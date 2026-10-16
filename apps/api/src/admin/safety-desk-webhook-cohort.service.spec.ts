import { type SafetyDeskWebhookCohortResponse } from '@maxim/contracts/safety-desk';
import { ServiceUnavailableException } from '@nestjs/common';
import { type Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { SafetyDeskWebhookCohortService } from './safety-desk-webhook-cohort.service';

function emptySnapshot(): SafetyDeskWebhookCohortResponse {
  return {
    schemaVersion: 1,
    basis: 'receipt_created_at',
    windowSeconds: 30,
    graceSeconds: 30,
    windowStartedAt: '2035-01-01T00:00:00.000Z',
    windowEndedAt: '2035-01-01T00:00:30.000Z',
    observedAt: '2035-01-01T00:01:00.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 0,
    effectsEvidence: 'not_linked',
    rows: (
      [
        'RECEIVED',
        'QUEUED',
        'PROCESSED',
        'DUPLICATE',
        'FAILED',
        'NO_REPLAY_HELD',
        'CANCELLED',
        'QUARANTINED',
      ] as const
    ).map((status) => ({
      status,
      countLowerBound: 0,
      truncated: false,
      oldestPendingAgeSec: null,
      expiredAtObservation: 0,
      quarantineTimestampPresent: 0,
      invalidProcessedClocks: 0,
      invalidQueuedClocks: 0,
      processedLatency: { sampleCount: 0, p95Ms: null, p99Ms: null },
      enqueueLatency: { sampleCount: 0, p95Ms: null, p99Ms: null },
    })),
  };
}

function harness() {
  const query = jest.fn();
  const execute = jest.fn().mockResolvedValue(0);
  const transaction = jest.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    run({ $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient),
  );
  const prisma: Pick<PrismaService, '$transaction'> = {
    $transaction: transaction as unknown as PrismaService['$transaction'],
  };
  const service = new SafetyDeskWebhookCohortService(prisma as PrismaService);
  const queueSnapshot = (snapshot: unknown = emptySnapshot()) => {
    query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ snapshot }]);
  };
  return { service, query, execute, transaction, queueSnapshot };
}

describe('SafetyDeskWebhookCohortService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('coalesces concurrent reads and reuses only a fresh validated sample', async () => {
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
    clock.mockReturnValue(11_000);
    queueSnapshot();
    await service.getSnapshot();
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('refuses unindexed reads without executing the cohort query', async () => {
    const { service, query } = harness();
    query.mockResolvedValueOnce([{ ready: false }]);
    await expect(service.getSnapshot()).rejects.toThrow(ServiceUnavailableException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refreshes cached evidence after the wall clock moves backwards', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(11_000);
    const { service, transaction, queueSnapshot } = harness();
    queueSnapshot();
    await service.getSnapshot();
    clock.mockReturnValue(1_000);
    queueSnapshot();
    await expect(service.getSnapshot()).resolves.toEqual(emptySnapshot());
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('does not return stale success or expose storage errors after a failed refresh', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const { service, query, transaction, queueSnapshot } = harness();
    queueSnapshot();
    await service.getSnapshot();
    clock.mockReturnValue(11_000);
    query.mockRejectedValueOnce(new Error('postgres://private-password@private-host'));
    await expect(service.getSnapshot()).rejects.toThrow('Сводка обработки временно недоступна.');
    queueSnapshot();
    await expect(service.getSnapshot()).resolves.toEqual(emptySnapshot());
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed evidence instead of silently publishing partial status coverage', async () => {
    const { service, queueSnapshot } = harness();
    queueSnapshot({ ...emptySnapshot(), rows: emptySnapshot().rows.slice(1) });
    await expect(service.getSnapshot()).rejects.toThrow(ServiceUnavailableException);
  });
});
