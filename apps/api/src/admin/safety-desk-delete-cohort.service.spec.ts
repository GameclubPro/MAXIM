import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { emptyDeleteCohortRecords } from './safety-desk-delete-cohort.fixture';
import { projectSafetyDeskDeleteCohort } from './safety-desk-delete-cohort.model';
import { SafetyDeskDeleteCohortService } from './safety-desk-delete-cohort.service';

function harness() {
  const query = jest.fn<
    ReturnType<Prisma.TransactionClient['$queryRaw']>,
    Parameters<Prisma.TransactionClient['$queryRaw']>
  >();
  const execute = jest
    .fn<
      ReturnType<Prisma.TransactionClient['$executeRaw']>,
      Parameters<Prisma.TransactionClient['$executeRaw']>
    >()
    .mockResolvedValue(0);
  const transaction = jest.fn(
    async (
      run: (tx: Prisma.TransactionClient) => Promise<unknown>,
      _options?: {
        isolationLevel: Prisma.TransactionIsolationLevel;
        maxWait: number;
        timeout: number;
      },
    ) => run({ $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient),
  );
  const prisma: Pick<PrismaService, '$transaction'> = {
    $transaction: transaction as unknown as PrismaService['$transaction'],
  };
  const service = new SafetyDeskDeleteCohortService(prisma as PrismaService);
  const queueSnapshot = (records: unknown = emptyDeleteCohortRecords()) =>
    query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce(records);
  return { service, query, execute, transaction, queueSnapshot };
}

describe('SafetyDeskDeleteCohortService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('coalesces one bounded read-only RepeatableRead snapshot for ten seconds', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const { service, query, execute, transaction, queueSnapshot } = harness();
    queueSnapshot();
    const first = service.getSnapshot();
    expect(service.getSnapshot()).toBe(first);
    const snapshot = await first;
    expect(snapshot).toEqual(projectSafetyDeskDeleteCohort(emptyDeleteCohortRecords()));
    expect(await service.getSnapshot()).toBe(snapshot);
    expect(query).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(
      execute.mock.calls.map(([strings]) => (Array.isArray(strings) ? strings.join('') : '')),
    ).toEqual([
      'SET TRANSACTION READ ONLY',
      "SET LOCAL statement_timeout = '2000ms'",
      "SET LOCAL lock_timeout = '250ms'",
    ]);
    expect(transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 2_000,
      timeout: 5_000,
    });
    clock.mockReturnValue(11_000);
    queueSnapshot();
    await service.getSnapshot();
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each([false, null, undefined])(
    'refuses absent exact index proof %s before a data read',
    async (ready) => {
      const { service, query } = harness();
      query.mockResolvedValueOnce([{ ready }]);
      await expect(service.getSnapshot()).rejects.toThrow(ServiceUnavailableException);
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it('does not expose SQL errors, retry a failed read or return stale evidence', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const { service, query, transaction, queueSnapshot } = harness();
    queueSnapshot();
    await service.getSnapshot();
    clock.mockReturnValue(11_000);
    query.mockRejectedValueOnce(new Error('postgres://private-password@private-host'));
    await expect(service.getSnapshot()).rejects.toThrow('Сводка удалений временно недоступна.');
    expect(query).toHaveBeenCalledTimes(3);
    expect(transaction).toHaveBeenCalledTimes(2);
    queueSnapshot();
    await expect(service.getSnapshot()).resolves.toHaveProperty('totalCountLowerBound', 0);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('refreshes after clock reversal and rejects incomplete evidence', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(11_000);
    const { service, transaction, queueSnapshot } = harness();
    queueSnapshot();
    await service.getSnapshot();
    clock.mockReturnValue(1_000);
    queueSnapshot(emptyDeleteCohortRecords().slice(1));
    await expect(service.getSnapshot()).rejects.toThrow(ServiceUnavailableException);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
