import { describe, expect, it } from 'vitest';
import { publicationScheduleInputSchema } from '../src/publication.js';
import { publicationPostActionRequestSchema } from '../src/publication-post-action-request.js';
import { scheduleVkParsingPostRequestSchema } from '../src/vk-parsing.js';
import { scheduleDomainRemovalRequestSchema } from '../src/navigation-allowlist.js';
import { offsetTimestampSchema, utcTimestampSchema } from '../src/validator-compat.js';

describe('public timestamp compatibility after the validator security update', () => {
  it.each([
    '2026-10-20T00:00Z',
    '2026-10-20T00:00:00Z',
    '2026-10-20T00:00:00.0Z',
    '2026-10-20T00:00:00.123456789Z',
  ])('retains UTC spelling at real scheduling request boundaries: %s', (value) => {
    expect(utcTimestampSchema.parse(value)).toBe(value);
    expect(scheduleVkParsingPostRequestSchema.parse({ scheduledAt: value }).scheduledAt).toBe(
      value,
    );
    expect(scheduleDomainRemovalRequestSchema.parse({ removeAfterAt: value }).removeAfterAt).toBe(
      value,
    );
    expect(
      publicationPostActionRequestSchema.parse({
        requestId: 'timestamp-compat',
        expectedVersion: 'a'.repeat(64),
        action: 'reschedule_delete',
        deleteAt: value,
      }),
    ).toEqual({
      requestId: 'timestamp-compat',
      expectedVersion: 'a'.repeat(64),
      action: 'reschedule_delete',
      deleteAt: value,
    });
  });

  it.each([
    '2026-10-20T00:00Z',
    '2026-10-20T00:00+03:00',
    '2026-10-20T00:00-04:30',
    '2026-10-20T00:00:00+03:00',
    '2026-10-20T00:00:00.123456789-04:30',
  ])('retains offset spelling for once, slots and recurrence schedules: %s', (value) => {
    expect(offsetTimestampSchema.parse(value)).toBe(value);
    expect(publicationScheduleInputSchema.parse({ mode: 'once', at: value })).toMatchObject({
      at: value,
    });
    expect(publicationScheduleInputSchema.parse({ mode: 'slots', slots: [value] })).toMatchObject({
      slots: [value],
    });
    expect(
      publicationScheduleInputSchema.parse({
        mode: 'recurrence',
        frequency: 'daily',
        times: ['00:00'],
        startsAt: value,
        endsAt: value.replace('2026-10-20', '2026-10-21'),
      }),
    ).toMatchObject({ startsAt: value, endsAt: value.replace('2026-10-20', '2026-10-21') });
  });

  it.each([
    '2026-10-20',
    '2026-10-20T00:00',
    '2026-02-30T00:00Z',
    '2026-10-20T24:00Z',
    '2026-10-20T00:60Z',
    '2026-10-20T00:00:60Z',
    '2026-10-20T00:00:00.Z',
    '2026-10-20t00:00z',
    '2026-10-20T00:00Z\n',
    '2026-10-20T00:00+0300',
    '2026-10-20T00:00+24:00',
  ])('continues rejecting invalid timestamp forms: %s', (value) => {
    expect(utcTimestampSchema.safeParse(value).success).toBe(false);
    expect(offsetTimestampSchema.safeParse(value).success).toBe(false);
    expect(publicationScheduleInputSchema.safeParse({ mode: 'once', at: value }).success).toBe(
      false,
    );
  });

  it('keeps UTC-only contracts separate from offset-enabled publication schedules', () => {
    const value = '2026-10-20T00:00+03:00';
    expect(utcTimestampSchema.safeParse(value).success).toBe(false);
    expect(scheduleVkParsingPostRequestSchema.safeParse({ scheduledAt: value }).success).toBe(
      false,
    );
    expect(scheduleDomainRemovalRequestSchema.safeParse({ removeAfterAt: value }).success).toBe(
      false,
    );
  });
});
