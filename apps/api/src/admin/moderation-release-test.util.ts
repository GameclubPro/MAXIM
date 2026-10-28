import { buildModerationReleaseCallbackPayload } from '../moderation/moderation-release-callback.util';
import type { MaxSendMessageOptions } from '../max/max-client.service';

export function moderationReleaseMessageOptions(
  action: 'UNBAN' | 'UNMUTE',
  sanctionEventId: string,
  entityId: string,
): MaxSendMessageOptions {
  return {
    buttons: [
      [
        {
          type: 'callback',
          text: action === 'UNBAN' ? 'Разбанить' : 'Снять мут',
          payload: buildModerationReleaseCallbackPayload(action, sanctionEventId),
          intent: 'positive',
        },
      ],
    ],
    textFormat: 'markdown',
    marketplacePublication: { entityId, purpose: 'MODERATION_NOTICE' },
  };
}
