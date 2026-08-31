import {
  DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES,
  isValidDeleteBotMessagesDelayMinutes,
} from '@maxim/contracts/settings';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { canExecuteActionsForBotState } from '../max/max-bot-state.util';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import { parseLinkHistoryListedMessage } from '../moderation/link-history-recovery.util';
import {
  buildMessageScopedModerationActionClaimKey,
  buildModerationMessageViolationProcessingClaimKey,
} from '../moderation/moderation-message-action-claim';
import type { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import { Prisma, type ModerationDeleteIntentStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { SCHEDULED_BOT_DELETE_REASON } from './repair-missed-moderation-deletes.util';

const BOT_MESSAGE_AUTO_DELETE_RULE_CODE = 'BOT_MESSAGE_AUTO_DELETE';
const REPAIR_AUDIT_ACTION = 'OPERATOR_REOPEN_BOT_MESSAGE_AUTO_DELETE_PRESENT';
const MAX_TARGETS = 20;
const MAX_ID_LENGTH = 256;
const REPAIR_RETRY_HORIZON_MS = 24 * 60 * 60_000;
const REPAIR_PRESENCE_TIMEOUT_MS = 5_000;
const LEGACY_EVIDENCE_LIVE_MESSAGE_WINDOW_MS = 10 * 60_000;
const LEGACY_OUTBOUND_SEND_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const LEGACY_OUTBOUND_SEND_CLOCK_SKEW_MS = 5 * 60_000;
const LEGACY_OUTBOUND_SEND_SCAN_CAP = 1_000;
const LEGACY_OUTBOUND_DELETE_DELAY_TOLERANCE_MS = 5_000;
const LEGACY_OUTBOUND_DELETE_MAX_DELAY_MS =
  DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.at(-1)! * 60_000;

const REPAIRABLE_STATUSES = new Set<ModerationDeleteIntentStatus>([
  'PENDING',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
]);

const INTENT_SELECT = {
  id: true,
  chatId: true,
  messageId: true,
  subjectUserId: true,
  sourceMessageAt: true,
  entityType: true,
  messageAuthorKind: true,
  originBotId: true,
  routingPolicy: true,
  status: true,
  updatedAt: true,
  attemptCount: true,
  lastBotId: true,
  succeededBotId: true,
  deleteDispatchStartedAt: true,
  deleteDispatchStartedBotId: true,
  remoteDeleteSucceededAt: true,
  remoteDeleteSucceededBotId: true,
  lastStatusCode: true,
  lastErrorCode: true,
  completedAt: true,
  absenceVerifiedAt: true,
  absenceVerifiedBotId: true,
  absenceVerificationCode: true,
  reasons: {
    select: {
      ruleCode: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.ModerationDeleteIntentSelect;

const LEGACY_CLAIM_SELECT = {
  id: true,
  dedupeKey: true,
  messageActionKey: true,
  chatId: true,
  userId: true,
  messageId: true,
  ruleCode: true,
  updateType: true,
  createdAt: true,
} satisfies Prisma.ModerationViolationMessageClaimSelect;

const LEGACY_MEMBERSHIP_SELECT = {
  id: true,
  chatId: true,
  botId: true,
  status: true,
  chat: {
    select: {
      entityType: true,
    },
  },
} satisfies Prisma.ChatBotMembershipSelect;

const LEGACY_OUTBOUND_SEND_SELECT = {
  id: true,
  jobId: true,
  actionType: true,
  chatId: true,
  sourceTag: true,
  trafficClass: true,
  actionHealthLane: true,
  status: true,
  ambiguous: true,
  terminal: true,
  dispatchBotId: true,
  remoteMessageId: true,
  metadata: true,
  completedAt: true,
  updatedAt: true,
} satisfies Prisma.MaxActionLedgerEntrySelect;

const LEGACY_OUTBOUND_DELETE_SELECT = {
  id: true,
  jobId: true,
  actionType: true,
  chatId: true,
  botId: true,
  messageId: true,
  sourceTag: true,
  trafficClass: true,
  actionHealthLane: true,
  status: true,
  ambiguous: true,
  terminal: true,
  attemptCount: true,
  lastStatusCode: true,
  lastErrorCode: true,
  lastError: true,
  dispatchBotId: true,
  metadata: true,
  enqueuedAt: true,
  firstAttemptAt: true,
  lastAttemptAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MaxActionLedgerEntrySelect;

export type BotAutoDeletePresenceRepairIntent = Prisma.ModerationDeleteIntentGetPayload<{
  select: typeof INTENT_SELECT;
}>;

export type BotAutoDeletePresenceRepairLegacyClaim =
  Prisma.ModerationViolationMessageClaimGetPayload<{
    select: typeof LEGACY_CLAIM_SELECT;
  }>;

export type BotAutoDeletePresenceRepairLegacyOutboundSend = Prisma.MaxActionLedgerEntryGetPayload<{
  select: typeof LEGACY_OUTBOUND_SEND_SELECT;
}>;

export type BotAutoDeletePresenceRepairLegacyOutboundDelete =
  Prisma.MaxActionLedgerEntryGetPayload<{
    select: typeof LEGACY_OUTBOUND_DELETE_SELECT;
  }>;

type BotAutoDeletePresenceRepairLegacyMembership = Prisma.ChatBotMembershipGetPayload<{
  select: typeof LEGACY_MEMBERSHIP_SELECT;
}>;

export type BotAutoDeletePresenceRepairTarget = {
  chatId: string;
  messageId: string;
};

export type BotAutoDeletePresenceRepairOptions = {
  apply: boolean;
  help: boolean;
  json: boolean;
  actorUserId: string | null;
  targets: BotAutoDeletePresenceRepairTarget[];
};

type IneligibleReason =
  | 'intent_missing'
  | 'intent_in_progress'
  | 'observed_intent_not_promotable'
  | 'not_bot_message_auto_delete_only'
  | 'not_bot_authored_chat_message'
  | 'missing_origin_bot'
  | 'non_origin_only_routing'
  | 'managed_output_auto_delete_blocked'
  | 'execution_rollout_disabled'
  | 'legacy_claim_identity_mismatch'
  | 'legacy_claim_bot_unresolved'
  | 'legacy_outbound_send_missing'
  | 'legacy_outbound_send_ambiguous'
  | 'legacy_outbound_send_identity_mismatch'
  | 'legacy_outbound_send_origin_bot_missing'
  | 'legacy_outbound_delete_missing'
  | 'legacy_outbound_delete_ambiguous'
  | 'legacy_outbound_delete_identity_mismatch'
  | 'legacy_outbound_delete_schedule_missing'
  | 'legacy_origin_bot_not_executable'
  | 'legacy_active_membership_missing'
  | 'legacy_chat_not_chat'
  | 'legacy_live_message_unparseable'
  | 'legacy_live_message_identity_mismatch'
  | 'legacy_live_sender_mismatch'
  | 'legacy_live_timestamp_mismatch';

export type BotAutoDeletePresenceRepairOutcome = BotAutoDeletePresenceRepairTarget & {
  intentId: string | null;
  result:
    | 'would_reopen'
    | 'reopened'
    | 'reopened_enqueue_failed'
    | 'would_create'
    | 'created'
    | 'reconciled_existing'
    | 'created_enqueue_failed'
    | 'already_absent'
    | 'ineligible'
    | 'cas_conflict'
    | 'error';
  reason: IneligibleReason | null;
  previousStatus: ModerationDeleteIntentStatus | null;
  presenceBotId: string | null;
  error?: string;
};

export type BotAutoDeletePresenceRepairSummary = {
  apply: boolean;
  requested: number;
  wouldReopen: number;
  reopened: number;
  wouldCreate: number;
  created: number;
  reconciledExisting: number;
  alreadyAbsent: number;
  ineligible: number;
  casConflicts: number;
  errors: number;
  outcomes: BotAutoDeletePresenceRepairOutcome[];
};

type RepairDependencies = {
  prisma: PrismaService;
  maxClient: Pick<MaxClientService, 'getExactMessagePresence' | 'getExactMessageRow'>;
  botRegistry: Pick<MaxBotRegistryService, 'getBotById' | 'resolveBotIdFromUserId'>;
  intentService: Pick<
    ModerationDeleteIntentService,
    | 'enqueueCurrentIntentWakeupStrict'
    | 'ensureBotMessageAutoDeleteRepairIntentWithAudit'
    | 'getRolloutForRuleCodes'
  >;
};

type IntentEligibility =
  | { eligible: true; intent: BotAutoDeletePresenceRepairIntent; originBotId: string }
  | { eligible: false; reason: IneligibleReason };

type MissingIntentEvidence = {
  source: 'legacy_claim' | 'outbound_send_ledger' | 'outbound_delete_ledger';
  originBotId: string;
  expectedUserId: string | null;
  expectedMessageAt: Date;
  auditPayload: Prisma.InputJsonObject;
};

export const BOT_AUTO_DELETE_PRESENCE_REPAIR_USAGE = [
  'Usage:',
  '  --target <chatId> <messageId> [--target <chatId> <messageId> ...] [--dry-run] [--json]',
  '  --apply --actor-user-id <id> --target <chatId> <messageId> [--target ...] [--json]',
  '',
  `Dry-run is the default. Between 1 and ${MAX_TARGETS} unique exact target pairs are required.`,
  'Both dry-run and apply perform an exact live MAX presence lookup with the original bot.',
  'Apply is restricted to APP_ROLE=admin and BOT_MESSAGE_AUTO_DELETE-only repairable intents.',
].join('\n');

function readRequiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new Error(`${option} must be at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

const targetKey = (target: BotAutoDeletePresenceRepairTarget): string =>
  JSON.stringify([target.chatId, target.messageId]);

export function readBotAutoDeletePresenceRepairOptions(
  argv: readonly string[],
): BotAutoDeletePresenceRepairOptions {
  let apply = false;
  let explicitDryRun = false;
  let help = false;
  let json = false;
  let actorUserId: string | null = null;
  const targets: BotAutoDeletePresenceRepairTarget[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      explicitDryRun = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--actor-user-id') {
      actorUserId = readRequiredValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === '--target') {
      const chatId = readRequiredValue(argv, index + 1, `${arg} chatId`);
      const messageId = readRequiredValue(argv, index + 2, `${arg} messageId`);
      targets.push({ chatId, messageId });
      index += 2;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (help) {
    return { apply, help, json, actorUserId, targets };
  }
  if (apply && explicitDryRun) {
    throw new Error('--apply cannot be combined with --dry-run');
  }
  if (targets.length === 0) {
    throw new Error('At least one explicit --target <chatId> <messageId> pair is required');
  }
  if (targets.length > MAX_TARGETS) {
    throw new Error(`At most ${MAX_TARGETS} --target pairs are allowed`);
  }
  if (new Set(targets.map(targetKey)).size !== targets.length) {
    throw new Error('Each --target <chatId> <messageId> pair must be unique');
  }
  if (apply && !actorUserId) {
    throw new Error('--apply requires --actor-user-id');
  }

  return { apply, help, json, actorUserId, targets };
}

export function classifyBotAutoDeletePresenceRepairIntent(
  intent: BotAutoDeletePresenceRepairIntent | null,
): IntentEligibility {
  if (!intent) {
    return { eligible: false, reason: 'intent_missing' };
  }
  if (intent.status === 'OBSERVED') {
    return { eligible: false, reason: 'observed_intent_not_promotable' };
  }
  if (!REPAIRABLE_STATUSES.has(intent.status)) {
    return { eligible: false, reason: 'intent_in_progress' };
  }
  if (intent.lastErrorCode === 'managed_output_auto_delete_blocked') {
    return { eligible: false, reason: 'managed_output_auto_delete_blocked' };
  }
  if (
    intent.reasons.length === 0 ||
    intent.reasons.some((reason) => reason.ruleCode !== BOT_MESSAGE_AUTO_DELETE_RULE_CODE)
  ) {
    return { eligible: false, reason: 'not_bot_message_auto_delete_only' };
  }
  if (intent.entityType !== 'CHAT' || intent.messageAuthorKind !== 'bot') {
    return { eligible: false, reason: 'not_bot_authored_chat_message' };
  }
  const originBotId = intent.originBotId?.trim() ?? '';
  if (!originBotId) {
    return { eligible: false, reason: 'missing_origin_bot' };
  }
  if (intent.routingPolicy !== 'origin_only') {
    return { eligible: false, reason: 'non_origin_only_routing' };
  }
  return { eligible: true, intent, originBotId };
}

const normalizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
  return message.trim().slice(0, 1_000) || 'Unknown error';
};

function ineligibleOutcome(
  target: BotAutoDeletePresenceRepairTarget,
  intent: BotAutoDeletePresenceRepairIntent | null,
  reason: IneligibleReason,
): BotAutoDeletePresenceRepairOutcome {
  return {
    ...target,
    intentId: intent?.id ?? null,
    result: 'ineligible',
    reason,
    previousStatus: intent?.status ?? null,
    presenceBotId: intent?.originBotId?.trim() || null,
  };
}

function legacyIneligibleOutcome(
  target: BotAutoDeletePresenceRepairTarget,
  reason: IneligibleReason,
  presenceBotId: string | null = null,
): BotAutoDeletePresenceRepairOutcome {
  return {
    ...target,
    intentId: null,
    result: 'ineligible',
    reason,
    previousStatus: null,
    presenceBotId,
  };
}

function asJsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : null;
}

function readOutboundAutoDeleteDelayMs(metadata: Prisma.JsonValue | null): number | null {
  const value = asJsonRecord(metadata)?.autoDeleteDelayMs;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  return isValidDeleteBotMessagesDelayMinutes(value / 60_000) ? value : null;
}

function readCanonicalIsoDate(value: Prisma.JsonValue | undefined): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}

function isAllowedDeleteDelayMs(value: number): boolean {
  return DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.some(
    (minutes) => Math.abs(value - minutes * 60_000) <= LEGACY_OUTBOUND_DELETE_DELAY_TOLERANCE_MS,
  );
}

function readOutboundDeleteSchedule(metadata: Prisma.JsonValue | null): {
  createdAt: Date;
  scheduledFor: Date;
  delayMs: number;
} | null {
  const row = asJsonRecord(metadata);
  const createdAt = readCanonicalIsoDate(row?.createdAt);
  const scheduledFor = readCanonicalIsoDate(row?.scheduledFor);
  if (
    !createdAt ||
    !scheduledFor ||
    row?.routing !== null ||
    !Array.isArray(row?.candidateBotIds) ||
    row.candidateBotIds.length !== 0 ||
    !Array.isArray(row?.attemptedBotIds) ||
    row.attemptedBotIds.length !== 0 ||
    row?.autoDeleteDelayMs !== null ||
    row?.sendAutoDelete != null ||
    row?.hasText !== false ||
    row?.textLength !== 0 ||
    row?.hasOptions !== false ||
    !Array.isArray(row?.optionKeys) ||
    row.optionKeys.length !== 0
  ) {
    return null;
  }
  const delayMs = scheduledFor.getTime() - createdAt.getTime();
  return delayMs > 0 &&
    delayMs <= LEGACY_OUTBOUND_DELETE_MAX_DELAY_MS + LEGACY_OUTBOUND_DELETE_DELAY_TOLERANCE_MS
    ? { createdAt, scheduledFor, delayMs }
    : null;
}

async function repairMissingIntentFromEvidence(
  dependencies: RepairDependencies,
  options: BotAutoDeletePresenceRepairOptions,
  target: BotAutoDeletePresenceRepairTarget,
  now: () => Date,
  evidence: MissingIntentEvidence,
): Promise<BotAutoDeletePresenceRepairOutcome> {
  const { originBotId } = evidence;
  const originBot = dependencies.botRegistry.getBotById(originBotId);
  if (!originBot || !canExecuteActionsForBotState(originBot.state)) {
    return legacyIneligibleOutcome(target, 'legacy_origin_bot_not_executable', originBotId);
  }

  const membership: BotAutoDeletePresenceRepairLegacyMembership | null =
    await dependencies.prisma.chatBotMembership.findUnique({
      where: {
        chatId_botId: {
          chatId: target.chatId,
          botId: originBotId,
        },
      },
      select: LEGACY_MEMBERSHIP_SELECT,
    });
  if (
    !membership ||
    membership.chatId !== target.chatId ||
    membership.botId !== originBotId ||
    membership.status !== 'ACTIVE'
  ) {
    return legacyIneligibleOutcome(target, 'legacy_active_membership_missing', originBotId);
  }
  if (membership.chat.entityType !== 'CHAT') {
    return legacyIneligibleOutcome(target, 'legacy_chat_not_chat', originBotId);
  }
  if (
    dependencies.intentService.getRolloutForRuleCodes(target.chatId, [
      BOT_MESSAGE_AUTO_DELETE_RULE_CODE,
    ]) !== 'execute'
  ) {
    return legacyIneligibleOutcome(target, 'execution_rollout_disabled', originBotId);
  }

  const presenceCheckedAt = now();
  let exactRow: Record<string, unknown> | null;
  try {
    exactRow = await dependencies.maxClient.getExactMessageRow(target.chatId, target.messageId, {
      botId: originBotId,
      bypassCache: true,
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      timeoutMs: REPAIR_PRESENCE_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    return {
      ...target,
      intentId: null,
      result: 'error',
      reason: null,
      previousStatus: null,
      presenceBotId: originBotId,
      error: `Exact live message lookup failed: ${normalizeError(error)}`,
    };
  }
  if (!exactRow) {
    return {
      ...target,
      intentId: null,
      result: 'already_absent',
      reason: null,
      previousStatus: null,
      presenceBotId: originBotId,
    };
  }

  const liveMessage = parseLinkHistoryListedMessage(exactRow);
  if (!liveMessage) {
    return legacyIneligibleOutcome(target, 'legacy_live_message_unparseable', originBotId);
  }
  if (liveMessage.messageId !== target.messageId) {
    return legacyIneligibleOutcome(target, 'legacy_live_message_identity_mismatch', originBotId);
  }
  const liveSenderId = String(liveMessage.senderId ?? '').trim();
  const liveOriginBotId = dependencies.botRegistry.resolveBotIdFromUserId(liveSenderId);
  if (!liveOriginBotId || liveOriginBotId !== originBotId) {
    return legacyIneligibleOutcome(target, 'legacy_live_sender_mismatch', originBotId);
  }
  if (evidence.expectedUserId && liveSenderId !== evidence.expectedUserId) {
    return legacyIneligibleOutcome(target, 'legacy_live_sender_mismatch', originBotId);
  }
  if (
    Math.abs(liveMessage.timestampMs - evidence.expectedMessageAt.getTime()) >
    LEGACY_EVIDENCE_LIVE_MESSAGE_WINDOW_MS
  ) {
    return legacyIneligibleOutcome(target, 'legacy_live_timestamp_mismatch', originBotId);
  }

  if (!options.apply) {
    return {
      ...target,
      intentId: null,
      result: 'would_create',
      reason: null,
      previousStatus: null,
      presenceBotId: originBotId,
    };
  }

  const liveMessageAt = new Date(liveMessage.timestampMs);
  const retryUntilAt = new Date(presenceCheckedAt.getTime() + REPAIR_RETRY_HORIZON_MS);
  let ensured: Awaited<
    ReturnType<ModerationDeleteIntentService['ensureBotMessageAutoDeleteRepairIntentWithAudit']>
  >;
  try {
    ensured = await dependencies.intentService.ensureBotMessageAutoDeleteRepairIntentWithAudit(
      {
        chatId: target.chatId,
        messageId: target.messageId,
        reasonKey: BOT_MESSAGE_AUTO_DELETE_RULE_CODE,
        ruleCode: BOT_MESSAGE_AUTO_DELETE_RULE_CODE,
        subjectUserId: liveSenderId,
        sourceMessageAt: liveMessageAt,
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        originBotId,
        routingPolicy: 'origin_only',
        executeAt: presenceCheckedAt,
        retryUntilAt,
        event: {
          userId: liveSenderId,
          eventType: 'MESSAGE',
          maskedExcerpt: null,
          score: 0.5,
          metadata: {
            reason: SCHEDULED_BOT_DELETE_REASON,
            repairSource:
              evidence.source === 'legacy_claim'
                ? 'exact_legacy_message_action_claim'
                : evidence.source === 'outbound_send_ledger'
                  ? 'exact_outbound_send_auto_delete_ledger'
                  : 'exact_outbound_scheduled_delete_ledger',
          },
        },
      },
      {
        actorUserId: options.actorUserId!,
        auditPayload: {
          repairVersion: 1,
          evidenceVersion:
            evidence.source === 'legacy_claim'
              ? 1
              : evidence.source === 'outbound_send_ledger'
                ? 2
                : 3,
          evidenceSource: evidence.source,
          ...evidence.auditPayload,
          liveMessageId: liveMessage.messageId,
          liveSenderId,
          liveMessageAt: liveMessageAt.toISOString(),
          presenceCheckedAt: presenceCheckedAt.toISOString(),
          originBotId,
        },
      },
    );
  } catch (error: unknown) {
    return {
      ...target,
      intentId: null,
      result: 'error',
      reason: null,
      previousStatus: null,
      presenceBotId: originBotId,
      error: `Atomic missing-intent create failed: ${normalizeError(error)}`,
    };
  }

  try {
    await dependencies.intentService.enqueueCurrentIntentWakeupStrict(ensured.intentId);
  } catch (error: unknown) {
    return {
      ...target,
      intentId: ensured.intentId,
      result: 'created_enqueue_failed',
      reason: null,
      previousStatus: null,
      presenceBotId: originBotId,
      error: normalizeError(error),
    };
  }

  return {
    ...target,
    intentId: ensured.intentId,
    result: ensured.created ? 'created' : 'reconciled_existing',
    reason: null,
    previousStatus: null,
    presenceBotId: originBotId,
  };
}

async function repairMissingOutboundDeleteIntent(
  dependencies: RepairDependencies,
  options: BotAutoDeletePresenceRepairOptions,
  target: BotAutoDeletePresenceRepairTarget,
  now: () => Date,
  send: BotAutoDeletePresenceRepairLegacyOutboundSend,
  sendCompletedAt: Date,
  originBotId: string,
  lookupStartAt: Date,
  lookupEndAt: Date,
): Promise<BotAutoDeletePresenceRepairOutcome> {
  const rows: BotAutoDeletePresenceRepairLegacyOutboundDelete[] =
    await dependencies.prisma.maxActionLedgerEntry.findMany({
      where: {
        chatId: target.chatId,
        actionType: 'DELETE_MESSAGE',
        messageId: target.messageId,
        status: 'SUCCEEDED',
        updatedAt: {
          gte: lookupStartAt,
          lte: lookupEndAt,
        },
      },
      select: LEGACY_OUTBOUND_DELETE_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 2,
    });
  if (rows.length === 0) {
    return legacyIneligibleOutcome(target, 'legacy_outbound_delete_missing', originBotId);
  }
  if (rows.length !== 1) {
    return legacyIneligibleOutcome(target, 'legacy_outbound_delete_ambiguous', originBotId);
  }

  const deletion = rows[0]!;
  const deletionCompletedAt = deletion.completedAt;
  const deletionEnqueuedAt = deletion.enqueuedAt;
  const deletionFirstAttemptAt = deletion.firstAttemptAt;
  const deletionLastAttemptAt = deletion.lastAttemptAt;
  if (
    deletion.actionType !== 'DELETE_MESSAGE' ||
    deletion.chatId !== target.chatId ||
    deletion.messageId !== target.messageId ||
    deletion.botId?.trim() !== originBotId ||
    (deletion.dispatchBotId !== null && deletion.dispatchBotId?.trim() !== originBotId) ||
    deletion.sourceTag !== MAX_API_SOURCE_TAGS.MODERATION_NOTICE ||
    deletion.trafficClass !== send.trafficClass ||
    deletion.actionHealthLane !== send.actionHealthLane ||
    deletion.status !== 'SUCCEEDED' ||
    deletion.ambiguous ||
    !deletion.terminal ||
    deletion.attemptCount < 1 ||
    deletion.lastStatusCode !== null ||
    deletion.lastErrorCode !== null ||
    deletion.lastError !== null ||
    !(deletionEnqueuedAt instanceof Date) ||
    !Number.isFinite(deletionEnqueuedAt.getTime()) ||
    !(deletionFirstAttemptAt instanceof Date) ||
    !Number.isFinite(deletionFirstAttemptAt.getTime()) ||
    !(deletionLastAttemptAt instanceof Date) ||
    !Number.isFinite(deletionLastAttemptAt.getTime()) ||
    !(deletionCompletedAt instanceof Date) ||
    !Number.isFinite(deletionCompletedAt.getTime()) ||
    deletionCompletedAt < lookupStartAt ||
    deletionCompletedAt > lookupEndAt
  ) {
    return legacyIneligibleOutcome(target, 'legacy_outbound_delete_identity_mismatch', originBotId);
  }

  const schedule = readOutboundDeleteSchedule(deletion.metadata);
  const anchoredDelayMs = schedule
    ? schedule.scheduledFor.getTime() - sendCompletedAt.getTime()
    : Number.NaN;
  const scheduleEvidenceMode = schedule
    ? isAllowedDeleteDelayMs(schedule.delayMs) &&
      schedule.createdAt.getTime() >=
        sendCompletedAt.getTime() - LEGACY_OUTBOUND_DELETE_DELAY_TOLERANCE_MS &&
      schedule.createdAt.getTime() <= sendCompletedAt.getTime() + 60_000
      ? 'fresh_full_delay'
      : isAllowedDeleteDelayMs(anchoredDelayMs) &&
          schedule.createdAt.getTime() >=
            sendCompletedAt.getTime() - LEGACY_OUTBOUND_DELETE_DELAY_TOLERANCE_MS &&
          schedule.createdAt <= schedule.scheduledFor &&
          schedule.delayMs <= anchoredDelayMs + LEGACY_OUTBOUND_DELETE_DELAY_TOLERANCE_MS
        ? 'recovered_remaining_delay'
        : null
    : null;
  if (
    !schedule ||
    !scheduleEvidenceMode ||
    Math.abs(schedule.createdAt.getTime() - deletion.createdAt.getTime()) > 60_000 ||
    deletionEnqueuedAt.getTime() + 60_000 < deletion.createdAt.getTime() ||
    deletionFirstAttemptAt.getTime() + 60_000 < schedule.scheduledFor.getTime() ||
    deletionLastAttemptAt < deletionFirstAttemptAt ||
    deletionCompletedAt < deletionLastAttemptAt ||
    deletionCompletedAt.getTime() - schedule.scheduledFor.getTime() > REPAIR_RETRY_HORIZON_MS ||
    deletion.updatedAt < deletionCompletedAt
  ) {
    return legacyIneligibleOutcome(target, 'legacy_outbound_delete_schedule_missing', originBotId);
  }

  return repairMissingIntentFromEvidence(dependencies, options, target, now, {
    source: 'outbound_delete_ledger',
    originBotId,
    expectedUserId: null,
    expectedMessageAt: sendCompletedAt,
    auditPayload: {
      sendLedgerId: send.id,
      sendLedgerJobId: send.jobId,
      sendLedgerStatus: send.status,
      sendLedgerSourceTag: send.sourceTag,
      sendLedgerCompletedAt: sendCompletedAt.toISOString(),
      sendLedgerUpdatedAt: send.updatedAt.toISOString(),
      sendLedgerAutoDeleteDelayMs: null,
      deleteLedgerId: deletion.id,
      deleteLedgerJobId: deletion.jobId,
      deleteLedgerStatus: deletion.status,
      deleteLedgerSourceTag: deletion.sourceTag,
      deleteLedgerCreatedAt: deletion.createdAt.toISOString(),
      deleteLedgerScheduledFor: schedule.scheduledFor.toISOString(),
      deleteLedgerCompletedAt: deletionCompletedAt.toISOString(),
      deleteLedgerUpdatedAt: deletion.updatedAt.toISOString(),
      deleteScheduledDelayMs: schedule.delayMs,
      deleteAnchoredDelayMs: anchoredDelayMs,
      deleteScheduleEvidenceMode: scheduleEvidenceMode,
    },
  });
}

async function repairMissingOutboundSendIntent(
  dependencies: RepairDependencies,
  options: BotAutoDeletePresenceRepairOptions,
  target: BotAutoDeletePresenceRepairTarget,
  now: () => Date,
): Promise<BotAutoDeletePresenceRepairOutcome> {
  const lookupAt = now();
  const lookupStartAt = new Date(lookupAt.getTime() - LEGACY_OUTBOUND_SEND_LOOKBACK_MS);
  const lookupEndAt = new Date(lookupAt.getTime() + LEGACY_OUTBOUND_SEND_CLOCK_SKEW_MS);
  // Cap the indexed recent-send page before matching the unindexed remote message id.
  const recentRows: BotAutoDeletePresenceRepairLegacyOutboundSend[] =
    await dependencies.prisma.maxActionLedgerEntry.findMany({
      where: {
        chatId: target.chatId,
        actionType: 'SEND_MESSAGE',
        updatedAt: {
          gte: lookupStartAt,
          lte: lookupEndAt,
        },
      },
      select: LEGACY_OUTBOUND_SEND_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: LEGACY_OUTBOUND_SEND_SCAN_CAP,
    });
  const rows = recentRows.filter((row) => row.remoteMessageId === target.messageId);
  if (rows.length === 0) {
    return legacyIneligibleOutcome(target, 'legacy_outbound_send_missing');
  }
  if (rows.length !== 1) {
    return legacyIneligibleOutcome(target, 'legacy_outbound_send_ambiguous');
  }

  const send = rows[0]!;
  if (
    send.actionType !== 'SEND_MESSAGE' ||
    send.chatId !== target.chatId ||
    send.sourceTag !== MAX_API_SOURCE_TAGS.MODERATION_NOTICE ||
    send.remoteMessageId !== target.messageId ||
    send.status !== 'SUCCEEDED' ||
    send.ambiguous ||
    !send.terminal ||
    !(send.completedAt instanceof Date) ||
    !Number.isFinite(send.completedAt.getTime()) ||
    send.completedAt < lookupStartAt ||
    send.completedAt > lookupEndAt
  ) {
    return legacyIneligibleOutcome(target, 'legacy_outbound_send_identity_mismatch');
  }

  const autoDeleteDelayMs = readOutboundAutoDeleteDelayMs(send.metadata);
  const originBotId = send.dispatchBotId?.trim() ?? '';
  if (!originBotId) {
    return legacyIneligibleOutcome(target, 'legacy_outbound_send_origin_bot_missing');
  }

  if (autoDeleteDelayMs === null) {
    return repairMissingOutboundDeleteIntent(
      dependencies,
      options,
      target,
      now,
      send,
      send.completedAt,
      originBotId,
      lookupStartAt,
      lookupEndAt,
    );
  }

  return repairMissingIntentFromEvidence(dependencies, options, target, now, {
    source: 'outbound_send_ledger',
    originBotId,
    expectedUserId: null,
    expectedMessageAt: send.completedAt,
    auditPayload: {
      sendLedgerId: send.id,
      sendLedgerJobId: send.jobId,
      sendLedgerStatus: send.status,
      sendLedgerSourceTag: send.sourceTag,
      sendLedgerCompletedAt: send.completedAt.toISOString(),
      sendLedgerUpdatedAt: send.updatedAt.toISOString(),
      autoDeleteDelayMs,
    },
  });
}

async function repairMissingLegacyIntent(
  dependencies: RepairDependencies,
  options: BotAutoDeletePresenceRepairOptions,
  target: BotAutoDeletePresenceRepairTarget,
  now: () => Date,
): Promise<BotAutoDeletePresenceRepairOutcome> {
  const expectedMessageActionKey = buildMessageScopedModerationActionClaimKey(
    target.chatId,
    target.messageId,
  );
  const claim = await dependencies.prisma.moderationViolationMessageClaim.findUnique({
    where: { messageActionKey: expectedMessageActionKey },
    select: LEGACY_CLAIM_SELECT,
  });
  if (!claim) {
    return repairMissingOutboundSendIntent(dependencies, options, target, now);
  }

  const expectedDedupeKey = buildModerationMessageViolationProcessingClaimKey({
    chatId: target.chatId,
    userId: claim.userId,
    messageId: target.messageId,
    ruleCode: BOT_MESSAGE_AUTO_DELETE_RULE_CODE,
    updateType: 'message_action',
  }).dedupeKey;
  if (
    claim.dedupeKey !== expectedDedupeKey ||
    claim.messageActionKey !== expectedMessageActionKey ||
    claim.chatId !== target.chatId ||
    claim.messageId !== target.messageId ||
    claim.ruleCode !== BOT_MESSAGE_AUTO_DELETE_RULE_CODE ||
    claim.updateType !== 'message_action'
  ) {
    return legacyIneligibleOutcome(target, 'legacy_claim_identity_mismatch');
  }

  const originBotId = dependencies.botRegistry.resolveBotIdFromUserId(claim.userId);
  if (!originBotId) {
    return legacyIneligibleOutcome(target, 'legacy_claim_bot_unresolved');
  }

  return repairMissingIntentFromEvidence(dependencies, options, target, now, {
    source: 'legacy_claim',
    originBotId,
    expectedUserId: claim.userId,
    expectedMessageAt: claim.createdAt,
    auditPayload: {
      claimId: claim.id,
      claimDedupeKey: claim.dedupeKey,
      claimMessageActionKey: expectedMessageActionKey,
      claimCreatedAt: claim.createdAt.toISOString(),
      claimUserId: claim.userId,
      ruleCode: claim.ruleCode,
      updateType: claim.updateType,
    },
  });
}

async function reopenIntentWithAudit(params: {
  prisma: PrismaService;
  intent: BotAutoDeletePresenceRepairIntent;
  actorUserId: string;
  presenceBotId: string;
  presenceCheckedAt: Date;
  retryUntilAt: Date;
}): Promise<boolean> {
  const { prisma, intent, actorUserId, presenceBotId, presenceCheckedAt, retryUntilAt } = params;
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "moderation_delete_intents" intent
      SET
        "status" = CAST('PENDING' AS "ModerationDeleteIntentStatus"),
        "execute_at" = LEAST(intent."execute_at", ${presenceCheckedAt}),
        "next_attempt_at" = ${presenceCheckedAt},
        "retry_until_at" = GREATEST(intent."retry_until_at", ${retryUntilAt}),
        "attempt_count" = 0,
        "last_bot_id" = NULL,
        "succeeded_bot_id" = NULL,
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "remote_delete_succeeded_at" = NULL,
        "remote_delete_succeeded_bot_id" = NULL,
        "candidate_failures" = '{}'::jsonb,
        "last_status_code" = NULL,
        "last_error_code" = 'operator_reopen_exact_message_present',
        "last_error" = NULL,
        "first_attempt_at" = NULL,
        "last_attempt_at" = NULL,
        "completed_at" = NULL,
        "absence_verified_at" = NULL,
        "absence_verified_bot_id" = NULL,
        "absence_verification_code" = NULL,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE intent."id" = ${intent.id}
        AND intent."chat_id" = ${intent.chatId}
        AND intent."message_id" = ${intent.messageId}
        AND intent."status" = CAST(${intent.status} AS "ModerationDeleteIntentStatus")
        AND intent."updated_at" = ${intent.updatedAt}
        AND intent."attempt_count" = ${intent.attemptCount}
        AND intent."last_error_code" IS DISTINCT FROM 'managed_output_auto_delete_blocked'
        AND intent."entity_type" = CAST('CHAT' AS "ChatEntityType")
        AND intent."message_author_kind" = 'bot'
        AND intent."origin_bot_id" = ${presenceBotId}
        AND intent."routing_policy" = 'origin_only'
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" bot_reason
          WHERE bot_reason."intent_id" = intent."id"
            AND bot_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" other_reason
          WHERE other_reason."intent_id" = intent."id"
            AND other_reason."rule_code" <> ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
        )
      RETURNING intent."id"
    `);
    if (rows[0]?.id !== intent.id) {
      return false;
    }

    await tx.auditLog.create({
      data: {
        chatId: intent.chatId,
        actorUserId,
        action: REPAIR_AUDIT_ACTION,
        payload: {
          repairVersion: 1,
          intentId: intent.id,
          messageId: intent.messageId,
          ruleCode: BOT_MESSAGE_AUTO_DELETE_RULE_CODE,
          previousStatus: intent.status,
          previousUpdatedAt: intent.updatedAt.toISOString(),
          previousAttemptCount: intent.attemptCount,
          previousLastBotId: intent.lastBotId,
          previousSucceededBotId: intent.succeededBotId,
          previousDeleteDispatchStartedAt: intent.deleteDispatchStartedAt?.toISOString() ?? null,
          previousDeleteDispatchStartedBotId: intent.deleteDispatchStartedBotId,
          previousRemoteDeleteSucceededAt: intent.remoteDeleteSucceededAt?.toISOString() ?? null,
          previousRemoteDeleteSucceededBotId: intent.remoteDeleteSucceededBotId,
          previousLastStatusCode: intent.lastStatusCode,
          previousLastErrorCode: intent.lastErrorCode,
          previousCompletedAt: intent.completedAt?.toISOString() ?? null,
          previousAbsenceVerifiedAt: intent.absenceVerifiedAt?.toISOString() ?? null,
          previousAbsenceVerifiedBotId: intent.absenceVerifiedBotId,
          previousAbsenceVerificationCode: intent.absenceVerificationCode,
          exactPresence: 'present',
          presenceCheckedAt: presenceCheckedAt.toISOString(),
          presenceBotId,
          retryUntilAt: retryUntilAt.toISOString(),
        },
      },
    });
    return true;
  });
}

async function repairOne(
  dependencies: RepairDependencies,
  options: BotAutoDeletePresenceRepairOptions,
  target: BotAutoDeletePresenceRepairTarget,
  now: () => Date,
): Promise<BotAutoDeletePresenceRepairOutcome> {
  const storedIntent = await dependencies.prisma.moderationDeleteIntent.findUnique({
    where: {
      chatId_messageId: target,
    },
    select: INTENT_SELECT,
  });
  if (!storedIntent) {
    return repairMissingLegacyIntent(dependencies, options, target, now);
  }
  const eligibility = classifyBotAutoDeletePresenceRepairIntent(storedIntent);
  if (!eligibility.eligible) {
    return ineligibleOutcome(target, storedIntent, eligibility.reason);
  }

  const { intent, originBotId } = eligibility;
  if (
    dependencies.intentService.getRolloutForRuleCodes(target.chatId, [
      BOT_MESSAGE_AUTO_DELETE_RULE_CODE,
    ]) !== 'execute'
  ) {
    return ineligibleOutcome(target, intent, 'execution_rollout_disabled');
  }

  let presence: 'present' | 'absent';
  const presenceCheckedAt = now();
  try {
    presence = await dependencies.maxClient.getExactMessagePresence(
      target.chatId,
      target.messageId,
      {
        botId: originBotId,
        bypassCache: true,
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
        timeoutMs: REPAIR_PRESENCE_TIMEOUT_MS,
      },
    );
  } catch (error: unknown) {
    return {
      ...target,
      intentId: intent.id,
      result: 'error',
      reason: null,
      previousStatus: intent.status,
      presenceBotId: originBotId,
      error: `Exact live presence lookup failed: ${normalizeError(error)}`,
    };
  }

  if (presence === 'absent') {
    return {
      ...target,
      intentId: intent.id,
      result: 'already_absent',
      reason: null,
      previousStatus: intent.status,
      presenceBotId: originBotId,
    };
  }
  if (!options.apply) {
    return {
      ...target,
      intentId: intent.id,
      result: 'would_reopen',
      reason: null,
      previousStatus: intent.status,
      presenceBotId: originBotId,
    };
  }

  const retryUntilAt = new Date(presenceCheckedAt.getTime() + REPAIR_RETRY_HORIZON_MS);
  let reopened: boolean;
  try {
    reopened = await reopenIntentWithAudit({
      prisma: dependencies.prisma,
      intent,
      actorUserId: options.actorUserId!,
      presenceBotId: originBotId,
      presenceCheckedAt,
      retryUntilAt,
    });
  } catch (error: unknown) {
    return {
      ...target,
      intentId: intent.id,
      result: 'error',
      reason: null,
      previousStatus: intent.status,
      presenceBotId: originBotId,
      error: `CAS reopen transaction failed: ${normalizeError(error)}`,
    };
  }
  if (!reopened) {
    return {
      ...target,
      intentId: intent.id,
      result: 'cas_conflict',
      reason: null,
      previousStatus: intent.status,
      presenceBotId: originBotId,
    };
  }

  try {
    await dependencies.intentService.enqueueCurrentIntentWakeupStrict(intent.id);
  } catch (error: unknown) {
    return {
      ...target,
      intentId: intent.id,
      result: 'reopened_enqueue_failed',
      reason: null,
      previousStatus: intent.status,
      presenceBotId: originBotId,
      error: normalizeError(error),
    };
  }

  return {
    ...target,
    intentId: intent.id,
    result: 'reopened',
    reason: null,
    previousStatus: intent.status,
    presenceBotId: originBotId,
  };
}

export async function runBotAutoDeletePresenceRepair(
  dependencies: RepairDependencies,
  options: BotAutoDeletePresenceRepairOptions,
  now: () => Date = () => new Date(),
): Promise<BotAutoDeletePresenceRepairSummary> {
  const outcomes: BotAutoDeletePresenceRepairOutcome[] = [];
  for (const target of options.targets) {
    try {
      outcomes.push(await repairOne(dependencies, options, target, now));
    } catch (error: unknown) {
      outcomes.push({
        ...target,
        intentId: null,
        result: 'error',
        reason: null,
        previousStatus: null,
        presenceBotId: null,
        error: normalizeError(error),
      });
    }
  }

  return {
    apply: options.apply,
    requested: outcomes.length,
    wouldReopen: outcomes.filter((outcome) => outcome.result === 'would_reopen').length,
    reopened: outcomes.filter((outcome) => outcome.result === 'reopened').length,
    wouldCreate: outcomes.filter((outcome) => outcome.result === 'would_create').length,
    created: outcomes.filter((outcome) => outcome.result === 'created').length,
    reconciledExisting: outcomes.filter((outcome) => outcome.result === 'reconciled_existing')
      .length,
    alreadyAbsent: outcomes.filter((outcome) => outcome.result === 'already_absent').length,
    ineligible: outcomes.filter((outcome) => outcome.result === 'ineligible').length,
    casConflicts: outcomes.filter((outcome) => outcome.result === 'cas_conflict').length,
    errors: outcomes.filter((outcome) =>
      ['error', 'reopened_enqueue_failed', 'created_enqueue_failed'].includes(outcome.result),
    ).length,
    outcomes,
  };
}

export function botAutoDeletePresenceRepairHasFailures(
  summary: BotAutoDeletePresenceRepairSummary,
): boolean {
  return (
    summary.errors > 0 || summary.casConflicts > 0 || (summary.apply && summary.ineligible > 0)
  );
}

function loadRepairEnvironment(): void {
  for (const envPath of new Set([
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(__dirname, '../../../../.env'),
    resolve(__dirname, '../../../../../../../.env'),
  ])) {
    loadEnv({ path: envPath, override: false, quiet: true });
  }
}

export function assertBotAutoDeletePresenceRepairRole(appRole: string | undefined): void {
  if (appRole?.trim() !== 'admin') {
    throw new Error('Bot auto-delete presence repair must run with APP_ROLE=admin');
  }
}

function writeSummary(summary: BotAutoDeletePresenceRepairSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  for (const outcome of summary.outcomes) {
    process.stdout.write(
      `${outcome.chatId} ${outcome.messageId}: ${outcome.result}${
        outcome.reason ? ` (${outcome.reason})` : ''
      }${outcome.error ? ` - ${outcome.error}` : ''}\n`,
    );
  }
  process.stdout.write(
    `${summary.apply ? 'Apply' : 'Dry-run'}: requested=${summary.requested} wouldReopen=${
      summary.wouldReopen
    } reopened=${summary.reopened} wouldCreate=${summary.wouldCreate} created=${
      summary.created
    } reconciledExisting=${summary.reconciledExisting} alreadyAbsent=${
      summary.alreadyAbsent
    } ineligible=${summary.ineligible} casConflicts=${summary.casConflicts} errors=${
      summary.errors
    }\n`,
  );
}

async function main(): Promise<void> {
  const options = readBotAutoDeletePresenceRepairOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${BOT_AUTO_DELETE_PRESENCE_REPAIR_USAGE}\n`);
    return;
  }

  loadRepairEnvironment();
  assertBotAutoDeletePresenceRepairRole(process.env.APP_ROLE);

  const [
    { NestFactory },
    { BotAutoDeletePresenceRepairModule },
    { MaxBotRegistryService },
    { MaxClientService },
    { ModerationDeleteIntentService },
    { PrismaService },
  ] = await Promise.all([
    import('@nestjs/core'),
    import('./bot-auto-delete-presence-repair.module'),
    import('../max/max-bot-registry.service'),
    import('../max/max-client.service'),
    import('../moderation/moderation-delete-intent.service'),
    import('../prisma/prisma.service'),
  ]);
  const app = await NestFactory.createApplicationContext(BotAutoDeletePresenceRepairModule, {
    logger: false,
  });
  try {
    const summary = await runBotAutoDeletePresenceRepair(
      {
        prisma: app.get(PrismaService),
        maxClient: app.get(MaxClientService),
        botRegistry: app.get(MaxBotRegistryService),
        intentService: app.get(ModerationDeleteIntentService),
      },
      options,
    );
    writeSummary(summary, options.json);
    if (botAutoDeletePresenceRepairHasFailures(summary)) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
