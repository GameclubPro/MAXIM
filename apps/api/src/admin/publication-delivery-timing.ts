import type { Logger } from '@nestjs/common';
import type { PublicationScheduleMode } from '../prisma/prisma-client';

export type PublicationExecutionTiming = {
  mode: PublicationScheduleMode;
  intentCreatedAt: Date;
};

type PublicationMediaKind = 'none' | 'image' | 'video' | 'unknown';
type PublicationTimingInput = {
  mode?: PublicationScheduleMode | null;
  media: PublicationMediaKind;
  scheduledAt?: Date | null;
  intentCreatedAt?: Date | null;
};

export function createPublicationExecutionObserver(
  logger: Partial<Pick<Logger, 'log'>>,
  row: { publicationOccurrenceId: string | null; mediaType: string | null; imageEnabled: boolean },
  enabled: boolean,
): {
  readonly scheduledAt: Date | null;
  onOccurrenceScheduledAt: (scheduledAt: Date, execution?: PublicationExecutionTiming) => void;
  observeReceipt: () => void;
} {
  let scheduledAt: Date | null = null;
  let execution: PublicationExecutionTiming | null = null;
  const observeReceipt = () => {
    if (!enabled || !row.publicationOccurrenceId) return;
    recordPublicationReceiptTiming(logger, {
      mode: execution?.mode,
      intentCreatedAt: execution?.intentCreatedAt,
      scheduledAt,
      media: row.mediaType === 'video' ? 'video' : row.imageEnabled ? 'image' : 'none',
      receiptPersistedAt: new Date(),
    });
  };
  return {
    get scheduledAt() {
      return scheduledAt;
    },
    observeReceipt,
    onOccurrenceScheduledAt: (nextScheduledAt, nextExecution) => {
      scheduledAt = nextScheduledAt;
      execution = nextExecution ?? null;
    },
  };
}

const LATENCY_BUCKETS = [1_000, 5_000, 15_000, 60_000, 300_000] as const;
const BLOCKER_REASONS = new Set([
  'PUBLISHER_ACTOR_ACCESS_REQUIRED',
  'PUBLISHER_RUNTIME_UNAVAILABLE',
  'PUBLISHER_AUTH_PAUSED',
  'policy_disabled',
  'bot_not_connected',
  'bot_access_expired',
  'bot_access_unconfirmed',
  'bot_not_admin',
  'write_permission_missing',
  'route_quarantined',
  'publisher_bot_changed',
]);

export function recordPublicationReceiptTiming(
  logger: Partial<Pick<Logger, 'log'>>,
  input: PublicationTimingInput & { receiptPersistedAt: Date },
): void {
  const reference = input.mode === 'NOW' ? input.intentCreatedAt : input.scheduledAt;
  const referenceMs = reference?.getTime();
  const persistedMs = input.receiptPersistedAt.getTime();
  const durationMs =
    referenceMs !== undefined &&
    Number.isFinite(referenceMs) &&
    Number.isFinite(persistedMs) &&
    persistedMs >= referenceMs
      ? persistedMs - referenceMs
      : null;
  const bucket = durationMs === null ? null : LATENCY_BUCKETS.find((upper) => durationMs <= upper);
  emit(logger, {
    metric: 'publication_delivery_v1',
    scope: 'delivery',
    outcome: 'receipt_persisted',
    mode: input.mode ?? 'UNKNOWN',
    media: input.media,
    clock:
      durationMs === null ? 'unknown' : input.mode === 'NOW' ? 'intent_created_at' : 'scheduled_at',
    durationMs,
    latencyBucket:
      durationMs === null ? 'unknown' : bucket === undefined ? 'over_300000ms' : `le_${bucket}ms`,
  });
}

export function recordPublicationDispatchOutcome(
  logger: Partial<Pick<Logger, 'log'>>,
  input: {
    mode?: PublicationScheduleMode | null;
    scope: 'occurrence' | 'deferral';
    outcome: 'blocked' | 'missed_window' | 'skipped';
    reason?: string;
  },
): void {
  emit(logger, {
    metric: 'publication_delivery_v1',
    scope: input.scope,
    outcome: input.outcome,
    mode: input.mode ?? 'UNKNOWN',
    reason:
      input.outcome === 'blocked'
        ? BLOCKER_REASONS.has(input.reason ?? '')
          ? input.reason
          : 'other'
        : input.outcome === 'missed_window'
          ? 'window_expired'
          : 'revision_changed',
  });
}

function emit(logger: Partial<Pick<Logger, 'log'>>, metric: Record<string, unknown>): void {
  // FLAG: These identifier-free observations follow a successful state CAS. Logging must
  // never change delivery recovery or imply exactly-once telemetry across a process crash.
  try {
    logger.log?.(metric, 'Publication delivery observation');
  } catch {
    // FLAG: The persisted receipt or transition remains the source of truth.
  }
}
