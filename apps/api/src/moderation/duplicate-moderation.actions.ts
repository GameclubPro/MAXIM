import type { MaxUpdate } from '@maxim/contracts';
import type { ChatSettings } from '../prisma/prisma-client';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import type { DuplicateDecision, DuplicateHit } from './rule-engine.contract';

export type DuplicateModerationActionRequest = {
  update: MaxUpdate;
  chatId: string;
  userId: string;
  messageId: string;
  settings: ChatSettings;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
  actionClaimed: boolean;
  backgroundExecution?: boolean;
  assertActiveLease?: () => void;
  deleteIntent?: EnsureModerationDeleteIntentInput;
  authorizeDelete: () => Promise<boolean>;
  beforeSanctionMutation?: () => Promise<void>;
} & (
  | { outcome: { kind: 'hit'; hit: DuplicateHit }; authorizeSanction?: never }
  | {
      outcome: { kind: 'decision'; decision: DuplicateDecision };
      authorizeSanction: () => Promise<boolean>;
    }
);

export type ExecuteDuplicateModerationAction = (
  request: DuplicateModerationActionRequest,
) => Promise<void>;

export function duplicateExplanationIdempotencyKey(
  metadata: Record<string, unknown> | undefined,
  chatId: string,
  messageId: string,
): string | undefined {
  const source =
    typeof metadata?.duplicateSource === 'string' ? metadata.duplicateSource.trim() : null;
  return source === 'photo' || source === 'message_v1'
    ? `${source}-duplicate:${chatId}:${messageId}:explanation`
    : undefined;
}

export function buildDuplicateModerationParameters(
  params: DuplicateModerationActionRequest,
  userLabel: string,
) {
  const message = params.update.message;
  if (!message) throw new Error('Duplicate action source message unavailable');
  return {
    chatId: params.chatId,
    userId: params.userId,
    messageId: params.messageId,
    text: message.text ?? '',
    createdAt: message.createdAt,
    userLabel,
    botSpeechStyle: params.settings.botSpeechStyle,
    botSpeechMedia: params.settings.botSpeechMedia,
    duplicateBotMessageEnabled: params.settings.duplicateBotMessageEnabled,
    duplicateBotMessageText: params.settings.duplicateBotMessageText,
    duplicateBotButtons: params.settings.duplicateBotButtons,
    duplicateBotButtonEnabled: params.settings.duplicateBotButtonEnabled,
    duplicateBotButtonUrl: params.settings.duplicateBotButtonUrl,
    duplicateBotButtonText: params.settings.duplicateBotButtonText,
    duplicateAdminContactButtonEnabled: params.settings.duplicateAdminContactButtonEnabled,
    duplicateAdminContactButtonUrl: params.settings.duplicateAdminContactButtonUrl,
    rulesAttachViolationsEnabled: params.settings.rulesAttachViolationsEnabled,
    rulesPublishedUrl: params.rulesPublishedUrl,
    rulesPublishedMessageId: params.rulesPublishedMessageId,
    deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
    deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
    suppressNonEssentialMessages: false,
    backgroundExecution: params.backgroundExecution ?? false,
    actionClaimed: params.actionClaimed,
    assertActiveLease: params.assertActiveLease,
    authorizeDelete: params.authorizeDelete,
    deleteIntent: params.deleteIntent,
  } as const;
}
