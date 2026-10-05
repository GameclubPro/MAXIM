import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
import { ModerationSanctionStateFenceService } from './moderation-sanction-state-fence.service';
import { resolveModerationSanctionExpiry } from './moderation-sanction-expiry.util';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { fingerprintModerationSettings } from './message-limits-delete-guard.service';

export const MODERATION_STATE_DELETE_RULES = new Set([
  'MUTE_ACTIVE_DELETE',
  'GLOBAL_SPAMMER_MESSAGE_DELETE',
  'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE',
  'BOT_ACCOUNT_MESSAGE_DELETE',
  'INVITATION_ACCESS_DELETE',
]);
export class ModerationStateDeleteRejectedError extends Error {
  readonly code = 'moderation_state_delete_no_longer_authorized';
}
type Reason = { ruleCode: string; reasonKey: string; metadata: unknown };

@Injectable()
export class ModerationStateDeleteGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly fence: ModerationSanctionStateFenceService,
    private readonly globalPolicy: GlobalSpammerIntelligenceService,
    private readonly config: ConfigService,
  ) {}

  async authorize(params: {
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId?: string;
    reasons: readonly Reason[];
    allowAbsentWithOwnedReceipt?: boolean;
    sourceMessageAt?: Date | null;
    beforeFinalAuthority?: () => Promise<void>;
  }): Promise<
    | 'not_applicable'
    | 'absent'
    | {
        reasonKeys: string[];
        deadlineAtMs: number;
        reasonDeadlines: { reasonKey: string; deadlineAtMs: number }[];
      }
  > {
    const reasons = params.reasons.filter((r) => MODERATION_STATE_DELETE_RULES.has(r.ruleCode));
    if (!reasons.length) return 'not_applicable';
    const userId = params.subjectUserId;
    if (!userId || this.bots.isKnownBotUserId(userId)) this.reject();
    const load = async () => {
      const settings = await this.prisma.chatSettings.findUnique({
        where: { chatId: params.chatId },
        include: { chat: { select: { entityType: true, admins: { select: { userId: true } } } } },
      });
      if (
        !settings ||
        settings.chat.entityType !== 'CHAT' ||
        settings.chat.admins.some((a) => a.userId === userId)
      )
        this.reject();
      return settings;
    };
    const settings = await load();
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
      throw new Error('State deletion author access unavailable');
    const row = await this.max.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row && !params.allowAbsentWithOwnedReceipt) return 'absent';
    if (!row) {
      const current = await load();
      if (
        !current.removeBotsFromGroupEnabled ||
        reasons.length !== 1 ||
        reasons.some((r) => r.ruleCode !== 'BOT_ACCOUNT_MESSAGE_DELETE')
      )
        this.reject();
      // FLAG: Absent-source follow-up uses two unique probes and the requested reason's
      // original source identity. Retained history or another reason cannot lend authority.
      const intent = await this.prisma.moderationDeleteIntent.findUnique({
        where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
        select: { id: true, status: true, subjectUserId: true, sourceMessageAt: true },
      });
      if (
        !intent ||
        intent.status !== 'SUCCEEDED' ||
        intent.subjectUserId !== userId ||
        !params.sourceMessageAt ||
        intent.sourceMessageAt?.getTime() !== params.sourceMessageAt.getTime()
      )
        this.reject();
      const reasonKey = reasons[0]!.reasonKey;
      const receipt = await this.prisma.moderationDeleteIntentReason.findUnique({
        where: { intentId_reasonKey: { intentId: intent.id, reasonKey } },
        select: { ruleCode: true, userId: true, metadata: true },
      });
      const metadata = this.metadata(receipt?.metadata);
      if (
        !receipt ||
        receipt.ruleCode !== 'BOT_ACCOUNT_MESSAGE_DELETE' ||
        (receipt.userId !== null && receipt.userId !== userId) ||
        metadata.moderationDeleteVerified !== true ||
        metadata.botAccountAuthorVerified !== true ||
        this.bots.isKnownBotUserId(userId)
      )
        this.reject();
      if (
        (await this.immunity.consumeForMessage({
          chatId: params.chatId,
          userId,
          messageId: params.messageId,
          scope: 'moderation-state-delete:v1',
          nightModeTimezone: current.nightModeTimezone,
        })) === 'granted'
      )
        this.reject();
      await params.beforeFinalAuthority?.();
      if (!(await load()).removeBotsFromGroupEnabled) this.reject();
      const deadlineAtMs = (params.sourceMessageAt?.getTime() ?? NaN) + 5 * 60_000;
      if (
        !Number.isSafeInteger(deadlineAtMs) ||
        params.sourceMessageAt!.getTime() <= 0 ||
        params.sourceMessageAt!.getTime() > Date.now() ||
        Date.now() >= deadlineAtMs
      )
        this.reject();
      return {
        reasonKeys: [reasonKey],
        deadlineAtMs,
        reasonDeadlines: [{ reasonKey, deadlineAtMs }],
      };
    }
    const message = this.parser.parse({
      type: 'message_created',
      updateId: 'moderation-state-delete-guard',
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
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'moderation-state-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    const current = await load();
    const sourceAtMs = params.sourceMessageAt?.getTime() ?? Date.parse(message.createdAt);
    const sourceDeadlineAtMs = sourceAtMs + 5 * 60_000;
    if (
      !Number.isSafeInteger(sourceAtMs) ||
      sourceAtMs <= 0 ||
      sourceAtMs > Date.now() ||
      Date.now() >= sourceDeadlineAtMs
    )
      this.reject();
    const reasonDeadlines: { reasonKey: string; deadlineAtMs: number }[] = [];
    for (const reason of reasons) {
      let allowed = false;
      let deadlineAtMs = sourceDeadlineAtMs;
      if (reason.ruleCode === 'MUTE_ACTIVE_DELETE') {
        const metadata = this.metadata(reason.metadata);
        const latest = await this.prisma.moderationEvent.findFirst({
          where: {
            chatId: params.chatId,
            userId,
            OR: [
              { action: { in: ['MUTE', 'BAN'] } },
              { ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] } },
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, action: true, createdAt: true, metadata: true },
        });
        if (
          latest &&
          latest.id === metadata.muteEventId &&
          (latest.action === 'MUTE' || latest.action === 'BAN') &&
          sourceAtMs >= latest.createdAt.getTime()
        ) {
          const expiry = resolveModerationSanctionExpiry(
            latest.action,
            latest.metadata,
            latest.createdAt,
            current.muteDurationHours,
          );
          allowed =
            (latest.action === 'MUTE' && expiry.permanent) ||
            !!(expiry.expiresAt && expiry.expiresAt.getTime() > Date.now());
          if (expiry.expiresAt) deadlineAtMs = Math.min(deadlineAtMs, expiry.expiresAt.getTime());
          if (
            allowed &&
            (await this.fence.isSanctionEventInvalidated({
              chatId: params.chatId,
              userId,
              sanctionEventId: latest.id,
              eventCreatedAt: latest.createdAt,
            }))
          )
            allowed = false;
        }
      } else if (reason.ruleCode === 'BOT_ACCOUNT_MESSAGE_DELETE') {
        const sender = this.metadata(this.metadata(row).sender);
        allowed =
          current.removeBotsFromGroupEnabled &&
          sender.is_bot === true &&
          !this.bots.isKnownBotUserId(userId);
      } else if (
        current.deleteSpammersEnabled &&
        (reason.ruleCode === 'GLOBAL_SPAMMER_MESSAGE_DELETE' ||
          reason.ruleCode === 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE')
      ) {
        const decisions = await this.prisma.adminGlobalSpammerExemption.findMany({
          where: {
            adminUserId: { in: current.chat.admins.flatMap((a) => this.variants(a.userId)) },
            userId: { in: this.variants(userId) },
          },
          select: { decision: true },
          take: 129,
        });
        if (decisions.length > 128) throw new Error('Spammer admin decision limit exceeded');
        const localBlock = decisions.some((d) => d.decision === 'BLOCK');
        const localAllow = decisions.some((d) => d.decision !== 'BLOCK');
        if (reason.ruleCode === 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE') allowed = localBlock;
        else if (!localBlock && !localAllow) {
          // FLAG: Bypass cached profile authority. Fresh policy/expiry/suppression reads are
          // shared with detection; a registry row alone cannot authorize this deletion.
          const policy = await this.globalPolicy.evaluatePolicy({
            chatId: params.chatId,
            userId,
            messageId: params.messageId,
            trigger: 'delete-final-guard',
            deleteSpammersEnabled: true,
            recordDecision: false,
            skipRuntimeProfileWrite: true,
            lookupContext: { now: new Date() },
          });
          const expiresAtMs = policy.expiresAt ? Date.parse(policy.expiresAt) : NaN;
          allowed =
            policy.action === 'DELETE_AND_KICK' &&
            Number.isFinite(expiresAtMs) &&
            expiresAtMs > Date.now();
          deadlineAtMs = Math.min(deadlineAtMs, expiresAtMs);
        }
      }
      // FLAG: Invitation access is retired. Historical pending reasons cannot revive it.
      if (allowed) reasonDeadlines.push({ reasonKey: reason.reasonKey, deadlineAtMs });
    }
    await params.beforeFinalAuthority?.();
    if (fingerprintModerationSettings(await load()) !== fingerprintModerationSettings(current))
      this.reject();
    const currentReasons = reasonDeadlines.filter((r) => Date.now() < r.deadlineAtMs);
    if (!currentReasons.length) this.reject();
    return {
      reasonKeys: currentReasons.map((r) => r.reasonKey),
      deadlineAtMs: Math.max(...currentReasons.map((r) => r.deadlineAtMs)),
      reasonDeadlines: currentReasons,
    };
  }

  async assertSpammerMemberAllowed(params: {
    chatId: string;
    userId: string;
    messageId: string;
    botId?: string;
    localBlock: boolean;
    beforeFinalAuthority?: () => Promise<void>;
  }): Promise<void> {
    if (this.bots.isKnownBotUserId(params.userId)) this.reject();
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: params.chatId },
      include: { chat: { select: { entityType: true, admins: { select: { userId: true } } } } },
    });
    if (
      !settings ||
      settings.chat.entityType !== 'CHAT' ||
      !settings.deleteSpammersEnabled ||
      settings.chat.admins.some((a) => a.userId === params.userId)
    )
      this.reject();
    const access = await this.max.getChatMemberAccess(params.chatId, params.userId, {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
    });
    if (!access || access.isAdmin === true || access.isOwner === true) this.reject();
    if (access.userId !== params.userId || access.isAdmin !== false || access.isOwner !== false)
      throw new Error('Spammer member access unavailable');
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        scope: 'moderation-state-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    const decisions = await this.prisma.adminGlobalSpammerExemption.findMany({
      where: {
        adminUserId: { in: settings.chat.admins.flatMap((a) => this.variants(a.userId)) },
        userId: { in: this.variants(params.userId) },
      },
      select: { decision: true },
      take: 129,
    });
    if (decisions.length > 128) throw new Error('Spammer admin decision limit exceeded');
    let policyDeadlineAtMs = Number.POSITIVE_INFINITY;
    const block = decisions.some((d) => d.decision === 'BLOCK');
    if (params.localBlock) {
      if (!block) this.reject();
    } else {
      if (decisions.length) this.reject();
      const policy = await this.globalPolicy.evaluatePolicy({
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        trigger: 'member-final-guard',
        deleteSpammersEnabled: true,
        recordDecision: false,
        skipRuntimeProfileWrite: true,
        lookupContext: { now: new Date() },
      });
      policyDeadlineAtMs = policy.expiresAt ? Date.parse(policy.expiresAt) : NaN;
      if (policy.action !== 'DELETE_AND_KICK' || !Number.isFinite(policyDeadlineAtMs))
        this.reject();
    }
    // FLAG: The selected executor is rechecked after external author/policy work and
    // before the final settings and synchronous expiry permit; no later await is allowed.
    await params.beforeFinalAuthority?.();
    const final = await this.prisma.chatSettings.findUnique({ where: { chatId: params.chatId } });
    if (
      Date.now() >= policyDeadlineAtMs ||
      !final ||
      fingerprintModerationSettings(final) !== fingerprintModerationSettings(settings)
    )
      this.reject();
  }

  private variants(value: string): string[] {
    const normalized = value.trim().toLowerCase();
    return [normalized, normalized.startsWith('id') ? normalized.slice(2) : `id${normalized}`];
  }

  private metadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  private reject(): never {
    throw new ModerationStateDeleteRejectedError();
  }
}
