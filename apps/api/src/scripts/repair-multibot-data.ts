import { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { Queue, type ConnectionOptions } from 'bullmq';
import { resolve } from 'node:path';
import { validateEnv } from '../config/env.schema';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import {
  ChatBotAccessState,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
  ChatRoutingState,
  createPrismaClient,
  Prisma,
  type PrismaClient,
} from '../prisma/prisma-client';
import {
  isFreshMembershipAccessSnapshot,
  membershipExplicitlyLacksAccess,
  normalizeMembershipAccessSnapshot,
} from '../max/max-bot-access-policy.util';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE,
  type MaxChatAdminRosterSyncJob,
} from '../max/max-chat-admin-roster-sync.queue';

const DEFAULT_ROUTE_LIMIT = 100;
const DEFAULT_PROBE_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_SAMPLE_LIMIT = 50;
const DEFAULT_ENQUEUE_CONCURRENCY = 4;
const MAX_ENQUEUE_CONCURRENCY = 16;
const ROSTER_SYNC_JOB_ATTEMPTS = 6;
const ROSTER_SYNC_JOB_PRIORITY = 2;
const ROSTER_SYNC_JOB_BACKOFF_MS = 3_000;

export type MultiBotDataRepairOptions = {
  applyRoutes: boolean;
  applyNoEligible: boolean;
  enqueueProbes: boolean;
  json: boolean;
  help: boolean;
  routeLimit: number;
  noEligibleLimit: number;
  probeLimit: number;
  pageSize: number;
  sampleLimit: number;
  enqueueConcurrency: number;
};

export type MultiBotRepairRuntimeBot = {
  id: string;
  executable: boolean;
  probeable: boolean;
};

export type MultiBotRepairMembership = {
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt?: Date | null;
  botAccessExpiresAt?: Date | null;
  lastSeenAt?: Date | null;
  lastWebhookAt?: Date | null;
  permissionsSnapshot: unknown;
};

export type MultiBotRepairEntity = {
  id: string;
  entityType: ChatEntityType;
  primaryBotId: string | null;
  botId: string | null;
  memberships: readonly MultiBotRepairMembership[];
};

export type MultiBotPrimaryIssue =
  | 'missing_primary'
  | 'unknown_runtime_bot'
  | 'non_executable_runtime_bot'
  | 'membership_missing'
  | 'membership_removed'
  | 'membership_access_denied'
  | 'membership_access_snapshot_denied';

export type MultiBotAccessContradictionReason =
  | 'bot_access_denied'
  | 'bot_access_lost'
  | 'permissions_snapshot_denied';

export type MultiBotAccessContradiction = {
  botId: string;
  reasons: MultiBotAccessContradictionReason[];
  knownRuntimeBot: boolean;
  probeEligible: boolean;
};

export type MultiBotEntityRepairPlan = {
  entityId: string;
  entityType: ChatEntityType;
  currentPrimaryBotId: string | null;
  primaryIssue: MultiBotPrimaryIssue | null;
  eligibleBotIds: string[];
  proposedPrimaryBotId: string | null;
  noEligibleBot: boolean;
  verificationNeededBotIds: string[];
  accessContradictions: MultiBotAccessContradiction[];
};

type RouteRepairCandidate = {
  entityId: string;
  proposedPrimaryBotId: string;
};

export type MultiBotAccessProbeCandidate = {
  entityId: string;
  entityType: ChatEntityType;
  botIds: string[];
  lastActivityAtMs: number;
};

type NoEligibleCandidate = {
  entityId: string;
};

type RouteRepairSample = {
  entityId: string;
  entityType: 'chat' | 'channel';
  currentPrimaryBotId: string | null;
  proposedPrimaryBotId: string;
  primaryIssue: MultiBotPrimaryIssue;
  eligibleBotIds: string[];
};

type NoEligibleSample = {
  entityId: string;
  entityType: 'chat' | 'channel';
  currentPrimaryBotId: string | null;
  primaryIssue: MultiBotPrimaryIssue;
};

type ContradictionSample = {
  entityId: string;
  entityType: 'chat' | 'channel';
  memberships: MultiBotAccessContradiction[];
};

export type MultiBotDataRepairSummary = {
  generatedAt: string;
  mode: {
    dryRun: boolean;
    applyRoutes: boolean;
    applyNoEligible: boolean;
    enqueueProbes: boolean;
  };
  limits: {
    routeLimit: number;
    noEligibleLimit: number;
    probeLimit: number;
    pageSize: number;
    sampleLimit: number;
    enqueueConcurrency: number;
  };
  runtimeBots: {
    known: number;
    executable: number;
    probeable: number;
  };
  audit: {
    managedEntities: number;
    chats: number;
    channels: number;
    memberships: number;
    privateDirectSkipped: number;
  };
  routes: {
    invalidPrimaryEntities: number;
    repairableEntities: number;
    selectedForApply: number;
    applied: number;
    staleOrChanged: number;
    failed: number;
    failureSamples: Array<{ entityId: string; errorType: string }>;
    samples: RouteRepairSample[];
  };
  accessContradictions: {
    memberships: number;
    entities: number;
    probeableMemberships: number;
    nonProbeableMemberships: number;
    verificationNeededMemberships: number;
    candidateJobs: number;
    selectedForEnqueue: number;
    enqueued: number;
    coalesced: number;
    inFlight: number;
    failed: number;
    failureSamples: Array<{ entityId: string; errorType: string }>;
    samples: ContradictionSample[];
  };
  noEligible: {
    entities: number;
    selectedForApply: number;
    applied: number;
    staleOrChanged: number;
    failed: number;
    failureSamples: Array<{ entityId: string; errorType: string }>;
    samples: NoEligibleSample[];
  };
};

export function parseMultiBotDataRepairOptions(argv: readonly string[]): MultiBotDataRepairOptions {
  assertKnownArguments(argv);
  const pageSize = readPositiveIntOption(argv, '--page-size') ?? DEFAULT_PAGE_SIZE;
  const enqueueConcurrency =
    readPositiveIntOption(argv, '--enqueue-concurrency') ?? DEFAULT_ENQUEUE_CONCURRENCY;
  if (pageSize > MAX_PAGE_SIZE) {
    throw new Error(`--page-size must be at most ${MAX_PAGE_SIZE}`);
  }
  if (enqueueConcurrency > MAX_ENQUEUE_CONCURRENCY) {
    throw new Error(`--enqueue-concurrency must be at most ${MAX_ENQUEUE_CONCURRENCY}`);
  }

  return {
    applyRoutes: argv.includes('--apply-routes'),
    applyNoEligible: argv.includes('--apply-no-eligible'),
    enqueueProbes: argv.includes('--enqueue-probes'),
    json: argv.includes('--json'),
    help: argv.includes('--help'),
    routeLimit: readPositiveIntOption(argv, '--route-limit') ?? DEFAULT_ROUTE_LIMIT,
    noEligibleLimit: readPositiveIntOption(argv, '--no-eligible-limit') ?? DEFAULT_ROUTE_LIMIT,
    probeLimit: readPositiveIntOption(argv, '--probe-limit') ?? DEFAULT_PROBE_LIMIT,
    pageSize,
    sampleLimit: readNonNegativeIntOption(argv, '--sample-limit') ?? DEFAULT_SAMPLE_LIMIT,
    enqueueConcurrency,
  };
}

export function planMultiBotEntityRepair(
  entity: MultiBotRepairEntity,
  runtimeBots: readonly MultiBotRepairRuntimeBot[],
): MultiBotEntityRepairPlan {
  const runtimeById = new Map(
    runtimeBots.map((bot, index) => [normalizeId(bot.id), { ...bot, index }] as const),
  );
  runtimeById.delete('');
  const memberships = entity.memberships.map((membership) => ({
    ...membership,
    botId: normalizeId(membership.botId),
  }));
  const primaryBotId = normalizeId(entity.primaryBotId) || null;
  const legacyBotId = normalizeId(entity.botId) || null;
  const primaryIssue = resolvePrimaryIssue(primaryBotId, memberships, runtimeById);
  const eligibleMemberships = memberships
    .filter((membership) => isConfirmedRouteEligibleMembership(membership, runtimeById))
    .sort(
      (left, right) =>
        (runtimeById.get(left.botId)?.index ?? Number.MAX_SAFE_INTEGER) -
          (runtimeById.get(right.botId)?.index ?? Number.MAX_SAFE_INTEGER) ||
        left.botId.localeCompare(right.botId),
    );
  const eligibleBotIds = Array.from(
    new Set(eligibleMemberships.map((membership) => membership.botId)),
  );
  const potentialBotIds = Array.from(
    new Set(
      memberships
        .filter((membership) => isPotentialRouteEligibleMembership(membership, runtimeById))
        .map((membership) => membership.botId),
    ),
  );
  const proposedPrimaryBotId =
    primaryIssue === null
      ? null
      : (eligibleMemberships.find((membership) => membership.role === ChatBotMembershipRole.PRIMARY)
          ?.botId ??
        (legacyBotId && eligibleBotIds.includes(legacyBotId) ? legacyBotId : null) ??
        eligibleBotIds[0] ??
        null);
  const accessContradictions = memberships
    .filter((membership) => membership.status === ChatBotMembershipStatus.ACTIVE)
    .map((membership) => {
      const reasons = resolveAccessContradictionReasons(membership);
      const runtimeBot = runtimeById.get(membership.botId);
      return {
        botId: membership.botId,
        reasons,
        knownRuntimeBot: Boolean(runtimeBot),
        probeEligible: runtimeBot?.probeable === true,
      };
    })
    .filter((membership) => membership.botId.length > 0 && membership.reasons.length > 0);

  return {
    entityId: entity.id,
    entityType: entity.entityType,
    currentPrimaryBotId: primaryBotId,
    primaryIssue,
    eligibleBotIds,
    proposedPrimaryBotId,
    noEligibleBot: primaryIssue !== null && potentialBotIds.length === 0,
    verificationNeededBotIds:
      primaryIssue !== null && eligibleBotIds.length === 0
        ? potentialBotIds.filter((botId) => runtimeById.get(botId)?.probeable === true)
        : [],
    accessContradictions,
  };
}

export function selectRecentAccessProbeCandidates(
  candidates: readonly MultiBotAccessProbeCandidate[],
  limit: number,
): MultiBotAccessProbeCandidate[] {
  return [...candidates]
    .sort(
      (left, right) =>
        right.lastActivityAtMs - left.lastActivityAtMs ||
        left.entityId.localeCompare(right.entityId),
    )
    .slice(0, Math.max(0, limit));
}

function resolvePrimaryIssue(
  primaryBotId: string | null,
  memberships: readonly MultiBotRepairMembership[],
  runtimeById: ReadonlyMap<string, MultiBotRepairRuntimeBot>,
): MultiBotPrimaryIssue | null {
  if (!primaryBotId) {
    return 'missing_primary';
  }
  const runtimeBot = runtimeById.get(primaryBotId);
  if (!runtimeBot) {
    return 'unknown_runtime_bot';
  }
  if (!runtimeBot.executable) {
    return 'non_executable_runtime_bot';
  }
  const membership = memberships.find((candidate) => candidate.botId === primaryBotId);
  if (!membership) {
    return 'membership_missing';
  }
  if (membership.status !== ChatBotMembershipStatus.ACTIVE) {
    return 'membership_removed';
  }
  if (
    membership.botAccessState === ChatBotAccessState.DENIED ||
    membership.botAccessState === ChatBotAccessState.LOST
  ) {
    return 'membership_access_denied';
  }
  if (membershipExplicitlyLacksAccess(membership.permissionsSnapshot)) {
    return 'membership_access_snapshot_denied';
  }
  return null;
}

function isConfirmedRouteEligibleMembership(
  membership: MultiBotRepairMembership,
  runtimeById: ReadonlyMap<string, MultiBotRepairRuntimeBot>,
): boolean {
  if (!isPotentialRouteEligibleMembership(membership, runtimeById)) {
    return false;
  }
  if (
    membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
    membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
  ) {
    return false;
  }

  const expiresAtMs = membership.botAccessExpiresAt?.getTime() ?? Number.NaN;
  if (Number.isFinite(expiresAtMs)) {
    return expiresAtMs > Date.now();
  }
  return isFreshMembershipAccessSnapshot(
    normalizeMembershipAccessSnapshot(membership.permissionsSnapshot),
  );
}

function isPotentialRouteEligibleMembership(
  membership: MultiBotRepairMembership,
  runtimeById: ReadonlyMap<string, MultiBotRepairRuntimeBot>,
): boolean {
  if (!membership.botId || membership.status !== ChatBotMembershipStatus.ACTIVE) {
    return false;
  }
  const runtimeBot = runtimeById.get(membership.botId);
  return Boolean(
    runtimeBot?.executable === true &&
    membership.botAccessState !== ChatBotAccessState.DENIED &&
    membership.botAccessState !== ChatBotAccessState.LOST &&
    !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
  );
}

function resolveAccessContradictionReasons(
  membership: MultiBotRepairMembership,
): MultiBotAccessContradictionReason[] {
  const reasons: MultiBotAccessContradictionReason[] = [];
  if (membership.botAccessState === ChatBotAccessState.DENIED) {
    reasons.push('bot_access_denied');
  }
  if (membership.botAccessState === ChatBotAccessState.LOST) {
    reasons.push('bot_access_lost');
  }
  if (membershipExplicitlyLacksAccess(membership.permissionsSnapshot)) {
    reasons.push('permissions_snapshot_denied');
  }
  return reasons;
}

async function runMultiBotDataRepair(
  prisma: PrismaClient,
  runtimeBots: readonly MultiBotRepairRuntimeBot[],
  options: MultiBotDataRepairOptions,
  redisUrl: string,
): Promise<MultiBotDataRepairSummary> {
  const summary = createEmptySummary(runtimeBots, options);
  const routeCandidates: RouteRepairCandidate[] = [];
  const noEligibleCandidates: NoEligibleCandidate[] = [];
  const probeCandidates: MultiBotAccessProbeCandidate[] = [];
  let cursor: string | undefined;

  while (true) {
    const rows = await prisma.chat.findMany({
      where: {
        OR: [
          { catalogKind: ChatCatalogKind.MANAGED },
          { catalogKind: ChatCatalogKind.UNKNOWN, entityType: ChatEntityType.CHANNEL },
        ],
      },
      orderBy: { id: 'asc' },
      take: options.pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        entityType: true,
        primaryBotId: true,
        botId: true,
        routingState: true,
        botMemberships: {
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
          select: {
            botId: true,
            role: true,
            status: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessExpiresAt: true,
            lastSeenAt: true,
            lastWebhookAt: true,
            permissionsSnapshot: true,
          },
        },
      },
    });
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      if (row.entityType !== ChatEntityType.CHANNEL && isPrivateDirectChatId(row.id)) {
        summary.audit.privateDirectSkipped += 1;
        continue;
      }
      summary.audit.managedEntities += 1;
      summary.audit.memberships += row.botMemberships.length;
      if (row.entityType === ChatEntityType.CHANNEL) {
        summary.audit.channels += 1;
      } else {
        summary.audit.chats += 1;
      }

      const plan = planMultiBotEntityRepair(
        {
          id: row.id,
          entityType: row.entityType,
          primaryBotId: row.primaryBotId,
          botId: row.botId,
          memberships: row.botMemberships,
        },
        runtimeBots,
      );
      if (plan.primaryIssue !== null) {
        summary.routes.invalidPrimaryEntities += 1;
      }
      if (plan.proposedPrimaryBotId && plan.primaryIssue) {
        summary.routes.repairableEntities += 1;
        if (summary.routes.samples.length < options.sampleLimit) {
          summary.routes.samples.push({
            entityId: row.id,
            entityType: toEntityTypeName(row.entityType),
            currentPrimaryBotId: plan.currentPrimaryBotId,
            proposedPrimaryBotId: plan.proposedPrimaryBotId,
            primaryIssue: plan.primaryIssue,
            eligibleBotIds: plan.eligibleBotIds,
          });
        }
        if (routeCandidates.length < options.routeLimit) {
          routeCandidates.push({
            entityId: row.id,
            proposedPrimaryBotId: plan.proposedPrimaryBotId,
          });
        }
      }
      if (plan.noEligibleBot && plan.primaryIssue) {
        summary.noEligible.entities += 1;
        if (summary.noEligible.samples.length < options.sampleLimit) {
          summary.noEligible.samples.push({
            entityId: row.id,
            entityType: toEntityTypeName(row.entityType),
            currentPrimaryBotId: plan.currentPrimaryBotId,
            primaryIssue: plan.primaryIssue,
          });
        }
        if (
          row.routingState !== ChatRoutingState.NO_ELIGIBLE_BOT &&
          noEligibleCandidates.length < options.noEligibleLimit
        ) {
          noEligibleCandidates.push({ entityId: row.id });
        }
      }
      if (plan.accessContradictions.length > 0) {
        summary.accessContradictions.entities += 1;
        summary.accessContradictions.memberships += plan.accessContradictions.length;
        const probeableMemberships = plan.accessContradictions.filter(
          (membership) => membership.probeEligible,
        ).length;
        summary.accessContradictions.probeableMemberships += probeableMemberships;
        summary.accessContradictions.nonProbeableMemberships +=
          plan.accessContradictions.length - probeableMemberships;
        if (summary.accessContradictions.samples.length < options.sampleLimit) {
          summary.accessContradictions.samples.push({
            entityId: row.id,
            entityType: toEntityTypeName(row.entityType),
            memberships: plan.accessContradictions,
          });
        }
      }
      summary.accessContradictions.verificationNeededMemberships +=
        plan.verificationNeededBotIds.length;
      const targetedProbeBotIds = Array.from(
        new Set([
          ...plan.accessContradictions
            .filter((membership) => membership.probeEligible)
            .map((membership) => membership.botId),
          ...plan.verificationNeededBotIds,
        ]),
      );
      if (targetedProbeBotIds.length > 0) {
        summary.accessContradictions.candidateJobs += 1;
        probeCandidates.push({
          entityId: row.id,
          entityType: row.entityType,
          botIds: targetedProbeBotIds,
          lastActivityAtMs: resolveMembershipActivityAtMs(row.botMemberships),
        });
      }
    }

    cursor = rows.at(-1)?.id;
    if (rows.length < options.pageSize || !cursor) {
      break;
    }
  }

  summary.routes.selectedForApply = routeCandidates.length;
  summary.noEligible.selectedForApply = noEligibleCandidates.length;
  const selectedProbeCandidates = selectRecentAccessProbeCandidates(
    probeCandidates,
    options.probeLimit,
  );
  summary.accessContradictions.selectedForEnqueue = selectedProbeCandidates.length;

  if (options.applyRoutes) {
    for (const candidate of routeCandidates) {
      try {
        const outcome = await applyRouteRepair(prisma, candidate, runtimeBots);
        if (outcome === 'applied') {
          summary.routes.applied += 1;
        } else {
          summary.routes.staleOrChanged += 1;
        }
      } catch (error: unknown) {
        summary.routes.failed += 1;
        if (summary.routes.failureSamples.length < options.sampleLimit) {
          summary.routes.failureSamples.push({
            entityId: candidate.entityId,
            errorType: readErrorType(error),
          });
        }
      }
    }
  }

  if (options.applyNoEligible) {
    for (const candidate of noEligibleCandidates) {
      try {
        const outcome = await applyNoEligibleRoutingState(prisma, candidate, runtimeBots);
        if (outcome === 'applied') {
          summary.noEligible.applied += 1;
        } else {
          summary.noEligible.staleOrChanged += 1;
        }
      } catch (error: unknown) {
        summary.noEligible.failed += 1;
        if (summary.noEligible.failureSamples.length < options.sampleLimit) {
          summary.noEligible.failureSamples.push({
            entityId: candidate.entityId,
            errorType: readErrorType(error),
          });
        }
      }
    }
  }

  if (options.enqueueProbes && selectedProbeCandidates.length > 0) {
    const connection: ConnectionOptions = { url: redisUrl, maxRetriesPerRequest: null };
    const queue = new Queue<MaxChatAdminRosterSyncJob>(MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE, {
      connection,
    });
    try {
      const outcomes = await mapWithConcurrency(
        selectedProbeCandidates,
        options.enqueueConcurrency,
        async (candidate) => {
          try {
            return await enqueueTargetedAccessProbe(queue, candidate);
          } catch (error: unknown) {
            return { outcome: 'failed' as const, errorType: readErrorType(error) };
          }
        },
      );
      for (let index = 0; index < outcomes.length; index += 1) {
        const outcome = outcomes[index]!;
        const candidate = selectedProbeCandidates[index]!;
        if (outcome.outcome === 'failed') {
          summary.accessContradictions.failed += 1;
          if (summary.accessContradictions.failureSamples.length < options.sampleLimit) {
            summary.accessContradictions.failureSamples.push({
              entityId: candidate.entityId,
              errorType: outcome.errorType,
            });
          }
        } else {
          summary.accessContradictions[outcome.outcome] += 1;
        }
      }
    } finally {
      await queue.close().catch(() => undefined);
    }
  }

  return summary;
}

function resolveMembershipActivityAtMs(
  memberships: readonly Pick<MultiBotRepairMembership, 'lastSeenAt' | 'lastWebhookAt'>[],
): number {
  return memberships.reduce((latestAtMs, membership) => {
    const webhookAtMs = membership.lastWebhookAt?.getTime() ?? Number.NaN;
    const seenAtMs = membership.lastSeenAt?.getTime() ?? Number.NaN;
    return Math.max(
      latestAtMs,
      Number.isFinite(webhookAtMs) ? webhookAtMs : 0,
      Number.isFinite(seenAtMs) ? seenAtMs : 0,
    );
  }, 0);
}

async function applyRouteRepair(
  prisma: PrismaClient,
  candidate: RouteRepairCandidate,
  runtimeBots: readonly MultiBotRepairRuntimeBot[],
): Promise<'applied' | 'staleOrChanged'> {
  return prisma.$transaction(
    async (tx) => {
      const current = await tx.chat.findUnique({
        where: { id: candidate.entityId },
        select: {
          id: true,
          entityType: true,
          primaryBotId: true,
          botId: true,
          botMemberships: {
            orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
            select: {
              botId: true,
              role: true,
              status: true,
              botAccessState: true,
              botAccessCheckedAt: true,
              botAccessExpiresAt: true,
              permissionsSnapshot: true,
            },
          },
        },
      });
      if (!current) {
        return 'staleOrChanged';
      }
      const freshPlan = planMultiBotEntityRepair(
        {
          id: current.id,
          entityType: current.entityType,
          primaryBotId: current.primaryBotId,
          botId: current.botId,
          memberships: current.botMemberships,
        },
        runtimeBots,
      );
      if (
        freshPlan.primaryIssue === null ||
        freshPlan.proposedPrimaryBotId !== candidate.proposedPrimaryBotId
      ) {
        return 'staleOrChanged';
      }

      await tx.chatBotMembership.updateMany({
        where: {
          chatId: current.id,
          status: ChatBotMembershipStatus.ACTIVE,
          role: ChatBotMembershipRole.PRIMARY,
        },
        data: { role: ChatBotMembershipRole.STANDBY },
      });
      const promoted = await tx.chatBotMembership.updateMany({
        where: {
          chatId: current.id,
          botId: candidate.proposedPrimaryBotId,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        data: { role: ChatBotMembershipRole.PRIMARY },
      });
      if (promoted.count !== 1) {
        throw new Error('Route repair candidate membership changed during apply');
      }
      await tx.chat.update({
        where: { id: current.id },
        data: {
          primaryBotId: candidate.proposedPrimaryBotId,
          botId: candidate.proposedPrimaryBotId,
          routingState: ChatRoutingState.READY,
          routingVersion: { increment: 1 },
        },
      });
      return 'applied';
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function applyNoEligibleRoutingState(
  prisma: PrismaClient,
  candidate: NoEligibleCandidate,
  runtimeBots: readonly MultiBotRepairRuntimeBot[],
): Promise<'applied' | 'staleOrChanged'> {
  return prisma.$transaction(
    async (tx) => {
      const current = await tx.chat.findUnique({
        where: { id: candidate.entityId },
        select: {
          id: true,
          entityType: true,
          primaryBotId: true,
          botId: true,
          routingState: true,
          botMemberships: {
            orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
            select: {
              botId: true,
              role: true,
              status: true,
              botAccessState: true,
              botAccessCheckedAt: true,
              botAccessExpiresAt: true,
              permissionsSnapshot: true,
            },
          },
        },
      });
      if (!current || current.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
        return 'staleOrChanged';
      }

      const freshPlan = planMultiBotEntityRepair(
        {
          id: current.id,
          entityType: current.entityType,
          primaryBotId: current.primaryBotId,
          botId: current.botId,
          memberships: current.botMemberships,
        },
        runtimeBots,
      );
      if (!freshPlan.noEligibleBot) {
        return 'staleOrChanged';
      }

      const updated = await tx.chat.updateMany({
        where: {
          id: current.id,
          routingState: { not: ChatRoutingState.NO_ELIGIBLE_BOT },
        },
        data: {
          primaryBotId: null,
          botId: null,
          routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
          routingVersion: { increment: 1 },
        },
      });
      return updated.count === 1 ? 'applied' : 'staleOrChanged';
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

type ProbeEnqueueResult =
  | { outcome: 'enqueued' | 'coalesced' | 'inFlight' }
  | { outcome: 'failed'; errorType: string };

async function enqueueTargetedAccessProbe(
  queue: Queue<MaxChatAdminRosterSyncJob>,
  candidate: MultiBotAccessProbeCandidate,
): Promise<ProbeEnqueueResult> {
  const jobId = buildRosterSyncJobId(candidate.entityId);
  const desiredBotIds = Array.from(new Set(candidate.botIds.map(normalizeId).filter(Boolean)));
  if (desiredBotIds.length === 0) {
    return { outcome: 'coalesced' };
  }
  let desiredData = buildRosterSyncJob(candidate, desiredBotIds);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    const existingBotIds = Array.isArray(existing.data.botIds)
      ? existing.data.botIds.map(normalizeId).filter(Boolean)
      : [];
    const mergedBotIds = Array.from(new Set([...existingBotIds, ...desiredBotIds]));
    const alreadyCoversDesired = desiredBotIds.every((botId) => existingBotIds.includes(botId));
    if (state === 'active') {
      return { outcome: 'inFlight' };
    }
    if (alreadyCoversDesired && state !== 'failed' && state !== 'completed') {
      return { outcome: 'coalesced' };
    }
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      desiredData = buildRosterSyncJob(candidate, mergedBotIds);
      await existing.remove();
    } else if (state === 'failed' || state === 'completed') {
      await existing.remove();
    } else {
      return { outcome: 'coalesced' };
    }
  }

  try {
    await queue.add('sync-chat-admin-roster', desiredData, {
      jobId,
      attempts: ROSTER_SYNC_JOB_ATTEMPTS,
      priority: ROSTER_SYNC_JOB_PRIORITY,
      removeOnComplete: true,
      removeOnFail: false,
      backoff: { type: 'fixed', delay: ROSTER_SYNC_JOB_BACKOFF_MS },
    });
    return { outcome: 'enqueued' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error);
    if (message.includes('job') && message.includes('exists')) {
      return { outcome: 'coalesced' };
    }
    throw error;
  }
}

function buildRosterSyncJob(
  candidate: MultiBotAccessProbeCandidate,
  botIds: string[],
): MaxChatAdminRosterSyncJob {
  return {
    chatId: candidate.entityId,
    botIds,
    entityType: toEntityTypeName(candidate.entityType),
    source: 'admin_access_validation',
  };
}

function buildRosterSyncJobId(entityId: string): string {
  return `chat-admin-roster-sync__${entityId}`;
}

function createEmptySummary(
  runtimeBots: readonly MultiBotRepairRuntimeBot[],
  options: MultiBotDataRepairOptions,
): MultiBotDataRepairSummary {
  return {
    generatedAt: new Date().toISOString(),
    mode: {
      dryRun: !options.applyRoutes && !options.applyNoEligible && !options.enqueueProbes,
      applyRoutes: options.applyRoutes,
      applyNoEligible: options.applyNoEligible,
      enqueueProbes: options.enqueueProbes,
    },
    limits: {
      routeLimit: options.routeLimit,
      noEligibleLimit: options.noEligibleLimit,
      probeLimit: options.probeLimit,
      pageSize: options.pageSize,
      sampleLimit: options.sampleLimit,
      enqueueConcurrency: options.enqueueConcurrency,
    },
    runtimeBots: {
      known: runtimeBots.length,
      executable: runtimeBots.filter((bot) => bot.executable).length,
      probeable: runtimeBots.filter((bot) => bot.probeable).length,
    },
    audit: {
      managedEntities: 0,
      chats: 0,
      channels: 0,
      memberships: 0,
      privateDirectSkipped: 0,
    },
    routes: {
      invalidPrimaryEntities: 0,
      repairableEntities: 0,
      selectedForApply: 0,
      applied: 0,
      staleOrChanged: 0,
      failed: 0,
      failureSamples: [],
      samples: [],
    },
    accessContradictions: {
      memberships: 0,
      entities: 0,
      probeableMemberships: 0,
      nonProbeableMemberships: 0,
      verificationNeededMemberships: 0,
      candidateJobs: 0,
      selectedForEnqueue: 0,
      enqueued: 0,
      coalesced: 0,
      inFlight: 0,
      failed: 0,
      failureSamples: [],
      samples: [],
    },
    noEligible: {
      entities: 0,
      selectedForApply: 0,
      applied: 0,
      staleOrChanged: 0,
      failed: 0,
      failureSamples: [],
      samples: [],
    },
  };
}

function resolveRuntimeBots(env: Record<string, unknown>): {
  bots: MultiBotRepairRuntimeBot[];
  redisUrl: string;
} {
  const validated = validateEnv(env);
  const registry = new MaxBotRegistryService(
    new ConfigService(validated as unknown as Record<string, unknown>),
  );
  const executableBotIds = new Set(registry.getActionableBots().map((bot) => bot.id));
  const probeableBotIds = new Set(registry.getDiscoveryBots().map((bot) => bot.id));
  return {
    bots: registry.getAllBots().map((bot) => ({
      id: bot.id,
      executable: executableBotIds.has(bot.id),
      probeable: probeableBotIds.has(bot.id),
    })),
    redisUrl: validated.REDIS_URL,
  };
}

function renderTextSummary(summary: MultiBotDataRepairSummary): string {
  const mode = summary.mode.dryRun
    ? 'DRY RUN'
    : [
        summary.mode.applyRoutes ? 'APPLY ROUTES' : null,
        summary.mode.applyNoEligible ? 'APPLY NO ELIGIBLE' : null,
        summary.mode.enqueueProbes ? 'ENQUEUE PROBES' : null,
      ]
        .filter(Boolean)
        .join(' + ');
  return [
    `Multi-bot data repair: ${mode}`,
    `Managed entities: ${summary.audit.managedEntities} (${summary.audit.chats} chats, ${summary.audit.channels} channels), memberships=${summary.audit.memberships}, private-direct skipped=${summary.audit.privateDirectSkipped}`,
    `Routes: invalid=${summary.routes.invalidPrimaryEntities}, repairable=${summary.routes.repairableEntities}, selected=${summary.routes.selectedForApply}, applied=${summary.routes.applied}, stale=${summary.routes.staleOrChanged}, failed=${summary.routes.failed}`,
    `Access contradictions: memberships=${summary.accessContradictions.memberships}, entities=${summary.accessContradictions.entities}, probeable=${summary.accessContradictions.probeableMemberships}, jobs=${summary.accessContradictions.candidateJobs}, selected=${summary.accessContradictions.selectedForEnqueue}, enqueued=${summary.accessContradictions.enqueued}, coalesced=${summary.accessContradictions.coalesced}, in-flight=${summary.accessContradictions.inFlight}, failed=${summary.accessContradictions.failed}`,
    `No eligible bot: ${summary.noEligible.entities}, selected=${summary.noEligible.selectedForApply}, applied=${summary.noEligible.applied}, stale=${summary.noEligible.staleOrChanged}, failed=${summary.noEligible.failed}`,
    summary.mode.dryRun
      ? 'No routes or routing states were changed and no probes were enqueued. Use an explicit apply/enqueue flag.'
      : 'Route, no-eligible state, and probe operations were limited independently.',
  ].join('\n');
}

function renderHelp(): string {
  return [
    'Usage: npm run multi-bot:repair-data --workspace @maxim/api -- [options]',
    '',
    'Default mode is a read-only audit.',
    '  --apply-routes             Apply revalidated primary route repairs.',
    '  --apply-no-eligible        Persist NO_ELIGIBLE_BOT after serializable revalidation.',
    '  --enqueue-probes           Enqueue read-only targeted roster/access probes.',
    `  --route-limit <n>          Maximum route writes per run (default ${DEFAULT_ROUTE_LIMIT}).`,
    `  --no-eligible-limit <n>    Maximum NO_ELIGIBLE_BOT writes per run (default ${DEFAULT_ROUTE_LIMIT}).`,
    `  --probe-limit <n>          Maximum probe jobs per run (default ${DEFAULT_PROBE_LIMIT}).`,
    `  --page-size <n>            Database page size, max ${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}).`,
    `  --sample-limit <n>         Maximum samples per report section (default ${DEFAULT_SAMPLE_LIMIT}).`,
    `  --enqueue-concurrency <n>  Redis enqueue concurrency, max ${MAX_ENQUEUE_CONCURRENCY} (default ${DEFAULT_ENQUEUE_CONCURRENCY}).`,
    '  --json                     Print the structured summary without secrets.',
    '  --help                     Print this help.',
  ].join('\n');
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function assertKnownArguments(argv: readonly string[]): void {
  const booleanOptions = new Set([
    '--apply-routes',
    '--apply-no-eligible',
    '--enqueue-probes',
    '--json',
    '--help',
  ]);
  const valueOptions = new Set([
    '--route-limit',
    '--no-eligible-limit',
    '--probe-limit',
    '--page-size',
    '--sample-limit',
    '--enqueue-concurrency',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (booleanOptions.has(argument)) {
      continue;
    }
    if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
}

function readPositiveIntOption(argv: readonly string[], name: string): number | undefined {
  const value = readOptionValue(argv, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer`);
  }
  return parsed;
}

function readNonNegativeIntOption(argv: readonly string[], name: string): number | undefined {
  const value = readOptionValue(argv, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return parsed;
}

function readOptionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function normalizeId(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toEntityTypeName(entityType: ChatEntityType): 'chat' | 'channel' {
  return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
}

function readErrorType(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name.trim() : 'UnknownError';
}

async function main(): Promise<void> {
  const options = parseMultiBotDataRepairOptions(process.argv.slice(2));
  if (options.help) {
    console.log(renderHelp());
    return;
  }
  loadEnv({ quiet: true });
  loadEnv({ path: resolve(process.cwd(), '.env'), override: false, quiet: true });
  const runtime = resolveRuntimeBots(process.env);
  const prisma = createPrismaClient();
  try {
    const summary = await runMultiBotDataRepair(prisma, runtime.bots, options, runtime.redisUrl);
    console.log(options.json ? JSON.stringify(summary, null, 2) : renderTextSummary(summary));
    if (
      summary.routes.failed > 0 ||
      summary.accessContradictions.failed > 0 ||
      summary.noEligible.failed > 0
    ) {
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
