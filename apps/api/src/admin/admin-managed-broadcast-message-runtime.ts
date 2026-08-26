import { ServiceUnavailableException, type Logger } from '@nestjs/common';
import type { ManagedEntityType, SendBroadcastRequest } from '@maxim/contracts';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import {
  MAX_API_SOURCE_TAGS,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import type { ManagedBroadcastCommentDialogReference } from './admin-managed-broadcast-ledger';
import type { ManagedBroadcastResolvedMedia } from './admin.service.support';
import {
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
  CHAT_DIALOG_ACTION_AUTO_ATTACH,
} from './admin.service.support';
import { readPublisherPreparedDialogContext } from './publisher-dialog-context.service';

export class AdminManagedBroadcastMessageRuntime {
  constructor(
    private readonly context: AdminManagedBroadcastRuntimeContext,
    private readonly logger: Logger,
  ) {}

  async buildMessage(
    chatId: string,
    entityType: ManagedEntityType,
    payload: SendBroadcastRequest,
    normalizedSourceText: string,
    media: ManagedBroadcastResolvedMedia,
    dispatchBotId?: string,
    dialogBotId: string | undefined = dispatchBotId,
    publisherDialog?: { value: unknown; required: boolean },
  ): Promise<{
    messageText: string;
    messageOptions:
      | Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
      | undefined;
    commentDialogReference: ManagedBroadcastCommentDialogReference | null;
  }> {
    const preparedDialog = dialogBotId
      ? readPublisherPreparedDialogContext(publisherDialog?.value, dialogBotId)
      : null;
    if (publisherDialog?.required && !preparedDialog) {
      throw new ServiceUnavailableException(
        'Publisher delivery is missing its main-bot signed dialog context',
      );
    }
    const resolvedDialog = preparedDialog
      ? { buttons: preparedDialog.buttons, commentDialogReference: preparedDialog.reference }
      : await this.context.resolveBroadcastButtonContext(
          chatId,
          entityType,
          {
            customButtons: payload.buttons,
            includeCustomButton: payload.buttonEnabled,
            customButtonText: payload.buttonText.trim(),
            customButtonUrl: payload.buttonUrl.trim(),
          },
          dialogBotId,
        );
    const { buttons, commentDialogReference: dialogReference } = resolvedDialog;
    const commentDialogReference = dialogReference
      ? {
          ...dialogReference,
          botId: dispatchBotId ?? null,
          dialogBotId: dialogBotId ?? dispatchBotId ?? null,
        }
      : null;
    const hasMedia = Boolean(media.imagePayload) || Boolean(media.attachments?.length);
    const hasText = normalizedSourceText.trim().length > 0;
    const richText = payload.textFormat === 'markdown' && hasText;
    const baseText = richText
      ? renderSupportedMarkdownAsHtml(normalizedSourceText, { blockMode: 'raw' })
      : hasText
        ? normalizedSourceText
        : hasMedia
          ? ' '
          : '';
    const baseTextFormat: MaxSendMessageOptions['textFormat'] = richText ? 'html' : undefined;
    const preparedText = this.context.channelPostSignatureService
      ? await this.context.channelPostSignatureService.preparePostText(
          chatId,
          { text: baseText, ...(baseTextFormat ? { textFormat: baseTextFormat } : {}) },
          {
            entityType,
            trafficClass: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
          },
        )
      : { text: baseText, textFormat: baseTextFormat, signatureApplied: false };
    const messageOptions =
      buttons.length > 0 || hasMedia || preparedText.textFormat
        ? {
            ...(preparedText.textFormat ? { textFormat: preparedText.textFormat } : {}),
            ...(buttons.length > 0 ? { buttons } : {}),
            ...(media.imagePayload ? { imagePayload: media.imagePayload } : {}),
            ...(media.attachments?.length ? { attachments: media.attachments } : {}),
          }
        : undefined;
    return {
      messageText: preparedText.text,
      messageOptions,
      commentDialogReference,
    };
  }

  async recordDialogReference(params: {
    chatId: string;
    actorUserId: string;
    messageId: string | null;
    publishedUrl?: string | null;
    text?: string | null;
    reference: ManagedBroadcastCommentDialogReference | null;
    source: string;
    broadcastId?: string;
    occurrenceIndex?: number;
  }): Promise<void> {
    const { chatId, actorUserId, messageId, reference } = params;
    if (!messageId || (!reference?.includeCommentsButton && !reference?.includeSuggestButton)) {
      return;
    }
    const previewText = params.text?.trim() ? params.text : null;
    const publishedUrl = params.publishedUrl?.trim() || null;
    const commonPayload = {
      messageId,
      threadId: reference.threadId,
      source: 'managed_broadcast',
      managedBroadcastSource: params.source,
      ...(previewText ? { text: previewText } : {}),
      ...(publishedUrl ? { publishedUrl } : {}),
      ...(params.broadcastId ? { broadcastId: params.broadcastId } : {}),
      ...(params.occurrenceIndex ? { occurrenceIndex: params.occurrenceIndex } : {}),
      ...(reference.botId ? { botId: reference.botId } : {}),
      ...(reference.dialogBotId ? { dialogBotId: reference.dialogBotId } : {}),
      ...(reference.customButtons.length > 0 ? { customButtons: reference.customButtons } : {}),
    };
    const payload =
      reference.entityType === 'channel'
        ? {
            ...commonPayload,
            includeCommentsButton: reference.includeCommentsButton,
            includeSuggestButton: reference.includeSuggestButton,
            suggestionEntryMode: reference.suggestionEntryMode,
            ...(reference.suggestButtonText
              ? { suggestButtonText: reference.suggestButtonText }
              : {}),
          }
        : commonPayload;
    try {
      await this.context.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId,
          action:
            reference.entityType === 'channel'
              ? CHANNEL_DIALOG_ACTION_AUTO_ATTACH
              : CHAT_DIALOG_ACTION_AUTO_ATTACH,
          payload,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          entityType: reference.entityType,
          messageId,
          threadId: reference.threadId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record managed broadcast comments button reference',
      );
    }
  }
}
