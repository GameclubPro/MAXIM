import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REQUIRED_SUBSCRIPTION_MAX_CHANNELS } from '@maxim/contracts';
import { extractHttpStatusCode } from '../common/http-error.util';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { isMaxExactMessageLookupMissingIdError } from '../max/max-exact-message-lookup.error';
import { wasMaxMemberMutationAttempted } from '../max/max-member-error.util';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from '../max/max-mutation-outcome.util';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { fingerprintModerationSettings } from './message-limits-delete-guard.service';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import {
  assertRequiredSubscriptionNoticeAuthority,
  RequiredSubscriptionNoticeRejectedError,
  type RequiredSubscriptionNoticeAuthority,
} from './required-subscription-notice-authority';

export const REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE = 'REQUIRED_SUBSCRIPTION_DELETE';
export class RequiredSubscriptionExecutionRejectedError extends Error {
  readonly code = 'required_subscription_no_longer_authorized';
}

// FLAG: Initial unavailable evidence is distinct from revoked execution authority or absence.
export class RequiredSubscriptionInitialSourceUnavailableError extends Error {
  readonly code = 'required_subscription_initial_source_unavailable';

  constructor(cause: unknown) {
    super('Required subscription initial source unavailable', { cause });
    this.name = 'RequiredSubscriptionInitialSourceUnavailableError';
  }
}

@Injectable()
export class RequiredSubscriptionExecutionGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly membership: MaxMembershipLookupService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
  ) {}

  async assertNoticeAllowed(
    proof: RequiredSubscriptionNoticeAuthority,
    botId?: string,
    beforeFinalAuthority?: () => Promise<void>,
  ): Promise<void> {
    const options = {
      botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
    };
    await assertRequiredSubscriptionNoticeAuthority(this.prisma, proof, {
      isKnownBotUserId: (userId) => this.bots.isKnownBotUserId(userId),
      getMemberAccess: () => this.max.getChatMemberAccess(proof.chatId, proof.userId, options),
      getSource: () => this.max.getExactMessageRow(proof.chatId, proof.messageId, options),
      getMembership: async (targetId) => {
        // FLAG: The selected executor proves the source chat. Each subscription target
        // has its own read route; retain fresh evidence without forcing the source bot there.
        const result = await this.membership.getMembershipResolution(
          targetId,
          proof.userId,
          'moderation_required_subscription',
          { forceRefresh: true, allowStaleOnError: false },
        );
        if (!result.fresh || result.membership === null) {
          if (
            this.membership.getLookupIssue(targetId, 'moderation_required_subscription')?.kind ===
            'terminal'
          )
            throw new RequiredSubscriptionNoticeRejectedError();
          throw new Error('Required subscription notice fresh membership unavailable');
        }
        return result.membership;
      },
      consumeImmunity: (input) => this.immunity.consumeForMessage(input),
      beforeFinalAuthority,
    });
  }

  async authorize(params: {
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId?: string;
    initialQualification?: boolean;
    beforeFinalAuthority?: () => Promise<void>;
    reasons: readonly { ruleCode: string; reasonKey: string; metadata: unknown }[];
  }): Promise<
    | 'not_applicable'
    | 'absent'
    | {
        reasonKeys: string[];
        deadlineAtMs: number;
        reasonDeadlines: { reasonKey: string; deadlineAtMs: number }[];
      }
  > {
    const reasons = params.reasons.filter(
      (r) => r.ruleCode === REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE,
    );
    if (!reasons.length) return 'not_applicable';
    const userId = params.subjectUserId;
    if (!userId || this.bots.isKnownBotUserId(userId)) this.reject();
    const load = async () => {
      const settings = await this.prisma.chatSettings.findUnique({
        where: { chatId: params.chatId },
        include: {
          chat: {
            select: { entityType: true, admins: { where: { userId }, select: { userId: true } } },
          },
        },
      });
      if (
        !settings ||
        settings.chat.entityType !== 'CHAT' ||
        settings.chat.admins.length ||
        !settings.requiredSubscriptionEnabled
      )
        this.reject();
      return settings;
    };
    const settings = await load();
    const targets = Array.isArray(settings.requiredSubscriptionChannelIds)
      ? [
          ...new Set(
            settings.requiredSubscriptionChannelIds
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              .map((v) => v.trim()),
          ),
        ]
      : [];
    if (!targets.length || targets.length > REQUIRED_SUBSCRIPTION_MAX_CHANNELS) this.reject();
    const eligible = reasons.filter((reason) => {
      const binding = this.metadata(reason.metadata);
      const sourceAt = Number(binding.requiredSubscriptionSourceAtMs);
      const deadline = Number(binding.requiredSubscriptionDeadlineAtMs);
      return (
        binding.requiredSubscriptionGuardVersion === 1 &&
        binding.requiredSubscriptionPolicySha256 ===
          fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION') &&
        Number.isSafeInteger(sourceAt) &&
        sourceAt > 0 &&
        sourceAt <= Date.now() &&
        deadline === sourceAt + 5 * 60_000 &&
        Date.now() < deadline
      );
    });
    if (!eligible.length) this.reject();
    const options = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
    };
    const access = await this.max.getChatMemberAccess(params.chatId, userId, options);
    if (!access || access.isAdmin === true || access.isOwner === true) this.reject();
    if (access.userId !== userId || access.isAdmin !== false || access.isOwner !== false)
      throw new Error('Required subscription author access unavailable');
    let row: Record<string, unknown> | null;
    try {
      row = await this.max.getExactMessageRow(params.chatId, params.messageId, options);
    } catch (error) {
      // FLAG: Only the initial source GET may classify 404 or locally proven missing-ID
      // responses as unavailable evidence, never as confirmed absence.
      // Later authorization and attempted mutations retain their original failure fences.
      if (
        params.initialQualification === true &&
        (extractHttpStatusCode(error) === 404 || isMaxExactMessageLookupMissingIdError(error)) &&
        !wasMaxMessageSendAttempted(error) &&
        !wasMaxMemberMutationAttempted(error) &&
        !isMaxMutationOutcomeAmbiguous(error)
      )
        throw new RequiredSubscriptionInitialSourceUnavailableError(error);
      throw error;
    }
    if (!row) return 'absent';
    const message = this.parser.parse({
      type: 'message_created',
      updateId: 'required-subscription-final-guard',
      message: row,
    }).message;
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== userId ||
      message.entityType === 'channel'
    )
      this.reject();
    // FLAG: Fresh negative membership is required at the mutation boundary. Never reuse
    // stale missing snapshots, retry counters, or a notice lease as subscription authority.
    // Resolve each target's own read route independently of the source executor's route.
    let missing = false;
    for (let offset = 0; offset < targets.length; offset += 2) {
      const results = await Promise.all(
        targets.slice(offset, offset + 2).map(async (target) => {
          const result = await this.membership.getMembershipResolution(
            target,
            userId,
            'moderation_required_subscription',
            { forceRefresh: true, allowStaleOnError: false },
          );
          if (!result.fresh || result.membership === null) {
            if (
              this.membership.getLookupIssue(target, 'moderation_required_subscription')?.kind ===
              'terminal'
            )
              this.reject();
            throw new Error('Required subscription fresh membership unavailable');
          }
          return result.membership;
        }),
      );
      if (results.some((membership) => !membership)) missing = true;
    }
    if (!missing) this.reject();
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'required-subscription-final:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    await params.beforeFinalAuthority?.();
    if (
      fingerprintModerationSettings(await load(), 'REQUIRED_SUBSCRIPTION') !==
      fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION')
    )
      this.reject();
    const reasonDeadlines = eligible
      .map((reason) => ({
        reasonKey: reason.reasonKey,
        deadlineAtMs: Number(this.metadata(reason.metadata).requiredSubscriptionDeadlineAtMs),
      }))
      .filter((reason) => Date.now() < reason.deadlineAtMs);
    if (!reasonDeadlines.length) this.reject();
    return {
      reasonKeys: reasonDeadlines.map((r) => r.reasonKey),
      deadlineAtMs: Math.max(...reasonDeadlines.map((r) => r.deadlineAtMs)),
      reasonDeadlines,
    };
  }

  private metadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  private reject(): never {
    throw new RequiredSubscriptionExecutionRejectedError();
  }
}
