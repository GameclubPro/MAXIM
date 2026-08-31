import type { Logger } from '@nestjs/common';
import type { ChatSummary, ManualModerationActionResult } from '@maxim/contracts';
import type { Queue } from 'bullmq';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type {
  MaxActionDispatchOptions,
  MaxPublishedMessage,
  MaxSendMessageOptions,
} from '../max/max-client.service';
import type { ModerationSanctionStateLeaseGuard } from '../moderation/moderation-sanction-state-lock.service';
import type { ManualModerationFanoutLedgerStatus, Prisma } from '../prisma/prisma-client';
import type {
  AdminManualFanoutJob,
  AdminManualGroupModerationCommandJob,
} from './admin-manual-fanout.queue';
import type { AdminSuperBanJob } from './admin-super-ban.queue';
import type {
  AdminActionSource,
  ManualBanFollowUpSource,
  ManualModerationBotAction,
  ManualModerationExecutionOptions,
  ManualModerationFanoutSource,
  ResolveManualModerationActionBotAssignmentOptions,
} from './admin.service.support';

export type ManualModerationCleanupResult = {
  candidateMessageIds: string[];
  deletedMessageIds: string[];
  pendingMessageIds: string[];
  failedMessageIds: string[];
};

export type ManualModerationCleanupSummary = {
  mode?: 'queued';
  jobId?: string;
  candidateCount: number;
  deletedCount: number;
  pendingCount: number;
  failedCount: number;
};

export type ManualMuteFanoutResult = {
  mutedChatIds: string[];
  skippedChatIds: string[];
  failedChatIds: string[];
  retryableFailedChatIds?: string[];
};

export type ManualMuteFanoutSummary = {
  mode?: 'queued';
  jobId?: string;
  mutedChatsCount: number;
  mutedChatIds: string[];
  skippedChatsCount: number;
  skippedChatIds: string[];
  failedChatsCount: number;
  failedChatIds: string[];
};

export type ManualBanFanoutResult = {
  removedChatIds: string[];
  skippedChatIds: string[];
  failedChatIds: string[];
  retryableFailedChatIds?: string[];
  deletedMessageCount: number;
  failedMessageDeleteCount: number;
};

export type ManualBanFanoutSummary = {
  mode?: 'queued';
  jobId?: string;
  removedChatsCount: number;
  removedChatIds: string[];
  skippedChatsCount: number;
  skippedChatIds: string[];
  failedChatsCount: number;
  failedChatIds: string[];
  deletedMessageCount: number;
  failedMessageDeleteCount: number;
};

export type ManualMuteFollowUpInput = {
  sourceChatId: string;
  targetUserId: string;
  actor: AuthUser;
  rootIntentKey?: string | null;
  botId?: string | null;
  muteDurationHours: number | null;
  muteExpiresAt: Date | null;
  mutePermanent: boolean;
  source: ManualModerationFanoutSource;
  leaseGuard?: ModerationSanctionStateLeaseGuard;
};

export type ManualMuteFollowUpSummary = {
  sourceMessageCleanup: ManualModerationCleanupSummary;
  crossChatMuteFanout: ManualMuteFanoutSummary;
};

export type ManualBanFollowUpInput = {
  sourceChatId: string;
  targetUserId: string;
  actor: AuthUser;
  source: ManualBanFollowUpSource;
  rootIntentKey?: string | null;
  leaseGuard?: ModerationSanctionStateLeaseGuard;
};

export type ManualBanSourceCleanupInput = ManualBanFollowUpInput & {
  botId?: string | null;
};

export type ManualBanFollowUpSummary = {
  sourceMessageCleanup: ManualModerationCleanupSummary;
  crossChatFanout: ManualBanFanoutSummary;
};

export type ManualModerationFanoutLedgerOperation =
  | 'SOURCE_CLEANUP'
  | 'FANOUT_BAN_MEMBER'
  | 'FANOUT_MUTE_RECORD'
  | 'COMMAND_SOURCE_BAN'
  | 'COMMAND_SOURCE_MUTE'
  | 'COMMAND_NOTICE_OUTCOME'
  | 'COMMAND_NOTICE_SUCCESS'
  | 'COMMAND_NOTICE_FAILURE';

export type ManualModerationFanoutLedgerRowView = {
  status: ManualModerationFanoutLedgerStatus;
  moderationEventId: string | null;
};

export type ManualModerationFanoutLedgerClaimView =
  | { claimed: true; lockToken: string }
  | { claimed: false };

export type ManualModerationFanoutOperationKeyInput = {
  operation: ManualModerationFanoutLedgerOperation;
  sourceChatId: string;
  targetChatId: string;
  targetUserId: string;
  jobId?: string | null;
  rootIntentKey?: string | null;
  extra?: Array<string | number | boolean | null | undefined>;
};

export type ManualModerationFanoutLedgerClaimInput = {
  operationKey: string;
  jobId?: string | null;
  rootIntentKey?: string | null;
  sourceKind: string;
  operation: ManualModerationFanoutLedgerOperation;
  sourceChatId: string;
  targetChatId: string;
  targetUserId: string;
  actorUserId: string;
  logicalAction: string;
  botId?: string | null;
  executionMode?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

export type ManualModerationFanoutLedgerCompleteInput = {
  operationKey: string;
  lockToken: string;
  status?: ManualModerationFanoutLedgerStatus;
  botId?: string | null;
  executionMode?: string | null;
  moderationEventId?: string | null;
  auditLogId?: string | null;
  remoteMessageId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

export type ManualModerationFanoutLedgerFailureInput = {
  operationKey: string;
  lockToken: string;
  status: ManualModerationFanoutLedgerStatus;
  error: unknown;
  terminal?: boolean;
  retainClaim?: boolean;
  requireClaim?: boolean;
  botId?: string | null;
  executionMode?: string | null;
  metadata?: Prisma.InputJsonValue | null;
};

export type ManualModerationActionBotAssignmentInput = {
  chatId: string;
  action: ManualModerationBotAction;
  options?: ResolveManualModerationActionBotAssignmentOptions;
};

export type AdminManualModerationRuntimeContext = {
  readonly logger: Logger;
  readonly adminSuperBanQueue?: Queue<AdminSuperBanJob>;
  readonly adminManualFanoutQueue?: Queue<AdminManualFanoutJob>;
  enqueueManualModerationFanout(job: AdminManualFanoutJob): Promise<boolean>;
  isKnownRuntimeBotUserId(userId: string | null | undefined): boolean;
  isSuperBanDeveloperUserId(userId: string | null | undefined): boolean;
  processDeveloperSuperBanJob(job: AdminSuperBanJob): Promise<void>;
  processManualSystemBan(
    chatId: string,
    targetUserId: string,
    actor: AuthUser,
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>,
    options: ManualModerationExecutionOptions,
  ): Promise<ManualModerationActionResult>;
  processManualModerationAction(
    chatId: string,
    targetUserId: string,
    actor: AuthUser,
    body: unknown,
    source: AdminActionSource,
    options: ManualModerationExecutionOptions,
  ): Promise<ManualModerationActionResult>;
  resolveManualCommandFanoutChats(actor: AuthUser, sourceChatId: string): Promise<ChatSummary[]>;
  runManualSourceCleanupWithLedger(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    sourceKind: string;
    sourceChatId: string;
    targetUserId: string;
    actorUserId: string;
    botId?: string | null;
    logMessage: string;
  }): Promise<ManualModerationCleanupResult>;
  applyManualMuteFanout(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
    source: ManualModerationFanoutSource;
    targetChats?: ChatSummary[];
  }): Promise<ManualMuteFanoutResult>;
  applyManualSystemBanFanout(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    source?: ManualBanFollowUpSource;
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    targetChats?: ChatSummary[];
  }): Promise<ManualBanFanoutResult>;
  resolveManualMuteCommandFollowUpSummaries(
    params: ManualMuteFollowUpInput,
  ): Promise<ManualMuteFollowUpSummary>;
  resolveManualGroupCommandCleanupBotId(
    chatId: string,
    preferredBotId?: string | null,
  ): Promise<string | undefined>;
  resolveManualModerationTargetDisplayName(
    chatId: string,
    targetUserId: string,
    options: { botId?: string; allowRemoteLookup?: boolean },
  ): Promise<string | null>;
  deleteManualGroupCommandTargetMessage(
    job: Pick<
      AdminManualGroupModerationCommandJob,
      'sourceChatId' | 'commandBotId' | 'targetUserId' | 'targetMessageId'
    >,
    options: { botId?: string },
  ): Promise<void>;
  deleteManualGroupCommandMessage(
    chatId: string,
    messageId: string,
    options: { botId?: string; originBotId?: string | null; actorUserId?: string | null },
  ): Promise<void>;
  readManualModerationFanoutIntentRow(params: {
    rootIntentKey: string;
    operation: 'COMMAND_SOURCE_BAN' | 'COMMAND_SOURCE_MUTE';
    sourceChatId: string;
    targetChatId: string;
    targetUserId: string;
  }): Promise<ManualModerationFanoutLedgerRowView | null>;
  resolveManualMuteResultFromLedger(
    row: ManualModerationFanoutLedgerRowView,
    fallback: {
      userId: string;
      muteDurationHours: number | null;
      muteExpiresAt: Date | null;
      mutePermanent: boolean;
    },
  ): ManualModerationActionResult;
  isAmbiguousAttemptedMaxMemberMutation(error: unknown): boolean;
  isManualModerationTransientMaxError(error: unknown): boolean;
  isManualModerationOrderingFailure(error: unknown): boolean;
  resolveManualModerationActionBotAssignment(
    input: ManualModerationActionBotAssignmentInput,
  ): Promise<string | undefined>;
  deleteRecentTrackedMessagesForManualAction(
    chatId: string,
    targetUserId: string,
    options: { botId?: string; leaseGuard?: ModerationSanctionStateLeaseGuard },
  ): Promise<ManualModerationCleanupResult>;
  runManualBanSourceCleanup(
    chatId: string,
    targetUserId: string,
    actorUserId: string,
    options: { botId?: string; leaseGuard?: ModerationSanctionStateLeaseGuard },
  ): Promise<ManualModerationCleanupResult>;
  runManualBanFanoutInlineSummary(params: ManualBanFollowUpInput): Promise<ManualBanFanoutSummary>;
  summarizeManualModerationCleanup(
    result: ManualModerationCleanupResult,
  ): ManualModerationCleanupSummary;
  summarizeManualMuteFanout(result: ManualMuteFanoutResult): ManualMuteFanoutSummary;
  summarizeManualBanFanout(result: ManualBanFanoutResult): ManualBanFanoutSummary;
  normalizeManualModerationBotId(value: unknown): string | null;
  canResolveCurrentChatMemberAccess(): boolean;
  resolveDeliveryBotAssignment(chatId: string): Promise<string | null>;
  buildManualModerationFanoutOperationKey(params: ManualModerationFanoutOperationKeyInput): string;
  claimManualModerationFanoutLedgerEntry(
    params: ManualModerationFanoutLedgerClaimInput,
  ): Promise<ManualModerationFanoutLedgerClaimView>;
  completeManualModerationFanoutLedgerEntry(
    params: ManualModerationFanoutLedgerCompleteInput,
  ): Promise<void>;
  markManualModerationFanoutLedgerFailed(
    params: ManualModerationFanoutLedgerFailureInput,
  ): Promise<boolean>;
  findSettledManualGroupCommandOutcomeRows(params: {
    jobId: string;
    chatId: string;
    targetUserId: string;
  }): Promise<Array<{ operation: string }>>;
  sendMessage(
    chatId: string,
    text: string,
    options: MaxSendMessageOptions,
    dispatchOptions: MaxActionDispatchOptions,
  ): Promise<MaxPublishedMessage | void>;
  extractMaxApiErrorMessage(error: unknown): string;
  extractHttpErrorMessage(error: unknown): string;
  escapeMarkdownPlainText(value: string): string;
  readTrimmedString(value: unknown): string | null;
};

type AdminManualModerationRuntimeContextTarget = Omit<
  AdminManualModerationRuntimeContext,
  | 'processManualSystemBan'
  | 'processManualModerationAction'
  | 'resolveManualModerationActionBotAssignment'
> & {
  maxClient: {
    getCurrentChatMemberAccess?: unknown;
    sendMessage: AdminManualModerationRuntimeContext['sendMessage'];
  };
  prisma: {
    manualModerationFanoutLedgerEntry: {
      findMany(args: unknown): Promise<Array<{ operation: string }>>;
    };
  };
  applyManualSystemBan: AdminManualModerationRuntimeContext['processManualSystemBan'];
  applyManualModerationAction: AdminManualModerationRuntimeContext['processManualModerationAction'];
  resolveManualModerationActionBotAssignment(
    chatId: string,
    action: ManualModerationBotAction,
    options?: ResolveManualModerationActionBotAssignmentOptions,
  ): Promise<string | undefined>;
};

export function createAdminManualModerationRuntimeContext(
  target: object,
): AdminManualModerationRuntimeContext {
  const typedTarget = target as AdminManualModerationRuntimeContextTarget;

  return {
    get logger(): Logger {
      return typedTarget.logger;
    },
    get adminSuperBanQueue(): Queue<AdminSuperBanJob> | undefined {
      return typedTarget.adminSuperBanQueue;
    },
    get adminManualFanoutQueue(): Queue<AdminManualFanoutJob> | undefined {
      return typedTarget.adminManualFanoutQueue;
    },
    enqueueManualModerationFanout: (job) => typedTarget.enqueueManualModerationFanout(job),
    isKnownRuntimeBotUserId: (userId) => typedTarget.isKnownRuntimeBotUserId(userId),
    isSuperBanDeveloperUserId: (userId) => typedTarget.isSuperBanDeveloperUserId(userId),
    processDeveloperSuperBanJob: (job) => typedTarget.processDeveloperSuperBanJob(job),
    processManualSystemBan: (chatId, targetUserId, actor, source, options) =>
      typedTarget.applyManualSystemBan(chatId, targetUserId, actor, source, options),
    processManualModerationAction: (chatId, targetUserId, actor, body, source, options) =>
      typedTarget.applyManualModerationAction(chatId, targetUserId, actor, body, source, options),
    resolveManualCommandFanoutChats: (actor, sourceChatId) =>
      typedTarget.resolveManualCommandFanoutChats(actor, sourceChatId),
    runManualSourceCleanupWithLedger: (params) =>
      typedTarget.runManualSourceCleanupWithLedger(params),
    applyManualMuteFanout: (params) => typedTarget.applyManualMuteFanout(params),
    applyManualSystemBanFanout: (params) => typedTarget.applyManualSystemBanFanout(params),
    resolveManualMuteCommandFollowUpSummaries: (params) =>
      typedTarget.resolveManualMuteCommandFollowUpSummaries(params),
    resolveManualGroupCommandCleanupBotId: (chatId, preferredBotId) =>
      typedTarget.resolveManualGroupCommandCleanupBotId(chatId, preferredBotId),
    resolveManualModerationTargetDisplayName: (chatId, targetUserId, options) =>
      typedTarget.resolveManualModerationTargetDisplayName(chatId, targetUserId, options),
    deleteManualGroupCommandTargetMessage: (job, options) =>
      typedTarget.deleteManualGroupCommandTargetMessage(job, options),
    deleteManualGroupCommandMessage: (chatId, messageId, options) =>
      typedTarget.deleteManualGroupCommandMessage(chatId, messageId, options),
    readManualModerationFanoutIntentRow: (params) =>
      typedTarget.readManualModerationFanoutIntentRow(params),
    resolveManualMuteResultFromLedger: (row, fallback) =>
      typedTarget.resolveManualMuteResultFromLedger(row, fallback),
    isAmbiguousAttemptedMaxMemberMutation: (error) =>
      typedTarget.isAmbiguousAttemptedMaxMemberMutation(error),
    isManualModerationTransientMaxError: (error) =>
      typedTarget.isManualModerationTransientMaxError(error),
    isManualModerationOrderingFailure: (error) =>
      typedTarget.isManualModerationOrderingFailure(error),
    resolveManualModerationActionBotAssignment: ({ chatId, action, options }) =>
      typedTarget.resolveManualModerationActionBotAssignment(chatId, action, options),
    deleteRecentTrackedMessagesForManualAction: (chatId, targetUserId, options) =>
      typedTarget.deleteRecentTrackedMessagesForManualAction(chatId, targetUserId, options),
    runManualBanSourceCleanup: (chatId, targetUserId, actorUserId, options) =>
      typedTarget.runManualBanSourceCleanup(chatId, targetUserId, actorUserId, options),
    runManualBanFanoutInlineSummary: (params) =>
      typedTarget.runManualBanFanoutInlineSummary(params),
    summarizeManualModerationCleanup: (result) =>
      typedTarget.summarizeManualModerationCleanup(result),
    summarizeManualMuteFanout: (result) => typedTarget.summarizeManualMuteFanout(result),
    summarizeManualBanFanout: (result) => typedTarget.summarizeManualBanFanout(result),
    normalizeManualModerationBotId: (value) => typedTarget.normalizeManualModerationBotId(value),
    canResolveCurrentChatMemberAccess: () =>
      typeof typedTarget.maxClient.getCurrentChatMemberAccess === 'function',
    resolveDeliveryBotAssignment: (chatId) => typedTarget.resolveDeliveryBotAssignment(chatId),
    buildManualModerationFanoutOperationKey: (params) =>
      typedTarget.buildManualModerationFanoutOperationKey(params),
    claimManualModerationFanoutLedgerEntry: (params) =>
      typedTarget.claimManualModerationFanoutLedgerEntry(params),
    completeManualModerationFanoutLedgerEntry: (params) =>
      typedTarget.completeManualModerationFanoutLedgerEntry(params),
    markManualModerationFanoutLedgerFailed: (params) =>
      typedTarget.markManualModerationFanoutLedgerFailed(params),
    findSettledManualGroupCommandOutcomeRows: ({ jobId, chatId, targetUserId }) =>
      typedTarget.prisma.manualModerationFanoutLedgerEntry.findMany({
        where: {
          jobId,
          operation: {
            in: ['COMMAND_NOTICE_OUTCOME', 'COMMAND_NOTICE_SUCCESS', 'COMMAND_NOTICE_FAILURE'],
          },
          targetChatId: chatId,
          targetUserId,
          status: { in: ['SUCCEEDED', 'AMBIGUOUS'] },
        },
        select: { operation: true },
        take: 3,
      }),
    sendMessage: (chatId, text, options, dispatchOptions) =>
      typedTarget.maxClient.sendMessage(chatId, text, options, dispatchOptions),
    extractMaxApiErrorMessage: (error) => typedTarget.extractMaxApiErrorMessage(error),
    extractHttpErrorMessage: (error) => typedTarget.extractHttpErrorMessage(error),
    escapeMarkdownPlainText: (value) => typedTarget.escapeMarkdownPlainText(value),
    readTrimmedString: (value) => typedTarget.readTrimmedString(value),
  };
}
