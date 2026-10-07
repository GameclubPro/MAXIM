import type { MaxUpdate } from '@maxim/contracts';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';

export type WebhookPreparationScope = {
  botId: string;
  workClass: 'ordinary' | 'interactive' | 'lifecycle';
};

export function webhookPreparationScope(update?: MaxUpdate): WebhookPreparationScope {
  // FLAG: This is scheduling identity only. Malformed retained payloads must reach
  // their normal per-receipt validation without breaking independent discovery.
  const type = typeof update?.type === 'string' ? update.type.trim().toLowerCase() : '';
  const workClass =
    update &&
    [
      'bot_added',
      'bot_removed',
      'user_added',
      'user_removed',
      'bot_stopped',
      'dialog_removed',
    ].includes(type)
      ? 'lifecycle'
      : update && isManagedEntityHandshakeStartCommand(update)
        ? 'interactive'
        : 'ordinary';
  return {
    botId: typeof update?.botId === 'string' ? update.botId.trim() || 'unknown' : 'unknown',
    workClass,
  };
}

export function webhookPreparationScopeKey(scope: WebhookPreparationScope): string {
  return JSON.stringify([scope.botId, scope.workClass]);
}
