import { Injectable } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { ChatSettings } from '../../prisma/prisma-client';
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { PhotoDuplicateRuntimePolicyService } from '../photo-duplicate/photo-duplicate-runtime-policy.service';
import { maskText } from '../text-mask.util';
import type { DuplicateHit } from '../rule-engine.contract';
import { digestDuplicateContent } from './message-duplicate-content';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { messageDuplicateActionsEnabled } from './message-duplicate-policy.service';
import {
  MessageDuplicateDeleteGuardService,
  MessageDuplicateGuardRejectedError,
} from './message-duplicate-delete-guard.service';
import { resolveDuplicateFlowOutcome } from '../duplicate-flow-policy';
import type { ExecuteDuplicateModerationAction } from '../duplicate-moderation.actions';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import {
  MESSAGE_DUPLICATE_CLAIM_PREFIX,
  MESSAGE_DUPLICATE_SOURCE,
  messageDuplicateSanctionSettingsDigest,
  type MessageDuplicateBinding,
} from './message-duplicate-state';

@Injectable()
export class MessageDuplicateEnforcementService {
  constructor(
    private readonly intents: ModerationDeleteIntentService,
    private readonly policy: MessageDuplicatePolicyService,
    private readonly photoPolicy: PhotoDuplicateRuntimePolicyService,
    private readonly guard: MessageDuplicateDeleteGuardService,
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
    update?: MaxUpdate;
    executeFullAction?: ExecuteDuplicateModerationAction;
  }): Promise<boolean> {
    const policy = await this.policy.resolve(params.chatId, true);
    if (
      !messageDuplicateActionsEnabled(policy.mode) ||
      policy.revision !== params.binding.controlRevision ||
      params.binding.eventTimestampMs < policy.effectiveAtMs
    )
      return false;
    const full = policy.mode === 'full';
    const binding: MessageDuplicateBinding = { ...params.binding, ...(full ? { version: 2 } : {}) };
    const decision = full
      ? resolveDuplicateFlowOutcome({
          settings: params.settings,
          repeatCount: params.hit.count,
          hash: params.hit.hash,
          fingerprintType: params.hit.fingerprintType,
        }).decision
      : undefined;
    if (decision) {
      binding.sanction = {
        action: decision.action,
        repeatCount: decision.count,
        threshold: decision.threshold,
        settingsDigest: messageDuplicateSanctionSettingsDigest(params.settings),
      };
      binding.requiredCount = Math.max(binding.requiredCount, decision.threshold + 1);
    }
    if (binding.hasPhotos && !full) {
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
    if (full && (!params.update || !params.executeFullAction))
      throw new Error('Full message duplicate action executor unavailable');
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
    const intent: EnsureModerationDeleteIntentInput = {
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
          enforcementScope: full ? 'full' : 'delete_only',
        },
      },
    };
    const result = await this.intents.ensureIntentWithMessageActionClaim({ claim, intent });
    params.assertLease?.();
    if (
      full &&
      result.claim !== 'blocked' &&
      result.intent?.intentId &&
      result.intent.rollout === 'execute'
    ) {
      const check = async (sanction = false): Promise<boolean> => {
        params.assertLease?.();
        try {
          const allowed = await this.guard.assertMessageStillActionable({
            chatId: params.chatId,
            messageId: binding.messageId,
            subjectUserId: binding.senderId,
            botId: params.botId,
            binding,
            ...(sanction ? { sanctionIntentId: result.intent!.intentId! } : {}),
          });
          params.assertLease?.();
          return allowed === 'allowed';
        } catch (error) {
          if (error instanceof MessageDuplicateGuardRejectedError) return false;
          throw error;
        }
      };
      const metadata = {
        ...params.hit.metadata,
        duplicateSource: MESSAGE_DUPLICATE_SOURCE,
        messageDuplicate: binding,
        enforcementScope: 'full',
      };
      const common = {
        update: params.update!,
        chatId: params.chatId,
        userId: binding.senderId,
        messageId: binding.messageId,
        settings: params.settings,
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
        actionClaimed: true,
        backgroundExecution: params.assertLease !== undefined,
        deleteIntent: intent,
        assertActiveLease: params.assertLease,
        authorizeDelete: () => check(),
      };
      await params.executeFullAction!(
        decision
          ? {
              ...common,
              outcome: { kind: 'decision', decision: { ...decision, metadata } },
              authorizeSanction: () => check(true),
              beforeSanctionMutation: async () => {
                if (!(await check(true)))
                  throw new MessageDuplicateGuardRejectedError(
                    'message_duplicate_sanction_revoked',
                  );
              },
            }
          : { ...common, outcome: { kind: 'hit', hit: { ...params.hit, metadata } } },
      );
    }
    return result.claim !== 'blocked';
  }
}
