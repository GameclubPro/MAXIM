import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { PhotoDuplicateRuntimePolicyService } from '../photo-duplicate/photo-duplicate-runtime-policy.service';
import { resolveDuplicateFlowConfig, resolveDuplicateFlowOutcome } from '../duplicate-flow-policy';
import {
  buildMessageDuplicateIdentity,
  extractDuplicateMessageContent,
} from './message-duplicate-content';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import {
  MESSAGE_DUPLICATE_SOURCE,
  messageDuplicateSettingsDigest,
  messageDuplicateSanctionSettingsDigest,
  parseMessageDuplicateBinding,
  type MessageDuplicateBinding,
} from './message-duplicate-state';

export class MessageDuplicateGuardRejectedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MessageDuplicateGuardRejectedError';
  }
}

@Injectable()
export class MessageDuplicateDeleteGuardService {
  private readonly parser = new WebhookParser();
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly photoPolicy: PhotoDuplicateRuntimePolicyService,
    private readonly policy: MessageDuplicatePolicyService,
    private readonly history: MessageDuplicateHistoryService,
    config: ConfigService,
  ) {
    this.timeoutMs = config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000;
  }

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId: string;
  }): Promise<'allowed' | 'absent' | 'not_applicable'> {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, reasonKey: true, metadata: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 65,
    });
    if (reasons.length === 0)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_reason_missing');
    if (reasons.length > 64)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_reason_limit');
    const owned = reasons.filter(
      (reason) =>
        reason.reasonKey.startsWith('MESSAGE_DUPLICATE:') ||
        (reason.metadata as Record<string, unknown> | null)?.duplicateSource ===
          MESSAGE_DUPLICATE_SOURCE,
    );
    if (owned.length === 0) return 'not_applicable';
    // FLAG: Mixed guarded reasons must not mutually bypass their current-content checks.
    const bindings = owned.map((reason) =>
      reason.ruleCode === 'DUPLICATE_DELETE' ? parseMessageDuplicateBinding(reason.metadata) : null,
    );
    if (bindings.some((binding) => !binding))
      throw new MessageDuplicateGuardRejectedError('message_duplicate_binding_invalid');
    const binding = (bindings as MessageDuplicateBinding[]).sort(
      (a, b) => b.eventTimestampMs - a.eventTimestampMs,
    )[0]!;
    return this.assertMessageStillActionable({ ...params, binding });
  }

  async assertMessageStillActionable(params: {
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId: string;
    binding: MessageDuplicateBinding;
    sanctionIntentId?: string;
  }): Promise<'allowed' | 'absent'> {
    const { binding } = params;
    if (
      params.subjectUserId !== binding.senderId ||
      params.messageId !== binding.messageId ||
      this.bots.isKnownBotUserId(binding.senderId)
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    await this.assertPolicy(params.chatId, binding, Boolean(params.sanctionIntentId));
    const settings = await this.loadSettings(params.chatId, binding);
    const options = {
      botId: params.botId,
      timeoutMs: this.timeoutMs,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
    };
    const access = await this.max.getChatMemberAccess(params.chatId, binding.senderId, options);
    if (!access || (access.userId !== null && access.userId !== binding.senderId))
      throw new Error('Message duplicate author access unavailable');
    if (access.isAdmin || access.isOwner)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    const raw = await this.max.getExactMessageRow(params.chatId, params.messageId, options);
    if (!raw && !params.sanctionIntentId) return 'absent';
    if (!raw) {
      // FLAG: Absence alone cannot authorize a sanction. Require our exact successful DELETE
      // receipt and its immutable binding; an unrelated deletion or an ambiguous send is insufficient.
      const receipt = await this.prisma.moderationDeleteIntent.findUnique({
        where: { id: params.sanctionIntentId },
        select: {
          chatId: true,
          messageId: true,
          subjectUserId: true,
          remoteDeleteSucceededAt: true,
          reasons: {
            where: { reasonKey: `MESSAGE_DUPLICATE:v1:${binding.eventTimestampMs}` },
            select: { metadata: true, createdAt: true },
            take: 1,
          },
        },
      });
      const recorded = parseMessageDuplicateBinding(receipt?.reasons[0]?.metadata);
      if (
        !receipt?.remoteDeleteSucceededAt ||
        !receipt.reasons[0] ||
        receipt.reasons[0].createdAt > receipt.remoteDeleteSucceededAt ||
        receipt.chatId !== params.chatId ||
        receipt.messageId !== params.messageId ||
        receipt.subjectUserId !== binding.senderId ||
        !recorded ||
        recorded.contentDigest !== binding.contentDigest ||
        recorded.eventTimestampMs !== binding.eventTimestampMs ||
        recorded.controlRevision !== binding.controlRevision ||
        recorded.settingsDigest !== binding.settingsDigest ||
        JSON.stringify(recorded.sanction) !== JSON.stringify(binding.sanction)
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_unproven_absence');
      }
    } else {
      const message = this.parser.parse({
        type: 'message_created',
        updateId: 'message-duplicate-guard',
        message: raw,
      }).message;
      if (
        !message ||
        message.chatId !== params.chatId ||
        message.messageId !== params.messageId ||
        message.senderId !== binding.senderId ||
        message.entityType === 'channel'
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_identity_changed');
      }
      const content = extractDuplicateMessageContent(raw, false);
      if (
        (binding.compareMode === 'MESSAGE' && content.sourceDigest !== binding.sourceDigest) ||
        buildMessageDuplicateIdentity(content, binding.compareMode, binding.mediaHashes) !==
          binding.contentDigest
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_content_changed');
      }
    }
    if (!(await this.history.stillMatches(params.chatId, binding))) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_history_changed');
    }
    const protection = await this.immunity.consumeForMessage({
      chatId: params.chatId,
      userId: binding.senderId,
      messageId: binding.messageId,
      scope: 'duplicate:v1',
      nightModeTimezone: settings.nightModeTimezone,
    });
    if (protection === 'granted')
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    // FLAG: Re-read policy and settings after external/content checks, including queued intents.
    await this.loadSettings(params.chatId, binding);
    await this.assertPolicy(params.chatId, binding, Boolean(params.sanctionIntentId));
    return 'allowed';
  }

  private async assertPolicy(
    chatId: string,
    binding: MessageDuplicateBinding,
    requireFull = false,
  ): Promise<void> {
    const policy = await this.policy.resolve(chatId, true);
    if (
      (requireFull ? policy.mode !== 'full' : !['delete_only', 'full'].includes(policy.mode)) ||
      (binding.version === 2 && policy.mode !== 'full') ||
      (requireFull && (binding.version !== 2 || !binding.sanction)) ||
      policy.revision !== binding.controlRevision ||
      binding.eventTimestampMs < policy.effectiveAtMs ||
      Date.now() >= binding.eventTimestampMs + binding.windowSeconds * 1000 ||
      binding.eventTimestampMs > Date.now() + 60_000
    ) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_policy_changed');
    }
    if (binding.hasPhotos && binding.version === 1) {
      const photo = await this.photoPolicy.resolveEffectivePolicy({
        chatId,
        preset: 'SAME_IMAGE',
        scope: 'SAME_AUTHOR',
      });
      if (
        !photo.enforce ||
        !photo.allowedMatchKinds.includes('canonical_sha256') ||
        photo.controlRevision !== binding.photoControlRevision
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_photo_policy_changed');
      }
    }
  }

  private async loadSettings(chatId: string, binding: MessageDuplicateBinding) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      include: { chat: { select: { entityType: true, admins: { select: { userId: true } } } } },
    });
    if (
      !settings?.antiDuplicateEnabled ||
      settings.chat.entityType !== 'CHAT' ||
      messageDuplicateSettingsDigest(settings) !== binding.settingsDigest ||
      Math.max(
        resolveDuplicateFlowConfig(settings).allowedCount + 2,
        (binding.sanction?.threshold ?? 0) + 1,
      ) !== binding.requiredCount
    ) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_settings_changed');
    }
    if (binding.sanction) {
      const decision = resolveDuplicateFlowOutcome({
        settings,
        repeatCount: binding.sanction.repeatCount,
        hash: binding.fingerprint,
        fingerprintType: 'exact',
      }).decision;
      if (
        messageDuplicateSanctionSettingsDigest(settings) !== binding.sanction.settingsDigest ||
        decision?.action !== binding.sanction.action ||
        decision.threshold !== binding.sanction.threshold
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_sanction_settings_changed');
      }
    }
    if (settings.chat.admins.some((admin) => admin.userId === binding.senderId)) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    }
    const release = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId: binding.senderId,
        ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
        createdAt: { gte: new Date(Date.now() - binding.windowSeconds * 1000) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (release) throw new MessageDuplicateGuardRejectedError('message_duplicate_manual_release');
    return settings;
  }
}
