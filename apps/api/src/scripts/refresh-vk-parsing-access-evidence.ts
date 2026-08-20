import { NestFactory } from '@nestjs/core';
import {
  buildBotAccessSnapshotPersistence,
  normalizePermissions,
} from '../max/bot-access-snapshot.util';
import { normalizePermissionName } from '../max/max-bot-access-policy.util';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  MAX_API_SOURCE_TAGS,
  type MaxChatMemberAccess,
  type MaxClientService,
} from '../max/max-client.service';
import {
  classifyMaxTerminalChatActionError,
  resolveManagedEntityAccessLossReason,
} from '../max/managed-entity-access-loss.service';
import {
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
  Prisma,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

const MAX_CHAT_IDS = 5;
const LIVE_CHECK_TIMEOUT_MS = 5_000;
const CHANNEL_WRITE_PERMISSIONS = new Set(['write', 'can_write']);

export const VK_PARSING_ACCESS_EVIDENCE_SOURCE = 'vk_parsing_access_evidence_refresh';

const MANAGED_CHAT_SELECT = {
  id: true,
  entityType: true,
  botMemberships: {
    where: { status: ChatBotMembershipStatus.ACTIVE },
    select: {
      botId: true,
      status: true,
    },
    orderBy: { botId: 'asc' },
  },
} satisfies Prisma.ChatSelect;

type ManagedChat = Prisma.ChatGetPayload<{ select: typeof MANAGED_CHAT_SELECT }>;
type AccessEvidencePrisma = Pick<PrismaService, 'chat'>;
type AccessEvidenceBotLink = Pick<MaxBotLinkService, 'recordBotAccessProbe'>;
type AccessEvidenceRegistry = Pick<MaxBotRegistryService, 'getActionableBots' | 'getDiscoveryBots'>;
type AccessEvidenceMaxClient = Pick<MaxClientService, 'getCurrentChatMemberAccess'>;

export const VK_PARSING_ACCESS_EVIDENCE_REFRESH_USAGE = [
  'Usage:',
  '  --chat-id <id> [--chat-id <id> ...] [--dry-run] [--json]',
  '  --apply --chat-id <id> [--chat-id <id> ...] [--json]',
  '',
  `Between 1 and ${MAX_CHAT_IDS} unique explicit --chat-id values are required.`,
  'Dry-run is the default. Only successful live MAX probes are eligible for persistence.',
  'The command never creates or reactivates memberships and does not change rosters, allowlists, or published snapshots.',
  'Successful persistence may reconcile primary-bot routing from the refreshed access evidence.',
].join('\n');

export type VkParsingAccessEvidenceRefreshOptions = {
  apply: boolean;
  json: boolean;
  chatIds: string[];
};

export type VkParsingAccessEvidenceBotOutcome = {
  botId: string;
  result:
    | 'would_persist'
    | 'persisted'
    | 'cas_conflict'
    | 'transient_error'
    | 'terminal_access_loss';
  capable: boolean;
  persisted: boolean;
  checkedAt: string | null;
  expiresAt: string | null;
  isAdmin: boolean | null;
  isOwner: boolean | null;
  permissions: string[];
  terminalReason?: string;
  error?: string;
};

export type VkParsingAccessEvidenceChatOutcome = {
  chatId: string;
  entityType: 'chat' | 'channel' | null;
  result: 'ready' | 'unmanaged_or_missing' | 'no_eligible_memberships' | 'access_unproven';
  eligibleBotIds: string[];
  freshCapableBotIds: string[];
  bots: VkParsingAccessEvidenceBotOutcome[];
};

export type VkParsingAccessEvidenceRefreshSummary = {
  apply: boolean;
  requested: number;
  selected: number;
  ready: number;
  persisted: number;
  wouldPersist: number;
  casConflicts: number;
  transientErrors: number;
  terminalAccessLosses: number;
  unmatchedChatIds: string[];
  complete: boolean;
  outcomes: VkParsingAccessEvidenceChatOutcome[];
};

function readRequiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function readVkParsingAccessEvidenceRefreshOptions(
  argv: readonly string[],
): VkParsingAccessEvidenceRefreshOptions {
  let apply = false;
  let explicitDryRun = false;
  let json = false;
  const chatIds: string[] = [];

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
    if (arg === '--chat-id') {
      chatIds.push(readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(VK_PARSING_ACCESS_EVIDENCE_REFRESH_USAGE);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (apply && explicitDryRun) {
    throw new Error('--apply cannot be combined with --dry-run');
  }
  if (chatIds.length === 0) {
    throw new Error('At least one explicit --chat-id is required');
  }
  if (new Set(chatIds).size !== chatIds.length) {
    throw new Error('Each --chat-id must be unique');
  }
  if (chatIds.length > MAX_CHAT_IDS) {
    throw new Error(`At most ${MAX_CHAT_IDS} --chat-id values are allowed`);
  }

  return { apply, json, chatIds };
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
  return message.trim().slice(0, 1_000) || 'Unknown error';
}

function toEntityType(value: ChatEntityType): 'chat' | 'channel' {
  return value === ChatEntityType.CHANNEL ? 'channel' : 'chat';
}

export function hasVkPublishCapability(
  entityType: ChatEntityType,
  access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner' | 'permissions'>,
): boolean {
  if (access.isOwner) {
    return true;
  }
  if (!access.isAdmin) {
    return false;
  }
  if (entityType !== ChatEntityType.CHANNEL) {
    return true;
  }
  return access.permissions.some((permission) =>
    CHANNEL_WRITE_PERMISSIONS.has(normalizePermissionName(permission)),
  );
}

async function loadNamedManagedChats(
  prisma: AccessEvidencePrisma,
  chatIds: readonly string[],
): Promise<ManagedChat[]> {
  const requested = new Set(chatIds);
  const rows = await prisma.chat.findMany({
    where: {
      id: { in: [...chatIds] },
      OR: [
        { catalogKind: ChatCatalogKind.MANAGED },
        { catalogKind: ChatCatalogKind.UNKNOWN, entityType: ChatEntityType.CHANNEL },
      ],
    },
    select: MANAGED_CHAT_SELECT,
    orderBy: { id: 'asc' },
    take: chatIds.length,
  });
  return rows.filter((row) => requested.has(row.id));
}

async function probeMembership(
  maxClient: AccessEvidenceMaxClient,
  botLink: AccessEvidenceBotLink,
  chat: ManagedChat,
  membership: ManagedChat['botMemberships'][number],
  apply: boolean,
  now: () => Date,
): Promise<VkParsingAccessEvidenceBotOutcome> {
  try {
    const checkedAt = now();
    const access = await maxClient.getCurrentChatMemberAccess(chat.id, {
      botId: membership.botId,
      bypassCache: true,
      trafficClass: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      timeoutMs: LIVE_CHECK_TIMEOUT_MS,
    });
    const persistence = buildBotAccessSnapshotPersistence(access, {
      source: VK_PARSING_ACCESS_EVIDENCE_SOURCE,
      now: checkedAt,
    });
    const capable = hasVkPublishCapability(chat.entityType, access);
    const permissions = normalizePermissions(access.permissions);

    if (!apply) {
      return {
        botId: membership.botId,
        result: 'would_persist',
        capable,
        persisted: false,
        checkedAt: persistence.botAccessCheckedAt.toISOString(),
        expiresAt: persistence.botAccessExpiresAt.toISOString(),
        isAdmin: access.isAdmin,
        isOwner: access.isOwner,
        permissions,
      };
    }

    // FLAG: Persist successful probes through the shared access boundary so routing stays aligned;
    // membership recovery must remain disabled for this bounded repair command.
    const persisted = await botLink.recordBotAccessProbe({
      chatId: chat.id,
      botId: membership.botId,
      access,
      source: VK_PARSING_ACCESS_EVIDENCE_SOURCE,
      checkedAt,
      allowMembershipRecovery: false,
    });
    return {
      botId: membership.botId,
      result: persisted ? 'persisted' : 'cas_conflict',
      capable,
      persisted,
      checkedAt: persistence.botAccessCheckedAt.toISOString(),
      expiresAt: persistence.botAccessExpiresAt.toISOString(),
      isAdmin: access.isAdmin,
      isOwner: access.isOwner,
      permissions,
    };
  } catch (error: unknown) {
    const classification = classifyMaxTerminalChatActionError(error);
    const terminalReason = classification
      ? resolveManagedEntityAccessLossReason('lookup', classification)
      : null;
    return {
      botId: membership.botId,
      result: terminalReason ? 'terminal_access_loss' : 'transient_error',
      capable: false,
      persisted: false,
      checkedAt: null,
      expiresAt: null,
      isAdmin: null,
      isOwner: null,
      permissions: [],
      ...(terminalReason ? { terminalReason } : {}),
      error: normalizeError(error),
    };
  }
}

export async function runVkParsingAccessEvidenceRefresh(
  prisma: AccessEvidencePrisma,
  registry: AccessEvidenceRegistry,
  maxClient: AccessEvidenceMaxClient,
  botLink: AccessEvidenceBotLink,
  options: VkParsingAccessEvidenceRefreshOptions,
  now: () => Date = () => new Date(),
): Promise<VkParsingAccessEvidenceRefreshSummary> {
  const chats = await loadNamedManagedChats(prisma, options.chatIds);
  const chatsById = new Map(chats.map((chat) => [chat.id, chat]));
  const discoveryBotIds = new Set(registry.getDiscoveryBots().map((bot) => bot.id));
  const actionableBotIds = new Set(registry.getActionableBots().map((bot) => bot.id));
  const outcomes: VkParsingAccessEvidenceChatOutcome[] = [];

  for (const chatId of options.chatIds) {
    const chat = chatsById.get(chatId);
    if (!chat) {
      outcomes.push({
        chatId,
        entityType: null,
        result: 'unmanaged_or_missing',
        eligibleBotIds: [],
        freshCapableBotIds: [],
        bots: [],
      });
      continue;
    }

    const memberships = chat.botMemberships.filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        discoveryBotIds.has(membership.botId) &&
        actionableBotIds.has(membership.botId),
    );
    if (memberships.length === 0) {
      outcomes.push({
        chatId,
        entityType: toEntityType(chat.entityType),
        result: 'no_eligible_memberships',
        eligibleBotIds: [],
        freshCapableBotIds: [],
        bots: [],
      });
      continue;
    }

    const bots: VkParsingAccessEvidenceBotOutcome[] = [];
    for (const membership of memberships) {
      bots.push(await probeMembership(maxClient, botLink, chat, membership, options.apply, now));
    }
    const freshCapableBotIds = bots
      .filter(
        (bot) =>
          bot.capable &&
          (options.apply ? bot.result === 'persisted' : bot.result === 'would_persist'),
      )
      .map((bot) => bot.botId);
    outcomes.push({
      chatId,
      entityType: toEntityType(chat.entityType),
      result: freshCapableBotIds.length > 0 ? 'ready' : 'access_unproven',
      eligibleBotIds: memberships.map((membership) => membership.botId),
      freshCapableBotIds,
      bots,
    });
  }

  const botOutcomes = outcomes.flatMap((outcome) => outcome.bots);
  const unmatchedChatIds = outcomes
    .filter((outcome) => outcome.result === 'unmanaged_or_missing')
    .map((outcome) => outcome.chatId);
  const ready = outcomes.filter((outcome) => outcome.result === 'ready').length;
  return {
    apply: options.apply,
    requested: options.chatIds.length,
    selected: chats.length,
    ready,
    persisted: botOutcomes.filter((outcome) => outcome.result === 'persisted').length,
    wouldPersist: botOutcomes.filter((outcome) => outcome.result === 'would_persist').length,
    casConflicts: botOutcomes.filter((outcome) => outcome.result === 'cas_conflict').length,
    transientErrors: botOutcomes.filter((outcome) => outcome.result === 'transient_error').length,
    terminalAccessLosses: botOutcomes.filter((outcome) => outcome.result === 'terminal_access_loss')
      .length,
    unmatchedChatIds,
    complete: ready === options.chatIds.length,
    outcomes,
  };
}

function printSummary(summary: VkParsingAccessEvidenceRefreshSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `${summary.apply ? 'Applied' : 'Dry-run'} VK access evidence refresh: ` +
      `${summary.ready}/${summary.requested} chats ready, ${summary.persisted} persisted, ` +
      `${summary.wouldPersist} would persist, ${summary.transientErrors} transient errors, ` +
      `${summary.terminalAccessLosses} terminal losses, ${summary.casConflicts} CAS conflicts.\n` +
      summary.outcomes
        .map(
          (outcome) =>
            `${outcome.chatId}: ${outcome.result}` +
            (outcome.freshCapableBotIds.length > 0
              ? ` via ${outcome.freshCapableBotIds.join(',')}`
              : ''),
        )
        .join('\n') +
      '\n',
  );
}

async function main(): Promise<void> {
  const options = readVkParsingAccessEvidenceRefreshOptions(process.argv.slice(2));
  const [
    { VkParsingAccessEvidenceRefreshModule },
    { PrismaService },
    { MaxBotRegistryService },
    { MaxClientService },
    { MaxBotLinkService },
  ] = await Promise.all([
    import('./vk-parsing-access-evidence-refresh.module'),
    import('../prisma/prisma.service'),
    import('../max/max-bot-registry.service'),
    import('../max/max-client.service'),
    import('../max/max-bot-link.service'),
  ]);
  const app = await NestFactory.createApplicationContext(VkParsingAccessEvidenceRefreshModule, {
    logger: false,
  });
  try {
    const summary = await runVkParsingAccessEvidenceRefresh(
      app.get(PrismaService),
      app.get(MaxBotRegistryService),
      app.get(MaxClientService),
      app.get(MaxBotLinkService),
      options,
    );
    printSummary(summary, options.json);
    if (!summary.complete) {
      process.exitCode = 1;
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
