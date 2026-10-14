import { bindStateVoiceSource } from './state-voice-delete-source';
import type { ActiveMute } from './moderation.service.support';
import type { VoiceSourceInput } from './voice-webhook-source';
import { maskText } from './text-mask.util';

export type ActiveMuteMessageInput = {
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  createdAt: string;
  mute: ActiveMute;
  voiceSource?: VoiceSourceInput | null;
};

export function buildActiveMuteDeleteIntent(params: ActiveMuteMessageInput) {
  const { chatId, userId, messageId, text, createdAt, mute } = params;
  return bindStateVoiceSource(
    {
      chatId,
      messageId,
      reasonKey: 'MUTE_ACTIVE_DELETE',
      ruleCode: 'MUTE_ACTIVE_DELETE',
      subjectUserId: userId,
      sourceMessageAt: createdAt,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      event: {
        userId,
        eventType: 'MESSAGE',
        maskedExcerpt: maskText(text),
        score: 1,
        metadata: {
          reason: 'Message removed during active mute window',
          muteEventId: mute.eventId,
          muteIssuedAt: mute.issuedAt.toISOString(),
          mutePermanent: mute.permanent,
          ...(mute.expiresAt ? { muteExpiresAt: mute.expiresAt.toISOString() } : {}),
          ...(mute.durationHours !== null ? { muteDurationHours: mute.durationHours } : {}),
        },
      },
    },
    params.voiceSource,
  );
}
