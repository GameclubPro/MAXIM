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
  | { status: 'claimed'; lockToken: string; markerId?: string }
  | {
      status: 'recover_audit';
      markerId: string;
      replyMessageId: string;
      botId: string | null;
    }
  | { status: 'done' | 'in_progress' | 'recovered_audit' };

export type LegacyChannelEditRecoveryCandidate = {
  chatId: string;
  messageId: string;
  evidence: 'marker' | 'predispatch_marker' | 'audit';
  evidenceId: string;
  evidenceAt: Date;
};

export type LegacyChannelEditRecoveryAuditCursor = {
  createdAt: Date;
  id: string;
};

export type LegacyChannelEditRecoveryMarkerCursor = LegacyChannelEditRecoveryAuditCursor;

export type LegacyChannelEditRecoveryCandidatePage = {
  candidates: LegacyChannelEditRecoveryCandidate[];
  nextMarkerCursor: LegacyChannelEditRecoveryMarkerCursor | null;
  markerScanExhausted: boolean;
  nextAuditCursor: LegacyChannelEditRecoveryAuditCursor | null;
  auditScanExhausted: boolean;
};

type MarkerKind = 'channel_auto_post' | 'chat_auto_comment';

type CompletionState = 'none' | 'done' | 'recover_legacy_channel_edit';

type MarkerRow = {
  id: string;
  status: ReplacementAttachMarkerStatus;
  lockedAt: Date | null;
  botId: string | null;
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
const CHAT_AUTO_COMMENT_MARKER_ID_PREFIX = 'ccr1_';
const CHAT_AUTO_COMMENT_AUDIT_ID_PREFIX = 'aca1_';
const CHAT_AUTO_COMMENT_MARKER_ID_PATTERN = /^ccr1_[a-f0-9]{32}$/u;
const CHANNEL_EDIT_RECOVERY_VERSION = 'channel-engagement-edit-recovery:v1';
const CHANNEL_EDIT_RECOVERY_ERROR_PREFIX = `[${CHANNEL_EDIT_RECOVERY_VERSION}]`;
const CHANNEL_EDIT_RECOVERY_LOCK_PREFIX = `${CHANNEL_EDIT_RECOVERY_VERSION}:`;
const CHANNEL_DIALOG_PUBLISH_ACTION = 'PUBLISH_CHANNEL_ENGAGEMENT';
const CHANNEL_EDIT_RECOVERY_DEFAULT_LIMIT = 25;
const CHANNEL_EDIT_RECOVERY_MAX_LIMIT = 100;
const CHANNEL_EDIT_RECOVERY_DEFAULT_LOOKBACK_MS = 72 * 60 * 60_000;
const CHANNEL_EDIT_RECOVERY_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const CHANNEL_EDIT_RECOVERY_DEFAULT_MINIMUM_AGE_MS = 5 * 60_000;
const CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_PREFIX = '[channel-auto-post:pre-dispatch:v1]';
const CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_CODES = [
  'MAX_API_CIRCUIT_OPEN',
  'MAX_API_INTERNAL_RATE_LIMIT',
] as const;
const CHANNEL_AUTO_POST_PRE_DISPATCH_PROOF_CONSUMED =
  '[channel-auto-post:pre-dispatch-proof-consumed:v1] Recovery claim acquired; a stale outcome requires verification.';
const CHANNEL_AUTO_POST_UNVERIFIED_FAILURE_PREFIX = '[channel-auto-post:unverified-failure:v1]';
const LEGACY_MAX_API_CIRCUIT_OPEN_ERROR = 'MAX API circuit breaker is open';

export function persistChannelAutoPostPreDispatchFailureEvidence(
  error: unknown,
  summary: string,
): string {
  const code = readProvenMaxPreDispatchFailureCode(error);
  if (!code) {
    return hasPersistedChannelAutoPostPreDispatchEvidence(summary)
      ? `${CHANNEL_AUTO_POST_UNVERIFIED_FAILURE_PREFIX} ${summary}`
      : summary;
  }
  return `${CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_PREFIX}[${code}] ${summary}`;
}

function hasPersistedChannelAutoPostPreDispatchEvidence(
  lastError: string | null | undefined,
): boolean {
  if (lastError === LEGACY_MAX_API_CIRCUIT_OPEN_ERROR) {
    return true;
  }
  return CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_CODES.some((code) =>
    lastError?.startsWith(`${CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_PREFIX}[${code}]`),
  );
}

function readProvenMaxPreDispatchFailureCode(
  error: unknown,
): (typeof CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_CODES)[number] | null {
  if (
    !error ||
    typeof error !== 'object' ||
    (error as { preDispatch?: unknown }).preDispatch !== true
  ) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' &&
    CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_CODES.includes(
      code as (typeof CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_CODES)[number],
    )
    ? (code as (typeof CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_CODES)[number])
    : null;
}

export function buildChatAutoCommentAuditId(markerId: string): string | null {
  const normalized = markerId.trim().toLowerCase();
  if (!CHAT_AUTO_COMMENT_MARKER_ID_PATTERN.test(normalized)) {
    return null;
  }

  return `${CHAT_AUTO_COMMENT_AUDIT_ID_PREFIX}${normalized.slice(
    CHAT_AUTO_COMMENT_MARKER_ID_PREFIX.length,
  )}`;
}

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

  probeChatAutoCommentAuditRecovery(params: {
    chatId: string;
    messageId: string;
  }): Promise<ReplacementAttachMarkerClaim | null> {
    return this.resolveChatAutoCommentAuditRecovery(
      this.getDelegate('chat_auto_comment'),
      params.chatId,
      params.messageId,
    );
  }

  async listLegacyChannelEditRecoveryCandidates(
    params: {
      now?: Date;
      limit?: number;
      lookbackMs?: number;
      minimumAgeMs?: number;
      markerCursor?: LegacyChannelEditRecoveryMarkerCursor | null;
      auditCursor?: LegacyChannelEditRecoveryAuditCursor | null;
    } = {},
  ): Promise<LegacyChannelEditRecoveryCandidatePage> {
    const delegate = this.getDelegate('channel_auto_post');
    if (!delegate?.findMany || (!delegate.create && !delegate.createMany) || !delegate.updateMany) {
      return {
        candidates: [],
        nextMarkerCursor: params.markerCursor ?? null,
        markerScanExhausted: true,
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
    const markerCursor = this.normalizeAuditCursor(params.markerCursor, windowStart, windowEnd);

    const markerRows = await markerDelegate.findMany({
      where: {
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        createdAt: { gte: windowStart },
        ...(markerCursor
          ? {
              OR: [
                { createdAt: { gt: markerCursor.createdAt } },
                { createdAt: markerCursor.createdAt, id: { gt: markerCursor.id } },
              ],
            }
          : {}),
        AND: [
          {
            OR: [{ linkType: null }, { linkType: { not: 'forward' } }],
          },
          {
            OR: [
              {
                status: 'SKIPPED',
                deliveryMode: 'edit_message',
                createdAt: { lte: windowEnd },
                OR: [
                  { lastError: null },
                  {
                    lastError: { not: { startsWith: CHANNEL_EDIT_RECOVERY_ERROR_PREFIX } },
                  },
                ],
              },
              {
                status: 'IN_PROGRESS',
                deliveryMode: null,
                lockedAt: null,
                updatedAt: { lte: windowEnd },
                OR: [
                  { lastError: LEGACY_MAX_API_CIRCUIT_OPEN_ERROR },
                  ...CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_CODES.map((code) => ({
                    lastError: {
                      startsWith: `${CHANNEL_AUTO_POST_PRE_DISPATCH_FAILURE_PREFIX}[${code}]`,
                    },
                  })),
                ],
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
        updatedAt: true,
        status: true,
        deliveryMode: true,
        lastError: true,
      },
    });
    const lastMarkerRow = markerRows[markerRows.length - 1];
    const lastMarkerId = this.readNonEmptyString(lastMarkerRow?.id);
    const nextMarkerCursor =
      lastMarkerRow?.createdAt instanceof Date && lastMarkerId
        ? { createdAt: lastMarkerRow.createdAt, id: lastMarkerId }
        : markerCursor;
    const markerScanExhausted = markerRows.length < limit;
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
        nextMarkerCursor,
        markerScanExhausted,
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
      nextMarkerCursor,
      markerScanExhausted,
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

  async completeChatAutoCommentAuditRecovery(params: {
    chatId: string;
    messageId: string;
    markerId: string;
    replyMessageId: string;
  }): Promise<void> {
    const updated = await this.getDelegate('chat_auto_comment')?.updateMany?.({
      where: {
        id: params.markerId,
        chatId: params.chatId,
        messageId: params.messageId,
        status: { in: ['IN_PROGRESS', 'SUCCEEDED'] },
      },
      data: {
        status: 'SUCCEEDED',
        lockToken: null,
        lockedAt: null,
        deliveryMode: 'reply_message',
        replyMessageId: params.replyMessageId,
        replacementSendStartedAt: null,
        originalDeleted: false,
      },
    });
    if (updated && updated.count !== 1) {
      throw new Error('Failed to finalize the recovered chat auto-comment audit marker');
    }
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
    if (kind === 'chat_auto_comment') {
      const auditRecovery = await this.resolveChatAutoCommentAuditRecovery(
        delegate,
        params.chatId,
        params.messageId,
      );
      if (auditRecovery) {
        return auditRecovery;
      }
    }

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
      return {
        status: 'claimed',
        lockToken: this.createLockToken(false),
        ...(kind === 'chat_auto_comment' ? { markerId: this.createChatAutoCommentMarkerId() } : {}),
      };
    }

    const existing = await delegate.findUnique({
      where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
      select: {
        id: true,
        status: true,
        lockedAt: true,
        botId: true,
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
      return claimed.count > 0
        ? {
            status: 'claimed',
            lockToken,
          }
        : { status: 'in_progress' };
    }
    if (
      existing?.replacementMessageId ||
      existing?.replyMessageId ||
      existing?.replacementSendStartedAt
    ) {
      return { status: 'in_progress' };
    }
    const channelPreDispatchRecovery =
      kind === 'channel_auto_post' &&
      existing?.status === 'IN_PROGRESS' &&
      this.hasProvenChannelAutoPostPreDispatchEvidence(existing.lastError);
    if (
      kind === 'channel_auto_post' &&
      existing?.status === 'IN_PROGRESS' &&
      !channelPreDispatchRecovery
    ) {
      return { status: 'in_progress' };
    }

    const recoveryClaim =
      completionState === 'recover_legacy_channel_edit' ||
      this.hasChannelEditRecoveryEvidence(existing?.lastError);
    const lockToken = this.createLockToken(recoveryClaim);
    const existingMarkerId = this.readNonEmptyString(existing?.id);
    const markerId =
      kind === 'chat_auto_comment'
        ? existingMarkerId && buildChatAutoCommentAuditId(existingMarkerId)
          ? existingMarkerId
          : this.createChatAutoCommentMarkerId()
        : null;
    if (!existing) {
      const createData = {
        ...(markerId ? { id: markerId } : {}),
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
          return {
            status: 'claimed',
            lockToken,
            ...(markerId ? { markerId } : {}),
          };
        }
      } else if (delegate.create) {
        try {
          await delegate.create({ data: createData });
          return {
            status: 'claimed',
            lockToken,
            ...(markerId ? { markerId } : {}),
          };
        } catch (error: unknown) {
          if (!this.isPrismaKnownError(error, 'P2002')) {
            throw error;
          }
        }
      }
      if (kind === 'channel_auto_post') {
        return { status: 'in_progress' };
      }
    }

    const claimed = await delegate.updateMany({
      where: {
        ...(kind === 'chat_auto_comment' && (existingMarkerId ?? markerId)
          ? { id: existingMarkerId ?? markerId }
          : {}),
        chatId: params.chatId,
        messageId: params.messageId,
        status: 'IN_PROGRESS',
        ...(kind === 'channel_auto_post' && existing?.status === 'IN_PROGRESS'
          ? { lastError: existing.lastError }
          : {}),
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        ...(channelPreDispatchRecovery
          ? { lockedAt: null }
          : {
              OR: [
                { lockedAt: null },
                { lockedAt: { lt: new Date(Date.now() - ATTACH_LOCK_TTL_MS) } },
              ],
            }),
      },
      data: {
        ...(kind === 'chat_auto_comment' && existingMarkerId && markerId !== existingMarkerId
          ? { id: markerId }
          : {}),
        lockToken,
        lockedAt: now,
        source: params.source,
        botId: params.botId,
        ...(kind === 'channel_auto_post' ? { linkType: params.linkType ?? null } : {}),
        ...(channelPreDispatchRecovery
          ? { lastError: CHANNEL_AUTO_POST_PRE_DISPATCH_PROOF_CONSUMED }
          : recoveryClaim
            ? { lastError: this.withChannelEditRecoveryEvidence(existing?.lastError) }
            : {}),
      },
    });
    return claimed.count > 0
      ? {
          status: 'claimed',
          lockToken,
          ...(markerId ? { markerId } : {}),
        }
      : { status: 'in_progress' };
  }

  private async resolveChatAutoCommentAuditRecovery(
    delegate: MarkerDelegate | null,
    chatId: string,
    messageId: string,
  ): Promise<ReplacementAttachMarkerClaim | null> {
    if (!delegate?.findUnique) {
      return null;
    }

    const marker = await delegate.findUnique({
      where: { chatId_messageId: { chatId, messageId } },
      select: {
        id: true,
        status: true,
        botId: true,
        deliveryMode: true,
        replyMessageId: true,
      },
    });
    const markerId = this.readNonEmptyString(marker?.id);
    const replyMessageId = this.readNonEmptyString(marker?.replyMessageId);
    const auditId = markerId ? buildChatAutoCommentAuditId(markerId) : null;
    if (
      !marker ||
      !markerId ||
      !auditId ||
      (marker.status !== 'IN_PROGRESS' && marker.status !== 'SUCCEEDED')
    ) {
      return null;
    }

    const audit = await this.prisma.auditLog.findFirst({
      where: {
        id: auditId,
        chatId,
        action: CHAT_DIALOG_AUTO_ATTACH_ACTION,
      },
      select: { id: true, payload: true },
    });
    if (!replyMessageId) {
      const payload = this.readRecord(audit?.payload);
      const auditedReplyMessageId = this.readNonEmptyString(payload?.replyMessageId);
      if (
        !audit ||
        !auditedReplyMessageId ||
        this.readNonEmptyString(payload?.messageId) !== messageId ||
        this.readNonEmptyString(payload?.threadId) !== markerId ||
        this.readNonEmptyString(payload?.deliveryMode) !== 'reply_message'
      ) {
        return null;
      }

      const repaired = await delegate.updateMany?.({
        where: {
          id: markerId,
          chatId,
          messageId,
          status: { in: ['IN_PROGRESS', 'SUCCEEDED'] },
        },
        data: {
          status: 'SUCCEEDED',
          lockToken: null,
          lockedAt: null,
          deliveryMode: 'reply_message',
          replyMessageId: auditedReplyMessageId,
          replacementSendStartedAt: null,
          originalDeleted: false,
        },
      });
      if (repaired && repaired.count !== 1) {
        throw new Error('Failed to repair the chat auto-comment marker from its audit');
      }
      return { status: 'recovered_audit' };
    }

    if (marker.deliveryMode !== 'reply_message') {
      return null;
    }
    if (!audit) {
      return {
        status: 'recover_audit',
        markerId,
        replyMessageId,
        botId: this.readNonEmptyString(marker.botId),
      };
    }

    const finalized = await delegate.updateMany?.({
      where: {
        id: markerId,
        chatId,
        messageId,
        replyMessageId,
        status: { in: ['IN_PROGRESS', 'SUCCEEDED'] },
      },
      data: {
        status: 'SUCCEEDED',
        lockToken: null,
        lockedAt: null,
        replacementSendStartedAt: null,
      },
    });
    if (finalized && finalized.count !== 1) {
      throw new Error('Failed to finalize the chat auto-comment marker from its audit');
    }
    return { status: 'done' };
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

  private createChatAutoCommentMarkerId(): string {
    return `${CHAT_AUTO_COMMENT_MARKER_ID_PREFIX}${randomUUID().replaceAll('-', '')}`;
  }

  private readMarkerRecoveryCandidate(row: {
    id: unknown;
    chatId: unknown;
    messageId: unknown;
    createdAt: unknown;
    updatedAt?: unknown;
    status?: unknown;
    deliveryMode?: unknown;
    lastError?: unknown;
  }): LegacyChannelEditRecoveryCandidate | null {
    const evidenceId = this.readNonEmptyString(row.id);
    const chatId = this.readNonEmptyString(row.chatId);
    const messageId = this.readNonEmptyString(row.messageId);
    if (!evidenceId || !chatId || !messageId || !(row.createdAt instanceof Date)) {
      return null;
    }
    const preDispatchMarker =
      row.status === 'IN_PROGRESS' &&
      row.deliveryMode === null &&
      this.hasProvenChannelAutoPostPreDispatchEvidence(
        typeof row.lastError === 'string' ? row.lastError : null,
      );
    const evidenceAt =
      preDispatchMarker && row.updatedAt instanceof Date ? row.updatedAt : row.createdAt;
    return {
      chatId,
      messageId,
      evidence: preDispatchMarker ? 'predispatch_marker' : 'marker',
      evidenceId,
      evidenceAt,
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

  private readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
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

  private hasProvenChannelAutoPostPreDispatchEvidence(
    lastError: string | null | undefined,
  ): boolean {
    return hasPersistedChannelAutoPostPreDispatchEvidence(lastError);
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
