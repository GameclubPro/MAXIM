import { Injectable } from '@nestjs/common';
import type { ChatSettings } from '../../prisma/prisma-client';
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { PhotoDuplicateRuntimePolicyService } from '../photo-duplicate/photo-duplicate-runtime-policy.service';
import { maskText } from '../text-mask.util';
import type { DuplicateHit } from '../rule-engine.contract';
import { digestDuplicateContent } from './message-duplicate-content';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import {
  MESSAGE_DUPLICATE_CLAIM_PREFIX,
  MESSAGE_DUPLICATE_SOURCE,
  type MessageDuplicateBinding,
} from './message-duplicate-state';

@Injectable()
export class MessageDuplicateEnforcementService {
  constructor(
    private readonly intents: ModerationDeleteIntentService,
    private readonly policy: MessageDuplicatePolicyService,
    private readonly photoPolicy: PhotoDuplicateRuntimePolicyService,
  ) {}

  async enqueue(params: {
    chatId: string;
    sourceCreatedAt: string;
    botId: string;
    text: string;
    settings: ChatSettings;
    hit: DuplicateHit;
    binding: MessageDuplicateBinding;
    assertLease?: () => void;
  }): Promise<boolean> {
    const policy = await this.policy.resolve(params.chatId, true);
    if (
      policy.mode !== 'delete_only' ||
      policy.revision !== params.binding.controlRevision ||
      params.binding.eventTimestampMs < policy.effectiveAtMs
    )
      return false;
    const binding = { ...params.binding };
    if (binding.hasPhotos) {
      const photo = await this.photoPolicy.resolveEffectivePolicy({
        chatId: params.chatId,
        preset: 'SAME_IMAGE',
        scope: 'SAME_AUTHOR',
      });
      if (
        !photo.enforce ||
        !photo.allowedMatchKinds.includes('canonical_sha256') ||
        !photo.controlRevision
      )
        return false;
      binding.photoControlRevision = photo.controlRevision;
    }
    params.assertLease?.();
    const claim = {
      dedupeKey: `${MESSAGE_DUPLICATE_CLAIM_PREFIX}${digestDuplicateContent([params.chatId, binding.senderId, binding.messageId])}`,
      messageActionKey: buildMessageScopedModerationActionClaimKey(
        params.chatId,
        binding.messageId,
      ),
      chatId: params.chatId,
      userId: binding.senderId,
      messageId: binding.messageId,
      ruleCode: 'DUPLICATE_MESSAGE_ACTION',
      updateType: 'message_action' as const,
    };
    const result = await this.intents.ensureIntentWithMessageActionClaim({
      claim,
      intent: {
        chatId: params.chatId,
        messageId: binding.messageId,
        subjectUserId: binding.senderId,
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        sourceMessageAt: params.sourceCreatedAt,
        originBotId: params.botId,
        ruleCode: 'DUPLICATE_DELETE',
        reasonKey: `MESSAGE_DUPLICATE:v1:${binding.eventTimestampMs}`,
        retryUntilAt: new Date(
          Math.min(policy.expiresAtMs, binding.eventTimestampMs + binding.windowSeconds * 1000),
        ),
        event: {
          userId: binding.senderId,
          eventType: 'MESSAGE',
          maskedExcerpt: maskText(params.text),
          score: 1,
          metadata: {
            duplicateSource: MESSAGE_DUPLICATE_SOURCE,
            messageDuplicate: binding,
            fingerprintType: params.hit.fingerprintType,
            count: params.hit.count,
            windowSec: binding.windowSeconds,
            reason: 'Repeated message content',
            enforcementScope: 'delete_only',
          },
        },
      },
    });
    params.assertLease?.();
    return result.claim !== 'blocked';
  }
}
