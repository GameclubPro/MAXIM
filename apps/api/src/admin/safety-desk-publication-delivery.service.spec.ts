import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { SafetyDeskPublicationDeliveryCohortService } from './safety-desk-publication-delivery-cohort.service';
import { SafetyDeskPublicationDeliveryEvidenceService } from './safety-desk-publication-delivery-evidence.service';
import { deliveryFixture } from './safety-desk-publication-delivery-test-fixture';
function harness() {
  const query = jest.fn(),
    execute = jest.fn().mockResolvedValue(0);
  const transaction = jest.fn(
    async (run: (tx: Prisma.TransactionClient) => Promise<unknown>, _options?: unknown) =>
      run({ $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient),
  );
  const prisma = {
    $transaction: transaction as unknown as PrismaService['$transaction'],
  } satisfies Pick<PrismaService, '$transaction'>;
  return {
    query,
    execute,
    transaction,
    cohort: new SafetyDeskPublicationDeliveryCohortService(prisma as PrismaService),
    evidence: new SafetyDeskPublicationDeliveryEvidenceService(prisma as PrismaService),
  };
}
function emptyRows() {
  const row = deliveryFixture();
  return ['PENDING', 'SENDING', 'SENT', 'FAILED', 'AMBIGUOUS', 'CANCELED'].map((headStatus) => ({
    ...row,
    id: null,
    headStatus,
    captured: 0,
    windowStartedAt: new Date(row.observedAt.getTime() - 930000),
    windowEndedAt: new Date(row.observedAt.getTime() - 30000),
  }));
}
describe('Read-only delivery observation services', () => {
  afterEach(() => jest.restoreAllMocks());
  it('coalesces and caches the validated closed snapshot, with repeatable read', async () => {
    const h = harness();
    h.query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce(emptyRows());
    const first = h.cohort.getSnapshot();
    expect(h.cohort.getSnapshot()).toBe(first);
    const result = await first;
    expect(result.totalCountLowerBound).toBe(0);
    expect(await h.cohort.getSnapshot()).toBe(result);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: 'RepeatableRead',
      maxWait: 2000,
      timeout: 5000,
    });
    expect(h.execute.mock.calls.map(([strings]) => strings.join(''))).toEqual([
      'SET TRANSACTION READ ONLY',
      "SET LOCAL statement_timeout = '2000ms'",
      "SET LOCAL lock_timeout = '250ms'",
    ]);
  });
  it('refuses absent index evidence before any data access', async () => {
    const h = harness();
    h.query.mockResolvedValue([{ ready: false }]);
    await expect(h.cohort.getSnapshot()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.query).toHaveBeenCalledTimes(1);
    await expect(h.evidence.getEvidence('recipient')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(h.query).toHaveBeenCalledTimes(2);
  });
  it('never returns stale success or raw error details after timeout', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000),
      h = harness();
    h.query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce(emptyRows());
    await h.cohort.getSnapshot();
    clock.mockReturnValue(11000);
    h.query.mockRejectedValueOnce(new Error('private-connection secret timeout'));
    await expect(h.cohort.getSnapshot()).rejects.toThrow('Сводка доставок временно недоступна.');
    h.query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce(emptyRows());
    expect((await h.cohort.getSnapshot()).totalCountLowerBound).toBe(0);
  });
  it('rejects malformed IDs and preserves exact absence as404', async () => {
    const h = harness();
    await expect(h.evidence.getEvidence(' recipient ')).rejects.toBeInstanceOf(BadRequestException);
    expect(h.query).not.toHaveBeenCalled();
    h.query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([]);
    await expect(h.evidence.getEvidence('recipient')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('does not broaden lookup for missing saved content attribution', async () => {
    const h = harness();
    h.query
      .mockResolvedValueOnce([{ ready: true }])
      .mockResolvedValueOnce([deliveryFixture({ contentRevisionId: null })]);
    expect(await h.evidence.getEvidence('recipient')).toMatchObject({
      binding: 'not_recorded',
      action: { keyBasis: 'unavailable' },
      automaticRetryAllowed: false,
    });
    expect(h.query).toHaveBeenCalledTimes(2);
  });
});
