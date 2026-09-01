import { NestFactory } from '@nestjs/core';
import {
  DEFAULT_PRIMARY_ACCESS_SNAPSHOT_FRESH_MS,
  normalizeMembershipAccessSnapshot,
  normalizePermissionName,
} from '../max/max-bot-access-policy.util';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  Prisma,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { releasePublicationRouteQuarantineBacklog } from '../admin/publication-route-quarantine-backlog';

const MAX_ROUTE_PAIRS = 5;
const RECOVERY_AUDIT_ACTION = 'PUBLICATION_SEND_ROUTE_CONTROLLED_RECOVERY';
const WRITE_MESSAGE_PERMISSION_ALIASES = new Set(['write', 'can_write']);

const RECOVERY_MEMBERSHIP_SELECT = {
  id: true,
  chatId: true,
  botId: true,
  status: true,
  botAccessState: true,
  botAccessCheckedAt: true,
  botAccessExpiresAt: true,
  permissionsSnapshot: true,
  sendRouteFailureCount: true,
  sendRouteQuarantinedUntil: true,
  sendRouteLastFailureAt: true,
  sendRouteLastFailureCode: true,
  sendRouteLastSuccessAt: true,
  updatedAt: true,
  chat: {
    select: {
      entityType: true,
      routingState: true,
    },
  },
} satisfies Prisma.ChatBotMembershipSelect;

type RecoveryMembership = Prisma.ChatBotMembershipGetPayload<{
  select: typeof RECOVERY_MEMBERSHIP_SELECT;
}>;

type RecoveryBotRegistry = Pick<MaxBotRegistryService, 'getActionableBots'>;
type RecoveryClock = () => Date;

export type PublicationSendRoutePair = {
  chatId: string;
  botId: string;
};

export type PublicationSendRouteRecoveryOptions = {
  apply: boolean;
  json: boolean;
  actorUserId: string | null;
  routes: PublicationSendRoutePair[];
};

type RecoveryIneligibleReason =
  | 'membership_missing'
  | 'membership_inactive'
  | 'chat_route_not_ready'
  | 'bot_not_actionable'
  | 'not_sticky_disappearance'
  | 'persisted_access_unconfirmed'
  | 'persisted_access_stale'
  | 'persisted_send_capability_missing';

export type PublicationSendRouteRecoveryOutcome = {
  chatId: string;
  botId: string;
  result: 'would_apply' | 'applied' | 'ineligible' | 'cas_conflict' | 'error';
  reason: RecoveryIneligibleReason | null;
  previousFailureCount: number | null;
  previousQuarantinedUntil: string | null;
  wokenBroadcastCount: number;
  releasedDeliveryCount: number;
  error?: string;
};

export type PublicationSendRouteRecoverySummary = {
  apply: boolean;
  requested: number;
  wouldApply: number;
  applied: number;
  ineligible: number;
  casConflicts: number;
  errors: number;
  outcomes: PublicationSendRouteRecoveryOutcome[];
};

export const PUBLICATION_SEND_ROUTE_RECOVERY_USAGE = [
  'Usage:',
  '  --route <chatId> <botId> [--route <chatId> <botId> ...] [--dry-run] [--json]',
  '  --apply --actor-user-id <id> --route <chatId> <botId> [--route ...] [--json]',
  '',
  `Dry-run is the default. Between 1 and ${MAX_ROUTE_PAIRS} unique explicit route pairs are required.`,
  '--apply performs no live MAX calls. It relies on fresh persisted ACTIVE access/capability.',
  'Eligible sticky routes move to one controlled half-open probe; only matching Publication backlog is woken.',
].join('\n');

function readRequiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

const buildRouteKey = (route: PublicationSendRoutePair): string =>
  JSON.stringify([route.chatId, route.botId]);

export function readPublicationSendRouteRecoveryOptions(
  argv: readonly string[],
): PublicationSendRouteRecoveryOptions {
  let apply = false;
  let explicitDryRun = false;
  let json = false;
  let actorUserId: string | null = null;
  const routes: PublicationSendRoutePair[] = [];

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
    if (arg === '--actor-user-id') {
      actorUserId = readRequiredValue(argv, index + 1, arg);
      index += 1;
      continue;
    }
    if (arg === '--route') {
      const chatId = readRequiredValue(argv, index + 1, `${arg} chatId`);
      const botId = readRequiredValue(argv, index + 2, `${arg} botId`);
      routes.push({ chatId, botId });
      index += 2;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(PUBLICATION_SEND_ROUTE_RECOVERY_USAGE);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (apply && explicitDryRun) {
    throw new Error('--apply cannot be combined with --dry-run');
  }
  if (routes.length === 0) {
    throw new Error('At least one explicit --route <chatId> <botId> pair is required');
  }
  if (routes.length > MAX_ROUTE_PAIRS) {
    throw new Error(`At most ${MAX_ROUTE_PAIRS} --route pairs are allowed`);
  }
  if (new Set(routes.map(buildRouteKey)).size !== routes.length) {
    throw new Error('Each --route <chatId> <botId> pair must be unique');
  }
  if (apply && !actorUserId) {
    throw new Error('--apply requires --actor-user-id');
  }

  return { apply, json, actorUserId, routes };
}

const normalizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
  return message.trim().slice(0, 1_000) || 'Unknown error';
};

const toIso = (value: Date | null): string | null => value?.toISOString() ?? null;

function hasFreshPersistedAccess(membership: RecoveryMembership, now: Date): boolean {
  if (membership.botAccessExpiresAt) {
    return membership.botAccessExpiresAt > now;
  }
  const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
  const checkedAtMs =
    membership.botAccessCheckedAt?.getTime() ??
    (snapshot?.checkedAt ? Date.parse(snapshot.checkedAt) : Number.NaN);
  return (
    Number.isFinite(checkedAtMs) &&
    checkedAtMs <= now.getTime() &&
    checkedAtMs + DEFAULT_PRIMARY_ACCESS_SNAPSHOT_FRESH_MS > now.getTime()
  );
}

function hasPersistedSendCapability(membership: RecoveryMembership): boolean {
  if (membership.chat.entityType !== ChatEntityType.CHANNEL) {
    return true;
  }
  if (membership.botAccessState === ChatBotAccessState.CONFIRMED_OWNER) {
    return true;
  }
  const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
  if (snapshot?.isOwner) {
    return true;
  }
  return Boolean(
    snapshot?.permissions.some((permission) =>
      WRITE_MESSAGE_PERMISSION_ALIASES.has(normalizePermissionName(permission)),
    ),
  );
}

function resolveIneligibleReason(
  membership: RecoveryMembership,
  actionableBotIds: ReadonlySet<string>,
  now: Date,
): Exclude<RecoveryIneligibleReason, 'membership_missing'> | null {
  if (membership.status !== ChatBotMembershipStatus.ACTIVE) {
    return 'membership_inactive';
  }
  if (membership.chat.routingState !== ChatRoutingState.READY) {
    return 'chat_route_not_ready';
  }
  if (!actionableBotIds.has(membership.botId)) {
    return 'bot_not_actionable';
  }
  if (
    membership.sendRouteFailureCount < 2 ||
    membership.sendRouteLastFailureCode !== MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE
  ) {
    return 'not_sticky_disappearance';
  }
  if (
    membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
    membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
  ) {
    return 'persisted_access_unconfirmed';
  }
  if (!hasFreshPersistedAccess(membership, now)) {
    return 'persisted_access_stale';
  }
  if (!hasPersistedSendCapability(membership)) {
    return 'persisted_send_capability_missing';
  }
  return null;
}

async function applyControlledHalfOpenRecovery(
  prisma: PrismaService,
  membership: RecoveryMembership,
  actorUserId: string,
  applyAt: Date,
): Promise<
  | { applied: false; wokenBroadcastCount: 0; releasedDeliveryCount: 0 }
  | { applied: true; wokenBroadcastCount: number; releasedDeliveryCount: number }
> {
  return prisma.$transaction(
    async (tx) => {
      // FLAG: This CAS fences every persisted health field plus updatedAt. A concurrent lifecycle,
      // access, verification, claim, or operator mutation must win instead of being overwritten.
      const transitioned = await tx.chatBotMembership.updateMany({
        where: {
          id: membership.id,
          chatId: membership.chatId,
          botId: membership.botId,
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: membership.botAccessState,
          botAccessCheckedAt: membership.botAccessCheckedAt,
          botAccessExpiresAt: membership.botAccessExpiresAt,
          sendRouteFailureCount: membership.sendRouteFailureCount,
          sendRouteQuarantinedUntil: membership.sendRouteQuarantinedUntil,
          sendRouteLastFailureAt: membership.sendRouteLastFailureAt,
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
          sendRouteLastSuccessAt: membership.sendRouteLastSuccessAt,
          updatedAt: membership.updatedAt,
          chat: {
            routingState: ChatRoutingState.READY,
            entityType: membership.chat.entityType,
          },
        },
        data: {
          sendRouteFailureCount: 1,
          sendRouteQuarantinedUntil: applyAt,
        },
      });
      if (transitioned.count !== 1) {
        return {
          applied: false as const,
          wokenBroadcastCount: 0 as const,
          releasedDeliveryCount: 0 as const,
        };
      }

      const { wokenBroadcastCount, releasedDeliveryCount } =
        await releasePublicationRouteQuarantineBacklog(tx, membership.chatId, applyAt);

      await tx.auditLog.create({
        data: {
          chatId: membership.chatId,
          actorUserId,
          action: RECOVERY_AUDIT_ACTION,
          payload: {
            reason: 'operator_controlled_half_open_after_repeated_publication_disappearance',
            botId: membership.botId,
            applyAt: applyAt.toISOString(),
            previousHealth: {
              failureCount: membership.sendRouteFailureCount,
              quarantinedUntil: toIso(membership.sendRouteQuarantinedUntil),
              lastFailureAt: toIso(membership.sendRouteLastFailureAt),
              lastFailureCode: membership.sendRouteLastFailureCode,
              lastSuccessAt: toIso(membership.sendRouteLastSuccessAt),
            },
            nextHealth: {
              failureCount: 1,
              quarantinedUntil: applyAt.toISOString(),
              lastFailureAt: toIso(membership.sendRouteLastFailureAt),
              lastFailureCode: membership.sendRouteLastFailureCode,
              lastSuccessAt: toIso(membership.sendRouteLastSuccessAt),
            },
            persistedAccess: {
              state: membership.botAccessState,
              checkedAt: toIso(membership.botAccessCheckedAt),
              expiresAt: toIso(membership.botAccessExpiresAt),
              entityType: membership.chat.entityType,
              routingState: membership.chat.routingState,
            },
            wokenBroadcastCount,
            releasedDeliveryCount,
          },
        },
      });
      return {
        applied: true as const,
        wokenBroadcastCount,
        releasedDeliveryCount,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function runPublicationSendRouteRecovery(
  prisma: PrismaService,
  botRegistry: RecoveryBotRegistry,
  options: PublicationSendRouteRecoveryOptions,
  now: RecoveryClock = () => new Date(),
): Promise<PublicationSendRouteRecoverySummary> {
  const memberships = await prisma.chatBotMembership.findMany({
    where: {
      OR: options.routes.map((route) => ({ chatId: route.chatId, botId: route.botId })),
    },
    select: RECOVERY_MEMBERSHIP_SELECT,
  });
  const membershipsByRoute = new Map(
    memberships.map((membership) => [buildRouteKey(membership), membership]),
  );
  const actionableBotIds = new Set(botRegistry.getActionableBots().map((bot) => bot.id));
  const outcomes: PublicationSendRouteRecoveryOutcome[] = [];

  for (const route of options.routes) {
    const membership = membershipsByRoute.get(buildRouteKey(route));
    if (!membership) {
      outcomes.push({
        ...route,
        result: 'ineligible',
        reason: 'membership_missing',
        previousFailureCount: null,
        previousQuarantinedUntil: null,
        wokenBroadcastCount: 0,
        releasedDeliveryCount: 0,
      });
      continue;
    }

    const checkedAt = now();
    const ineligibleReason = resolveIneligibleReason(membership, actionableBotIds, checkedAt);
    const baseOutcome = {
      ...route,
      previousFailureCount: membership.sendRouteFailureCount,
      previousQuarantinedUntil: toIso(membership.sendRouteQuarantinedUntil),
    };
    if (ineligibleReason) {
      outcomes.push({
        ...baseOutcome,
        result: 'ineligible',
        reason: ineligibleReason,
        wokenBroadcastCount: 0,
        releasedDeliveryCount: 0,
      });
      continue;
    }
    if (!options.apply) {
      outcomes.push({
        ...baseOutcome,
        result: 'would_apply',
        reason: null,
        wokenBroadcastCount: 0,
        releasedDeliveryCount: 0,
      });
      continue;
    }

    try {
      const result = await applyControlledHalfOpenRecovery(
        prisma,
        membership,
        options.actorUserId!,
        checkedAt,
      );
      outcomes.push({
        ...baseOutcome,
        result: result.applied ? 'applied' : 'cas_conflict',
        reason: null,
        wokenBroadcastCount: result.wokenBroadcastCount,
        releasedDeliveryCount: result.releasedDeliveryCount,
      });
    } catch (error: unknown) {
      outcomes.push({
        ...baseOutcome,
        result: 'error',
        reason: null,
        wokenBroadcastCount: 0,
        releasedDeliveryCount: 0,
        error: normalizeError(error),
      });
    }
  }

  return {
    apply: options.apply,
    requested: options.routes.length,
    wouldApply: outcomes.filter((outcome) => outcome.result === 'would_apply').length,
    applied: outcomes.filter((outcome) => outcome.result === 'applied').length,
    ineligible: outcomes.filter((outcome) => outcome.result === 'ineligible').length,
    casConflicts: outcomes.filter((outcome) => outcome.result === 'cas_conflict').length,
    errors: outcomes.filter((outcome) => outcome.result === 'error').length,
    outcomes,
  };
}

function printSummary(summary: PublicationSendRouteRecoverySummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Publication send-route recovery ${summary.apply ? 'apply' : 'dry-run'}: ` +
      `${summary.applied} applied, ${summary.wouldApply} eligible, ` +
      `${summary.ineligible} ineligible, ${summary.casConflicts} CAS conflicts, ` +
      `${summary.errors} errors.\n` +
      summary.outcomes
        .map(
          (outcome) =>
            `${outcome.chatId}/${outcome.botId}: ${outcome.result}` +
            (outcome.reason ? ` (${outcome.reason})` : '') +
            (outcome.error ? ` - ${outcome.error}` : ''),
        )
        .join('\n') +
      '\n',
  );
}

async function main(): Promise<void> {
  const options = readPublicationSendRouteRecoveryOptions(process.argv.slice(2));
  const [{ PublicationSendRouteRecoveryModule }, { PrismaService }, { MaxBotRegistryService }] =
    await Promise.all([
      import('./publication-send-route-recovery.module'),
      import('../prisma/prisma.service'),
      import('../max/max-bot-registry.service'),
    ]);
  const app = await NestFactory.createApplicationContext(PublicationSendRouteRecoveryModule, {
    logger: false,
  });
  try {
    const summary = await runPublicationSendRouteRecovery(
      app.get(PrismaService),
      app.get(MaxBotRegistryService),
      options,
    );
    printSummary(summary, options.json);
    if (
      summary.casConflicts > 0 ||
      summary.errors > 0 ||
      (options.apply && summary.ineligible > 0)
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
