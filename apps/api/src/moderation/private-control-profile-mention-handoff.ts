import type { MaxSendMessageOptions } from '../max/max-client.service';
import { escapePrivateHtml, escapePrivateHtmlAttribute } from './private-control-launcher-renderer';
import type { PrivateSession } from './private-control.types';
import {
  clearPrivateHandoffDelivery,
  markPrivateHandoffDelivered,
} from './private-control-handoff-state';

export type PrivateProfileMentionMessage = {
  text: string;
  options: MaxSendMessageOptions;
};

export type PrivateProfileMentionHandoffPayload = {
  displayName: string;
  userId: string;
};

export type PrivateProfileMentionDeliveryAdapters = {
  send(privateChatId: string, message: PrivateProfileMentionMessage): Promise<void>;
  saveSession(session: PrivateSession): Promise<void>;
  onFailure(error: unknown, privateChatId: string | null): void;
};

export function renderPrivateProfileMentionMessage(
  payload: PrivateProfileMentionHandoffPayload,
): PrivateProfileMentionMessage {
  const mentionText = `<a href="${escapePrivateHtmlAttribute(
    `max://user/${encodeURIComponent(payload.userId)}`,
  )}">${escapePrivateHtml(payload.displayName)}</a>`;

  return {
    text: `<p><strong>${escapePrivateHtml('Профиль пользователя')}</strong></p><p>${mentionText}</p>`,
    options: {
      textFormat: 'html',
    },
  };
}

export async function deliverPrivateProfileMentionHandoffToKnownPrivateChat(
  session: PrivateSession,
  payload: PrivateProfileMentionHandoffPayload,
  adapters: PrivateProfileMentionDeliveryAdapters,
): Promise<void> {
  const privateChatId = session.lastPrivateChatId;
  if (!privateChatId) {
    clearPrivateHandoffDelivery(session, 'profileMention');
    return;
  }

  try {
    await adapters.send(privateChatId, renderPrivateProfileMentionMessage(payload));
    markPrivateHandoffDelivered(session, 'profileMention', session.lastPrivateChatId);
    await adapters.saveSession(session);
  } catch (error: unknown) {
    clearPrivateHandoffDelivery(session, 'profileMention');
    adapters.onFailure(error, session.lastPrivateChatId);
  }
}
