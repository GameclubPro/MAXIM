import { Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import {
  duplicateObservationOutcomeSchema,
  type DuplicateObservationDiagnostics,
  type DuplicateObservationOutcome,
} from '@maxim/contracts/settings';
import { RedisCounterService } from '../redis-counter.service';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import {
  DUPLICATE_TELEMETRY_BUCKET_MS,
  DUPLICATE_TELEMETRY_BUCKETS,
  DUPLICATE_TELEMETRY_COUNTER_LIMIT,
  duplicateObservationIsVerified,
  duplicateTelemetryKey,
  emptyDuplicateObservationDiagnostics,
  parseDuplicateTelemetry,
  type DuplicateTelemetryCounters,
  type DuplicateTelemetryField,
} from './message-duplicate-telemetry';

export const MESSAGE_DUPLICATE_METRIC_COUNTERS = [
  'telemetry.buffer_limited',
  'telemetry.unavailable',
  'policy.unavailable',
  'admission.off',
  'admission.schedule_closed',
  'admission.event_time_rejected',
  'admission.untracked',
  'admission.missing_receipt',
  'admission.media_queued',
  'admission.action_ineligible',
  'admission.shadow',
  'content.missing_message',
  'content.invalid_content',
  'content.content_limit',
  'content.unsupported_attachment',
  'content.split_album',
  'history.fingerprint_budget',
  'history.unverified',
  'history.stale',
  'history.replayed',
  'history.no_match_or_allowed',
  'history.matched',
  'history.unavailable',
  'media.first_candidate',
  'media.policy_changed',
  'media.schedule_closed',
  'media.source_missing',
  'media.identity_rejected',
  'media.settings_rejected',
  'media.event_time_rejected',
  'media.deadline_expired',
  'media.content_unverified',
  'media.late_event',
  'media.baseline_missing',
  'media.baseline_rejected',
  'media.baseline_rejected_cached',
  'media.baseline_verified',
  'media.budget_deferred',
  'media.photo_owned',
  'media.action_ineligible',
  'media.url_malformed',
  'media.url_protocol',
  'media.url_credentials',
  'media.url_port',
  'media.url_host',
  'enforcement.policy_changed',
  'enforcement.photo_policy',
  'enforcement.claim_blocked',
  'enforcement.intent_handoff',
  'worker.started',
  'worker.completed',
  'worker.expired',
  'worker.invalid',
  'worker.retry',
  'worker.terminal',
  'worker.cleanup_retry',
  'worker.cleanup_completed',
  'worker.cleanup_exhausted',
  'worker.defer_source',
  'worker.defer_media',
  'worker.defer_governor_pause',
  'worker.defer_governor_slow',
  'worker.defer_proof_budget',
  'worker.defer_decode_capacity',
  'worker.wakeup_unavailable',
  'worker.defer_ordering',
  'worker.age_under_10s',
  'worker.age_10s_to_60s',
  'worker.age_over_60s',
  'guard.allowed',
  'guard.absent',
  'guard.unavailable',
  'guard.other_rejection',
  'guard.message_duplicate_reason_missing',
  'guard.message_duplicate_reason_limit',
  'guard.message_duplicate_binding_invalid',
  'guard.message_duplicate_author_immune',
  'guard.message_duplicate_author_not_member',
  'guard.message_duplicate_unproven_absence',
  'guard.message_duplicate_identity_changed',
  'guard.message_duplicate_content_changed',
  'guard.message_duplicate_history_changed',
  'guard.message_duplicate_original_missing',
  'guard.message_duplicate_original_changed',
  'guard.message_duplicate_policy_changed',
  'guard.message_duplicate_photo_policy_changed',
  'guard.message_duplicate_settings_changed',
  'guard.message_duplicate_schedule_closed',
  'guard.message_duplicate_sanction_settings_changed',
  'guard.message_duplicate_manual_release',
] as const;

export type MessageDuplicateMetricCounter = (typeof MESSAGE_DUPLICATE_METRIC_COUNTERS)[number];
const ALLOWED_COUNTERS: ReadonlySet<string> = new Set(MESSAGE_DUPLICATE_METRIC_COUNTERS);
const ALLOWED_OUTCOMES: ReadonlySet<string> = new Set(duplicateObservationOutcomeSchema.options);
export const MESSAGE_DUPLICATE_PHASES = [
  'policy',
  'source',
  'media',
  'history',
  'enforcement',
] as const;
export type MessageDuplicatePhase = (typeof MESSAGE_DUPLICATE_PHASES)[number];
const ALLOWED_PHASES: ReadonlySet<string> = new Set(MESSAGE_DUPLICATE_PHASES);
const PHASE_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 600000];
const MAX_PENDING_BUCKETS = 256;
const MAX_TELEMETRY_WRITES = 4;

@Injectable()
export class MessageDuplicateMetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(MessageDuplicateMetricsService.name);
  private readonly counters = new Map<MessageDuplicateMetricCounter, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAtMs = 0;
  private stopped = false;
  private readonly phases = new Map<
    MessageDuplicatePhase,
    { count: number; totalMs: number; maxMs: number; buckets: number[] }
  >();
  private readonly observations = new Map<string, DuplicateTelemetryCounters>();
  private telemetryInFlight = false;

  constructor(@Optional() private readonly redis?: RedisCounterService) {}

  record(counter: MessageDuplicateMetricCounter): void {
    // FLAG: Only fixed labels and bounded numeric counts may reach diagnostics. Never accept
    // identifiers, content, hashes, URLs or free-form error messages as metric dimensions.
    if (this.stopped || !ALLOWED_COUNTERS.has(counter)) return;
    this.counters.set(
      counter,
      Math.min(Number.MAX_SAFE_INTEGER, (this.counters.get(counter) ?? 0) + 1),
    );
    this.schedule();
  }

  recordPhase(phase: MessageDuplicatePhase, elapsedMs: number): void {
    if (this.stopped || !ALLOWED_PHASES.has(phase) || !Number.isFinite(elapsedMs) || elapsedMs < 0)
      return;
    const duration = Math.min(600000, Math.ceil(elapsedMs));
    const entry = this.phases.get(phase) ?? {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      buckets: PHASE_BOUNDS_MS.map(() => 0),
    };
    entry.count = Math.min(Number.MAX_SAFE_INTEGER, entry.count + 1);
    entry.totalMs = Math.min(Number.MAX_SAFE_INTEGER, entry.totalMs + duration);
    entry.maxMs = Math.max(entry.maxMs, duration);
    const bucket = PHASE_BOUNDS_MS.findIndex((bound) => duration <= bound);
    entry.buckets[bucket] = Math.min(Number.MAX_SAFE_INTEGER, entry.buckets[bucket]! + 1);
    this.phases.set(phase, entry);
    this.schedule();
  }

  recordObservation(
    chatId: string,
    outcome: DuplicateObservationOutcome,
    supported: boolean,
  ): void {
    if (
      this.stopped ||
      !this.redis ||
      !ALLOWED_OUTCOMES.has(outcome) ||
      !chatId ||
      chatId.length > 512
    )
      return;
    const bucket = Math.floor(Date.now() / DUPLICATE_TELEMETRY_BUCKET_MS);
    const key = duplicateTelemetryKey(chatId, bucket);
    const entry = this.observations.get(key);
    if (!entry && this.observations.size >= MAX_PENDING_BUCKETS) {
      this.record('telemetry.buffer_limited');
      return;
    }
    const counters = entry ?? {};
    const increment = (field: DuplicateTelemetryField) => {
      counters[field] = Math.min(DUPLICATE_TELEMETRY_COUNTER_LIMIT, (counters[field] ?? 0) + 1);
    };
    increment(outcome);
    if (supported) {
      increment('supported');
      if (duplicateObservationIsVerified(outcome)) increment('verified');
    }
    this.observations.set(key, counters);
    this.schedule();
  }

  async readObservations(chatId: string): Promise<DuplicateObservationDiagnostics> {
    const now = Date.now();
    const unavailable = emptyDuplicateObservationDiagnostics('UNAVAILABLE', now);
    if (!this.redis || !chatId || chatId.length > 512) return unavailable;
    try {
      const bucket = Math.floor(now / DUPLICATE_TELEMETRY_BUCKET_MS);
      const raw = await raceWithTimeout({
        operation: () =>
          Promise.all(
            Array.from({ length: DUPLICATE_TELEMETRY_BUCKETS }, (_, index) =>
              this.redis!.getString(duplicateTelemetryKey(chatId, bucket - index)),
            ),
          ),
        timeoutMs: 250,
        onTimeout: () => {
          throw new Error('Duplicate telemetry read deadline');
        },
      });
      if (raw.every((value) => value === null))
        return emptyDuplicateObservationDiagnostics('NO_DATA', now);
      const sum: DuplicateTelemetryCounters = {};
      for (const value of raw) {
        if (value === null) continue;
        const counters = parseDuplicateTelemetry(value);
        if (!counters) return unavailable;
        for (const [key, count] of Object.entries(counters)) {
          const field = key as DuplicateTelemetryField;
          sum[field] = (sum[field] ?? 0) + count;
        }
      }
      const supported = sum.supported ?? 0;
      const verified = sum.verified ?? 0;
      if (verified > supported) return unavailable;
      return {
        ...unavailable,
        state: 'AVAILABLE',
        supportedAttempts: supported,
        verifiedAttempts: verified,
        coverage: supported > 0 ? verified / supported : null,
        outcomes: duplicateObservationOutcomeSchema.options
          .filter((outcome) => sum[outcome])
          .map((outcome) => ({ outcome, count: sum[outcome]! })),
      };
    } catch {
      return unavailable;
    }
  }

  private schedule(): void {
    if (!this.timer) {
      this.startedAtMs = Date.now();
      this.timer = setTimeout(() => this.flush(), 30_000);
      this.timer.unref();
    }
  }

  recordContentRejection(reason: string): void {
    this.record(`content.${reason}` as MessageDuplicateMetricCounter);
  }

  recordGuardRejection(code: string): void {
    const counter = `guard.${code}` as MessageDuplicateMetricCounter;
    this.record(ALLOWED_COUNTERS.has(counter) ? counter : 'guard.other_rejection');
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.flush();
    this.observations.clear();
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.stopped) void this.flushObservations();
    if (this.counters.size === 0 && this.phases.size === 0) return;
    const counters = Object.fromEntries(this.counters);
    const phases = Object.fromEntries(this.phases);
    this.counters.clear();
    this.phases.clear();
    try {
      this.logger.log({
        event: 'message_duplicate_diagnostics',
        schemaVersion: 2,
        windowStartedAt: new Date(this.startedAtMs).toISOString(),
        windowEndedAt: new Date().toISOString(),
        counters,
        phases,
        phaseBucketUpperBoundsMs: PHASE_BOUNDS_MS,
      });
    } catch {
      // FLAG: Best-effort diagnostics must never change a moderation decision or its retry.
    }
  }

  private async flushObservations(): Promise<void> {
    if (!this.redis || this.telemetryInFlight || this.observations.size === 0) return;
    this.telemetryInFlight = true;
    // FLAG: A blocked Redis command retains one of four slots. Do not race/release it and
    // create an unbounded offline queue; telemetry must never await on a moderation path.
    const batch = [...this.observations];
    for (const [key] of batch) this.observations.delete(key);
    try {
      let next = 0;
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(MAX_TELEMETRY_WRITES, batch.length) }, async () => {
          while (!this.stopped && next < batch.length) {
            const [key, counters] = batch[next++]!;
            await this.redis!.mergeDuplicateTelemetry(key, counters);
          }
        }),
      );
      if (results.some((result) => result.status === 'rejected'))
        this.record('telemetry.unavailable');
    } finally {
      this.telemetryInFlight = false;
      if (!this.stopped && this.observations.size > 0) this.schedule();
    }
  }
}

export async function measureDuplicatePhase<T>(
  metrics: MessageDuplicateMetricsService | undefined,
  phase: MessageDuplicatePhase,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    // FLAG: Optional diagnostics cannot replace the original result/error.
    try {
      metrics?.recordPhase?.(phase, performance.now() - startedAt);
    } catch {
      /* FLAG: Telemetry cannot replace the moderation outcome. */
    }
  }
}
