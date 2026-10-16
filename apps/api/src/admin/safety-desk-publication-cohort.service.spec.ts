import { type SafetyDeskPublicationCohortResponse } from '@maxim/contracts/safety-desk';
import { ServiceUnavailableException } from '@nestjs/common';
import { type Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { SafetyDeskPublicationCohortService } from './safety-desk-publication-cohort.service';

function emptySnapshot(): SafetyDeskPublicationCohortResponse {
  return {
    schemaVersion: 1,
    basis: 'occurrence_created_at',
    dispatchProfile: 'PUBLIK_V1',
    windowSeconds: 900,
    graceSeconds: 30,
    windowStartedAt: '2035-01-01T00:00:00.000Z',
    windowEndedAt: '2035-01-01T00:15:00.000Z',
    observedAt: '2035-01-01T00:15:30.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 0,
    completionTimingEvidence: 'not_recorded',
    effectsEvidence: 'occurrence_status_only',
    rows: (
      ['SCHEDULED', 'IN_PROGRESS', 'SENT', 'PARTIAL', 'FAILED', 'AMBIGUOUS', 'CANCELED'] as const
    ).map((status) => ({
      status,
      countLowerBound: 0,
      truncated: false,
      pendingNotDue: 0,
      pendingDue: 0,
      pendingExpired: 0,
      pendingTimingUnknown: 0,
      blockedPending: 0,
      retryAuthorizedCount: 0,
      oldestDueAgeSec: null,
      modeCounts: { NOW: 0, ONCE: 0, SLOTS: 0, RECURRENCE: 0, UNKNOWN: 0 },
      mediaCounts: { TEXT: 0, IMAGE: 0, VIDEO: 0, UNKNOWN: 0 },
    })),
  };
}

function harness() {
  const query = jest.fn();
  const execute = jest.fn().mockResolvedValue(0);
  const transaction = jest.fn(
    async (
      run: (tx: Prisma.TransactionClient) => Promise<unknown>,
      _options?: { maxWait: number; timeout: number },
    ) => run({ $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient),
  );
  const prisma: Pick<PrismaService, '$transaction'> = {
    $transaction: transaction as unknown as PrismaService['$transaction'],
  };
  const service = new SafetyDeskPublicationCohortService(prisma as PrismaService);
  const queueSnapshot = (snapshot: unknown = emptySnapshot()) => {
    query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ snapshot }]);
  };
  return { service, query, execute, transaction, queueSnapshot };
}

describe('SafetyDeskPublicationCohortService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('coalesces concurrent reads and caches validated evidence for ten seconds only', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const { service, query, execute, transaction, queueSnapshot } = harness();
    queueSnapshot();
    const first = service.getSnapshot();
    expect(service.getSnapshot()).toBe(first);
    const snapshot = await first;
    expect(snapshot).toEqual(emptySnapshot());
    expect(await service.getSnapshot()).toBe(snapshot);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([strings]) => strings.join(''))).toEqual([
      'SET TRANSACTION READ ONLY',
      "SET LOCAL statement_timeout = '2000ms'",
      "SET LOCAL lock_timeout = '250ms'",
    ]);
    expect(transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 2_000, timeout: 5_000 });
    clock.mockReturnValue(11_000);
    queueSnapshot();
    await service.getSnapshot();
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each([false, null, undefined])(
    'refuses missing index proof %s before reading the cohort',
    async (ready) => {
      const { service, query } = harness();
      query.mockResolvedValueOnce([{ ready }]);
      await expect(service.getSnapshot()).rejects.toThrow(ServiceUnavailableException);
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it('refreshes after the wall clock moves backwards', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(11_000);
    const { service, transaction, queueSnapshot } = harness();
    queueSnapshot();
    await service.getSnapshot();
    clock.mockReturnValue(1_000);
    queueSnapshot();
    await expect(service.getSnapshot()).resolves.toEqual(emptySnapshot());
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('never returns stale success or connection details when refresh fails', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const { service, query, transaction, queueSnapshot } = harness();
    queueSnapshot();
    await service.getSnapshot();
    clock.mockReturnValue(11_000);
    query.mockRejectedValueOnce(new Error('postgres://private-password@private-host'));
    await expect(service.getSnapshot()).rejects.toThrow('Сводка публикаций временно недоступна.');
    queueSnapshot();
    await expect(service.getSnapshot()).resolves.toEqual(emptySnapshot());
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('rejects a missing status and incomplete dimension evidence', async () => {
    const { service, queueSnapshot } = harness();
    queueSnapshot({ ...emptySnapshot(), rows: emptySnapshot().rows.slice(1) });
    await expect(service.getSnapshot()).rejects.toThrow(ServiceUnavailableException);
    const wrongDimension = emptySnapshot();
    wrongDimension.rows[0]!.mediaCounts.TEXT = 1;
    queueSnapshot(wrongDimension);
    await expect(service.getSnapshot()).rejects.toThrow(ServiceUnavailableException);
  });
});
