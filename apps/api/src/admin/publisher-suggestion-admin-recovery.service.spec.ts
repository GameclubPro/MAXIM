import {
  buildPublisherSuggestionAdminRecoveryQuery,
  buildPublisherSuggestionAdminTerminalSyncRecoveryQuery,
  PublisherSuggestionAdminRecoveryService,
} from './publisher-suggestion-admin-recovery.service';

function sqlText(query: unknown): string {
  const value = query as { strings?: readonly string[] };
  return value.strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

function createService(params: {
  dispatchEnabled: boolean;
  rows?: Array<{ id: string; createdAt: Date }>;
  terminalRows?: Array<{
    id: string;
    reviewStatus: 'published' | 'drafted' | 'cancelled';
    createdAt: Date;
  }>;
}) {
  const prisma = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce(params.rows ?? [])
      .mockResolvedValueOnce(params.terminalRows ?? []),
    channelSuggestionAdminDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const queue = {
    enqueueDelivery: jest.fn().mockResolvedValue(undefined),
    enqueueSync: jest.fn().mockResolvedValue(undefined),
    recoverFailedSyncJobs: jest.fn().mockResolvedValue(0),
  };
  const runtimeBoundary = {
    dispatchEnabled: params.dispatchEnabled,
  };
  const credentials = {
    getBotId: jest.fn(() => 'publisher-bot'),
  };
  const service = new PublisherSuggestionAdminRecoveryService(
    prisma as never,
    queue as never,
    runtimeBoundary as never,
    credentials as never,
  );
  return { service, prisma, queue, runtimeBoundary, credentials };
}

describe('Publisher suggestion admin recovery query', () => {
  it('uses independently limited literal Publisher-action UNION ALL branches', () => {
    const query = buildPublisherSuggestionAdminRecoveryQuery({
      lookbackFrom: new Date('2026-08-25T18:00:00.000Z'),
      staleBefore: new Date('2026-09-01T17:55:00.000Z'),
      botKey: 'publisher:publisher-bot',
      publisherBotId: 'publisher-bot',
      cursor: {
        createdAt: new Date('2026-08-31T12:00:00.000Z'),
        id: 'publisher-suggestion-cursor',
      },
    });
    const sql = sqlText(query);

    expect(sql.match(/audit\.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'/gu)).toHaveLength(6);
    expect(sql.match(/\bUNION ALL\b/gu)).toHaveLength(5);
    expect(sql).not.toMatch(/\bOR\b/gu);
    expect(sql).not.toMatch(/audit\.action\s*=\s*\?/gu);
    expect(sql).not.toMatch(/audit\.action\s+IN\b/gu);
    expect(sql).not.toMatch(/payload->>'reviewStatus'\s+IN\b/gu);
    expect(sql).toContain("audit.payload->>'reviewStatus' = 'pending'");
    expect(sql.match(/audit\.payload->>'reviewClaimToken' IS NULL/gu)).toHaveLength(6);
    expect(sql.match(/\(audit\.created_at, audit\.id\) > \(\?, \?::text\)/gu)).toHaveLength(6);
    expect(sql).toContain('AND NOT EXISTS ( SELECT 1 FROM channel_suggestion_admin_deliveries');
    expect(sql).toContain('delivery.bot_key = ?');
    expect(sql).toContain("delivery.status = 'PENDING'");
    expect(sql).toContain("delivery.status = 'FAILED'");
    expect(sql).toContain("delivery.status = 'SENDING'");
    expect(sql.match(/private_start\.normalized_payload->>'type' IN \(/gu)).toHaveLength(2);
    for (const activityType of ['bot_started', 'message_created']) {
      expect(sql.match(new RegExp(`'${activityType}'`, 'gu'))).toHaveLength(2);
    }
    expect(sql).not.toContain("'message_callback'");
    expect(query.values).not.toContain('PUBLISHER_CHANNEL_DIALOG_SUGGESTION');
  });

  it('uses independently limited terminal branches and exact durable sync markers', () => {
    const query = buildPublisherSuggestionAdminTerminalSyncRecoveryQuery({
      lookbackFrom: new Date('2026-08-25T18:00:00.000Z'),
      botKey: 'publisher:publisher-bot',
      publisherBotId: 'publisher-bot',
      cursor: {
        createdAt: new Date('2026-08-31T12:00:00.000Z'),
        id: 'publisher-terminal-cursor',
      },
    });
    const sql = sqlText(query);

    expect(sql.match(/audit\.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'/gu)).toHaveLength(3);
    expect(sql.match(/\bUNION ALL\b/gu)).toHaveLength(2);
    expect(sql.match(/\(audit\.created_at, audit\.id\) > \(\?, \?::text\)/gu)).toHaveLength(3);
    expect(sql).toContain("audit.payload->>'reviewStatus' = 'published'");
    expect(sql).toContain("audit.payload->>'reviewStatus' = 'drafted'");
    expect(sql).toContain("audit.payload->>'reviewStatus' = 'cancelled'");
    expect(sql).not.toMatch(/payload->>'reviewStatus'\s+IN\b/gu);
    expect(sql.match(/publisherAdminCardSyncKey/gu)).toHaveLength(3);
    expect(sql.match(/publisherAdminCardSyncedCount/gu)).toHaveLength(6);
    expect(sql.match(/CROSS JOIN LATERAL/gu)).toHaveLength(3);
    expect(sql.match(/delivery_sync\.sent_card_count > 0/gu)).toHaveLength(3);
    expect(sql.match(/delivery\.bot_key = \?/gu)).toHaveLength(3);
    expect(sql.match(/delivery\.status = 'SENT'/gu)).toHaveLength(3);
  });
});

describe('PublisherSuggestionAdminRecoveryService', () => {
  const originalRole = process.env.APP_ROLE;
  const originalServiceName = process.env.APP_SERVICE_NAME;

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });

  afterEach(() => {
    restoreEnv('APP_ROLE', originalRole);
    restoreEnv('APP_SERVICE_NAME', originalServiceName);
  });

  it('does not query or enqueue while Publisher dispatch is disabled', async () => {
    const fixture = createService({ dispatchEnabled: false });

    await expect(fixture.service.recover(new Date('2026-09-01T18:00:00.000Z'))).resolves.toBe(0);

    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(fixture.prisma.channelSuggestionAdminDelivery.findMany).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueDelivery).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueSync).not.toHaveBeenCalled();
    expect(fixture.queue.recoverFailedSyncJobs).not.toHaveBeenCalled();
  });

  it('re-enqueues a pending Publisher suggestion without a ledger via the stable delivery identity', async () => {
    const fixture = createService({
      dispatchEnabled: true,
      rows: [
        {
          id: 'publisher-suggestion-1',
          createdAt: new Date('2026-09-01T17:00:00.000Z'),
        },
      ],
    });
    const now = new Date('2026-09-01T18:00:00.000Z');

    await expect(fixture.service.recover(now)).resolves.toBe(1);

    expect(fixture.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const query = fixture.prisma.$queryRaw.mock.calls[0]?.[0];
    expect(sqlText(query)).toContain("audit.action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'");
    expect(fixture.prisma.channelSuggestionAdminDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ auditLogId: 'publisher-suggestion-1' }),
      }),
    );
    expect(fixture.queue.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(fixture.queue.enqueueDelivery).toHaveBeenCalledWith({
      suggestionId: 'publisher-suggestion-1',
      requiredBotId: 'publisher-bot',
      recoverExisting: true,
    });
    expect(fixture.queue.recoverFailedSyncJobs).toHaveBeenCalledWith('publisher-bot', 25);
  });

  it('continues past one failed recovery candidate so later lost deliveries are not starved', async () => {
    const fixture = createService({
      dispatchEnabled: true,
      rows: [
        { id: 'publisher-suggestion-bad', createdAt: new Date('2026-09-01T16:00:00.000Z') },
        { id: 'publisher-suggestion-good', createdAt: new Date('2026-09-01T17:00:00.000Z') },
      ],
    });
    fixture.queue.enqueueDelivery
      .mockRejectedValueOnce(new Error('BullMQ state changed'))
      .mockResolvedValueOnce(undefined);

    await expect(fixture.service.recover(new Date('2026-09-01T18:00:00.000Z'))).resolves.toBe(1);

    expect(fixture.queue.enqueueDelivery).toHaveBeenCalledTimes(2);
    expect(fixture.queue.enqueueDelivery).toHaveBeenLastCalledWith({
      suggestionId: 'publisher-suggestion-good',
      requiredBotId: 'publisher-bot',
      recoverExisting: true,
    });
  });

  it('recycles failed terminal card sync jobs even when no pending delivery needs recovery', async () => {
    const fixture = createService({ dispatchEnabled: true, rows: [] });
    fixture.queue.recoverFailedSyncJobs.mockResolvedValue(2);

    await expect(fixture.service.recover(new Date('2026-09-01T18:00:00.000Z'))).resolves.toBe(2);

    expect(fixture.queue.enqueueDelivery).not.toHaveBeenCalled();
    expect(fixture.queue.recoverFailedSyncJobs).toHaveBeenCalledWith('publisher-bot', 25);
  });

  it('recreates a missing terminal card-sync job from the durable audit state', async () => {
    const fixture = createService({
      dispatchEnabled: true,
      terminalRows: [
        {
          id: 'publisher-suggestion-terminal-1',
          reviewStatus: 'cancelled',
          createdAt: new Date('2026-09-01T17:00:00.000Z'),
        },
      ],
    });

    await expect(fixture.service.recover(new Date('2026-09-01T18:00:00.000Z'))).resolves.toBe(1);

    expect(fixture.queue.enqueueSync).toHaveBeenCalledWith({
      suggestionId: 'publisher-suggestion-terminal-1',
      requiredBotId: 'publisher-bot',
      reviewStatus: 'cancelled',
      recoverExisting: true,
    });
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
