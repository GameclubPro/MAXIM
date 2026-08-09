import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { appendAdminContactMarkdownLink } from '../common/admin-contact-link.util';
import { parseCompactProfileMentionStartPayload } from '../max/max-deep-link.util';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { ChatBotMembershipStatus, ChatEntityType, Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';

const OPERATOR_ACTOR_USER_ID = 'operator:stale-admin-contact-repair';
const LIVE_CHECK_TIMEOUT_MS = 5_000;
const MESSAGE_EDIT_TIMEOUT_MS = 12_000;

export const CHAT_SETTINGS_ADMIN_CONTACT_GROUPS = [
  ['requiredSubscriptionAdminContactButtonEnabled', 'requiredSubscriptionAdminContactButtonUrl'],
  ['invitationAccessAdminContactButtonEnabled', 'invitationAccessAdminContactButtonUrl'],
  ['messageLimitsAdminContactButtonEnabled', 'messageLimitsAdminContactButtonUrl'],
  ['phoneNumbersAdminContactButtonEnabled', 'phoneNumbersAdminContactButtonUrl'],
  ['profanityAdminContactButtonEnabled', 'profanityAdminContactButtonUrl'],
  ['textFiltersAdminContactButtonEnabled', 'textFiltersAdminContactButtonUrl'],
  ['linkAdminContactButtonEnabled', 'linkAdminContactButtonUrl'],
  ['duplicateAdminContactButtonEnabled', 'duplicateAdminContactButtonUrl'],
] as const;

type SettingsEnabledKey = (typeof CHAT_SETTINGS_ADMIN_CONTACT_GROUPS)[number][0];
type SettingsUrlKey = (typeof CHAT_SETTINGS_ADMIN_CONTACT_GROUPS)[number][1];
type ChatSettingsContactSnapshot = Record<SettingsEnabledKey, boolean> &
  Record<SettingsUrlKey, string> & { updatedAt: Date };

export const STALE_ADMIN_CONTACT_REPAIR_USAGE = [
  'Usage:',
  '  --chat-id <id> --expected-user-id <id> [--dry-run] [--json]',
  '  --apply --chat-id <id> --expected-user-id <id> [--json]',
  '',
  'Dry-run is the default. Exactly one chat and one former administrator are required.',
  'Apply is allowed only after live MAX proves the expected user is no longer an administrator.',
  'Only signed pm2_ profile handoff URLs bound to that chat and user are repaired.',
].join('\n');

export type StaleAdminContactRepairOptions = {
  apply: boolean;
  json: boolean;
  chatId: string;
  expectedUserId: string;
};

export type StaleAdminContactRepairState = {
  chatId: string;
  entityType: ChatEntityType;
  primaryBotId: string | null;
  legacyBotId: string | null;
  membershipBotIds: string[];
  settings: ChatSettingsContactSnapshot | null;
  rules: {
    text: string;
    adminContactButtonEnabled: boolean;
    adminContactButtonUrl: string;
    publishedMessageId: string | null;
    publishedBotId: string | null;
    publishOperationId: string | null;
    publishSendStartedAt: Date | null;
    pendingCleanupMessageId: string | null;
    updatedAt: Date;
  } | null;
};

export type SettingsContactChange = {
  enabledKey: SettingsEnabledKey;
  urlKey: SettingsUrlKey;
  expectedEnabled: boolean;
  expectedUrl: string;
};

export type RulesRepairSnapshot = {
  expectedText: string;
  expectedEnabled: boolean;
  expectedUrl: string;
  expectedPublishedMessageId: string | null;
  expectedPublishedBotId: string | null;
  expectedPublishOperationId: string | null;
  expectedPublishSendStartedAt: Date | null;
  expectedPendingCleanupMessageId: string | null;
  expectedUpdatedAt: Date;
};

export type RulesContactChange = RulesRepairSnapshot;

export type StaleAdminContactCommit = {
  runId: string;
  chatId: string;
  expectedUserId: string;
  settingsChanges: SettingsContactChange[];
  settingsSnapshot: ChatSettingsContactSnapshot | null;
  rulesChange: RulesContactChange | null;
  rulesSnapshot: RulesRepairSnapshot | null;
  publishedMessageEdited: boolean;
  publishedMessageId: string | null;
  publishedMessageBotId: string | null;
};

export type StaleAdminContactRepairDependencies = {
  validationTokens: readonly string[];
  loadState: (chatId: string) => Promise<StaleAdminContactRepairState | null>;
  readLiveAdminStatus: (
    chatId: string,
    botId: string,
    expectedUserId: string,
  ) => Promise<{ botIsAdmin: boolean; expectedUserIsAdmin: boolean }>;
  readPublishedMessageMarkdown: (messageId: string, botId: string) => Promise<string | null>;
  editPublishedRulesMessage: (params: {
    chatId: string;
    messageId: string;
    botId: string;
    text: string;
  }) => Promise<void>;
  recordAttempt: (repair: StaleAdminContactCommit) => Promise<void>;
  recordFailure: (
    repair: StaleAdminContactCommit,
    stage: 'published_message_edit' | 'database_cas' | 'cache_invalidation',
    error: string,
  ) => Promise<void>;
  commit: (repair: StaleAdminContactCommit) => Promise<'applied' | 'cas_conflict'>;
  invalidate: (chatId: string) => Promise<void>;
};

export type StaleAdminContactRepairResult =
  | 'ready'
  | 'applied'
  | 'already_clean'
  | 'chat_not_found'
  | 'not_a_chat'
  | 'no_usable_bot'
  | 'invalid_contact_url'
  | 'former_admin_still_admin'
  | 'live_admin_check_failed'
  | 'rules_publication_in_progress'
  | 'published_message_unreadable'
  | 'published_message_mismatch'
  | 'published_message_edit_failed'
  | 'cas_conflict'
  | 'cache_invalidation_failed';

export type StaleAdminContactRepairSummary = {
  apply: boolean;
  chatId: string;
  expectedUserId: string;
  result: StaleAdminContactRepairResult;
  complete: boolean;
  liveCheckBotId: string | null;
  settingsFields: string[];
  rulesContactMatched: boolean;
  publishedMessageId: string | null;
  publishedMessageAction: 'none' | 'would_edit' | 'edited' | 'already_clean';
  error?: string;
};

type ContactTarget = {
  chatId: string;
  userId: string;
};

type PublishedMessagePlan = {
  messageId: string | null;
  botId: string | null;
  action: 'none' | 'edit' | 'already_clean' | 'unreadable' | 'mismatch';
  cleanText: string | null;
  error?: string;
};

class RepairCasConflictError extends Error {
  constructor() {
    super('Repair compare-and-set conflict');
    this.name = 'RepairCasConflictError';
  }
}

function readRequiredOption(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function readStaleAdminContactRepairOptions(
  argv: readonly string[],
): StaleAdminContactRepairOptions {
  let apply = false;
  let explicitDryRun = false;
  let json = false;
  let chatId: string | null = null;
  let expectedUserId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--dry-run') {
      explicitDryRun = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--chat-id') {
      if (chatId !== null) {
        throw new Error('--chat-id may be provided only once');
      }
      chatId = readRequiredOption(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--expected-user-id') {
      if (expectedUserId !== null) {
        throw new Error('--expected-user-id may be provided only once');
      }
      expectedUserId = readRequiredOption(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      throw new Error(STALE_ADMIN_CONTACT_REPAIR_USAGE);
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (apply && explicitDryRun) {
    throw new Error('--apply cannot be combined with --dry-run');
  }
  if (!chatId) {
    throw new Error('--chat-id is required');
  }
  if (!expectedUserId) {
    throw new Error('--expected-user-id is required');
  }

  return { apply, json, chatId, expectedUserId };
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
  return message.replace(/\s+/gu, ' ').trim().slice(0, 500) || 'Unknown error';
}

function normalizeMessageText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim();
}

function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? '').filter(Boolean))];
}

function buildRulesRepairSnapshot(
  rules: NonNullable<StaleAdminContactRepairState['rules']>,
): RulesRepairSnapshot {
  return {
    expectedText: rules.text,
    expectedEnabled: rules.adminContactButtonEnabled,
    expectedUrl: rules.adminContactButtonUrl,
    expectedPublishedMessageId: rules.publishedMessageId,
    expectedPublishedBotId: rules.publishedBotId,
    expectedPublishOperationId: rules.publishOperationId,
    expectedPublishSendStartedAt: rules.publishSendStartedAt,
    expectedPendingCleanupMessageId: rules.pendingCleanupMessageId,
    expectedUpdatedAt: rules.updatedAt,
  };
}

function hasActiveRulesPublicationFence(rules: StaleAdminContactRepairState['rules']): boolean {
  return Boolean(
    rules &&
    (rules.publishOperationId !== null ||
      rules.publishSendStartedAt !== null ||
      rules.pendingCleanupMessageId !== null),
  );
}

function parseSignedContactTarget(
  value: string,
  validationTokens: readonly string[],
): ContactTarget | null {
  try {
    const parsedUrl = new URL(value.trim());
    const hostname = parsedUrl.hostname.toLowerCase();
    if (parsedUrl.protocol !== 'https:' || (hostname !== 'max.ru' && hostname !== 'www.max.ru')) {
      return null;
    }
    const payload = parsedUrl.searchParams.get('start')?.trim() ?? '';
    const target = parseCompactProfileMentionStartPayload(payload, validationTokens);
    return target ? { chatId: target.chatId, userId: target.userId } : null;
  } catch {
    return null;
  }
}

function planContactChanges(
  state: StaleAdminContactRepairState,
  expectedUserId: string,
  validationTokens: readonly string[],
): {
  settingsChanges: SettingsContactChange[];
  rulesChange: RulesContactChange | null;
  invalidFields: string[];
} {
  const settingsChanges: SettingsContactChange[] = [];
  const invalidFields: string[] = [];

  if (state.settings) {
    for (const [enabledKey, urlKey] of CHAT_SETTINGS_ADMIN_CONTACT_GROUPS) {
      const enabled = state.settings[enabledKey];
      const url = state.settings[urlKey].trim();
      if (!url) {
        if (enabled) {
          invalidFields.push(urlKey);
        }
        continue;
      }
      const target = parseSignedContactTarget(url, validationTokens);
      if (!target || target.chatId !== state.chatId) {
        invalidFields.push(urlKey);
        continue;
      }
      if (target.userId === expectedUserId) {
        settingsChanges.push({
          enabledKey,
          urlKey,
          expectedEnabled: enabled,
          expectedUrl: state.settings[urlKey],
        });
      }
    }
  }

  let rulesChange: RulesContactChange | null = null;
  if (state.rules) {
    const url = state.rules.adminContactButtonUrl.trim();
    if (!url) {
      if (state.rules.adminContactButtonEnabled) {
        invalidFields.push('adminContactButtonUrl');
      }
    } else {
      const target = parseSignedContactTarget(url, validationTokens);
      if (!target || target.chatId !== state.chatId) {
        invalidFields.push('adminContactButtonUrl');
      } else if (target.userId === expectedUserId) {
        rulesChange = buildRulesRepairSnapshot(state.rules);
      }
    }
  }

  return { settingsChanges, rulesChange, invalidFields };
}

function buildBaseSummary(
  options: StaleAdminContactRepairOptions,
  plan?: {
    settingsChanges: SettingsContactChange[];
    rulesChange: RulesContactChange | null;
  },
): Omit<StaleAdminContactRepairSummary, 'result' | 'complete'> {
  return {
    apply: options.apply,
    chatId: options.chatId,
    expectedUserId: options.expectedUserId,
    liveCheckBotId: null,
    settingsFields: plan?.settingsChanges.map((change) => change.urlKey) ?? [],
    rulesContactMatched: Boolean(plan?.rulesChange),
    publishedMessageId: null,
    publishedMessageAction: 'none',
  };
}

async function resolveLiveAdminCheck(
  dependencies: StaleAdminContactRepairDependencies,
  state: StaleAdminContactRepairState,
  botIds: readonly string[],
  expectedUserId: string,
): Promise<{
  botId: string | null;
  expectedUserIsAdmin: boolean;
  error: string | null;
}> {
  const failures: string[] = [];
  for (const botId of botIds) {
    try {
      const result = await dependencies.readLiveAdminStatus(state.chatId, botId, expectedUserId);
      if (!result.botIsAdmin) {
        failures.push(`${botId}: bot is not an administrator`);
        continue;
      }
      return { botId, expectedUserIsAdmin: result.expectedUserIsAdmin, error: null };
    } catch (error: unknown) {
      failures.push(`${botId}: ${normalizeError(error)}`);
    }
  }
  return {
    botId: null,
    expectedUserIsAdmin: false,
    error: failures.join('; ').slice(0, 500) || 'No bot could verify the live administrator roster',
  };
}

function hasExpectedAdminContactSuffix(text: string, cleanText: string, userId: string): boolean {
  const normalized = normalizeMessageText(text);
  const normalizedClean = normalizeMessageText(cleanText);
  const prefix = `${normalizedClean}\n\nСвязь с админом: [`;
  const suffix = `](max://user/${encodeURIComponent(userId)})`;
  return normalized.startsWith(prefix) && normalized.endsWith(suffix);
}

function readProfileLabel(value: string): string | null {
  try {
    const label = new URL(value.trim()).searchParams.get('profile_label') ?? '';
    return label.replace(/\s+/gu, ' ').trim() || null;
  } catch {
    return null;
  }
}

async function planPublishedMessage(
  dependencies: StaleAdminContactRepairDependencies,
  state: StaleAdminContactRepairState,
  expectedUserId: string,
  botIds: readonly string[],
): Promise<PublishedMessagePlan> {
  const messageId = state.rules?.publishedMessageId?.trim() || null;
  if (!messageId) {
    return { messageId: null, botId: null, action: 'none', cleanText: null };
  }
  const cleanText = state.rules?.text.trim() ?? '';
  if (!cleanText) {
    return {
      messageId,
      botId: null,
      action: 'mismatch',
      cleanText: null,
      error: 'Published rules have no stored source text',
    };
  }

  const storedContactTarget = state.rules?.adminContactButtonUrl
    ? parseSignedContactTarget(state.rules.adminContactButtonUrl, dependencies.validationTokens)
    : null;
  const storedContactMatchesExpected = Boolean(
    storedContactTarget &&
    storedContactTarget.chatId === state.chatId &&
    storedContactTarget.userId === expectedUserId,
  );

  const failures: string[] = [];
  for (const botId of botIds) {
    try {
      const markdown = await dependencies.readPublishedMessageMarkdown(messageId, botId);
      if (markdown === null) {
        failures.push(`${botId}: message has no text`);
        continue;
      }
      if (normalizeMessageText(markdown) === normalizeMessageText(cleanText)) {
        return { messageId, botId, action: 'already_clean', cleanText };
      }

      const exactStaleText = state.rules?.adminContactButtonUrl.trim()
        ? appendAdminContactMarkdownLink(cleanText, {
            enabled: true,
            url: state.rules.adminContactButtonUrl,
            botTokens: dependencies.validationTokens,
          })
        : null;
      const exactMatch =
        storedContactMatchesExpected &&
        exactStaleText !== null &&
        normalizeMessageText(markdown) === normalizeMessageText(exactStaleText);
      const profileLabel = state.rules?.adminContactButtonUrl
        ? readProfileLabel(state.rules.adminContactButtonUrl)
        : null;
      const visibleStaleText = profileLabel
        ? `${cleanText}\n\nСвязь с админом: ${profileLabel}`
        : null;
      const visibleMatch =
        storedContactMatchesExpected &&
        visibleStaleText !== null &&
        normalizeMessageText(markdown) === normalizeMessageText(visibleStaleText);
      if (
        exactMatch ||
        visibleMatch ||
        hasExpectedAdminContactSuffix(markdown, cleanText, expectedUserId)
      ) {
        return { messageId, botId, action: 'edit', cleanText };
      }
      return {
        messageId,
        botId,
        action: 'mismatch',
        cleanText,
        error: 'Published rules text differs from both the stored source and expected stale text',
      };
    } catch (error: unknown) {
      failures.push(`${botId}: ${normalizeError(error)}`);
    }
  }

  return {
    messageId,
    botId: null,
    action: 'unreadable',
    cleanText,
    error: failures.join('; ').slice(0, 500) || 'Published rules message could not be read',
  };
}

export async function runStaleAdminContactRepair(
  dependencies: StaleAdminContactRepairDependencies,
  options: StaleAdminContactRepairOptions,
): Promise<StaleAdminContactRepairSummary> {
  const state = await dependencies.loadState(options.chatId);
  if (!state) {
    return {
      ...buildBaseSummary(options),
      result: 'chat_not_found',
      complete: false,
    };
  }
  if (state.entityType !== ChatEntityType.CHAT) {
    return {
      ...buildBaseSummary(options),
      result: 'not_a_chat',
      complete: false,
    };
  }

  const contactPlan = planContactChanges(
    state,
    options.expectedUserId,
    dependencies.validationTokens,
  );
  const baseSummary = buildBaseSummary(options, contactPlan);
  if (hasActiveRulesPublicationFence(state.rules)) {
    return {
      ...baseSummary,
      result: 'rules_publication_in_progress',
      complete: false,
      error: 'Chat rules have an active publication or cleanup fence',
    };
  }
  if (contactPlan.invalidFields.length > 0) {
    return {
      ...baseSummary,
      result: 'invalid_contact_url',
      complete: false,
      error: `Unverifiable contact fields: ${contactPlan.invalidFields.join(', ')}`,
    };
  }

  const botIds = uniqueNonEmpty([
    state.rules?.publishedBotId,
    state.legacyBotId,
    state.primaryBotId,
    ...state.membershipBotIds,
  ]);
  if (botIds.length === 0) {
    return {
      ...baseSummary,
      result: 'no_usable_bot',
      complete: false,
    };
  }

  const liveCheck = await resolveLiveAdminCheck(
    dependencies,
    state,
    botIds,
    options.expectedUserId,
  );
  if (!liveCheck.botId) {
    return {
      ...baseSummary,
      result: 'live_admin_check_failed',
      complete: false,
      error: liveCheck.error ?? undefined,
    };
  }
  if (liveCheck.expectedUserIsAdmin) {
    return {
      ...baseSummary,
      liveCheckBotId: liveCheck.botId,
      result: 'former_admin_still_admin',
      complete: false,
    };
  }

  // A readable message is not necessarily editable by that bot. Use the recorded
  // publisher, then the legacy owner field, with primary as the final legacy fallback.
  const messageBotIds = uniqueNonEmpty([
    state.rules?.publishedBotId,
    state.rules?.publishedBotId ? null : state.legacyBotId,
    state.rules?.publishedBotId || state.legacyBotId ? null : state.primaryBotId,
  ]);
  const messagePlan = await planPublishedMessage(
    dependencies,
    state,
    options.expectedUserId,
    messageBotIds,
  );
  const summaryWithChecks = {
    ...baseSummary,
    liveCheckBotId: liveCheck.botId,
    publishedMessageId: messagePlan.messageId,
    publishedMessageAction:
      messagePlan.action === 'edit'
        ? ('would_edit' as const)
        : messagePlan.action === 'already_clean'
          ? ('already_clean' as const)
          : ('none' as const),
  };
  if (messagePlan.action === 'unreadable') {
    return {
      ...summaryWithChecks,
      result: 'published_message_unreadable',
      complete: false,
      error: messagePlan.error,
    };
  }
  if (messagePlan.action === 'mismatch') {
    return {
      ...summaryWithChecks,
      result: 'published_message_mismatch',
      complete: false,
      error: messagePlan.error,
    };
  }

  const hasDatabaseChanges =
    contactPlan.settingsChanges.length > 0 || contactPlan.rulesChange !== null;
  if (!hasDatabaseChanges && messagePlan.action !== 'edit') {
    if (options.apply) {
      try {
        await dependencies.invalidate(state.chatId);
      } catch (error: unknown) {
        return {
          ...summaryWithChecks,
          result: 'cache_invalidation_failed',
          complete: false,
          error: normalizeError(error),
        };
      }
    }
    return {
      ...summaryWithChecks,
      result: 'already_clean',
      complete: true,
    };
  }
  if (!options.apply) {
    return {
      ...summaryWithChecks,
      result: 'ready',
      complete: true,
    };
  }

  const repair: StaleAdminContactCommit = {
    runId: randomUUID(),
    chatId: state.chatId,
    expectedUserId: options.expectedUserId,
    settingsChanges: contactPlan.settingsChanges,
    settingsSnapshot:
      state.settings && contactPlan.settingsChanges.length > 0 ? state.settings : null,
    rulesChange: contactPlan.rulesChange,
    rulesSnapshot: null,
    publishedMessageEdited: false,
    publishedMessageId: messagePlan.messageId,
    publishedMessageBotId: messagePlan.botId,
  };
  await dependencies.recordAttempt(repair);

  let publishedMessageEdited = false;
  if (
    messagePlan.action === 'edit' &&
    messagePlan.messageId &&
    messagePlan.botId &&
    messagePlan.cleanText
  ) {
    let editError: unknown = null;
    try {
      await dependencies.editPublishedRulesMessage({
        chatId: state.chatId,
        messageId: messagePlan.messageId,
        botId: messagePlan.botId,
        text: messagePlan.cleanText,
      });
    } catch (error: unknown) {
      editError = error;
    }
    let readbackError: unknown = null;
    for (const delayMs of [0, 250, 750]) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        const readback = await dependencies.readPublishedMessageMarkdown(
          messagePlan.messageId,
          messagePlan.botId,
        );
        if (
          readback !== null &&
          normalizeMessageText(readback) === normalizeMessageText(messagePlan.cleanText)
        ) {
          publishedMessageEdited = true;
          break;
        }
        readbackError = new Error('Published rules readback did not match the repaired text');
      } catch (error: unknown) {
        readbackError = error;
      }
    }
    if (!publishedMessageEdited) {
      const error = normalizeError(editError ?? readbackError);
      await dependencies.recordFailure(repair, 'published_message_edit', error);
      return {
        ...summaryWithChecks,
        result: 'published_message_edit_failed',
        complete: false,
        error,
      };
    }
  }

  const rulesSnapshot =
    state.rules && (contactPlan.rulesChange !== null || publishedMessageEdited)
      ? buildRulesRepairSnapshot(state.rules)
      : null;
  repair.rulesSnapshot = rulesSnapshot;
  repair.publishedMessageEdited = publishedMessageEdited;
  const commitResult = await dependencies.commit(repair);
  const finalPublishedMessageAction = publishedMessageEdited
    ? ('edited' as const)
    : messagePlan.action === 'already_clean'
      ? ('already_clean' as const)
      : ('none' as const);
  if (commitResult === 'cas_conflict') {
    await dependencies.recordFailure(repair, 'database_cas', 'Repair compare-and-set conflict');
    return {
      ...summaryWithChecks,
      publishedMessageAction: finalPublishedMessageAction,
      result: 'cas_conflict',
      complete: false,
    };
  }

  try {
    await dependencies.invalidate(state.chatId);
  } catch (error: unknown) {
    const normalizedError = normalizeError(error);
    await dependencies.recordFailure(repair, 'cache_invalidation', normalizedError);
    return {
      ...summaryWithChecks,
      publishedMessageAction: finalPublishedMessageAction,
      result: 'cache_invalidation_failed',
      complete: false,
      error: normalizedError,
    };
  }

  return {
    ...summaryWithChecks,
    publishedMessageAction: finalPublishedMessageAction,
    result: 'applied',
    complete: true,
  };
}

function buildSettingsContactSnapshot(row: Record<string, unknown>): ChatSettingsContactSnapshot {
  if (!(row.updatedAt instanceof Date)) {
    throw new Error('Chat settings snapshot is missing updatedAt');
  }
  const result: Record<string, boolean | string | Date> = { updatedAt: row.updatedAt };
  for (const [enabledKey, urlKey] of CHAT_SETTINGS_ADMIN_CONTACT_GROUPS) {
    result[enabledKey] = row[enabledKey] === true;
    result[urlKey] = typeof row[urlKey] === 'string' ? row[urlKey] : '';
  }
  return result as ChatSettingsContactSnapshot;
}

function buildRepairAuditPayload(repair: StaleAdminContactCommit): Prisma.InputJsonObject {
  return {
    runId: repair.runId,
    expectedUserId: repair.expectedUserId,
    settingsFields: repair.settingsChanges.map((change) => change.urlKey),
    rulesContactChanged: repair.rulesChange !== null,
    publishedMessageId: repair.publishedMessageId,
    publishedMessageBotId: repair.publishedMessageBotId,
    source: 'operator_cli',
  };
}

export function createProductionDependencies(params: {
  prisma: PrismaService;
  registry: MaxBotRegistryService;
  maxClient: MaxClientService;
  chatContextCache: ChatContextCacheService;
}): StaleAdminContactRepairDependencies {
  const validationTokens = params.registry.getValidationTokens();
  return {
    validationTokens,
    async loadState(chatId) {
      const chat = await params.prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          id: true,
          entityType: true,
          primaryBotId: true,
          botId: true,
          botMemberships: {
            where: { status: ChatBotMembershipStatus.ACTIVE },
            select: { botId: true },
            orderBy: { botId: 'asc' },
          },
          settings: {
            select: {
              requiredSubscriptionAdminContactButtonEnabled: true,
              requiredSubscriptionAdminContactButtonUrl: true,
              invitationAccessAdminContactButtonEnabled: true,
              invitationAccessAdminContactButtonUrl: true,
              messageLimitsAdminContactButtonEnabled: true,
              messageLimitsAdminContactButtonUrl: true,
              phoneNumbersAdminContactButtonEnabled: true,
              phoneNumbersAdminContactButtonUrl: true,
              profanityAdminContactButtonEnabled: true,
              profanityAdminContactButtonUrl: true,
              textFiltersAdminContactButtonEnabled: true,
              textFiltersAdminContactButtonUrl: true,
              linkAdminContactButtonEnabled: true,
              linkAdminContactButtonUrl: true,
              duplicateAdminContactButtonEnabled: true,
              duplicateAdminContactButtonUrl: true,
              updatedAt: true,
            },
          },
          rules: {
            select: {
              text: true,
              adminContactButtonEnabled: true,
              adminContactButtonUrl: true,
              publishedMessageId: true,
              publishedBotId: true,
              publishOperationId: true,
              publishSendStartedAt: true,
              pendingCleanupMessageId: true,
              updatedAt: true,
            },
          },
        },
      });
      if (!chat) {
        return null;
      }
      return {
        chatId: chat.id,
        entityType: chat.entityType,
        primaryBotId: chat.primaryBotId,
        legacyBotId: chat.botId,
        membershipBotIds: chat.botMemberships.map((membership) => membership.botId),
        settings: chat.settings
          ? buildSettingsContactSnapshot(chat.settings as unknown as Record<string, unknown>)
          : null,
        rules: chat.rules,
      };
    },
    async readLiveAdminStatus(chatId, botId, expectedUserId) {
      const options = {
        botId,
        bypassCache: true,
        trafficClass: 'background' as const,
        actionHealthLane: 'background' as const,
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        timeoutMs: LIVE_CHECK_TIMEOUT_MS,
      };
      const [access, expectedUserAccess] = await Promise.all([
        params.maxClient.getCurrentChatMemberAccess(chatId, options),
        params.maxClient.getChatMemberAccess(chatId, expectedUserId, options),
      ]);
      return {
        botIsAdmin: access.isAdmin || access.isOwner,
        expectedUserIsAdmin: Boolean(expectedUserAccess?.isAdmin || expectedUserAccess?.isOwner),
      };
    },
    readPublishedMessageMarkdown(messageId, botId) {
      return params.maxClient.getMessageTextAsMarkdown(messageId, {
        botId,
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
        timeoutMs: LIVE_CHECK_TIMEOUT_MS,
      });
    },
    editPublishedRulesMessage({ chatId, messageId, botId, text }) {
      return params.maxClient.editMessageInlineKeyboard(
        chatId,
        messageId,
        text,
        {
          textFormat: 'markdown',
          preserveExistingInlineKeyboard: true,
        },
        {
          botId,
          trafficClass: 'interactive',
          actionHealthLane: 'interactive',
          sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
          timeoutMs: MESSAGE_EDIT_TIMEOUT_MS,
        },
      );
    },
    recordAttempt(repair) {
      return params.prisma.auditLog
        .create({
          data: {
            chatId: repair.chatId,
            actorUserId: OPERATOR_ACTOR_USER_ID,
            action: 'REPAIR_STALE_ADMIN_CONTACT_STARTED',
            payload: buildRepairAuditPayload(repair),
          },
        })
        .then(() => undefined);
    },
    recordFailure(repair, stage, error) {
      return params.prisma.auditLog
        .create({
          data: {
            chatId: repair.chatId,
            actorUserId: OPERATOR_ACTOR_USER_ID,
            action: 'REPAIR_STALE_ADMIN_CONTACT_FAILED',
            payload: {
              ...buildRepairAuditPayload(repair),
              stage,
              error,
            },
          },
        })
        .then(() => undefined);
    },
    async commit(repair) {
      try {
        await params.prisma.$transaction(async (tx) => {
          if (repair.settingsChanges.length > 0) {
            if (!repair.settingsSnapshot) {
              throw new RepairCasConflictError();
            }
            const where: Record<string, unknown> = {
              chatId: repair.chatId,
              updatedAt: repair.settingsSnapshot.updatedAt,
            };
            const data: Record<string, unknown> = {};
            for (const [enabledKey, urlKey] of CHAT_SETTINGS_ADMIN_CONTACT_GROUPS) {
              where[enabledKey] = repair.settingsSnapshot[enabledKey];
              where[urlKey] = repair.settingsSnapshot[urlKey];
            }
            for (const change of repair.settingsChanges) {
              data[change.enabledKey] = false;
              data[change.urlKey] = '';
            }
            const updated = await tx.chatSettings.updateMany({
              where: where as Prisma.ChatSettingsWhereInput,
              data: data as Prisma.ChatSettingsUpdateManyMutationInput,
            });
            if (updated.count !== 1) {
              throw new RepairCasConflictError();
            }
          }

          if (repair.rulesSnapshot) {
            const updated = await tx.chatRules.updateMany({
              where: {
                chatId: repair.chatId,
                text: repair.rulesSnapshot.expectedText,
                adminContactButtonEnabled: repair.rulesSnapshot.expectedEnabled,
                adminContactButtonUrl: repair.rulesSnapshot.expectedUrl,
                publishedMessageId: repair.rulesSnapshot.expectedPublishedMessageId,
                publishedBotId: repair.rulesSnapshot.expectedPublishedBotId,
                publishOperationId: repair.rulesSnapshot.expectedPublishOperationId,
                publishSendStartedAt: repair.rulesSnapshot.expectedPublishSendStartedAt,
                pendingCleanupMessageId: repair.rulesSnapshot.expectedPendingCleanupMessageId,
                updatedAt: repair.rulesSnapshot.expectedUpdatedAt,
              },
              data: repair.rulesChange
                ? {
                    adminContactButtonEnabled: false,
                    adminContactButtonUrl: '',
                  }
                : {
                    adminContactButtonEnabled: repair.rulesSnapshot.expectedEnabled,
                  },
            });
            if (updated.count !== 1) {
              throw new RepairCasConflictError();
            }
          }

          await tx.auditLog.create({
            data: {
              chatId: repair.chatId,
              actorUserId: OPERATOR_ACTOR_USER_ID,
              action: 'REPAIR_STALE_ADMIN_CONTACT',
              payload: {
                ...buildRepairAuditPayload(repair),
                publishedMessageEdited: repair.publishedMessageEdited,
              },
            },
          });
        });
        return 'applied';
      } catch (error: unknown) {
        if (error instanceof RepairCasConflictError) {
          return 'cas_conflict';
        }
        throw error;
      }
    },
    invalidate(chatId) {
      return params.chatContextCache.invalidate(chatId);
    },
  };
}

function printSummary(summary: StaleAdminContactRepairSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${summary.apply ? 'Apply' : 'Dry-run'} stale admin-contact repair for ${summary.chatId}: ` +
      `${summary.result}. Settings fields: ${summary.settingsFields.length}; ` +
      `rules contact: ${summary.rulesContactMatched ? 'yes' : 'no'}; ` +
      `published message: ${summary.publishedMessageAction}.\n`,
  );
  if (summary.error) {
    process.stderr.write(`${summary.error}\n`);
  }
}

async function main(): Promise<void> {
  const options = readStaleAdminContactRepairOptions(process.argv.slice(2));
  const [
    { StaleAdminContactRepairModule },
    { PrismaService },
    { MaxBotRegistryService },
    { MaxClientService },
    { ChatContextCacheService },
  ] = await Promise.all([
    import('./stale-admin-contact-repair.module'),
    import('../prisma/prisma.service'),
    import('../max/max-bot-registry.service'),
    import('../max/max-client.service'),
    import('../chat-context/chat-context-cache.service'),
  ]);
  const app = await NestFactory.createApplicationContext(StaleAdminContactRepairModule, {
    logger: false,
  });
  try {
    const summary = await runStaleAdminContactRepair(
      createProductionDependencies({
        prisma: app.get(PrismaService),
        registry: app.get(MaxBotRegistryService),
        maxClient: app.get(MaxClientService),
        chatContextCache: app.get(ChatContextCacheService),
      }),
      options,
    );
    printSummary(summary, options.json);
    if (!summary.complete) {
      process.exitCode = 2;
    }
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
