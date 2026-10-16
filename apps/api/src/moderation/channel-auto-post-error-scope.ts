import { MaxApiInternalRateLimitError } from '../max/max-client.service';

// FLAG: This classification only isolates scheduling waits. It grants no retry,
// bot access, marker completion or permission to replay an attempted mutation.
export function isChannelAutoPostScopedWait(error: unknown): error is MaxApiInternalRateLimitError {
  return (
    error instanceof MaxApiInternalRateLimitError &&
    Number.isFinite(error.retryAfterMs) &&
    error.retryAfterMs > 0 &&
    ['bot', 'external_cooldown', 'chat', 'message_target'].includes(error.limitScope)
  );
}
