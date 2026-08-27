import type { ChannelDialogType } from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { readTrimmedString } from './admin-legacy-utils';
import {
  CHANNEL_DIALOG_ACTION_COMMENT,
  CHANNEL_DIALOG_ACTION_SUGGEST,
  PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
} from './admin.service.support';

export function resolveDialogAuditAction(
  dialogType: ChannelDialogType,
  dialogProfile: MiniappProfile = 'moderation',
): string {
  if (dialogType === 'comments' && dialogProfile === 'publisher') {
    return PUBLISHER_CHAT_DIALOG_ACTION_COMMENT;
  }
  return dialogType === 'comments' ? CHANNEL_DIALOG_ACTION_COMMENT : CHANNEL_DIALOG_ACTION_SUGGEST;
}

export function isPublisherChatAutoAttachPayload(payload: Record<string, unknown>): boolean {
  return payload.publisherQueueVersion === 1 && readTrimmedString(payload.publisherBotId) !== null;
}

export function resolveDialogCommentsTargetMessageId(
  payload: Record<string, unknown>,
): string | null {
  const deliveryMode = readTrimmedString(payload.deliveryMode);
  if (deliveryMode === 'replace_with_bot_message') {
    return readTrimmedString(payload.replacementMessageId);
  }
  if (deliveryMode === 'reply_message') {
    return readTrimmedString(payload.replyMessageId);
  }
  return readTrimmedString(payload.messageId);
}
