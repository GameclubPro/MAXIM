import { PublisherBackgroundWorkCoordinatorClosedError } from '../publisher/publisher-background-work-coordinator.service';
import {
  buildChannelSuggestionPublicationLedgerJobId,
  CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
} from './admin-channel-suggestion-publication-protocol';
import {
  buildPublisherSuggestionAdmissionCleanupQuery,
  buildPublisherSuggestionPendingCleanupQuery,
  buildPublisherSuggestionTerminalImageCleanupQuery,
  PublisherSuggestionPublicationQueueService,
} from './publisher-suggestion-publication-queue.service';
import {
  buildPublisherSuggestionPublicationRequestId,
  PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
  PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
} from './publisher-suggestion-review-protocol';

type SqlQuery = {
  strings?: readonly string[];
  values?: readonly unknown[];
};

function sqlText(query: SqlQuery): string {
  return query.strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

function recoveryScanCalls(queryRaw: jest.Mock): Array<[SqlQuery]> {
  return queryRaw.mock.calls.filter(([query]: [SqlQuery]) =>
    sqlText(query).includes('publisher_suggestion_recovery_candidates'),
  );
}

function mockRecoveryPages(queryRaw: jest.Mock, pages: unknown[][]): void {
  const remaining = [...pages];
  queryRaw.mockImplementation(async (query: SqlQuery) =>
    sqlText(query).includes('publisher_suggestion_recovery_candidates')
      ? (remaining.shift() ?? [])
      : [],
  );
}

describe('PublisherSuggestionPublicationQueueService', () => {
  const originalRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
  });

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalRole;
    }
    jest.useRealTimers();
  });

  function createHarness(dispatchEnabled: boolean, globallyPaused = false) {
    const queue = {
      getJob: jest.fn(),
      add: jest.fn(),
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const dispatchHealth = {
      isGloballyPaused: jest.fn().mockResolvedValue(globallyPaused),
    };
    const backgroundWork = {
      runExclusive: jest.fn((_lane: string, operation: () => Promise<unknown>) => operation()),
    };
    const service = new PublisherSuggestionPublicationQueueService(
      queue as never,
      prisma as never,
      dispatchHealth as never,
      backgroundWork as never,
      { dispatchEnabled } as never,
    );
    return { backgroundWork, dispatchHealth, prisma, queue, service };
  }

  function createClaimRow(index: number) {
    const id = `suggestion-${String(index).padStart(4, '0')}`;
    return {
      id,
      createdAt: new Date(Date.UTC(2026, 7, 26, 10, 0, 0, index)),
      payload: {
        type: 'suggest',
        reviewStatus: 'publishing',
        reviewDispatchProfile: 'PUBLIK_V1',
        reviewAction: 'publish',
        reviewPublicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
        reviewPublicationLedgerJobId: buildChannelSuggestionPublicationLedgerJobId(id),
        reviewClaimToken: `claim-${index}`,
        reviewClaimedAt: '2026-08-26T09:55:00.000Z',
        reviewClaimedByUserId: 'admin-1',
      },
    };
  }

  it('does not start suggestion recovery while dispatch is disabled', async () => {
    jest.useFakeTimers();
    const { dispatchHealth, prisma, queue, service } = createHarness(false);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(dispatchHealth.isGloballyPaused).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('starts bounded suggestion recovery when dispatch is enabled', async () => {
    const { prisma, service } = createHarness(true);

    service.onModuleInit();
    await (service as any).recover();

    const recoveryCalls = recoveryScanCalls(prisma.$queryRaw);
    expect(recoveryCalls).toHaveLength(1);
    const scanSql = sqlText(recoveryCalls[0]![0]);
    expect(scanSql).toContain(
      "WHERE action = 'CHANNEL_DIALOG_SUGGESTION' AND payload->>'type' = 'suggest' AND payload->>'reviewStatus' = 'publishing'",
    );
    expect(scanSql).toContain(
      "WHERE action = 'CHANNEL_DIALOG_SUGGESTION' AND COALESCE(NULLIF(payload->>'reviewStatus', ''), 'pending') = 'pending' AND payload->>'reviewStatus' = 'pending'",
    );
    expect(scanSql).toContain(
      "WHERE action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION' AND payload->>'reviewStatus' IN ('publishing', 'pending')",
    );
    expect(scanSql.match(/FROM audit_logs/gu)).toHaveLength(3);
    expect(scanSql.match(/LIMIT 100/gu)).toHaveLength(4);
    expect(scanSql.match(/UNION ALL/gu)).toHaveLength(2);
    expect(scanSql).not.toMatch(/\bOR\b/gu);
    expect(scanSql).not.toContain('action IN');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    service.onModuleDestroy();
  });

  it('uses separately limited terminal branches and bounded retention deletes', () => {
    const terminalSql = sqlText(buildPublisherSuggestionTerminalImageCleanupQuery());
    expect(terminalSql.match(/FROM audit_logs/gu)).toHaveLength(3);
    expect(terminalSql.match(/UNION ALL/gu)).toHaveLength(2);
    expect(terminalSql.match(/LIMIT \?/gu)).toHaveLength(4);
    expect(terminalSql).toContain("payload->>'reviewStatus' = 'published'");
    expect(terminalSql).toContain("payload->>'reviewStatus' = 'drafted'");
    expect(terminalSql).toContain("payload->>'reviewStatus' = 'cancelled'");
    expect(terminalSql).not.toContain("reviewStatus' IN");
    expect(terminalSql).not.toMatch(/\bOR\b/gu);
    expect(terminalSql).toContain('DELETE FROM channel_suggestion_image_assets');

    const cutoff = new Date('2026-08-01T00:00:00.000Z');
    const pendingQuery = buildPublisherSuggestionPendingCleanupQuery(cutoff);
    const pendingSql = sqlText(pendingQuery);
    expect(pendingSql).toContain("action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'");
    expect(pendingSql).toContain("payload->>'reviewStatus' = 'pending'");
    expect(pendingSql).toContain("payload->>'reviewClaimToken' IS NULL");
    expect(pendingSql).toContain('created_at < ?');
    expect(pendingSql).toContain('ORDER BY created_at ASC, id ASC');
    expect(pendingSql).toContain('LIMIT ?');
    expect(pendingSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(pendingSql).toContain('DELETE FROM audit_logs');
    expect(pendingSql).not.toMatch(/\b(?:IN|OR)\b/gu);
    expect(pendingQuery.values).toContain(cutoff);

    const admissionQuery = buildPublisherSuggestionAdmissionCleanupQuery(cutoff);
    const admissionSql = sqlText(admissionQuery);
    expect(admissionSql).toContain("action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION_ADMISSION'");
    expect(admissionSql).toContain('created_at < ?');
    expect(admissionSql).toContain('LIMIT ?');
    expect(admissionSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(admissionSql).toContain('DELETE FROM audit_logs');
    expect(admissionQuery.values).toContain(cutoff);
  });

  it('keeps enabled recovery timers idle before DB or queue work while globally paused', async () => {
    jest.useFakeTimers();
    const { dispatchHealth, prisma, queue, service } = createHarness(true, true);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(6);
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();

    dispatchHealth.isGloballyPaused.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(dispatchHealth.isGloballyPaused).toHaveBeenCalledTimes(3);
    expect(recoveryScanCalls(prisma.$queryRaw)).toHaveLength(1);
    service.onModuleDestroy();
  });

  it('fails recovery closed when the pause lookup fails', async () => {
    const { dispatchHealth, prisma, queue, service } = createHarness(true);
    dispatchHealth.isGloballyPaused.mockRejectedValueOnce(new Error('redis unavailable'));

    service.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('coalesces overlapping recovery ticks before they can duplicate DB work', async () => {
    const { prisma, service } = createHarness(true);
    let resolveRows!: (rows: []) => void;
    prisma.$queryRaw.mockImplementation((query: SqlQuery) => {
      if (!sqlText(query).includes('publisher_suggestion_recovery_candidates')) {
        return Promise.resolve([]);
      }
      return new Promise<[]>((resolve) => {
        resolveRows = resolve;
      });
    });

    const first = (service as any).recover() as Promise<void>;
    const second = (service as any).recover() as Promise<void>;
    while (recoveryScanCalls(prisma.$queryRaw).length === 0) await Promise.resolve();

    expect(recoveryScanCalls(prisma.$queryRaw)).toHaveLength(1);
    resolveRows([]);
    await Promise.all([first, second]);

    expect(recoveryScanCalls(prisma.$queryRaw)).toHaveLength(1);
  });

  it('advances a bounded keyset cursor past more than 100 failed claims', async () => {
    const { prisma, queue, service } = createHarness(true);
    const blockedClaims = Array.from({ length: 200 }, (_, index) => createClaimRow(index));
    const readyClaim = createClaimRow(200);
    mockRecoveryPages(prisma.$queryRaw, [
      blockedClaims.slice(0, 100),
      blockedClaims.slice(100),
      [readyClaim],
    ]);
    queue.getJob.mockImplementation(async () => {
      if (queue.getJob.mock.calls.length <= blockedClaims.length) {
        return {
          getState: jest.fn().mockResolvedValue('failed'),
          retry: jest.fn().mockRejectedValue(new Error('permanent blocker')),
        };
      }
      return null;
    });
    const warn = jest.spyOn((service as any).logger, 'warn');

    await (service as any).recover();

    expect(recoveryScanCalls(prisma.$queryRaw)).toHaveLength(2);
    expect(queue.add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedClaims: 200, err: 'permanent blocker' }),
      'Failed to recover some queued Publik suggestion publications',
    );

    await (service as any).recover();

    const recoveryCalls = recoveryScanCalls(prisma.$queryRaw);
    expect(recoveryCalls).toHaveLength(3);
    const cursorQuery = recoveryCalls[2]![0];
    expect(sqlText(cursorQuery).match(/AND \(created_at, id\) > \(\?, \?::text\)/gu)).toHaveLength(
      3,
    );
    expect(cursorQuery.values).toEqual([
      blockedClaims[199]!.createdAt,
      blockedClaims[199]!.id,
      blockedClaims[199]!.createdAt,
      blockedClaims[199]!.id,
      blockedClaims[199]!.createdAt,
      blockedClaims[199]!.id,
    ]);
    expect(queue.add).toHaveBeenCalledWith(
      'publish-approved-suggestion',
      expect.objectContaining({
        suggestionId: readyClaim.id,
        claimToken: 'claim-200',
      }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^publik-suggestion-/),
      }),
    );
  });

  it.each(['publishing', 'pending'] as const)(
    'recovers %s durable claims created by the Publisher inbox pipeline',
    async (reviewStatus) => {
      const { prisma, queue, service } = createHarness(true);
      const suggestionId = 'publisher-suggestion-1';
      mockRecoveryPages(prisma.$queryRaw, [
        [
          {
            id: suggestionId,
            createdAt: new Date('2026-08-27T10:00:00.000Z'),
            payload: {
              reviewStatus,
              reviewAction: 'publish',
              reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
              reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
              reviewPublicationRequestId: buildPublisherSuggestionPublicationRequestId(
                suggestionId,
                'publisher-claim-1',
              ),
              reviewClaimToken: 'publisher-claim-1',
              reviewClaimedAt: '2026-08-27T09:59:00.000Z',
              reviewClaimedByUserId: 'admin-1',
            },
          },
        ],
      ]);
      queue.getJob.mockResolvedValue(null);

      await (service as any).recover();

      expect(queue.add).toHaveBeenCalledWith(
        'publish-approved-suggestion',
        expect.objectContaining({
          suggestionId,
          claimToken: 'publisher-claim-1',
        }),
        expect.objectContaining({ jobId: expect.stringMatching(/^publik-suggestion-/u) }),
      );
      expect(recoveryScanCalls(prisma.$queryRaw)).toHaveLength(1);
    },
  );

  it('recreates a completed new-protocol job consumed by an older rolling worker', async () => {
    const { queue, service } = createHarness(true);
    const remove = jest.fn().mockResolvedValue(undefined);
    queue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('completed'),
      remove,
    });

    await service.enqueue('publisher-suggestion-1', 'claim-1', {
      recycleCompleted: true,
    });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'publish-approved-suggestion',
      expect.objectContaining({
        suggestionId: 'publisher-suggestion-1',
        claimToken: 'claim-1',
      }),
      expect.objectContaining({ jobId: expect.stringMatching(/^publik-suggestion-/u) }),
    );
  });

  it('migrates stale inline-v0 claims before the normal durable recovery scan', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const { prisma, queue, service } = createHarness(true);
    prisma.$queryRaw.mockImplementation(async (query: SqlQuery) => {
      const queryText = sqlText(query);
      if (queryText.includes('publisher_suggestion_recovery_candidates')) return [];
      if (queryText.startsWith('UPDATE audit_logs')) {
        return [{ id: 'legacy-inline-suggestion-1' }];
      }
      return [
        {
          id: 'legacy-inline-suggestion-1',
          createdAt: new Date('2026-08-27T10:00:00.000Z'),
          payload: {
            type: 'suggest',
            reviewStatus: 'publishing',
            reviewedAt: '2026-08-27T10:05:00.000Z',
            reviewedByUserId: 'admin-1',
          },
        },
      ];
    });
    queue.getJob.mockResolvedValue(null);

    await (service as any).recover();

    expect(queue.add).toHaveBeenCalledWith(
      'publish-approved-suggestion',
      expect.objectContaining({ suggestionId: 'legacy-inline-suggestion-1' }),
      expect.objectContaining({ jobId: expect.stringMatching(/^publik-suggestion-/u) }),
    );
    const migrationCall = prisma.$queryRaw.mock.calls.find(([query]: [SqlQuery]) =>
      sqlText(query).startsWith('UPDATE audit_logs'),
    );
    const migrationSql = sqlText(migrationCall?.[0]);
    expect(migrationSql).toContain("payload->>'reviewStatus' = 'publishing'");
    expect(migrationSql).toContain("payload->>'reviewPublicationProtocol' IS NULL");
    expect(migrationSql).toContain("payload->>'reviewedAt' <= ?::text");
  });

  it('does not recycle completed legacy publication jobs', async () => {
    const { queue, service } = createHarness(true);
    const remove = jest.fn();
    queue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('completed'),
      remove,
    });

    await service.enqueue('legacy-suggestion-1', 'legacy-claim-1');

    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('absorbs coordinator shutdown from its detached timer path', async () => {
    const { backgroundWork, service } = createHarness(true);
    backgroundWork.runExclusive.mockRejectedValue(
      new PublisherBackgroundWorkCoordinatorClosedError(),
    );
    const warn = jest.spyOn((service as any).logger, 'warn');

    (service as any).triggerRecovery();
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();
  });
});
