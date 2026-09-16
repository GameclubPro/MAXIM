import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { migrateStopWordsPolicies } from './migrate-stop-words-policy';

function harness() {
  const rows = [
    {
      id: 'row-1',
      chatId: 'chat-1',
      updatedAt: new Date(),
      stopWordsPolicy: null,
      stopWordsRevision: 0,
      messageLimitsBlockedWords: ['casino'],
      messageLimitsBlockedDomains: [],
    },
    {
      id: 'row-2',
      chatId: 'chat-2',
      updatedAt: new Date(),
      stopWordsPolicy: stopWordsPolicySchema.parse({}),
      stopWordsRevision: 1,
      messageLimitsBlockedWords: [],
      messageLimitsBlockedDomains: [],
    },
  ];
  const tx = {
    $executeRaw: jest.fn(),
    chatSettings: {
      findMany: jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
  const invalidate = jest.fn();
  return { rows, tx, prisma, invalidate };
}

describe('bounded stop-word migration', () => {
  it('is read-only by default and skips existing policies', async () => {
    const h = harness();
    expect(
      await migrateStopWordsPolicies({
        prisma: h.prisma as never,
        invalidate: h.invalidate,
        apply: false,
        limit: 10,
      }),
    ).toMatchObject({ scanned: 2, eligible: 1, migrated: 0, exhausted: true });
    expect(h.tx.chatSettings.updateMany).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });
  it('migrates with optimistic locking and invalidates only committed changes', async () => {
    const h = harness();
    expect(
      await migrateStopWordsPolicies({
        prisma: h.prisma as never,
        invalidate: h.invalidate,
        apply: true,
        limit: 10,
      }),
    ).toMatchObject({ migrated: 1, conflicts: 0 });
    expect(h.tx.chatSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'row-1', updatedAt: h.rows[0]!.updatedAt, stopWordsRevision: 0 },
      }),
    );
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledWith('chat-1');
  });
  it('preserves a concurrent change instead of replacing it', async () => {
    const h = harness();
    h.tx.chatSettings.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await migrateStopWordsPolicies({
        prisma: h.prisma as never,
        invalidate: h.invalidate,
        apply: true,
        limit: 10,
      }),
    ).toMatchObject({ migrated: 0, conflicts: 1 });
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalledWith('chat-1');
  });
});
