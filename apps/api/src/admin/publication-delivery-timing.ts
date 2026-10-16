import type { Logger } from '@nestjs/common';
import type { ManagedBroadcastDelivery, PublicationScheduleMode } from '../prisma/prisma-client';
import { createMaxSendObservation } from '../max/max-send-observation';

export type PublicationExecutionTiming = {
  mode: PublicationScheduleMode;
  intentCreatedAt: Date;
  deadlineAt?: Date | null;
};

export function resolvePublicationDeadlineWake(nextAt: Date, deadlineAt?: Date | null): Date {
  // FLAG: A long Retry-After may outlive author intent. Wake for SQL-only expiry,
  // retaining the recipient's retry time so no SEND can happen before MAX allows it.
  return deadlineAt && nextAt.getTime() > deadlineAt.getTime() + 1
    ? new Date(deadlineAt.getTime() + 1)
    : nextAt;
}

type PublicationMediaKind = 'none' | 'image' | 'video' | 'unknown';
export type PublicationTimingDimensions = {
  mode?: PublicationScheduleMode | null;
  media: PublicationMediaKind;
};
type PublicationWaitStage =
  | 'wakeup_queue'
  | 'initial_recipient_claim'
  | 'recipient_retry_lateness'
  | 'capacity_deferral'
  | 'observed_acknowledgement_to_receipt';

const WAIT_REASONS = new Set([
  'create',
  'update',
  'resume',
  'retry',
  'resolution',
  'local_capacity',
  'max_rate_limit',
  'circuit_open',
]);

export function recordPublicationWaitTiming(
  logger: Partial<Pick<Logger, 'log'>>,
  input: Partial<PublicationTimingDimensions> & {
    stage: PublicationWaitStage;
    from: Date | null | undefined;
    to: Date;
    reason?: string | null;
    outcome?: 'observed' | 'expired';
  },
): void {
  observeSafely(() => {
    const durationMs = elapsedDateMs(input.from, input.to);
    emit(logger, {
      metric: 'publication_wait_v1',
      stage: input.stage,
      mode: input.mode ?? 'UNKNOWN',
      media: input.media ?? 'unknown',
      reason: WAIT_REASONS.has(input.reason ?? '') ? input.reason : 'unknown',
      outcome: input.outcome ?? 'observed',
      durationMs,
      clock: durationMs === null ? 'unknown' : 'wall',
    });
  });
}
export type PublicationStage =
  | 'actor_authority'
  | 'delivery_readiness'
  | 'target_preparation'
  | 'target_selection'
  | 'dispatch_quantum';

export async function measurePublicationStage<T>(
  logger: Partial<Pick<Logger, 'log'>> | undefined,
  stage: PublicationStage,
  operation: () => Promise<T>,
  lane: 'immediate' | 'deadline' | 'preflight' | 'unknown' = 'unknown',
): Promise<T> {
  const started = performance.now();
  let outcome: 'returned' | 'threw' = 'threw';
  try {
    const result = await operation();
    outcome = 'returned';
    return result;
  } finally {
    // FLAG: The original promise retains authority until settlement. No timeout race,
    // raw exception/identifier label, or logging failure may alter dispatch behavior.
    if (logger)
      emit(logger, {
        metric: 'publication_stage_v1',
        stage,
        lane,
        outcome,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      });
  }
}

type PublicationTimingInput = PublicationTimingDimensions & {
  scheduledAt?: Date | null;
  intentCreatedAt?: Date | null;
};

export function createPublicationExecutionObserver(
  logger: Partial<Pick<Logger, 'log'>>,
  row: { publicationOccurrenceId: string | null; mediaType: string | null; imageEnabled: boolean },
  enabled: boolean,
): {
  readonly scheduledAt: Date | null;
  readonly deadlineAt: Date | null;
  readonly dimensions: PublicationTimingDimensions;
  onOccurrenceScheduledAt: (scheduledAt: Date, execution?: PublicationExecutionTiming) => void;
  observeReceipt: () => void;
  observeAcknowledgement: () => void;
  runDispatch<T>(
    key: string,
    lane: 'critical' | 'interactive' | 'background',
    operation: () => Promise<T>,
  ): Promise<T>;
  observeClaim: (
    delivery: Pick<ManagedBroadcastDelivery, 'attemptCount'> &
      Partial<
        Pick<ManagedBroadcastDelivery, 'capacityDeferralCount' | 'nextAttemptAt' | 'waitReason'>
      >,
  ) => void;
} {
  let scheduledAt: Date | null = null;
  let execution: PublicationExecutionTiming | null = null;
  let acknowledgementAt: Date | null = null;
  let dispatchObservation: ReturnType<typeof createMaxSendObservation> | null = null;
  const dimensions = (): PublicationTimingDimensions => ({
    mode: execution?.mode,
    media: row.mediaType === 'video' ? 'video' : row.imageEnabled ? 'image' : 'none',
  });
  const observeReceipt = () => {
    if (!enabled || !row.publicationOccurrenceId) return;
    const persistedAt = new Date();
    recordPublicationReceiptTiming(logger, {
      ...dimensions(),
      intentCreatedAt: execution?.intentCreatedAt,
      scheduledAt,
      receiptPersistedAt: persistedAt,
    });
    recordPublicationWaitTiming(logger, {
      ...dimensions(),
      stage: 'observed_acknowledgement_to_receipt',
      from: acknowledgementAt,
      to: persistedAt,
    });
    acknowledgementAt = null;
    dispatchObservation?.observeRecipientReceipt();
    dispatchObservation = null;
  };
  return {
    get dimensions() {
      return dimensions();
    },
    get deadlineAt() {
      return execution?.deadlineAt ?? null;
    },
    get scheduledAt() {
      return scheduledAt;
    },
    observeReceipt: () => observeSafely(observeReceipt),
    runDispatch: (key, lane, operation) => {
      if (!enabled || !row.publicationOccurrenceId) return operation();
      const dimension = dimensions();
      dispatchObservation = createMaxSendObservation(
        { mode: dimension.mode ?? 'UNKNOWN', media: dimension.media, lane },
        (observation) => emit(logger, observation),
      );
      return dispatchObservation.run(key, operation);
    },
    observeClaim: (delivery) =>
      observeSafely(() => {
        // FLAG: A prior recipient's response cannot time this recipient's recovery receipt.
        // Claims are observations, not durable once-only counters or new execution authority.
        acknowledgementAt = null;
        dispatchObservation = null;
        if (!enabled || !row.publicationOccurrenceId) return;
        const claimedAt = new Date();
        if (delivery.attemptCount === 0 && (delivery.capacityDeferralCount ?? 0) === 0) {
          recordPublicationWaitTiming(logger, {
            ...dimensions(),
            stage: 'initial_recipient_claim',
            from: execution?.mode === 'NOW' ? execution.intentCreatedAt : scheduledAt,
            to: claimedAt,
          });
        }
        if (delivery.nextAttemptAt) {
          recordPublicationWaitTiming(logger, {
            ...dimensions(),
            stage: 'recipient_retry_lateness',
            from: delivery.nextAttemptAt,
            to: claimedAt,
            reason: delivery.waitReason,
          });
        }
      }),
    observeAcknowledgement: () => {
      observeSafely(() => {
        if (!enabled || !row.publicationOccurrenceId) return;
        acknowledgementAt = new Date();
        recordPublicationReceiptTiming(logger, {
          mode: execution?.mode,
          intentCreatedAt: execution?.intentCreatedAt,
          scheduledAt,
          media: row.mediaType === 'video' ? 'video' : row.imageEnabled ? 'image' : 'none',
          receiptPersistedAt: acknowledgementAt,
          outcome: 'max_acknowledgement_observed',
        });
      });
    },
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
  input: PublicationTimingInput & {
    receiptPersistedAt: Date;
    outcome?: 'receipt_persisted' | 'max_acknowledgement_observed';
  },
): void {
  observeSafely(() => {
    const reference = input.mode === 'NOW' ? input.intentCreatedAt : input.scheduledAt;
    const durationMs = elapsedDateMs(reference, input.receiptPersistedAt);
    const bucket =
      durationMs === null ? null : LATENCY_BUCKETS.find((upper) => durationMs <= upper);
    emit(logger, {
      metric: 'publication_delivery_v1',
      scope: 'delivery',
      outcome: input.outcome ?? 'receipt_persisted',
      mode: input.mode ?? 'UNKNOWN',
      media: input.media,
      clock:
        durationMs === null
          ? 'unknown'
          : input.mode === 'NOW'
            ? 'intent_created_at'
            : 'scheduled_at',
      durationMs,
      latencyBucket:
        durationMs === null ? 'unknown' : bucket === undefined ? 'over_300000ms' : `le_${bucket}ms`,
    });
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
  // FLAG: Identifier-free observations never change recovery or imply exactly-once telemetry.
  try {
    logger.log?.(metric, 'Publication delivery observation');
  } catch {
    // FLAG: The persisted receipt or transition remains the source of truth.
  }
}

function elapsedDateMs(from: Date | null | undefined, to: Date): number | null {
  const fromMs = from?.getTime();
  const toMs = to.getTime();
  return fromMs !== undefined && Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs >= fromMs
    ? toMs - fromMs
    : null;
}

function observeSafely(observe: () => void): void {
  try {
    observe();
  } catch {
    // FLAG: An invalid observation or accessor must not alter the original operation.
  }
}
