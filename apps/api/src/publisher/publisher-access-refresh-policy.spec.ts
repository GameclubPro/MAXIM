import { ConfigService } from '@nestjs/config';
import {
  PublisherAccessRefreshPolicy,
  publisherRosterRetryAt,
} from './publisher-access-refresh-policy';

describe('Publisher access rollout policy', () => {
  it('selects a stable exact-bot 10% cohort and keeps queue priorities global', () => {
    const policy = new PublisherAccessRefreshPolicy(
      new ConfigService({ MAX_PUBLISHER_ACCESS_REFRESH_MODE: 'canary' }),
    );
    const restarted = new PublisherAccessRefreshPolicy(
      new ConfigService({ MAX_PUBLISHER_ACCESS_REFRESH_MODE: 'canary' }),
    );
    const chats = Array.from({ length: 10000 }, (_, i) => `chat-${i}`);
    const selected = chats.filter((id) => policy.separatesMaintenance('publisher', id));
    expect(selected.length).toBeGreaterThan(900);
    expect(selected.length).toBeLessThan(1100);
    expect(selected).toEqual(chats.filter((id) => restarted.separatesMaintenance('publisher', id)));
    expect(selected).not.toEqual(chats.filter((id) => policy.separatesMaintenance('other', id)));
    expect(policy.deadlinePrioritiesEnabled).toBe(true);
    const now = new Date();
    for (const id of selected) {
      const initial = policy.initialRosterRefreshAt('publisher', id, now);
      expect(initial.getTime()).toBeGreaterThanOrEqual(now.getTime());
      expect(initial.getTime()).toBeLessThan(now.getTime() + 30 * 60000);
      expect(initial).toEqual(restarted.initialRosterRefreshAt('publisher', id, now));
    }
  });
  it('defaults to the compatible rollback behavior', () => {
    const policy = new PublisherAccessRefreshPolicy();
    expect(policy.deadlinePrioritiesEnabled).toBe(false);
    expect(policy.separatesMaintenance('publisher', 'chat')).toBe(false);
  });
});

describe('Publisher roster retry deadline', () => {
  it.each([
    [{ retryAfterMs: 120000 }, 120000],
    [{ response: { headers: { 'retry-after': '7200' } } }, 7200000],
    [{ response: { headers: { 'Retry-After': ['180', '240'] } } }, 240000],
    [{ response: { headers: { 'retry-after': 'Fri, 02 Oct 2026 12:05:00 GMT' } } }, 300000],
    [{ retryAfterMs: Infinity }, 60000],
    [{ response: { headers: { 'retry-after': '-7200' } } }, 60000],
  ])('honors valid retry metadata without changing access: %j', (error, delay) => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(publisherRosterRetryAt(error, now).getTime()).toBe(now + delay);
  });
});
