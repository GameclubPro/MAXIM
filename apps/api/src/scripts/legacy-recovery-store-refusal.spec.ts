import type { Prisma } from '../prisma/prisma-client';
import { inventoryLegacyRecoverySelectedSql } from './legacy-recovery-live-sql';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import { classifyLegacyRecoveryStoreRefusal } from './legacy-recovery-store-refusal';

describe('fixed legacy recovery store refusal diagnostics', () => {
  it.each([
    [{ code: 'P2028' }, 'transaction_unavailable'],
    [{ code: '57014' }, 'query_cancelled'],
    [{ code: 'P1008' }, 'query_timeout'],
    [{ code: 'P2024' }, 'pool_timeout'],
    [{ code: '55P03' }, 'lock_unavailable'],
    [{ code: '40P01' }, 'deadlock'],
    [{ code: 'ECONNRESET' }, 'connection_unavailable'],
    [{ code: 'P1001' }, 'connection_unavailable'],
    [{ code: 'P2010', meta: { code: '57014' } }, 'query_cancelled'],
    [
      { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '57014' } } } },
      'query_cancelled',
    ],
    [{ code: 'private-credential', message: 'private-source-text' }, 'query_failed'],
    [{ message: 'P2028 57014 private-source-text' }, 'query_failed'],
    ['57014', 'query_failed'],
    [null, 'query_failed'],
  ])('classifies only recognized structured codes: %j', (error, expected) => {
    expect(classifyLegacyRecoveryStoreRefusal(error)).toBe(expected);
  });

  it('bounds cycles without serializing unknown diagnostic content', () => {
    const cycle = { cause: null as unknown, message: 'private-source-text' };
    cycle.cause = cycle;
    expect(classifyLegacyRecoveryStoreRefusal(cycle)).toBe('query_failed');
  });

  it('retains the exact fixed SQL stage and safe driver category on a failed store read', async () => {
    const tx = {
      $queryRaw: jest.fn().mockRejectedValue({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '57014' } } },
        message: 'private-query-text private-password',
      }),
    };
    const result = await inventoryLegacyRecoverySelectedSql(
      tx as unknown as Prisma.TransactionClient,
      { selection: { ownerWebhookEventIds: ['owner'], majorBotIds: ['major'] } },
      { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30_000 },
    );
    expect(result.issues).toEqual([
      { code: 'sql_inventory_query_failed', descriptor: 'sql:inventory' },
      { code: 'sql_store_query_cancelled', descriptor: 'sql:snapshot' },
    ]);
    expect(result.candidates).toEqual([]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/private-|57014|P2010/u);
  });
});
