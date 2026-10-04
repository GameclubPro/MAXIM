import { Injectable, Optional } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { DuplicateObservationOutcome } from '@maxim/contracts/settings';
import type { ChatSettings } from '../../prisma/prisma-client';
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { maskText } from '../text-mask.util';
import type { DuplicateHit } from '../rule-engine.contract';
import { digestDuplicateContent } from './message-duplicate-content';
import {
  MessageDuplicateMetricsService,
  measureDuplicatePhase,
} from './message-duplicate-metrics.service';
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

export type DuplicateEnforcementResult =
  | {
      kind: 'rejected';
      reason: 'binding_invalid' | 'policy_changed' | 'qualification_rejected' | 'claim_blocked';
    }
  | { kind: 'intent_accepted'; intentId: string };

export function duplicateEnforcementObservation(
  result: DuplicateEnforcementResult,
): DuplicateObservationOutcome {
  if (result.kind === 'intent_accepted') return 'ENFORCEMENT_REQUESTED';
  switch (result.reason) {
    case 'policy_changed':
      return 'POLICY_CHANGED';
    case 'qualification_rejected':
      return 'MATCHED_QUALIFICATION_REJECTED';
    case 'claim_blocked':
      return 'MATCHED_CLAIM_BLOCKED';
    case 'binding_invalid':
      return 'MATCHED_INELIGIBLE';
  }
}

@Injectable()
export class MessageDuplicateEnforcementService {
  constructor(
    private readonly intents: ModerationDeleteIntentService,
    private readonly policy: MessageDuplicatePolicyService,
    private readonly guard: MessageDuplicateDeleteGuardService,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
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
  }): Promise<DuplicateEnforcementResult> {
    this.metrics?.record('enforcement.match_found');
    const policy = await this.policy.resolve(params.chatId, true);
    const imageOnly = params.binding.compareMode === 'IMAGE';
    const full = policy.mode === 'full';
    const binding: MessageDuplicateBinding = {
      ...params.binding,
      enforcementScope: full ? 'full' : 'delete_only',
    };
    if (binding.version !== 3 || !binding.authorization)
      return { kind: 'rejected', reason: 'binding_invalid' };
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
    params.assertLease?.();
    if (
      !messageDuplicateActionsEnabled(policy.mode) ||
      (imageOnly && policy.mode !== 'full') ||
      (binding.hasPhotos && !imageOnly) ||
      policy.revision !== binding.controlRevision ||
      binding.eventTimestampMs < policy.effectiveAtMs
    ) {
      this.metrics?.record('enforcement.policy_changed');
      await this.intents.releaseUnmaterializedMessageAction({ claim, binding });
      return { kind: 'rejected', reason: 'policy_changed' };
    }
    try {
      await this.guard.assertQualificationAuthority(params.chatId, binding);
    } catch (error) {
      if (error instanceof MessageDuplicateGuardRejectedError) {
        await this.intents.releaseUnmaterializedMessageAction({ claim, binding });
        this.metrics?.record('enforcement.qualification_rejected');
        return { kind: 'rejected', reason: 'qualification_rejected' };
      }
      throw error;
    }
    // FLAG: A competing rule must win the durable action claim before qualification
    // can reserve an escalation stage. Our own interrupted claim is resumable.
    if ((await this.intents.claimMessageActionBeforeQualification(claim, binding)) === 'blocked') {
      this.metrics?.record('enforcement.claim_blocked');
      return { kind: 'rejected', reason: 'claim_blocked' };
    }
    let repeatCount: number | null;
    try {
      repeatCount = await measureDuplicatePhase(this.metrics, 'qualification', () =>
        this.guard.qualify({
          chatId: params.chatId,
          messageId: binding.messageId,
          subjectUserId: binding.senderId,
          botId: params.botId,
          binding,
        }),
      );
    } catch (error) {
      if (error instanceof MessageDuplicateGuardRejectedError) {
        await this.intents.releaseUnmaterializedMessageAction({ claim, binding });
        this.metrics?.record('enforcement.qualification_rejected');
        return { kind: 'rejected', reason: 'qualification_rejected' };
      }
      throw error;
    }
    if (repeatCount === null) {
      await this.intents.releaseUnmaterializedMessageAction({ claim, binding });
      this.metrics?.record('enforcement.qualification_rejected');
      return { kind: 'rejected', reason: 'qualification_rejected' };
    }
    const decision = full
      ? resolveDuplicateFlowOutcome({
          settings: params.settings,
          repeatCount,
          hash: params.hit.hash,
          fingerprintType: params.hit.fingerprintType,
        }).decision
      : undefined;
    if (decision) {
      binding.sanction = {
        action: decision.action,
        repeatCount: decision.count,
        threshold: decision.threshold,
        settingsDigest: messageDuplicateSanctionSettingsDigest(params.settings, imageOnly),
      };
    }
    if (full && (!params.update || !params.executeFullAction))
      throw new Error('Full message duplicate action executor unavailable');
    params.assertLease?.();
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
        Math.min(
          policy.expiresAtMs,
          binding.original!.expiresAtMs,
          binding.authorization.deadlineAtMs,
        ),
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
          count: repeatCount,
          windowSec: binding.windowSeconds,
          reason: 'Repeated message content',
          enforcementScope: full ? 'full' : 'delete_only',
        },
      },
    };
    try {
      await this.guard.assertQualificationAuthority(params.chatId, binding);
    } catch (error) {
      if (error instanceof MessageDuplicateGuardRejectedError) {
        await this.intents.releaseUnmaterializedMessageAction({ claim, binding });
        this.metrics?.record('enforcement.qualification_rejected');
        return { kind: 'rejected', reason: 'qualification_rejected' };
      }
      throw error;
    }
    params.assertLease?.();
    const result = await measureDuplicatePhase(this.metrics, 'intent_handoff', () =>
      this.intents.ensureIntentWithMessageActionClaim({ claim, intent }),
    );
    if (result.claim === 'blocked')
      await this.intents.releaseUnmaterializedMessageAction({ claim, binding });
    this.metrics?.record(
      result.claim === 'blocked' ? 'enforcement.claim_blocked' : 'enforcement.intent_handoff',
    );
    if (result.claim === 'blocked') return { kind: 'rejected', reason: 'claim_blocked' };
    // FLAG: Persisted intent acceptance is not a DELETE receipt or a completed sanction.
    if (!result.intent.intentId) throw new Error('Message duplicate intent was not materialized');
    this.metrics?.record('enforcement.intent_accepted');
    params.assertLease?.();
    if (full && result.intent?.intentId && result.intent.rollout === 'execute') {
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
          : {
              ...common,
              outcome: { kind: 'hit', hit: { ...params.hit, count: repeatCount, metadata } },
            },
      );
    }
    return { kind: 'intent_accepted', intentId: result.intent.intentId };
  }
}
