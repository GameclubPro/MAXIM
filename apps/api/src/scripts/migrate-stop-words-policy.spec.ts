import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { Prisma } from '../prisma/prisma-client';
import { migrateStopWordsPolicies } from './migrate-stop-words-policy';

function harness() {
  const rows = [
    {
      id: 'row-1',
      chatId: 'chat-1',
      updatedAt: new Date(),
      stopWordsPolicy: null as unknown,
      stopWordsMedia: null as unknown,
      stopWordsRevision: 0,
      messageLimitsBlockedWords: ['casino'],
      messageLimitsBlockedDomains: [],
    },
    {
      id: 'row-2',
      chatId: 'chat-2',
      updatedAt: new Date(),
      stopWordsPolicy: stopWordsPolicySchema.parse({}) as unknown,
      stopWordsMedia: null as unknown,
      stopWordsRevision: 1,
      messageLimitsBlockedWords: [],
      messageLimitsBlockedDomains: [],
    },
  ];
  const tx = {
    $executeRaw: jest.fn(),
    chatSettings: {
      findMany: jest.fn(async (args: Prisma.ChatSettingsFindManyArgs) => {
        const after = typeof args.where?.id === 'object' ? args.where.id.gt : undefined;
        return rows
          .filter((row) => typeof after !== 'string' || row.id > after)
          .slice(0, args.take ?? rows.length);
      }),
      updateMany: jest
        .fn<Promise<Prisma.BatchPayload>, [Prisma.ChatSettingsUpdateManyArgs]>()
        .mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
  const invalidate = jest.fn();
  return { rows, tx, prisma, invalidate };
}

describe('bounded stop-word migration', () => {
  it('previews legacy and valid rows without writing or invalidating', async () => {
    const h = harness();
    expect(
      await migrateStopWordsPolicies({
        prisma: h.prisma as never,
        invalidate: h.invalidate,
        apply: false,
        limit: 10,
      }),
    ).toEqual({
      apply: false,
      after: null,
      limit: 10,
      scanned: 2,
      valid: 1,
      legacy: 1,
      eligible: 1,
      migrated: 0,
      conflicts: 0,
      invalid: 0,
      exhausted: true,
      stoppedBy: 'exhausted',
      nextCursor: 'row-2',
    });
    expect(h.tx.chatSettings.updateMany).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it.each(['policy', 'media', 'legacy'] as const)(
    'counts invalid %s without replacing it',
    async (invalid) => {
      const h = harness();
      if (invalid === 'legacy') h.rows[0]!.messageLimitsBlockedWords = [''];
      else if (invalid === 'policy') h.rows[0]!.stopWordsPolicy = { version: 99, enabled: true };
      else {
        h.rows[0]!.stopWordsPolicy = stopWordsPolicySchema.parse({});
        h.rows[0]!.stopWordsMedia = { explanation: { base64: 123 } };
      }
      const result = await migrateStopWordsPolicies({
        prisma: h.prisma as never,
        invalidate: h.invalidate,
        apply: true,
        limit: 10,
      });
      expect(result).toMatchObject({ scanned: 2, valid: 1, legacy: 0, invalid: 1, migrated: 0 });
      expect(result.scanned).toBe(result.valid + result.legacy + result.invalid);
      expect(h.tx.chatSettings.updateMany).not.toHaveBeenCalled();
      expect(h.tx.auditLog.create).not.toHaveBeenCalled();
      expect(h.invalidate.mock.calls).toEqual([['chat-2']]);
    },
  );

  it('limits the scan and resumes from its exact keyset cursor', async () => {
    const h = harness();
    const params = { prisma: h.prisma as never, invalidate: h.invalidate, apply: false, limit: 1 };
    const first = await migrateStopWordsPolicies(params);
    expect(first).toMatchObject({
      scanned: 1,
      legacy: 1,
      exhausted: false,
      stoppedBy: 'limit',
      nextCursor: 'row-1',
    });
    const second = await migrateStopWordsPolicies({ ...params, after: first.nextCursor! });
    expect(second).toMatchObject({
      after: 'row-1',
      scanned: 1,
      valid: 1,
      exhausted: false,
      stoppedBy: 'limit',
      nextCursor: 'row-2',
    });
    const final = await migrateStopWordsPolicies({ ...params, after: second.nextCursor! });
    expect(final).toMatchObject({
      after: 'row-2',
      scanned: 0,
      exhausted: true,
      stoppedBy: 'exhausted',
      nextCursor: 'row-2',
    });
    expect(h.tx.chatSettings.findMany.mock.calls.every(([args]) => args.take === 1)).toBe(true);
  });

  it('previews convertible legacy button state on a copy without changing raw settings', async () => {
    const h = harness();
    const row = Object.assign(h.rows[0]!, { messageLimitsBotButtonEnabled: true });
    const before = structuredClone(row);
    expect(
      await migrateStopWordsPolicies({
        prisma: h.prisma as never,
        invalidate: h.invalidate,
        apply: false,
        limit: 10,
      }),
    ).toMatchObject({ scanned: 2, valid: 1, legacy: 1, eligible: 1, invalid: 0 });
    expect(row).toEqual(before);
    expect(h.tx.chatSettings.updateMany).not.toHaveBeenCalled();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('reports the deadline as an incomplete scan and preserves its last cursor', async () => {
    const h = harness();
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(60_000);
    try {
      expect(
        await migrateStopWordsPolicies({
          prisma: h.prisma as never,
          invalidate: h.invalidate,
          apply: false,
          limit: 10,
        }),
      ).toMatchObject({ scanned: 1, exhausted: false, stoppedBy: 'deadline', nextCursor: 'row-1' });
    } finally {
      clock.mockRestore();
    }
  });

  it('migrates with optimistic locking, audits only committed changes and recovers invalidation', async () => {
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
        data: expect.objectContaining({ stopWordsRevision: { increment: 1 } }),
      }),
    );
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(h.invalidate.mock.calls).toEqual([['chat-1'], ['chat-2']]);
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

  it('does not hide invalidation failure after a committed migration', async () => {
    const h = harness();
    h.invalidate.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(
      migrateStopWordsPolicies({
        prisma: h.prisma as never,
        invalidate: h.invalidate,
        apply: true,
        limit: 10,
      }),
    ).rejects.toThrow('Redis unavailable');
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(h.tx.chatSettings.findMany).toHaveBeenCalledTimes(1);
  });
});
