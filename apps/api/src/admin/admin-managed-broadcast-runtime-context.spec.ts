import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import {
  createAdminManagedBroadcastRuntimeContext,
  type AdminManagedBroadcastRuntimeContext,
} from './admin-managed-broadcast-runtime-context';

function dependencies(): AdminManagedBroadcastRuntimeContext {
  return {
    prisma: {} as never,
    maxClient: {} as never,
    logger: { log: jest.fn(), warn: jest.fn() } as never,
    resolveSystemModeSnapshot: jest.fn().mockResolvedValue({
      mode: 'degrade',
      source: 'auto',
      reason: 'pressure',
    }),
    resolveDeliveryBotAssignment: jest.fn(),
    resolvePrivateDeliveryBotId: jest.fn(),
    resolvePrivateDialogChatId: jest.fn(),
    listChatsForMassBroadcast: jest.fn(),
    assertManagedEntityAdminAccess: jest.fn(),
    assertManagedEntityReadAccess: jest.fn(),
    resolveBroadcastButtonContext: jest.fn(),
  };
}

describe('managed broadcast capability boundary', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps throttle state per runtime and shares the interval across pressure sources', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-03T10:00:00Z'));
    const base = dependencies();
    const decide = jest
      .fn()
      .mockResolvedValue({ action: 'pause', reason: 'load', retryAfterMs: 5000 });
    let governor: AdminManagedBroadcastRuntimeContext['backgroundRuntimeGovernorService'] = {
      decide,
    } as never;
    const context = createAdminManagedBroadcastRuntimeContext({
      ...base,
      get backgroundRuntimeGovernorService() {
        return governor;
      },
    });
    const first = new AdminManagedBroadcastRuntime(context);
    const second = new AdminManagedBroadcastRuntime(context);
    await first.processDueManagedBroadcasts('startup');
    await first.processDueManagedBroadcasts('scheduled');
    expect(base.logger.log).toHaveBeenCalledTimes(1);
    await second.processDueManagedBroadcasts('scheduled');
    expect(base.logger.log).toHaveBeenCalledTimes(2);
    governor = undefined;
    await first.processDueManagedBroadcasts('scheduled');
    expect(base.logger.log).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(60_000);
    await first.processDueManagedBroadcasts('scheduled');
    expect(base.logger.log).toHaveBeenCalledTimes(3);
    expect(base.resolveSystemModeSnapshot).toHaveBeenCalledTimes(2);
    expect(context).not.toHaveProperty('managedBroadcastDegradePauseLogAtMs');
  });

  it('preserves authorization failure before reading publication rows', async () => {
    const base = dependencies();
    const denied = new Error('revoked');
    const read = jest.fn().mockRejectedValue(denied);
    const findMany = jest.fn();
    const context = createAdminManagedBroadcastRuntimeContext({
      ...base,
      prisma: { managedBroadcast: { findMany } } as never,
      assertManagedEntityReadAccess: read,
    });
    const runtime = new AdminManagedBroadcastRuntime(context);
    const user = { userId: 'user-1', chatId: 'private-1', username: null, displayName: 'User' };
    await expect(runtime.listManagedBroadcasts('chat-1', user)).rejects.toBe(denied);
    expect(read).toHaveBeenCalledWith('chat-1', 'user-1', 'chat', {});
    expect(findMany).not.toHaveBeenCalled();
  });
});
