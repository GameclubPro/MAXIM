import { isValidDeleteBotMessagesDelayMinutes } from '@maxim/contracts/settings';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { MaxBotLinkService, type MaxDeleteMessageBotRoute } from '../max/max-bot-link.service';
import {
  isMaxApiCircuitOpenError,
  MAX_API_SOURCE_TAGS,
  MaxClientService,
} from '../max/max-client.service';
import {
  MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
  MAX_SEND_FENCE_STALE_MS,
} from '../max/max-send-ambiguity.util';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildMessageScopedModerationActionClaimKey,
  claimDurableModerationMessageAction,
  type ModerationMessageActionClaimData,
  type ModerationMessageActionClaimModel,
} from './moderation-message-action-claim';
import { buildManagedPublicationAutoDeleteFenceWhere } from './managed-publication-auto-delete-fence';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';
import {
  MODERATION_DELETE_INTENT_QUEUE,
  type ModerationDeleteIntentJob,
} from './moderation-delete-intent.queue';
import {
  normalizeModerationDeleteIntentMode,
  parseModerationDeleteIntentCanaryChatIds,
  resolveModerationDeleteIntentRollout,
} from './moderation-delete-intent-rollout.util';
import type {
  EnsureModerationDeleteIntentInput,
  EnsureClaimedModerationDeleteIntentResult,
  EnsureModerationDeleteIntentResult,
  ModerationDeleteAttemptResult,
  ModerationDeleteIntentMode,
  ModerationDeleteIntentRollout,
  ModerationDeleteIntentSnapshot,
  ModerationDeleteIntentStatus,
} from './moderation-delete-intent.types';
import {
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE,
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_VERSION,
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON,
  isValidBotMessageExplicitOperatorCleanupReason,
} from './bot-message-explicit-operator-cleanup.constants';
import { NIGHT_MODE_TRANSITION_NOTICE_RULE_CODES } from './night-mode-transition-notice-persistence-error';
import {
  NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE,
  parseNightModeCloseNoticeCleanupBinding,
  type NightModeCloseNoticeCleanupBinding,
} from './night-mode-close-notice-cleanup-binding';
import {
  buildNightModeTransitionScheduleFingerprint,
  buildNightModeTransitionSideEffectFingerprint,
} from './night-mode-transition-generation.util';
import { resolveNightModeTransitionSnapshot } from './night-mode-transition-time.util';
import { LinkHistoryDeleteGuardService } from './link-history-delete-guard.service';
import {
  LINK_BLOCKED_DELETE_RULE_CODE,
  LINK_HISTORY_RECOVERY_RULE_CODE,
} from './link-history-recovery.util';
import {
  isPhotoDuplicateMatchKindAllowed,
  PHOTO_DUPLICATE_MATCH_KINDS,
  type PhotoDuplicateMatchKind,
  type PhotoDuplicateMatchPreset,
  type PhotoDuplicateScope,
} from './photo-duplicate/photo-duplicate.runtime';
import { PhotoDuplicateRuntimePolicyService } from './photo-duplicate/photo-duplicate-runtime-policy.service';
import {
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE,
  CommercialOcrDeleteGuardRejectedError,
  CommercialOcrDeleteGuardService,
  parseCommercialOcrDeleteBinding,
} from './commercial-ocr/commercial-ocr-delete-guard.service';

const DEFAULT_RETRY_HORIZON_MS = 24 * 60 * 60_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;
const DEFAULT_CAPABILITY_RETRY_MS = 30_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_SWEEP_BATCH_SIZE = 100;
const DEFAULT_RECOVERY_BATCH_SIZE = 10;
const DEFAULT_PURGE_MAX_BATCHES = 40;
const DEFAULT_DELETE_TIMEOUT_MS = 5_000;
const DEFAULT_RETENTION_DAYS = 90;
const BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS = 5;
const BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE =
  'bot_message_auto_delete_retry_limit_reached';
const BOT_MESSAGE_AUTO_DELETE_SUCCESS_VERIFICATION_PENDING_ERROR_CODE =
  'bot_message_auto_delete_success_verification_pending';
const BOT_MESSAGE_AUTO_DELETE_SUCCESS_STILL_PRESENT_ERROR_CODE =
  'bot_message_auto_delete_success_still_present';
export const BOT_MESSAGE_AUTO_DELETE_REPAIR_INTENT_AUDIT_ACTION =
  'OPERATOR_CREATE_MISSING_BOT_MESSAGE_AUTO_DELETE_INTENT';
export const BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_INTENT_AUDIT_ACTION =
  'OPERATOR_CREATE_EXPLICIT_BOT_MESSAGE_CLEANUP_INTENT';
const NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE = 'night_mode_close_notice_cleanup_stale';
const DELETE_QUEUE_PRIORITY_INTERACTIVE = 1;
const DELETE_QUEUE_PRIORITY_BACKGROUND = 10;
const CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE =
  'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP';
const CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE =
  'channel_auto_post_cleanup_entity_mismatch';
const CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE =
  'channel_auto_post_cleanup_sender_not_admin';
export const MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES = [
  CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE,
  'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
  'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
] as const;
const BOT_MESSAGE_AUTO_DELETE_RULE_CODE = 'BOT_MESSAGE_AUTO_DELETE';
const REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE = 'REQUIRED_SUBSCRIPTION_DELETE';
const REPLACEMENT_CLEANUP_RULE_CODE_SET: ReadonlySet<string> = new Set(
  MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
);

const TERMINAL_STATUSES = new Set<ModerationDeleteIntentStatus>([
  'OBSERVED',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
]);

type IntentRow = {
  id: string;
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  sourceMessageAt: Date | null;
  entityType: 'CHAT' | 'CHANNEL' | null;
  messageAuthorKind: string | null;
  originBotId: string | null;
  routingPolicy: string;
  commercialOcrGuardRequired: boolean;
  commercialOcrDeadlineAt: Date | null;
  status: ModerationDeleteIntentStatus;
  executeAt: Date;
  nextAttemptAt: Date;
  retryUntilAt: Date;
  attemptCount: number;
  lastBotId: string | null;
  succeededBotId: string | null;
  deleteDispatchStartedAt: Date | null;
  deleteDispatchStartedBotId: string | null;
  remoteDeleteSucceededAt: Date | null;
  remoteDeleteSucceededBotId: string | null;
  candidateFailures: unknown;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  lastError: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  leasedFromStatus: ModerationDeleteIntentStatus | null;
  replacementCleanup?: boolean;
  nonChannelReplacementCleanup?: boolean;
  channelAutoPostCleanupReason?: boolean;
  channelAutoPostCleanupOnly?: boolean;
  botMessageAutoDeleteReason?: boolean;
  botMessageAutoDeleteOnly?: boolean;
  requiredSubscriptionDeleteReason?: boolean;
  commercialOcrDeleteReason?: boolean;
  nonCommercialOcrDeleteReason?: boolean;
  linkFamilyDeleteOnly?: boolean;
  photoDuplicateDeleteOnly?: boolean;
  nightModeCloseNoticeCleanupReason?: boolean;
  nightModeCloseNoticeCleanupOnly?: boolean;
  nightModeCloseNoticeCleanupBinding?: unknown;
};

type PhotoDuplicateDeleteReasonFence = {
  matchKind: PhotoDuplicateMatchKind;
  preset: PhotoDuplicateMatchPreset;
  scope: PhotoDuplicateScope;
};

type ManagedBotMessageOwner = {
  id: string;
  kind:
    | 'managed_publication'
    | 'managed_publication_in_flight'
    | 'managed_giveaway_publication'
    | 'managed_giveaway_results'
    | 'vk_parsing_post'
    | 'published_chat_rules'
    | 'chat_auto_comment_replacement'
    | 'chat_auto_comment_reply'
    | 'night_mode_transition_notice';
};

export type ModerationDeleteIntentRoutingContext = {
  chatId: string;
  entityType: 'CHAT' | 'CHANNEL' | null;
  messageAuthorKind: string | null;
  routingPolicy: string;
  replacementCleanup?: boolean;
};

type CandidateFailure = {
  failedAt: string;
  retryAt: string;
  errorCode: string;
  statusCode: number | null;
};

type IntentLeaseHeartbeat = {
  renew: () => Promise<boolean>;
  stop: () => void;
};

type BotMessageAutoDeleteRetryLimitOutcome =
  | { kind: 'continue'; intent: IntentRow }
  | { kind: 'terminal'; intent: IntentRow }
  | { kind: 'lease_lost' };

type BotMessageAutoDeleteRepairActiveStatus = Extract<
  ModerationDeleteIntentStatus,
  'PENDING' | 'RETRYABLE' | 'WAITING_CAPABILITY' | 'AMBIGUOUS'
>;

type BotMessageAutoDeleteRepairIntentAuditBaseOptions = {
  actorUserId: string;
  auditPayload: Prisma.InputJsonObject;
};

export type BotMessageAutoDeleteExplicitOperatorCleanupPolicy = {
  settingsId: string;
  chatId: string;
  deleteBotMessagesEnabled: true;
  deleteBotMessagesDelayMinutes: number;
  createdAt: Date;
  updatedAt: Date;
  sendJobCreatedAt: Date;
};

export type BotMessageAutoDeleteExplicitOperatorCleanupSendEvidence = {
  ledgerId: string;
  jobId: string;
  chatId: string;
  messageId: string;
  dispatchBotId: string;
  trafficClass: string | null;
  actionHealthLane: string | null;
  enqueuedAt: Date;
  completedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  jobCreatedAt: Date;
};

export type BotMessageAutoDeleteRepairIntentAuditOptions =
  | (BotMessageAutoDeleteRepairIntentAuditBaseOptions & {
      kind?: 'legacy_missing_intent';
      operatorReason?: never;
      expectedPolicy?: never;
    })
  | (BotMessageAutoDeleteRepairIntentAuditBaseOptions & {
      kind: 'explicit_operator_cleanup';
      operatorReason: string;
      expectedPolicy: BotMessageAutoDeleteExplicitOperatorCleanupPolicy;
      expectedSend: BotMessageAutoDeleteExplicitOperatorCleanupSendEvidence;
    });

export type EnsureBotMessageAutoDeleteRepairIntentResult = {
  created: boolean;
  intentId: string;
  rollout: 'execute';
  status: BotMessageAutoDeleteRepairActiveStatus;
};

export type ModerationDeleteIntentAttemptOptions = {
  /** Fences this inline attempt only; the persisted intent remains the durable recovery owner. */
  beforeDeleteMutation?: () => Promise<void>;
};

export class BotMessageAutoDeleteExplicitCleanupConflictError extends Error {
  readonly code = 'explicit_operator_cleanup_conflict';

  constructor(message = 'Explicit bot-message cleanup authorization changed before commit') {
    super(message);
    this.name = 'BotMessageAutoDeleteExplicitCleanupConflictError';
  }
}

export class BotMessageAutoDeleteExplicitCleanupPolicyConflictError extends BotMessageAutoDeleteExplicitCleanupConflictError {
  constructor() {
    super('Current bot-message cleanup policy no longer matches the authorized snapshot');
    this.name = 'BotMessageAutoDeleteExplicitCleanupPolicyConflictError';
  }
}

class ModerationDeleteIntentLeaseLostError extends Error {
  constructor() {
    super('Moderation delete intent lease ownership was lost');
    this.name = 'ModerationDeleteIntentLeaseLostError';
  }
}

class ModerationDeletePreDispatchGuardError extends Error {
  constructor(readonly guardError: unknown) {
    super('Moderation delete pre-dispatch guard rejected the mutation', { cause: guardError });
    this.name = 'ModerationDeletePreDispatchGuardError';
  }
}

class ModerationDeleteReasonMissingError extends Error {
  readonly code = 'moderation_delete_reason_missing';

  constructor() {
    super('Moderation delete intent has no durable reason');
    this.name = 'ModerationDeleteReasonMissingError';
  }
}

class NightModeCloseNoticeCleanupGuardRejectedError extends Error {
  readonly code = NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'NightModeCloseNoticeCleanupGuardRejectedError';
  }
}

class ChannelAutoPostCleanupEntityGuardRejectedError extends Error {
  readonly code = CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE;

  constructor(chatId: string, entityType: string | null) {
    super(
      `Channel auto-post cleanup for ${chatId} cannot run against ${entityType ?? 'a missing entity'}`,
    );
    this.name = 'ChannelAutoPostCleanupEntityGuardRejectedError';
  }
}

class ChannelAutoPostCleanupSenderGuardRejectedError extends Error {
  readonly code = CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE;

  constructor(chatId: string, userId: string | null) {
    super(
      `Channel auto-post cleanup for ${chatId} cannot delete a message from ${userId ?? 'an unknown sender'}`,
    );
    this.name = 'ChannelAutoPostCleanupSenderGuardRejectedError';
  }
}

class ModerationDeleteProtectedMessageError extends Error {
  constructor(readonly protectedIntent: IntentRow) {
    super('Managed bot message became protected before delete dispatch');
    this.name = 'ModerationDeleteProtectedMessageError';
  }
}

class ModerationDeleteGuardedMessageAbsentError extends Error {
  constructor(
    readonly verificationCode:
      | 'guarded_link_predispatch_exact_absence'
      | 'guarded_commercial_ocr_predispatch_exact_absence',
  ) {
    super('MAX confirmed that the guarded message is absent');
    this.name = 'ModerationDeleteGuardedMessageAbsentError';
  }
}

export class PhotoDuplicateDeleteIntentGuardRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PhotoDuplicateDeleteIntentGuardRejectedError';
  }
}

type DeleteErrorDetails = {
  status: 'RETRYABLE' | 'WAITING_CAPABILITY' | 'AMBIGUOUS' | 'EXPIRED' | 'FAILED_TERMINAL';
  statusCode: number | null;
  errorCode: string;
  message: string;
  retryDelayMs: number | null;
};

type ReplacementCleanupRecoveryCandidate = {
  sourceId: string;
  source: 'channel_auto_post' | 'chat_auto_comment' | 'chat_rules_state' | 'chat_rules_republish';
  chatId: string;
  messageId: string;
  originBotId: string | null;
  entityType: 'CHAT' | 'CHANNEL';
  messageAuthorKind: 'user' | 'bot';
  routingPolicy: 'origin_first' | 'origin_only';
  existingIntentId: string | null;
  existingIntentStatus: ModerationDeleteIntentStatus | null;
  createdAt: Date;
};

@Injectable()
export class ModerationDeleteIntentService {
  private readonly logger = new Logger(ModerationDeleteIntentService.name);
  private readonly mode: ModerationDeleteIntentMode;
  private readonly canaryChatIds: ReadonlySet<string>;
  private readonly commercialOcrMode: ModerationDeleteIntentMode;
  private readonly commercialOcrCanaryChatIds: ReadonlySet<string>;
  private readonly crossBotCanaryChatIds: ReadonlySet<string>;
  private readonly replacementCleanupEnabled: boolean;
  private readonly requiredSubscriptionDeleteEnabled: boolean;
  private readonly retryHorizonMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly capabilityRetryMs: number;
  private readonly leaseMs: number;
  private readonly sweepBatchSize: number;
  private readonly recoveryBatchSize: number;
  private readonly deleteTimeoutMs: number;
  private readonly retentionDays: number;
  private readonly purgeMaxBatches: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @InjectQueue(MODERATION_DELETE_INTENT_QUEUE)
    private readonly queue: Queue<ModerationDeleteIntentJob>,
    configService: ConfigService,
    private readonly linkHistoryDeleteGuard: LinkHistoryDeleteGuardService,
    private readonly photoDuplicateRuntimePolicy: PhotoDuplicateRuntimePolicyService,
    private readonly commercialOcrDeleteGuard: CommercialOcrDeleteGuardService,
  ) {
    this.mode = normalizeModerationDeleteIntentMode(
      configService.get('MODERATION_DELETE_INTENT_MODE'),
    );
    this.canaryChatIds = parseModerationDeleteIntentCanaryChatIds(
      configService.get('MODERATION_DELETE_INTENT_CANARY_CHAT_IDS'),
    );
    this.commercialOcrMode = normalizeModerationDeleteIntentMode(
      configService.get('COMMERCIAL_OCR_ROLLOUT_MODE'),
    );
    this.commercialOcrCanaryChatIds = new Set(
      [
        ...parseModerationDeleteIntentCanaryChatIds(
          configService.get('COMMERCIAL_OCR_CANARY_CHAT_IDS'),
        ),
      ].filter((chatId) => chatId !== '*'),
    );
    this.crossBotCanaryChatIds = parseModerationDeleteIntentCanaryChatIds(
      configService.get('MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS'),
    );
    this.replacementCleanupEnabled = this.readBoolean(
      configService.get('MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED'),
      true,
    );
    this.requiredSubscriptionDeleteEnabled = this.readBoolean(
      configService.get('MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED'),
      true,
    );
    this.retryHorizonMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RETRY_HORIZON_MS'),
      DEFAULT_RETRY_HORIZON_MS,
    );
    this.retryBaseMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RETRY_BASE_MS'),
      DEFAULT_RETRY_BASE_MS,
    );
    this.retryMaxMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RETRY_MAX_MS'),
      DEFAULT_RETRY_MAX_MS,
    );
    this.capabilityRetryMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_CAPABILITY_RETRY_MS'),
      DEFAULT_CAPABILITY_RETRY_MS,
    );
    this.leaseMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_LEASE_MS'),
      DEFAULT_LEASE_MS,
    );
    this.sweepBatchSize = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_SWEEP_BATCH_SIZE'),
      DEFAULT_SWEEP_BATCH_SIZE,
    );
    this.recoveryBatchSize = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RECOVERY_BATCH_SIZE'),
      DEFAULT_RECOVERY_BATCH_SIZE,
    );
    this.deleteTimeoutMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_TIMEOUT_MS'),
      DEFAULT_DELETE_TIMEOUT_MS,
    );
    this.retentionDays = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RETENTION_DAYS'),
      DEFAULT_RETENTION_DAYS,
    );
    this.purgeMaxBatches = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_PURGE_MAX_BATCHES'),
      DEFAULT_PURGE_MAX_BATCHES,
    );
  }

  get rolloutMode(): ModerationDeleteIntentMode {
    return this.mode;
  }

  get replacementCleanupRolloutEnabled(): boolean {
    return this.replacementCleanupEnabled;
  }

  getRolloutForChat(chatId: string): ModerationDeleteIntentRollout {
    return resolveModerationDeleteIntentRollout({
      mode: this.mode,
      canaryChatIds: this.canaryChatIds,
      chatId,
    });
  }

  getRolloutForRule(chatId: string, ruleCode: string): ModerationDeleteIntentRollout {
    return this.getRolloutForRuleCodes(chatId, [ruleCode]);
  }

  getRolloutForInput(
    input: Pick<EnsureModerationDeleteIntentInput, 'chatId' | 'reasonKey' | 'ruleCode'>,
  ): ModerationDeleteIntentRollout {
    return this.getRolloutForRule(input.chatId, input.ruleCode ?? input.reasonKey);
  }

  getRolloutForRuleCodes(
    chatId: string,
    ruleCodes: readonly string[],
  ): ModerationDeleteIntentRollout {
    const normalizedRuleCodes = ruleCodes.map((ruleCode) => ruleCode.trim());
    // FLAG: Required-subscription enforcement deletion must retain durable retry ownership.
    if (
      this.requiredSubscriptionDeleteEnabled &&
      normalizedRuleCodes.some((ruleCode) => ruleCode === REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE)
    ) {
      return 'execute';
    }
    if (normalizedRuleCodes.some((ruleCode) => ruleCode === BOT_MESSAGE_AUTO_DELETE_RULE_CODE)) {
      return 'execute';
    }
    if (
      this.replacementCleanupEnabled &&
      normalizedRuleCodes.some((ruleCode) => this.isReplacementCleanupRuleCode(ruleCode))
    ) {
      return 'execute';
    }

    const rollouts: ModerationDeleteIntentRollout[] = [];
    if (normalizedRuleCodes.includes(COMMERCIAL_OCR_DELETE_RULE_CODE)) {
      rollouts.push(this.getCommercialOcrRolloutForChat(chatId));
    }
    if (
      normalizedRuleCodes.length === 0 ||
      normalizedRuleCodes.some((ruleCode) => ruleCode !== COMMERCIAL_OCR_DELETE_RULE_CODE)
    ) {
      rollouts.push(this.getRolloutForChat(chatId));
    }
    if (rollouts.includes('execute')) {
      return 'execute';
    }
    return rollouts.includes('observed') ? 'observed' : 'off';
  }

  resolveEffectiveRoutingPolicy(
    intent: ModerationDeleteIntentRoutingContext,
  ): 'delete_capable' | 'origin_first' | 'origin_only' {
    const userAuthoredChat = intent.entityType === 'CHAT' && intent.messageAuthorKind === 'user';
    const crossBotCanaryEnabled =
      this.crossBotCanaryChatIds.has('*') || this.crossBotCanaryChatIds.has(intent.chatId);
    const replacementCleanupCrossBotEnabled =
      this.replacementCleanupEnabled &&
      intent.replacementCleanup === true &&
      intent.routingPolicy !== 'origin_only';
    if (!userAuthoredChat || (!crossBotCanaryEnabled && !replacementCleanupCrossBotEnabled)) {
      return 'origin_only';
    }
    return intent.routingPolicy === 'delete_capable' ? 'delete_capable' : 'origin_first';
  }

  async ensureIntent(
    input: EnsureModerationDeleteIntentInput,
  ): Promise<EnsureModerationDeleteIntentResult> {
    return this.persistIntent(input, true);
  }

  async ensureBotMessageAutoDeleteRepairIntentWithAudit(
    input: EnsureModerationDeleteIntentInput,
    options: BotMessageAutoDeleteRepairIntentAuditOptions,
  ): Promise<EnsureBotMessageAutoDeleteRepairIntentResult> {
    const normalized = this.normalizeInput(input);
    const actorUserId = options.actorUserId.trim();
    const repairKind = options.kind ?? 'legacy_missing_intent';
    if (!actorUserId) {
      throw new Error('actorUserId is required for bot-message auto-delete intent repair');
    }
    if (
      !options.auditPayload ||
      typeof options.auditPayload !== 'object' ||
      Array.isArray(options.auditPayload)
    ) {
      throw new Error('auditPayload must be a JSON object for bot-message auto-delete repair');
    }
    if (repairKind !== 'legacy_missing_intent' && repairKind !== 'explicit_operator_cleanup') {
      throw new Error('Unsupported bot-message auto-delete repair kind');
    }
    if (
      normalized.reasonKey !== BOT_MESSAGE_AUTO_DELETE_RULE_CODE ||
      normalized.ruleCode !== BOT_MESSAGE_AUTO_DELETE_RULE_CODE ||
      normalized.entityType !== 'CHAT' ||
      normalized.messageAuthorKind !== 'bot' ||
      input.routingPolicy !== 'origin_only' ||
      normalized.routingPolicy !== 'origin_only' ||
      !normalized.originBotId ||
      !normalized.subjectUserId ||
      !normalized.sourceMessageAt ||
      this.optionalString(input.event?.userId) !== normalized.subjectUserId ||
      input.event?.eventType !== 'MESSAGE'
    ) {
      throw new Error(
        'Bot-message auto-delete repair requires exact BOT_MESSAGE_AUTO_DELETE CHAT/bot/origin_only identity and MESSAGE author evidence',
      );
    }
    const expectedSourceMessageAt = normalized.sourceMessageAt;
    const explicitCleanup =
      options.kind === 'explicit_operator_cleanup'
        ? {
            operatorReason: options.operatorReason.trim(),
            expectedPolicy: options.expectedPolicy,
            expectedSend: options.expectedSend,
          }
        : null;
    if (explicitCleanup) {
      const policy = explicitCleanup.expectedPolicy;
      const send = explicitCleanup.expectedSend;
      const metadata =
        input.event?.metadata &&
        typeof input.event.metadata === 'object' &&
        !Array.isArray(input.event.metadata)
          ? (input.event.metadata as Record<string, unknown>)
          : null;
      if (!isValidBotMessageExplicitOperatorCleanupReason(explicitCleanup.operatorReason)) {
        throw new Error('Explicit operator cleanup reason must be 8..256 printable characters');
      }
      if (
        !policy.settingsId.trim() ||
        policy.chatId !== normalized.chatId ||
        policy.deleteBotMessagesEnabled !== true ||
        !isValidDeleteBotMessagesDelayMinutes(policy.deleteBotMessagesDelayMinutes) ||
        !Number.isFinite(policy.createdAt.getTime()) ||
        !Number.isFinite(policy.updatedAt.getTime()) ||
        !Number.isFinite(policy.sendJobCreatedAt.getTime()) ||
        policy.createdAt > policy.updatedAt ||
        (policy.createdAt <= policy.sendJobCreatedAt && policy.updatedAt <= policy.sendJobCreatedAt)
      ) {
        throw new Error('Explicit operator cleanup requires a valid newer enabled policy snapshot');
      }
      if (
        !send.ledgerId.trim() ||
        !send.jobId.trim() ||
        send.chatId !== normalized.chatId ||
        send.messageId !== normalized.messageId ||
        send.dispatchBotId !== normalized.originBotId ||
        !Number.isFinite(send.enqueuedAt.getTime()) ||
        !Number.isFinite(send.completedAt.getTime()) ||
        !Number.isFinite(send.createdAt.getTime()) ||
        !Number.isFinite(send.updatedAt.getTime()) ||
        !Number.isFinite(send.jobCreatedAt.getTime()) ||
        send.jobCreatedAt.getTime() !== policy.sendJobCreatedAt.getTime() ||
        Math.abs(send.jobCreatedAt.getTime() - send.createdAt.getTime()) > 60_000 ||
        send.enqueuedAt.getTime() + 60_000 < send.jobCreatedAt.getTime() ||
        send.enqueuedAt > send.completedAt
      ) {
        throw new Error('Explicit operator cleanup requires valid exact SEND ledger evidence');
      }
      if (
        !metadata ||
        metadata.reason !== BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON ||
        metadata.repairSource !== BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE ||
        metadata.evidenceSource !== BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE ||
        metadata.evidenceVersion !== BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_VERSION ||
        metadata.sourceSendAutoDeleteDelayMs !== null
      ) {
        throw new Error(
          'Explicit operator cleanup requires exact durable explicit-cleanup reason metadata',
        );
      }
    }

    // FLAG: Only exact legacy evidence or an explicit operator-authorized cleanup may create
    // deletion ownership. Policy fencing, persistence, classifier verification, and audit must
    // remain one atomic transaction.
    return this.runSerializableTransaction(async (tx) => {
      if (explicitCleanup) {
        const expectedPolicy = explicitCleanup.expectedPolicy;
        const policyRows = await tx.$queryRaw<
          Array<{
            settingsId: string;
            chatId: string;
            deleteBotMessagesEnabled: boolean;
            deleteBotMessagesDelayMinutes: number;
            createdAt: Date;
            updatedAt: Date;
          }>
        >(Prisma.sql`
          SELECT
            settings."id" AS "settingsId",
            settings."chat_id" AS "chatId",
            settings."delete_bot_messages_enabled" AS "deleteBotMessagesEnabled",
            settings."delete_bot_messages_delay_minutes" AS "deleteBotMessagesDelayMinutes",
            settings."created_at" AS "createdAt",
            settings."updated_at" AS "updatedAt"
          FROM "chat_settings" settings
          WHERE settings."chat_id" = ${normalized.chatId}
          LIMIT 1
          FOR UPDATE
        `);
        const currentPolicy = policyRows[0];
        if (
          !currentPolicy ||
          currentPolicy.settingsId !== expectedPolicy.settingsId ||
          currentPolicy.chatId !== expectedPolicy.chatId ||
          currentPolicy.deleteBotMessagesEnabled !== true ||
          currentPolicy.deleteBotMessagesDelayMinutes !==
            expectedPolicy.deleteBotMessagesDelayMinutes ||
          currentPolicy.createdAt.getTime() !== expectedPolicy.createdAt.getTime() ||
          currentPolicy.updatedAt.getTime() !== expectedPolicy.updatedAt.getTime()
        ) {
          throw new BotMessageAutoDeleteExplicitCleanupPolicyConflictError();
        }

        const expectedSend = explicitCleanup.expectedSend;
        const sendRows = await tx.$queryRaw<
          Array<{
            ledgerId: string;
            jobId: string;
            actionType: string;
            chatId: string;
            remoteMessageId: string | null;
            sourceTag: string | null;
            trafficClass: string | null;
            actionHealthLane: string | null;
            status: string;
            ambiguous: boolean;
            terminal: boolean;
            dispatchBotId: string | null;
            enqueuedAt: Date | null;
            completedAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
            hasAutoDeleteDelayMs: boolean;
            autoDeleteDelayType: string | null;
            jobCreatedAt: string | null;
          }>
        >(Prisma.sql`
          SELECT
            send."id" AS "ledgerId",
            send."job_id" AS "jobId",
            send."action_type" AS "actionType",
            send."chat_id" AS "chatId",
            send."remote_message_id" AS "remoteMessageId",
            send."source_tag" AS "sourceTag",
            send."traffic_class" AS "trafficClass",
            send."action_health_lane" AS "actionHealthLane",
            send."status"::text AS "status",
            send."ambiguous" AS "ambiguous",
            send."terminal" AS "terminal",
            send."dispatch_bot_id" AS "dispatchBotId",
            send."enqueued_at" AS "enqueuedAt",
            send."completed_at" AS "completedAt",
            send."created_at" AS "createdAt",
            send."updated_at" AS "updatedAt",
            send."metadata" ? 'autoDeleteDelayMs' AS "hasAutoDeleteDelayMs",
            jsonb_typeof(send."metadata"->'autoDeleteDelayMs') AS "autoDeleteDelayType",
            send."metadata"->>'createdAt' AS "jobCreatedAt"
          FROM "max_action_ledger" send
          WHERE send."id" = ${expectedSend.ledgerId}
          LIMIT 1
          FOR UPDATE
        `);
        const currentSend = sendRows[0];
        if (
          !currentSend ||
          currentSend.ledgerId !== expectedSend.ledgerId ||
          currentSend.jobId !== expectedSend.jobId ||
          currentSend.actionType !== 'SEND_MESSAGE' ||
          currentSend.chatId !== expectedSend.chatId ||
          currentSend.remoteMessageId !== expectedSend.messageId ||
          currentSend.sourceTag !== MAX_API_SOURCE_TAGS.MODERATION_NOTICE ||
          currentSend.trafficClass !== expectedSend.trafficClass ||
          currentSend.actionHealthLane !== expectedSend.actionHealthLane ||
          currentSend.status !== 'SUCCEEDED' ||
          currentSend.ambiguous ||
          !currentSend.terminal ||
          currentSend.dispatchBotId !== expectedSend.dispatchBotId ||
          currentSend.enqueuedAt?.getTime() !== expectedSend.enqueuedAt.getTime() ||
          currentSend.completedAt?.getTime() !== expectedSend.completedAt.getTime() ||
          currentSend.createdAt.getTime() !== expectedSend.createdAt.getTime() ||
          currentSend.updatedAt.getTime() !== expectedSend.updatedAt.getTime() ||
          currentSend.hasAutoDeleteDelayMs !== true ||
          currentSend.autoDeleteDelayType !== 'null' ||
          currentSend.jobCreatedAt !== expectedSend.jobCreatedAt.toISOString()
        ) {
          throw new BotMessageAutoDeleteExplicitCleanupConflictError(
            'Exact SEND ledger evidence changed after explicit-cleanup preflight',
          );
        }

        const deleteOwners = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT deletion."id"
          FROM "max_action_ledger" deletion
          WHERE deletion."chat_id" = ${normalized.chatId}
            AND deletion."action_type" = 'DELETE_MESSAGE'
            AND deletion."message_id" = ${normalized.messageId}
          LIMIT 1
          FOR UPDATE
        `);
        if (deleteOwners[0]) {
          throw new BotMessageAutoDeleteExplicitCleanupConflictError(
            'A DELETE ledger owner appeared after explicit-cleanup preflight',
          );
        }
      }

      const existingRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT intent."id"
        FROM "moderation_delete_intents" intent
        WHERE intent."chat_id" = ${normalized.chatId}
          AND intent."message_id" = ${normalized.messageId}
        LIMIT 1
      `);
      const existingIntentId = existingRows[0]?.id ?? null;
      if (explicitCleanup && existingIntentId) {
        throw new BotMessageAutoDeleteExplicitCleanupConflictError(
          'A moderation delete intent appeared after explicit-cleanup preflight',
        );
      }
      const ensured = await this.persistIntent(input, false, tx);
      if (!ensured.intentId) {
        throw new Error('Bot-message auto-delete repair did not persist an intent');
      }

      const currentRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
        SELECT ${this.intentSelectSql('intent')}
        FROM "moderation_delete_intents" intent
        WHERE intent."id" = ${ensured.intentId}
        LIMIT 1
      `);
      const current = currentRows[0];
      const activeStatuses: ReadonlySet<ModerationDeleteIntentStatus> = new Set([
        'PENDING',
        'RETRYABLE',
        'WAITING_CAPABILITY',
        'AMBIGUOUS',
      ]);
      const matchingSubject = current?.subjectUserId === normalized.subjectUserId;
      const matchingSource =
        current?.sourceMessageAt?.getTime() === expectedSourceMessageAt.getTime();
      if (
        !current ||
        current.id !== ensured.intentId ||
        current.chatId !== normalized.chatId ||
        current.messageId !== normalized.messageId ||
        current.entityType !== 'CHAT' ||
        current.messageAuthorKind !== 'bot' ||
        current.originBotId !== normalized.originBotId ||
        current.routingPolicy !== 'origin_only' ||
        !matchingSubject ||
        !matchingSource ||
        current.botMessageAutoDeleteReason !== true ||
        !this.isBotMessageAutoDeleteOnlyReason(current) ||
        ensured.rollout !== 'execute' ||
        ensured.status !== current.status ||
        !activeStatuses.has(current.status) ||
        !this.isExecutionEnabledForIntent(current)
      ) {
        throw new Error(
          `Persisted moderation delete intent ${ensured.intentId} is not an active matching BOT_MESSAGE_AUTO_DELETE-only repair intent`,
        );
      }

      const created = existingIntentId === null;
      if (created) {
        await tx.auditLog.create({
          data: {
            chatId: current.chatId,
            actorUserId,
            action:
              repairKind === 'explicit_operator_cleanup'
                ? BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_INTENT_AUDIT_ACTION
                : BOT_MESSAGE_AUTO_DELETE_REPAIR_INTENT_AUDIT_ACTION,
            payload: {
              ...options.auditPayload,
              repairVersion: 1,
              ...(explicitCleanup
                ? {
                    evidenceVersion: BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_VERSION,
                    evidenceSource: BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE,
                    sendLedgerId: explicitCleanup.expectedSend.ledgerId,
                    sendLedgerJobId: explicitCleanup.expectedSend.jobId,
                    sendLedgerStatus: 'SUCCEEDED',
                    sendLedgerSourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
                    sendLedgerDispatchBotId: explicitCleanup.expectedSend.dispatchBotId,
                    sendLedgerTrafficClass: explicitCleanup.expectedSend.trafficClass,
                    sendLedgerActionHealthLane: explicitCleanup.expectedSend.actionHealthLane,
                    sendLedgerEnqueuedAt: explicitCleanup.expectedSend.enqueuedAt.toISOString(),
                    sendLedgerCompletedAt: explicitCleanup.expectedSend.completedAt.toISOString(),
                    sendLedgerCreatedAt: explicitCleanup.expectedSend.createdAt.toISOString(),
                    sendLedgerUpdatedAt: explicitCleanup.expectedSend.updatedAt.toISOString(),
                    sendLedgerAutoDeleteDelayMs: null,
                    operatorReason: explicitCleanup.operatorReason,
                    policySettingsId: explicitCleanup.expectedPolicy.settingsId,
                    policyEnabled: true,
                    policyDelayMinutes:
                      explicitCleanup.expectedPolicy.deleteBotMessagesDelayMinutes,
                    policyCreatedAt: explicitCleanup.expectedPolicy.createdAt.toISOString(),
                    policyUpdatedAt: explicitCleanup.expectedPolicy.updatedAt.toISOString(),
                    sendJobCreatedAt: explicitCleanup.expectedPolicy.sendJobCreatedAt.toISOString(),
                  }
                : {}),
              repairKind,
              intentId: current.id,
              messageId: current.messageId,
              ruleCode: BOT_MESSAGE_AUTO_DELETE_RULE_CODE,
              originBotId: current.originBotId,
            },
          },
        });
      }

      return {
        created,
        intentId: current.id,
        rollout: 'execute',
        status: current.status as BotMessageAutoDeleteRepairActiveStatus,
      };
    });
  }

  async ensureIntentWithMessageActionClaim(params: {
    claim: ModerationMessageActionClaimData;
    intent: EnsureModerationDeleteIntentInput;
  }): Promise<EnsureClaimedModerationDeleteIntentResult> {
    this.assertClaimMatchesIntent(params.claim, params.intent);
    if (this.getRolloutForInput(params.intent) === 'off') {
      return { claim: 'blocked', intent: null };
    }

    const result = await this.runSerializableTransaction(async (tx) => {
      const claim = await claimDurableModerationMessageAction({
        model: tx.moderationViolationMessageClaim as unknown as ModerationMessageActionClaimModel,
        data: params.claim,
        resumeKnownOwner: true,
      });
      if (claim === 'blocked') {
        return { claim, intent: null } as const;
      }
      const intent = await this.persistIntent(params.intent, false, tx);
      if (!intent.intentId) {
        throw new Error('Claimed moderation message action did not materialize a delete intent');
      }
      return { claim, intent } as const;
    });

    if (result.intent?.rollout === 'execute' && result.intent.intentId) {
      try {
        await this.enqueueCurrentWakeup(result.intent.intentId, DELETE_QUEUE_PRIORITY_INTERACTIVE);
      } catch (error: unknown) {
        this.logger.warn(
          { intentId: result.intent.intentId, err: this.errorMessage(error) },
          'Failed to enqueue atomically persisted moderation delete intent; DB sweeper will retry',
        );
      }
    }
    return result;
  }

  async ensureAndAttempt(
    input: EnsureModerationDeleteIntentInput,
    options?: ModerationDeleteIntentAttemptOptions,
  ): Promise<ModerationDeleteAttemptResult> {
    const ensured = await this.persistIntent(input, false);
    if (ensured.rollout === 'off' || !ensured.intentId) {
      return { kind: 'off', confirmed: false, intentId: null, status: null };
    }
    if (ensured.rollout === 'observed') {
      return {
        kind: 'observed',
        confirmed: false,
        intentId: ensured.intentId,
        status: ensured.status ?? 'OBSERVED',
      };
    }

    const result = await this.attemptIntent(ensured.intentId, options);
    if (!result.confirmed) {
      await this.enqueueCurrentWakeup(ensured.intentId);
    }
    return result;
  }

  async attemptIntent(
    intentId: string,
    options?: ModerationDeleteIntentAttemptOptions,
  ): Promise<ModerationDeleteAttemptResult> {
    const existing = await this.loadIntent(intentId);
    if (!existing) {
      throw new Error(`Moderation delete intent ${intentId} does not exist`);
    }
    if (!this.isExecutionEnabledForIntent(existing)) {
      return this.toAttemptResult(existing);
    }

    const claimed = await this.claimOne(intentId);
    if (!claimed) {
      await this.expireIntentIfDue(intentId);
      const current = await this.loadRequiredIntent(intentId);
      return this.toAttemptResult(current);
    }
    return this.executeLeasedIntent(claimed.id, claimed.leaseToken!, options);
  }

  async enqueueCurrentIntentWakeupStrict(intentId: string): Promise<void> {
    const intent = await this.loadRequiredIntent(intentId);
    const eligibility = this.classifyIntentWakeupEligibility(intent);
    switch (eligibility) {
      case 'eligible':
        await this.enqueueIntentJob(intent.id, DELETE_QUEUE_PRIORITY_INTERACTIVE);
        return;
      case 'settled_or_in_progress':
        return;
      case 'execution_disabled':
        throw new Error(
          `Moderation delete intent ${intent.id} is not executable in the current rollout`,
        );
      case 'retry_window_exhausted':
        throw new Error(
          `Moderation delete intent ${intent.id} has no mutation evidence and its retry window is exhausted`,
        );
      case 'not_due':
        throw new Error(`Moderation delete intent ${intent.id} is not due for enqueue`);
    }
  }

  async retryTerminalIntent(
    intentId: string,
    expectedStatus: 'EXPIRED' | 'FAILED_TERMINAL',
    expectedVersion: { updatedAt: Date; attemptCount: number },
    options?: { actorUserId: string },
  ): Promise<{ reopened: boolean; intent: ModerationDeleteIntentSnapshot }> {
    const existing = await this.loadRequiredIntent(intentId);
    if (!this.isExecutionEnabledForIntent(existing)) {
      return { reopened: false, intent: this.toSnapshot(existing) };
    }
    const independentNonCommercialOcrExecution = this.hasExecutableNonCommercialOcrReason(existing);
    const resetBotMessageAutoDeleteRetryLimit =
      existing.status === 'FAILED_TERMINAL' &&
      existing.lastErrorCode === BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE &&
      !this.hasDeleteMutationEvidence(existing);

    const now = new Date();
    const retryUntilAt = new Date(now.getTime() + this.retryHorizonMs);
    const reopened = await this.runSerializableTransaction(async (tx) => {
      const rows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
        UPDATE "moderation_delete_intents"
        SET
          "status" = CASE
            WHEN "remote_delete_succeeded_at" IS NOT NULL
              OR "remote_delete_succeeded_bot_id" IS NOT NULL
              OR "delete_dispatch_started_at" IS NOT NULL
              OR "delete_dispatch_started_bot_id" IS NOT NULL
            THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
            ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
          END,
          "execute_at" = LEAST("execute_at", ${now}),
          "next_attempt_at" = ${now},
          "attempt_count" = CASE
            WHEN ${resetBotMessageAutoDeleteRetryLimit} THEN 0
            ELSE "attempt_count"
          END,
          "commercial_ocr_guard_required" = (
            "commercial_ocr_guard_required"
            OR EXISTS (
              SELECT 1
              FROM "moderation_delete_intent_reasons" existing_ocr_reason
              WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
                AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            )
          ),
          "commercial_ocr_deadline_at" = CASE
            WHEN "commercial_ocr_guard_required" OR EXISTS (
              SELECT 1
              FROM "moderation_delete_intent_reasons" existing_ocr_reason
              WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
                AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            )
            THEN COALESCE("commercial_ocr_deadline_at", "retry_until_at")
            ELSE "commercial_ocr_deadline_at"
          END,
          "retry_until_at" = CASE
            WHEN NOT ${independentNonCommercialOcrExecution} AND (
              "commercial_ocr_guard_required" OR EXISTS (
                SELECT 1
                FROM "moderation_delete_intent_reasons" existing_ocr_reason
                WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
                  AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
              )
            )
            THEN LEAST(
              GREATEST("retry_until_at", ${retryUntilAt}),
              COALESCE("commercial_ocr_deadline_at", "retry_until_at")
            )
            ELSE GREATEST("retry_until_at", ${retryUntilAt})
          END,
          "completed_at" = NULL,
          "last_status_code" = CASE
            WHEN ${resetBotMessageAutoDeleteRetryLimit} THEN NULL
            ELSE "last_status_code"
          END,
          "last_error_code" = CASE
            WHEN ${resetBotMessageAutoDeleteRetryLimit} THEN NULL
            ELSE "last_error_code"
          END,
          "last_error" = CASE
            WHEN ${resetBotMessageAutoDeleteRetryLimit} THEN NULL
            ELSE "last_error"
          END,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "leased_from_status" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${intentId}
          AND "status" = CAST(${expectedStatus} AS "ModerationDeleteIntentStatus")
          AND "updated_at" = ${expectedVersion.updatedAt}
          AND "attempt_count" = ${expectedVersion.attemptCount}
          AND (
            ${independentNonCommercialOcrExecution}
            OR
            NOT (
              "commercial_ocr_guard_required"
              OR EXISTS (
                SELECT 1
                FROM "moderation_delete_intent_reasons" existing_ocr_reason
                WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
                  AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
              )
            )
            OR COALESCE("commercial_ocr_deadline_at", "retry_until_at") > ${now}
          )
        RETURNING ${this.intentReturningSql()}
      `);
      const updated = rows[0] ?? null;
      if (updated && options?.actorUserId) {
        await tx.auditLog.create({
          data: {
            chatId: existing.chatId,
            actorUserId: options.actorUserId,
            action: 'SAFETY_DESK_REOPEN_DELETE_INTENT',
            payload: {
              intentId: existing.id,
              messageId: existing.messageId,
              previousStatus: expectedStatus,
              previousErrorCode: existing.lastErrorCode,
              previousStatusCode: existing.lastStatusCode,
              dispatchStartedAt: existing.deleteDispatchStartedAt?.toISOString() ?? null,
              dispatchStartedBotId: existing.deleteDispatchStartedBotId,
              retryUntilAt: updated.retryUntilAt.toISOString(),
            },
          },
        });
      }
      return updated;
    });
    if (!reopened) {
      return { reopened: false, intent: this.toSnapshot(await this.loadRequiredIntent(intentId)) };
    }
    reopened.replacementCleanup = existing.replacementCleanup;
    reopened.botMessageAutoDeleteReason = existing.botMessageAutoDeleteReason;
    reopened.botMessageAutoDeleteOnly = existing.botMessageAutoDeleteOnly;
    reopened.requiredSubscriptionDeleteReason = existing.requiredSubscriptionDeleteReason;
    reopened.commercialOcrDeleteReason = existing.commercialOcrDeleteReason;
    reopened.nonCommercialOcrDeleteReason = existing.nonCommercialOcrDeleteReason;
    await this.enqueueWakeup(reopened, DELETE_QUEUE_PRIORITY_INTERACTIVE);
    return { reopened: true, intent: this.toSnapshot(reopened) };
  }

  async executeLeasedIntent(
    intentId: string,
    leaseToken: string,
    options?: ModerationDeleteIntentAttemptOptions,
  ): Promise<ModerationDeleteAttemptResult> {
    const intent = await this.loadIntent(intentId);
    if (!intent) {
      throw new Error(`Moderation delete intent ${intentId} does not exist`);
    }
    if (
      intent.status !== 'IN_PROGRESS' ||
      intent.leaseToken !== leaseToken ||
      !intent.leaseExpiresAt ||
      intent.leaseExpiresAt.getTime() <= Date.now()
    ) {
      return this.toAttemptResult(intent);
    }
    if (!this.isExecutionEnabledForIntent(intent)) {
      await this.releasePausedLease(intent.id, leaseToken);
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }
    // FLAG: A queued historical job may already be above the sweep cap. Terminalize it before
    // starting a heartbeat or making any MAX access, presence, or delete call.
    if (
      this.isBotMessageAutoDeleteRetryLimitApplicable(intent) &&
      intent.attemptCount > BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS
    ) {
      const retryLimitOutcome = await this.enforceBotMessageAutoDeleteRetryLimit(
        intent,
        leaseToken,
        true,
      );
      if (retryLimitOutcome.kind === 'terminal') {
        return this.toAttemptResult(retryLimitOutcome.intent);
      }
      if (retryLimitOutcome.kind === 'lease_lost') {
        return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
      }
      Object.assign(intent, retryLimitOutcome.intent);
    }
    const heartbeat = this.startLeaseHeartbeat(intent.id, leaseToken);
    try {
      if (
        intent.remoteDeleteSucceededAt &&
        intent.remoteDeleteSucceededBotId &&
        !this.isBotMessageAutoDeleteOnlyReason(intent)
      ) {
        return this.finalizeRecordedRemoteSuccess(
          intent,
          leaseToken,
          intent.remoteDeleteSucceededBotId,
        );
      }

      if (!this.hasDeleteMutationEvidence(intent)) {
        await this.assertLeaseForExternalCall(heartbeat);
        const protectedIntent = await this.finishProtectedManagedBotMessageAutoDelete(
          intent,
          leaseToken,
        );
        if (protectedIntent) {
          return this.toAttemptResult(protectedIntent);
        }
      }

      let route: MaxDeleteMessageBotRoute;
      try {
        route = await this.resolveDeleteRouteWithRefresh(intent, heartbeat);
      } catch (error: unknown) {
        if (error instanceof ModerationDeleteIntentLeaseLostError) {
          throw error;
        }
        const details = this.describeError(error, 'route_lookup_failed');
        return this.finishRetryableAttempt(intent, leaseToken, {
          ...details,
          status: 'RETRYABLE',
          retryDelayMs: this.retryDelayMs(intent.attemptCount),
        });
      }

      const candidateBotIds = this.filterAndOrderRouteCandidates(intent, route);
      if (candidateBotIds.length === 0) {
        return this.finishRetryableAttempt(intent, leaseToken, {
          status: 'WAITING_CAPABILITY',
          statusCode: null,
          errorCode: route.capabilityReason || 'no_delete_capable_bot',
          message: `No active bot has fresh confirmed delete permission (${route.capabilityReason})`,
          retryDelayMs: this.capabilityRetryDelayMs(intent.attemptCount),
        });
      }

      const attemptedBotIds = new Set<string>();
      let lastAccessFailure: DeleteErrorDetails | null = null;
      let unresolvedDeleteDispatch = this.hasDeleteMutationEvidence(intent);
      while (candidateBotIds.length > 0) {
        const botId = candidateBotIds.shift()!;
        if (attemptedBotIds.has(botId)) {
          continue;
        }
        attemptedBotIds.add(botId);
        if (!(await this.recordAttemptBot(intent.id, leaseToken, botId))) {
          return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
        }

        if (unresolvedDeleteDispatch) {
          try {
            const presence = await this.getExactMessagePresence(intent, botId, heartbeat);
            if (presence === 'absent') {
              if (
                intent.remoteDeleteSucceededAt &&
                intent.remoteDeleteSucceededBotId &&
                this.isBotMessageAutoDeleteOnlyReason(intent)
              ) {
                const completed = await this.completeSucceeded(
                  intent.id,
                  leaseToken,
                  botId,
                  'post_success_exact_absence',
                );
                return this.toAttemptResult(completed);
              }
              const completed = await this.completeAlreadyAbsent(
                intent.id,
                leaseToken,
                botId,
                'retry_predelete_exact_presence',
              );
              return this.toAttemptResult(completed);
            }
            if (this.isBotMessageAutoDeleteOnlyReason(intent)) {
              if (!(await this.clearBotMessageAutoDeleteMutationEvidence(intent.id, leaseToken))) {
                return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
              }
              intent.deleteDispatchStartedAt = null;
              intent.deleteDispatchStartedBotId = null;
              intent.remoteDeleteSucceededAt = null;
              intent.remoteDeleteSucceededBotId = null;
              if (intent.attemptCount > BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS) {
                const retryLimitOutcome = await this.enforceBotMessageAutoDeleteRetryLimit(
                  intent,
                  leaseToken,
                  true,
                );
                if (retryLimitOutcome.kind === 'terminal') {
                  return this.toAttemptResult(retryLimitOutcome.intent);
                }
                if (retryLimitOutcome.kind === 'lease_lost') {
                  return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
                }
                Object.assign(intent, retryLimitOutcome.intent);
              }
            }
            unresolvedDeleteDispatch = false;
          } catch (error: unknown) {
            if (error instanceof ModerationDeleteIntentLeaseLostError) {
              throw error;
            }
            const details = this.describeError(error, 'predelete_presence_unknown');
            const waitingForCapability =
              details.statusCode === 404 ||
              this.isDeleteAccessFailure(details) ||
              this.isDeleteMessageNotFoundFailure(details);
            lastAccessFailure = {
              ...details,
              status: waitingForCapability ? 'WAITING_CAPABILITY' : 'AMBIGUOUS',
              errorCode: 'predelete_presence_unknown',
              retryDelayMs: waitingForCapability
                ? this.capabilityRetryDelayMs(intent.attemptCount)
                : this.retryDelayMs(intent.attemptCount),
            };
            await this.refreshCandidateAccess(intent, botId, heartbeat);
            await this.recordCandidateFailure(
              intent.id,
              leaseToken,
              botId,
              intent.attemptCount,
              lastAccessFailure,
            );
            route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
              chatId: intent.chatId,
              expectedEntityType: intent.entityType,
              requireFreshSnapshot: true,
            });
            for (const nextBotId of this.filterAndOrderRouteCandidates(intent, route)) {
              if (!attemptedBotIds.has(nextBotId) && !candidateBotIds.includes(nextBotId)) {
                candidateBotIds.push(nextBotId);
              }
            }
            continue;
          }
        }

        let dispatchMarkerPersisted = false;
        try {
          await this.assertLeaseForExternalCall(heartbeat);
          const beforeImmediateDeleteMutation = async () => {
            await this.assertLeaseForExternalCall(heartbeat);
            const protectedIntent = await this.finishProtectedManagedBotMessageAutoDelete(
              intent,
              leaseToken,
            );
            if (protectedIntent) {
              throw new ModerationDeleteProtectedMessageError(protectedIntent);
            }
            await this.runDeletePreDispatchGuards(intent, botId, options);
            if (!(await this.markDeleteDispatchStarted(intent.id, leaseToken, botId))) {
              throw new ModerationDeleteIntentLeaseLostError();
            }
            dispatchMarkerPersisted = true;
            intent.deleteDispatchStartedAt = new Date();
            intent.deleteDispatchStartedBotId = botId;
            unresolvedDeleteDispatch = true;
            await this.runDeletePreDispatchGuards(intent, botId, options, leaseToken);
          };
          await this.maxClient.deleteMessage(intent.chatId, intent.messageId, {
            immediate: true,
            beforeImmediateDeleteMutation,
            botId,
            timeoutMs: this.deleteTimeoutMs,
            trafficClass: 'critical',
            actionHealthLane: 'critical',
            sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
            ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
            idempotencyKey: `moderation-delete-intent-${intent.id}-attempt-${intent.attemptCount}`,
          });
        } catch (error: unknown) {
          if (error instanceof ModerationDeleteProtectedMessageError) {
            return this.toAttemptResult(error.protectedIntent);
          }
          if (error instanceof ModerationDeleteGuardedMessageAbsentError) {
            if (dispatchMarkerPersisted) {
              if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
                throw new ModerationDeleteIntentLeaseLostError();
              }
              intent.deleteDispatchStartedAt = null;
              intent.deleteDispatchStartedBotId = null;
              unresolvedDeleteDispatch = false;
            }
            const completed = await this.completeAlreadyAbsent(
              intent.id,
              leaseToken,
              botId,
              error.verificationCode,
            );
            return this.toAttemptResult(completed);
          }
          if (error instanceof ModerationDeletePreDispatchGuardError) {
            if (dispatchMarkerPersisted) {
              if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
                throw new ModerationDeleteIntentLeaseLostError();
              }
              intent.deleteDispatchStartedAt = null;
              intent.deleteDispatchStartedBotId = null;
              unresolvedDeleteDispatch = false;
            }
            const details = this.describeError(
              error.guardError,
              'delete_pre_dispatch_guard_rejected',
            );
            const terminalGuardRejection = this.isTerminalDeleteGuardRejection(error.guardError);
            const outcome = terminalGuardRejection
              ? await this.finishTerminalPreDispatchGuardRejection(intent, leaseToken, {
                  ...details,
                  status: 'FAILED_TERMINAL',
                  errorCode: details.errorCode,
                  retryDelayMs: null,
                })
              : await this.finishRetryableAttempt(intent, leaseToken, {
                  ...details,
                  status: 'RETRYABLE',
                  errorCode: details.errorCode,
                  retryDelayMs: this.retryDelayMs(intent.attemptCount),
                });
            if (terminalGuardRejection) {
              return outcome;
            }
            throw error;
          }
          if (error instanceof ModerationDeleteIntentLeaseLostError) {
            throw error;
          }
          const details = this.classifyDeleteError(error, intent.attemptCount);
          if (details.errorCode === 'unverified_message_not_found') {
            const absence = await this.verifyMessageAbsence(intent, botId, heartbeat);
            if (absence === 'verified_absent') {
              const completed = await this.completeAlreadyAbsent(
                intent.id,
                leaseToken,
                botId,
                'postdelete_exact_presence',
              );
              return this.toAttemptResult(completed);
            }
            if (absence === 'message_present') {
              if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
                return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
              }
              intent.deleteDispatchStartedAt = null;
              intent.deleteDispatchStartedBotId = null;
              unresolvedDeleteDispatch = false;
              lastAccessFailure = {
                ...details,
                status: 'WAITING_CAPABILITY',
                errorCode: 'delete_404_message_still_present',
                message: 'MAX still returns the exact message after DELETE returned 404',
                retryDelayMs: this.capabilityRetryDelayMs(intent.attemptCount),
              };
            } else {
              return this.finishRetryableAttempt(
                { ...intent, lastBotId: botId },
                leaseToken,
                details,
              );
            }
          } else if (this.isDeleteAccessFailure(details)) {
            if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
              return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
            }
            intent.deleteDispatchStartedAt = null;
            intent.deleteDispatchStartedBotId = null;
            unresolvedDeleteDispatch = false;
            lastAccessFailure = details;
            await this.refreshCandidateAccess(intent, botId, heartbeat);
          } else if (details.status === 'FAILED_TERMINAL') {
            if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
              return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
            }
            intent.deleteDispatchStartedAt = null;
            intent.deleteDispatchStartedBotId = null;
            return this.finishRetryableAttempt(
              { ...intent, lastBotId: botId },
              leaseToken,
              details,
            );
          } else {
            return this.finishRetryableAttempt(
              { ...intent, lastBotId: botId },
              leaseToken,
              details,
            );
          }

          await this.recordCandidateFailure(
            intent.id,
            leaseToken,
            botId,
            intent.attemptCount,
            lastAccessFailure ?? details,
          );
          route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
            chatId: intent.chatId,
            expectedEntityType: intent.entityType,
            requireFreshSnapshot: true,
          });
          for (const nextBotId of this.filterAndOrderRouteCandidates(intent, route)) {
            if (!attemptedBotIds.has(nextBotId) && !candidateBotIds.includes(nextBotId)) {
              candidateBotIds.push(nextBotId);
            }
          }
          continue;
        }

        return this.recordRemoteSuccessAndFinalize(intent, leaseToken, botId);
      }

      return this.finishRetryableAttempt(
        intent,
        leaseToken,
        lastAccessFailure ?? {
          status: 'WAITING_CAPABILITY',
          statusCode: null,
          errorCode: 'delete_candidates_exhausted',
          message: 'All fresh delete-capable bot candidates were exhausted',
          retryDelayMs: this.capabilityRetryDelayMs(intent.attemptCount),
        },
      );
    } catch (error: unknown) {
      if (error instanceof ModerationDeletePreDispatchGuardError) {
        throw error.guardError;
      }
      if (error instanceof ModerationDeleteIntentLeaseLostError) {
        return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
      }
      try {
        return await this.finishPersistenceFailure(
          intent,
          leaseToken,
          'delete_intent_execution_failed',
          error,
        );
      } catch (recoveryError: unknown) {
        this.logger.error(
          {
            intentId: intent.id,
            err: this.errorMessage(error),
            recoveryErr: this.errorMessage(recoveryError),
          },
          'Failed to release moderation delete intent lease after execution error',
        );
        throw error;
      }
    } finally {
      heartbeat.stop();
    }
  }

  async sweepDueIntents(): Promise<number> {
    await this.expireDueIntents();
    if (!this.hasAnyExecutionScope()) {
      return 0;
    }

    const dueIntents = await this.selectDueIntentIds();
    await Promise.all(
      dueIntents.map(async (intent) => {
        try {
          await this.enqueueIntentJob(intent.id);
        } catch (error: unknown) {
          this.logger.warn(
            { intentId: intent.id, err: this.errorMessage(error) },
            'Failed to enqueue due moderation delete intent; DB state remains retryable',
          );
        }
      }),
    );
    return dueIntents.length;
  }

  async recoverReplacementCleanupSources(): Promise<number> {
    if (!this.hasAnyExecutionScope()) {
      return 0;
    }
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60_000);
    const markerRolloutFilter = this.buildRecoveryRolloutFilter(Prisma.sql`marker."chat_id"`);
    const rulesRolloutFilter = this.buildRecoveryRolloutFilter(Prisma.sql`rules."chat_id"`);
    const auditRolloutFilter = this.buildRecoveryRolloutFilter(Prisma.sql`audit."chat_id"`);
    const candidates = await this.prisma.$queryRaw<ReplacementCleanupRecoveryCandidate[]>(
      Prisma.sql`
        WITH recovery_candidates AS (
          SELECT
            marker."id" AS "sourceId",
            'channel_auto_post'::text AS "source",
            marker."chat_id" AS "chatId",
            marker."message_id" AS "messageId",
            COALESCE(marker."bot_id", intent."origin_bot_id") AS "originBotId",
            'CHANNEL'::text AS "entityType",
            'user'::text AS "messageAuthorKind",
            'origin_only'::text AS "routingPolicy",
            intent."id" AS "existingIntentId",
            intent."status" AS "existingIntentStatus",
            marker."updated_at" AS "createdAt"
          FROM "channel_auto_post_attach_markers" marker
          INNER JOIN "chats" channel_chat
            ON channel_chat."id" = marker."chat_id"
            AND channel_chat."entity_type" = CAST('CHANNEL' AS "ChatEntityType")
          LEFT JOIN "moderation_delete_intents" intent
            ON intent."chat_id" = marker."chat_id"
            AND intent."message_id" = marker."message_id"
          WHERE marker."status" IN (
              CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus"),
              CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus")
            )
            AND ${markerRolloutFilter}
            AND marker."delivery_mode" = 'replace_with_bot_message'
            AND marker."replacement_message_id" IS NOT NULL
            AND (
              marker."bot_id" IS NOT NULL
              OR intent."origin_bot_id" IS NOT NULL
              OR intent."status" IN (
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
            )
            AND marker."original_deleted" = false
            AND marker."updated_at" >= ${cutoff}
            AND (
              marker."status" = CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus")
              OR marker."cleanup_intent_id" IS NULL
              OR intent."status" IN (
                CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
              OR (
                intent."status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
                AND NOT EXISTS (
                  SELECT 1
                  FROM "moderation_delete_intent_reasons" recovery_reason
                  WHERE recovery_reason."intent_id" = intent."id"
                    AND recovery_reason."reason_key" =
                      'replacement-cleanup-recovery:channel_auto_post:' || marker."id"
                )
              )
            )

          UNION ALL

          SELECT
            rules."id" AS "sourceId",
            'chat_rules_state'::text AS "source",
            rules."chat_id" AS "chatId",
            rules."pending_cleanup_message_id" AS "messageId",
            COALESCE(rules."pending_cleanup_bot_id", intent."origin_bot_id") AS "originBotId",
            'CHAT'::text AS "entityType",
            'bot'::text AS "messageAuthorKind",
            'origin_only'::text AS "routingPolicy",
            intent."id" AS "existingIntentId",
            intent."status" AS "existingIntentStatus",
            rules."updated_at" AS "createdAt"
          FROM "chat_rules" rules
          LEFT JOIN "moderation_delete_intents" intent
            ON intent."chat_id" = rules."chat_id"
            AND intent."message_id" = rules."pending_cleanup_message_id"
          WHERE rules."pending_cleanup_message_id" IS NOT NULL
            AND ${rulesRolloutFilter}
            AND (
              rules."pending_cleanup_bot_id" IS NOT NULL
              OR intent."origin_bot_id" IS NOT NULL
              OR intent."status" IN (
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
            )
            AND rules."updated_at" >= ${cutoff}
            AND (
              rules."pending_cleanup_intent_id" IS NULL
              OR intent."status" IN (
                CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
              OR (
                intent."status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
                AND NOT EXISTS (
                  SELECT 1
                  FROM "moderation_delete_intent_reasons" recovery_reason
                  WHERE recovery_reason."intent_id" = intent."id"
                    AND recovery_reason."reason_key" =
                      'replacement-cleanup-recovery:chat_rules_state:' || rules."id"
                )
              )
            )

          UNION ALL

          SELECT
            marker."id" AS "sourceId",
            'chat_auto_comment'::text AS "source",
            marker."chat_id" AS "chatId",
            marker."message_id" AS "messageId",
            COALESCE(marker."bot_id", intent."origin_bot_id") AS "originBotId",
            'CHAT'::text AS "entityType",
            'user'::text AS "messageAuthorKind",
            'origin_first'::text AS "routingPolicy",
            intent."id" AS "existingIntentId",
            intent."status" AS "existingIntentStatus",
            marker."updated_at" AS "createdAt"
          FROM "chat_auto_comment_attach_markers" marker
          LEFT JOIN "moderation_delete_intents" intent
            ON intent."chat_id" = marker."chat_id"
            AND intent."message_id" = marker."message_id"
          WHERE marker."status" IN (
              CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus"),
              CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus")
            )
            AND ${markerRolloutFilter}
            AND marker."delivery_mode" = 'replace_with_bot_message'
            AND marker."replacement_message_id" IS NOT NULL
            AND (
              marker."bot_id" IS NOT NULL
              OR intent."origin_bot_id" IS NOT NULL
              OR intent."status" IN (
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
            )
            AND marker."original_deleted" = false
            AND marker."updated_at" >= ${cutoff}
            AND (
              marker."status" = CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus")
              OR marker."cleanup_intent_id" IS NULL
              OR intent."status" IN (
                CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
              OR (
                intent."status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
                AND NOT EXISTS (
                  SELECT 1
                  FROM "moderation_delete_intent_reasons" recovery_reason
                  WHERE recovery_reason."intent_id" = intent."id"
                    AND recovery_reason."reason_key" =
                      'replacement-cleanup-recovery:chat_auto_comment:' || marker."id"
                )
              )
            )

          UNION ALL

          SELECT
            audit."id" AS "sourceId",
            'chat_rules_republish'::text AS "source",
            audit."chat_id" AS "chatId",
            NULLIF(BTRIM(audit."payload"->>'previousPublishedMessageId'), '') AS "messageId",
            COALESCE(
              NULLIF(BTRIM(audit."payload"->>'previousPublishedBotId'), ''),
              NULLIF(BTRIM(audit."payload"->>'botId'), ''),
              intent."origin_bot_id"
            ) AS "originBotId",
            'CHAT'::text AS "entityType",
            'bot'::text AS "messageAuthorKind",
            'origin_only'::text AS "routingPolicy",
            intent."id" AS "existingIntentId",
            intent."status" AS "existingIntentStatus",
            audit."created_at" AS "createdAt"
          FROM "audit_logs" audit
          LEFT JOIN "moderation_delete_intents" intent
            ON intent."chat_id" = audit."chat_id"
            AND intent."message_id" = NULLIF(
              BTRIM(audit."payload"->>'previousPublishedMessageId'),
              ''
            )
          WHERE audit."action" = 'PUBLISH_CHAT_RULES'
            AND ${auditRolloutFilter}
            AND audit."payload"->>'previousCleanupOutcome' IN ('failed', 'accepted', 'owned')
            AND NULLIF(BTRIM(audit."payload"->>'previousPublishedMessageId'), '') IS NOT NULL
            AND (
              COALESCE(
                NULLIF(BTRIM(audit."payload"->>'previousPublishedBotId'), ''),
                NULLIF(BTRIM(audit."payload"->>'botId'), ''),
                intent."origin_bot_id"
              ) IS NOT NULL
              OR intent."status" IN (
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
            )
            AND audit."created_at" >= ${cutoff}
            AND (
              intent."id" IS NULL
              OR intent."status" IN (
                CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
              OR (
                intent."status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
                AND NOT EXISTS (
                  SELECT 1
                  FROM "moderation_delete_intent_reasons" recovery_reason
                  WHERE recovery_reason."intent_id" = intent."id"
                    AND recovery_reason."reason_key" =
                      'replacement-cleanup-recovery:chat_rules_republish:' || audit."id"
                )
              )
            )
        )
        SELECT *
        FROM recovery_candidates
        ORDER BY "createdAt" ASC, "sourceId" ASC
        LIMIT ${this.recoveryBatchSize}
      `,
    );

    let recovered = 0;
    for (const candidate of candidates) {
      const cleanupRuleCode = this.replacementCleanupRuleCode(candidate.source);
      if (this.getRolloutForRule(candidate.chatId, cleanupRuleCode) !== 'execute') {
        continue;
      }
      try {
        if (
          candidate.existingIntentId &&
          (candidate.existingIntentStatus === 'SUCCEEDED' ||
            candidate.existingIntentStatus === 'ALREADY_ABSENT')
        ) {
          await this.markReplacementCleanupConfirmed({
            id: candidate.existingIntentId,
            chatId: candidate.chatId,
            messageId: candidate.messageId,
          });
          recovered += 1;
          continue;
        }

        if (!candidate.originBotId) {
          continue;
        }

        const ensured = await this.persistIntent(
          {
            chatId: candidate.chatId,
            messageId: candidate.messageId,
            reasonKey: this.replacementCleanupReasonKey(candidate),
            ruleCode: cleanupRuleCode,
            entityType: candidate.entityType,
            messageAuthorKind: candidate.messageAuthorKind,
            originBotId: candidate.originBotId,
            routingPolicy: candidate.routingPolicy,
            event: {
              eventType: null,
              metadata: {
                source: candidate.source,
                sourceId: candidate.sourceId,
                recoveredBy: 'moderation_delete_intent_reconciler',
              },
            },
          },
          false,
        );
        const intentId = ensured.intentId;
        if (intentId) {
          await this.markRecoveredReplacementOwned(candidate, intentId);
          await this.enqueueCurrentWakeup(intentId);
        }
        recovered += 1;
      } catch (error: unknown) {
        this.logger.warn(
          {
            source: candidate.source,
            sourceId: candidate.sourceId,
            chatId: candidate.chatId,
            messageId: candidate.messageId,
            err: this.errorMessage(error),
          },
          'Failed to recover replacement cleanup into a durable delete intent',
        );
      }
    }
    return recovered;
  }

  async quarantineStaleReplacementSendFences(): Promise<number> {
    const staleBefore = new Date(Date.now() - MAX_SEND_FENCE_STALE_MS);
    const lastError = `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Replacement send started, but no remote message id was persisted before worker recovery.`;
    const recoveredChannelReplies = await this.prisma.channelAutoPostAttachMarker.updateMany({
      where: {
        status: 'IN_PROGRESS',
        deliveryMode: 'reply_message',
        replyMessageId: { not: null },
        replacementSendStartedAt: null,
        OR: [{ lockedAt: null }, { lockedAt: { lte: staleBefore } }],
      },
      data: {
        status: 'SUCCEEDED',
        lockToken: null,
        lockedAt: null,
        lastError: null,
        lastStatusCode: null,
      },
    });
    const recoveredChatReplies = await this.prisma.chatAutoCommentAttachMarker.updateMany({
      where: {
        status: 'IN_PROGRESS',
        deliveryMode: 'reply_message',
        replyMessageId: { not: null },
        replacementSendStartedAt: null,
        OR: [{ lockedAt: null }, { lockedAt: { lte: staleBefore } }],
      },
      data: {
        status: 'SUCCEEDED',
        lockToken: null,
        lockedAt: null,
        lastError: null,
        lastStatusCode: null,
      },
    });
    const channel = await this.prisma.channelAutoPostAttachMarker.updateMany({
      where: {
        status: 'IN_PROGRESS',
        replacementSendStartedAt: { lte: staleBefore },
        replacementMessageId: null,
      },
      data: {
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        lastError,
        lastStatusCode: null,
      },
    });
    const chat = await this.prisma.chatAutoCommentAttachMarker.updateMany({
      where: {
        status: 'IN_PROGRESS',
        replacementSendStartedAt: { lte: staleBefore },
        replacementMessageId: null,
      },
      data: {
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        lastError,
        lastStatusCode: null,
      },
    });
    const quarantined = channel.count + chat.count;
    if (quarantined > 0) {
      this.logger.error(
        {
          channelMarkers: channel.count,
          chatMarkers: chat.count,
          staleBefore: staleBefore.toISOString(),
        },
        'Quarantined stale ambiguous replacement sends without retrying MAX',
      );
    }
    if (recoveredChannelReplies.count > 0 || recoveredChatReplies.count > 0) {
      this.logger.warn(
        {
          recoveredChannelReplies: recoveredChannelReplies.count,
          recoveredChatReplies: recoveredChatReplies.count,
          staleBefore: staleBefore.toISOString(),
        },
        'Finalized stale fallback replies with a persisted remote message id',
      );
    }
    return recoveredChannelReplies.count + recoveredChatReplies.count + quarantined;
  }

  private async markRecoveredReplacementOwned(
    candidate: ReplacementCleanupRecoveryCandidate,
    intentId: string,
  ): Promise<void> {
    if (candidate.source === 'chat_rules_republish') {
      return;
    }
    if (candidate.source === 'chat_rules_state') {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "chat_rules"
        SET
          "pending_cleanup_intent_id" = ${intentId},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${candidate.sourceId}
          AND "pending_cleanup_message_id" = ${candidate.messageId}
      `);
      return;
    }
    if (candidate.source === 'channel_auto_post') {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "channel_auto_post_attach_markers"
        SET
          "status" = CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus"),
          "lock_token" = NULL,
          "locked_at" = NULL,
          "cleanup_intent_id" = ${intentId},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${candidate.sourceId}
          AND "replacement_message_id" IS NOT NULL
          AND "original_deleted" = false
      `);
      return;
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "chat_auto_comment_attach_markers"
      SET
        "status" = CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus"),
        "lock_token" = NULL,
        "locked_at" = NULL,
        "cleanup_intent_id" = ${intentId},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${candidate.sourceId}
        AND "replacement_message_id" IS NOT NULL
        AND "original_deleted" = false
    `);
  }

  async purgeRetainedIntents(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60_000);
    let total = 0;
    for (let batch = 0; batch < this.purgeMaxBatches; batch += 1) {
      const purged = await this.prisma.$executeRaw(Prisma.sql`
        WITH retained AS (
          SELECT intent."id"
          FROM "moderation_delete_intents" intent
          WHERE intent."updated_at" < ${cutoff}
            AND intent."status" IN (
              CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
              CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
              CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus"),
              CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
              CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "channel_auto_post_attach_markers" marker
              WHERE marker."chat_id" = intent."chat_id"
                AND marker."message_id" = intent."message_id"
                AND marker."delivery_mode" = 'replace_with_bot_message'
                AND marker."replacement_message_id" IS NOT NULL
                AND marker."original_deleted" = false
                AND marker."status" IN (
                  CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus"),
                  CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus")
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "chat_auto_comment_attach_markers" marker
              WHERE marker."chat_id" = intent."chat_id"
                AND marker."message_id" = intent."message_id"
                AND marker."delivery_mode" = 'replace_with_bot_message'
                AND marker."replacement_message_id" IS NOT NULL
                AND marker."original_deleted" = false
                AND marker."status" IN (
                  CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus"),
                  CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus")
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "chat_rules" rules
              WHERE rules."chat_id" = intent."chat_id"
                AND rules."pending_cleanup_message_id" = intent."message_id"
            )
          ORDER BY intent."updated_at" ASC
          LIMIT ${this.sweepBatchSize}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "moderation_delete_intents" intent
        USING retained
        WHERE intent."id" = retained."id"
      `);
      total += purged;
      if (purged < this.sweepBatchSize) {
        break;
      }
    }
    return total;
  }

  private async runDeletePreDispatchGuards(
    intent: IntentRow,
    botId: string,
    options?: ModerationDeleteIntentAttemptOptions,
    finalDispatchLeaseToken?: string,
  ): Promise<void> {
    try {
      // FLAG: A remote DELETE must always have a durable reason at the exact dispatch boundary.
      // Derived rule classifiers cannot represent a reasonless intent and therefore cannot fence it.
      // FLAG: A channel replacement cleanup must never cross an entity reclassification boundary.
      await this.assertChannelAutoPostCleanupStillAuthorized(intent, botId);
      // FLAG: A delayed close-notice cleanup is bound to the exact open session, settings
      // generation and persisted notice event. Re-check all three at the transport-final boundary.
      await this.assertNightModeCloseNoticeCleanupStillAuthorized(intent);
      const commercialOcrGuardRequired = await this.resolveDeleteIntentCommercialOcrGuard(intent);
      // FLAG: A durable photo-only retry must regain authorization from current chat settings and
      // a fresh shared runtime control immediately before every remote DELETE mutation.
      await this.assertPhotoDuplicateDeleteIntentStillActionable(intent);
      if (commercialOcrGuardRequired) {
        // FLAG: OCR is asynchronous. Bind every OCR-only DELETE to the current exact message,
        // author immunity, filter setting, runtime rollout and behavior versions at dispatch time.
        const result = await this.commercialOcrDeleteGuard.assertIntentStillActionable({
          intentId: intent.id,
          chatId: intent.chatId,
          messageId: intent.messageId,
          subjectUserId: intent.subjectUserId,
          sourceMessageAt: intent.sourceMessageAt,
          botId,
        });
        if (result === 'absent') {
          throw new ModerationDeleteGuardedMessageAbsentError(
            'guarded_commercial_ocr_predispatch_exact_absence',
          );
        }
      }
      if (intent.linkFamilyDeleteOnly === true) {
        const result = await this.linkHistoryDeleteGuard.assertIntentStillActionable({
          intentId: intent.id,
          chatId: intent.chatId,
          messageId: intent.messageId,
          subjectUserId: intent.subjectUserId,
          botId,
        });
        if (result === 'absent') {
          throw new ModerationDeleteGuardedMessageAbsentError(
            'guarded_link_predispatch_exact_absence',
          );
        }
        if (result !== 'allowed') {
          throw new Error('Guarded link delete intent lost its required reason metadata');
        }
      }
      await options?.beforeDeleteMutation?.();
      if (commercialOcrGuardRequired && finalDispatchLeaseToken) {
        await this.assertCommercialOcrDispatchDeadline(intent.id, finalDispatchLeaseToken, botId);
      }
    } catch (error: unknown) {
      if (error instanceof ModerationDeleteGuardedMessageAbsentError) {
        throw error;
      }
      throw new ModerationDeletePreDispatchGuardError(error);
    }
  }

  private async assertCommercialOcrDispatchDeadline(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<void> {
    // FLAG: This database-clock fence is the final await before MAX DELETE. The earlier OCR guard
    // performs network and immunity checks that may outlive the durable OCR authorization window.
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents" intent
      SET "updated_at" = CURRENT_TIMESTAMP
      WHERE intent."id" = ${intentId}
        AND intent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND intent."lease_token" = ${leaseToken}
        AND intent."lease_expires_at" > CURRENT_TIMESTAMP
        AND intent."delete_dispatch_started_at" IS NOT NULL
        AND intent."delete_dispatch_started_bot_id" = ${botId}
        AND (
          intent."commercial_ocr_guard_required"
          OR EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" ocr_reason
            WHERE ocr_reason."intent_id" = intent."id"
              AND ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
          )
        )
        AND COALESCE(intent."commercial_ocr_deadline_at", intent."retry_until_at")
          > CURRENT_TIMESTAMP
    `);
    if (changed === 0) {
      throw new CommercialOcrDeleteGuardRejectedError(
        'commercial_ocr_deadline_expired',
        'Commercial OCR deletion deadline expired before dispatch',
      );
    }
  }

  private isTerminalDeleteGuardRejection(error: unknown): boolean {
    const code = this.firstString(this.asRecord(error)?.code);
    if (
      code === 'moderation_delete_reason_missing' ||
      code === CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE ||
      code === CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE ||
      code === NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE
    ) {
      return true;
    }
    return (
      code === 'commercial_ocr_runtime_disabled' ||
      code === 'commercial_ocr_runtime_revoked' ||
      code === 'commercial_ocr_runtime_control_changed' ||
      code === 'commercial_ocr_runtime_control_expired' ||
      code === 'commercial_ocr_deadline_expired' ||
      code === 'commercial_ocr_version_changed' ||
      code === 'commercial_ocr_binding_invalid' ||
      code === 'commercial_ocr_binding_ambiguous' ||
      code === 'commercial_ocr_reason_missing' ||
      code === 'commercial_ocr_author_immune' ||
      code === 'commercial_ocr_source_timestamp_changed' ||
      code === 'commercial_ocr_filter_disabled' ||
      code === 'commercial_ocr_policy_changed' ||
      code === 'commercial_ocr_admin_immune' ||
      code === 'commercial_ocr_message_changed' ||
      code === 'commercial_ocr_participant_immune'
    );
  }

  private async assertNightModeCloseNoticeCleanupStillAuthorized(intent: IntentRow): Promise<void> {
    if (
      intent.nightModeCloseNoticeCleanupReason !== true ||
      intent.nightModeCloseNoticeCleanupOnly !== true
    ) {
      return;
    }
    let binding = parseNightModeCloseNoticeCleanupBinding(
      intent.nightModeCloseNoticeCleanupBinding,
    );
    if (intent.nightModeCloseNoticeCleanupBinding != null && !binding) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Night mode close notice cleanup lost its exact persisted binding',
      );
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: intent.chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            rules: {
              select: {
                publishedUrl: true,
                publishedMessageId: true,
              },
            },
          },
        },
      },
    });
    const snapshot = settings ? resolveNightModeTransitionSnapshot(settings) : null;
    if (
      !settings?.nightModeEnabled ||
      settings.chat?.entityType !== 'CHAT' ||
      intent.entityType !== 'CHAT' ||
      !snapshot ||
      snapshot.status !== 'open'
    ) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Night mode close notice cleanup became stale after disable or reschedule',
      );
    }

    if (!binding) {
      binding = await this.reconstructLegacyNightModeCloseNoticeCleanupBinding(
        intent,
        settings,
        snapshot.sessionKey,
      );
    }
    if (
      binding.event.messageId !== intent.messageId ||
      snapshot.sessionKey !== binding.sessionKey ||
      buildNightModeTransitionScheduleFingerprint(settings) !== binding.scheduleFingerprint ||
      buildNightModeTransitionSideEffectFingerprint(settings) !== binding.sideEffectFingerprint
    ) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Night mode close notice cleanup became stale after disable or reschedule',
      );
    }

    const boundEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        id: binding.event.id,
        chatId: intent.chatId,
        messageId: intent.messageId,
        botId: intent.originBotId,
        ruleCode: binding.event.ruleCode,
        metadata: {
          path: ['sessionKey'],
          equals: binding.sessionKey,
        } satisfies Prisma.JsonFilter,
      },
      select: { id: true },
    });
    if (!boundEvent) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Night mode close notice cleanup event binding no longer matches',
      );
    }
  }

  private async reconstructLegacyNightModeCloseNoticeCleanupBinding(
    intent: IntentRow,
    settings: Parameters<typeof buildNightModeTransitionSideEffectFingerprint>[0],
    currentSessionKey: string,
  ): Promise<NightModeCloseNoticeCleanupBinding> {
    const originBotId = intent.originBotId?.trim() ?? '';
    if (!originBotId || typeof this.prisma.moderationEvent?.findMany !== 'function') {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Legacy night mode close notice cleanup has no exact event proof',
      );
    }
    const candidates = await this.prisma.moderationEvent.findMany({
      where: {
        chatId: intent.chatId,
        messageId: intent.messageId,
        botId: originBotId,
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        metadata: {
          path: ['sessionKey'],
          equals: currentSessionKey,
        } satisfies Prisma.JsonFilter,
      },
      select: {
        id: true,
        messageId: true,
        botId: true,
        metadata: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 2,
    });
    const matching = candidates.filter((event) => {
      const metadata = this.asRecord(event.metadata);
      return (
        event.messageId === intent.messageId &&
        event.botId === originBotId &&
        this.firstString(metadata?.sessionKey) === currentSessionKey
      );
    });
    if (matching.length !== 1) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Legacy night mode close notice cleanup event proof is missing or ambiguous',
      );
    }

    let binding: NightModeCloseNoticeCleanupBinding = {
      version: 1,
      sessionKey: currentSessionKey,
      scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(settings),
      sideEffectFingerprint: buildNightModeTransitionSideEffectFingerprint(settings),
      event: {
        id: matching[0]!.id,
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        messageId: intent.messageId,
      },
    };
    const persisted = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intent_reasons" reason
      SET
        "metadata" = jsonb_set(
          COALESCE(reason."metadata", CAST('{}' AS JSONB)),
          CAST(ARRAY['nightModeCloseNoticeCleanup'] AS TEXT[]),
          CAST(${JSON.stringify(binding)} AS JSONB),
          TRUE
        ),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE reason."intent_id" = ${intent.id}
        AND reason."rule_code" = ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
        AND reason."metadata"->'nightModeCloseNoticeCleanup' IS NULL
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intents" parent
          WHERE parent."id" = reason."intent_id"
            AND parent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND parent."lease_token" = ${intent.leaseToken}
            AND parent."lease_expires_at" > CURRENT_TIMESTAMP
        )
    `);
    if (persisted !== 1) {
      const existingReason = await this.prisma.moderationDeleteIntentReason.findFirst({
        where: {
          intentId: intent.id,
          ruleCode: NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE,
        },
        select: { metadata: true },
      });
      const existingBinding = parseNightModeCloseNoticeCleanupBinding(
        this.asRecord(existingReason?.metadata)?.nightModeCloseNoticeCleanup,
      );
      if (JSON.stringify(existingBinding) !== JSON.stringify(binding)) {
        throw new NightModeCloseNoticeCleanupGuardRejectedError(
          'Legacy night mode close notice cleanup binding changed before backfill',
        );
      }
      binding = existingBinding!;
    }
    intent.nightModeCloseNoticeCleanupBinding = binding;
    return binding;
  }

  private async assertChannelAutoPostCleanupStillAuthorized(
    intent: IntentRow,
    botId: string,
  ): Promise<void> {
    if (
      intent.channelAutoPostCleanupReason !== true ||
      this.hasExecutableReasonIgnoringChannelAutoPostCleanup(intent)
    ) {
      return;
    }
    const chat = await this.prisma.chat.findUnique({
      where: { id: intent.chatId },
      select: { entityType: true },
    });
    if (chat?.entityType !== 'CHANNEL') {
      throw new ChannelAutoPostCleanupEntityGuardRejectedError(
        intent.chatId,
        chat?.entityType ?? null,
      );
    }

    const snapshot = await this.maxClient.getChatSnapshot(intent.chatId, {
      botId,
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      timeoutMs: this.deleteTimeoutMs,
    });
    if (snapshot.entityType !== 'channel') {
      throw new ChannelAutoPostCleanupEntityGuardRejectedError(intent.chatId, snapshot.entityType);
    }

    const senderId = intent.subjectUserId?.trim() || null;
    if (!senderId) {
      throw new ChannelAutoPostCleanupSenderGuardRejectedError(intent.chatId, null);
    }
    const senderAccess = await this.maxClient.getChatMemberAccess(intent.chatId, senderId, {
      botId,
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      timeoutMs: this.deleteTimeoutMs,
    });
    if (senderAccess?.isAdmin !== true && senderAccess?.isOwner !== true) {
      throw new ChannelAutoPostCleanupSenderGuardRejectedError(intent.chatId, senderId);
    }
  }

  private async resolveDeleteIntentCommercialOcrGuard(intent: IntentRow): Promise<boolean> {
    // An old writer may finish after the additive migration and rely on the column default. The
    // durable reason remains authoritative, so dispatch must discover it even when the row flag is
    // false. Invalid legacy bindings then fail closed in the OCR guard.
    const reason = await this.prisma.moderationDeleteIntentReason.findFirst({
      where: { intentId: intent.id },
      select: { id: true },
    });
    if (!reason) {
      throw new ModerationDeleteReasonMissingError();
    }
    if (this.hasExecutableNonCommercialOcrReason(intent)) {
      return false;
    }
    if (intent.commercialOcrGuardRequired === true) {
      return true;
    }
    const commercialOcrReason = await this.prisma.moderationDeleteIntentReason.findFirst({
      where: { intentId: intent.id, ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE },
      select: { id: true },
    });
    return commercialOcrReason !== null;
  }

  private async assertPhotoDuplicateDeleteIntentStillActionable(intent: IntentRow): Promise<void> {
    if (intent.photoDuplicateDeleteOnly !== true) {
      return;
    }

    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: intent.id },
      select: { ruleCode: true, metadata: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (reasons.length === 0) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_reason_missing',
        'Photo duplicate delete intent lost its required reason metadata',
      );
    }

    const fences: PhotoDuplicateDeleteReasonFence[] = [];
    for (const reason of reasons) {
      if (reason.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE) {
        continue;
      }
      const metadata = this.asRecord(reason.metadata);
      if (
        reason.ruleCode !== 'DUPLICATE_DELETE' ||
        this.firstString(metadata?.duplicateSource) !== 'photo'
      ) {
        // An independent reason still owns the same deletion, so photo rollout controls must not
        // suppress it.
        return;
      }
      const fence = this.parsePhotoDuplicateDeleteReasonFence(metadata);
      if (!fence) {
        throw new PhotoDuplicateDeleteIntentGuardRejectedError(
          'photo_duplicate_reason_invalid',
          'Photo duplicate delete intent has no valid preset, scope and match-kind fence',
        );
      }
      fences.push(fence);
    }
    if (fences.length === 0) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_reason_missing',
        'Photo duplicate delete intent lost its required reason metadata',
      );
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: intent.chatId },
      select: {
        antiDuplicateEnabled: true,
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: true,
        duplicatePhotoScope: true,
      },
    });
    if (!settings?.antiDuplicateEnabled || !settings.duplicatePhotoEnabled) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_settings_disabled',
        'Photo duplicate deletion is no longer enabled for this chat',
      );
    }
    if (
      fences.some(
        (fence) =>
          fence.preset !== settings.duplicatePhotoMatchPreset ||
          fence.scope !== settings.duplicatePhotoScope,
      )
    ) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_settings_changed',
        'Photo duplicate preset or scope changed after the delete intent was recorded',
      );
    }

    const policy = await this.photoDuplicateRuntimePolicy.resolveEffectivePolicy({
      chatId: intent.chatId,
      preset: settings.duplicatePhotoMatchPreset,
      scope: settings.duplicatePhotoScope,
    });
    if (!policy.enforce) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_runtime_downgraded',
        'Photo duplicate runtime control no longer authorizes deletion',
      );
    }
    if (fences.some((fence) => !isPhotoDuplicateMatchKindAllowed(policy, fence.matchKind))) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_match_kind_disabled',
        'Photo duplicate match kind is no longer authorized by runtime control',
      );
    }
  }

  private parsePhotoDuplicateDeleteReasonFence(
    metadata: Record<string, unknown> | null,
  ): PhotoDuplicateDeleteReasonFence | null {
    const matchKind = this.firstString(metadata?.matchKind);
    const preset = this.firstString(metadata?.preset);
    const scope = this.firstString(metadata?.scope);
    if (
      !PHOTO_DUPLICATE_MATCH_KINDS.includes(matchKind as PhotoDuplicateMatchKind) ||
      (preset !== 'SAME_IMAGE' && preset !== 'MINOR_EDITS') ||
      (scope !== 'SAME_AUTHOR' && scope !== 'CHAT')
    ) {
      return null;
    }
    return {
      matchKind: matchKind as PhotoDuplicateMatchKind,
      preset,
      scope,
    };
  }

  private async persistIntent(
    input: EnsureModerationDeleteIntentInput,
    enqueue: boolean,
    transactionClient?: Prisma.TransactionClient,
  ): Promise<EnsureModerationDeleteIntentResult> {
    const normalized = this.normalizeInput(input);
    const rollout = this.getRolloutForRule(normalized.chatId, normalized.ruleCode);
    if (rollout === 'off') {
      return { intentId: null, rollout, status: null };
    }

    const initialStatus: ModerationDeleteIntentStatus =
      rollout === 'observed'
        ? 'OBSERVED'
        : normalized.retryUntilAt.getTime() <= Date.now()
          ? 'EXPIRED'
          : 'PENDING';
    const intentId = randomUUID();
    const reasonId = randomUUID();
    const metadataJson = this.serializeMetadata(normalized.event.metadata);
    const shouldAdoptReplacementRouting =
      this.isReplacementCleanupRuleCode(normalized.ruleCode) &&
      normalized.entityType === 'CHAT' &&
      normalized.messageAuthorKind === 'user' &&
      normalized.routingPolicy !== 'origin_only';
    // Historical BOT_MESSAGE_AUTO_DELETE rows were shadow observations. They must never become
    // executable merely because the rollout policy changed and the same webhook is replayed.
    const shouldPromoteObserved =
      normalized.ruleCode === BOT_MESSAGE_AUTO_DELETE_RULE_CODE
        ? Prisma.sql`FALSE`
        : Prisma.sql`
            "moderation_delete_intents"."status" = CAST(
              'OBSERVED' AS "ModerationDeleteIntentStatus"
            )
            AND EXCLUDED."status" <> CAST('OBSERVED' AS "ModerationDeleteIntentStatus")
          `;
    const hasStoredCommercialOcrReason = Prisma.sql`
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" existing_ocr_reason
        WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
          AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
      )
    `;
    const resultingHasCommercialOcrReason = Prisma.sql`(
      "moderation_delete_intents"."commercial_ocr_guard_required"
      OR EXCLUDED."commercial_ocr_guard_required"
      OR ${hasStoredCommercialOcrReason}
    )`;
    const shouldAdoptIndependentChannelCleanupContext = Prisma.sql`(
      ${normalized.ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
      AND ${normalized.entityType !== null}
      AND EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" stored_channel_cleanup_reason
        WHERE stored_channel_cleanup_reason."intent_id" = "moderation_delete_intents"."id"
          AND stored_channel_cleanup_reason."rule_code" =
            ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
      )
      AND EXISTS (
        SELECT 1
        FROM "chats" current_entity
        WHERE current_entity."id" = "moderation_delete_intents"."chat_id"
          AND current_entity."entity_type" = EXCLUDED."entity_type"
      )
    )`;

    const persist = async (tx: Prisma.TransactionClient) => {
      const rows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
        INSERT INTO "moderation_delete_intents" (
          "id", "chat_id", "message_id", "subject_user_id", "source_message_at",
          "entity_type", "message_author_kind", "origin_bot_id", "routing_policy",
          "commercial_ocr_guard_required", "commercial_ocr_deadline_at", "status",
          "execute_at", "next_attempt_at",
          "retry_until_at", "completed_at", "created_at", "updated_at"
        ) VALUES (
          ${intentId}, ${normalized.chatId}, ${normalized.messageId}, ${normalized.subjectUserId},
          ${normalized.sourceMessageAt}, CAST(${normalized.entityType} AS "ChatEntityType"),
          ${normalized.messageAuthorKind}, ${normalized.originBotId}, ${normalized.routingPolicy},
          ${normalized.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE},
          ${normalized.commercialOcrDeadlineAt},
          CAST(${initialStatus} AS "ModerationDeleteIntentStatus"), ${normalized.executeAt},
          ${normalized.executeAt}, ${normalized.retryUntilAt},
          ${initialStatus === 'EXPIRED' ? new Date() : null}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("chat_id", "message_id") DO UPDATE SET
          "status" = CASE
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."status"
            ELSE "moderation_delete_intents"."status"
          END,
          "subject_user_id" = COALESCE(
            "moderation_delete_intents"."subject_user_id",
            EXCLUDED."subject_user_id"
          ),
          "source_message_at" = CASE
            WHEN ${normalized.ruleCode === LINK_BLOCKED_DELETE_RULE_CODE}
              AND "moderation_delete_intents"."status" NOT IN (
                CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
                CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
              )
              AND EXCLUDED."source_message_at" IS NOT NULL
              AND (
                "moderation_delete_intents"."source_message_at" IS NULL
                OR "moderation_delete_intents"."source_message_at" < EXCLUDED."source_message_at"
              )
            THEN EXCLUDED."source_message_at"
            ELSE COALESCE(
              "moderation_delete_intents"."source_message_at",
              EXCLUDED."source_message_at"
            )
          END,
          "origin_bot_id" = CASE
            WHEN ${shouldPromoteObserved} OR ${shouldAdoptIndependentChannelCleanupContext}
            THEN COALESCE(EXCLUDED."origin_bot_id", "moderation_delete_intents"."origin_bot_id")
            ELSE COALESCE("moderation_delete_intents"."origin_bot_id", EXCLUDED."origin_bot_id")
          END,
          "entity_type" = CASE
            WHEN ${shouldPromoteObserved} OR ${shouldAdoptIndependentChannelCleanupContext}
            THEN COALESCE(EXCLUDED."entity_type", "moderation_delete_intents"."entity_type")
            ELSE COALESCE("moderation_delete_intents"."entity_type", EXCLUDED."entity_type")
          END,
          "message_author_kind" = CASE
            WHEN ${shouldPromoteObserved} OR ${shouldAdoptIndependentChannelCleanupContext}
            THEN COALESCE(
              EXCLUDED."message_author_kind",
              "moderation_delete_intents"."message_author_kind"
            )
            ELSE COALESCE(
              "moderation_delete_intents"."message_author_kind",
              EXCLUDED."message_author_kind"
            )
          END,
          "routing_policy" = CASE
            WHEN ${shouldPromoteObserved} OR ${shouldAdoptIndependentChannelCleanupContext}
            THEN EXCLUDED."routing_policy"
            WHEN ${shouldAdoptReplacementRouting}
              AND EXCLUDED."routing_policy" = 'delete_capable'
            THEN EXCLUDED."routing_policy"
            WHEN ${shouldAdoptReplacementRouting}
              AND EXCLUDED."routing_policy" = 'origin_first'
              AND "moderation_delete_intents"."routing_policy" = 'origin_only'
            THEN EXCLUDED."routing_policy"
            ELSE "moderation_delete_intents"."routing_policy"
          END,
          "commercial_ocr_guard_required" = (
            ${resultingHasCommercialOcrReason}
          ),
          "commercial_ocr_deadline_at" = CASE
            WHEN ${resultingHasCommercialOcrReason}
            THEN COALESCE(
              "moderation_delete_intents"."commercial_ocr_deadline_at",
              EXCLUDED."commercial_ocr_deadline_at",
              "moderation_delete_intents"."retry_until_at"
            )
            ELSE "moderation_delete_intents"."commercial_ocr_deadline_at"
          END,
          "execute_at" = CASE
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."execute_at"
            ELSE "moderation_delete_intents"."execute_at"
          END,
          "next_attempt_at" = CASE
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."next_attempt_at"
            ELSE "moderation_delete_intents"."next_attempt_at"
          END,
          "retry_until_at" = CASE
            WHEN ${resultingHasCommercialOcrReason} AND ${shouldPromoteObserved}
            THEN GREATEST(
              "moderation_delete_intents"."retry_until_at",
              EXCLUDED."retry_until_at"
            )
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."retry_until_at"
            ELSE "moderation_delete_intents"."retry_until_at"
          END,
          "completed_at" = CASE
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."completed_at"
            ELSE "moderation_delete_intents"."completed_at"
          END,
          "updated_at" = CURRENT_TIMESTAMP
        RETURNING
          "id",
          "chat_id" AS "chatId",
          "message_id" AS "messageId",
          "subject_user_id" AS "subjectUserId",
          "source_message_at" AS "sourceMessageAt",
          "entity_type" AS "entityType",
          "message_author_kind" AS "messageAuthorKind",
          "origin_bot_id" AS "originBotId",
          "routing_policy" AS "routingPolicy",
          "commercial_ocr_guard_required" AS "commercialOcrGuardRequired",
          "commercial_ocr_deadline_at" AS "commercialOcrDeadlineAt",
          "status",
          "execute_at" AS "executeAt",
          "next_attempt_at" AS "nextAttemptAt",
          "retry_until_at" AS "retryUntilAt",
          "attempt_count" AS "attemptCount",
          "last_bot_id" AS "lastBotId",
          "succeeded_bot_id" AS "succeededBotId",
          "delete_dispatch_started_at" AS "deleteDispatchStartedAt",
          "delete_dispatch_started_bot_id" AS "deleteDispatchStartedBotId",
          "remote_delete_succeeded_at" AS "remoteDeleteSucceededAt",
          "remote_delete_succeeded_bot_id" AS "remoteDeleteSucceededBotId",
          "candidate_failures" AS "candidateFailures",
          "last_status_code" AS "lastStatusCode",
          "last_error_code" AS "lastErrorCode",
          "last_error" AS "lastError",
          "lease_token" AS "leaseToken",
          "lease_expires_at" AS "leaseExpiresAt",
          "leased_from_status" AS "leasedFromStatus"
      `);
      const intent = rows[0];
      if (!intent) {
        throw new Error('Failed to persist moderation delete intent');
      }

      const conflictReasonChanged = await tx.$executeRaw(Prisma.sql`
        WITH changed_reason AS (
          INSERT INTO "moderation_delete_intent_reasons" (
            "id", "intent_id", "reason_key", "user_id", "event_type", "rule_code",
            "masked_excerpt", "score", "metadata", "created_at", "updated_at"
          ) VALUES (
            ${reasonId}, ${intent.id}, ${normalized.reasonKey}, ${normalized.event.userId},
            CAST(${normalized.event.eventType} AS "EventType"), ${normalized.ruleCode},
            ${normalized.event.maskedExcerpt}, ${normalized.event.score},
            CAST(${metadataJson} AS JSONB), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT ("intent_id", "reason_key") DO UPDATE SET
            "rule_code" = EXCLUDED."rule_code",
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "moderation_delete_intent_reasons"."rule_code" <> EXCLUDED."rule_code"
            AND EXCLUDED."rule_code" IN (${Prisma.join([
              ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
            ])})
          RETURNING 1
        )
        UPDATE "moderation_delete_intents" schedule
        SET
          "execute_at" = LEAST(schedule."execute_at", ${normalized.executeAt}),
          "next_attempt_at" = LEAST(schedule."next_attempt_at", ${normalized.executeAt}),
          "retry_until_at" = GREATEST(schedule."retry_until_at", ${normalized.retryUntilAt}),
          "updated_at" = CURRENT_TIMESTAMP
        WHERE schedule."id" = ${intent.id}
          AND schedule."id" <> ${intentId}
          AND EXISTS (SELECT 1 FROM changed_reason)
      `);
      const reasonChanged = intent.id === intentId ? 1 : conflictReasonChanged;
      if (reasonChanged === 1 && intent.id !== intentId) {
        intent.executeAt = new Date(
          Math.min(intent.executeAt.getTime(), normalized.executeAt.getTime()),
        );
        intent.nextAttemptAt = new Date(
          Math.min(intent.nextAttemptAt.getTime(), normalized.executeAt.getTime()),
        );
        intent.retryUntilAt = new Date(
          Math.max(intent.retryUntilAt.getTime(), normalized.retryUntilAt.getTime()),
        );
      }
      let storedNonCommercialOcrDeleteReason: boolean | undefined;
      let storedReplacementCleanup: boolean | undefined;
      let storedNonChannelReplacementCleanup: boolean | undefined;
      let storedChannelAutoPostCleanupReason: boolean | undefined;
      let storedBotMessageAutoDeleteReason: boolean | undefined;
      let storedRequiredSubscriptionDeleteReason: boolean | undefined;
      if (intent.id !== intentId && normalized.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE) {
        const reasonState = await tx.$queryRaw<
          Array<{
            nonCommercialOcrDeleteReason: boolean;
            replacementCleanup: boolean;
            nonChannelReplacementCleanup: boolean;
            channelAutoPostCleanupReason: boolean;
            botMessageAutoDeleteReason: boolean;
            requiredSubscriptionDeleteReason: boolean;
          }>
        >(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_non_ocr_reason
            WHERE existing_non_ocr_reason."intent_id" = ${intent.id}
              AND existing_non_ocr_reason."rule_code" <> ${COMMERCIAL_OCR_DELETE_RULE_CODE}
              AND existing_non_ocr_reason."rule_code" <>
                ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
          ) AS "nonCommercialOcrDeleteReason",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_replacement_reason
            WHERE existing_replacement_reason."intent_id" = ${intent.id}
              AND existing_replacement_reason."rule_code" IN (${Prisma.join([
                ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
              ])})
          ) AS "replacementCleanup",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_non_channel_replacement_reason
            WHERE existing_non_channel_replacement_reason."intent_id" = ${intent.id}
              AND existing_non_channel_replacement_reason."rule_code" IN (${Prisma.join([
                ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES.filter(
                  (ruleCode) =>
                    ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE,
                ),
              ])})
          ) AS "nonChannelReplacementCleanup",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_channel_cleanup_reason
            WHERE existing_channel_cleanup_reason."intent_id" = ${intent.id}
              AND existing_channel_cleanup_reason."rule_code" =
                ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
          ) AS "channelAutoPostCleanupReason",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_auto_delete_reason
            WHERE existing_auto_delete_reason."intent_id" = ${intent.id}
              AND existing_auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
          ) AS "botMessageAutoDeleteReason",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_required_subscription_reason
            WHERE existing_required_subscription_reason."intent_id" = ${intent.id}
              AND existing_required_subscription_reason."rule_code" =
                ${REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE}
          ) AS "requiredSubscriptionDeleteReason"
        `);
        storedNonCommercialOcrDeleteReason = reasonState[0]?.nonCommercialOcrDeleteReason === true;
        storedReplacementCleanup = reasonState[0]?.replacementCleanup === true;
        storedNonChannelReplacementCleanup =
          typeof reasonState[0]?.nonChannelReplacementCleanup === 'boolean'
            ? reasonState[0].nonChannelReplacementCleanup
            : undefined;
        storedChannelAutoPostCleanupReason =
          typeof reasonState[0]?.channelAutoPostCleanupReason === 'boolean'
            ? reasonState[0].channelAutoPostCleanupReason
            : undefined;
        storedBotMessageAutoDeleteReason = reasonState[0]?.botMessageAutoDeleteReason === true;
        storedRequiredSubscriptionDeleteReason =
          reasonState[0]?.requiredSubscriptionDeleteReason === true;
      } else if (
        intent.id !== intentId &&
        this.requiredSubscriptionDeleteEnabled &&
        normalized.ruleCode !== REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE
      ) {
        const reasonState = await tx.$queryRaw<
          Array<{ requiredSubscriptionDeleteReason: boolean }>
        >(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_required_subscription_reason
            WHERE existing_required_subscription_reason."intent_id" = ${intent.id}
              AND existing_required_subscription_reason."rule_code" =
                ${REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE}
          ) AS "requiredSubscriptionDeleteReason"
        `);
        storedRequiredSubscriptionDeleteReason =
          reasonState[0]?.requiredSubscriptionDeleteReason === true;
      }
      let effectiveIntent = intent;
      if (
        reasonChanged === 1 &&
        initialStatus === 'PENDING' &&
        normalized.ruleCode !== 'BOT_MESSAGE_AUTO_DELETE' &&
        this.isReplacementCleanupRuleCode(normalized.ruleCode) &&
        intent.status === 'FAILED_TERMINAL' &&
        intent.lastErrorCode === 'managed_output_auto_delete_blocked'
      ) {
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            AND "last_error_code" = 'managed_output_auto_delete_blocked'
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      if (
        reasonChanged === 1 &&
        effectiveIntent === intent &&
        initialStatus === 'PENDING' &&
        normalized.ruleCode !== BOT_MESSAGE_AUTO_DELETE_RULE_CODE &&
        intent.status === 'FAILED_TERMINAL' &&
        intent.lastErrorCode === BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE
      ) {
        // FLAG: Any later executable reason owns an independent deletion and must not remain
        // hidden behind the bounded best-effort bot-message cleanup decision.
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CAST('PENDING' AS "ModerationDeleteIntentStatus"),
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            AND "last_error_code" = ${BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE}
            AND "remote_delete_succeeded_at" IS NULL
            AND "remote_delete_succeeded_bot_id" IS NULL
            AND "delete_dispatch_started_at" IS NULL
            AND "delete_dispatch_started_bot_id" IS NULL
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      if (
        effectiveIntent === intent &&
        initialStatus === 'PENDING' &&
        normalized.ruleCode === LINK_BLOCKED_DELETE_RULE_CODE &&
        normalized.messageAuthorKind === 'user' &&
        normalized.sourceMessageAt &&
        (intent.status === 'EXPIRED' || intent.status === 'FAILED_TERMINAL') &&
        (!intent.sourceMessageAt || normalized.sourceMessageAt > intent.sourceMessageAt)
      ) {
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "source_message_at" = ${normalized.sourceMessageAt},
            "attempt_count" = 0,
            "first_attempt_at" = NULL,
            "last_attempt_at" = NULL,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" IN (
              CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
              CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            )
            AND (
              "source_message_at" IS NULL
              OR "source_message_at" < ${normalized.sourceMessageAt}
            )
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      if (
        reasonChanged === 1 &&
        effectiveIntent === intent &&
        intent.status === 'EXPIRED' &&
        initialStatus === 'PENDING' &&
        this.isReplacementCleanupRecoveryReason(normalized.reasonKey) &&
        this.isReplacementCleanupRuleCode(normalized.ruleCode)
      ) {
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      if (
        reasonChanged === 1 &&
        effectiveIntent === intent &&
        initialStatus === 'PENDING' &&
        normalized.ruleCode !== COMMERCIAL_OCR_DELETE_RULE_CODE &&
        intent.commercialOcrGuardRequired === true &&
        (intent.status === 'EXPIRED' || intent.status === 'FAILED_TERMINAL')
      ) {
        // FLAG: A newly committed independent reason must not remain hidden behind an earlier
        // terminal OCR-only decision. Concurrent IN_PROGRESS merges are handled by the locked
        // terminal guard boundary below.
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "commercial_ocr_guard_required" = TRUE
            AND "remote_delete_succeeded_at" IS NULL
            AND "remote_delete_succeeded_bot_id" IS NULL
            AND "delete_dispatch_started_at" IS NULL
            AND "delete_dispatch_started_bot_id" IS NULL
            AND (
              "status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
              OR (
                "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
                AND (
                  "last_error_code" LIKE 'commercial_ocr_%'
                  OR "last_error_code" = 'moderation_delete_reason_missing'
                )
              )
            )
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      if (
        reasonChanged === 1 &&
        effectiveIntent === intent &&
        initialStatus === 'PENDING' &&
        normalized.ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE &&
        normalized.ruleCode !== NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE &&
        normalized.entityType !== null &&
        intent.status === 'FAILED_TERMINAL' &&
        (intent.lastErrorCode === CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE ||
          intent.lastErrorCode === CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE ||
          intent.lastErrorCode === NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE)
      ) {
        // FLAG: A later independent reason must not inherit a terminal cleanup-generation mismatch.
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "entity_type" = CAST(${normalized.entityType} AS "ChatEntityType"),
            "message_author_kind" = COALESCE(
              ${normalized.messageAuthorKind},
              "message_author_kind"
            ),
            "origin_bot_id" = COALESCE(${normalized.originBotId}, "origin_bot_id"),
            "routing_policy" = ${normalized.routingPolicy},
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            AND "last_error_code" IN (
              ${CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE},
              ${CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE},
              ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE}
            )
            AND "remote_delete_succeeded_at" IS NULL
            AND "remote_delete_succeeded_bot_id" IS NULL
            AND "delete_dispatch_started_at" IS NULL
            AND "delete_dispatch_started_bot_id" IS NULL
            AND EXISTS (
              SELECT 1
              FROM "chats" current_entity
              WHERE current_entity."id" = "moderation_delete_intents"."chat_id"
                AND current_entity."entity_type" =
                  CAST(${normalized.entityType} AS "ChatEntityType")
            )
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      await this.linkReplacementCleanupIntent(tx, normalized, effectiveIntent.id);
      if (effectiveIntent.status === 'SUCCEEDED') {
        await this.materializeModerationEventsForIntent(tx, effectiveIntent.id);
      }
      if (storedNonCommercialOcrDeleteReason !== undefined) {
        effectiveIntent.nonCommercialOcrDeleteReason = storedNonCommercialOcrDeleteReason;
      }
      if (storedReplacementCleanup !== undefined) {
        effectiveIntent.replacementCleanup = storedReplacementCleanup;
      }
      if (storedNonChannelReplacementCleanup !== undefined) {
        effectiveIntent.nonChannelReplacementCleanup = storedNonChannelReplacementCleanup;
      }
      if (storedChannelAutoPostCleanupReason !== undefined) {
        effectiveIntent.channelAutoPostCleanupReason = storedChannelAutoPostCleanupReason;
      }
      if (storedBotMessageAutoDeleteReason !== undefined) {
        effectiveIntent.botMessageAutoDeleteReason = storedBotMessageAutoDeleteReason;
      }
      if (storedRequiredSubscriptionDeleteReason !== undefined) {
        effectiveIntent.requiredSubscriptionDeleteReason = storedRequiredSubscriptionDeleteReason;
      }
      return effectiveIntent;
    };
    const persisted = transactionClient
      ? await persist(transactionClient)
      : await this.prisma.$transaction(persist);
    persisted.replacementCleanup =
      persisted.replacementCleanup === true ||
      this.isReplacementCleanupRuleCode(normalized.ruleCode);
    const normalizedNonChannelReplacementCleanup =
      this.isReplacementCleanupRuleCode(normalized.ruleCode) &&
      normalized.ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE;
    if (
      persisted.nonChannelReplacementCleanup !== undefined ||
      normalizedNonChannelReplacementCleanup
    ) {
      persisted.nonChannelReplacementCleanup =
        persisted.nonChannelReplacementCleanup === true || normalizedNonChannelReplacementCleanup;
    }
    if (
      persisted.channelAutoPostCleanupReason !== undefined ||
      normalized.ruleCode === CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE
    ) {
      persisted.channelAutoPostCleanupReason =
        persisted.channelAutoPostCleanupReason === true ||
        normalized.ruleCode === CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE;
    }
    persisted.botMessageAutoDeleteReason =
      persisted.botMessageAutoDeleteReason === true ||
      normalized.ruleCode === BOT_MESSAGE_AUTO_DELETE_RULE_CODE;
    persisted.requiredSubscriptionDeleteReason =
      persisted.requiredSubscriptionDeleteReason === true ||
      normalized.ruleCode === REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE;
    persisted.commercialOcrDeleteReason =
      persisted.commercialOcrGuardRequired ||
      normalized.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE;
    persisted.nonCommercialOcrDeleteReason =
      persisted.nonCommercialOcrDeleteReason === true ||
      normalized.ruleCode !== COMMERCIAL_OCR_DELETE_RULE_CODE;

    const effectiveRollout =
      persisted.status !== 'OBSERVED' && this.isExecutionEnabledForIntent(persisted)
        ? 'execute'
        : 'observed';
    if (enqueue && effectiveRollout === 'execute') {
      try {
        await this.enqueueWakeup(persisted, DELETE_QUEUE_PRIORITY_INTERACTIVE);
      } catch (error: unknown) {
        this.logger.warn(
          { intentId: persisted.id, err: this.errorMessage(error) },
          'Failed to enqueue persisted moderation delete intent; DB sweeper will retry',
        );
      }
    }
    return { intentId: persisted.id, rollout: effectiveRollout, status: persisted.status };
  }

  private async claimOne(intentId: string): Promise<IntentRow | null> {
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    const rows = await this.prisma.$queryRaw<IntentRow[]>(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus"),
        "lease_token" = ${leaseToken},
        "lease_expires_at" = ${leaseExpiresAt},
        "leased_from_status" = COALESCE("leased_from_status", "status"),
        "attempt_count" = "attempt_count" + 1,
        "first_attempt_at" = COALESCE("first_attempt_at", ${now}),
        "last_attempt_at" = ${now},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "execute_at" <= ${now}
        AND "next_attempt_at" <= ${now}
        AND (
          "retry_until_at" > ${now}
          OR "remote_delete_succeeded_at" IS NOT NULL
          OR "remote_delete_succeeded_bot_id" IS NOT NULL
          OR "delete_dispatch_started_at" IS NOT NULL
          OR "delete_dispatch_started_bot_id" IS NOT NULL
        )
        AND (
          "status" IN (
            CAST('PENDING' AS "ModerationDeleteIntentStatus"),
            CAST('RETRYABLE' AS "ModerationDeleteIntentStatus"),
            CAST('WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus"),
            CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
          )
          OR (
            "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_expires_at" < ${now}
          )
        )
      RETURNING ${this.intentReturningSql()}
    `);
    return rows[0] ?? null;
  }

  private async selectDueIntentIds(): Promise<Array<{ id: string }>> {
    const now = new Date();
    const rolloutFilter = this.buildSweepRolloutFilter();
    return this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT intent."id"
        FROM "moderation_delete_intents" intent
        WHERE intent."execute_at" <= ${now}
          AND intent."next_attempt_at" <= ${now}
          AND (
            intent."retry_until_at" > ${now}
            OR intent."remote_delete_succeeded_at" IS NOT NULL
            OR intent."remote_delete_succeeded_bot_id" IS NOT NULL
            OR intent."delete_dispatch_started_at" IS NOT NULL
            OR intent."delete_dispatch_started_bot_id" IS NOT NULL
          )
          AND ${rolloutFilter}
          AND (
            intent."status" IN (
              CAST('PENDING' AS "ModerationDeleteIntentStatus"),
              CAST('RETRYABLE' AS "ModerationDeleteIntentStatus"),
              CAST('WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus"),
              CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
            )
            OR (
              intent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
              AND intent."lease_expires_at" < ${now}
            )
          )
        ORDER BY intent."next_attempt_at" ASC, intent."created_at" ASC
        LIMIT ${this.sweepBatchSize}
        FOR UPDATE SKIP LOCKED
      )
      SELECT candidates."id"
      FROM candidates
    `);
  }

  private async finishRetryableAttempt(
    intent: IntentRow,
    leaseToken: string,
    details: DeleteErrorDetails,
  ): Promise<ModerationDeleteAttemptResult> {
    const retryLimitReached =
      details.status !== 'FAILED_TERMINAL' &&
      details.status !== 'EXPIRED' &&
      this.isBotMessageAutoDeleteRetryLimitApplicable(intent) &&
      intent.attemptCount >= BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS;
    if (retryLimitReached) {
      const retryLimitOutcome = await this.enforceBotMessageAutoDeleteRetryLimit(
        intent,
        leaseToken,
        false,
      );
      if (retryLimitOutcome.kind === 'terminal') {
        return this.toAttemptResult(retryLimitOutcome.intent);
      }
      if (retryLimitOutcome.kind === 'lease_lost') {
        return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
      }
      intent = retryLimitOutcome.intent;
    }

    const now = Date.now();
    const requestedNextAt = new Date(now + Math.max(1_000, details.retryDelayMs ?? 1_000));
    const hasRemoteSuccessMarker = this.hasRemoteSuccessMarker(intent);
    const hasUnresolvedDispatch = this.hasDeleteDispatchMarker(intent);
    const hasDefinitiveFollowupPending = hasRemoteSuccessMarker || hasUnresolvedDispatch;
    const waitingForCapability =
      !hasDefinitiveFollowupPending && details.status === 'WAITING_CAPABILITY';
    const expires =
      !hasDefinitiveFollowupPending &&
      (details.status === 'EXPIRED' ||
        (!waitingForCapability && requestedNextAt >= intent.retryUntilAt));
    const terminal = !hasDefinitiveFollowupPending && details.status === 'FAILED_TERMINAL';
    const status: ModerationDeleteIntentStatus = hasDefinitiveFollowupPending
      ? 'AMBIGUOUS'
      : expires
        ? 'EXPIRED'
        : details.status;
    const nextAttemptAt = expires ? intent.retryUntilAt : requestedNextAt;

    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST(${status} AS "ModerationDeleteIntentStatus"),
        "next_attempt_at" = CASE
          WHEN ${waitingForCapability}
          THEN CASE
            WHEN "next_attempt_at" > "last_attempt_at"
              AND "retry_until_at" > CURRENT_TIMESTAMP
            THEN CURRENT_TIMESTAMP
            ELSE LEAST(${requestedNextAt}, "retry_until_at")
          END
          ELSE ${nextAttemptAt}
        END,
        "last_status_code" = ${details.statusCode},
        "last_error_code" = ${details.errorCode},
        "last_error" = ${details.message.slice(0, 2_000)},
        "completed_at" = ${expires || terminal ? new Date() : null},
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intent.id}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
    if (changed === 0) {
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }

    const current = await this.loadRequiredIntent(intent.id);
    if (!TERMINAL_STATUSES.has(current.status)) {
      await this.enqueueWakeup(current);
    }
    return this.toAttemptResult(current);
  }

  private async finishTerminalPreDispatchGuardRejection(
    intent: IntentRow,
    leaseToken: string,
    details: DeleteErrorDetails,
  ): Promise<ModerationDeleteAttemptResult> {
    const current = await this.prisma.$transaction(
      async (tx) => {
        // FLAG: Lock first, then read reason classifiers in a new READ COMMITTED statement. If a
        // concurrent writer owns the row, this waits for its reason insert before terminalizing.
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "moderation_delete_intents"
          WHERE "id" = ${intent.id}
            AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_token" = ${leaseToken}
          FOR UPDATE
        `);
        if (!locked[0]) {
          return null;
        }

        const latestRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          SELECT ${this.intentSelectSql('intent')}
          FROM "moderation_delete_intents" intent
          WHERE intent."id" = ${intent.id}
          LIMIT 1
        `);
        const latest = latestRows[0];
        if (!latest) {
          return null;
        }

        const channelCleanupGuardRejected =
          details.errorCode === CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE ||
          details.errorCode === CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE;
        const nightModeCleanupGuardRejected =
          details.errorCode === NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE;
        const independentReasonExecutable = channelCleanupGuardRejected
          ? this.hasExecutableReasonIgnoringChannelAutoPostCleanup(latest)
          : nightModeCleanupGuardRejected
            ? latest.nightModeCloseNoticeCleanupReason === true &&
              latest.nightModeCloseNoticeCleanupOnly !== true
            : this.hasExecutableNonCommercialOcrReason(latest);
        const now = Date.now();
        // A fresh independent reason does not inherit the obsolete OCR guard failure or its
        // backoff. Requeue it immediately; the next attempt reloads the mixed durable classifiers.
        const requestedNextAt = independentReasonExecutable ? new Date(now) : new Date(now + 1_000);
        const hasDefinitiveFollowupPending =
          this.hasRemoteSuccessMarker(latest) || this.hasDeleteDispatchMarker(latest);
        const expires =
          independentReasonExecutable &&
          !hasDefinitiveFollowupPending &&
          requestedNextAt >= latest.retryUntilAt;
        const status: ModerationDeleteIntentStatus = hasDefinitiveFollowupPending
          ? 'AMBIGUOUS'
          : expires
            ? 'EXPIRED'
            : independentReasonExecutable
              ? 'RETRYABLE'
              : 'FAILED_TERMINAL';
        const nextAttemptAt = expires ? latest.retryUntilAt : requestedNextAt;
        const terminal = status === 'EXPIRED' || status === 'FAILED_TERMINAL';

        const changed = await tx.$executeRaw(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CAST(${status} AS "ModerationDeleteIntentStatus"),
            "next_attempt_at" = ${nextAttemptAt},
            "last_status_code" = ${details.statusCode},
            "last_error_code" = ${details.errorCode},
            "last_error" = ${details.message.slice(0, 2_000)},
            "completed_at" = ${terminal ? new Date() : null},
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_token" = ${leaseToken}
        `);
        if (changed === 0) {
          return null;
        }

        return {
          ...latest,
          status,
          nextAttemptAt,
          lastStatusCode: details.statusCode,
          lastErrorCode: details.errorCode,
          lastError: details.message.slice(0, 2_000),
          leaseToken: null,
          leaseExpiresAt: null,
          leasedFromStatus: null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    const resolved = current ?? (await this.loadRequiredIntent(intent.id));
    if (!TERMINAL_STATUSES.has(resolved.status)) {
      await this.enqueueWakeup(resolved);
    }
    return this.toAttemptResult(resolved);
  }

  private async recordRemoteSuccessAndFinalize(
    intent: IntentRow,
    leaseToken: string,
    botId: string,
  ): Promise<ModerationDeleteAttemptResult> {
    if (this.isBotMessageAutoDeleteOnlyReason(intent)) {
      return this.recordRemoteSuccessPendingVerification(intent, leaseToken, botId);
    }

    let marked: boolean;
    try {
      marked = await this.recordRemoteDeleteSucceeded(intent.id, leaseToken, botId);
    } catch (error: unknown) {
      return this.persistRemoteSuccessFallback(intent, leaseToken, botId, error);
    }
    if (!marked) {
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }
    return this.finalizeRecordedRemoteSuccess(
      {
        ...intent,
        lastBotId: botId,
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: botId,
      },
      leaseToken,
      botId,
    );
  }

  private async recordRemoteSuccessPendingVerification(
    intent: IntentRow,
    leaseToken: string,
    botId: string,
  ): Promise<ModerationDeleteAttemptResult> {
    const nextAttemptAt = new Date(Date.now() + this.retryDelayMs(intent.attemptCount));
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus"),
        "next_attempt_at" = ${nextAttemptAt},
        "last_bot_id" = ${botId},
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "remote_delete_succeeded_at" = COALESCE(
          "remote_delete_succeeded_at",
          CURRENT_TIMESTAMP
        ),
        "remote_delete_succeeded_bot_id" = COALESCE(
          "remote_delete_succeeded_bot_id",
          ${botId}
        ),
        "last_status_code" = NULL,
        "last_error_code" = ${BOT_MESSAGE_AUTO_DELETE_SUCCESS_VERIFICATION_PENDING_ERROR_CODE},
        "last_error" = 'MAX acknowledged DELETE; exact absence verification is pending',
        "completed_at" = NULL,
        "absence_verified_at" = NULL,
        "absence_verified_bot_id" = NULL,
        "absence_verification_code" = NULL,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intent.id}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
    if (changed === 0) {
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }

    const current = await this.loadRequiredIntent(intent.id);
    await this.enqueueWakeup(current);
    return this.toAttemptResult(current);
  }

  private async finalizeRecordedRemoteSuccess(
    intent: IntentRow,
    leaseToken: string,
    botId: string,
  ): Promise<ModerationDeleteAttemptResult> {
    try {
      const completed = await this.completeSucceeded(intent.id, leaseToken, botId);
      return this.toAttemptResult(completed);
    } catch (error: unknown) {
      return this.finishPersistenceFailure(
        intent,
        leaseToken,
        'remote_success_finalize_failed',
        error,
      );
    }
  }

  private async recordRemoteDeleteSucceeded(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "last_bot_id" = ${botId},
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "remote_delete_succeeded_at" = COALESCE(
          "remote_delete_succeeded_at",
          CURRENT_TIMESTAMP
        ),
        "remote_delete_succeeded_bot_id" = COALESCE(
          "remote_delete_succeeded_bot_id",
          ${botId}
        ),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
    return changed > 0;
  }

  private async persistRemoteSuccessFallback(
    intent: IntentRow,
    leaseToken: string,
    botId: string,
    error: unknown,
  ): Promise<ModerationDeleteAttemptResult> {
    const nextAttemptAt = new Date(Date.now() + this.retryDelayMs(intent.attemptCount));
    const details = this.describeError(error, 'remote_success_marker_persist_failed');
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus"),
        "next_attempt_at" = ${nextAttemptAt},
        "last_bot_id" = ${botId},
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "remote_delete_succeeded_at" = COALESCE(
          "remote_delete_succeeded_at",
          CURRENT_TIMESTAMP
        ),
        "remote_delete_succeeded_bot_id" = COALESCE(
          "remote_delete_succeeded_bot_id",
          ${botId}
        ),
        "last_status_code" = ${details.statusCode},
        "last_error_code" = 'remote_success_marker_persist_failed',
        "last_error" = ${details.message.slice(0, 2_000)},
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intent.id}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
    if (changed === 0) {
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }
    return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
  }

  private async finishPersistenceFailure(
    intent: IntentRow,
    leaseToken: string,
    errorCode: string,
    error: unknown,
  ): Promise<ModerationDeleteAttemptResult> {
    const details = this.describeError(error, errorCode);
    return this.finishRetryableAttempt(intent, leaseToken, {
      ...details,
      status: 'AMBIGUOUS',
      errorCode,
      retryDelayMs: this.retryDelayMs(intent.attemptCount),
    });
  }

  private async completeSucceeded(
    intentId: string,
    leaseToken: string,
    botId: string,
    absenceVerificationCode: 'post_success_exact_absence' | null = null,
  ): Promise<IntentRow> {
    const absenceVerifiedAt = absenceVerificationCode ? new Date() : null;
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE "moderation_delete_intents"
        SET
          "status" = CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
          "last_bot_id" = ${botId},
          "succeeded_bot_id" = COALESCE("remote_delete_succeeded_bot_id", ${botId}),
          "last_status_code" = NULL,
          "last_error_code" = NULL,
          "last_error" = NULL,
          "delete_dispatch_started_at" = NULL,
          "delete_dispatch_started_bot_id" = NULL,
          "absence_verified_at" = COALESCE(${absenceVerifiedAt}, "absence_verified_at"),
          "absence_verified_bot_id" = COALESCE(${absenceVerificationCode ? botId : null}, "absence_verified_bot_id"),
          "absence_verification_code" = COALESCE(${absenceVerificationCode}, "absence_verification_code"),
          "completed_at" = CURRENT_TIMESTAMP,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "leased_from_status" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${intentId}
          AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
          AND "lease_token" = ${leaseToken}
          AND "remote_delete_succeeded_at" IS NOT NULL
          AND "remote_delete_succeeded_bot_id" IS NOT NULL
      `);
      if (changed === 0) {
        return;
      }

      await this.materializeModerationEventsForIntent(tx, intentId);
    });
    const completed = await this.loadRequiredIntent(intentId);
    if (completed.status === 'SUCCEEDED') {
      await this.markReplacementCleanupConfirmed(completed);
    }
    return completed;
  }

  private async materializeModerationEventsForIntent(
    tx: Prisma.TransactionClient,
    intentId: string,
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "moderation_events" (
        "id", "chat_id", "bot_id", "user_id", "message_id", "event_type",
        "rule_code", "action", "masked_excerpt", "score", "operator", "metadata",
        "created_at"
      )
      SELECT
        'mdi-' || reason."id",
        intent."chat_id",
        COALESCE(intent."succeeded_bot_id", intent."last_bot_id"),
        COALESCE(reason."user_id", intent."subject_user_id"),
        intent."message_id",
        reason."event_type",
        reason."rule_code",
        CAST('DELETE_MESSAGE' AS "SanctionAction"),
        reason."masked_excerpt",
        reason."score",
        CAST('BOT' AS "Operator"),
        COALESCE(reason."metadata", '{}'::jsonb) || jsonb_build_object(
          'moderationDeleteIntentId', intent."id",
          'moderationDeleteReasonKey', reason."reason_key"
        ),
        CURRENT_TIMESTAMP
      FROM "moderation_delete_intent_reasons" reason
      JOIN "moderation_delete_intents" intent ON intent."id" = reason."intent_id"
      WHERE reason."intent_id" = ${intentId}
        AND intent."status" = CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus")
        AND reason."moderation_event_id" IS NULL
        AND reason."event_type" IS NOT NULL
        AND COALESCE(reason."user_id", intent."subject_user_id") IS NOT NULL
      ON CONFLICT ("id") DO NOTHING
    `);

    await tx.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intent_reasons" reason
      SET
        "moderation_event_id" = 'mdi-' || reason."id",
        "updated_at" = CURRENT_TIMESTAMP
      FROM "moderation_delete_intents" intent
      WHERE reason."intent_id" = ${intentId}
        AND intent."id" = reason."intent_id"
        AND intent."status" = CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus")
        AND reason."moderation_event_id" IS NULL
        AND reason."event_type" IS NOT NULL
        AND COALESCE(reason."user_id", intent."subject_user_id") IS NOT NULL
    `);
  }

  private async recordAttemptBot(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET "last_bot_id" = ${botId}, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
    `);
    return changed > 0;
  }

  private async markDeleteDispatchStarted(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "delete_dispatch_started_at" = CURRENT_TIMESTAMP,
        "delete_dispatch_started_bot_id" = ${botId},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
    `);
    return changed > 0;
  }

  private async clearDeleteDispatchStarted(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
        AND "delete_dispatch_started_at" IS NOT NULL
        AND "delete_dispatch_started_bot_id" = ${botId}
    `);
    return changed > 0;
  }

  private async clearBotMessageAutoDeleteMutationEvidence(
    intentId: string,
    leaseToken: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "remote_delete_succeeded_at" = NULL,
        "remote_delete_succeeded_bot_id" = NULL,
        "last_status_code" = NULL,
        "last_error_code" = ${BOT_MESSAGE_AUTO_DELETE_SUCCESS_STILL_PRESENT_ERROR_CODE},
        "last_error" = 'MAX still returns the exact message after acknowledging DELETE',
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
        AND (
          "delete_dispatch_started_at" IS NOT NULL
          OR "delete_dispatch_started_bot_id" IS NOT NULL
          OR "remote_delete_succeeded_at" IS NOT NULL
          OR "remote_delete_succeeded_bot_id" IS NOT NULL
        )
    `);
    return changed > 0;
  }

  private startLeaseHeartbeat(intentId: string, leaseToken: string): IntentLeaseHeartbeat {
    let stopped = false;
    let lost = false;
    let inFlight: Promise<boolean> | null = null;
    const renew = async (): Promise<boolean> => {
      if (stopped || lost) {
        return false;
      }
      if (inFlight) {
        return inFlight;
      }
      inFlight = this.renewLease(intentId, leaseToken)
        .catch((error: unknown) => {
          this.logger.warn(
            { intentId, err: this.errorMessage(error) },
            'Failed to renew moderation delete intent lease; outbound work is fenced',
          );
          return false;
        })
        .then((owned) => {
          if (!owned) {
            lost = true;
          }
          return owned;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    };
    const intervalMs = Math.max(25, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => void renew(), intervalMs);
    timer.unref();
    return {
      renew,
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async renewLease(intentId: string, leaseToken: string): Promise<boolean> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET "lease_expires_at" = ${leaseExpiresAt}
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > ${now}
    `);
    return changed > 0;
  }

  private async assertLeaseForExternalCall(heartbeat: IntentLeaseHeartbeat): Promise<void> {
    if (!(await heartbeat.renew())) {
      throw new ModerationDeleteIntentLeaseLostError();
    }
  }

  private async releasePausedLease(intentId: string, leaseToken: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = COALESCE(
          "leased_from_status",
          CAST('PENDING' AS "ModerationDeleteIntentStatus")
        ),
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
  }

  private async expireDueIntents(): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT intent."id"
        FROM "moderation_delete_intents" intent
        WHERE intent."retry_until_at" <= CURRENT_TIMESTAMP
          AND intent."remote_delete_succeeded_at" IS NULL
          AND intent."remote_delete_succeeded_bot_id" IS NULL
          AND intent."delete_dispatch_started_at" IS NULL
          AND intent."delete_dispatch_started_bot_id" IS NULL
          AND intent."status" IN (
            CAST('PENDING' AS "ModerationDeleteIntentStatus"),
            CAST('RETRYABLE' AS "ModerationDeleteIntentStatus"),
            CAST('WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus"),
            CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus"),
            CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
          )
          AND (
            intent."status" <> CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            OR intent."lease_expires_at" IS NULL
            OR intent."lease_expires_at" <= CURRENT_TIMESTAMP
          )
        ORDER BY intent."retry_until_at" ASC, intent."created_at" ASC, intent."id" ASC
        LIMIT ${this.sweepBatchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "moderation_delete_intents" intent
      SET
        "status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
        "completed_at" = CURRENT_TIMESTAMP,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      FROM candidates
      WHERE intent."id" = candidates."id"
    `);
  }

  private async expireIntentIfDue(intentId: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
        "completed_at" = CURRENT_TIMESTAMP,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "retry_until_at" <= CURRENT_TIMESTAMP
        AND "remote_delete_succeeded_at" IS NULL
        AND "remote_delete_succeeded_bot_id" IS NULL
        AND "delete_dispatch_started_at" IS NULL
        AND "delete_dispatch_started_bot_id" IS NULL
        AND "status" IN (
          CAST('PENDING' AS "ModerationDeleteIntentStatus"),
          CAST('RETRYABLE' AS "ModerationDeleteIntentStatus"),
          CAST('WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus"),
          CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
        )
    `);
  }

  private async enqueueCurrentWakeup(
    intentId: string,
    priority = DELETE_QUEUE_PRIORITY_BACKGROUND,
  ): Promise<void> {
    const intent = await this.loadIntent(intentId);
    if (intent) {
      await this.enqueueWakeup(intent, priority);
    }
  }

  private async enqueueWakeup(
    intent: IntentRow,
    priority = DELETE_QUEUE_PRIORITY_BACKGROUND,
  ): Promise<void> {
    if (this.classifyIntentWakeupEligibility(intent) !== 'eligible') {
      return;
    }
    try {
      await this.enqueueIntentJob(intent.id, priority);
    } catch (error: unknown) {
      this.logger.warn(
        { intentId: intent.id, err: this.errorMessage(error) },
        'Failed to enqueue moderation delete intent wakeup; DB sweeper will recover it',
      );
    }
  }

  private classifyIntentWakeupEligibility(
    intent: IntentRow,
  ):
    | 'eligible'
    | 'settled_or_in_progress'
    | 'execution_disabled'
    | 'retry_window_exhausted'
    | 'not_due' {
    if (TERMINAL_STATUSES.has(intent.status) || intent.status === 'IN_PROGRESS') {
      return 'settled_or_in_progress';
    }
    if (!this.isExecutionEnabledForIntent(intent)) {
      return 'execution_disabled';
    }
    const wakeAtMs = Math.max(intent.executeAt.getTime(), intent.nextAttemptAt.getTime());
    if (
      !this.hasRemoteSuccessMarker(intent) &&
      !this.hasDeleteDispatchMarker(intent) &&
      wakeAtMs >= intent.retryUntilAt.getTime()
    ) {
      return 'retry_window_exhausted';
    }
    return wakeAtMs <= Date.now() ? 'eligible' : 'not_due';
  }

  private async enqueueIntentJob(
    intentId: string,
    priority = DELETE_QUEUE_PRIORITY_BACKGROUND,
  ): Promise<void> {
    const job = await this.queue.add(
      'execute-moderation-delete-intent',
      { intentId },
      {
        jobId: `mdi-${intentId}`,
        priority,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    if (
      job &&
      priority === DELETE_QUEUE_PRIORITY_INTERACTIVE &&
      job.opts.priority !== DELETE_QUEUE_PRIORITY_INTERACTIVE
    ) {
      try {
        await job.changePriority({ priority: DELETE_QUEUE_PRIORITY_INTERACTIVE });
      } catch (error: unknown) {
        this.logger.warn(
          { intentId, err: this.errorMessage(error) },
          'Failed to promote an existing moderation delete intent job priority',
        );
      }
    }
  }

  private async loadRequiredIntent(intentId: string): Promise<IntentRow> {
    const intent = await this.loadIntent(intentId);
    if (!intent) {
      throw new Error(`Moderation delete intent ${intentId} does not exist`);
    }
    return intent;
  }

  private async loadIntent(intentId: string): Promise<IntentRow | null> {
    const rows = await this.prisma.$queryRaw<IntentRow[]>(Prisma.sql`
      SELECT ${this.intentSelectSql('intent')}
      FROM "moderation_delete_intents" intent
      WHERE intent."id" = ${intentId}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private async finishProtectedManagedBotMessageAutoDelete(
    intent: IntentRow,
    leaseToken: string,
  ): Promise<IntentRow | null> {
    if (intent.botMessageAutoDeleteOnly !== true) {
      return null;
    }

    const owner = await this.findManagedBotMessageOwner(intent);
    if (!owner) {
      return null;
    }

    const lastError =
      `BOT_MESSAGE_AUTO_DELETE blocked because ${owner.kind} ${owner.id} owns ` +
      `message ${intent.messageId}`;
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents" guarded_intent
      SET
        "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus"),
        "last_status_code" = NULL,
        "last_error_code" = 'managed_output_auto_delete_blocked',
        "last_error" = ${lastError.slice(0, 2_000)},
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "completed_at" = CURRENT_TIMESTAMP,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE guarded_intent."id" = ${intent.id}
        AND guarded_intent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND guarded_intent."lease_token" = ${leaseToken}
        AND guarded_intent."remote_delete_succeeded_at" IS NULL
        AND guarded_intent."remote_delete_succeeded_bot_id" IS NULL
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" guarded_reason
          WHERE guarded_reason."intent_id" = guarded_intent."id"
            AND guarded_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" other_reason
          WHERE other_reason."intent_id" = guarded_intent."id"
            AND other_reason."rule_code" NOT IN (
              ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE},
              ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            )
        )
    `);
    return updated > 0 ? this.loadRequiredIntent(intent.id) : null;
  }

  private async findManagedBotMessageOwner(
    intent: Pick<
      IntentRow,
      'chatId' | 'messageId' | 'sourceMessageAt' | 'entityType' | 'originBotId'
    >,
  ): Promise<ManagedBotMessageOwner | null> {
    const { chatId, messageId } = intent;
    const delivery = await this.prisma.managedBroadcastDelivery.findFirst({
      where: {
        targetChatId: chatId,
        remoteMessageId: messageId,
      },
      select: { id: true },
    });
    if (delivery) {
      return { id: delivery.id, kind: 'managed_publication' };
    }

    const originBotId = intent.originBotId?.trim() ?? '';
    const entityType = intent.entityType;
    if (originBotId && entityType) {
      // FLAG: Keep this final destructive-action fence exact-first, then cover the brief window
      // before a managed publication persists its remote message id. The exact-id recheck and
      // source-time bound close SENDING/SENT/AMBIGUOUS transitions without a generic stale fence.
      const sendFence = await this.prisma.managedBroadcastDelivery.findFirst({
        where: buildManagedPublicationAutoDeleteFenceWhere({
          targetChatId: chatId,
          messageId,
          originBotId,
          entityType,
          sourceMessageAt: intent.sourceMessageAt,
        }),
        select: {
          id: true,
          remoteMessageId: true,
        },
      });
      if (sendFence) {
        return {
          id: sendFence.id,
          kind:
            sendFence.remoteMessageId === messageId
              ? 'managed_publication'
              : 'managed_publication_in_flight',
        };
      }
    }

    const giveaway = await this.prisma.managedGiveaway.findFirst({
      where: {
        sourceChatId: chatId,
        OR: [{ publicationMessageId: messageId }, { resultsMessageId: messageId }],
      },
      select: {
        id: true,
        publicationMessageId: true,
        resultsMessageId: true,
      },
    });
    if (giveaway) {
      return {
        id: giveaway.id,
        kind:
          giveaway.publicationMessageId === messageId
            ? 'managed_giveaway_publication'
            : 'managed_giveaway_results',
      };
    }

    const vkPost = await this.prisma.vkParsingPost.findFirst({
      where: {
        chatId,
        publishedMessageId: messageId,
      },
      select: { id: true },
    });
    if (vkPost) {
      return { id: vkPost.id, kind: 'vk_parsing_post' };
    }

    const chatRules = await this.prisma.chatRules.findUnique({
      where: { chatId },
      select: { id: true, publishedMessageId: true },
    });
    if (chatRules?.publishedMessageId === messageId) {
      return { id: chatRules.id, kind: 'published_chat_rules' };
    }

    const chatAutoCommentReplacement = await this.prisma.chatAutoCommentAttachMarker.findFirst({
      where: {
        chatId,
        OR: [{ replacementMessageId: messageId }, { replyMessageId: messageId }],
      },
      select: { id: true, replacementMessageId: true, replyMessageId: true },
    });
    if (chatAutoCommentReplacement) {
      return {
        id: chatAutoCommentReplacement.id,
        kind:
          chatAutoCommentReplacement.replacementMessageId === messageId
            ? 'chat_auto_comment_replacement'
            : 'chat_auto_comment_reply',
      };
    }

    const transitionEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        messageId,
        ruleCode: { in: [...NIGHT_MODE_TRANSITION_NOTICE_RULE_CODES] },
      },
      select: { id: true },
    });
    return transitionEvent
      ? { id: transitionEvent.id, kind: 'night_mode_transition_notice' }
      : null;
  }

  private async resolveDeleteRouteWithRefresh(
    intent: IntentRow,
    heartbeat: IntentLeaseHeartbeat,
  ): Promise<MaxDeleteMessageBotRoute> {
    let route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
      chatId: intent.chatId,
      expectedEntityType: intent.entityType,
      requireFreshSnapshot: true,
    });
    if (this.filterAndOrderRouteCandidates(intent, route).length > 0) {
      return route;
    }

    const originRecoveryBotId =
      this.resolveEffectiveRoutingPolicy(intent) === 'origin_only'
        ? intent.originBotId?.trim() || null
        : null;
    if (
      originRecoveryBotId &&
      !route.candidateCapabilities.some((candidate) => candidate.botId === originRecoveryBotId) &&
      Boolean(this.maxBotLinkService.getExecutableBotById(originRecoveryBotId)) &&
      !this.isCandidateBackedOff(intent, originRecoveryBotId, null)
    ) {
      await this.refreshCandidateAccess(intent, originRecoveryBotId, heartbeat);
      route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
        chatId: intent.chatId,
        expectedEntityType: intent.entityType,
        requireFreshSnapshot: true,
      });
      if (this.filterAndOrderRouteCandidates(intent, route).length > 0) {
        return route;
      }
    }

    const probeCandidates = route.candidateCapabilities
      .filter(
        (candidate) =>
          (candidate.state === 'stale_or_unknown' || candidate.state === 'explicitly_incapable') &&
          candidate.reason !== 'bot_not_actionable' &&
          Boolean(this.maxBotLinkService.getExecutableBotById(candidate.botId)) &&
          this.isBotAllowedByRoutingPolicy(intent, candidate.botId) &&
          !this.isCandidateBackedOff(intent, candidate.botId, candidate.checkedAt),
      )
      .slice(0, 4);
    for (const candidate of probeCandidates) {
      await this.refreshCandidateAccess(intent, candidate.botId, heartbeat);
    }
    if (probeCandidates.length > 0) {
      route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
        chatId: intent.chatId,
        expectedEntityType: intent.entityType,
        requireFreshSnapshot: true,
      });
    }
    return route;
  }

  private async refreshCandidateAccess(
    intent: IntentRow,
    botId: string,
    heartbeat: IntentLeaseHeartbeat,
  ): Promise<'refreshed' | 'denied' | 'unknown'> {
    let accessProbeStartedAt: Date | null = null;
    try {
      await this.assertLeaseForExternalCall(heartbeat);
      accessProbeStartedAt = new Date();
      const access = await this.maxClient.getCurrentChatMemberAccess(intent.chatId, {
        botId,
        bypassCache: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
        timeoutMs: this.deleteTimeoutMs,
        ignoreFailureMetricStatuses: [403, 404],
      });
      const persisted = await this.maxBotLinkService.recordBotAccessProbe({
        chatId: intent.chatId,
        botId,
        access,
        source: 'moderation_delete_intent_probe',
        checkedAt: accessProbeStartedAt,
        allowMembershipRecovery:
          this.resolveEffectiveRoutingPolicy(intent) === 'origin_only' &&
          intent.originBotId === botId,
      });
      return persisted ? 'refreshed' : 'unknown';
    } catch (error: unknown) {
      if (error instanceof ModerationDeleteIntentLeaseLostError) {
        throw error;
      }
      const details = this.describeError(error, 'delete_access_probe_failed');
      if (details.statusCode === 401 || details.statusCode === 403 || details.statusCode === 404) {
        if (!accessProbeStartedAt) {
          return 'unknown';
        }
        const persisted = await this.maxBotLinkService.recordBotAccessProbe({
          chatId: intent.chatId,
          botId,
          access: null,
          source: 'moderation_delete_intent_probe_denied',
          checkedAt: accessProbeStartedAt,
        });
        return persisted ? 'denied' : 'unknown';
      }
      return 'unknown';
    }
  }

  private async verifyMessageAbsence(
    intent: IntentRow,
    botId: string,
    heartbeat: IntentLeaseHeartbeat,
  ): Promise<'verified_absent' | 'message_present' | 'unknown'> {
    if ((await this.refreshCandidateAccess(intent, botId, heartbeat)) !== 'refreshed') {
      return 'unknown';
    }
    const route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
      chatId: intent.chatId,
      expectedEntityType: intent.entityType,
      requireFreshSnapshot: true,
    });
    const exactCapability = route.candidateCapabilities.find(
      (candidate) => candidate.botId === botId && candidate.state === 'confirmed_capable',
    );
    if (!exactCapability) {
      return 'unknown';
    }

    try {
      const presence = await this.getExactMessagePresence(intent, botId, heartbeat);
      return presence === 'present' ? 'message_present' : 'verified_absent';
    } catch (error: unknown) {
      if (error instanceof ModerationDeleteIntentLeaseLostError) {
        throw error;
      }
      return 'unknown';
    }
  }

  private async getExactMessagePresence(
    intent: IntentRow,
    botId: string,
    heartbeat: IntentLeaseHeartbeat,
  ): Promise<'present' | 'absent'> {
    await this.assertLeaseForExternalCall(heartbeat);
    return this.maxClient.getExactMessagePresence(intent.chatId, intent.messageId, {
      botId,
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      timeoutMs: this.deleteTimeoutMs,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
    });
  }

  private async recordCandidateFailure(
    intentId: string,
    leaseToken: string,
    botId: string,
    attemptCount: number,
    details: DeleteErrorDetails,
  ): Promise<void> {
    const failedAt = new Date();
    const retryAt = new Date(
      failedAt.getTime() +
        Math.max(this.capabilityRetryDelayMs(attemptCount), details.retryDelayMs ?? 0),
    );
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "candidate_failures" = COALESCE("candidate_failures", '{}'::jsonb) ||
          jsonb_build_object(
            CAST(${botId} AS text),
            jsonb_build_object(
              'failedAt', CAST(${failedAt.toISOString()} AS text),
              'retryAt', CAST(${retryAt.toISOString()} AS text),
              'errorCode', CAST(${details.errorCode} AS text),
              'statusCode', CAST(${details.statusCode} AS integer)
            )
          ),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
  }

  private async completeAlreadyAbsent(
    intentId: string,
    leaseToken: string,
    botId: string,
    verificationCode:
      | 'retry_predelete_exact_presence'
      | 'postdelete_exact_presence'
      | 'guarded_link_predispatch_exact_absence'
      | 'guarded_commercial_ocr_predispatch_exact_absence',
  ): Promise<IntentRow> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus"),
        "last_bot_id" = ${botId},
        "last_status_code" = 404,
        "last_error_code" = 'verified_message_absent',
        "last_error" = NULL,
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "completed_at" = CURRENT_TIMESTAMP,
        "absence_verified_at" = CURRENT_TIMESTAMP,
        "absence_verified_bot_id" = ${botId},
        "absence_verification_code" = ${verificationCode},
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
    const completed = await this.loadRequiredIntent(intentId);
    if (completed.status === 'ALREADY_ABSENT') {
      await this.markReplacementCleanupConfirmed(completed);
    }
    return completed;
  }

  private async markReplacementCleanupConfirmed(
    intent: Pick<IntentRow, 'id' | 'chatId' | 'messageId'>,
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw(Prisma.sql`
        WITH channel_cleanup AS (
          UPDATE "channel_auto_post_attach_markers"
          SET
            "status" = CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus"),
            "lock_token" = NULL,
            "locked_at" = NULL,
            "original_deleted" = true,
            "cleanup_intent_id" = ${intent.id},
            "last_error" = NULL,
            "last_status_code" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${intent.chatId}
            AND "message_id" = ${intent.messageId}
            AND "delivery_mode" = 'replace_with_bot_message'
            AND "replacement_message_id" IS NOT NULL
            AND "status" IN (
              CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus"),
              CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus")
            )
          RETURNING "id"
        ),
        chat_cleanup AS (
          UPDATE "chat_auto_comment_attach_markers"
          SET
            "status" = CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus"),
            "lock_token" = NULL,
            "locked_at" = NULL,
            "original_deleted" = true,
            "cleanup_intent_id" = ${intent.id},
            "last_error" = NULL,
            "last_status_code" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${intent.chatId}
            AND "message_id" = ${intent.messageId}
            AND "delivery_mode" = 'replace_with_bot_message'
            AND "replacement_message_id" IS NOT NULL
            AND "status" IN (
              CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus"),
              CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus")
            )
          RETURNING "id"
        ),
        rules_cleanup AS (
          UPDATE "chat_rules"
          SET
            "published_message_id" = CASE
              WHEN "pending_cleanup_kind" = 'reset_current'
                AND "published_message_id" = ${intent.messageId}
              THEN NULL
              ELSE "published_message_id"
            END,
            "published_bot_id" = CASE
              WHEN "pending_cleanup_kind" = 'reset_current'
                AND "published_message_id" = ${intent.messageId}
              THEN NULL
              ELSE "published_bot_id"
            END,
            "published_url" = CASE
              WHEN "pending_cleanup_kind" = 'reset_current'
                AND "published_message_id" = ${intent.messageId}
              THEN NULL
              ELSE "published_url"
            END,
            "published_at" = CASE
              WHEN "pending_cleanup_kind" = 'reset_current'
                AND "published_message_id" = ${intent.messageId}
              THEN NULL
              ELSE "published_at"
            END,
            "pending_cleanup_message_id" = NULL,
            "pending_cleanup_bot_id" = NULL,
            "pending_cleanup_intent_id" = NULL,
            "pending_cleanup_kind" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${intent.chatId}
            AND "pending_cleanup_message_id" = ${intent.messageId}
          RETURNING "id"
        )
        UPDATE "audit_logs"
        SET "payload" = jsonb_set(
          "payload",
          '{previousCleanupOutcome}',
          '"confirmed"'::jsonb,
          true
        ) - 'previousCleanupError'
        WHERE "chat_id" = ${intent.chatId}
          AND "action" = 'PUBLISH_CHAT_RULES'
          AND "payload"->>'previousPublishedMessageId' = ${intent.messageId}
      `);
    } catch (error: unknown) {
      this.logger.warn(
        { intentId: intent.id, err: this.errorMessage(error) },
        'Failed to synchronize confirmed replacement cleanup marker',
      );
    }
  }

  private async linkReplacementCleanupIntent(
    tx: Prisma.TransactionClient,
    input: { chatId: string; messageId: string; ruleCode: string },
    intentId: string,
  ): Promise<void> {
    switch (input.ruleCode) {
      case 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP':
        await tx.$executeRaw(Prisma.sql`
          UPDATE "channel_auto_post_attach_markers"
          SET
            "cleanup_intent_id" = ${intentId},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${input.chatId}
            AND "message_id" = ${input.messageId}
            AND "delivery_mode" = 'replace_with_bot_message'
            AND "replacement_message_id" IS NOT NULL
            AND "original_deleted" = false
            AND "status" IN (
              CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus"),
              CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus")
            )
        `);
        return;
      case 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP':
        await tx.$executeRaw(Prisma.sql`
          UPDATE "chat_auto_comment_attach_markers"
          SET
            "cleanup_intent_id" = ${intentId},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${input.chatId}
            AND "message_id" = ${input.messageId}
            AND "delivery_mode" = 'replace_with_bot_message'
            AND "replacement_message_id" IS NOT NULL
            AND "original_deleted" = false
            AND "status" IN (
              CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus"),
              CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus")
            )
        `);
        return;
      case 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP':
        await tx.$executeRaw(Prisma.sql`
          UPDATE "chat_rules"
          SET
            "pending_cleanup_intent_id" = ${intentId},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${input.chatId}
            AND "pending_cleanup_message_id" = ${input.messageId}
        `);
        return;
      default:
        return;
    }
  }

  private buildSweepRolloutFilter(): Prisma.Sql {
    const baseFilter = this.buildBaseRolloutFilter(Prisma.sql`intent."chat_id"`);
    const commercialOcrFilter = this.buildCommercialOcrRolloutFilter(Prisma.sql`intent."chat_id"`);
    const replacementCleanupFilter = this.replacementCleanupEnabled
      ? Prisma.sql`
          OR EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" execution_reason
            WHERE execution_reason."intent_id" = intent."id"
              AND execution_reason."rule_code" IN (${Prisma.join([
                ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
              ])})
          )
        `
      : Prisma.empty;
    const requiredSubscriptionDeleteFilter = this.requiredSubscriptionDeleteEnabled
      ? Prisma.sql`
          OR EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" required_subscription_reason
            WHERE required_subscription_reason."intent_id" = intent."id"
              AND required_subscription_reason."rule_code" =
                ${REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE}
          )
        `
      : Prisma.empty;
    const executableRolloutFilter = Prisma.sql`(
      (
        ${baseFilter}
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" base_reason
          WHERE base_reason."intent_id" = intent."id"
            AND base_reason."rule_code" <> ${COMMERCIAL_OCR_DELETE_RULE_CODE}
        )
      )
      OR (
        ${commercialOcrFilter}
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" ocr_reason
          WHERE ocr_reason."intent_id" = intent."id"
            AND ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
        )
      )
      ${replacementCleanupFilter}
      ${requiredSubscriptionDeleteFilter}
      OR (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" auto_delete_reason
          WHERE auto_delete_reason."intent_id" = intent."id"
            AND auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
        )
      )
    )`;
    const botMessageAutoDeleteRetryLimitApplicable =
      this.botMessageAutoDeleteRetryLimitApplicableSql(
        Prisma.sql`intent."id"`,
        Prisma.sql`intent."commercial_ocr_guard_required"`,
      );
    // FLAG: Keep the fifth attempt selectable, but never requeue an auto-delete-only row after it.
    // Mutation evidence must still be reconciled regardless of the cap.
    return Prisma.sql`(
      ${executableRolloutFilter}
      AND (
        NOT ${botMessageAutoDeleteRetryLimitApplicable}
        OR intent."attempt_count" < ${BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS}
        OR intent."delete_dispatch_started_at" IS NOT NULL
        OR intent."delete_dispatch_started_bot_id" IS NOT NULL
        OR intent."remote_delete_succeeded_at" IS NOT NULL
        OR intent."remote_delete_succeeded_bot_id" IS NOT NULL
      )
    )`;
  }

  private buildRecoveryRolloutFilter(chatIdColumn: Prisma.Sql): Prisma.Sql {
    return this.replacementCleanupEnabled
      ? Prisma.sql`TRUE`
      : this.buildBaseRolloutFilter(chatIdColumn);
  }

  private buildBaseRolloutFilter(chatIdColumn: Prisma.Sql): Prisma.Sql {
    if (this.mode === 'on' || this.canaryChatIds.has('*')) {
      return Prisma.sql`TRUE`;
    }
    if (this.mode !== 'canary') {
      return Prisma.sql`FALSE`;
    }
    const ids = [...this.canaryChatIds];
    return ids.length > 0
      ? Prisma.sql`${chatIdColumn} IN (${Prisma.join(ids)})`
      : Prisma.sql`FALSE`;
  }

  private buildCommercialOcrRolloutFilter(chatIdColumn: Prisma.Sql): Prisma.Sql {
    if (this.commercialOcrMode === 'on') {
      return Prisma.sql`TRUE`;
    }
    if (this.commercialOcrMode !== 'canary') {
      return Prisma.sql`FALSE`;
    }
    const ids = [...this.commercialOcrCanaryChatIds];
    return ids.length > 0
      ? Prisma.sql`${chatIdColumn} IN (${Prisma.join(ids)})`
      : Prisma.sql`FALSE`;
  }

  private replacementCleanupRuleCode(
    source: ReplacementCleanupRecoveryCandidate['source'],
  ): string {
    switch (source) {
      case 'channel_auto_post':
        return 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP';
      case 'chat_auto_comment':
        return 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP';
      case 'chat_rules_state':
      case 'chat_rules_republish':
        return 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP';
    }
  }

  private replacementCleanupReasonKey(candidate: ReplacementCleanupRecoveryCandidate): string {
    return `replacement-cleanup-recovery:${candidate.source}:${candidate.sourceId}`;
  }

  private isReplacementCleanupRecoveryReason(reasonKey: string): boolean {
    return reasonKey.startsWith('replacement-cleanup-recovery:');
  }

  private isReplacementCleanupRuleCode(ruleCode: string): boolean {
    return REPLACEMENT_CLEANUP_RULE_CODE_SET.has(ruleCode.trim());
  }

  private isExecutionEnabledForIntent(
    intent: Pick<
      IntentRow,
      | 'chatId'
      | 'replacementCleanup'
      | 'nonChannelReplacementCleanup'
      | 'channelAutoPostCleanupReason'
      | 'botMessageAutoDeleteReason'
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'commercialOcrGuardRequired'
      | 'commercialOcrDeleteReason'
      | 'nonCommercialOcrDeleteReason'
    >,
  ): boolean {
    if (this.hasExecutableNonCommercialOcrReason(intent)) {
      return true;
    }
    if (this.replacementCleanupEnabled && intent.channelAutoPostCleanupReason === true) {
      return true;
    }
    const hasCommercialOcrReason =
      intent.commercialOcrDeleteReason === true || intent.commercialOcrGuardRequired === true;
    if (
      hasCommercialOcrReason &&
      this.getCommercialOcrRolloutForChat(intent.chatId) === 'execute'
    ) {
      return true;
    }
    if (hasCommercialOcrReason && intent.nonCommercialOcrDeleteReason !== true) {
      return false;
    }
    return this.getRolloutForChat(intent.chatId) === 'execute';
  }

  private hasExecutableNonCommercialOcrReason(
    intent: Pick<
      IntentRow,
      | 'chatId'
      | 'replacementCleanup'
      | 'nonChannelReplacementCleanup'
      | 'channelAutoPostCleanupReason'
      | 'botMessageAutoDeleteReason'
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'nonCommercialOcrDeleteReason'
    >,
  ): boolean {
    if (
      (this.requiredSubscriptionDeleteEnabled &&
        intent.requiredSubscriptionDeleteReason === true) ||
      intent.botMessageAutoDeleteReason === true ||
      intent.botMessageAutoDeleteOnly === true ||
      (this.replacementCleanupEnabled &&
        (intent.nonChannelReplacementCleanup === true ||
          (intent.nonChannelReplacementCleanup === undefined &&
            intent.channelAutoPostCleanupReason === undefined &&
            intent.replacementCleanup === true)))
    ) {
      return true;
    }
    return (
      intent.nonCommercialOcrDeleteReason === true &&
      this.getRolloutForChat(intent.chatId) === 'execute'
    );
  }

  private hasExecutableReasonIgnoringChannelAutoPostCleanup(
    intent: Pick<
      IntentRow,
      | 'chatId'
      | 'replacementCleanup'
      | 'nonChannelReplacementCleanup'
      | 'channelAutoPostCleanupReason'
      | 'botMessageAutoDeleteReason'
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'commercialOcrGuardRequired'
      | 'commercialOcrDeleteReason'
      | 'nonCommercialOcrDeleteReason'
    >,
  ): boolean {
    if (this.hasExecutableNonCommercialOcrReason(intent)) {
      return true;
    }
    return (
      (intent.commercialOcrDeleteReason === true || intent.commercialOcrGuardRequired === true) &&
      this.getCommercialOcrRolloutForChat(intent.chatId) === 'execute'
    );
  }

  private getCommercialOcrRolloutForChat(chatId: string): ModerationDeleteIntentRollout {
    return resolveModerationDeleteIntentRollout({
      mode: this.commercialOcrMode,
      canaryChatIds: this.commercialOcrCanaryChatIds,
      chatId,
    });
  }

  private hasAnyExecutionScope(): boolean {
    return true;
  }

  private orderCandidateBotIds(intent: IntentRow, values: readonly string[]): string[] {
    const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
    const routingPolicy = this.resolveEffectiveRoutingPolicy(intent);
    if (routingPolicy === 'origin_only') {
      return intent.originBotId && unique.includes(intent.originBotId) ? [intent.originBotId] : [];
    }
    if (routingPolicy !== 'origin_first' || !intent.originBotId) {
      return unique;
    }
    return unique.includes(intent.originBotId)
      ? [intent.originBotId, ...unique.filter((botId) => botId !== intent.originBotId)]
      : unique;
  }

  private isBotAllowedByRoutingPolicy(intent: IntentRow, botId: string): boolean {
    if (this.resolveEffectiveRoutingPolicy(intent) === 'origin_only') {
      return Boolean(intent.originBotId && botId === intent.originBotId);
    }
    return true;
  }

  private filterAndOrderRouteCandidates(
    intent: IntentRow,
    route: MaxDeleteMessageBotRoute,
  ): string[] {
    const capabilities = new Map(
      route.candidateCapabilities.map((candidate) => [candidate.botId, candidate]),
    );
    return this.orderCandidateBotIds(intent, route.candidateBotIds).filter((botId) => {
      const candidate = capabilities.get(botId);
      return (
        candidate?.state === 'confirmed_capable' &&
        !this.isCandidateBackedOff(intent, botId, candidate.checkedAt)
      );
    });
  }

  private isCandidateBackedOff(
    intent: IntentRow,
    botId: string,
    capabilityCheckedAt: string | null,
  ): boolean {
    const failure = this.readCandidateFailures(intent.candidateFailures).get(botId);
    if (!failure) {
      return false;
    }
    const failedAtMs = new Date(failure.failedAt).getTime();
    const checkedAtMs = capabilityCheckedAt ? new Date(capabilityCheckedAt).getTime() : Number.NaN;
    if (Number.isFinite(checkedAtMs) && checkedAtMs > failedAtMs) {
      return false;
    }
    return new Date(failure.retryAt).getTime() > Date.now();
  }

  private readCandidateFailures(value: unknown): Map<string, CandidateFailure> {
    const result = new Map<string, CandidateFailure>();
    const row = this.asRecord(value);
    if (!row) {
      return result;
    }
    for (const [botId, rawFailure] of Object.entries(row)) {
      const failure = this.asRecord(rawFailure);
      if (!failure) {
        continue;
      }
      const failedAt = this.firstString(failure.failedAt);
      const retryAt = this.firstString(failure.retryAt);
      if (!failedAt || !retryAt) {
        continue;
      }
      const rawStatusCode = failure.statusCode;
      const parsedStatusCode =
        (typeof rawStatusCode === 'number' ||
          (typeof rawStatusCode === 'string' && rawStatusCode.trim().length > 0)) &&
        Number.isFinite(Number(rawStatusCode))
          ? Number(rawStatusCode)
          : null;
      result.set(botId, {
        failedAt,
        retryAt,
        errorCode: this.firstString(failure.errorCode),
        statusCode: parsedStatusCode,
      });
    }
    return result;
  }

  private classifyDeleteError(error: unknown, attemptCount: number): DeleteErrorDetails {
    const details = this.describeError(error, 'delete_failed');
    if (isMaxApiCircuitOpenError(error)) {
      return {
        ...details,
        status: 'RETRYABLE',
        errorCode: 'max_circuit_open',
        retryDelayMs: Math.max(error.retryAfterMs, this.retryDelayMs(attemptCount)),
      };
    }
    if (this.isDeleteMessageNotFoundFailure(details)) {
      return {
        ...details,
        status: 'WAITING_CAPABILITY',
        errorCode: 'unverified_message_not_found',
        retryDelayMs: this.capabilityRetryDelayMs(attemptCount),
      };
    }
    if (this.isDeleteAccessFailure(details)) {
      return {
        ...details,
        status: 'WAITING_CAPABILITY',
        retryDelayMs: this.capabilityRetryDelayMs(attemptCount),
      };
    }
    if (details.statusCode === 404) {
      return {
        ...details,
        status: 'WAITING_CAPABILITY',
        errorCode: 'unverified_message_not_found',
        retryDelayMs: this.capabilityRetryDelayMs(attemptCount),
      };
    }
    if (details.statusCode === 400 || details.statusCode === 422) {
      return { ...details, status: 'FAILED_TERMINAL', retryDelayMs: null };
    }
    if (details.statusCode === 429 || (details.statusCode !== null && details.statusCode >= 500)) {
      return {
        ...details,
        status: 'RETRYABLE',
        retryDelayMs: Math.max(details.retryDelayMs ?? 0, this.retryDelayMs(attemptCount)),
      };
    }
    if (this.isAmbiguousTransportError(error)) {
      return {
        ...details,
        status: 'AMBIGUOUS',
        retryDelayMs: this.retryDelayMs(attemptCount),
      };
    }
    return {
      ...details,
      status: 'RETRYABLE',
      retryDelayMs: this.retryDelayMs(attemptCount),
    };
  }

  private isDeleteMessageNotFoundFailure(
    details: Pick<DeleteErrorDetails, 'errorCode' | 'message'>,
  ): boolean {
    const code = details.errorCode.trim().toLowerCase();
    const message = details.message.trim().toLowerCase();
    return (
      code === 'message.not.found' ||
      code === 'message_not_found' ||
      code === 'message.not_found' ||
      message.includes('message not found') ||
      message.includes('message.not.found')
    );
  }

  private isDeleteAccessFailure(
    details: Pick<DeleteErrorDetails, 'statusCode' | 'errorCode' | 'message'>,
  ): boolean {
    if (details.statusCode === 401 || details.statusCode === 403) {
      return true;
    }
    const code = details.errorCode.trim().toLowerCase();
    const message = details.message.trim().toLowerCase();
    return (
      code === 'access.denied' ||
      code === 'chat.denied' ||
      code === 'chat.not.found' ||
      code === 'permission.denied' ||
      message.includes('access denied') ||
      message.includes('permission denied') ||
      message.includes('not enough permission') ||
      message.includes('forbidden')
    );
  }

  private describeError(error: unknown, fallbackCode: string): DeleteErrorDetails {
    const row = this.asRecord(error);
    const response = this.asRecord(row?.response);
    const data = this.asRecord(response?.data);
    const nestedError = this.asRecord(data?.error);
    const headers = this.asRecord(response?.headers);
    const rawStatus = response?.status ?? row?.statusCode ?? row?.status;
    const statusCode = Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : null;
    const errorCode = this.firstString(nestedError?.code, data?.code, row?.code, fallbackCode);
    const message = this.firstString(
      nestedError?.message,
      data?.message,
      row?.message,
      'Unknown moderation delete error',
    );
    return {
      status: 'RETRYABLE',
      statusCode,
      errorCode,
      message,
      retryDelayMs: this.extractRetryAfterMs(row, data, headers),
    };
  }

  private isAmbiguousTransportError(error: unknown): boolean {
    const row = this.asRecord(error);
    const code = this.firstString(row?.code).toUpperCase();
    if (['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code)) {
      return true;
    }
    const message = this.firstString(row?.message).toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('socket hang up') ||
      message.includes('network error')
    );
  }

  private retryDelayMs(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(10, attemptCount - 1));
    const base = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.max(1_000, Math.round(base * jitter));
  }

  private capabilityRetryDelayMs(attemptCount: number): number {
    return Math.max(this.capabilityRetryMs, this.retryDelayMs(attemptCount));
  }

  private isBotMessageAutoDeleteRetryLimitApplicable(
    intent: Pick<
      IntentRow,
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'replacementCleanup'
      | 'commercialOcrGuardRequired'
      | 'commercialOcrDeleteReason'
      | 'remoteDeleteSucceededAt'
      | 'remoteDeleteSucceededBotId'
      | 'deleteDispatchStartedAt'
      | 'deleteDispatchStartedBotId'
    >,
  ): boolean {
    return this.isBotMessageAutoDeleteOnlyReason(intent) && !this.hasDeleteMutationEvidence(intent);
  }

  private isBotMessageAutoDeleteOnlyReason(
    intent: Pick<
      IntentRow,
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'replacementCleanup'
      | 'commercialOcrGuardRequired'
      | 'commercialOcrDeleteReason'
    >,
  ): boolean {
    return (
      intent.botMessageAutoDeleteOnly === true &&
      intent.requiredSubscriptionDeleteReason !== true &&
      intent.replacementCleanup !== true &&
      intent.commercialOcrGuardRequired !== true &&
      intent.commercialOcrDeleteReason !== true
    );
  }

  private botMessageAutoDeleteRetryLimitDetails(): DeleteErrorDetails {
    return {
      status: 'FAILED_TERMINAL',
      statusCode: null,
      errorCode: BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE,
      message:
        `BOT_MESSAGE_AUTO_DELETE reached its limit of ` +
        `${BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS} external attempts before dispatch`,
      retryDelayMs: null,
    };
  }

  private async enforceBotMessageAutoDeleteRetryLimit(
    intent: IntentRow,
    leaseToken: string,
    exceededOnly: boolean,
  ): Promise<BotMessageAutoDeleteRetryLimitOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        // FLAG: Lock first, then classify reasons in a new READ COMMITTED statement. This prevents
        // a concurrent independent reason from inheriting an auto-delete-only terminal.
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "moderation_delete_intents"
          WHERE "id" = ${intent.id}
            AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_token" = ${leaseToken}
          FOR UPDATE
        `);
        if (!locked[0]) {
          return { kind: 'lease_lost' } as const;
        }

        const latestRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          SELECT ${this.intentSelectSql('intent')}
          FROM "moderation_delete_intents" intent
          WHERE intent."id" = ${intent.id}
          LIMIT 1
        `);
        const latest = latestRows[0];
        if (!latest) {
          return { kind: 'lease_lost' } as const;
        }
        const attemptLimitReached = exceededOnly
          ? latest.attemptCount > BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS
          : latest.attemptCount >= BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS;
        if (!attemptLimitReached || !this.isBotMessageAutoDeleteRetryLimitApplicable(latest)) {
          return { kind: 'continue', intent: latest } as const;
        }

        const details = this.botMessageAutoDeleteRetryLimitDetails();
        const completedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus"),
            "next_attempt_at" = CURRENT_TIMESTAMP,
            "last_status_code" = ${details.statusCode},
            "last_error_code" = ${details.errorCode},
            "last_error" = ${details.message.slice(0, 2_000)},
            "completed_at" = CURRENT_TIMESTAMP,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_token" = ${leaseToken}
            AND "remote_delete_succeeded_at" IS NULL
            AND "remote_delete_succeeded_bot_id" IS NULL
            AND "delete_dispatch_started_at" IS NULL
            AND "delete_dispatch_started_bot_id" IS NULL
          RETURNING ${this.intentReturningSql()}
        `);
        const completed = completedRows[0];
        return completed
          ? ({ kind: 'terminal', intent: completed } as const)
          : ({ kind: 'lease_lost' } as const);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private hasRemoteSuccessMarker(
    intent: Pick<IntentRow, 'remoteDeleteSucceededAt' | 'remoteDeleteSucceededBotId'>,
  ): boolean {
    return Boolean(intent.remoteDeleteSucceededAt || intent.remoteDeleteSucceededBotId);
  }

  private hasDeleteDispatchMarker(
    intent: Pick<IntentRow, 'deleteDispatchStartedAt' | 'deleteDispatchStartedBotId'>,
  ): boolean {
    return Boolean(intent.deleteDispatchStartedAt || intent.deleteDispatchStartedBotId);
  }

  private hasDeleteMutationEvidence(
    intent: Pick<
      IntentRow,
      | 'remoteDeleteSucceededAt'
      | 'remoteDeleteSucceededBotId'
      | 'deleteDispatchStartedAt'
      | 'deleteDispatchStartedBotId'
    >,
  ): boolean {
    return this.hasRemoteSuccessMarker(intent) || this.hasDeleteDispatchMarker(intent);
  }

  private toSnapshot(intent: IntentRow): ModerationDeleteIntentSnapshot {
    return {
      id: intent.id,
      chatId: intent.chatId,
      messageId: intent.messageId,
      status: intent.status,
      executeAt: intent.executeAt,
      nextAttemptAt: intent.nextAttemptAt,
      retryUntilAt: intent.retryUntilAt,
      attemptCount: intent.attemptCount,
      lastBotId: intent.lastBotId,
      succeededBotId: intent.succeededBotId,
      deleteDispatchStartedAt: intent.deleteDispatchStartedAt,
      deleteDispatchStartedBotId: intent.deleteDispatchStartedBotId,
      remoteDeleteSucceededAt: intent.remoteDeleteSucceededAt,
      remoteDeleteSucceededBotId: intent.remoteDeleteSucceededBotId,
      lastStatusCode: intent.lastStatusCode,
      lastErrorCode: intent.lastErrorCode,
      lastError: intent.lastError,
    };
  }

  private toAttemptResult(intent: IntentRow): ModerationDeleteAttemptResult {
    const base = { intentId: intent.id } as const;
    switch (intent.status) {
      case 'OBSERVED':
        return { ...base, kind: 'observed', confirmed: false, status: intent.status };
      case 'SUCCEEDED':
        return {
          ...base,
          kind: 'confirmed',
          confirmed: true,
          status: intent.status,
          botId: intent.succeededBotId,
        };
      case 'ALREADY_ABSENT':
        return {
          ...base,
          kind: 'already_absent',
          confirmed: true,
          status: intent.status,
          botId: null,
        };
      case 'WAITING_CAPABILITY':
        return { ...base, kind: 'waiting_capability', confirmed: false, status: intent.status };
      case 'AMBIGUOUS':
        return { ...base, kind: 'ambiguous', confirmed: false, status: intent.status };
      case 'EXPIRED':
        return { ...base, kind: 'expired', confirmed: false, status: intent.status };
      case 'FAILED_TERMINAL':
        return { ...base, kind: 'terminal', confirmed: false, status: intent.status };
      case 'PENDING':
      case 'RETRYABLE':
      case 'IN_PROGRESS':
        return { ...base, kind: 'pending', confirmed: false, status: intent.status };
    }
  }

  private normalizeInput(input: EnsureModerationDeleteIntentInput) {
    const chatId = input.chatId.trim();
    const messageId = input.messageId.trim();
    const reasonKey = input.reasonKey.trim();
    const ruleCode = (input.ruleCode ?? reasonKey).trim();
    if (!chatId || !messageId || !reasonKey || !ruleCode) {
      throw new Error('chatId, messageId, reasonKey, and ruleCode must be non-empty');
    }

    const now = new Date();
    const executeAt = this.toDate(input.executeAt, now);
    const sourceMessageAt = this.toNullableDate(input.sourceMessageAt);
    const defaultRetryBaseMs = Math.max(
      executeAt.getTime(),
      sourceMessageAt?.getTime() ?? now.getTime(),
    );
    const retryUntilAt = this.toDate(
      input.retryUntilAt,
      new Date(defaultRetryBaseMs + this.retryHorizonMs),
    );
    if (retryUntilAt < executeAt) {
      throw new Error('retryUntilAt must not be earlier than executeAt');
    }
    const commercialOcrDeadlineAt = this.toNullableDate(input.commercialOcrDeadlineAt);
    if (
      ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE &&
      (!commercialOcrDeadlineAt || commercialOcrDeadlineAt.getTime() !== retryUntilAt.getTime())
    ) {
      throw new Error('commercial OCR intent deadline must equal retryUntilAt');
    }

    const subjectUserId = this.optionalString(input.subjectUserId);
    const eventUserId = this.optionalString(input.event?.userId) ?? subjectUserId;
    const eventType =
      input.event?.eventType === undefined
        ? eventUserId
          ? 'MESSAGE'
          : null
        : input.event.eventType;
    const entityType =
      input.entityType === 'CHAT' || input.entityType === 'CHANNEL' ? input.entityType : null;
    const messageAuthorKind =
      input.messageAuthorKind === 'user' || input.messageAuthorKind === 'bot'
        ? input.messageAuthorKind
        : null;
    const originBotId = this.optionalString(input.originBotId);
    const routingPolicy = this.resolveRoutingPolicy(input, chatId);
    if (
      this.getRolloutForRule(chatId, ruleCode) === 'execute' &&
      routingPolicy === 'origin_only' &&
      !originBotId
    ) {
      throw new Error('originBotId is required for executable origin-only delete intent');
    }
    return {
      chatId,
      messageId,
      reasonKey,
      ruleCode,
      subjectUserId,
      sourceMessageAt,
      entityType,
      messageAuthorKind,
      originBotId,
      routingPolicy,
      executeAt,
      retryUntilAt,
      commercialOcrDeadlineAt,
      event: {
        userId: eventUserId,
        eventType,
        maskedExcerpt: this.optionalString(input.event?.maskedExcerpt),
        score:
          typeof input.event?.score === 'number' && Number.isFinite(input.event.score)
            ? input.event.score
            : 1,
        metadata: input.event?.metadata,
      },
    };
  }

  private assertClaimMatchesIntent(
    claim: ModerationMessageActionClaimData,
    intent: EnsureModerationDeleteIntentInput,
  ): void {
    const binding = parseCommercialOcrDeleteBinding(intent.event?.metadata);
    const retryUntilAt = this.toNullableDate(intent.retryUntilAt);
    if (
      claim.updateType !== 'message_action' ||
      claim.ruleCode !== COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE ||
      claim.messageActionKey !==
        buildMessageScopedModerationActionClaimKey(intent.chatId, intent.messageId) ||
      !claim.dedupeKey.startsWith('commercial-ocr-action:v1:') ||
      claim.chatId.trim() !== intent.chatId.trim() ||
      claim.messageId.trim() !== intent.messageId.trim() ||
      claim.userId.trim() !== this.optionalString(intent.subjectUserId) ||
      (intent.ruleCode ?? intent.reasonKey).trim() !== COMMERCIAL_OCR_DELETE_RULE_CODE ||
      !binding ||
      !retryUntilAt ||
      retryUntilAt.toISOString() !== binding.ocrDeadlineAt ||
      this.toNullableDate(intent.sourceMessageAt)?.toISOString() !== binding.sourceCreatedAt
    ) {
      throw new Error('Moderation message action claim does not match its OCR delete intent');
    }
  }

  private async runSerializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: unknown) {
        if (attempt >= maxAttempts || !this.isPrismaSerializationFailure(error)) {
          throw error;
        }
      }
    }
    throw new Error('Serializable moderation delete intent transaction did not complete');
  }

  private isPrismaSerializationFailure(error: unknown): boolean {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === 'P2034') {
      return true;
    }
    return this.errorMessage(error).toLowerCase().includes('could not serialize access');
  }

  private intentReturningSql(alias?: string): Prisma.Sql {
    return this.intentColumnsSql(alias);
  }

  private intentSelectSql(alias: string): Prisma.Sql {
    const intentIdColumn = Prisma.raw(`"${alias}"."id"`);
    return Prisma.sql`
      ${this.intentColumnsSql(alias)},
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" execution_reason
        WHERE execution_reason."intent_id" = ${intentIdColumn}
          AND execution_reason."rule_code" IN (${Prisma.join([
            ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
          ])})
      ) AS "replacementCleanup",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" non_channel_replacement_reason
        WHERE non_channel_replacement_reason."intent_id" = ${intentIdColumn}
          AND non_channel_replacement_reason."rule_code" IN (${Prisma.join([
            ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES.filter(
              (ruleCode) => ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE,
            ),
          ])})
      ) AS "nonChannelReplacementCleanup",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" channel_cleanup_reason
        WHERE channel_cleanup_reason."intent_id" = ${intentIdColumn}
          AND channel_cleanup_reason."rule_code" =
            ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
      ) AS "channelAutoPostCleanupReason",
      (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" channel_cleanup_reason
          WHERE channel_cleanup_reason."intent_id" = ${intentIdColumn}
            AND channel_cleanup_reason."rule_code" =
              ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" independent_reason
          WHERE independent_reason."intent_id" = ${intentIdColumn}
            AND independent_reason."rule_code" <>
              ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
        )
      ) AS "channelAutoPostCleanupOnly",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" auto_delete_reason
        WHERE auto_delete_reason."intent_id" = ${intentIdColumn}
          AND auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
      ) AS "botMessageAutoDeleteReason",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" required_subscription_reason
        WHERE required_subscription_reason."intent_id" = ${intentIdColumn}
          AND required_subscription_reason."rule_code" =
            ${REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE}
      ) AS "requiredSubscriptionDeleteReason",
      ${this.botMessageAutoDeleteOnlySql(intentIdColumn)} AS "botMessageAutoDeleteOnly",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" ocr_reason
        WHERE ocr_reason."intent_id" = ${intentIdColumn}
          AND ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
      ) AS "commercialOcrDeleteReason",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" non_ocr_reason
        WHERE non_ocr_reason."intent_id" = ${intentIdColumn}
          AND non_ocr_reason."rule_code" <> ${COMMERCIAL_OCR_DELETE_RULE_CODE}
          AND non_ocr_reason."rule_code" <>
            ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
      ) AS "nonCommercialOcrDeleteReason",
      (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" link_reason
          WHERE link_reason."intent_id" = ${intentIdColumn}
            AND link_reason."rule_code" IN (${Prisma.join([
              LINK_BLOCKED_DELETE_RULE_CODE,
              LINK_HISTORY_RECOVERY_RULE_CODE,
            ])})
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" non_link_reason
          WHERE non_link_reason."intent_id" = ${intentIdColumn}
            AND non_link_reason."rule_code" NOT IN (${Prisma.join([
              LINK_BLOCKED_DELETE_RULE_CODE,
              LINK_HISTORY_RECOVERY_RULE_CODE,
              COMMERCIAL_OCR_DELETE_RULE_CODE,
              CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE,
            ])})
        )
      ) AS "linkFamilyDeleteOnly"
      ,
      (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" photo_reason
          WHERE photo_reason."intent_id" = ${intentIdColumn}
            AND photo_reason."rule_code" = 'DUPLICATE_DELETE'
            AND COALESCE(photo_reason."metadata"->>'duplicateSource', '') = 'photo'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" independent_reason
          WHERE independent_reason."intent_id" = ${intentIdColumn}
            AND independent_reason."rule_code" <> ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            AND independent_reason."rule_code" <>
              ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
            AND (
              independent_reason."rule_code" <> 'DUPLICATE_DELETE'
              OR COALESCE(independent_reason."metadata"->>'duplicateSource', '') <> 'photo'
            )
        )
      ) AS "photoDuplicateDeleteOnly"
      ,
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" night_cleanup_reason
        WHERE night_cleanup_reason."intent_id" = ${intentIdColumn}
          AND night_cleanup_reason."rule_code" = ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
      ) AS "nightModeCloseNoticeCleanupReason"
      ,
      (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" night_cleanup_reason
          WHERE night_cleanup_reason."intent_id" = ${intentIdColumn}
            AND night_cleanup_reason."rule_code" = ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" independent_reason
          WHERE independent_reason."intent_id" = ${intentIdColumn}
            AND independent_reason."rule_code" <> ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
        )
      ) AS "nightModeCloseNoticeCleanupOnly"
      ,
      (
        SELECT night_cleanup_reason."metadata"->'nightModeCloseNoticeCleanup'
        FROM "moderation_delete_intent_reasons" night_cleanup_reason
        WHERE night_cleanup_reason."intent_id" = ${intentIdColumn}
          AND night_cleanup_reason."rule_code" = ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
        ORDER BY night_cleanup_reason."created_at" ASC, night_cleanup_reason."id" ASC
        LIMIT 1
      ) AS "nightModeCloseNoticeCleanupBinding"
    `;
  }

  private botMessageAutoDeleteOnlySql(intentIdColumn: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`(
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" auto_delete_reason
        WHERE auto_delete_reason."intent_id" = ${intentIdColumn}
          AND auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" other_reason
        WHERE other_reason."intent_id" = ${intentIdColumn}
          AND other_reason."rule_code" NOT IN (
            ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE},
            ${COMMERCIAL_OCR_DELETE_RULE_CODE},
            ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
          )
      )
    )`;
  }

  private botMessageAutoDeleteRetryLimitApplicableSql(
    intentIdColumn: Prisma.Sql,
    commercialOcrGuardRequiredColumn: Prisma.Sql,
  ): Prisma.Sql {
    return Prisma.sql`(
      ${commercialOcrGuardRequiredColumn} = FALSE
      AND EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" retry_cap_auto_delete_reason
        WHERE retry_cap_auto_delete_reason."intent_id" = ${intentIdColumn}
          AND retry_cap_auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" retry_cap_other_reason
        WHERE retry_cap_other_reason."intent_id" = ${intentIdColumn}
          AND retry_cap_other_reason."rule_code" <> ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
      )
    )`;
  }

  private intentColumnsSql(alias?: string): Prisma.Sql {
    const column = (name: string) =>
      alias ? Prisma.raw(`"${alias}"."${name}"`) : Prisma.raw(`"${name}"`);
    return Prisma.sql`
      ${column('id')} AS "id",
      ${column('chat_id')} AS "chatId",
      ${column('message_id')} AS "messageId",
      ${column('subject_user_id')} AS "subjectUserId",
      ${column('source_message_at')} AS "sourceMessageAt",
      ${column('entity_type')} AS "entityType",
      ${column('message_author_kind')} AS "messageAuthorKind",
      ${column('origin_bot_id')} AS "originBotId",
      ${column('routing_policy')} AS "routingPolicy",
      ${column('commercial_ocr_guard_required')} AS "commercialOcrGuardRequired",
      ${column('commercial_ocr_deadline_at')} AS "commercialOcrDeadlineAt",
      ${column('status')} AS "status",
      ${column('execute_at')} AS "executeAt",
      ${column('next_attempt_at')} AS "nextAttemptAt",
      ${column('retry_until_at')} AS "retryUntilAt",
      ${column('attempt_count')} AS "attemptCount",
      ${column('last_bot_id')} AS "lastBotId",
      ${column('succeeded_bot_id')} AS "succeededBotId",
      ${column('delete_dispatch_started_at')} AS "deleteDispatchStartedAt",
      ${column('delete_dispatch_started_bot_id')} AS "deleteDispatchStartedBotId",
      ${column('remote_delete_succeeded_at')} AS "remoteDeleteSucceededAt",
      ${column('remote_delete_succeeded_bot_id')} AS "remoteDeleteSucceededBotId",
      ${column('candidate_failures')} AS "candidateFailures",
      ${column('last_status_code')} AS "lastStatusCode",
      ${column('last_error_code')} AS "lastErrorCode",
      ${column('last_error')} AS "lastError",
      ${column('lease_token')} AS "leaseToken",
      ${column('lease_expires_at')} AS "leaseExpiresAt",
      ${column('leased_from_status')} AS "leasedFromStatus"
    `;
  }

  private serializeMetadata(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return JSON.stringify({ serializationError: 'metadata_not_serializable' });
    }
  }

  private extractRetryAfterMs(
    error: Record<string, unknown> | null,
    data: Record<string, unknown> | null,
    headers: Record<string, unknown> | null,
  ): number | null {
    for (const rawValue of [error?.retryAfterMs, data?.retry_after_ms, data?.retryAfterMs]) {
      const numeric = Number(rawValue);
      if (Number.isFinite(numeric) && numeric > 0) {
        return Math.ceil(numeric);
      }
    }

    const rawHeader = headers?.['retry-after'] ?? headers?.['Retry-After'];
    const header =
      Array.isArray(rawHeader) && rawHeader.length > 0
        ? String(rawHeader[0])
        : String(rawHeader ?? '');
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(1_000, Math.ceil(seconds * 1_000));
    }
    const retryAtMs = Date.parse(header);
    return Number.isFinite(retryAtMs) ? Math.max(1_000, retryAtMs - Date.now()) : null;
  }

  private resolveRoutingPolicy(
    input: EnsureModerationDeleteIntentInput,
    chatId: string,
  ): 'delete_capable' | 'origin_first' | 'origin_only' {
    const userAuthoredChat = input.entityType === 'CHAT' && input.messageAuthorKind === 'user';
    const replacementCleanupRoutingRequested = this.isReplacementCleanupRuleCode(
      input.ruleCode ?? input.reasonKey,
    );
    const crossBotEnabled =
      replacementCleanupRoutingRequested ||
      this.crossBotCanaryChatIds.has('*') ||
      this.crossBotCanaryChatIds.has(chatId);
    if (!userAuthoredChat || !crossBotEnabled) {
      return 'origin_only';
    }
    if (input.routingPolicy === 'origin_first') {
      return 'origin_first';
    }
    return input.routingPolicy === 'delete_capable' ? 'delete_capable' : 'origin_only';
  }

  private toDate(value: Date | string | null | undefined, fallback: Date): Date {
    if (value === undefined || value === null) {
      return fallback;
    }
    const parsed = value instanceof Date ? new Date(value) : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid date: ${String(value)}`);
    }
    return parsed;
  }

  private toNullableDate(value: Date | string | null | undefined): Date | null {
    return value === undefined || value === null ? null : this.toDate(value, new Date());
  }

  private optionalString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized || null;
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
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

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  }

  private firstString(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export type {
  EnsureModerationDeleteIntentInput,
  EnsureModerationDeleteIntentResult,
  ModerationDeleteAttemptResult,
  ModerationDeleteIntentSnapshot,
};
