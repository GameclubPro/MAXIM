import { AdminManagedEntityAccessRuntime } from './admin-managed-entity-access-runtime';
import type { AdminManagedEntityAccessRuntimeContext } from './admin-managed-entity-access-runtime-context';

function fixture() {
  const updateMany = jest.fn().mockResolvedValue({ count: 2 });
  const warn = jest.fn();
  const context: AdminManagedEntityAccessRuntimeContext = {
    prisma: {} as never,
    chatContextCache: {} as never,
    logger: { warn } as never,
    managedEntitiesRuntimeBotIds: new Set(['major-1', 'major-2']),
    accessEdges: { updateMany },
    forgetManagedEntitiesLastSuccessChat: jest.fn(),
    invalidateManagedEntitiesAllowlistCache: jest.fn(),
    normalizeManagedEntityAccessBotId: jest.fn(),
  };
  return { runtime: new AdminManagedEntityAccessRuntime(context), context, updateMany, warn };
}

const denial = {
  chatId: ' chat-1 ',
  userId: ' actor-1 ',
  state: 'USER_DENIED' as const,
  deniedReason: 'not_admin',
  source: 'remote',
};

describe('managed entity access runtime capabilities', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-03T12:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it('limits denial writes to the live Major bot scope, preserving Publisher edges', async () => {
    const { runtime, context, updateMany } = fixture();
    await runtime.markManagedEntityAccessEdgesDeniedForUser(denial);
    expect(updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', userId: 'actor-1', botId: { in: ['major-1', 'major-2'] } },
      data: {
        state: 'USER_DENIED',
        userRole: 'MEMBER',
        botRole: 'UNKNOWN',
        checkedAt: new Date(),
        expiresAt: null,
        deniedReason: 'not_admin',
        source: 'remote',
      },
    });
    const newWriter = jest.fn().mockResolvedValue({ count: 0 });
    Object.assign(context, {
      managedEntitiesRuntimeBotIds: new Set(['major-3']),
      accessEdges: { updateMany: newWriter },
    });
    await runtime.markManagedEntityAccessEdgesDeniedForUser({ ...denial, state: 'BOT_DENIED' });
    expect(newWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: 'chat-1', userId: 'actor-1', botId: { in: ['major-3'] } },
        data: expect.objectContaining({ userRole: 'UNKNOWN', botRole: 'MEMBER' }),
      }),
    );
  });

  it('does not attempt a write for missing capability or blank identity', async () => {
    const { runtime, context, updateMany } = fixture();
    await runtime.markManagedEntityAccessEdgesDeniedForUser({ ...denial, userId: ' ' });
    Object.assign(context, { accessEdges: null });
    await runtime.markManagedEntityAccessEdgesDeniedForUser(denial);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('preserves best-effort denial logging without throwing a persistence failure', async () => {
    const { runtime, updateMany, warn } = fixture();
    updateMany.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      runtime.markManagedEntityAccessEdgesDeniedForUser(denial),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'USER_DENIED', err: 'database unavailable' }),
      'Failed to mark managed entity access edges denied',
    );
  });
});
