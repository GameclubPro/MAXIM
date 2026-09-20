import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

export const MESSAGE_DUPLICATE_METRIC_COUNTERS = [
  'policy.unavailable',
  'admission.off',
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
  'media.source_missing',
  'media.identity_rejected',
  'media.settings_rejected',
  'media.event_time_rejected',
  'media.content_unverified',
  'media.late_event',
  'media.baseline_missing',
  'media.baseline_rejected',
  'media.baseline_rejected_cached',
  'media.baseline_verified',
  'media.budget_deferred',
  'media.photo_owned',
  'media.action_ineligible',
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
  'worker.defer_source',
  'worker.defer_media',
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
  'guard.message_duplicate_policy_changed',
  'guard.message_duplicate_photo_policy_changed',
  'guard.message_duplicate_settings_changed',
  'guard.message_duplicate_sanction_settings_changed',
  'guard.message_duplicate_manual_release',
] as const;

export type MessageDuplicateMetricCounter = (typeof MESSAGE_DUPLICATE_METRIC_COUNTERS)[number];
const ALLOWED_COUNTERS: ReadonlySet<string> = new Set(MESSAGE_DUPLICATE_METRIC_COUNTERS);

@Injectable()
export class MessageDuplicateMetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(MessageDuplicateMetricsService.name);
  private readonly counters = new Map<MessageDuplicateMetricCounter, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAtMs = 0;
  private stopped = false;

  record(counter: MessageDuplicateMetricCounter): void {
    // FLAG: Only fixed labels and bounded numeric counts may reach diagnostics. Never accept
    // identifiers, content, hashes, URLs or free-form error messages as metric dimensions.
    if (this.stopped || !ALLOWED_COUNTERS.has(counter)) return;
    this.counters.set(
      counter,
      Math.min(Number.MAX_SAFE_INTEGER, (this.counters.get(counter) ?? 0) + 1),
    );
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
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.counters.size === 0) return;
    const counters = Object.fromEntries(this.counters);
    this.counters.clear();
    try {
      this.logger.log({
        event: 'message_duplicate_diagnostics',
        schemaVersion: 1,
        windowStartedAt: new Date(this.startedAtMs).toISOString(),
        windowEndedAt: new Date().toISOString(),
        counters,
      });
    } catch {
      // FLAG: Best-effort diagnostics must never change a moderation decision or its retry.
    }
  }
}
