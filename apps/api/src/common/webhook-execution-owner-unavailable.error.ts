import { WebhookPreparationDeferredError } from './webhook-preparation-deferred.error';

export class WebhookExecutionOwnerUnavailableError extends WebhookPreparationDeferredError {
  constructor(message: string, retryAfterMs = 1_000, cause?: unknown) {
    super(message, retryAfterMs, cause);
    this.name = 'WebhookExecutionOwnerUnavailableError';
  }
}
