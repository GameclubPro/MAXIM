import type { ChannelStatsResponse } from '@maxim/contracts';
import { AdminChannelStatsRuntime } from './admin-channel-stats-runtime';
import type { AdminChannelStatsRuntimeContext } from './admin-channel-stats-runtime-context';
import { createDeferred } from './admin-service-test-support';

const actor = { userId: 'admin-1', username: null, displayName: null, chatTitle: null };
const query = { range: '7d', includeActivityPreview: false };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const assertReadOnlyChatAdmin = jest.fn().mockResolvedValue(undefined);
  const syncChannelIfStale = jest.fn().mockResolvedValue(undefined);
  const context: AdminChannelStatsRuntimeContext = {
    prisma: {} as never,
    maxClient: {} as never,
    chatContextCache: {} as never,
    logger: { warn: jest.fn() } as never,
    channelStatsCollector: { syncChannelIfStale } as never,
    getMembershipActivityFeedPage: jest.fn(),
    buildEmptyMembershipActivityPage: jest.fn(),
    resolveAssistBotAssignment: jest.fn(),
    assertReadOnlyChatAdmin,
    ensureEntityType: jest.fn().mockResolvedValue(undefined),
  };
  const runtime = new AdminChannelStatsRuntime(context);
  const response = { meta: { refreshQueued: false } } as ChannelStatsResponse;
  const build = jest.spyOn(runtime, 'buildChannelStatsResponse').mockResolvedValue(response);
  return { runtime, build, response, assertReadOnlyChatAdmin, syncChannelIfStale };
}

describe('channel stats runtime state ownership', () => {
  it('authorizes every cached read, including a different actor and a revoked grant', async () => {
    const { runtime, response, build, assertReadOnlyChatAdmin } = fixture();
    await expect(runtime.getChannelStats('channel-1', actor, query)).resolves.toBe(response);
    await expect(
      runtime.getChannelStats('channel-1', { ...actor, userId: 'admin-2' }, query),
    ).resolves.toBe(response);
    assertReadOnlyChatAdmin.mockRejectedValueOnce(new Error('access revoked'));
    await expect(runtime.getChannelStats('channel-1', actor, query)).rejects.toThrow(
      'access revoked',
    );
    expect(assertReadOnlyChatAdmin).toHaveBeenCalledTimes(3);
    expect(assertReadOnlyChatAdmin).toHaveBeenNthCalledWith(2, 'channel-1', 'admin-2', 'channel', {
      forceRemote: true,
    });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('shares pending reads and retries a failed read without retaining its rejected promise', async () => {
    const { runtime, build, response } = fixture();
    const first = createDeferred<ChannelStatsResponse>();
    build.mockReturnValueOnce(first.promise);
    const outcomes = Promise.allSettled([
      runtime.getChannelStats('channel-1', actor, query),
      runtime.getChannelStats('channel-1', actor, query),
    ]);
    await flush();
    expect(build).toHaveBeenCalledTimes(1);
    first.reject(new Error('read failed'));
    expect((await outcomes).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(runtime.getChannelStats('channel-1', actor, query)).resolves.toBe(response);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('does not evict a replacement response when the previous pending read fails late', async () => {
    const { runtime, build, response } = fixture();
    const first = createDeferred<ChannelStatsResponse>();
    build.mockReturnValueOnce(first.promise);
    const oldRead = runtime.getChannelStats('channel-1', actor, query);
    const oldOutcome = expect(oldRead).rejects.toThrow('old read failed');
    await flush();
    runtime.invalidateChannelStatsResponseCache('channel-1');
    await expect(runtime.getChannelStats('channel-1', actor, query)).resolves.toBe(response);
    first.reject(new Error('old read failed'));
    await oldOutcome;
    await expect(runtime.getChannelStats('channel-1', actor, query)).resolves.toBe(response);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the selected channel', async () => {
    const { runtime, build } = fixture();
    await runtime.getChannelStats('channel-1', actor, query);
    await runtime.getChannelStats('channel-2', actor, query);
    runtime.invalidateChannelStatsResponseCache('channel-1');
    await runtime.getChannelStats('channel-2', actor, query);
    expect(build).toHaveBeenCalledTimes(2);
    await runtime.getChannelStats('channel-1', actor, query);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('coalesces background refreshes and invalidates the response when refresh finishes', async () => {
    const { runtime, build, syncChannelIfStale } = fixture();
    const refresh = createDeferred<void>();
    syncChannelIfStale.mockReturnValueOnce(refresh.promise);
    await runtime.getChannelStats('channel-1', actor, query);
    expect(runtime.scheduleChannelStatsRefresh('channel-1')).toBe(true);
    expect(runtime.scheduleChannelStatsRefresh('channel-1')).toBe(true);
    await flush();
    expect(syncChannelIfStale).toHaveBeenCalledTimes(1);
    await runtime.getChannelStats('channel-1', actor, query);
    expect(build).toHaveBeenCalledTimes(1);
    refresh.resolve();
    await flush();
    await runtime.getChannelStats('channel-1', actor, query);
    expect(build).toHaveBeenCalledTimes(2);
    runtime.scheduleChannelStatsRefresh('channel-1');
    await flush();
    expect(syncChannelIfStale).toHaveBeenCalledTimes(2);
  });
});
