import { AsyncLocalStorage } from 'node:async_hooks';
import { parseWebhookEventTimestampMs } from '../webhook/webhook-event-timestamp';
import type { WebhookCanonicalExecutionContext } from './webhook-canonical-execution.service';

export type WebhookEffectOrigin = Readonly<{
  sourceWebhookEventId: string;
  sourceReceivingBotId: string;
  sourceExecutionBotId: string;
  sourceEventAt: Date;
  sourceEvidenceVersion: 1;
}>;
type Scope = {
  active: boolean;
  chatId: string;
  messageId: string;
  origin: WebhookEffectOrigin | null;
};
type CanonicalSource = Pick<WebhookCanonicalExecutionContext, 'update' | 'activeBotId'> & {
  webhookEvent: Pick<WebhookCanonicalExecutionContext['webhookEvent'], 'id' | 'botId'>;
};
const scopes = new AsyncLocalStorage<Scope>();
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identity = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;

// FLAG: Only the event/edit clock is provenance. Never substitute message creation
// or an ingress fallback clock when the original MAX event timestamp is unavailable.
export function readWebhookOriginEventAt(update: unknown): Date | null {
  const row = record(update);
  if (row.eventTimestampSource === 'ingress') return null;
  const raw = record(row.raw),
    data = record(raw.data),
    event = record(raw.event);
  for (const candidate of [
    raw.timestamp,
    raw.created_at,
    raw.createdAt,
    data.timestamp,
    data.created_at,
    data.createdAt,
    event.timestamp,
    event.created_at,
    event.createdAt,
  ]) {
    if (typeof candidate === 'string' && candidate.length > 128) continue;
    const milliseconds = parseWebhookEventTimestampMs(candidate);
    if (milliseconds !== null) return new Date(milliseconds);
  }
  return null;
}

export async function withCanonicalWebhookOrigin<T>(
  execution: CanonicalSource,
  callback: () => Promise<T>,
): Promise<T> {
  const { update, webhookEvent, activeBotId } = execution;
  const sourceEventAt = readWebhookOriginEventAt(update);
  const source = update.message;
  const valid =
    typeof update.type === 'string' &&
    ['message_created', 'message_edited'].includes(update.type.trim().toLowerCase()) &&
    identity(webhookEvent.id, 128) &&
    identity(webhookEvent.botId) &&
    identity(activeBotId) &&
    update.botId === webhookEvent.botId &&
    identity(source?.chatId) &&
    identity(source?.messageId) &&
    sourceEventAt !== null;
  const scope: Scope = {
    active: true,
    chatId: source?.chatId ?? '',
    messageId: source?.messageId ?? '',
    origin: valid
      ? {
          sourceWebhookEventId: webhookEvent.id,
          sourceReceivingBotId: webhookEvent.botId!,
          sourceExecutionBotId: activeBotId!,
          sourceEventAt: sourceEventAt!,
          sourceEvidenceVersion: 1,
        }
      : null,
  };
  return scopes.run(scope, async () => {
    try {
      return await callback();
    } finally {
      // FLAG: The actual handler owns this lifetime, including after a guard timeout.
      // Descendant tasks that outlive its settlement cannot attribute new reasons to it.
      scope.active = false;
    }
  });
}

export function readExactDeleteOrigin(
  chatId: string,
  messageId: string,
): WebhookEffectOrigin | null {
  const scope = scopes.getStore();
  if (!scope?.active || scope.chatId !== chatId || scope.messageId !== messageId || !scope.origin)
    return null;
  return { ...scope.origin, sourceEventAt: new Date(scope.origin.sourceEventAt) };
}
