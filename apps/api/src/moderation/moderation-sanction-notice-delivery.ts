import type { BotSpeechStyle } from '@maxim/contracts/bot-speech';
import type { MaxActionLedgerContext, MaxSendMessageOptions } from '../max/max-client.service';
import { withModerationReleaseButton } from './moderation-release-callback.util';

export type ModerationNoticeImmediateOptions = {
  immediate?: boolean;
  beforeImmediateSendMutation?: (beforeFinalAuthority?: () => Promise<void>) => Promise<void>;
};

export type SanctionNoticeParams = {
  chatId: string;
  userId: string;
  messageId: string;
  userLabel: string;
  deleteBotMessagesEnabled: boolean;
  deleteBotMessagesDelayMinutes: number;
  botMessageOptions?: MaxSendMessageOptions;
  sanctionNoticeText?: string;
  bypassNoticeBucket?: boolean;
  idempotencyKey?: string;
  rethrowOnFailure?: boolean;
  botSpeechStyle: BotSpeechStyle | null;
  botId?: string;
  sanctionEventId?: string | null;
  beforeSend?: () => Promise<void>;
  ledgerContext?: MaxActionLedgerContext;
  noticeDispatchOptions?: ModerationNoticeImmediateOptions;
};

export async function deliverSanctionNotice(params: {
  notice: SanctionNoticeParams;
  action: 'UNMUTE' | 'UNBAN';
  text: string;
  send: (
    input: {
      chatId: string;
      botId?: string;
      text: string;
      messageOptions?: MaxSendMessageOptions;
      deleteBotMessagesEnabled: boolean;
      deleteBotMessagesDelayMinutes: number;
      userFacing: true;
      bypassNoticeBucket?: boolean;
      idempotencyKey?: string;
      beforeSend?: () => Promise<void>;
      ledgerContext?: MaxActionLedgerContext;
    } & ModerationNoticeImmediateOptions,
  ) => Promise<boolean>;
  logger: { warn: (data: Record<string, unknown>, message: string) => void };
}): Promise<void> {
  const input = params.notice;
  try {
    await params.send({
      ...input.noticeDispatchOptions,
      chatId: input.chatId,
      botId: input.botId,
      text: params.text,
      messageOptions: input.sanctionEventId
        ? withModerationReleaseButton(input.botMessageOptions, {
            action: params.action,
            sanctionEventId: input.sanctionEventId,
          })
        : input.botMessageOptions,
      deleteBotMessagesEnabled: input.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: input.deleteBotMessagesDelayMinutes,
      userFacing: true,
      bypassNoticeBucket: input.bypassNoticeBucket,
      idempotencyKey: input.idempotencyKey,
      beforeSend: input.beforeSend,
      ledgerContext: input.ledgerContext,
    });
  } catch (error) {
    params.logger.warn(
      {
        chatId: input.chatId,
        userId: input.userId,
        messageId: input.messageId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      params.action === 'UNMUTE'
        ? 'Failed to send mute notice message'
        : 'Failed to send permanent ban notice message',
    );
    if (input.rethrowOnFailure) throw error;
  }
}
