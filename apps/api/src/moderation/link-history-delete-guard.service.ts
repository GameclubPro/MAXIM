import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  LINK_BLOCKED_DELETE_RULE_CODE,
  LINK_HISTORY_RECOVERY_RULE_CODE,
  LINK_HISTORY_RECOVERY_SOURCE_TAG,
  createMessageContentFingerprint,
  deriveLinkPolicySemanticEffectiveAt,
  filterActionableNavigationTargets,
  isLinkHistoryPolicyViolation,
  parseLinkHistoryListedMessage,
} from './link-history-recovery.util';
import {
  extractEnabledNavigationTargets,
  resolveEnabledNavigationTargetOptions,
  type EnabledNavigationTargetOptions,
} from './navigation/enabled-navigation-targets';
import { adaptMaxMessageNavigationView } from './navigation/max-navigation-view.adapter';

export type LinkHistoryDeleteGuardResult = 'absent' | 'allowed' | 'not_applicable';

type RecoveryReasonMetadata = {
  contentFingerprint: string;
  policyRevision: number;
  policyEffectiveAt: Date;
};

type LiveReasonMetadata = {
  linkPolicyRevision: number;
  linkPolicyEffectiveAt: Date;
};

export class LinkHistoryDeleteGuardRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LinkHistoryDeleteGuardRejectedError';
  }
}

@Injectable()
export class LinkHistoryDeleteGuardService {
  private readonly deleteEnabled: boolean;
  private readonly extractionOptions: EnabledNavigationTargetOptions;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    configService: ConfigService,
  ) {
    this.deleteEnabled = this.readBoolean(
      configService.get('MODERATION_LINK_HISTORY_DELETE_ENABLED'),
      false,
    );
    this.extractionOptions = resolveEnabledNavigationTargetOptions(configService);
  }

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId: string;
  }): Promise<LinkHistoryDeleteGuardResult> {
    const reasonRows = await this.prisma.moderationDeleteIntentReason.findMany({
      where: {
        intentId: params.intentId,
        ruleCode: { in: [LINK_BLOCKED_DELETE_RULE_CODE, LINK_HISTORY_RECOVERY_RULE_CODE] },
      },
      select: { ruleCode: true, metadata: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (reasonRows.length === 0) {
      return 'not_applicable';
    }
    const liveReasonRows = reasonRows.filter(
      (row) => row.ruleCode === LINK_BLOCKED_DELETE_RULE_CODE,
    );
    const usesLiveSemantics = liveReasonRows.length > 0;
    if (!usesLiveSemantics && !this.deleteEnabled) {
      throw new LinkHistoryDeleteGuardRejectedError(
        'history_delete_disabled',
        'Link history recovery deletion is disabled',
      );
    }

    const recoveryReasons = reasonRows
      .filter((row) => row.ruleCode === LINK_HISTORY_RECOVERY_RULE_CODE)
      .map((row) => this.parseReasonMetadata(row.metadata))
      .filter((reason): reason is RecoveryReasonMetadata => reason !== null);
    const liveReasons = liveReasonRows
      .map((row) => this.parseLiveReasonMetadata(row.metadata))
      .filter((reason): reason is LiveReasonMetadata => reason !== null);
    if (usesLiveSemantics ? liveReasons.length === 0 : recoveryReasons.length === 0) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics ? 'live_reason_invalid' : 'history_reason_invalid',
        'Link deletion intent has no valid policy fence',
      );
    }

    if (!params.subjectUserId) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics ? 'live_message_identity_changed' : 'history_message_identity_changed',
        'Link deletion intent no longer identifies the message author',
      );
    }
    if (this.maxBotLinkService.isKnownBotUserId(params.subjectUserId)) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics ? 'live_runtime_bot_immune' : 'history_runtime_bot_immune',
        'Runtime bot messages are immune from link deletion',
      );
    }

    const now = new Date();
    const [settings, allowlistRows, expiredAllowlist] = await this.prisma.$transaction(
      [
        this.prisma.chatSettings.findUnique({
          where: { chatId: params.chatId },
          select: {
            linkPolicy: true,
            linkPolicyRevision: true,
            linkPolicyEffectiveAt: true,
            chat: {
              select: {
                admins: { select: { userId: true } },
              },
            },
          },
        }),
        this.prisma.domainAllowlist.findMany({
          where: {
            chatId: params.chatId,
            OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: now } }],
          },
          select: { domain: true },
        }),
        this.prisma.domainAllowlist.aggregate({
          where: {
            chatId: params.chatId,
            removeAfterAt: { lte: now },
          },
          _max: { removeAfterAt: true },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const policyEffectiveAt = settings
      ? deriveLinkPolicySemanticEffectiveAt(
          settings.linkPolicy,
          settings.linkPolicyEffectiveAt,
          expiredAllowlist._max.removeAfterAt,
        )
      : null;
    if (
      !settings ||
      settings.linkPolicy === 'ALERT_ONLY' ||
      (usesLiveSemantics ? !settings.linkPolicyEffectiveAt : !policyEffectiveAt)
    ) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics ? 'live_policy_inactive' : 'history_policy_inactive',
        'Strict link policy is no longer active',
      );
    }
    const matchingRecoveryReasons = recoveryReasons.filter(
      (reason) =>
        reason.policyRevision === settings.linkPolicyRevision &&
        reason.policyEffectiveAt.getTime() === policyEffectiveAt?.getTime(),
    );
    const matchingLiveReasons = liveReasons.filter(
      (reason) =>
        reason.linkPolicyRevision === settings.linkPolicyRevision &&
        settings.linkPolicyEffectiveAt !== null &&
        reason.linkPolicyEffectiveAt.getTime() === settings.linkPolicyEffectiveAt.getTime(),
    );
    if (
      usesLiveSemantics ? matchingLiveReasons.length === 0 : matchingRecoveryReasons.length === 0
    ) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics ? 'live_policy_revision_changed' : 'history_policy_revision_changed',
        'Link policy changed after the deletion candidate was recorded',
      );
    }

    if (settings.chat.admins.some((admin) => admin.userId === params.subjectUserId)) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics ? 'live_admin_immune' : 'history_admin_immune',
        'Current chat administrators are immune from link deletion',
      );
    }
    const remoteAccess = await this.maxClient.getChatMemberAccess(
      params.chatId,
      params.subjectUserId,
      {
        trafficClass: 'critical',
        sourceTag: usesLiveSemantics
          ? MAX_API_SOURCE_TAGS.MODERATION_DELETE
          : LINK_HISTORY_RECOVERY_SOURCE_TAG,
        botId: params.botId,
        bypassCache: true,
      },
    );
    if (!remoteAccess) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics ? 'live_author_access_unknown' : 'history_author_access_unknown',
        'MAX did not confirm the current access level of the message author',
      );
    }
    if (
      (remoteAccess.userId && String(remoteAccess.userId) !== params.subjectUserId) ||
      remoteAccess.isAdmin ||
      remoteAccess.isOwner
    ) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics ? 'live_admin_immune' : 'history_admin_immune',
        'MAX reports a different author identity or current administrator access',
      );
    }

    const exactRow = await this.maxClient.getExactMessageRow(params.chatId, params.messageId, {
      trafficClass: 'critical',
      sourceTag: usesLiveSemantics
        ? MAX_API_SOURCE_TAGS.MODERATION_DELETE
        : LINK_HISTORY_RECOVERY_SOURCE_TAG,
      botId: params.botId,
      bypassCache: true,
    });
    if (!exactRow) {
      return 'absent';
    }

    const metadata = parseLinkHistoryListedMessage(exactRow);
    if (
      !metadata ||
      metadata.messageId !== params.messageId ||
      !metadata.senderId ||
      metadata.senderId !== params.subjectUserId
    ) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics ? 'live_message_identity_changed' : 'history_message_identity_changed',
        'Exact message identity or author no longer matches the link deletion intent',
      );
    }
    if (
      !usesLiveSemantics &&
      policyEffectiveAt &&
      metadata.timestampMs < policyEffectiveAt.getTime()
    ) {
      throw new LinkHistoryDeleteGuardRejectedError(
        'history_policy_revision_changed',
        'Message predates the current link policy baseline',
      );
    }

    const view = adaptMaxMessageNavigationView(exactRow);
    const fingerprint = createMessageContentFingerprint(view);
    if (
      !usesLiveSemantics &&
      !matchingRecoveryReasons.some((reason) => reason.contentFingerprint === fingerprint)
    ) {
      throw new LinkHistoryDeleteGuardRejectedError(
        'history_content_changed',
        'Message content changed after the recovery candidate was recorded',
      );
    }

    const targets = filterActionableNavigationTargets(
      extractEnabledNavigationTargets(view, this.extractionOptions),
    );
    if (
      !isLinkHistoryPolicyViolation(
        settings.linkPolicy,
        allowlistRows.map((row) => row.domain),
        targets,
      )
    ) {
      throw new LinkHistoryDeleteGuardRejectedError(
        usesLiveSemantics
          ? 'live_violation_no_longer_present'
          : 'history_violation_no_longer_present',
        'Exact message content no longer violates the current link policy',
      );
    }
    return 'allowed';
  }

  private parseReasonMetadata(value: unknown): RecoveryReasonMetadata | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const row = value as Record<string, unknown>;
    const fingerprint =
      typeof row.contentFingerprint === 'string' ? row.contentFingerprint.trim().toLowerCase() : '';
    const revision = Number(row.policyRevision);
    const effectiveAt =
      typeof row.policyEffectiveAt === 'string' || row.policyEffectiveAt instanceof Date
        ? new Date(row.policyEffectiveAt)
        : null;
    if (
      !/^[a-f0-9]{64}$/u.test(fingerprint) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !effectiveAt ||
      !Number.isFinite(effectiveAt.getTime())
    ) {
      return null;
    }
    return {
      contentFingerprint: fingerprint,
      policyRevision: revision,
      policyEffectiveAt: effectiveAt,
    };
  }

  private parseLiveReasonMetadata(value: unknown): LiveReasonMetadata | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const row = value as Record<string, unknown>;
    const revision = row.linkPolicyRevision;
    const effectiveAt =
      typeof row.linkPolicyEffectiveAt === 'string' || row.linkPolicyEffectiveAt instanceof Date
        ? new Date(row.linkPolicyEffectiveAt)
        : null;
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !effectiveAt ||
      !Number.isFinite(effectiveAt.getTime())
    ) {
      return null;
    }
    return {
      linkPolicyRevision: revision,
      linkPolicyEffectiveAt: effectiveAt,
    };
  }

  private readBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }
    return fallback;
  }
}
