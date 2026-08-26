import { createHash, randomUUID } from 'node:crypto';
import { Queue, type ConnectionOptions, type Job, type JobState } from 'bullmq';
import Redis from 'ioredis';
import {
  DEFAULT_PRIMARY_ACCESS_SNAPSHOT_FRESH_MS,
  normalizeMembershipAccessSnapshot,
  normalizePermissionName,
} from '../max/max-bot-access-policy.util';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  MaxActionLedgerStatus,
  PublicationDispatchProfile,
  Prisma,
  createPrismaClient,
  type PrismaClient,
} from '../prisma/prisma-client';
import {
  VK_PARSING_PUBLISH_QUEUE,
  VK_PARSING_PUBLISH_RETRY_POLICY,
  type VkParsingPublishJob,
} from '../admin/vk-parsing.queue';

const VK_PUBLISH_JOB_NAME = 'publish-vk-post';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const DEFAULT_START_DELAY_MS = 5 * 60_000;
const APPLY_MAX_CUTOFF_AGE_MS = 30 * 60_000;
const APPLY_MIN_START_DELAY_MS = 24 * 60 * 60_000;
const REPAIR_SCHEDULE_DRIFT_TOLERANCE_MS = 5_000;
const REPAIR_CHAT_SPACING_MS = 15 * 60_000;
const REPAIR_SCHEDULE_STEP_MS = 15 * 60_000;
const REPAIR_MAX_SCHEDULE_LOOKAHEAD_STEPS = (8 * 24 * 60) / 15;
const REPAIR_ORPHAN_SCAN_LIMIT = 500;
const REPAIR_ORPHAN_SCAN_STATES = [
  'waiting',
  'delayed',
  'prioritized',
  'active',
  'failed',
] as const;
const REPAIR_LOCK_KEY = 'maxim:repair:vk-parsing-publish:v1';
const REPAIR_LOCK_TTL_MS = 15 * 60_000;
const REPAIR_AUDIT_ACTION = 'VK_PARSING_REPAIR_PUBLISH_QUEUE';
const REPAIR_ACTOR_USER_ID = 'vk-parsing-publish-repair';
const ACCESS_LOSS_ERROR_CODE = 'max.access_lost';
const MAX_SEND_AMBIGUOUS_ERROR_PREFIX = '[max.send_ambiguous]';
const CHANNEL_WRITE_PERMISSIONS = new Set(['write', 'can_write']);

const REPAIR_POST_SELECT = {
  id: true,
  sourceId: true,
  chatId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  vkPublishedAt: true,
  publishedMessageId: true,
  publishedAtMax: true,
  autoPublishedAt: true,
  autoPublishError: true,
  publishQueuedAt: true,
  publishScheduledAt: true,
  publishCancelledAt: true,
  publishCancelledByUserId: true,
  publishLockedAt: true,
  publishAttemptCount: true,
  publishIdempotencyKey: true,
  publishReason: true,
  dispatchProfile: true,
  lastError: true,
  source: {
    select: {
      id: true,
      status: true,
      importEnabled: true,
      autoPublishEnabled: true,
      autoPublishEnabledAt: true,
      autoPublishPausedAt: true,
      autoPublishPausedReason: true,
      publishIntervalMinutes: true,
      dailyLimit: true,
      minPublishIntervalMinutes: true,
      publishMode: true,
      priority: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      lastAutoPublishedAt: true,
      lastErrorCode: true,
      circuitReasonCode: true,
      updatedAt: true,
    },
  },
  chat: {
    select: {
      entityType: true,
      routingState: true,
      updatedAt: true,
      vkParsingSettings: {
        select: {
          autoPublishEnabled: true,
          autoPublishEnabledAt: true,
          autoPublishKillSwitchEnabled: true,
          schedulerTimezone: true,
          quietHoursStart: true,
          quietHoursEnd: true,
          workHoursStart: true,
          workHoursEnd: true,
          distributeEvenlyEnabled: true,
          roundRobinEnabled: true,
          updatedAt: true,
        },
      },
      botMemberships: {
        select: {
          botId: true,
          status: true,
          botAccessState: true,
          botAccessCheckedAt: true,
          botAccessExpiresAt: true,
          permissionsSnapshot: true,
          sendRouteQuarantinedUntil: true,
          updatedAt: true,
        },
        orderBy: { botId: 'asc' },
      },
    },
  },
} satisfies Prisma.VkParsingPostSelect;

const REPAIR_LEDGER_SELECT = {
  jobId: true,
  actionType: true,
  chatId: true,
  status: true,
  ambiguous: true,
  terminal: true,
  attemptCount: true,
  firstAttemptAt: true,
  lastAttemptAt: true,
  dispatchToken: true,
  dispatchStartedAt: true,
  dispatchBotId: true,
  remoteMessageId: true,
  updatedAt: true,
} satisfies Prisma.MaxActionLedgerEntrySelect;

type RepairPostRow = Prisma.VkParsingPostGetPayload<{ select: typeof REPAIR_POST_SELECT }>;
type RepairLedgerRow = Prisma.MaxActionLedgerEntryGetPayload<{
  select: typeof REPAIR_LEDGER_SELECT;
}>;

export type VkPublishRepairOptions = {
  apply: boolean;
  json: boolean;
  cutoff: Date;
  cutoffExplicit: boolean;
  startAt: Date;
  startAtExplicit: boolean;
  chatIds: string[];
  limit: number;
  limitExplicit: boolean;
  batchSize: number;
  confirmPlanHash: string | null;
};

export type RepairQueueEvidence = {
  presence: 'missing' | 'present';
  jobId: string;
  name: string | null;
  state: JobState | 'unknown' | 'missing';
  postId: string | null;
  chatId: string | null;
  reason: string | null;
  idempotencyKey: string | null;
  attemptsMade: number;
  attemptsStarted: number;
  processedOn: string | null;
  finishedOn: string | null;
  dueAt: string | null;
};

export type RepairLedgerEvidence = {
  presence: 'missing' | 'present';
  jobId: string;
  actionType: string | null;
  chatId: string | null;
  status: string | null;
  ambiguous: boolean;
  terminal: boolean;
  attemptCount: number;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  dispatchTokenPresent: boolean;
  dispatchStartedAt: string | null;
  dispatchBotId: string | null;
  remoteMessageIdPresent: boolean;
  updatedAt: string | null;
};

export type RepairAccessEvidence = {
  routingState: string;
  entityType: string;
  capableBotIds: string[];
  memberships: Array<{
    botId: string;
    status: string;
    accessState: string;
    accessCheckedAt: string | null;
    accessExpiresAt: string | null;
    quarantinedUntil: string | null;
    permissions: string[];
    updatedAt: string;
  }>;
};

export type RepairCandidateFacts = {
  postId: string;
  chatId: string;
  sourceId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  vkPublishedAt: string | null;
  publishedMessageId: string | null;
  publishedAtMax: string | null;
  autoPublishedAt: string | null;
  autoPublishError: string | null;
  publishQueuedAt: string | null;
  publishScheduledAt: string | null;
  publishCancelledAt: string | null;
  publishCancelledByUserId: string | null;
  publishLockedAt: string | null;
  publishAttemptCount: number;
  publishIdempotencyKey: string | null;
  publishReason: string | null;
  dispatchProfile: 'LEGACY_ROUTED' | 'PUBLIK_V1';
  lastError: string | null;
  source: {
    status: string;
    importEnabled: boolean;
    autoPublishEnabled: boolean;
    autoPublishEnabledAt: string | null;
    autoPublishPausedAt: string | null;
    autoPublishPausedReason: string | null;
    publishIntervalMinutes: number;
    dailyLimit: number;
    minPublishIntervalMinutes: number;
    publishMode: string;
    priority: string;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    lastAutoPublishedAt: string | null;
    lastErrorCode: string | null;
    circuitReasonCode: string | null;
    updatedAt: string;
  };
  settings: {
    autoPublishEnabled: boolean;
    autoPublishEnabledAt: string | null;
    autoPublishKillSwitchEnabled: boolean;
    schedulerTimezone: string;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    workHoursStart: string;
    workHoursEnd: string;
    distributeEvenlyEnabled: boolean;
    roundRobinEnabled: boolean;
    updatedAt: string;
  } | null;
  access: RepairAccessEvidence;
};

export type RepairSkipReason =
  | 'manual_ownership'
  | 'invalid_ownership'
  | 'cancelled'
  | 'already_published'
  | 'ownership_locked'
  | 'ambiguous_send'
  | 'attempted_send'
  | 'automation_disabled'
  | 'access_loss'
  | 'access_unproven'
  | 'queue_active'
  | 'queue_attempted'
  | 'queue_invalid'
  | 'ledger_active'
  | 'ledger_ambiguous'
  | 'ledger_attempted';

export type RepairPlanEntry = {
  postId: string;
  chatId: string;
  sourceId: string;
  publishIdempotencyKey: string | null;
  previousScheduledAt: string | null;
  nextScheduledAt: string | null;
  action: 'repair' | 'already_correct' | 'skip';
  skipReason: RepairSkipReason | null;
  evidenceHash: string;
  facts: RepairCandidateFacts;
  queue: RepairQueueEvidence;
  ledger: RepairLedgerEvidence;
};

export type RepairOrphanPlanEntry = {
  jobId: string;
  action: 'report_only' | 'skip';
  skipReason: 'active' | 'attempted' | 'ledger_evidence' | 'unsupported_state' | null;
  evidenceHash: string;
  queue: RepairQueueEvidence;
  ledger: RepairLedgerEvidence;
};

export type VkPublishRepairPlanDocument = {
  version: 1;
  cutoff: string;
  startAt: string;
  chatIds: string[];
  limit: number;
  batchSize: number;
  chatSpacingMs: number;
  totalOwnershipRowsAtCutoff: number;
  ownershipRowsAfterCutoff: number;
  entries: RepairPlanEntry[];
  orphanScan: {
    limit: number;
    totalJobsInScannedStates: number;
    scannedJobs: number;
    truncated: boolean;
    entries: RepairOrphanPlanEntry[];
  };
};

export type VkPublishRepairPlan = {
  planHash: string;
  document: VkPublishRepairPlanDocument;
  queue: {
    paused: boolean;
    active: number;
  };
};

export type RepairApplyOutcome = {
  postId: string;
  result: 'applied' | 'cas_conflict' | 'revalidation_conflict' | 'queue_error';
  error?: string;
};

export type RepairOrphanApplyOutcome = {
  jobId: string;
  result: 'removed' | 'already_missing' | 'revalidation_conflict' | 'ownership_restored' | 'error';
  error?: string;
};

export const VK_PUBLISH_REPAIR_USAGE = [
  'Usage:',
  '  [--cutoff <ISO>] [--start-at <ISO>] [--chat-id <id[,id...]>] [--limit 1..500]',
  '    [--batch-size 1..100] [--dry-run] [--json]',
  '  --apply --cutoff <ISO> --start-at <ISO> --limit <n> --confirm-plan-hash <sha256>',
  '    [--chat-id <id[,id...]>] [--batch-size <n>] [--json]',
  '',
  `Dry-run is the default and is bounded to ${DEFAULT_LIMIT} ownership rows.`,
  '--cutoff freezes the selected ownership set; --start-at freezes the first repair slot.',
  '--chat-id is repeatable and scopes both dry-run and apply for a canary.',
  '--apply requires the exact hash printed by a dry-run with identical options.',
  'Apply requires a cutoff no older than 30 minutes and starts at least 24 hours after it.',
  'Apply also requires vk-parsing-publish to be globally paused with zero active jobs.',
  'The command never drains, obliterates, resumes, or sends directly to MAX.',
].join('\n');

function readRequiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function readBoundedPositiveInteger(raw: string, option: string, maximum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${option} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function readIsoDate(raw: string, option: string): Date {
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime()) || value.toISOString() !== raw) {
    throw new Error(`${option} must be an exact ISO-8601 UTC timestamp`);
  }
  return value;
}

function appendChatIds(target: Set<string>, raw: string): void {
  for (const chatId of raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    target.add(chatId);
  }
  if (target.size === 0) {
    throw new Error('--chat-id requires at least one non-empty chat ID');
  }
}

export function readVkPublishRepairOptions(
  argv: readonly string[],
  now: Date = new Date(),
): VkPublishRepairOptions {
  let apply = false;
  let explicitDryRun = false;
  let json = false;
  let cutoff = new Date(now);
  let cutoffExplicit = false;
  let startAt = new Date(now.getTime() + DEFAULT_START_DELAY_MS);
  let startAtExplicit = false;
  const chatIds = new Set<string>();
  let limit = DEFAULT_LIMIT;
  let limitExplicit = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  let confirmPlanHash: string | null = null;

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
    if (arg === '--cutoff') {
      cutoff = readIsoDate(readRequiredValue(argv, index, arg), arg);
      cutoffExplicit = true;
      index += 1;
      continue;
    }
    if (arg === '--start-at') {
      startAt = readIsoDate(readRequiredValue(argv, index, arg), arg);
      startAtExplicit = true;
      index += 1;
      continue;
    }
    if (arg === '--chat-id') {
      appendChatIds(chatIds, readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      limit = readBoundedPositiveInteger(readRequiredValue(argv, index, arg), arg, MAX_LIMIT);
      limitExplicit = true;
      index += 1;
      continue;
    }
    if (arg === '--batch-size') {
      batchSize = readBoundedPositiveInteger(
        readRequiredValue(argv, index, arg),
        arg,
        MAX_BATCH_SIZE,
      );
      index += 1;
      continue;
    }
    if (arg === '--confirm-plan-hash') {
      confirmPlanHash = readRequiredValue(argv, index, arg).toLowerCase();
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(VK_PUBLISH_REPAIR_USAGE);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (apply && explicitDryRun) {
    throw new Error('--apply cannot be combined with --dry-run');
  }
  if (batchSize > limit) {
    throw new Error('--batch-size cannot exceed --limit');
  }
  if (confirmPlanHash && !/^[a-f0-9]{64}$/u.test(confirmPlanHash)) {
    throw new Error('--confirm-plan-hash must be a 64-character lowercase SHA-256 digest');
  }
  if (!apply && confirmPlanHash) {
    throw new Error('--confirm-plan-hash is valid only with --apply');
  }
  if (apply && !cutoffExplicit) {
    throw new Error('--apply requires an explicit --cutoff');
  }
  if (apply && !startAtExplicit) {
    throw new Error('--apply requires an explicit --start-at');
  }
  if (apply && !limitExplicit) {
    throw new Error('--apply requires an explicit --limit');
  }
  if (apply && !confirmPlanHash) {
    throw new Error('--apply requires --confirm-plan-hash');
  }
  if (cutoff.getTime() > now.getTime()) {
    throw new Error('--cutoff must not be in the future');
  }
  if (apply && now.getTime() - cutoff.getTime() > APPLY_MAX_CUTOFF_AGE_MS) {
    throw new Error('--apply requires a cutoff no older than 30 minutes');
  }
  if (apply && startAt.getTime() - cutoff.getTime() < APPLY_MIN_START_DELAY_MS) {
    throw new Error('--apply requires --start-at at least 24 hours after --cutoff');
  }
  if (startAt.getTime() < now.getTime()) {
    throw new Error('--start-at must not be in the past');
  }

  return {
    apply,
    json,
    cutoff,
    cutoffExplicit,
    startAt,
    startAtExplicit,
    chatIds: [...chatIds].sort(),
    limit,
    limitExplicit,
    batchSize,
    confirmPlanHash,
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Plan contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Plan contains unsupported value type: ${typeof value}`);
}

export function hashRepairPlan(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function iso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildPublishJobId(postId: string, idempotencyKey: string): string {
  return `vk-parsing-publish__${postId}__${idempotencyKey}`;
}

function buildLedgerJobId(postId: string, idempotencyKey: string): string {
  return `vk-parsing:publish:${postId}:${idempotencyKey}`;
}

function toQueueEvidence(
  jobId: string,
  job: Job<VkParsingPublishJob> | null,
  state: JobState | 'unknown' | 'missing',
): RepairQueueEvidence {
  if (!job) {
    return {
      presence: 'missing',
      jobId,
      name: null,
      state: 'missing',
      postId: null,
      chatId: null,
      reason: null,
      idempotencyKey: null,
      attemptsMade: 0,
      attemptsStarted: 0,
      processedOn: null,
      finishedOn: null,
      dueAt: null,
    };
  }

  const timestamp = Number(job.timestamp);
  const delay = Number(job.delay);
  const dueAt =
    Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(delay) && delay >= 0
      ? new Date(timestamp + delay).toISOString()
      : null;
  return {
    presence: 'present',
    jobId,
    name: nullableString(job.name),
    state,
    postId: nullableString(job.data?.postId),
    chatId: nullableString(job.data?.chatId),
    reason: nullableString(job.data?.reason),
    idempotencyKey: nullableString(job.data?.idempotencyKey),
    attemptsMade: Number.isFinite(job.attemptsMade) ? Math.max(0, job.attemptsMade) : 0,
    attemptsStarted: Number.isFinite(job.attemptsStarted) ? Math.max(0, job.attemptsStarted) : 0,
    processedOn:
      typeof job.processedOn === 'number' && job.processedOn > 0
        ? new Date(job.processedOn).toISOString()
        : null,
    finishedOn:
      typeof job.finishedOn === 'number' && job.finishedOn > 0
        ? new Date(job.finishedOn).toISOString()
        : null,
    dueAt,
  };
}

function toLedgerEvidence(jobId: string, ledger: RepairLedgerRow | null): RepairLedgerEvidence {
  if (!ledger) {
    return {
      presence: 'missing',
      jobId,
      actionType: null,
      chatId: null,
      status: null,
      ambiguous: false,
      terminal: false,
      attemptCount: 0,
      firstAttemptAt: null,
      lastAttemptAt: null,
      dispatchTokenPresent: false,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageIdPresent: false,
      updatedAt: null,
    };
  }
  return {
    presence: 'present',
    jobId,
    actionType: ledger.actionType,
    chatId: ledger.chatId,
    status: ledger.status,
    ambiguous: ledger.ambiguous,
    terminal: ledger.terminal,
    attemptCount: ledger.attemptCount,
    firstAttemptAt: iso(ledger.firstAttemptAt),
    lastAttemptAt: iso(ledger.lastAttemptAt),
    dispatchTokenPresent: Boolean(nullableString(ledger.dispatchToken)),
    dispatchStartedAt: iso(ledger.dispatchStartedAt),
    dispatchBotId: nullableString(ledger.dispatchBotId),
    remoteMessageIdPresent: Boolean(nullableString(ledger.remoteMessageId)),
    updatedAt: ledger.updatedAt.toISOString(),
  };
}

export function hasFreshRepairAccessSnapshot(
  checkedAt: Date | null,
  snapshotCheckedAt: string | null,
  expiresAt: Date | null,
  observedAt: Date,
): boolean {
  const observedAtMs = observedAt.getTime();
  const checkedAtMs =
    checkedAt?.getTime() ?? (snapshotCheckedAt ? Date.parse(snapshotCheckedAt) : Number.NaN);
  if (!Number.isFinite(checkedAtMs) || checkedAtMs > observedAtMs) {
    return false;
  }
  return expiresAt
    ? expiresAt.getTime() > observedAtMs
    : checkedAtMs + DEFAULT_PRIMARY_ACCESS_SNAPSHOT_FRESH_MS > observedAtMs;
}

function hasFreshMembershipAccess(
  membership: RepairPostRow['chat']['botMemberships'][number],
  observedAt: Date,
): boolean {
  const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
  return hasFreshRepairAccessSnapshot(
    membership.botAccessCheckedAt,
    snapshot?.checkedAt ?? null,
    membership.botAccessExpiresAt,
    observedAt,
  );
}

function hasPersistedPublishCapability(
  entityType: ChatEntityType,
  membership: RepairPostRow['chat']['botMemberships'][number],
): boolean {
  const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
  if (membership.botAccessState === ChatBotAccessState.CONFIRMED_OWNER || snapshot?.isOwner) {
    return true;
  }
  if (membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN || !snapshot?.isAdmin) {
    return false;
  }
  if (entityType !== ChatEntityType.CHANNEL) {
    return true;
  }
  return snapshot.permissions.some((permission) =>
    CHANNEL_WRITE_PERMISSIONS.has(normalizePermissionName(permission)),
  );
}

function buildAccessEvidence(row: RepairPostRow, at: Date): RepairAccessEvidence {
  const memberships = row.chat.botMemberships.map((membership) => {
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    return {
      botId: membership.botId,
      status: membership.status,
      accessState: membership.botAccessState,
      accessCheckedAt: iso(membership.botAccessCheckedAt),
      accessExpiresAt: iso(membership.botAccessExpiresAt),
      quarantinedUntil: iso(membership.sendRouteQuarantinedUntil),
      permissions: snapshot?.permissions ?? [],
      updatedAt: membership.updatedAt.toISOString(),
    };
  });
  const capableBotIds = row.chat.botMemberships
    .filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        (!membership.sendRouteQuarantinedUntil ||
          membership.sendRouteQuarantinedUntil.getTime() <= at.getTime()) &&
        hasFreshMembershipAccess(membership, at) &&
        hasPersistedPublishCapability(row.chat.entityType, membership),
    )
    .map((membership) => membership.botId)
    .sort();
  return {
    routingState: row.chat.routingState,
    entityType: row.chat.entityType,
    capableBotIds,
    memberships,
  };
}

function toCandidateFacts(row: RepairPostRow, at: Date): RepairCandidateFacts {
  const settings = row.chat.vkParsingSettings;
  return {
    postId: row.id,
    chatId: row.chatId,
    sourceId: row.sourceId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    vkPublishedAt: iso(row.vkPublishedAt),
    publishedMessageId: nullableString(row.publishedMessageId),
    publishedAtMax: iso(row.publishedAtMax),
    autoPublishedAt: iso(row.autoPublishedAt),
    autoPublishError: nullableString(row.autoPublishError),
    publishQueuedAt: iso(row.publishQueuedAt),
    publishScheduledAt: iso(row.publishScheduledAt),
    publishCancelledAt: iso(row.publishCancelledAt),
    publishCancelledByUserId: nullableString(row.publishCancelledByUserId),
    publishLockedAt: iso(row.publishLockedAt),
    publishAttemptCount: row.publishAttemptCount,
    publishIdempotencyKey: nullableString(row.publishIdempotencyKey),
    publishReason: nullableString(row.publishReason),
    dispatchProfile: row.dispatchProfile,
    lastError: nullableString(row.lastError),
    source: {
      status: row.source.status,
      importEnabled: row.source.importEnabled,
      autoPublishEnabled: row.source.autoPublishEnabled,
      autoPublishEnabledAt: iso(row.source.autoPublishEnabledAt),
      autoPublishPausedAt: iso(row.source.autoPublishPausedAt),
      autoPublishPausedReason: nullableString(row.source.autoPublishPausedReason),
      publishIntervalMinutes: row.source.publishIntervalMinutes,
      dailyLimit: row.source.dailyLimit,
      minPublishIntervalMinutes: row.source.minPublishIntervalMinutes,
      publishMode: row.source.publishMode,
      priority: row.source.priority,
      quietHoursStart: nullableString(row.source.quietHoursStart),
      quietHoursEnd: nullableString(row.source.quietHoursEnd),
      lastAutoPublishedAt: iso(row.source.lastAutoPublishedAt),
      lastErrorCode: nullableString(row.source.lastErrorCode),
      circuitReasonCode: nullableString(row.source.circuitReasonCode),
      updatedAt: row.source.updatedAt.toISOString(),
    },
    settings: settings
      ? {
          autoPublishEnabled: settings.autoPublishEnabled,
          autoPublishEnabledAt: iso(settings.autoPublishEnabledAt),
          autoPublishKillSwitchEnabled: settings.autoPublishKillSwitchEnabled,
          schedulerTimezone: settings.schedulerTimezone,
          quietHoursStart: nullableString(settings.quietHoursStart),
          quietHoursEnd: nullableString(settings.quietHoursEnd),
          workHoursStart: settings.workHoursStart,
          workHoursEnd: settings.workHoursEnd,
          distributeEvenlyEnabled: settings.distributeEvenlyEnabled,
          roundRobinEnabled: settings.roundRobinEnabled,
          updatedAt: settings.updatedAt.toISOString(),
        }
      : null,
    access: buildAccessEvidence(row, at),
  };
}

function isAutomationEligible(facts: RepairCandidateFacts): boolean {
  const settings = facts.settings;
  if (
    !settings?.autoPublishEnabled ||
    !settings.autoPublishEnabledAt ||
    settings.autoPublishKillSwitchEnabled ||
    facts.source.status !== 'ACTIVE' ||
    !facts.source.importEnabled ||
    !facts.source.autoPublishEnabled ||
    !facts.source.autoPublishEnabledAt ||
    facts.source.autoPublishPausedAt !== null ||
    facts.source.publishMode === 'REVIEW'
  ) {
    return false;
  }
  const baselineMs = Math.max(
    Date.parse(settings.autoPublishEnabledAt),
    Date.parse(facts.source.autoPublishEnabledAt),
  );
  const createdAtMs = Date.parse(facts.createdAt);
  const vkPublishedAtMs = facts.vkPublishedAt ? Date.parse(facts.vkPublishedAt) : Number.NaN;
  return (
    Number.isFinite(baselineMs) &&
    Number.isFinite(vkPublishedAtMs) &&
    createdAtMs >= baselineMs &&
    vkPublishedAtMs >= baselineMs
  );
}

function hasAccessLoss(facts: RepairCandidateFacts): boolean {
  return (
    facts.source.lastErrorCode === ACCESS_LOSS_ERROR_CODE ||
    facts.source.circuitReasonCode === ACCESS_LOSS_ERROR_CODE ||
    facts.source.autoPublishPausedReason?.toLowerCase().includes('access') === true
  );
}

function queuePayloadMatches(facts: RepairCandidateFacts, queue: RepairQueueEvidence): boolean {
  return (
    queue.name === VK_PUBLISH_JOB_NAME &&
    queue.postId === facts.postId &&
    queue.chatId === facts.chatId &&
    queue.reason === facts.publishReason &&
    queue.idempotencyKey === facts.publishIdempotencyKey
  );
}

function hasOnlyPristineLedgerEvidence(ledger: RepairLedgerEvidence, chatId: string): boolean {
  if (ledger.presence === 'missing') {
    return true;
  }
  return (
    ledger.actionType === 'SEND_MESSAGE' &&
    ledger.chatId === chatId &&
    ledger.status === MaxActionLedgerStatus.ENQUEUED &&
    !ledger.terminal &&
    ledger.attemptCount === 0 &&
    !ledger.firstAttemptAt &&
    !ledger.lastAttemptAt &&
    !ledger.dispatchTokenPresent &&
    !ledger.dispatchStartedAt &&
    !ledger.dispatchBotId &&
    !ledger.remoteMessageIdPresent
  );
}

export function classifyRepairCandidate(
  facts: RepairCandidateFacts,
  queue: RepairQueueEvidence,
  ledger: RepairLedgerEvidence,
): RepairSkipReason | null {
  // FLAG: A cancelled or otherwise invalid DB owner must not hide a live BullMQ execution hazard.
  // Validate present queue evidence first so apply remains fail-closed for active, attempted,
  // malformed, or unsupported jobs even when the DB row itself is not repairable.
  if (queue.presence === 'present') {
    if (queue.state === 'active') {
      return 'queue_active';
    }
    if (
      queue.attemptsMade > 0 ||
      queue.attemptsStarted > 0 ||
      queue.processedOn ||
      queue.finishedOn
    ) {
      return 'queue_attempted';
    }
    if (!isExactPristineInactiveQueueReservation(facts, queue)) {
      return 'queue_invalid';
    }
  }
  if (facts.publishReason === 'manual-retry' || facts.publishReason === 'manual-schedule') {
    return 'manual_ownership';
  }
  if (
    facts.publishReason !== 'autopublish' ||
    !facts.publishIdempotencyKey ||
    !facts.publishQueuedAt ||
    (facts.status !== 'NEW' && facts.status !== 'FAILED')
  ) {
    return 'invalid_ownership';
  }
  if (facts.publishCancelledAt || facts.publishCancelledByUserId) {
    return 'cancelled';
  }
  if (facts.publishedMessageId || facts.publishedAtMax || facts.autoPublishedAt) {
    return 'already_published';
  }
  if (facts.publishLockedAt) {
    return 'ownership_locked';
  }
  if (
    facts.lastError?.startsWith(MAX_SEND_AMBIGUOUS_ERROR_PREFIX) ||
    facts.autoPublishError?.startsWith(MAX_SEND_AMBIGUOUS_ERROR_PREFIX)
  ) {
    return 'ambiguous_send';
  }
  if (facts.publishAttemptCount > 0 || facts.lastError || facts.autoPublishError) {
    return 'attempted_send';
  }
  if (!isAutomationEligible(facts)) {
    return hasAccessLoss(facts) ? 'access_loss' : 'automation_disabled';
  }
  if (
    hasAccessLoss(facts) ||
    facts.access.routingState !== ChatRoutingState.READY ||
    facts.access.capableBotIds.length === 0
  ) {
    return hasAccessLoss(facts) ? 'access_loss' : 'access_unproven';
  }
  if (ledger.presence === 'present') {
    if (ledger.status === MaxActionLedgerStatus.IN_PROGRESS) {
      return 'ledger_active';
    }
    if (ledger.ambiguous || ledger.status === MaxActionLedgerStatus.AMBIGUOUS) {
      return 'ledger_ambiguous';
    }
    if (!hasOnlyPristineLedgerEvidence(ledger, facts.chatId)) {
      return 'ledger_attempted';
    }
  }
  return null;
}

function evidenceHash(
  facts: RepairCandidateFacts,
  queue: RepairQueueEvidence,
  ledger: RepairLedgerEvidence,
): string {
  return hashRepairPlan({ facts, queue, ledger });
}

function schedulesMatch(
  previousScheduledAt: string | null,
  nextScheduledAt: string,
  queue: RepairQueueEvidence,
): boolean {
  if (previousScheduledAt !== nextScheduledAt || queue.presence !== 'present' || !queue.dueAt) {
    return false;
  }
  return (
    Math.abs(Date.parse(queue.dueAt) - Date.parse(nextScheduledAt)) <=
    REPAIR_SCHEDULE_DRIFT_TOLERANCE_MS
  );
}

function parseTimeOfDay(value: string): number {
  const [hoursRaw, minutesRaw] = value.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }
  return (
    Math.max(0, Math.min(23, Math.trunc(hours))) * 60 +
    Math.max(0, Math.min(59, Math.trunc(minutes)))
  );
}

function minuteInsideRange(minute: number, start: string, end: string): boolean {
  const startMinute = parseTimeOfDay(start);
  const endMinute = parseTimeOfDay(end);
  if (startMinute === endMinute) {
    return true;
  }
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

function minuteInTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function isAllowedRepairTime(date: Date, facts: RepairCandidateFacts): boolean {
  const settings = facts.settings;
  if (!settings) {
    return false;
  }
  let minute: number;
  try {
    minute = minuteInTimeZone(date, settings.schedulerTimezone);
  } catch {
    return false;
  }
  const inOptionalRange = (start: string | null, end: string | null): boolean =>
    Boolean(start && end && minuteInsideRange(minute, start, end));
  return (
    minuteInsideRange(minute, settings.workHoursStart, settings.workHoursEnd) &&
    !inOptionalRange(settings.quietHoursStart, settings.quietHoursEnd) &&
    !inOptionalRange(facts.source.quietHoursStart, facts.source.quietHoursEnd)
  );
}

function repairPriorityRank(priority: string): number {
  if (priority === 'HIGH') {
    return 0;
  }
  return priority === 'LOW' ? 2 : 1;
}

type AssessedRepairRow = {
  facts: RepairCandidateFacts;
  queue: RepairQueueEvidence;
  ledger: RepairLedgerEvidence;
};

function compareAssessedRepairRows(left: AssessedRepairRow, right: AssessedRepairRow): number {
  const byPriority =
    repairPriorityRank(left.facts.source.priority) -
    repairPriorityRank(right.facts.source.priority);
  if (byPriority !== 0) {
    return byPriority;
  }
  const leftPublishedAt = left.facts.vkPublishedAt
    ? Date.parse(left.facts.vkPublishedAt)
    : Date.parse(left.facts.createdAt);
  const rightPublishedAt = right.facts.vkPublishedAt
    ? Date.parse(right.facts.vkPublishedAt)
    : Date.parse(right.facts.createdAt);
  return leftPublishedAt - rightPublishedAt || left.facts.postId.localeCompare(right.facts.postId);
}

function orderAssessedRepairRows(assessed: readonly AssessedRepairRow[]): AssessedRepairRow[] {
  const byChat = new Map<string, AssessedRepairRow[]>();
  for (const row of assessed) {
    const rows = byChat.get(row.facts.chatId) ?? [];
    rows.push(row);
    byChat.set(row.facts.chatId, rows);
  }

  const ordered: AssessedRepairRow[] = [];
  for (const chatId of [...byChat.keys()].sort()) {
    const chatRows = byChat.get(chatId)!;
    if (!chatRows.some((row) => row.facts.settings?.roundRobinEnabled)) {
      ordered.push(...chatRows.sort(compareAssessedRepairRows));
      continue;
    }
    const bySource = new Map<string, AssessedRepairRow[]>();
    for (const row of chatRows) {
      const sourceRows = bySource.get(row.facts.sourceId) ?? [];
      sourceRows.push(row);
      bySource.set(row.facts.sourceId, sourceRows);
    }
    const sourceQueues = [...bySource.values()]
      .map((rows) => rows.sort(compareAssessedRepairRows))
      .sort((left, right) => compareAssessedRepairRows(left[0]!, right[0]!));
    let remaining = sourceQueues.reduce((total, queue) => total + queue.length, 0);
    while (remaining > 0) {
      for (const sourceQueue of sourceQueues) {
        const row = sourceQueue.shift();
        if (row) {
          ordered.push(row);
          remaining -= 1;
        }
      }
    }
  }
  return ordered;
}

function resolveRepairSourceSpacingMs(facts: RepairCandidateFacts): number {
  return (
    Math.max(
      5,
      facts.source.minPublishIntervalMinutes,
      ...(facts.settings?.distributeEvenlyEnabled ? [facts.source.publishIntervalMinutes] : []),
    ) * 60_000
  );
}

type RepairScheduleReservation = {
  postId: string;
  scheduledAtMs: number;
  sourceSpacingMs: number;
};

function isLiveRepairQueueState(state: RepairQueueEvidence['state']): boolean {
  return ['active', 'delayed', 'waiting', 'prioritized', 'waiting-children'].includes(state);
}

function isExactPristineInactiveQueueReservation(
  facts: RepairCandidateFacts,
  queue: RepairQueueEvidence,
): boolean {
  const idempotencyKey = facts.publishIdempotencyKey;
  const dueAtMs = queue.dueAt ? Date.parse(queue.dueAt) : Number.NaN;
  return (
    queue.presence === 'present' &&
    Boolean(idempotencyKey) &&
    queue.jobId === buildPublishJobId(facts.postId, idempotencyKey ?? '') &&
    queuePayloadMatches(facts, queue) &&
    ['autopublish', 'manual-retry', 'manual-schedule'].includes(queue.reason ?? '') &&
    ['delayed', 'waiting', 'prioritized'].includes(queue.state) &&
    queue.attemptsMade === 0 &&
    queue.attemptsStarted === 0 &&
    !queue.processedOn &&
    !queue.finishedOn &&
    Number.isFinite(dueAtMs)
  );
}

function addRepairScheduleReservation(
  reservationsByKey: Map<string, RepairScheduleReservation[]>,
  key: string,
  reservation: RepairScheduleReservation,
): void {
  const reservations = reservationsByKey.get(key) ?? [];
  const insertAt = reservations.findIndex(
    (current) =>
      current.scheduledAtMs > reservation.scheduledAtMs ||
      (current.scheduledAtMs === reservation.scheduledAtMs &&
        current.postId.localeCompare(reservation.postId) > 0),
  );
  if (insertAt === -1) {
    reservations.push(reservation);
  } else {
    reservations.splice(insertAt, 0, reservation);
  }
  reservationsByKey.set(key, reservations);
}

function hasRepairScheduleConflict(
  candidateMs: number,
  facts: RepairCandidateFacts,
  occupiedChatSchedules: ReadonlyMap<string, readonly RepairScheduleReservation[]>,
  occupiedSourceSchedules: ReadonlyMap<string, readonly RepairScheduleReservation[]>,
): boolean {
  const chatConflict = (occupiedChatSchedules.get(facts.chatId) ?? []).some(
    (reservation) => Math.abs(candidateMs - reservation.scheduledAtMs) < REPAIR_CHAT_SPACING_MS,
  );
  if (chatConflict) {
    return true;
  }
  const sourceSpacingMs = resolveRepairSourceSpacingMs(facts);
  return (occupiedSourceSchedules.get(facts.sourceId) ?? []).some(
    (reservation) =>
      Math.abs(candidateMs - reservation.scheduledAtMs) <
      Math.max(sourceSpacingMs, reservation.sourceSpacingMs),
  );
}

function resolveEarliestUnreservedRepairScheduleAt(
  candidateMs: number,
  facts: RepairCandidateFacts,
  occupiedChatSchedules: ReadonlyMap<string, readonly RepairScheduleReservation[]>,
  occupiedSourceSchedules: ReadonlyMap<string, readonly RepairScheduleReservation[]>,
): number {
  let currentMs = candidateMs;
  for (let step = 0; step < REPAIR_MAX_SCHEDULE_LOOKAHEAD_STEPS; step += 1) {
    if (
      isAllowedRepairTime(new Date(currentMs), facts) &&
      !hasRepairScheduleConflict(currentMs, facts, occupiedChatSchedules, occupiedSourceSchedules)
    ) {
      return currentMs;
    }
    currentMs += REPAIR_SCHEDULE_STEP_MS;
  }
  throw new Error(`No unreserved repair slot found within eight days for post ${facts.postId}`);
}

export function buildDeterministicRepairPlan(
  cutoff: Date,
  limit: number,
  batchSize: number,
  totalOwnershipRowsAtCutoff: number,
  assessed: Array<{
    facts: RepairCandidateFacts;
    queue: RepairQueueEvidence;
    ledger: RepairLedgerEvidence;
  }>,
  startAt: Date = cutoff,
  chatIds: readonly string[] = [],
  orphanScan: RepairOrphanScan = {
    limit: REPAIR_ORPHAN_SCAN_LIMIT,
    totalJobsInScannedStates: 0,
    scannedJobs: 0,
    truncated: false,
    entries: [],
  },
  ownershipRowsAfterCutoff = 0,
): VkPublishRepairPlanDocument {
  const occupiedChatSchedules = new Map<string, RepairScheduleReservation[]>();
  const occupiedSourceSchedules = new Map<string, RepairScheduleReservation[]>();
  const plannedBySource = new Map<string, number>();
  const repairablePostIds = new Set(
    assessed
      .filter(({ facts, queue, ledger }) => classifyRepairCandidate(facts, queue, ledger) === null)
      .map(({ facts }) => facts.postId),
  );
  // FLAG: Keep exact, pristine jobs that the repair cannot mutate as fixed reservations. Release
  // every repairable row before planning so one pass reaches the same deterministic fixed point
  // that a post-apply dry-run will calculate.
  for (const { facts, queue } of assessed) {
    if (
      repairablePostIds.has(facts.postId) ||
      !isExactPristineInactiveQueueReservation(facts, queue)
    ) {
      continue;
    }
    const fixedAtMs = Date.parse(queue.dueAt ?? '');
    const reservation = {
      postId: facts.postId,
      scheduledAtMs: fixedAtMs,
      sourceSpacingMs: resolveRepairSourceSpacingMs(facts),
    };
    addRepairScheduleReservation(occupiedChatSchedules, facts.chatId, reservation);
    addRepairScheduleReservation(occupiedSourceSchedules, facts.sourceId, reservation);
  }
  const ordered = orderAssessedRepairRows(assessed);
  const entries = ordered.map(({ facts, queue, ledger }): RepairPlanEntry => {
    const skipReason = classifyRepairCandidate(facts, queue, ledger);
    let nextScheduledAt: string | null = null;
    let action: RepairPlanEntry['action'] = 'skip';
    if (!skipReason) {
      const sourceSpacingMs = resolveRepairSourceSpacingMs(facts);
      const plannedForSource = plannedBySource.get(facts.sourceId) ?? 0;
      const dailyLimit = Math.max(1, facts.source.dailyLimit);
      const dailyWindowStartMs =
        startAt.getTime() + Math.floor(plannedForSource / dailyLimit) * 24 * 60 * 60_000;
      const lastPublishedFloorMs = facts.source.lastAutoPublishedAt
        ? Date.parse(facts.source.lastAutoPublishedAt) + sourceSpacingMs
        : 0;
      const candidateMs = Math.max(
        startAt.getTime(),
        dailyWindowStartMs,
        Number.isFinite(lastPublishedFloorMs) ? lastPublishedFloorMs : 0,
      );
      const scheduledAtMs = resolveEarliestUnreservedRepairScheduleAt(
        candidateMs,
        facts,
        occupiedChatSchedules,
        occupiedSourceSchedules,
      );
      nextScheduledAt = new Date(scheduledAtMs).toISOString();
      action = schedulesMatch(facts.publishScheduledAt, nextScheduledAt, queue)
        ? 'already_correct'
        : 'repair';
      const reservation = {
        postId: facts.postId,
        scheduledAtMs,
        sourceSpacingMs,
      };
      addRepairScheduleReservation(occupiedChatSchedules, facts.chatId, reservation);
      addRepairScheduleReservation(occupiedSourceSchedules, facts.sourceId, reservation);
      plannedBySource.set(facts.sourceId, plannedForSource + 1);
    }
    return {
      postId: facts.postId,
      chatId: facts.chatId,
      sourceId: facts.sourceId,
      publishIdempotencyKey: facts.publishIdempotencyKey,
      previousScheduledAt: facts.publishScheduledAt,
      nextScheduledAt,
      action,
      skipReason,
      evidenceHash: evidenceHash(facts, queue, ledger),
      facts,
      queue,
      ledger,
    };
  });
  return {
    version: 1,
    cutoff: cutoff.toISOString(),
    startAt: startAt.toISOString(),
    chatIds: [...chatIds].sort(),
    limit,
    batchSize,
    chatSpacingMs: REPAIR_CHAT_SPACING_MS,
    totalOwnershipRowsAtCutoff,
    ownershipRowsAfterCutoff,
    entries,
    orphanScan,
  };
}

async function inspectQueueJob(
  queue: Queue<VkParsingPublishJob>,
  facts: Pick<RepairCandidateFacts, 'postId' | 'publishIdempotencyKey'>,
): Promise<RepairQueueEvidence> {
  const key = facts.publishIdempotencyKey ?? 'missing-key';
  const jobId = buildPublishJobId(facts.postId, key);
  const job = (await queue.getJob(jobId)) ?? null;
  const state = job ? await job.getState() : 'missing';
  return toQueueEvidence(jobId, job, state);
}

async function inspectLedger(
  prisma: PrismaClient,
  facts: Pick<RepairCandidateFacts, 'postId' | 'publishIdempotencyKey'>,
): Promise<RepairLedgerEvidence> {
  const key = facts.publishIdempotencyKey ?? 'missing-key';
  const jobId = buildLedgerJobId(facts.postId, key);
  const ledger = await prisma.maxActionLedgerEntry.findUnique({
    where: { jobId },
    select: REPAIR_LEDGER_SELECT,
  });
  return toLedgerEvidence(jobId, ledger);
}

async function assessRow(
  prisma: PrismaClient,
  queue: Queue<VkParsingPublishJob>,
  row: RepairPostRow,
  observedAt: Date,
): Promise<{
  facts: RepairCandidateFacts;
  queue: RepairQueueEvidence;
  ledger: RepairLedgerEvidence;
}> {
  const facts = toCandidateFacts(row, observedAt);
  const [queueEvidence, ledgerEvidence] = await Promise.all([
    inspectQueueJob(queue, facts),
    inspectLedger(prisma, facts),
  ]);
  return { facts, queue: queueEvidence, ledger: ledgerEvidence };
}

type RepairOrphanScan = VkPublishRepairPlanDocument['orphanScan'];

export function classifyRepairOrphan(
  queue: RepairQueueEvidence,
  ledger: RepairLedgerEvidence,
): RepairOrphanPlanEntry['skipReason'] {
  if (queue.state === 'active') {
    return 'active';
  }
  if (
    queue.attemptsMade > 0 ||
    queue.attemptsStarted > 0 ||
    queue.processedOn ||
    queue.finishedOn
  ) {
    return 'attempted';
  }
  if (!['delayed', 'waiting', 'prioritized'].includes(queue.state)) {
    return 'unsupported_state';
  }
  if (!queue.chatId || !hasOnlyPristineLedgerEvidence(ledger, queue.chatId)) {
    return 'ledger_evidence';
  }
  return null;
}

async function scanRepairOrphans(
  prisma: PrismaClient,
  queue: Queue<VkParsingPublishJob>,
  chatIds: readonly string[],
): Promise<RepairOrphanScan> {
  const counts = await queue.getJobCounts(...REPAIR_ORPHAN_SCAN_STATES);
  const totalJobsInScannedStates = REPAIR_ORPHAN_SCAN_STATES.reduce(
    (total, state) => total + (counts[state] ?? 0),
    0,
  );
  const jobs = await queue.getJobs(
    [...REPAIR_ORPHAN_SCAN_STATES],
    0,
    REPAIR_ORPHAN_SCAN_LIMIT - 1,
    true,
  );
  const chatFilter = new Set(chatIds);
  const evidence: RepairQueueEvidence[] = [];
  for (const job of jobs) {
    const jobId = job.id ?? '';
    const state = await job.getState();
    const snapshot = toQueueEvidence(jobId, job, state);
    if (
      snapshot.name !== VK_PUBLISH_JOB_NAME ||
      snapshot.reason !== 'autopublish' ||
      !snapshot.postId ||
      !snapshot.chatId ||
      !snapshot.idempotencyKey ||
      snapshot.jobId !== buildPublishJobId(snapshot.postId, snapshot.idempotencyKey) ||
      (chatFilter.size > 0 && !chatFilter.has(snapshot.chatId))
    ) {
      continue;
    }
    evidence.push(snapshot);
  }

  const postIds = [...new Set(evidence.map((entry) => entry.postId).filter(Boolean))] as string[];
  const currentRows =
    postIds.length > 0
      ? await prisma.vkParsingPost.findMany({
          where: { id: { in: postIds } },
          select: {
            id: true,
            chatId: true,
            publishReason: true,
            publishIdempotencyKey: true,
            dispatchProfile: true,
          },
        })
      : [];
  const currentOwnerByPostId = new Map(currentRows.map((row) => [row.id, row]));
  const orphanEvidence = evidence.filter((entry) => {
    const current = currentOwnerByPostId.get(entry.postId!);
    return !(
      current?.chatId === entry.chatId &&
      current.dispatchProfile === PublicationDispatchProfile.LEGACY_ROUTED &&
      current.publishReason === 'autopublish' &&
      current.publishIdempotencyKey === entry.idempotencyKey
    );
  });
  const entries: RepairOrphanPlanEntry[] = [];
  for (const batch of chunks(orphanEvidence, DEFAULT_BATCH_SIZE)) {
    entries.push(
      ...(await Promise.all(
        batch.map(async (queueEvidence): Promise<RepairOrphanPlanEntry> => {
          const ledger = await inspectLedger(prisma, {
            postId: queueEvidence.postId!,
            publishIdempotencyKey: queueEvidence.idempotencyKey,
          });
          const skipReason = classifyRepairOrphan(queueEvidence, ledger);
          return {
            jobId: queueEvidence.jobId,
            action: skipReason ? 'skip' : 'report_only',
            skipReason,
            evidenceHash: hashRepairPlan({ queue: queueEvidence, ledger }),
            queue: queueEvidence,
            ledger,
          };
        }),
      )),
    );
  }

  return {
    limit: REPAIR_ORPHAN_SCAN_LIMIT,
    totalJobsInScannedStates,
    scannedJobs: jobs.length,
    truncated: totalJobsInScannedStates > jobs.length,
    entries: entries.sort((left, right) => left.jobId.localeCompare(right.jobId)),
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export async function buildVkPublishRepairPlan(
  prisma: PrismaClient,
  queue: Queue<VkParsingPublishJob>,
  options: VkPublishRepairOptions,
): Promise<VkPublishRepairPlan> {
  const observedAt = new Date();
  const where = {
    dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
    publishQueuedAt: { not: null, lte: options.cutoff },
    publishIdempotencyKey: { not: null },
    ...(options.chatIds.length > 0 ? { chatId: { in: options.chatIds } } : {}),
  } satisfies Prisma.VkParsingPostWhereInput;
  const afterCutoffWhere = {
    dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
    publishQueuedAt: { gt: options.cutoff },
    publishIdempotencyKey: { not: null },
    ...(options.chatIds.length > 0 ? { chatId: { in: options.chatIds } } : {}),
  } satisfies Prisma.VkParsingPostWhereInput;
  const [rows, totalOwnershipRowsAtCutoff, ownershipRowsAfterCutoff, paused, counts, orphanScan] =
    await Promise.all([
      prisma.vkParsingPost.findMany({
        where,
        select: REPAIR_POST_SELECT,
        orderBy: [
          { publishScheduledAt: 'asc' },
          { publishQueuedAt: 'asc' },
          { updatedAt: 'asc' },
          { id: 'asc' },
        ],
        take: options.limit,
      }),
      prisma.vkParsingPost.count({ where }),
      prisma.vkParsingPost.count({ where: afterCutoffWhere }),
      queue.isPaused(),
      queue.getJobCounts('active'),
      scanRepairOrphans(prisma, queue, options.chatIds),
    ]);
  const assessed: Awaited<ReturnType<typeof assessRow>>[] = [];
  for (const batch of chunks(rows, options.batchSize)) {
    assessed.push(
      ...(await Promise.all(batch.map((row) => assessRow(prisma, queue, row, observedAt)))),
    );
  }
  const document = buildDeterministicRepairPlan(
    options.cutoff,
    options.limit,
    options.batchSize,
    totalOwnershipRowsAtCutoff,
    assessed,
    options.startAt,
    options.chatIds,
    orphanScan,
    ownershipRowsAfterCutoff,
  );
  return {
    planHash: hashRepairPlan(document),
    document,
    queue: { paused, active: counts.active ?? 0 },
  };
}

type RedisLockClient = Pick<Redis, 'set' | 'eval'>;

export async function acquireRepairLock(
  redis: RedisLockClient,
  token: string = randomUUID(),
): Promise<string | null> {
  const acquired = await redis.set(REPAIR_LOCK_KEY, token, 'PX', REPAIR_LOCK_TTL_MS, 'NX');
  return acquired === 'OK' ? token : null;
}

export async function renewRepairLock(redis: RedisLockClient, token: string): Promise<boolean> {
  const renewed = await redis.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
    1,
    REPAIR_LOCK_KEY,
    token,
    String(REPAIR_LOCK_TTL_MS),
  );
  return Number(renewed) > 0;
}

export async function releaseRepairLock(redis: RedisLockClient, token: string): Promise<void> {
  // FLAG: Release is compare-and-delete; an expired lock may already belong to another operator.
  await redis.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    1,
    REPAIR_LOCK_KEY,
    token,
  );
}

export type RepairLockHeartbeat = {
  assertHealthy: () => void;
  stop: () => Promise<void>;
};

export function startRepairLockHeartbeat(
  redis: RedisLockClient,
  token: string,
  intervalMs: number = Math.floor(REPAIR_LOCK_TTL_MS / 3),
): RepairLockHeartbeat {
  let stopped = false;
  let lostError: Error | null = null;
  let inFlight: Promise<void> | null = null;
  const runRenewal = async (): Promise<void> => {
    try {
      if (!(await renewRepairLock(redis, token))) {
        lostError = new Error('Lost the distributed VK publish repair lock');
      }
    } catch (error: unknown) {
      lostError = new Error(`VK publish repair lock renewal failed: ${normalizeError(error)}`);
    }
  };
  const timer = setInterval(
    () => {
      if (stopped || inFlight) {
        return;
      }
      inFlight = runRenewal().finally(() => {
        inFlight = null;
      });
    },
    Math.max(1, intervalMs),
  );
  timer.unref();
  return {
    assertHealthy: () => {
      if (lostError) {
        throw lostError;
      }
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 1_000) || 'Unknown error';
}

async function reloadEntryEvidence(
  prisma: PrismaClient,
  queue: Queue<VkParsingPublishJob>,
  entry: RepairPlanEntry,
  cutoff: Date,
): Promise<Awaited<ReturnType<typeof assessRow>> | null> {
  const row = await prisma.vkParsingPost.findUnique({
    where: { id: entry.postId },
    select: REPAIR_POST_SELECT,
  });
  if (
    !row ||
    row.dispatchProfile !== PublicationDispatchProfile.LEGACY_ROUTED ||
    !row.publishQueuedAt ||
    row.publishQueuedAt.getTime() > cutoff.getTime()
  ) {
    return null;
  }
  return assessRow(prisma, queue, row, new Date());
}

export async function assertFrozenOwnershipSnapshot(
  prisma: PrismaClient,
  document: VkPublishRepairPlanDocument,
): Promise<void> {
  const chatScope =
    document.chatIds.length > 0 ? { chatId: { in: document.chatIds } } : ({} as const);
  const [atCutoff, afterCutoff] = await Promise.all([
    prisma.vkParsingPost.count({
      where: {
        dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
        publishQueuedAt: { not: null, lte: new Date(document.cutoff) },
        publishIdempotencyKey: { not: null },
        ...chatScope,
      },
    }),
    prisma.vkParsingPost.count({
      where: {
        dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
        publishQueuedAt: { gt: new Date(document.cutoff) },
        publishIdempotencyKey: { not: null },
        ...chatScope,
      },
    }),
  ]);
  if (atCutoff !== document.totalOwnershipRowsAtCutoff) {
    throw new Error(
      `Frozen ownership snapshot changed: expected ${document.totalOwnershipRowsAtCutoff}, current ${atCutoff}`,
    );
  }
  if (afterCutoff !== 0) {
    throw new Error(`Found ${afterCutoff} VK publish ownership rows after the frozen cutoff`);
  }
}

async function persistRepairSchedule(
  prisma: PrismaClient,
  entry: RepairPlanEntry,
  planHash: string,
): Promise<boolean> {
  const facts = entry.facts;
  if (!entry.nextScheduledAt || !facts.publishIdempotencyKey || !facts.publishQueuedAt) {
    return false;
  }
  const publishQueuedAt = facts.publishQueuedAt;
  const nextScheduledAt = entry.nextScheduledAt;
  return prisma.$transaction(async (tx) => {
    // FLAG: The queue owner, schedule, lock, attempts, errors, and row revision all participate in
    // this CAS. A worker, admin action, or another repair must win instead of being overwritten.
    const updated = await tx.vkParsingPost.updateMany({
      where: {
        id: facts.postId,
        chatId: facts.chatId,
        sourceId: facts.sourceId,
        status: facts.status,
        updatedAt: new Date(facts.updatedAt),
        publishQueuedAt: new Date(publishQueuedAt),
        publishScheduledAt: facts.publishScheduledAt ? new Date(facts.publishScheduledAt) : null,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishLockedAt: null,
        publishAttemptCount: 0,
        publishIdempotencyKey: facts.publishIdempotencyKey,
        publishReason: 'autopublish',
        dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
        publishedMessageId: null,
        publishedAtMax: null,
        autoPublishedAt: null,
        autoPublishError: null,
        lastError: null,
      },
      data: { publishScheduledAt: new Date(nextScheduledAt) },
    });
    if (updated.count !== 1) {
      return false;
    }
    await tx.auditLog.create({
      data: {
        chatId: facts.chatId,
        actorUserId: REPAIR_ACTOR_USER_ID,
        action: REPAIR_AUDIT_ACTION,
        payload: {
          planHash,
          postId: facts.postId,
          sourceId: facts.sourceId,
          previousScheduledAt: facts.publishScheduledAt,
          nextScheduledAt: entry.nextScheduledAt,
          preservedPublishIdempotencyKey: facts.publishIdempotencyKey,
          reason: 'bounded_vk_publish_queue_repair',
        },
      },
    });
    return true;
  });
}

function assertExactInactiveJob(entry: RepairPlanEntry, evidence: RepairQueueEvidence): void {
  if (evidence.presence === 'missing') {
    return;
  }
  if (evidence.state === 'active') {
    throw new Error(`Refusing to remove active job ${evidence.jobId}`);
  }
  if (
    evidence.name !== VK_PUBLISH_JOB_NAME ||
    evidence.postId !== entry.postId ||
    evidence.chatId !== entry.chatId ||
    evidence.reason !== 'autopublish' ||
    evidence.idempotencyKey !== entry.publishIdempotencyKey ||
    evidence.attemptsMade > 0 ||
    evidence.attemptsStarted > 0 ||
    evidence.processedOn ||
    evidence.finishedOn ||
    !['delayed', 'waiting', 'prioritized'].includes(evidence.state)
  ) {
    throw new Error(`Refusing to remove non-exact or attempted job ${evidence.jobId}`);
  }
}

export async function replaceExactInactivePublishJob(
  queue: Queue<VkParsingPublishJob>,
  entry: Pick<RepairPlanEntry, 'postId' | 'chatId' | 'publishIdempotencyKey' | 'nextScheduledAt'>,
  createdAt: Date,
  readNowMs: number | (() => number) = () => Date.now(),
): Promise<void> {
  if (!entry.publishIdempotencyKey || !entry.nextScheduledAt) {
    throw new Error('Repair entry is missing its idempotency key or next schedule');
  }
  const fullEntry = entry as RepairPlanEntry;
  const jobId = buildPublishJobId(entry.postId, entry.publishIdempotencyKey);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    const evidence = toQueueEvidence(jobId, existing, state);
    assertExactInactiveJob(fullEntry, evidence);
    await existing.remove();
  }
  const scheduledAtMs = Date.parse(entry.nextScheduledAt);
  const addJob = async (): Promise<void> => {
    const nowMs = typeof readNowMs === 'function' ? readNowMs() : readNowMs;
    await queue.add(
      VK_PUBLISH_JOB_NAME,
      {
        postId: entry.postId,
        chatId: entry.chatId,
        reason: 'autopublish',
        idempotencyKey: entry.publishIdempotencyKey!,
        retryPolicyName: 'vk-parsing-publish',
        createdAt: createdAt.toISOString(),
      },
      {
        jobId,
        delay: Math.max(0, scheduledAtMs - nowMs),
        ...VK_PARSING_PUBLISH_RETRY_POLICY,
      },
    );
  };
  const confirmJob = async (): Promise<boolean> => {
    const added = await queue.getJob(jobId);
    if (!added) {
      return false;
    }
    const evidence = toQueueEvidence(jobId, added, await added.getState());
    assertExactInactiveJob(fullEntry, evidence);
    if (
      !evidence.dueAt ||
      Math.abs(Date.parse(evidence.dueAt) - scheduledAtMs) > REPAIR_SCHEDULE_DRIFT_TOLERANCE_MS
    ) {
      throw new Error(`Recreated job ${jobId} does not match the repaired schedule`);
    }
    return true;
  };

  try {
    await addJob();
  } catch (firstError: unknown) {
    if (await confirmJob()) {
      return;
    }
    try {
      await addJob();
    } catch (retryError: unknown) {
      if (await confirmJob()) {
        return;
      }
      throw new Error(
        `Unable to recreate ${jobId} after retry: ${normalizeError(retryError)}; first error: ${normalizeError(firstError)}`,
      );
    }
  }
  if (!(await confirmJob())) {
    throw new Error(`BullMQ did not persist recreated job ${jobId}`);
  }
}

async function applyRepairEntry(
  prisma: PrismaClient,
  queue: Queue<VkParsingPublishJob>,
  entry: RepairPlanEntry,
  cutoff: Date,
  planHash: string,
  assertMutationSafe: () => Promise<void>,
): Promise<RepairApplyOutcome> {
  await assertMutationSafe();
  const current = await reloadEntryEvidence(prisma, queue, entry, cutoff);
  if (
    !current ||
    evidenceHash(current.facts, current.queue, current.ledger) !== entry.evidenceHash ||
    classifyRepairCandidate(current.facts, current.queue, current.ledger) !== null
  ) {
    return { postId: entry.postId, result: 'revalidation_conflict' };
  }
  await assertMutationSafe();
  const persisted = await persistRepairSchedule(prisma, entry, planHash);
  if (!persisted) {
    return { postId: entry.postId, result: 'cas_conflict' };
  }
  await assertMutationSafe();
  try {
    await replaceExactInactivePublishJob(queue, entry, cutoff);
    return { postId: entry.postId, result: 'applied' };
  } catch (error: unknown) {
    return { postId: entry.postId, result: 'queue_error', error: normalizeError(error) };
  }
}

async function assertFrozenRepairQueueEvidence(
  queue: Queue<VkParsingPublishJob>,
  document: VkPublishRepairPlanDocument,
): Promise<void> {
  for (const batch of chunks(document.entries, document.batchSize)) {
    const currentEvidence = await Promise.all(
      batch.map((entry) => inspectQueueJob(queue, entry.facts)),
    );
    currentEvidence.forEach((current, index) => {
      const planned = batch[index]!;
      if (hashRepairPlan(current) !== hashRepairPlan(planned.queue)) {
        throw new Error(`Frozen BullMQ evidence changed for post ${planned.postId}`);
      }
    });
  }
}

export async function applyVkPublishRepairPlan(
  prisma: PrismaClient,
  queue: Queue<VkParsingPublishJob>,
  redis: RedisLockClient,
  lockToken: string,
  plan: VkPublishRepairPlan,
): Promise<{
  repairs: RepairApplyOutcome[];
  orphanJobs: RepairOrphanApplyOutcome[];
}> {
  const repairs: RepairApplyOutcome[] = [];
  const orphanJobs: RepairOrphanApplyOutcome[] = [];
  if (plan.document.entries.length !== plan.document.totalOwnershipRowsAtCutoff) {
    throw new Error(
      `Selected ownership snapshot is truncated: ${plan.document.entries.length}/${plan.document.totalOwnershipRowsAtCutoff}`,
    );
  }
  if (plan.document.ownershipRowsAfterCutoff !== 0) {
    throw new Error(
      `Plan contains ${plan.document.ownershipRowsAfterCutoff} ownership rows after cutoff`,
    );
  }
  const unsafeLiveEntry = plan.document.entries.find(
    (entry) =>
      entry.queue.presence === 'present' &&
      isLiveRepairQueueState(entry.queue.state) &&
      !isExactPristineInactiveQueueReservation(entry.facts, entry.queue),
  );
  if (unsafeLiveEntry) {
    throw new Error(
      `Plan contains unreservable live BullMQ evidence for post ${unsafeLiveEntry.postId}`,
    );
  }
  const assertMutationSafe = async (): Promise<void> => {
    if (!(await renewRepairLock(redis, lockToken))) {
      throw new Error('Lost the distributed VK publish repair lock');
    }
    const [paused, counts] = await Promise.all([queue.isPaused(), queue.getJobCounts('active')]);
    if (!paused || (counts.active ?? 0) !== 0) {
      throw new Error('vk-parsing-publish must remain paused with zero active jobs');
    }
    await assertFrozenOwnershipSnapshot(prisma, plan.document);
  };
  const repairEntries = plan.document.entries.filter((entry) => entry.action === 'repair');
  if (repairEntries.length > 0) {
    await assertMutationSafe();
    await assertFrozenRepairQueueEvidence(queue, plan.document);
  }
  for (const batch of chunks(repairEntries, plan.document.batchSize)) {
    for (const entry of batch) {
      repairs.push(
        await applyRepairEntry(
          prisma,
          queue,
          entry,
          new Date(plan.document.cutoff),
          plan.planHash,
          assertMutationSafe,
        ),
      );
    }
  }
  return { repairs, orphanJobs };
}

function renderPlan(plan: VkPublishRepairPlan, apply: boolean): Record<string, unknown> {
  const counts = plan.document.entries.reduce<Record<string, number>>((result, entry) => {
    const key = entry.action === 'skip' ? `skip:${entry.skipReason}` : entry.action;
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
  return {
    mode: apply ? 'apply' : 'dry-run',
    planHash: plan.planHash,
    cutoff: plan.document.cutoff,
    startAt: plan.document.startAt,
    chatIds: plan.document.chatIds,
    limit: plan.document.limit,
    batchSize: plan.document.batchSize,
    totalOwnershipRowsAtCutoff: plan.document.totalOwnershipRowsAtCutoff,
    ownershipRowsAfterCutoff: plan.document.ownershipRowsAfterCutoff,
    selected: plan.document.entries.length,
    queue: plan.queue,
    counts,
    orphanScan: {
      ...plan.document.orphanScan,
      reportOnly: true,
      entries: plan.document.orphanScan.entries,
      counts: plan.document.orphanScan.entries.reduce<Record<string, number>>((result, entry) => {
        const key = entry.action === 'skip' ? `skip:${entry.skipReason}` : entry.action;
        result[key] = (result[key] ?? 0) + 1;
        return result;
      }, {}),
    },
    entries: plan.document.entries,
  };
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const result = value as Record<string, unknown>;
  process.stdout.write(
    `${String(result.mode)} VK publish repair plan ${String(result.planHash)}\n` +
      `cutoff=${String(result.cutoff)} startAt=${String(result.startAt)} chats=${JSON.stringify(
        result.chatIds,
      )} selected=${String(result.selected)}/${String(
        result.totalOwnershipRowsAtCutoff,
      )} queue=${JSON.stringify(result.queue)}\n` +
      `counts=${JSON.stringify(result.counts)}\n`,
  );
}

async function main(): Promise<void> {
  const options = readVkPublishRepairOptions(process.argv.slice(2));
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for VK publish repair');
  }
  const prisma = createPrismaClient(undefined, {
    application_name: 'vk-parsing-publish-repair',
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
  });
  const connection: ConnectionOptions = { url: redisUrl, maxRetriesPerRequest: null };
  const queue = new Queue<VkParsingPublishJob>(VK_PARSING_PUBLISH_QUEUE, { connection });
  const lockRedis = options.apply
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true })
    : null;
  let lockToken: string | null = null;
  let lockHeartbeat: RepairLockHeartbeat | null = null;
  try {
    if (lockRedis) {
      lockToken = await acquireRepairLock(lockRedis);
      if (!lockToken) {
        throw new Error('Another VK publish repair holds the distributed lock');
      }
      lockHeartbeat = startRepairLockHeartbeat(lockRedis, lockToken);
    }
    const plan = await buildVkPublishRepairPlan(prisma, queue, options);
    lockHeartbeat?.assertHealthy();
    printResult(renderPlan(plan, options.apply), options.json);
    if (!options.apply) {
      return;
    }
    if (plan.planHash !== options.confirmPlanHash) {
      throw new Error(
        `Plan hash mismatch: expected ${options.confirmPlanHash}, current ${plan.planHash}`,
      );
    }
    if (!plan.queue.paused || plan.queue.active !== 0) {
      throw new Error('vk-parsing-publish must be globally paused with zero active jobs');
    }
    if (plan.document.entries.length !== plan.document.totalOwnershipRowsAtCutoff) {
      throw new Error(
        `Selected ownership snapshot is truncated: ${plan.document.entries.length}/${plan.document.totalOwnershipRowsAtCutoff}`,
      );
    }
    if (plan.document.ownershipRowsAfterCutoff !== 0) {
      throw new Error(
        `Found ${plan.document.ownershipRowsAfterCutoff} VK publish ownership rows after cutoff; refusing apply`,
      );
    }
    const outcomes = await applyVkPublishRepairPlan(prisma, queue, lockRedis!, lockToken!, plan);
    const repairs = outcomes.repairs;
    const orphanJobs = outcomes.orphanJobs;
    const result = {
      planHash: plan.planHash,
      applied: repairs.filter((outcome) => outcome.result === 'applied').length,
      conflicts: repairs.filter(
        (outcome) =>
          outcome.result === 'cas_conflict' || outcome.result === 'revalidation_conflict',
      ).length,
      queueErrors: repairs.filter((outcome) => outcome.result === 'queue_error').length,
      removedOrphanJobs: orphanJobs.filter((outcome) => outcome.result === 'removed').length,
      orphanConflicts: orphanJobs.filter(
        (outcome) =>
          outcome.result === 'revalidation_conflict' || outcome.result === 'ownership_restored',
      ).length,
      orphanErrors: orphanJobs.filter((outcome) => outcome.result === 'error').length,
      repairs,
      orphanJobs,
      queueRemainsPaused: true,
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    if (
      result.conflicts > 0 ||
      result.queueErrors > 0 ||
      result.orphanConflicts > 0 ||
      result.orphanErrors > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await lockHeartbeat?.stop().catch(() => undefined);
    if (lockRedis && lockToken) {
      await releaseRepairLock(lockRedis, lockToken).catch(() => undefined);
    }
    await Promise.allSettled([
      queue.close(),
      prisma.$disconnect(),
      lockRedis?.quit() ?? Promise.resolve('OK'),
    ]);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
