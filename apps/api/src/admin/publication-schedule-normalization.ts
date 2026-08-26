import type { PublicationScheduleInput } from '@maxim/contracts/publication';
import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { assertPublicationTimezone } from './publication-recurrence';

export function normalizePublicationSchedule(
  schedule: PublicationScheduleInput,
  now: Date,
  pastGraceMs: number,
): PublicationScheduleInput {
  try {
    assertPublicationTimezone(schedule.timezone);
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      throw new BadRequestException('Выберите корректный часовой пояс.');
    }
    throw error;
  }
  const normalized =
    schedule.mode === 'recurrence' && schedule.startsAt === null
      ? { ...schedule, startsAt: now.toISOString() }
      : schedule;
  const localTimes =
    normalized.mode === 'recurrence'
      ? normalized.times
      : normalized.mode === 'once'
        ? [
            DateTime.fromISO(normalized.at, { setZone: true })
              .setZone(normalized.timezone)
              .toFormat('HH:mm'),
          ]
        : normalized.mode === 'slots'
          ? normalized.slots.map((slot) =>
              DateTime.fromISO(slot, { setZone: true })
                .setZone(normalized.timezone)
                .toFormat('HH:mm'),
            )
          : [];
  if (localTimes.some((time) => Number(time.slice(3, 5)) % 30 !== 0)) {
    throw new BadRequestException('Выберите время с шагом 30 минут.');
  }
  const datedSlots =
    normalized.mode === 'once'
      ? [new Date(normalized.at)]
      : normalized.mode === 'slots'
        ? normalized.slots.map((slot) => new Date(slot))
        : [];
  if (datedSlots.some((slot) => slot.getUTCSeconds() !== 0 || slot.getUTCMilliseconds() !== 0)) {
    throw new BadRequestException('Выберите время с шагом 30 минут.');
  }
  if (datedSlots.some((slot) => slot.getTime() < now.getTime() - pastGraceMs)) {
    throw new BadRequestException('Время публикации уже прошло.');
  }
  return normalized;
}
