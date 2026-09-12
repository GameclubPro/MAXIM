import type { ChatParticipantsQuery } from '@maxim/contracts';
import type { MaxChatRosterMember } from '../max/max-client.service';
import {
  matchesParticipantActivity,
  scanParticipantActivityPage,
} from './participant-activity-page';

const now = Date.parse('2026-09-12T12:00:00Z');
const day = 86_400_000;
const member = (userId: string, age: number | null): MaxChatRosterMember => ({
  userId,
  displayName: userId,
  username: null,
  avatarUrl: null,
  profileUrl: null,
  role: 'member',
  isBot: false,
  unavailableReason: null,
  lastMaxActivityAt: age === null ? null : new Date(now - age * day).toISOString(),
});
const query: ChatParticipantsQuery = {
  range: '7d',
  roleFilter: 'all',
  activityFilter: '30d',
  limit: 1,
};

describe('participant activity pagination', () => {
  it.each([7, 14, 30, 60, 90])(
    'includes exactly %i days but not one millisecond younger',
    (days) => {
      const filter = `${days}d` as ChatParticipantsQuery['activityFilter'];
      expect(matchesParticipantActivity(member('a', days), filter, now)).toBe(true);
      expect(matchesParticipantActivity(member('a', days - 1 / day), filter, now)).toBe(false);
      expect(matchesParticipantActivity(member('a', null), filter, now)).toBe(false);
    },
  );
  it('keeps a new activity later than the cursor baseline out of unknown', () => {
    expect(matchesParticipantActivity(member('a', -1 / day), 'unknown', now)).toBe(false);
  });
  it('resumes from raw roster offsets, not filtered offsets', async () => {
    const load = jest.fn().mockResolvedValue({
      items: [member('recent', 1), member('old-a', 40), member('old-b', 50)],
      nextMarker: null,
    });
    const params = {
      chatId: 'chat',
      userId: 'admin',
      query,
      load,
      matches: () => true,
      maxPages: 2,
      now,
    };
    const first = await scanParticipantActivityPage(params);
    expect(first.items.map((item) => item.userId)).toEqual(['old-a']);
    const second = await scanParticipantActivityPage({
      ...params,
      query: { ...query, cursor: first.nextMarker! },
    });
    expect(second.items.map((item) => item.userId)).toEqual(['old-b']);
    expect(second.nextMarker).toBeNull();
  });
  it('bounds sparse scans and continues with a cursor', async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce({ items: [member('a', 1)], nextMarker: 'page2' })
      .mockResolvedValueOnce({ items: [member('b', 2)], nextMarker: 'page3' });
    const result = await scanParticipantActivityPage({
      chatId: 'chat',
      userId: 'admin',
      query,
      load,
      matches: () => true,
      maxPages: 2,
      now,
    });
    expect(result.items).toEqual([]);
    expect(result.nextMarker).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('rejects cross-chat, cross-user, filter-changed and expired cursors before MAX', async () => {
    const load = jest
      .fn()
      .mockResolvedValue({ items: [member('a', 40), member('b', 50)], nextMarker: null });
    const params = {
      chatId: 'chat',
      userId: 'admin',
      query,
      load,
      matches: () => true,
      maxPages: 2,
      now,
    };
    const page = await scanParticipantActivityPage(params);
    load.mockClear();
    for (const override of [
      { chatId: 'other' },
      { userId: 'other' },
      { now: now + 31 * 60_000 },
      { query: { ...query, activityFilter: '7d' as const, cursor: page.nextMarker! } },
    ]) {
      await expect(
        scanParticipantActivityPage({
          ...params,
          query: { ...query, cursor: page.nextMarker! },
          ...override,
        }),
      ).rejects.toThrow('Обновите');
    }
    expect(load).not.toHaveBeenCalled();
  });
  it('rejects repeated remote markers', async () => {
    const load = jest.fn().mockResolvedValue({ items: [], nextMarker: 'again' });
    await expect(
      scanParticipantActivityPage({
        chatId: 'chat',
        userId: 'admin',
        query,
        load,
        matches: () => true,
        maxPages: 2,
        now,
      }),
    ).rejects.toThrow('повторил');
  });
});
