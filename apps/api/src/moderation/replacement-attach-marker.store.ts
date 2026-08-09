import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../prisma/prisma.service';
import { MAX_SEND_AMBIGUOUS_ERROR_PREFIX } from '../max/max-send-ambiguity.util';
import {
  CHANNEL_DIALOG_AUTO_ATTACH_ACTION,
  CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION,
  CHAT_DIALOG_AUTO_ATTACH_ACTION,
} from './moderation.service.support';

export type ReplacementAttachMarkerStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'SKIPPED';

export const CHANNEL_AUTO_POST_ATTACH_STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  SKIPPED: 'SKIPPED',
} as const satisfies Record<string, ReplacementAttachMarkerStatus>;

export const CHAT_AUTO_COMMENT_ATTACH_STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  SKIPPED: 'SKIPPED',
} as const satisfies Record<string, ReplacementAttachMarkerStatus>;

export type ReplacementAttachMarkerClaim =
  | { status: 'claimed'; lockToken: string }
  | { status: 'done' | 'in_progress' };

export type LegacyChannelEditRecoveryCandidate = {
  chatId: string;
  messageId: string;
  evidence: 'marker' | 'audit';
  evidenceId: string;
  evidenceAt: Date;
};

export type LegacyChannelEditRecoveryAuditCursor = {
  createdAt: Date;
  id: string;
};

export type LegacyChannelEditRecoveryCandidatePage = {
  candidates: LegacyChannelEditRecoveryCandidate[];
  nextAuditCursor: LegacyChannelEditRecoveryAuditCursor | null;
  auditScanExhausted: boolean;
};

type MarkerKind = 'channel_auto_post' | 'chat_auto_comment';

type CompletionState = 'none' | 'done' | 'recover_legacy_channel_edit';

type MarkerRow = {
  status: ReplacementAttachMarkerStatus;
  lockedAt: Date | null;
  deliveryMode: string | null;
  replacementMessageId: string | null;
  replyMessageId: string | null;
  replacementSendStartedAt: Date | null;
  lastError: string | null;
};

type MarkerDelegate = {
  findUnique?: (args: unknown) => Promise<MarkerRow | null>;
  findMany?: (args: unknown) => Promise<Array<Record<string, unknown>>>;
  create?: (args: unknown) => Promise<unknown>;
  createMany?: (args: unknown) => Promise<{ count: number }>;
  updateMany?: (args: unknown) => Promise<{ count: number }>;
};

type MarkerPrisma = {
  channelAutoPostAttachMarker?: MarkerDelegate;
  chatAutoCommentAttachMarker?: MarkerDelegate;
};

const ATTACH_LOCK_TTL_MS = 2 * 60_000;
const CHANNEL_EDIT_RECOVERY_VERSION = 'channel-engagement-edit-recovery:v1';
const CHANNEL_EDIT_RECOVERY_ERROR_PREFIX = `[${CHANNEL_EDIT_RECOVERY_VERSION}]`;
const CHANNEL_EDIT_RECOVERY_LOCK_PREFIX = `${CHANNEL_EDIT_RECOVERY_VERSION}:`;
const CHANNEL_DIALOG_PUBLISH_ACTION = 'PUBLISH_CHANNEL_ENGAGEMENT';
const CHANNEL_EDIT_RECOVERY_DEFAULT_LIMIT = 25;
const CHANNEL_EDIT_RECOVERY_MAX_LIMIT = 100;
const CHANNEL_EDIT_RECOVERY_DEFAULT_LOOKBACK_MS = 72 * 60 * 60_000;
const CHANNEL_EDIT_RECOVERY_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const CHANNEL_EDIT_RECOVERY_DEFAULT_MINIMUM_AGE_MS = 5 * 60_000;

export class ReplacementAttachMarkerStore {
  constructor(private readonly prisma: PrismaService) {}

  claimChannelAutoPost(params: {
    chatId: string;
    messageId: string;
    source: 'webhook' | 'poll';
    botId: string | null;
    linkType: string | null;
    hasEngagementButtons: boolean;
  }): Promise<ReplacementAttachMarkerClaim> {
    return this.claim('channel_auto_post', params);
  }

  claimChatAutoComment(params: {
    chatId: string;
    messageId: string;
    source: 'webhook';
    botId: string | null;
  }): Promise<ReplacementAttachMarkerClaim> {
    return this.claim('chat_auto_comment', params);
  }

  async listLegacyChannelEditRecoveryCandidates(
    params: {
      now?: Date;
      limit?: number;
      lookbackMs?: number;
      minimumAgeMs?: number;
      auditCursor?: LegacyChannelEditRecoveryAuditCursor | null;
    } = {},
  ): Promise<LegacyChannelEditRecoveryCandidatePage> {
    const delegate = this.getDelegate('channel_auto_post');
    if (!delegate?.findMany || (!delegate.create && !delegate.createMany) || !delegate.updateMany) {
      return {
        candidates: [],
        nextAuditCursor: params.auditCursor ?? null,
        auditScanExhausted: true,
      };
    }

    const now = this.resolveRecoveryNow(params.now);
    const limit = this.clampInteger(
      params.limit,
      CHANNEL_EDIT_RECOVERY_DEFAULT_LIMIT,
      1,
      CHANNEL_EDIT_RECOVERY_MAX_LIMIT,
    );
    const lookbackMs = this.clampInteger(
      params.lookbackMs,
      CHANNEL_EDIT_RECOVERY_DEFAULT_LOOKBACK_MS,
      1,
      CHANNEL_EDIT_RECOVERY_MAX_LOOKBACK_MS,
    );
    const minimumAgeMs = this.clampInteger(
      params.minimumAgeMs,
      CHANNEL_EDIT_RECOVERY_DEFAULT_MINIMUM_AGE_MS,
      0,
      Math.max(0, lookbackMs - 1),
    );
    const windowStart = new Date(now.getTime() - lookbackMs);
    const windowEnd = new Date(now.getTime() - minimumAgeMs);
    const staleLockBefore = new Date(now.getTime() - ATTACH_LOCK_TTL_MS);
    const enabledChannelFilter = {
      chat: {
        channelSettings: {
          is: {
            OR: [{ commentsEnabled: true }, { postSuggestionsEnabled: true }],
          },
        },
      },
    };
    const markerDelegate = this.prisma.channelAutoPostAttachMarker;

    const markerRows = await markerDelegate.findMany({
      where: {
        deliveryMode: 'edit_message',
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        createdAt: { gte: windowStart, lte: windowEnd },
        AND: [
          {
            OR: [{ linkType: null }, { linkType: { not: 'forward' } }],
          },
          {
            OR: [
              {
                status: 'SKIPPED',
                OR: [
                  { lastError: null },
                  {
                    lastError: { not: { startsWith: CHANNEL_EDIT_RECOVERY_ERROR_PREFIX } },
                  },
                ],
              },
              {
                status: 'IN_PROGRESS',
                lastError: { startsWith: CHANNEL_EDIT_RECOVERY_ERROR_PREFIX },
                OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
              },
            ],
          },
          {
            OR: [
              { lastError: null },
              { lastError: { not: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX } } },
            ],
          },
        ],
        ...enabledChannelFilter,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        chatId: true,
        messageId: true,
        createdAt: true,
      },
    });
    const markerCandidates = markerRows.flatMap((row) => {
      const candidate = this.readMarkerRecoveryCandidate(row);
      return candidate ? [candidate] : [];
    });
    const successfulMarkerKeys = new Set<string>();
    if (markerCandidates.length > 0) {
      const successfulRows = await this.prisma.auditLog.findMany({
        where: {
          action: { in: [CHANNEL_DIALOG_AUTO_ATTACH_ACTION, CHANNEL_DIALOG_PUBLISH_ACTION] },
          createdAt: { gte: windowStart, lte: now },
          OR: markerCandidates.map((candidate) => ({
            chatId: candidate.chatId,
            payload: { path: ['messageId'], equals: candidate.messageId },
          })),
        },
        select: { chatId: true, payload: true },
      });
      for (const row of successfulRows) {
        const key = this.readAuditMessageKey(row.chatId, row.payload);
        if (key) {
          successfulMarkerKeys.add(key);
        }
      }
    }
    const candidates = markerCandidates.filter(
      (candidate) => !successfulMarkerKeys.has(`${candidate.chatId}\u0000${candidate.messageId}`),
    );
    if (candidates.length >= limit) {
      return {
        candidates: candidates.slice(0, limit),
        nextAuditCursor: params.auditCursor ?? null,
        auditScanExhausted: false,
      };
    }

    const remainingCapacity = limit - candidates.length;
    const auditCursor = this.normalizeAuditCursor(params.auditCursor, windowStart, windowEnd);
    const auditRows = await this.prisma.auditLog.findMany({
      where: {
        action: CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION,
        createdAt: { gte: windowStart, lte: windowEnd },
        payload: { path: ['deliveryMode'], equals: 'edit_message' },
        ...(auditCursor
          ? {
              OR: [
                { createdAt: { gt: auditCursor.createdAt } },
                { createdAt: auditCursor.createdAt, id: { gt: auditCursor.id } },
              ],
            }
          : {}),
        ...enabledChannelFilter,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: remainingCapacity,
      select: {
        id: true,
        chatId: true,
        payload: true,
        createdAt: true,
      },
    });
    const nextAuditCursor = auditRows.length
      ? {
          createdAt: auditRows[auditRows.length - 1]!.createdAt,
          id: auditRows[auditRows.length - 1]!.id,
        }
      : auditCursor;
    const auditCandidates = auditRows.flatMap((row) => {
      const candidate = this.readAuditRecoveryCandidate(row);
      return candidate ? [candidate] : [];
    });
    const existingMarkerKeys = new Set<string>();
    if (auditCandidates.length > 0) {
      const existingMarkers = await markerDelegate.findMany({
        where: {
          OR: auditCandidates.map((candidate) => ({
            chatId: candidate.chatId,
            messageId: candidate.messageId,
          })),
        },
        select: { chatId: true, messageId: true },
      });
      for (const row of existingMarkers) {
        const chatId = this.readNonEmptyString(row.chatId);
        const messageId = this.readNonEmptyString(row.messageId);
        if (chatId && messageId) {
          existingMarkerKeys.add(`${chatId}\u0000${messageId}`);
        }
      }
    }
    const markerCandidateKeys = new Set(
      candidates.map((candidate) => `${candidate.chatId}\u0000${candidate.messageId}`),
    );
    for (const candidate of auditCandidates) {
      const key = `${candidate.chatId}\u0000${candidate.messageId}`;
      if (!existingMarkerKeys.has(key) && !markerCandidateKeys.has(key)) {
        candidates.push(candidate);
        markerCandidateKeys.add(key);
        if (candidates.length >= limit) {
          break;
        }
      }
    }

    return {
      candidates,
      nextAuditCursor,
      auditScanExhausted: auditRows.length < remainingCapacity,
    };
  }

  completeChannelAutoPost(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    status: 'SUCCEEDED' | 'SKIPPED';
    source: 'webhook' | 'poll';
    botId: string | null;
    linkType: string | null;
    deliveryMode: string | null;
    replacementMessageId?: string | null;
    replyMessageId?: string | null;
    publishedUrl?: string | null;
    originalDeleted?: boolean;
    terminalEditAttemptExhausted?: boolean;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    return this.complete('channel_auto_post', params);
  }

  completeChatAutoComment(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    status: 'SUCCEEDED' | 'SKIPPED';
    source: 'webhook';
    botId: string | null;
    deliveryMode: string | null;
    replacementMessageId?: string | null;
    replyMessageId?: string | null;
    publishedUrl?: string | null;
    originalDeleted: boolean;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    return this.complete('chat_auto_comment', params);
  }

  recordChannelReplacementMessage(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replacementMessageId: string;
    publishedUrl: string | null;
  }): Promise<void> {
    return this.recordReplacementMessage('channel_auto_post', params);
  }

  recordChatReplacementMessage(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replacementMessageId: string;
    publishedUrl: string | null;
  }): Promise<void> {
    return this.recordReplacementMessage('chat_auto_comment', params);
  }

  recordChatReplyMessage(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replyMessageId: string;
  }): Promise<void> {
    return this.recordChatReplyResult(params);
  }

  recordChannelReplyMessage(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replyMessageId: string;
    publishedUrl: string | null;
  }): Promise<void> {
    return this.recordChannelReplyResult(params);
  }

  recordChannelReplacementSendStarted(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
  }): Promise<void> {
    return this.recordReplacementSendStarted('channel_auto_post', params);
  }

  recordChatReplacementSendStarted(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
  }): Promise<void> {
    return this.recordReplacementSendStarted('chat_auto_comment', params);
  }

  recordChatReplySendStarted(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
  }): Promise<void> {
    // FLAG: Keep replies on this durable fence so stale recovery and Safety Desk see every send.
    return this.recordSendStarted('chat_auto_comment', params, 'reply_message');
  }

  recordChannelReplySendStarted(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
  }): Promise<void> {
    return this.recordSendStarted('channel_auto_post', params, 'reply_message');
  }

  releaseChannelAutoPost(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    source: 'webhook' | 'poll';
    botId: string | null;
    linkType: string | null;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    return this.release('channel_auto_post', params);
  }

  releaseChatAutoComment(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    source: 'webhook';
    botId: string | null;
    lastError: string | null;
    lastStatusCode: number | null;
  }): Promise<void> {
    return this.release('chat_auto_comment', params);
  }

  private async claim(
    kind: MarkerKind,
    params: {
      chatId: string;
      messageId: string;
      source: 'webhook' | 'poll';
      botId: string | null;
      linkType?: string | null;
      hasEngagementButtons?: boolean;
    },
  ): Promise<ReplacementAttachMarkerClaim> {
    const delegate = this.getDelegate(kind);
    const canPersistRecovery = Boolean(
      delegate?.findUnique && (delegate.create || delegate.createMany) && delegate.updateMany,
    );
    const allowLegacyChannelEditRecovery =
      kind === 'channel_auto_post' &&
      params.hasEngagementButtons === true &&
      params.linkType !== 'forward' &&
      canPersistRecovery;
    const completionState = await this.resolveCompletionState(
      kind,
      params.chatId,
      params.messageId,
      allowLegacyChannelEditRecovery,
    );
    if (completionState === 'done') {
      return { status: 'done' };
    }

    const now = new Date();
    if (
      !delegate?.findUnique ||
      (!delegate.create && !delegate.createMany) ||
      !delegate.updateMany
    ) {
      return { status: 'claimed', lockToken: this.createLockToken(false) };
    }

    const existing = await delegate.findUnique({
      where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
      select: {
        status: true,
        lockedAt: true,
        deliveryMode: true,
        replacementMessageId: true,
        replyMessageId: true,
        replacementSendStartedAt: true,
        lastError: true,
      },
    });
    if (existing?.status === 'SUCCEEDED') {
      return { status: 'done' };
    }
    if (existing?.status === 'SKIPPED') {
      if (!allowLegacyChannelEditRecovery || !this.isRecoverableLegacyChannelEditMarker(existing)) {
        return { status: 'done' };
      }

      const lockToken = this.createLockToken(true);
      const claimed = await delegate.updateMany({
        where: {
          chatId: params.chatId,
          messageId: params.messageId,
          status: 'SKIPPED',
          deliveryMode: 'edit_message',
          replacementMessageId: null,
          replyMessageId: null,
          replacementSendStartedAt: null,
          lastError: existing.lastError,
        },
        data: {
          status: 'IN_PROGRESS',
          lockToken,
          lockedAt: now,
          source: params.source,
          botId: params.botId,
          linkType: params.linkType ?? null,
          lastError: this.withChannelEditRecoveryEvidence(existing.lastError),
        },
      });
      return claimed.count > 0 ? { status: 'claimed', lockToken } : { status: 'in_progress' };
    }
    if (
      existing?.replacementMessageId ||
      existing?.replyMessageId ||
      existing?.replacementSendStartedAt
    ) {
      return { status: 'in_progress' };
    }

    const recoveryClaim =
      completionState === 'recover_legacy_channel_edit' ||
      this.hasChannelEditRecoveryEvidence(existing?.lastError);
    const lockToken = this.createLockToken(recoveryClaim);
    if (!existing) {
      const createData = {
        chatId: params.chatId,
        messageId: params.messageId,
        status: 'IN_PROGRESS',
        lockToken,
        lockedAt: now,
        source: params.source,
        botId: params.botId,
        ...(kind === 'channel_auto_post' ? { linkType: params.linkType ?? null } : {}),
        ...(recoveryClaim
          ? {
              deliveryMode: 'edit_message',
              lastError: this.withChannelEditRecoveryEvidence(null),
            }
          : {}),
      };
      if (delegate.createMany) {
        const created = await delegate.createMany({ data: [createData], skipDuplicates: true });
        if (created.count > 0) {
          return { status: 'claimed', lockToken };
        }
      } else if (delegate.create) {
        try {
          await delegate.create({ data: createData });
          return { status: 'claimed', lockToken };
        } catch (error: unknown) {
          if (!this.isPrismaKnownError(error, 'P2002')) {
            throw error;
          }
        }
      }
    }

    const claimed = await delegate.updateMany({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        status: 'IN_PROGRESS',
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - ATTACH_LOCK_TTL_MS) } }],
      },
      data: {
        lockToken,
        lockedAt: now,
        source: params.source,
        botId: params.botId,
        ...(kind === 'channel_auto_post' ? { linkType: params.linkType ?? null } : {}),
        ...(recoveryClaim
          ? { lastError: this.withChannelEditRecoveryEvidence(existing?.lastError) }
          : {}),
      },
    });
    return claimed.count > 0 ? { status: 'claimed', lockToken } : { status: 'in_progress' };
  }

  private async resolveCompletionState(
    kind: MarkerKind,
    chatId: string,
    messageId: string,
    allowLegacyChannelEditRecovery: boolean,
  ): Promise<CompletionState> {
    const marker = await this.getDelegate(kind)?.findUnique?.({
      where: { chatId_messageId: { chatId, messageId } },
      select: {
        status: true,
        lockedAt: true,
        deliveryMode: true,
        replacementMessageId: true,
        replyMessageId: true,
        replacementSendStartedAt: true,
        lastError: true,
      },
    });
    if (marker?.status === 'SUCCEEDED') {
      return 'done';
    }
    const recoverableMarker =
      marker?.status === 'SKIPPED' &&
      allowLegacyChannelEditRecovery &&
      this.isRecoverableLegacyChannelEditMarker(marker);
    if (marker?.status === 'SKIPPED') {
      if (!recoverableMarker) {
        return 'done';
      }
    }

    const successfullyAttached = await this.prisma.auditLog.findFirst({
      where: {
        chatId,
        action:
          kind === 'channel_auto_post'
            ? {
                in: [CHANNEL_DIALOG_AUTO_ATTACH_ACTION, CHANNEL_DIALOG_PUBLISH_ACTION],
              }
            : CHAT_DIALOG_AUTO_ATTACH_ACTION,
        payload: { path: ['messageId'], equals: messageId },
      },
      select: { id: true },
    });
    if (successfullyAttached) {
      return 'done';
    }
    if (recoverableMarker) {
      return 'recover_legacy_channel_edit';
    }
    if (kind !== 'channel_auto_post') {
      return 'none';
    }

    const skippedAttach = await this.prisma.auditLog.findFirst({
      where: {
        chatId,
        action: CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION,
        payload: { path: ['messageId'], equals: messageId },
      },
      select: { id: true, payload: true },
    });
    if (!skippedAttach) {
      return 'none';
    }
    if (
      allowLegacyChannelEditRecovery &&
      this.isRecoverableLegacyChannelEditAudit(skippedAttach.payload)
    ) {
      return 'recover_legacy_channel_edit';
    }
    return 'done';
  }

  private async complete(
    kind: MarkerKind,
    params: {
      chatId: string;
      messageId: string;
      lockToken: string;
      status: 'SUCCEEDED' | 'SKIPPED';
      source: 'webhook' | 'poll';
      botId: string | null;
      linkType?: string | null;
      deliveryMode: string | null;
      replacementMessageId?: string | null;
      replyMessageId?: string | null;
      publishedUrl?: string | null;
      originalDeleted?: boolean;
      terminalEditAttemptExhausted?: boolean;
      lastError: string | null;
      lastStatusCode: number | null;
    },
  ): Promise<void> {
    const preserveAmbiguousSendFence =
      !params.replacementMessageId &&
      !params.replyMessageId &&
      params.lastError?.startsWith(MAX_SEND_AMBIGUOUS_ERROR_PREFIX) === true;
    const channelEditRecoveryExhausted =
      kind === 'channel_auto_post' &&
      params.status === 'SKIPPED' &&
      params.deliveryMode === 'edit_message' &&
      (params.terminalEditAttemptExhausted === true ||
        this.isChannelEditRecoveryLock(params.lockToken));
    await this.getDelegate(kind)?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
      },
      data: {
        status: params.status,
        lockToken: null,
        lockedAt: null,
        source: params.source,
        botId: params.botId,
        ...(kind === 'channel_auto_post' ? { linkType: params.linkType ?? null } : {}),
        deliveryMode: params.deliveryMode,
        replacementMessageId: params.replacementMessageId ?? null,
        replyMessageId: params.replyMessageId ?? null,
        ...(!preserveAmbiguousSendFence ? { replacementSendStartedAt: null } : {}),
        publishedUrl: params.publishedUrl ?? null,
        ...(params.originalDeleted ? { originalDeleted: true } : {}),
        lastError: channelEditRecoveryExhausted
          ? this.withChannelEditRecoveryEvidence(params.lastError)
          : params.lastError,
        lastStatusCode: params.lastStatusCode,
      },
    });
  }

  private async recordReplacementMessage(
    kind: MarkerKind,
    params: {
      chatId: string;
      messageId: string;
      lockToken: string;
      replacementMessageId: string;
      publishedUrl: string | null;
    },
  ): Promise<void> {
    const updated = await this.getDelegate(kind)?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
      },
      data: {
        deliveryMode: 'replace_with_bot_message',
        replacementMessageId: params.replacementMessageId,
        publishedUrl: params.publishedUrl,
      },
    });
    if (updated && updated.count !== 1) {
      throw new Error(`Failed to persist the ${this.label(kind)} replacement message marker`);
    }
  }

  private async recordReplacementSendStarted(
    kind: MarkerKind,
    params: { chatId: string; messageId: string; lockToken: string },
  ): Promise<void> {
    return this.recordSendStarted(kind, params, 'replace_with_bot_message');
  }

  private async recordSendStarted(
    kind: MarkerKind,
    params: { chatId: string; messageId: string; lockToken: string },
    deliveryMode: 'replace_with_bot_message' | 'reply_message',
  ): Promise<void> {
    const updated = await this.getDelegate(kind)?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
        replacementMessageId: null,
        replacementSendStartedAt: null,
      },
      data: {
        deliveryMode,
        replacementSendStartedAt: new Date(),
      },
    });
    if (updated && updated.count !== 1) {
      const sendKind = deliveryMode === 'reply_message' ? 'reply' : 'replacement';
      throw new Error(`Failed to persist the ${this.label(kind)} ${sendKind} send fence`);
    }
  }

  private async recordChatReplyResult(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replyMessageId: string;
  }): Promise<void> {
    const updated = await this.getDelegate('chat_auto_comment')?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
      },
      data: {
        deliveryMode: 'reply_message',
        replyMessageId: params.replyMessageId,
        replacementSendStartedAt: null,
      },
    });
    if (updated && updated.count !== 1) {
      throw new Error('Failed to persist the chat auto-comment reply message marker');
    }
  }

  private async recordChannelReplyResult(params: {
    chatId: string;
    messageId: string;
    lockToken: string;
    replyMessageId: string;
    publishedUrl: string | null;
  }): Promise<void> {
    const updated = await this.getDelegate('channel_auto_post')?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
      },
      data: {
        deliveryMode: 'reply_message',
        replyMessageId: params.replyMessageId,
        publishedUrl: params.publishedUrl,
        replacementSendStartedAt: null,
      },
    });
    if (updated && updated.count !== 1) {
      throw new Error('Failed to persist the channel auto-post reply message marker');
    }
  }

  private async release(
    kind: MarkerKind,
    params: {
      chatId: string;
      messageId: string;
      lockToken: string;
      source: 'webhook' | 'poll';
      botId: string | null;
      linkType?: string | null;
      lastError: string | null;
      lastStatusCode: number | null;
    },
  ): Promise<void> {
    await this.getDelegate(kind)?.updateMany?.({
      where: {
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: params.lockToken,
        status: 'IN_PROGRESS',
      },
      data: {
        ...(kind === 'channel_auto_post' && this.isChannelEditRecoveryLock(params.lockToken)
          ? { status: 'SKIPPED', deliveryMode: 'edit_message' }
          : {}),
        lockToken: null,
        lockedAt: null,
        replacementSendStartedAt: null,
        source: params.source,
        botId: params.botId,
        ...(kind === 'channel_auto_post' ? { linkType: params.linkType ?? null } : {}),
        lastError: params.lastError,
        lastStatusCode: params.lastStatusCode,
      },
    });
  }

  private getDelegate(kind: MarkerKind): MarkerDelegate | null {
    const prisma = this.prisma as unknown as MarkerPrisma;
    return (
      (kind === 'channel_auto_post'
        ? prisma.channelAutoPostAttachMarker
        : prisma.chatAutoCommentAttachMarker) ?? null
    );
  }

  private label(kind: MarkerKind): string {
    return kind === 'channel_auto_post' ? 'channel auto-post' : 'chat auto-comment';
  }

  private readMarkerRecoveryCandidate(row: {
    id: unknown;
    chatId: unknown;
    messageId: unknown;
    createdAt: unknown;
  }): LegacyChannelEditRecoveryCandidate | null {
    const evidenceId = this.readNonEmptyString(row.id);
    const chatId = this.readNonEmptyString(row.chatId);
    const messageId = this.readNonEmptyString(row.messageId);
    if (!evidenceId || !chatId || !messageId || !(row.createdAt instanceof Date)) {
      return null;
    }
    return {
      chatId,
      messageId,
      evidence: 'marker',
      evidenceId,
      evidenceAt: row.createdAt,
    };
  }

  private readAuditRecoveryCandidate(row: {
    id: string;
    chatId: string;
    payload: unknown;
    createdAt: Date;
  }): LegacyChannelEditRecoveryCandidate | null {
    if (!this.isRecoverableLegacyChannelEditAudit(row.payload)) {
      return null;
    }
    const payload = row.payload as Record<string, unknown>;
    const evidenceId = this.readNonEmptyString(row.id);
    const chatId = this.readNonEmptyString(row.chatId);
    const messageId = this.readNonEmptyString(payload.messageId);
    if (!evidenceId || !chatId || !messageId || !(row.createdAt instanceof Date)) {
      return null;
    }
    return {
      chatId,
      messageId,
      evidence: 'audit',
      evidenceId,
      evidenceAt: row.createdAt,
    };
  }

  private readAuditMessageKey(chatIdValue: unknown, payload: unknown): string | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const chatId = this.readNonEmptyString(chatIdValue);
    const messageId = this.readNonEmptyString((payload as Record<string, unknown>).messageId);
    return chatId && messageId ? `${chatId}\u0000${messageId}` : null;
  }

  private normalizeAuditCursor(
    cursor: LegacyChannelEditRecoveryAuditCursor | null | undefined,
    windowStart: Date,
    windowEnd: Date,
  ): LegacyChannelEditRecoveryAuditCursor | null {
    if (
      !cursor ||
      !(cursor.createdAt instanceof Date) ||
      !Number.isFinite(cursor.createdAt.getTime()) ||
      !cursor.id.trim() ||
      cursor.createdAt < windowStart ||
      cursor.createdAt > windowEnd
    ) {
      return null;
    }
    return { createdAt: cursor.createdAt, id: cursor.id.trim() };
  }

  private resolveRecoveryNow(value: Date | undefined): Date {
    const now = value ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('Legacy channel edit recovery requires a valid current time.');
    }
    return now;
  }

  private clampInteger(
    value: number | undefined,
    defaultValue: number,
    minimum: number,
    maximum: number,
  ): number {
    const candidate = value === undefined || !Number.isFinite(value) ? defaultValue : value;
    return Math.min(maximum, Math.max(minimum, Math.floor(candidate)));
  }

  private readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private isRecoverableLegacyChannelEditMarker(marker: MarkerRow): boolean {
    return (
      marker.status === 'SKIPPED' &&
      marker.deliveryMode === 'edit_message' &&
      !marker.replacementMessageId &&
      !marker.replyMessageId &&
      !marker.replacementSendStartedAt &&
      !this.hasChannelEditRecoveryEvidence(marker.lastError) &&
      !marker.lastError?.startsWith(MAX_SEND_AMBIGUOUS_ERROR_PREFIX)
    );
  }

  private isRecoverableLegacyChannelEditAudit(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return false;
    }
    const record = payload as Record<string, unknown>;
    return (
      record.deliveryMode === 'edit_message' &&
      record.linkType !== 'forward' &&
      record.terminalEditAttemptExhausted !== true &&
      !this.readNonEmptyString(record.error)?.startsWith(MAX_SEND_AMBIGUOUS_ERROR_PREFIX)
    );
  }

  private createLockToken(channelEditRecovery: boolean): string {
    const token = randomUUID();
    return channelEditRecovery ? `${CHANNEL_EDIT_RECOVERY_LOCK_PREFIX}${token}` : token;
  }

  private isChannelEditRecoveryLock(lockToken: string): boolean {
    return lockToken.startsWith(CHANNEL_EDIT_RECOVERY_LOCK_PREFIX);
  }

  private hasChannelEditRecoveryEvidence(lastError: string | null | undefined): boolean {
    return lastError?.startsWith(CHANNEL_EDIT_RECOVERY_ERROR_PREFIX) === true;
  }

  private withChannelEditRecoveryEvidence(lastError: string | null | undefined): string {
    if (this.hasChannelEditRecoveryEvidence(lastError)) {
      return lastError as string;
    }
    return lastError
      ? `${CHANNEL_EDIT_RECOVERY_ERROR_PREFIX} ${lastError}`
      : `${CHANNEL_EDIT_RECOVERY_ERROR_PREFIX} Legacy skipped edit selected for repair.`;
  }

  private isPrismaKnownError(error: unknown, code: string): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      String((error as { code?: unknown }).code) === code,
    );
  }
}
