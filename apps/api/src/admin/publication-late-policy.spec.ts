import { PublicationScheduleMode } from '../prisma/prisma-client';
import {
  isPublicationScheduledWindowExpired,
  isPublicationOccurrenceWindowClosed,
} from './publication-late-policy';

describe('Publication scheduled late policy', () => {
  const now = new Date('2026-09-30T09:00:00Z');
  it.each([
    PublicationScheduleMode.ONCE,
    PublicationScheduleMode.SLOTS,
    PublicationScheduleMode.RECURRENCE,
  ])('applies the same inclusive five-minute boundary to %s', (mode) => {
    const occurrence = { scheduledAt: new Date('2026-09-30T08:55:00Z'), schedule: { mode } };
    expect(isPublicationScheduledWindowExpired(occurrence, now)).toBe(false);
    expect(
      isPublicationScheduledWindowExpired(
        { ...occurrence, scheduledAt: new Date('2026-09-30T08:54:59.999Z') },
        now,
      ),
    ).toBe(true);
  });
  it('keeps NOW publications eligible during recovery', () => {
    expect(
      isPublicationScheduledWindowExpired(
        {
          scheduledAt: new Date('2026-09-29T00:00:00Z'),
          schedule: { mode: PublicationScheduleMode.NOW },
        },
        now,
      ),
    ).toBe(false);
  });
  it.each([
    ['2026-09-30T08:55:00Z', false],
    ['2026-09-30T08:54:59.999Z', true],
    ['2026-09-30T09:00:00.001Z', true],
  ])('bounds explicit retry authorization at %s', (retryAt, expired) => {
    expect(
      isPublicationScheduledWindowExpired(
        {
          scheduledAt: new Date('2026-09-29T00:00:00Z'),
          schedule: { mode: PublicationScheduleMode.ONCE },
          dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
          dispatchBlockedAt: new Date(retryAt),
        },
        now,
      ),
    ).toBe(expired);
  });

  it.each([
    ['2026-09-30T08:59:00Z', 'bot_access_expired', false],
    ['2026-09-30T08:54:59Z', 'PUBLISHER_EXPLICIT_RETRY', true],
    ['2026-09-30T09:00:01Z', 'PUBLISHER_EXPLICIT_RETRY', true],
  ])('uses dedicated author proof %s despite blocker %s', (retryAt, blockerCode, expired) => {
    expect(
      isPublicationScheduledWindowExpired(
        {
          scheduledAt: new Date('2026-09-29T00:00:00Z'),
          retryAuthorizedAt: new Date(retryAt),
          dispatchBlockerCode: blockerCode,
          dispatchBlockedAt: new Date('2026-09-30T09:00:00Z'),
          schedule: { mode: PublicationScheduleMode.ONCE },
        },
        now,
      ),
    ).toBe(expired);
  });
  it('keeps an unstarted new post recoverable for its authored 24-hour horizon', () => {
    const occurrence = {
      scheduledAt: new Date(now.getTime() - 15 * 60_000),
      schedule: {
        mode: PublicationScheduleMode.ONCE,
        rule: { latePolicy: { mode: 'recover', maxDelayMinutes: 1440, catchUp: 'latest' } },
      },
    };
    expect(isPublicationScheduledWindowExpired(occurrence, now)).toBe(false);
    expect(
      isPublicationScheduledWindowExpired(
        occurrence,
        new Date(occurrence.scheduledAt.getTime() + 1440 * 60_000 + 1),
      ),
    ).toBe(true);
  });
  it.each(['latest', 'all'] as const)(
    'uses only durable newer occurrences for %s catch-up',
    async (catchUp) => {
      const findFirst = jest.fn().mockResolvedValue({ id: 'newer' });
      const occurrence = {
        scheduledAt: new Date(now.getTime() - 15 * 60_000),
        scheduleRevision: 4,
        schedule: {
          id: 'schedule',
          mode: PublicationScheduleMode.RECURRENCE,
          rule: { latePolicy: { mode: 'recover', maxDelayMinutes: 1440, catchUp } },
        },
      };
      expect(
        await isPublicationOccurrenceWindowClosed(
          { publicationOccurrence: { findFirst } } as never,
          occurrence,
          now,
        ),
      ).toBe(catchUp === 'latest');
      if (catchUp === 'latest')
        expect(findFirst.mock.calls[0][0].where).toEqual({
          scheduleId: 'schedule',
          scheduleRevision: 4,
          scheduledAt: { gt: occurrence.scheduledAt, lte: now },
          status: { not: 'CANCELED' },
        });
      else expect(findFirst).not.toHaveBeenCalled();
    },
  );
});
