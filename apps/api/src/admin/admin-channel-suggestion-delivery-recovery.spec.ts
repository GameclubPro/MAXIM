import { ChannelSuggestionAdminDeliveryStatus } from '../prisma/prisma-client';
import { createPrismaMock, extractSqlText } from './admin-service-test-support';
import {
  findRecentRecoverableChannelSuggestionAuditLogIds,
  isTerminalPrivateDialogDeliveryRow,
  recoverChannelSuggestionAdminDeliveriesAfterBotStarted,
} from './admin-channel-suggestion-delivery-recovery';

describe('channel suggestion delivery recovery', () => {
  it('ranks the latest logical suggestion before filtering eligible siblings and dedupes jobs', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      { id: 'suggestion-1' },
      { id: 'suggestion-1' },
      { id: 'suggestion-2' },
    ]);

    await expect(
      findRecentRecoverableChannelSuggestionAuditLogIds({
        prisma: prisma as never,
        action: 'CHANNEL_DIALOG_SUGGESTION',
        recoveryFrom: new Date('2026-08-17T10:00:00.000Z'),
        staleBefore: new Date('2026-08-24T09:55:00.000Z'),
        limit: 12,
      }),
    ).resolves.toEqual(['suggestion-1', 'suggestion-2']);

    const sql = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('DENSE_RANK() OVER');
    expect(sql).toContain('eligible_deliveries AS');
    expect(sql).toContain('ROW_NUMBER() OVER');
    expect(sql).toContain('ranked.admin_suggestion_rank = 1');
    expect(sql).toContain('ranked.created_at <=');
    expect(sql).toContain('GROUP BY eligible.audit_log_id');
    expect(sql).toContain('ORDER BY MIN(eligible.created_at) ASC');
    expect(sql).toContain('AS review_status');
    expect(sql).toContain('AS delivery_attempted_at');
    expect(sql).not.toContain('audit.payload,');
    expect(sql.indexOf('DENSE_RANK() OVER')).toBeLessThan(
      sql.indexOf('ranked.admin_suggestion_rank = 1'),
    );
  });

  it('lets SQL choose an eligible sibling and rechecks the global latest admin suggestion', async () => {
    const prisma = createPrismaMock();
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          id: 'ineligible-versioned',
          auditLogId: 'suggestion-1',
          adminUserId: 'admin-1',
          botKey: 'a',
          status: 'FAILED',
          terminal: true,
          lastStatusCode: 404,
          lastErrorCode: 'suggestion.delivery.dialog_unavailable',
        },
        {
          id: 'eligible-legacy',
          auditLogId: 'suggestion-1',
          adminUserId: 'admin-1',
          botKey: 'b',
          status: 'FAILED',
          terminal: true,
          lastStatusCode: 404,
          lastErrorCode: 'dialog.not.found',
        },
      ],
      skipDuplicates: true,
    });
    prisma.$queryRaw.mockResolvedValue([{ id: 'eligible-legacy' }]);
    const rows = await prisma.channelSuggestionAdminDelivery.findMany({
      where: { auditLogId: 'suggestion-1' },
    });

    await expect(
      recoverChannelSuggestionAdminDeliveriesAfterBotStarted({
        prisma: prisma as never,
        auditLogId: 'suggestion-1',
        rows: rows as never,
      }),
    ).resolves.toBe(1);

    const sql = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('WITH eligible_deliveries AS');
    expect(sql).toContain('delivery.id IN');
    expect(sql).toContain('JOIN audit_logs audit');
    expect(sql).toContain('newer_delivery.admin_user_id = delivery.admin_user_id');
    expect(sql).toContain("audit.payload->>'deliveryAttemptedAt'");
    expect(sql).toContain('LEAST(');
    expect(sql).toContain('UPDATE channel_suggestion_admin_deliveries target');
    expect(sql).toContain("target.status = 'FAILED'");
    expect(sql).toContain('target.terminal = true');
    expect(sql).toContain('RETURNING target.id');
    expect(sql).toContain("private_start.normalized_payload->>'type' = 'bot_started'");
    expect(sql).not.toContain('delivery.bot_key =');
    expect(sql).not.toContain('private_start.bot_id =');
  });

  it('scopes Publisher recovery to the current bot ledger and all private route evidence', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ id: 'publisher-terminal' }]);

    await expect(
      recoverChannelSuggestionAdminDeliveriesAfterBotStarted({
        prisma: prisma as never,
        auditLogId: 'publisher-suggestion-1',
        rows: [
          {
            id: 'publisher-terminal',
            adminUserId: 'publisher-admin-1',
            status: ChannelSuggestionAdminDeliveryStatus.FAILED,
            terminal: true,
            botId: 'publisher-bot',
            lastStatusCode: 404,
            lastErrorCode: 'suggestion.delivery.no_reachable_dialog',
          },
        ],
        options: {
          botKey: 'publisher:publisher-bot',
          botId: 'publisher-bot',
          privateActivityTypes: ['bot_started', 'message_created'],
        },
      }),
    ).resolves.toBe(1);

    const query = prisma.$queryRaw.mock.calls[0]?.[0] as { values?: unknown[] };
    const sql = extractSqlText(query);
    expect(sql).toContain('delivery.bot_key =');
    expect(sql).toContain('newer_delivery.bot_key =');
    expect(sql).toContain('blocking_sibling.bot_key =');
    expect(sql).toContain('private_start.bot_id =');
    expect(sql).toContain("private_start.normalized_payload->>'type' IN");
    expect(query.values).toEqual(
      expect.arrayContaining([
        'publisher:publisher-bot',
        'publisher-bot',
        'bot_started',
        'message_created',
      ]),
    );
  });

  it('does not reopen a terminal row beside an already retryable logical sibling', async () => {
    const prisma = createPrismaMock();

    await expect(
      recoverChannelSuggestionAdminDeliveriesAfterBotStarted({
        prisma: prisma as never,
        auditLogId: 'suggestion-1',
        rows: [
          {
            id: 'terminal-row',
            adminUserId: 'admin-1',
            status: ChannelSuggestionAdminDeliveryStatus.FAILED,
            terminal: true,
            botId: 'bot-1',
            lastStatusCode: 404,
            lastErrorCode: 'dialog.not.found',
          },
          {
            id: 'pending-row',
            adminUserId: 'admin-1',
            status: ChannelSuggestionAdminDeliveryStatus.PENDING,
            terminal: false,
            botId: 'bot-2',
            lastStatusCode: null,
            lastErrorCode: null,
          },
        ],
      }),
    ).resolves.toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not treat versioned preclaim failures as private-dialog recovery evidence', () => {
    expect(
      isTerminalPrivateDialogDeliveryRow({
        id: 'preclaim-row',
        adminUserId: 'admin-1',
        status: ChannelSuggestionAdminDeliveryStatus.FAILED,
        terminal: true,
        botId: 'bot-1',
        lastStatusCode: 404,
        lastErrorCode: 'suggestion.delivery.preclaim_failed',
      }),
    ).toBe(false);
  });
});
