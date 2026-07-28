import { NestFactory } from '@nestjs/core';
import type { MaxBotLinkService, MaxBotRoute } from '../max/max-bot-link.service';
import {
  MAX_API_SOURCE_TAGS,
  type MaxChatMemberAccess,
  type MaxClientService,
} from '../max/max-client.service';
import { normalizePermissionName } from '../max/max-bot-access-policy.util';
import { ChatBotMembershipStatus, ChatEntityType, Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

const MAX_SOURCE_IDS = 5;
const MAX_LIVE_CHECK_TIMEOUT_MS = 5_000;
const ACCESS_LOSS_ERROR_CODE = 'max.access_lost';
const RECOVERY_ACTOR_USER_ID = 'system';
const RECOVERY_AUDIT_ACTION = 'VK_PARSING_RECOVER_ACCESS_LOSS';
const SEND_PERMISSION_ALIASES = new Set(['write', 'can_write']);

const RECOVERY_SOURCE_SELECT = {
  id: true,
  chatId: true,
  screenName: true,
  status: true,
  importEnabled: true,
  autoPublishEnabled: true,
  autoPublishEnabledAt: true,
  autoPublishPausedAt: true,
  autoPublishPausedReason: true,
  syncStatus: true,
  nextSyncAt: true,
  syncStartedAt: true,
  syncLockedAt: true,
  syncLockedBy: true,
  syncLockDeadlineAt: true,
  syncHeartbeatAt: true,
  consecutiveFailures: true,
  terminalFailureCount: true,
  circuitOpenedAt: true,
  circuitReasonCode: true,
  circuitReason: true,
  circuitRetryAt: true,
  lastErrorCode: true,
  lastError: true,
  updatedAt: true,
  chat: { select: { entityType: true } },
} satisfies Prisma.VkParsingSourceSelect;

type RecoverySource = Prisma.VkParsingSourceGetPayload<{
  select: typeof RECOVERY_SOURCE_SELECT;
}>;

type SendMessageRoute = Extract<MaxBotRoute, { purpose: 'send_message' }>;

export const VK_ACCESS_LOSS_RECOVERY_USAGE = [
  'Usage:',
  '  [--source-id <id> ...] [--json]',
  '  --apply --source-id <id> [--source-id <id> ...] [--json]',
  '',
  `Dry-run is the default and previews at most ${MAX_SOURCE_IDS} access-loss sources.`,
  `--apply requires between 1 and ${MAX_SOURCE_IDS} unique explicit --source-id values.`,
  'Every candidate is checked against the shared send route and fresh MAX access before mutation.',
].join('\n');

export type VkAccessLossRecoveryOptions = {
  apply: boolean;
  json: boolean;
  sourceIds: string[];
};

type LiveRouteCheck = {
  botId: string;
  result:
    | 'capable'
    | 'insufficient_access'
    | 'membership_inactive'
    | 'membership_missing'
    | 'route_quarantined'
    | 'error';
  error?: string;
};

type RecoveryRouteSummary = {
  primaryBotId: string | null;
  selectedBotId: string | null;
  candidateBotIds: string[];
  reason: SendMessageRoute['reason'];
  routingVersion: number | null;
};

export type VkAccessLossRecoveryOutcome = {
  sourceId: string;
  chatId: string;
  screenName: string;
  result:
    | 'would_apply'
    | 'applied'
    | 'no_send_route'
    | 'no_live_publish_capability'
    | 'cas_conflict'
    | 'error';
  confirmedBotId: string | null;
  previousAutoPublishEnabledAt: string | null;
  nextAutoPublishEnabledAt: string | null;
  route: RecoveryRouteSummary | null;
  liveChecks: LiveRouteCheck[];
  error?: string;
};

export type VkAccessLossRecoverySummary = {
  apply: boolean;
  requested: number;
  selected: number;
  unmatchedSourceIds: string[];
  liveCapable: number;
  applied: number;
  casConflicts: number;
  errors: number;
  outcomes: VkAccessLossRecoveryOutcome[];
};

type RecoveryClock = () => Date;
type RecoveryMaxBotLink = Pick<MaxBotLinkService, 'resolveBotRoute'>;
type RecoveryMaxClient = Pick<MaxClientService, 'getCurrentChatMemberAccess'>;

function readRequiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function readVkAccessLossRecoveryOptions(
  argv: readonly string[],
): VkAccessLossRecoveryOptions {
  let apply = false;
  let json = false;
  let explicitDryRun = false;
  const sourceIds: string[] = [];

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
    if (arg === '--source-id') {
      sourceIds.push(readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(VK_ACCESS_LOSS_RECOVERY_USAGE);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (apply && explicitDryRun) {
    throw new Error('--apply cannot be combined with --dry-run');
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('Each --source-id must be unique');
  }
  if (sourceIds.length > MAX_SOURCE_IDS) {
    throw new Error(`At most ${MAX_SOURCE_IDS} --source-id values are allowed`);
  }
  if (apply && sourceIds.length === 0) {
    throw new Error('--apply requires at least one explicit --source-id');
  }

  return { apply, json, sourceIds };
}

const normalizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
  return message.trim().slice(0, 1_000) || 'Unknown error';
};

const toIso = (value: Date | null): string | null => value?.toISOString() ?? null;

function normalizeCandidateBotIds(route: MaxBotRoute): string[] {
  return Array.from(
    new Set(
      route.candidateBotIds
        .map((botId) => (typeof botId === 'string' ? botId.trim() : ''))
        .filter(Boolean),
    ),
  );
}

function summarizeRoute(route: SendMessageRoute): RecoveryRouteSummary {
  return {
    primaryBotId: route.primaryBotId,
    selectedBotId: route.botId,
    candidateBotIds: normalizeCandidateBotIds(route),
    reason: route.reason,
    routingVersion: route.routingVersion ?? null,
  };
}

function hasLivePublishCapability(
  entityType: ChatEntityType,
  access: MaxChatMemberAccess,
): boolean {
  if (access.isOwner) {
    return true;
  }
  if (entityType !== ChatEntityType.CHANNEL) {
    return access.isAdmin;
  }
  return access.permissions.some((permission) =>
    SEND_PERMISSION_ALIASES.has(normalizePermissionName(permission)),
  );
}

async function loadRecoverySources(
  prisma: PrismaService,
  options: VkAccessLossRecoveryOptions,
): Promise<{ sources: RecoverySource[]; unmatchedSourceIds: string[] }> {
  const sources = await prisma.vkParsingSource.findMany({
    where: {
      ...(options.sourceIds.length > 0 ? { id: { in: options.sourceIds } } : {}),
      status: 'ACTIVE',
      importEnabled: true,
      syncStatus: 'ERROR',
      nextSyncAt: null,
      lastErrorCode: ACCESS_LOSS_ERROR_CODE,
      circuitOpenedAt: { not: null },
      circuitReasonCode: ACCESS_LOSS_ERROR_CODE,
    },
    select: RECOVERY_SOURCE_SELECT,
    orderBy: [{ circuitOpenedAt: 'asc' }, { updatedAt: 'asc' }, { id: 'asc' }],
    take: MAX_SOURCE_IDS,
  });

  if (options.sourceIds.length === 0) {
    return { sources, unmatchedSourceIds: [] };
  }

  const byId = new Map(sources.map((source) => [source.id, source]));
  return {
    sources: options.sourceIds.flatMap((sourceId) => {
      const source = byId.get(sourceId);
      return source ? [source] : [];
    }),
    unmatchedSourceIds: options.sourceIds.filter((sourceId) => !byId.has(sourceId)),
  };
}

async function resolveLivePublishBot(
  prisma: PrismaService,
  maxBotLink: RecoveryMaxBotLink,
  maxClient: RecoveryMaxClient,
  source: RecoverySource,
  checkedAt: Date,
): Promise<{
  route: RecoveryRouteSummary | null;
  confirmedBotId: string | null;
  liveChecks: LiveRouteCheck[];
}> {
  const resolved = await maxBotLink.resolveBotRoute({
    purpose: 'send_message',
    chatId: source.chatId,
    fallbackToPrimary: true,
  });
  if (resolved.purpose !== 'send_message') {
    throw new Error(`Expected send_message route, received ${resolved.purpose}`);
  }

  const route = summarizeRoute(resolved);
  if (route.candidateBotIds.length === 0) {
    return { route, confirmedBotId: null, liveChecks: [] };
  }

  const memberships = await prisma.chatBotMembership.findMany({
    where: {
      chatId: source.chatId,
      botId: { in: route.candidateBotIds },
    },
    select: {
      botId: true,
      status: true,
      sendRouteQuarantinedUntil: true,
    },
  });
  const membershipsByBotId = new Map(
    memberships.map((membership) => [membership.botId, membership]),
  );
  const liveChecks: LiveRouteCheck[] = [];

  for (const botId of route.candidateBotIds) {
    const membership = membershipsByBotId.get(botId);
    if (!membership) {
      liveChecks.push({ botId, result: 'membership_missing' });
      continue;
    }
    if (membership.status !== ChatBotMembershipStatus.ACTIVE) {
      liveChecks.push({ botId, result: 'membership_inactive' });
      continue;
    }
    if (
      membership.sendRouteQuarantinedUntil &&
      membership.sendRouteQuarantinedUntil.getTime() > checkedAt.getTime()
    ) {
      liveChecks.push({ botId, result: 'route_quarantined' });
      continue;
    }

    try {
      const access = await maxClient.getCurrentChatMemberAccess(source.chatId, {
        botId,
        bypassCache: true,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
        timeoutMs: MAX_LIVE_CHECK_TIMEOUT_MS,
      });
      if (!hasLivePublishCapability(source.chat.entityType, access)) {
        liveChecks.push({ botId, result: 'insufficient_access' });
        continue;
      }
      liveChecks.push({ botId, result: 'capable' });
      return { route, confirmedBotId: botId, liveChecks };
    } catch (error: unknown) {
      liveChecks.push({ botId, result: 'error', error: normalizeError(error) });
    }
  }

  return { route, confirmedBotId: null, liveChecks };
}

async function applyRecovery(
  prisma: PrismaService,
  source: RecoverySource,
  route: RecoveryRouteSummary,
  confirmedBotId: string,
  applyAt: Date,
): Promise<boolean> {
  const previousBaseline = source.autoPublishEnabledAt;
  const nextBaseline = source.autoPublishEnabled ? applyAt : previousBaseline;
  const nextPausedAt = source.autoPublishEnabled ? null : source.autoPublishPausedAt;
  const nextPausedReason = source.autoPublishEnabled ? null : source.autoPublishPausedReason;

  return prisma.$transaction(async (tx) => {
    // FLAG: Every field that recovery relies on or overwrites participates in this CAS. The
    // updatedAt guard also rejects concurrent admin edits to settings outside this focused set.
    const updated = await tx.vkParsingSource.updateMany({
      where: {
        id: source.id,
        chatId: source.chatId,
        status: source.status,
        importEnabled: source.importEnabled,
        autoPublishEnabled: source.autoPublishEnabled,
        autoPublishEnabledAt: source.autoPublishEnabledAt,
        autoPublishPausedAt: source.autoPublishPausedAt,
        autoPublishPausedReason: source.autoPublishPausedReason,
        syncStatus: source.syncStatus,
        nextSyncAt: source.nextSyncAt,
        syncStartedAt: source.syncStartedAt,
        syncLockedAt: source.syncLockedAt,
        syncLockedBy: source.syncLockedBy,
        syncLockDeadlineAt: source.syncLockDeadlineAt,
        syncHeartbeatAt: source.syncHeartbeatAt,
        consecutiveFailures: source.consecutiveFailures,
        terminalFailureCount: source.terminalFailureCount,
        circuitOpenedAt: source.circuitOpenedAt,
        circuitReasonCode: source.circuitReasonCode,
        circuitReason: source.circuitReason,
        circuitRetryAt: source.circuitRetryAt,
        lastErrorCode: source.lastErrorCode,
        lastError: source.lastError,
        updatedAt: source.updatedAt,
      },
      data: {
        syncStatus: 'IDLE',
        nextSyncAt: applyAt,
        syncStartedAt: null,
        syncLockedAt: null,
        syncLockedBy: null,
        syncLockDeadlineAt: null,
        syncHeartbeatAt: null,
        consecutiveFailures: 0,
        terminalFailureCount: 0,
        circuitOpenedAt: null,
        circuitReasonCode: null,
        circuitReason: null,
        circuitRetryAt: null,
        lastErrorCode: null,
        lastError: null,
        ...(source.autoPublishEnabled
          ? {
              autoPublishEnabledAt: applyAt,
              autoPublishPausedAt: null,
              autoPublishPausedReason: null,
            }
          : {}),
      },
    });
    if (updated.count !== 1) {
      return false;
    }

    await tx.auditLog.create({
      data: {
        chatId: source.chatId,
        actorUserId: RECOVERY_ACTOR_USER_ID,
        action: RECOVERY_AUDIT_ACTION,
        payload: {
          sourceId: source.id,
          applyAt: applyAt.toISOString(),
          reason: 'operator_confirmed_live_max_publish_access',
          confirmedBotId,
          routePurpose: 'send_message',
          routeReason: route.reason,
          routeSelectedBotId: route.selectedBotId,
          routePrimaryBotId: route.primaryBotId,
          routeCandidateBotIds: route.candidateBotIds,
          routeRoutingVersion: route.routingVersion,
          previousAutoPublishEnabledAt: toIso(previousBaseline),
          nextAutoPublishEnabledAt: toIso(nextBaseline),
          previousAutoPublishPausedAt: toIso(source.autoPublishPausedAt),
          nextAutoPublishPausedAt: toIso(nextPausedAt),
          previousAutoPublishPausedReason: source.autoPublishPausedReason,
          nextAutoPublishPausedReason: nextPausedReason,
          previousCircuitOpenedAt: toIso(source.circuitOpenedAt),
          previousCircuitReason: source.circuitReason,
        },
      },
    });
    return true;
  });
}

export async function runVkAccessLossRecovery(
  prisma: PrismaService,
  maxBotLink: RecoveryMaxBotLink,
  maxClient: RecoveryMaxClient,
  options: VkAccessLossRecoveryOptions,
  now: RecoveryClock = () => new Date(),
): Promise<VkAccessLossRecoverySummary> {
  const { sources, unmatchedSourceIds } = await loadRecoverySources(prisma, options);
  const outcomes: VkAccessLossRecoveryOutcome[] = [];

  for (const source of sources) {
    let liveRoute: Awaited<ReturnType<typeof resolveLivePublishBot>>;
    try {
      liveRoute = await resolveLivePublishBot(prisma, maxBotLink, maxClient, source, now());
    } catch (error: unknown) {
      outcomes.push({
        sourceId: source.id,
        chatId: source.chatId,
        screenName: source.screenName,
        result: 'error',
        confirmedBotId: null,
        previousAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        nextAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        route: null,
        liveChecks: [],
        error: normalizeError(error),
      });
      continue;
    }

    const applyAt = now();
    const nextBaseline = source.autoPublishEnabled ? applyAt : source.autoPublishEnabledAt;
    if (!liveRoute.route || liveRoute.route.candidateBotIds.length === 0) {
      outcomes.push({
        sourceId: source.id,
        chatId: source.chatId,
        screenName: source.screenName,
        result: 'no_send_route',
        confirmedBotId: null,
        previousAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        nextAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        route: liveRoute.route,
        liveChecks: liveRoute.liveChecks,
      });
      continue;
    }
    if (!liveRoute.confirmedBotId) {
      outcomes.push({
        sourceId: source.id,
        chatId: source.chatId,
        screenName: source.screenName,
        result: 'no_live_publish_capability',
        confirmedBotId: null,
        previousAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        nextAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        route: liveRoute.route,
        liveChecks: liveRoute.liveChecks,
      });
      continue;
    }

    if (!options.apply) {
      outcomes.push({
        sourceId: source.id,
        chatId: source.chatId,
        screenName: source.screenName,
        result: 'would_apply',
        confirmedBotId: liveRoute.confirmedBotId,
        previousAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        nextAutoPublishEnabledAt: toIso(nextBaseline),
        route: liveRoute.route,
        liveChecks: liveRoute.liveChecks,
      });
      continue;
    }

    try {
      const applied = await applyRecovery(
        prisma,
        source,
        liveRoute.route,
        liveRoute.confirmedBotId,
        applyAt,
      );
      outcomes.push({
        sourceId: source.id,
        chatId: source.chatId,
        screenName: source.screenName,
        result: applied ? 'applied' : 'cas_conflict',
        confirmedBotId: liveRoute.confirmedBotId,
        previousAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        nextAutoPublishEnabledAt: applied
          ? toIso(nextBaseline)
          : toIso(source.autoPublishEnabledAt),
        route: liveRoute.route,
        liveChecks: liveRoute.liveChecks,
      });
    } catch (error: unknown) {
      outcomes.push({
        sourceId: source.id,
        chatId: source.chatId,
        screenName: source.screenName,
        result: 'error',
        confirmedBotId: liveRoute.confirmedBotId,
        previousAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        nextAutoPublishEnabledAt: toIso(source.autoPublishEnabledAt),
        route: liveRoute.route,
        liveChecks: liveRoute.liveChecks,
        error: normalizeError(error),
      });
    }
  }

  return {
    apply: options.apply,
    requested: options.sourceIds.length,
    selected: sources.length,
    unmatchedSourceIds,
    liveCapable: outcomes.filter((outcome) => outcome.confirmedBotId !== null).length,
    applied: outcomes.filter((outcome) => outcome.result === 'applied').length,
    casConflicts: outcomes.filter((outcome) => outcome.result === 'cas_conflict').length,
    errors: outcomes.filter((outcome) => outcome.result === 'error').length,
    outcomes,
  };
}

function printSummary(summary: VkAccessLossRecoverySummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `${summary.apply ? 'Applied' : 'Dry-run'} VK access-loss recovery: ` +
      `${summary.selected} selected, ${summary.liveCapable} live-capable, ` +
      `${summary.applied} applied, ${summary.casConflicts} CAS conflicts, ` +
      `${summary.errors} errors, ${summary.unmatchedSourceIds.length} unmatched.\n` +
      (summary.unmatchedSourceIds.length > 0
        ? `Unmatched source IDs: ${summary.unmatchedSourceIds.join(', ')}\n`
        : '') +
      summary.outcomes
        .map(
          (outcome) =>
            `${outcome.sourceId} (${outcome.chatId}): ${outcome.result}` +
            (outcome.confirmedBotId ? ` via ${outcome.confirmedBotId}` : '') +
            (outcome.error ? ` - ${outcome.error}` : ''),
        )
        .join('\n') +
      (summary.outcomes.length > 0 ? '\n' : ''),
  );
}

async function main(): Promise<void> {
  const options = readVkAccessLossRecoveryOptions(process.argv.slice(2));
  const [
    { VkParsingAccessLossRecoveryModule },
    { PrismaService },
    { MaxBotLinkService },
    { MaxClientService },
  ] = await Promise.all([
    import('./vk-parsing-access-loss-recovery.module'),
    import('../prisma/prisma.service'),
    import('../max/max-bot-link.service'),
    import('../max/max-client.service'),
  ]);
  const app = await NestFactory.createApplicationContext(VkParsingAccessLossRecoveryModule);
  try {
    const summary = await runVkAccessLossRecovery(
      app.get(PrismaService),
      app.get(MaxBotLinkService),
      app.get(MaxClientService),
      options,
    );
    printSummary(summary, options.json);
    const applyIncomplete =
      options.apply && summary.applied + summary.casConflicts + summary.errors !== summary.selected;
    if (
      summary.unmatchedSourceIds.length > 0 ||
      summary.casConflicts > 0 ||
      summary.errors > 0 ||
      applyIncomplete
    ) {
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
