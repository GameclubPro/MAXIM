import type { MaxBotContextService } from '../max/max-bot-context.service';
import type { WebhookCanonicalExecutionContext } from './webhook-canonical-execution.service';
import { withCanonicalWebhookOrigin } from './webhook-effect-origin-context';

export function runCanonicalWebhookHandler<T>(
  execution: WebhookCanonicalExecutionContext,
  botContext: Pick<MaxBotContextService, 'runWithBot'> | undefined,
  handler: () => Promise<T>,
): Promise<T> {
  return withCanonicalWebhookOrigin(execution, async () =>
    execution.activeBotId && botContext
      ? botContext.runWithBot(execution.activeBotId, handler)
      : handler(),
  );
}
