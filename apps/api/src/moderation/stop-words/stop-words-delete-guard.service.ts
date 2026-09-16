import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import {
  extractEnabledWebhookNavigationTargets,
  resolveEnabledNavigationTargetOptions,
} from '../navigation/enabled-navigation-targets';
import { createAllowlistLinkMatcher } from '../rule-engine-link-detector';
import {
  detectStopWordsViolations,
  extractStopWordsTextSegments,
  fingerprintStopWordsSource,
} from './stop-words.detection';
import { migrateStopWordsPolicy, readStopWordsPolicy } from './stop-words.policy';

export const STOP_WORDS_DELETE_RULE_CODES = new Set([
  'MESSAGE_BLOCKED_WORD_DELETE',
  'MESSAGE_BLOCKED_DOMAIN_DELETE',
]);
type GuardReason = { ruleCode: string; metadata: unknown };
type GuardInput = {
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  botId?: string;
};
export class StopWordsDeleteGuardRejectedError extends Error {
  readonly code = 'stop_words_delete_no_longer_authorized';
}

@Injectable()
export class StopWordsDeleteGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLink: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
  ) {}

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId?: string;
  }): Promise<'allowed' | 'absent' | 'not_applicable'> {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, metadata: true },
    });
    // FLAG: This guard owns stop-list-only intents. Independently owned durable reasons keep
    // their existing dispatch guards and must not be cancelled by disabling the stop-list.
    if (
      !reasons.length ||
      reasons.some((reason) => !STOP_WORDS_DELETE_RULE_CODES.has(reason.ruleCode))
    )
      return 'not_applicable';
    return this.assertMessageStillActionable(params, reasons);
  }

  async assertSanctionStillActionable(
    params: GuardInput & {
      ruleCode: string;
      metadata: unknown;
      action: 'WARN' | 'MUTE' | 'BAN';
    },
  ): Promise<void> {
    // FLAG: The compatibility release leaves pre-policy sanctions on the existing execution
    // path until activation. A present but invalid policy must never take this legacy branch.
    const current = await this.prisma.chatSettings.findUnique({
      where: { chatId: params.chatId }, select: { stopWordsPolicy: true },
    });
    if (current?.stopWordsPolicy === null) return;
    const result = await this.assertMessageStillActionable(
      params,
      [{ ruleCode: params.ruleCode + '_DELETE', metadata: params.metadata }],
      params.action,
    );
    if (result !== 'allowed') this.reject();
  }

  private async assertMessageStillActionable(
    params: GuardInput,
    reasons: readonly GuardReason[],
    action?: 'WARN' | 'MUTE' | 'BAN',
  ): Promise<'allowed' | 'absent'> {
    const senderId = params.subjectUserId;
    if (!senderId || this.maxBotLink.isKnownBotUserId(senderId)) this.reject();
    const settings = await this.load(params.chatId, senderId);
    if (action) this.assertSanctionPolicy(settings, reasons[0], action);
    const options = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
    };
    const access = await this.maxClient.getChatMemberAccess(params.chatId, senderId, options);
    if (!access || access.isAdmin || access.isOwner) this.reject();
    if (access.userId !== null && access.userId !== senderId)
      throw new Error('Stop-list author access unavailable');
    const row = await this.maxClient.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row) {
      if (!action) return 'absent';
      // FLAG: A missing message alone cannot authorize a member sanction. Require our own
      // successful guarded deletion of exactly the same rule, revision and source fingerprint.
      const metadata = this.metadata(reasons[0]?.metadata);
      if (
        typeof metadata.stopWordsSourceSha256 !== 'string' ||
        metadata.stopWordsPolicyVersion !== 1
      )
        this.reject();
      const completed = await this.prisma.moderationDeleteIntent.findFirst({
        where: {
          chatId: params.chatId,
          messageId: params.messageId,
          subjectUserId: senderId,
          status: 'SUCCEEDED',
          reasons: {
            some: {
              ruleCode: reasons[0].ruleCode,
              AND: [
                {
                  metadata: {
                    path: ['stopWordsSourceSha256'],
                    equals: metadata.stopWordsSourceSha256,
                  },
                },
                {
                  metadata: { path: ['stopWordsRuleId'], equals: String(metadata.stopWordsRuleId) },
                },
                {
                  metadata: {
                    path: ['stopWordsRevision'],
                    equals: Number(metadata.stopWordsRevision),
                  },
                },
              ],
            },
          },
        },
        select: { id: true },
      });
      if (!completed) this.reject();
      await this.assertNoImmunity(params, senderId, settings.nightModeTimezone);
      this.assertSanctionPolicy(await this.load(params.chatId, senderId), reasons[0], action);
      return 'allowed';
    }
    const raw = { type: 'message_created', updateId: 'stop-words-delete-guard', message: row };
    const message = this.parser.parse(raw).message;
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== senderId ||
      message.entityType === 'channel'
    )
      this.reject();
    const targets = extractEnabledWebhookNavigationTargets(
      raw,
      resolveEnabledNavigationTargetOptions(this.config),
    );
    const textSegments = extractStopWordsTextSegments(raw, message.text);
    const sourceFingerprint = fingerprintStopWordsSource({
      text: message.text,
      textSegments,
      navigationTargets: targets,
    });
    const stillMatches = (current: typeof settings) => {
      const policy = readStopWordsPolicy(current) ?? migrateStopWordsPolicy(current);
      const hits = detectStopWordsViolations({
        text: message.text,
        textSegments,
        navigationTargets: targets,
        settings: { ...current, stopWordsPolicy: policy },
        isLinkAllowlisted: createAllowlistLinkMatcher(
          current.chat.domains.map((entry) => entry.domain),
        ),
      });
      return reasons.some((reason) => {
        const metadata = this.metadata(reason.metadata);
        return hits.some(
          (hit) =>
            `${hit.ruleCode}_DELETE` === reason.ruleCode &&
            (metadata.stopWordsSourceSha256 === undefined ||
              metadata.stopWordsSourceSha256 === sourceFingerprint) &&
            (metadata.stopWordsRuleId === undefined ||
              metadata.stopWordsRuleId === hit.metadata?.stopWordsRuleId) &&
            (metadata.stopWordsRevision === undefined ||
              metadata.stopWordsRevision === current.stopWordsRevision),
        );
      });
    };
    if (!stillMatches(settings)) this.reject();
    await this.assertNoImmunity(params, senderId, settings.nightModeTimezone);
    const finalSettings = await this.load(params.chatId, senderId);
    if (!stillMatches(finalSettings)) this.reject();
    if (action) this.assertSanctionPolicy(finalSettings, reasons[0], action);
    return 'allowed';
  }

  private async load(chatId: string, senderId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        chatId: true,
        stopWordsPolicy: true,
        stopWordsRevision: true,
        nightModeTimezone: true,
        messageLimitsBlockedWords: true,
        messageLimitsBlockedDomains: true,
        chat: {
          select: {
            entityType: true,
            admins: { select: { userId: true } },
            domains: {
              where: { OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }] },
              select: { domain: true },
            },
          },
        },
      },
    });
    if (
      !settings ||
      settings.chat.entityType !== 'CHAT' ||
      settings.chat.admins.some((admin) => admin.userId === senderId)
    )
      this.reject();
    const policy = readStopWordsPolicy(settings);
    if (policy && !policy.enabled) this.reject();
    return settings;
  }

  private reject(): never {
    throw new StopWordsDeleteGuardRejectedError('Stop-list deletion is no longer authorized');
  }

  private async assertNoImmunity(
    params: GuardInput,
    senderId: string,
    nightModeTimezone: string,
  ): Promise<void> {
    const result = await this.immunity.consumeForMessage({
      chatId: params.chatId,
      userId: senderId,
      messageId: params.messageId,
      scope: 'stop-words-delete:v1',
      nightModeTimezone,
    });
    if (result === 'granted') this.reject();
  }

  private metadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private assertSanctionPolicy(
    settings: Awaited<ReturnType<StopWordsDeleteGuardService['load']>>,
    reason: GuardReason,
    action: 'WARN' | 'MUTE' | 'BAN',
  ): void {
    const policy = readStopWordsPolicy(settings);
    const metadata = this.metadata(reason.metadata);
    if (!policy || !policy.enabled || metadata.stopWordsRevision !== settings.stopWordsRevision)
      this.reject();
    const key =
      action === 'WARN' ? 'warnEnabled' : action === 'MUTE' ? 'muteEnabled' : 'banEnabled';
    if (!policy.sanctions[key]) this.reject();
  }
}
