import type { ResolvePublisherEntitiesRequest } from '@maxim/contracts/publisher';
import { refreshSelectedPublicationTargets } from '../../lib/api/publication-client';
import { runOrResumePublisherRefresh } from '../../lib/api/publisher-client';
import type { ApiTransport } from '../../lib/api/transport';
import { ApiRequestError } from '../../lib/api-request-error';

export async function savePublicationWithAccessRefresh<T>(options: {
  api: ApiTransport;
  targets: ResolvePublisherEntitiesRequest['targets'];
  save: () => Promise<T>;
  signal: AbortSignal;
  onRefreshing: () => void;
}): Promise<T> {
  const { api, save, signal, onRefreshing } = options;
  // Freeze the submitted audience: editing an existing post may select recipients
  // that differ from its persisted targets. Resuming must check this exact selection.
  const targets = options.targets.map(({ id, entityType }) => ({ id, entityType }));
  signal.throwIfAborted();
  try {
    return await save();
  } catch (error) {
    // FLAG: Only these pre-mutation readiness rejections prove no send was accepted.
    // Never retry transport errors, timeouts, denials or ambiguous delivery results.
    if (
      !(error instanceof ApiRequestError) ||
      error.status !== 409 ||
      error.code !== 'PUBLISHER_SETUP_REQUIRED' ||
      error.payload?.canRecheck === false ||
      !['bot_access_expired', 'bot_access_unconfirmed'].includes(String(error.payload?.blockerCode))
    ) {
      throw error;
    }
  }
  signal.throwIfAborted();
  onRefreshing();
  const scope = JSON.stringify(
    [...new Set(targets.map(({ id, entityType }) => `${entityType}:${id}`))].sort(),
  );
  await runOrResumePublisherRefresh(
    api,
    `publication-save:${scope}`,
    () => refreshSelectedPublicationTargets(api, targets),
    signal,
  );
  signal.throwIfAborted();
  // FLAG: Reuse the caller's frozen request, revision and idempotency key exactly
  // once. The server must still recheck fresh bot/user rights and publication policy.
  return save();
}
