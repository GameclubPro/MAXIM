import { collectMaxRetryErrorChain, readMaxRetryAfterMs } from '../max/max-retry-after';
import { MaxApiCircuitOpenError, MaxApiInternalRateLimitError } from '../max/max-client.service';
import { isMaxMutationOutcomeAmbiguous } from '../max/max-mutation-outcome.util';

export type PublicationCapacityWaitReason = 'max_rate_limit' | 'local_capacity' | 'circuit_open';

export function resolvePublicationCapacityRetry(
  error: unknown,
  now = new Date(),
  deferralCount = 0,
  jitterFraction = 0,
): { retryAt: Date; reason: PublicationCapacityWaitReason } | null {
  const chain = collectMaxRetryErrorChain(error);
  if (chain.some((item) => isMaxMutationOutcomeAmbiguous(item))) return null;
  const statuses = chain
    .map((item) => (item as { response?: { status?: unknown } }).response?.status)
    .filter((status) => status !== undefined);
  const external = statuses.length > 0 && statuses.every((status) => status === 429);
  const started = chain.some(
    (item) =>
      (item as { managedBroadcastSendStarted?: unknown }).managedBroadcastSendStarted === true,
  );
  const hasResponse = chain.some((item) => (item as { response?: unknown }).response != null);
  // FLAG: Copied code/message fields are not pre-dispatch evidence. Only concrete transport
  // rejections without a conflicting HTTP response may recycle an unstarted claim.
  const local =
    !hasResponse && !started && chain.some((item) => item instanceof MaxApiInternalRateLimitError);
  const circuit =
    !hasResponse && !started && chain.some((item) => item instanceof MaxApiCircuitOpenError);
  if (!external && !local && !circuit) return null;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;
  const hint = readMaxRetryAfterMs(error, nowMs);
  const ordinal =
    Number.isSafeInteger(deferralCount) && deferralCount >= 0 ? Math.min(deferralCount, 4) : 0;
  const fallback = external ? Math.min(300_000, 30_000 * 2 ** ordinal) : 1_000;
  const delay = Math.max(1, hint || fallback);
  const fraction = Number.isFinite(jitterFraction) ? Math.max(0, Math.min(1, jitterFraction)) : 0;
  const jitter = external ? Math.floor(Math.min(5_000, delay * 0.1) * fraction) : 0;
  return {
    retryAt: new Date(Math.min(8_640_000_000_000_000, nowMs + delay + jitter)),
    reason: external ? 'max_rate_limit' : local ? 'local_capacity' : 'circuit_open',
  };
}

export function resolvePublicationRateLimitRetryAt(error: unknown, now = new Date()): Date | null {
  return resolvePublicationCapacityRetry(error, now)?.retryAt ?? null;
}
