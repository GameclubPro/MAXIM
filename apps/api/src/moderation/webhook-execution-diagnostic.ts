import { describeWebhookPreparationFailure } from '../webhook/webhook-preparation-diagnostic';

export type WebhookExecutionFailureStage = 'handler' | 'completion' | 'ocr_activation';

const HOT_PATH_STAGES = new Set([
  'start',
  'active-mute',
  'admin-check',
  'admin-command',
  'chat-context',
  'developer-forced-global-spammer',
  'duplicate-admin-recheck',
  'duplicate-delete',
  'duplicate-follow-up',
  'duplicate-sanction',
  'global-spammer-exempt',
  'global-spammer-track',
  'invitation-access',
  'invitation-access.delete',
  'known-spammer-check',
  'required-subscription',
  'required-subscription.delete',
  'required-subscription.follow-up',
  'required-subscription.membership',
  'rule-engine',
  'rule-engine.commercial-campaign',
  'system-mode',
  'violation-admin-recheck',
  'violation-delete',
  'violation-follow-up',
  'violation-record',
]);

export function describeWebhookExecutionFailure(error: unknown, hotPathStage?: unknown) {
  const basic = describeWebhookPreparationFailure(error);
  let requestOperation = 'unknown';
  const locations: Record<string, { format: string; line: number; column: number }> = {};
  try {
    // FLAG: Preserve the first failure without logging messages, identities, arbitrary paths
    // or stack text. Later canonical recovery may replace the receipt's original error.
    const stack =
      error instanceof Error && typeof error.stack === 'string' ? error.stack.slice(0, 16_384) : '';
    const knownSources = {
      handler: /\/moderation\/moderation\.service\.legacy\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      canonical:
        /\/moderation\/webhook-canonical-execution\.service\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      channelMarker:
        /\/moderation\/replacement-attach-marker\.store\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
    };
    for (const [name, pattern] of Object.entries(knownSources)) {
      const match = pattern.exec(stack);
      if (match)
        locations[name] = { format: match[1], line: Number(match[2]), column: Number(match[3]) };
    }
    // Axios stacks may contain only HTTP-library frames. Classify its route in memory;
    // never retain URLs, parameters, headers, bodies or remote identifiers.
    const config = (error as { config?: { method?: unknown; url?: unknown } } | null)?.config;
    if (
      typeof config?.method === 'string' &&
      typeof config.url === 'string' &&
      config.url.length <= 2048
    ) {
      const method = config.method.toUpperCase();
      const path = new URL(config.url, 'https://platform-api.max.ru').pathname;
      const route = /^\/messages(?:\/[^/]+)?$/u.test(path)
        ? 'messages'
        : /^\/chats\/[^/]+\/members(?:\/[^/]+)?$/u.test(path)
          ? 'members'
          : /^\/chats\/[^/]+$/u.test(path)
            ? 'chat'
            : null;
      if (route && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
        requestOperation = `${method.toLowerCase()}_${route}`;
    }
  } catch {
    // Error getters must not replace the original failure or interfere with settlement.
  }
  return {
    ...basic,
    locations,
    requestOperation,
    hotPathStage:
      typeof hotPathStage === 'string' && HOT_PATH_STAGES.has(hotPathStage)
        ? hotPathStage
        : 'unknown',
  };
}
