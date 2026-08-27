import type { Logger } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import type { MaxMessageButton } from '../max/max-client.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  PublisherChatCommentAdmissionError,
  type PublisherChatCommentQueueService,
} from '../publisher/publisher-chat-comment.queue';

export class PublisherCommentKeyboardRouting {
  constructor(
    private readonly botRegistry: MaxBotRegistryService | undefined,
    private readonly queue: PublisherChatCommentQueueService | undefined,
    private readonly logger: Logger,
  ) {}

  async tryEnqueue(params: {
    chatId: string;
    messageId: string;
    threadId: string;
    entityType: ManagedEntityType;
    botId: string | null;
    dialogBotId: string | null;
    buttons: MaxMessageButton[][];
    commentsButton: { rowIndex: number; columnIndex: number; baseText: string | null } | null;
    count: number;
  }): Promise<boolean> {
    const publisherBotId = this.botRegistry?.getPublisherBotDescriptor().id ?? null;
    if (!publisherBotId || params.botId !== publisherBotId) {
      return false;
    }
    if (!params.commentsButton) {
      return true;
    }
    if (!this.queue || !params.dialogBotId) {
      this.logger.warn(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          messageId: params.messageId,
        },
        'Skipped publisher-origin comments counter because its exact edit route is unavailable',
      );
      return true;
    }
    try {
      await this.queue.enqueueKeyboardEdit({
        entityType: params.entityType,
        readinessFeature: params.entityType === 'chat' ? 'chat_comments' : 'publication',
        chatId: params.chatId,
        messageId: params.messageId,
        threadId: params.threadId,
        requiredBotId: publisherBotId,
        dialogBotId: params.dialogBotId,
        buttons: params.buttons,
        commentsButton: params.commentsButton,
        countSnapshot: params.count,
      });
    } catch (error: unknown) {
      if (!(error instanceof PublisherChatCommentAdmissionError)) {
        throw error;
      }
      this.logger.debug(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          messageId: params.messageId,
          reason: error.reason,
        },
        'Skipped publisher-origin comments counter while admission is closed',
      );
    }
    return true;
  }
}

export function createCommentsButtonPosition(
  buttons: readonly MaxMessageButton[][],
  baseText: string | null,
) {
  return { rowIndex: buttons.length, columnIndex: 0, baseText };
}
