import { buildModerationReleaseCallbackPayload } from '../moderation/moderation-release-callback.util';

export function moderationReleaseMessageOptions(
  action: 'UNBAN' | 'UNMUTE',
  sanctionEventId: string,
) {
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
  };
}
