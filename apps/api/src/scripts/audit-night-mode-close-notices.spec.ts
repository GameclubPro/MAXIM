import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  MaxActionLedgerStatus,
} from '../prisma/prisma-client';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import { buildNightModeTransitionJobId } from '../moderation/night-mode-transition.queue';
import {
  resolveCurrentNightModeCloseOccurrence,
  resolveNextNightModeTransitionOccurrences,
} from '../moderation/night-mode-transition-time.util';
import {
  assertNightModeCloseNoticeAuditRuntime,
  readNightModeCloseNoticeAuditOptions,
  runNightModeCloseNoticeFleetAudit,
  type NightModeCloseNoticeAuditSettingsRow,
  type NightModeCloseNoticeRegistryRow,
} from './audit-night-mode-close-notices';

const NOW = new Date('2026-09-04T20:30:00.000Z');
const auditSource = readFileSync(resolve(__dirname, 'audit-night-mode-close-notices.ts'), 'utf8');
const auditModuleSource = readFileSync(
  resolve(__dirname, 'night-mode-close-notice-audit.module.ts'),
  'utf8',
);

type AuditMembership = NightModeCloseNoticeAuditSettingsRow['chat']['botMemberships'][number];

function membership(overrides: Partial<AuditMembership> = {}): AuditMembership {
  return {
    botId: 'bot-actionable',
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: ChatBotAccessState.UNKNOWN,
    permissionsSnapshot: null,
    sendRouteFailureCount: 0,
    sendRouteQuarantinedUntil: null,
    sendRouteLastFailureAt: null,
    sendRouteLastFailureCode: null,
    sendRouteLastSuccessAt: null,
    ...overrides,
  };
}

function settingsRow(
  chatId: string,
  memberships: AuditMembership[],
  overrides: Partial<NightModeCloseNoticeAuditSettingsRow> = {},
): NightModeCloseNoticeAuditSettingsRow {
  return {
    chatId,
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    chat: {
      title: `Chat ${chatId}`,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      _count: { botMemberships: memberships.length },
      botMemberships: memberships,
    },
    ...overrides,
  };
}

function createPrismaFixture(params: {
  rows: NightModeCloseNoticeAuditSettingsRow[];
  registryRows?: NightModeCloseNoticeRegistryRow[];
  ledgerRows?: Array<Record<string, unknown> & { jobId: string }>;
}) {
  const findSettings = jest.fn(
    async (args: { where: { chatId?: { gt: string } }; take: number }) => {
      const after = args.where.chatId?.gt ?? '';
      return params.rows.filter((row) => row.chatId > after).slice(0, args.take);
    },
  );
  const queryRaw = jest.fn().mockResolvedValue(params.registryRows ?? []);
  const findLedgers = jest.fn(async (args: { where: { jobId: { in: string[] } } }) => {
    const ids = new Set(args.where.jobId.in);
    return (params.ledgerRows ?? []).filter((row) => ids.has(row.jobId));
  });
  return {
    prisma: {
      chatSettings: { findMany: findSettings },
      maxActionLedgerEntry: { findMany: findLedgers },
      $queryRaw: queryRaw,
    },
    findSettings,
    findLedgers,
    queryRaw,
  };
}

const botRegistry = {
  getActionableBots: () => [{ id: 'bot-actionable' }],
};

describe('night mode close notice fleet audit', () => {
  it('parses bounded, read-only CLI options', () => {
    expect(
      readNightModeCloseNoticeAuditOptions([
        '--json',
        '--page-size',
        '50',
        '--max-chats',
        '5000',
        '--sample-limit',
        '0',
        '--after',
        'chat-100',
      ]),
    ).toEqual({ pageSize: 50, maxChats: 5_000, sampleLimit: 0, after: 'chat-100' });

    expect(() => readNightModeCloseNoticeAuditOptions(['--page-size', '501'])).toThrow(
      /--page-size/u,
    );
    expect(() => readNightModeCloseNoticeAuditOptions(['--sample-limit', '-1'])).toThrow(
      /--sample-limit/u,
    );
    expect(() => readNightModeCloseNoticeAuditOptions(['--apply'])).toThrow(/Unknown option/u);
  });

  it('anchors the fleet scan on enabled settings and classifies chats missing memberships', async () => {
    const rows = [
      settingsRow('chat-01', []),
      settingsRow('chat-02', [
        membership({ botId: 'unknown-bot', botAccessState: ChatBotAccessState.DENIED }),
      ]),
      settingsRow('chat-03', [
        membership({
          sendRouteFailureCount: 2,
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
          sendRouteQuarantinedUntil: new Date('2026-09-05T02:00:00.000Z'),
        }),
      ]),
      settingsRow('chat-04', [
        membership({
          sendRouteFailureCount: 1,
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
          sendRouteQuarantinedUntil: new Date('2026-09-04T19:00:00.000Z'),
        }),
      ]),
      settingsRow('chat-05', [membership()]),
    ];
    const fixture = createPrismaFixture({ rows });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma as never,
      botRegistry as never,
      { pageSize: 2, maxChats: 100, sampleLimit: 1, after: null },
      () => NOW,
    );

    expect(result.scan).toEqual({ pages: 3, scannedChats: 5, complete: true, nextAfter: null });
    expect(result.categories.no_memberships.count).toBe(1);
    expect(result.categories.no_actionable_route.count).toBe(1);
    expect(result.categories.sticky_routes.count).toBe(1);
    expect(result.categories.first_failures.count).toBe(1);
    expect(result.categories.healthy.count).toBe(1);
    expect(result.routes).toMatchObject({
      memberships: 4,
      actionable: 3,
      sticky: { count: 1, affectedChats: 1 },
      firstFailures: { count: 1, affectedChats: 1 },
      healthy: { count: 1, affectedChats: 1 },
    });
    expect(result.routes.firstFailures.samples[0]).toMatchObject({
      chatId: 'chat-04',
      halfOpenEligible: true,
    });
    expect(result.coverage.current.scheduleExpected).toBe(3);
    expect(result.coverage.current.missingDurable).toBe(3);
    expect(result.coverage.current.successfulDeliveries).toBe(0);
    expect(result.coverage.current.withoutSuccessfulDelivery).toBe(5);
    expect(result.coverage.next.scheduleExpected).toBe(3);
    expect(result.coverage.next.missingDurable).toBe(3);
    expect(result.coverage.current.samples.missingDurable).toHaveLength(1);
    expect(result.coverage.current.samples.ledgerMissing).toHaveLength(1);
    expect(result.coverage.current.samples.withoutSuccessfulDelivery).toHaveLength(1);
    expect(result.categories.no_memberships.samples).toHaveLength(1);
    expect(result.scope).toEqual({
      nightModeEnabled: true,
      botCloseMessageEnabled: true,
      routeHealthPopulation: 'configured_actionable_bots_in_matching_chats',
      bullPayload: 'not_inspected_scheduler_self_heals_from_registry',
    });

    expect(fixture.findSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { nightModeEnabled: true, nightModeBotMessageEnabled: true },
        orderBy: { chatId: 'asc' },
        take: 2,
        select: expect.objectContaining({
          chat: {
            select: expect.objectContaining({
              botMemberships: expect.objectContaining({
                where: { botId: { in: ['bot-actionable'] } },
              }),
            }),
          },
        }),
      }),
    );
    expect(fixture.findSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          nightModeEnabled: true,
          nightModeBotMessageEnabled: true,
          chatId: { gt: 'chat-02' },
        },
      }),
    );
    expect(fixture.queryRaw).toHaveBeenCalledTimes(3);
    expect(fixture.findLedgers).toHaveBeenCalledTimes(3);
  });

  it('separates routing closure, access loss, and mixed degraded routes', async () => {
    const routingClosed = settingsRow('chat-routing-closed', [membership()]);
    routingClosed.chat.routingState = ChatRoutingState.NO_ELIGIBLE_BOT;
    const denied = settingsRow('chat-denied', [
      membership({ botAccessState: ChatBotAccessState.DENIED }),
    ]);
    denied.chat.routingState = ChatRoutingState.NO_ELIGIBLE_BOT;
    const mixed = settingsRow('chat-mixed', [
      membership(),
      membership({
        botId: 'bot-actionable-2',
        sendRouteFailureCount: 2,
        sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
      }),
    ]);
    mixed.chat._count.botMemberships = 4;
    const quarantined = settingsRow('chat-quarantined', [
      membership({ sendRouteQuarantinedUntil: new Date('2026-09-05T02:00:00.000Z') }),
      membership({
        botId: 'bot-actionable-2',
        sendRouteQuarantinedUntil: new Date('2026-09-05T03:00:00.000Z'),
      }),
    ]);
    const fixture = createPrismaFixture({ rows: [denied, mixed, quarantined, routingClosed] });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma as never,
      {
        getActionableBots: () => [{ id: 'bot-actionable' }, { id: 'bot-actionable-2' }],
      } as never,
      { pageSize: 10, maxChats: 10, sampleLimit: 10, after: null },
      () => NOW,
    );

    expect(result.categories.no_actionable_route.count).toBe(3);
    expect(result.categories.mixed_degraded.count).toBe(1);
    expect(result.noRouteReasons.routing_closed.count).toBe(1);
    expect(result.noRouteReasons.access_denied_or_lost.count).toBe(1);
    expect(result.noRouteReasons.route_quarantined.count).toBe(1);
    expect(result.routes).toMatchObject({
      memberships: 8,
      configuredBotMemberships: 6,
      excludedMemberships: 2,
      sticky: { count: 1 },
      healthy: { count: 1 },
      otherQuarantined: { count: 2 },
    });
  });

  it('rejects the publisher-only runtime registry', () => {
    const previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'publisher';
    try {
      expect(() => assertNightModeCloseNoticeAuditRuntime()).toThrow(/api-publisher/u);
    } finally {
      if (previousRole === undefined) {
        delete process.env.APP_ROLE;
      } else {
        process.env.APP_ROLE = previousRole;
      }
    }
  });

  it('checks exact current and next registry and ledger identities', async () => {
    const row = settingsRow('chat-exact', [membership()]);
    const current = resolveCurrentNightModeCloseOccurrence(row, NOW)!;
    const next = resolveNextNightModeTransitionOccurrences(row, NOW).find(
      (occurrence) => occurrence.transition === 'close',
    )!;
    const fingerprint = buildNightModeTransitionScheduleFingerprint(row);
    const registryRow = (
      occurrence: typeof current,
      runtimeVersion = 4,
    ): NightModeCloseNoticeRegistryRow => ({
      chat_id: row.chatId,
      job_id: buildNightModeTransitionJobId(
        row.chatId,
        'close',
        occurrence.dueAt.toISOString(),
        occurrence.sessionKey,
      ),
      transition: 'close',
      session_key: occurrence.sessionKey,
      scheduled_for: occurrence.dueAt,
      schedule_fingerprint: fingerprint,
      runtime_version: runtimeVersion,
    });
    const currentLedgerJobId = buildNightModeNoticeIdempotencyKey(
      'close',
      row.chatId,
      current.sessionKey,
    );
    const nextLedgerJobId = buildNightModeNoticeIdempotencyKey(
      'close',
      row.chatId,
      next.sessionKey,
    );
    const fixture = createPrismaFixture({
      rows: [row],
      registryRows: [registryRow(current), registryRow(next, 3)],
      ledgerRows: [
        {
          jobId: currentLedgerJobId,
          actionType: 'SEND_MESSAGE',
          chatId: row.chatId,
          sourceTag: 'night_mode_transition',
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
          attemptCount: 1,
          lastStatusCode: 200,
          lastErrorCode: null,
          completedAt: new Date('2026-09-04T20:00:05.000Z'),
          dispatchBotId: 'bot-actionable',
          remoteMessageId: 'mid.close',
        },
        {
          jobId: nextLedgerJobId,
          actionType: 'SEND_MESSAGE',
          chatId: row.chatId,
          sourceTag: 'wrong_source',
          status: MaxActionLedgerStatus.ENQUEUED,
          ambiguous: false,
          terminal: false,
          attemptCount: 0,
          lastStatusCode: null,
          lastErrorCode: null,
          completedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
        },
      ],
    });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma as never,
      botRegistry as never,
      { pageSize: 10, maxChats: 10, sampleLimit: 5, after: null },
      () => NOW,
    );

    expect(result.coverage.current).toMatchObject({
      occurrences: 1,
      scheduleExpected: 1,
      registry: { exact: 1, missing: 0, mismatch: 0 },
      ledger: { exact: 1, succeeded: 1, mismatch: 0 },
      durableCovered: 1,
      missingDurable: 0,
      successfulDeliveries: 1,
      withoutSuccessfulDelivery: 0,
    });
    expect(result.coverage.next).toMatchObject({
      occurrences: 1,
      scheduleExpected: 1,
      registry: { exact: 0, missing: 0, mismatch: 1 },
      ledger: { exact: 0, mismatch: 1 },
      durableCovered: 0,
      missingDurable: 1,
    });
    expect(result.coverage.next.samples.registryMismatch).toHaveLength(1);
    expect(result.coverage.next.samples.ledgerMismatch).toHaveLength(1);
    expect(fixture.findLedgers).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: { in: expect.arrayContaining([currentLedgerJobId, nextLedgerJobId]) } },
      }),
    );
  });

  it('reports malformed succeeded ledger provenance separately from terminal failure', async () => {
    const row = settingsRow('chat-invalid-success', [membership()]);
    const current = resolveCurrentNightModeCloseOccurrence(row, NOW)!;
    const ledgerJobId = buildNightModeNoticeIdempotencyKey('close', row.chatId, current.sessionKey);
    const fixture = createPrismaFixture({
      rows: [row],
      ledgerRows: [
        {
          jobId: ledgerJobId,
          actionType: 'SEND_MESSAGE',
          chatId: row.chatId,
          sourceTag: 'night_mode_transition',
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
          attemptCount: 1,
          lastStatusCode: 200,
          lastErrorCode: null,
          completedAt: new Date('2026-09-04T20:00:05.000Z'),
          dispatchBotId: 'bot-actionable',
          remoteMessageId: null,
        },
      ],
    });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma as never,
      botRegistry as never,
      { pageSize: 10, maxChats: 10, sampleLimit: 5, after: null },
      () => NOW,
    );

    expect(result.coverage.current.ledger).toMatchObject({
      invalidSuccess: 1,
      terminalFailure: 0,
    });
    expect(result.coverage.current.samples.ledgerInvalidSuccess).toEqual([
      expect.objectContaining({
        ledgerState: 'invalid_success',
        ledgerStatus: MaxActionLedgerStatus.SUCCEEDED,
        ledgerTerminal: true,
        ledgerHasCompletedAt: true,
        ledgerHasDispatchBot: true,
        ledgerHasRemoteMessage: false,
      }),
    ]);
  });

  it('caps the scan and returns an exact resume cursor', async () => {
    const fixture = createPrismaFixture({
      rows: [settingsRow('chat-01', []), settingsRow('chat-02', []), settingsRow('chat-03', [])],
    });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma as never,
      botRegistry as never,
      { pageSize: 2, maxChats: 2, sampleLimit: 0, after: null },
      () => NOW,
    );

    expect(result.scan).toEqual({
      pages: 1,
      scannedChats: 2,
      complete: false,
      nextAfter: 'chat-02',
    });
    expect(fixture.findSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: { gt: 'chat-02' } }),
        take: 1,
      }),
    );
  });

  it('keeps the dedicated bootstrap and audit path strictly read-only', () => {
    expect(auditSource).toContain('nightModeBotMessageEnabled: true');
    expect(auditSource).toContain(
      'WHERE (registry."chat_id", registry."job_id") IN (${Prisma.join(pairSql)})',
    );
    expect(auditSource).not.toMatch(
      /\$executeRaw|\.update(?:Many)?\(|\.create\(|\.delete(?:Many)?\(/u,
    );
    expect(auditSource).not.toMatch(/MaxClientService|new Queue\(|getExactMessagePresence/u);
    expect(auditModuleSource).toContain('PrismaModule');
    expect(auditModuleSource).toContain('MaxBotRegistryService');
    expect(auditModuleSource).not.toMatch(/HttpModule|MaxClientService|Redis/u);
  });
});
