import type { ChannelStatsResponse } from '@maxim/contracts';
import { mergeChannelAudienceObservations } from './admin-channel-stats-audience';
import { AdminChannelStatsRuntime } from './admin-channel-stats-runtime';
import type { AdminChannelStatsRuntimeContext } from './admin-channel-stats-runtime-context';
import type { StatisticsExchangeAudienceService } from '../integrations/marketplace/statistics-exchange-audience.service';

const at = (time: string, participantsCount: number) => ({
  capturedAt: new Date(time),
  participantsCount,
});
const now = new Date('2026-10-23T12:00:00.000Z');
const native = at('2026-10-23T11:00:00.000Z', 100);
const newer = at('2026-10-23T11:50:00.000Z', 150);
const query = { range: '7d' as const, includeActivityPreview: false, mode: 'overview' as const };

function fixture() {
  const importedAudience = jest
    .fn<
      ReturnType<StatisticsExchangeAudienceService['importedAudience']>,
      Parameters<StatisticsExchangeAudienceService['importedAudience']>
    >()
    .mockResolvedValue([newer]);
  const prisma = {
    chat: { findUnique: jest.fn().mockResolvedValue({ id: '-100', title: 'Synthetic channel' }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    channelAudienceSnapshot: {
      findFirst: jest
        .fn()
        .mockImplementation(async (input: { where: { capturedAt?: unknown } }) =>
          input.where.capturedAt ? null : native,
        ),
      findMany: jest.fn().mockResolvedValue([native]),
      create: jest.fn(),
    },
    channelStatsSyncState: {
      findUnique: jest.fn().mockResolvedValue({
        lastAudienceSyncAt: native.capturedAt,
        lastViewsSyncAt: now,
        lastViewsDiscoveryAt: now,
        membershipCoverageFrom: null,
      }),
    },
    channelPost: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const context: AdminChannelStatsRuntimeContext = {
    prisma: prisma as never,
    maxClient: { getChatSnapshot: jest.fn() } as never,
    chatContextCache: {} as never,
    logger: { warn: jest.fn() } as never,
    statisticsExchange: { importedAudience },
    assertReadOnlyChatAdmin: jest.fn().mockResolvedValue(undefined),
    ensureEntityType: jest.fn().mockResolvedValue(undefined),
    getMembershipActivityFeedPage: jest.fn(),
    buildEmptyMembershipActivityPage: () => ({ items: [], hasMore: false, nextCursor: null }),
    resolveAssistBotAssignment: jest.fn(),
  };
  return { runtime: new AdminChannelStatsRuntime(context), importedAudience, prisma };
}

describe('ordinary channel statistics supplemental audience', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('selects real observations by time, preserves zero and gives native the equal-time tie', () => {
    expect(
      mergeChannelAudienceObservations(
        [native],
        [
          at(native.capturedAt.toISOString(), 999),
          newer,
          at('2026-10-23T12:01:00.000Z', 999),
          at('2026-10-22T12:00:00.000Z', 0),
        ],
        now,
      ),
    ).toEqual([at('2026-10-22T12:00:00.000Z', 0), native, newer]);
  });

  it('supplements ordinary current/history without native writes or invented membership/views', async () => {
    const f = fixture();
    const result = await f.runtime.getChannelStats(
      '-100',
      { userId: '101', username: null, displayName: null, chatTitle: null },
      query,
    );
    expect(result.channel.participantsCount).toBe(150);
    expect(result.summary.subscribers.current).toBe(150);
    expect(result.official.series.participants.at(-1)?.participantsCount).toBe(150);
    expect(result.official.audience).toEqual({ joined: 0, left: 0, net: 0 });
    expect(result.meta.churnAvailable).toBe(false);
    expect(result.meta.viewsAvailable).toBe(false);
    expect(f.prisma.channelAudienceSnapshot.create).not.toHaveBeenCalled();
    expect(f.importedAudience).toHaveBeenCalledWith('101', '-100', 'CHANNEL');
  });

  it('does not reuse a supplemental response for another actor or after grant removal', async () => {
    const f = fixture();
    const build = jest
      .spyOn(f.runtime, 'buildChannelStatsResponse')
      .mockResolvedValue({ meta: { refreshQueued: false } } as ChannelStatsResponse);
    const actor = { userId: '101', username: null, displayName: null, chatTitle: null };
    await f.runtime.getChannelStats('-100', actor, query);
    await f.runtime.getChannelStats('-100', actor, query);
    expect(build).toHaveBeenCalledTimes(1);
    await f.runtime.getChannelStats('-100', { ...actor, userId: '102' }, query);
    expect(build).toHaveBeenCalledTimes(2);
    f.importedAudience.mockResolvedValue([]);
    await f.runtime.getChannelStats('-100', actor, query);
    expect(build).toHaveBeenCalledTimes(3);
  });
});
