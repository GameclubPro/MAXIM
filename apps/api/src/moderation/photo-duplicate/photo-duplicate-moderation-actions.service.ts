import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildMessageScopedModerationActionClaimKey,
  claimDurableModerationMessageAction,
  type ModerationMessageActionClaimModel,
} from '../moderation-message-action-claim';
import { ModerationService } from '../moderation.service';
import {
  buildPhotoDuplicateActionClaimDedupeKey,
  PHOTO_DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE,
  type PhotoDuplicateModerationActions,
} from './photo-duplicate-moderation.actions';

@Injectable()
export class PhotoDuplicateModerationActionsService implements PhotoDuplicateModerationActions {
  private readonly logger = new Logger(PhotoDuplicateModerationActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  isPhotoDuplicateMessageAuthorImmune(
    params: Parameters<PhotoDuplicateModerationActions['isPhotoDuplicateMessageAuthorImmune']>[0],
  ): boolean {
    return this.moderation.isPhotoDuplicateMessageAuthorImmune(params);
  }

  consumePhotoDuplicateParticipantImmunity(
    params: Parameters<
      PhotoDuplicateModerationActions['consumePhotoDuplicateParticipantImmunity']
    >[0],
  ): Promise<boolean> {
    return this.moderation.consumePhotoDuplicateParticipantImmunity(params);
  }

  async claimPhotoDuplicateAction(
    params: Parameters<PhotoDuplicateModerationActions['claimPhotoDuplicateAction']>[0],
  ): ReturnType<PhotoDuplicateModerationActions['claimPhotoDuplicateAction']> {
    const dedupeKey = buildPhotoDuplicateActionClaimDedupeKey(params);
    const messageActionKey = buildMessageScopedModerationActionClaimKey(
      params.chatId,
      params.messageId,
    );
    const data = {
      dedupeKey,
      messageActionKey,
      chatId: params.chatId,
      userId: params.userId,
      messageId: params.messageId,
      ruleCode: PHOTO_DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE,
      updateType: 'message_action',
    } as const;

    try {
      return await claimDurableModerationMessageAction({
        model: this.prisma
          .moderationViolationMessageClaim as unknown as ModerationMessageActionClaimModel,
        data,
        resumeKnownOwner: true,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to establish durable photo duplicate action ownership',
      );
      throw error;
    }
  }

  executePhotoDuplicateAction(
    params: Parameters<PhotoDuplicateModerationActions['executePhotoDuplicateAction']>[0],
  ): Promise<void> {
    return this.moderation.executePhotoDuplicateAction(params);
  }
}
