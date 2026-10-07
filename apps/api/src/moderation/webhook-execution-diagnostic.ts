import { describeWebhookPreparationFailure } from '../webhook/webhook-preparation-diagnostic';

export type WebhookExecutionFailureStage = 'handler' | 'completion' | 'ocr_activation';

export function describeWebhookExecutionFailure(error: unknown) {
  const basic = describeWebhookPreparationFailure(error);
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
  } catch {
    // Error getters must not replace the original failure or interfere with settlement.
  }
  return { ...basic, locations };
}
