export const WEBHOOK_PREPARATION_DEFER_DEFAULT_MS = 30_000;
const WEBHOOK_PREPARATION_DEFER_MIN_MS = 1_000;
const WEBHOOK_PREPARATION_DEFER_MAX_MS = 5 * 60_000;

export class WebhookPreparationDeferredError extends Error {
  readonly code = 'WEBHOOK_PREPARATION_DEFERRED';
  readonly retryAfterMs: number;

  constructor(
    message: string,
    retryAfterMs = WEBHOOK_PREPARATION_DEFER_DEFAULT_MS,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'WebhookPreparationDeferredError';
    const normalized = Number.isFinite(retryAfterMs)
      ? Math.trunc(retryAfterMs)
      : WEBHOOK_PREPARATION_DEFER_DEFAULT_MS;
    this.retryAfterMs = Math.min(
      WEBHOOK_PREPARATION_DEFER_MAX_MS,
      Math.max(WEBHOOK_PREPARATION_DEFER_MIN_MS, normalized),
    );
  }
}
