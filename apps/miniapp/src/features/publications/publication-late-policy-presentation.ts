import {
  DEFAULT_PUBLICATION_LATE_POLICY,
  type PublicationLatePolicy,
  type PublicationScheduleInput,
} from '@maxim/contracts/publication';
import { buildPublicationSchedule, type PublicationDraft } from './publication-model';

export const LEGACY_PUBLICATION_LATE_POLICY: PublicationLatePolicy = {
  mode: 'strict',
  maxDelayMinutes: 5,
  catchUp: 'all',
};

function canonicalInstant(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

function scheduleForLatePolicy(schedule: PublicationScheduleInput): unknown {
  if (schedule.mode === 'now') return { mode: schedule.mode, timezone: schedule.timezone };
  if (schedule.mode === 'once') {
    return { mode: schedule.mode, timezone: schedule.timezone, at: canonicalInstant(schedule.at) };
  }
  if (schedule.mode === 'slots') {
    return {
      mode: schedule.mode,
      timezone: schedule.timezone,
      slots: [...new Set(schedule.slots.map(canonicalInstant))].sort(),
    };
  }
  return {
    mode: schedule.mode,
    timezone: schedule.timezone,
    frequency: schedule.frequency,
    interval: schedule.interval,
    weekdays: schedule.frequency === 'weekly' ? [...schedule.weekdays].sort((a, b) => a - b) : [],
    times: [...schedule.times].sort(),
    startsAt: canonicalInstant(schedule.startsAt),
    endsAt: canonicalInstant(schedule.endsAt),
    maxOccurrences: schedule.maxOccurrences,
  };
}

export function resolvePublicationDraftLatePolicy(
  draft: PublicationDraft,
  baseline: PublicationDraft | null,
  acceptedSchedule: boolean,
  scheduleOmitted = false,
): PublicationLatePolicy {
  if (draft.latePolicy) return draft.latePolicy;
  // FLAG: Omitted policy on an unchanged accepted schedule keeps its five-minute deadline.
  // A draft or replacement schedule receives the current default without rewriting saved intent.
  if (
    acceptedSchedule &&
    baseline &&
    (scheduleOmitted ||
      draft.timingMode !== 'schedule' ||
      draft.scheduleKind !== 'recurrence' ||
      draft.recurrence.startsAt !== null) &&
    JSON.stringify(scheduleForLatePolicy(buildPublicationSchedule(baseline))) ===
      JSON.stringify(scheduleForLatePolicy(buildPublicationSchedule(draft)))
  ) {
    return baseline.latePolicy ?? LEGACY_PUBLICATION_LATE_POLICY;
  }
  return DEFAULT_PUBLICATION_LATE_POLICY;
}

export function formatPublicationLatePolicy(
  value: PublicationLatePolicy | undefined,
  recurring: boolean,
): string {
  const policy = value ?? LEGACY_PUBLICATION_LATE_POLICY;
  const delay =
    policy.maxDelayMinutes % 60 === 0
      ? `${policy.maxDelayMinutes / 60} ч.`
      : `${policy.maxDelayMinutes} мин.`;
  const action =
    policy.mode === 'strict' ? `Пропустить спустя ${delay}` : `Ждать восстановления до ${delay}`;
  const catchUp =
    recurring && policy.mode === 'recover'
      ? policy.catchUp === 'latest'
        ? ' · Только последний повтор'
        : ' · Все актуальные повторы'
      : '';
  return `${action} после назначенного времени${catchUp}`;
}
