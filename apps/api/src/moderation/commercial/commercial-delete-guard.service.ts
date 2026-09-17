import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { CommercialAdDetector } from './commercial-ad.detector';
import { isCommercialMessageDeleteEligible } from './commercial-action-policy';
import {
  COMMERCIAL_TEXT_DELETE_RULE_CODE,
  fingerprintCommercialDeleteText,
  isCommercialTextDeleteBindingCurrent,
  readCommercialTextDeleteBinding,
  fingerprintCommercialDeleteReasons,
  type CommercialDeleteSettings,
} from './commercial-delete-binding';

export class CommercialDeleteGuardRejectedError extends Error {
  reasonFingerprint?: string;
  constructor(
    readonly code:
      | 'commercial_text_settings_disabled'
      | 'commercial_text_author_immune'
      | 'commercial_text_message_changed'
      | 'commercial_text_binding_invalid'
      | 'commercial_text_binding_stale'
      | 'commercial_text_violation_no_longer_present',
  ) {
    super('Commercial message deletion is no longer authorized');
    this.name = 'CommercialDeleteGuardRejectedError';
  }
}

type GuardInput = {
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  botId?: string;
};
type DecisionEvidence = { reasonKey: string; score: number; metadata: unknown };
type CommercialGuardProof = 'absent' | { kind: 'allowed'; reasonKeys: string[] };
export const COMMERCIAL_TEXT_MAX_INTENT_REASONS = 64;

@Injectable()
export class CommercialDeleteGuardService {
  private readonly parser = new WebhookParser();
  private readonly detector = new CommercialAdDetector();
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLink: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
  ) {}

  async assertIntentStillActionable(
    params: GuardInput & { intentId: string },
  ): Promise<CommercialGuardProof | 'not_applicable' | 'missing_reason'> {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, reasonKey: true, score: true, metadata: true },
      orderBy: { reasonKey: 'asc' },
      take: COMMERCIAL_TEXT_MAX_INTENT_REASONS + 1,
    });
    if (!reasons.length) return 'missing_reason';
    // FLAG: Other durable reasons retain their own guards, but never prove commercial sanctions.
    if (reasons.some((reason) => reason.ruleCode !== COMMERCIAL_TEXT_DELETE_RULE_CODE))
      return 'not_applicable';
    if (
      reasons.length > COMMERCIAL_TEXT_MAX_INTENT_REASONS &&
      (await this.prisma.moderationDeleteIntentReason.findFirst({
        where: { intentId: params.intentId, ruleCode: { not: COMMERCIAL_TEXT_DELETE_RULE_CODE } },
        select: { id: true },
      }))
    )
      return 'not_applicable';
    try {
      if (reasons.length > COMMERCIAL_TEXT_MAX_INTENT_REASONS)
        throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
      return await this.verifyMessage({ ...params, evidence: reasons });
    } catch (error) {
      if (error instanceof CommercialDeleteGuardRejectedError)
        error.reasonFingerprint = fingerprintCommercialDeleteReasons(reasons);
      throw error;
    }
  }

  async assertMessageStillActionable(
    params: GuardInput & { evidence: readonly DecisionEvidence[] },
  ): Promise<'allowed' | 'absent'> {
    const result = await this.verifyMessage(params);
    return result === 'absent' ? result : 'allowed';
  }

  private async verifyMessage(
    params: GuardInput & { evidence: readonly DecisionEvidence[] },
  ): Promise<CommercialGuardProof> {
    const userId = params.subjectUserId;
    if (!userId) throw new CommercialDeleteGuardRejectedError('commercial_text_message_changed');
    if (this.maxBotLink.isKnownBotUserId(userId))
      throw new CommercialDeleteGuardRejectedError('commercial_text_author_immune');
    const settings = await this.loadSettings(params.chatId, userId);
    const evidence = this.resolveEvidence(params.evidence, settings);
    const options = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000,
    };
    const access = await this.maxClient.getChatMemberAccess(params.chatId, userId, options);
    // FLAG: A verified departure is not immunity for an extant ad. Transport/malformed lookup
    // failures throw; only an actual absent member may proceed to the exact-message check.
    if (access && access.userId !== null && access.userId !== userId)
      throw new Error('Commercial author access could not be verified');
    if (access?.isAdmin || access?.isOwner)
      throw new CommercialDeleteGuardRejectedError('commercial_text_author_immune');

    // FLAG: Read exactly one current message per dispatch attempt; never store or log its text.
    const row = await this.maxClient.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row) return 'absent';
    let message;
    try {
      message = this.parser.parse({
        type: 'message_created',
        updateId: 'commercial-delete-guard',
        message: row,
      }).message;
    } catch {
      throw new Error('Current commercial message could not be verified');
    }
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== userId ||
      message.entityType === 'channel'
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_message_changed');
    if (
      evidence.binding &&
      evidence.binding.sourceSha256 !== fingerprintCommercialDeleteText(message.text)
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_message_changed');
    this.assertDetection(message.text, settings, evidence);
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'commercial-text-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_author_immune');
    const finalSettings = await this.loadSettings(params.chatId, userId);
    const finalEvidence = this.resolveEvidence(params.evidence, finalSettings);
    this.assertDetection(message.text, finalSettings, finalEvidence);
    return { kind: 'allowed', reasonKeys: finalEvidence.reasonKeys };
  }

  private resolveEvidence(
    reasons: readonly DecisionEvidence[],
    settings: CommercialDeleteSettings,
  ) {
    if (
      !reasons.length ||
      reasons.some(
        (reason) => !Number.isFinite(reason.score) || reason.score < 0 || reason.score > 1,
      )
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
    const bindings = reasons.map((reason) => {
      const metadata =
        reason.metadata && typeof reason.metadata === 'object' && !Array.isArray(reason.metadata)
          ? (reason.metadata as Record<string, unknown>)
          : {};
      if (metadata.messageDisposition !== undefined && metadata.messageDisposition !== 'DELETE')
        throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
      if (metadata.commercialTextBinding === undefined) return null;
      const binding = readCommercialTextDeleteBinding(metadata.commercialTextBinding);
      if (!binding) throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
      return binding;
    });
    const bound = bindings.filter((binding) => binding !== null);
    const latestAt = Math.max(...bound.map((binding) => binding.eventTimestampMs));
    const selected = reasons.filter((_, index) =>
      bound.length ? bindings[index]?.eventTimestampMs === latestAt : true,
    );
    const currentBindings = bound.filter((binding) => binding.eventTimestampMs === latestAt);
    if (
      currentBindings.some((binding) => binding.sourceSha256 !== currentBindings[0]!.sourceSha256)
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
    if (currentBindings.some((binding) => !isCommercialTextDeleteBindingCurrent(binding, settings)))
      throw new CommercialDeleteGuardRejectedError('commercial_text_binding_stale');
    // FLAG: Legacy decisions may be rechecked, but cannot lend unbound historical campaign evidence.
    return {
      minimumScore: Math.max(...selected.map((reason) => reason.score)),
      binding: currentBindings[0] ?? null,
      reasonKeys: selected.map((reason) => reason.reasonKey),
      campaignContext: currentBindings.every(
        (binding) =>
          JSON.stringify(binding.campaignContext) ===
          JSON.stringify(currentBindings[0]!.campaignContext),
      )
        ? (currentBindings[0]?.campaignContext ?? null)
        : null,
    };
  }

  private assertDetection(
    text: string,
    settings: CommercialDeleteSettings,
    evidence: ReturnType<CommercialDeleteGuardService['resolveEvidence']>,
  ) {
    const detection = this.detector.detect({
      normalizedText: '',
      rawLoweredText: text.toLowerCase(),
      settings: settings as import('../../prisma/prisma-client').ChatSettings,
      commercialCampaignContext: evidence.campaignContext,
    });
    if (
      !detection ||
      detection.confidenceScore / 100 < evidence.minimumScore ||
      !isCommercialMessageDeleteEligible(
        detection.actionBand ?? null,
        detection.actionable === true,
        detection.messageDisposition,
      )
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_violation_no_longer_present');
  }

  private async loadSettings(chatId: string, userId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: true,
        commercialAdsWarnThreshold: true,
        commercialAdsDeleteThreshold: true,
        nightModeTimezone: true,
        chat: { select: { entityType: true, admins: { select: { userId: true } } } },
        textFiltersWarnEnabled: true,
        textFiltersMuteEnabled: true,
        textFiltersBanEnabled: true,
        textFiltersMuteDurationHours: true,
        textFiltersBotMessageEnabled: true,
      },
    });
    if (!settings?.commercialAdsFilterEnabled || settings.chat.entityType !== 'CHAT')
      throw new CommercialDeleteGuardRejectedError('commercial_text_settings_disabled');
    if (settings.chat.admins.some((admin) => admin.userId === userId))
      throw new CommercialDeleteGuardRejectedError('commercial_text_author_immune');
    return settings;
  }
}
