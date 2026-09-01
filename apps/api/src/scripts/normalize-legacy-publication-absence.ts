import { NestFactory } from '@nestjs/core';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import {
  ChatBotMembershipStatus,
  ManagedBroadcastDeliveryStatus,
  Prisma,
  PublicationOccurrenceStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { isLegacyAutomatedAbsenceFailure } from '../admin/publication-legacy-automated-absence';
import { releasePublicationRouteQuarantineBacklog } from '../admin/publication-route-quarantine-backlog';

const MAX_DELIVERY_IDS = 20;
const MAX_ID_LENGTH = 256;
const NORMALIZATION_AUDIT_ACTION = 'PUBLICATION_LEGACY_ABSENCE_NORMALIZED';
const NORMALIZATION_REASON = 'legacy_post_send_exact_absence_fail_closed';

const DELIVERY_SELECT = {
  id: true,
  broadcastId: true,
  occurrenceIndex: true,
  targetChatId: true,
  botId: true,
  status: true,
  remoteMessageId: true,
  remoteMessageVerifiedAt: true,
  remoteMessageVerificationAttemptCount: true,
  remoteMessageVerificationAbsentCount: true,
  remoteMessageVerificationPresentCount: true,
  remoteMessageVerificationAttemptedAt: true,
  remoteMessageVerificationNextAt: true,
  remoteMessageVerificationLastError: true,
  remoteMessageVerificationSource: true,
  legacySentWithoutRemoteId: true,
  lastErrorCode: true,
  lastError: true,
  sentAt: true,
  lockedAt: true,
  lockToken: true,
  publicationOccurrenceId: true,
  updatedAt: true,
  publicationOccurrence: {
    select: {
      id: true,
      status: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.ManagedBroadcastDeliverySelect;

const ROUTE_HEALTH_SELECT = {
  id: true,
  chatId: true,
  botId: true,
  status: true,
  sendRouteFailureCount: true,
  sendRouteQuarantinedUntil: true,
  sendRouteLastFailureAt: true,
  sendRouteLastFailureCode: true,
  sendRouteLastSuccessAt: true,
  updatedAt: true,
} satisfies Prisma.ChatBotMembershipSelect;

type LegacyAbsenceCandidate = Prisma.ManagedBroadcastDeliveryGetPayload<{
  select: typeof DELIVERY_SELECT;
}>;
type RouteHealthSnapshot = Prisma.ChatBotMembershipGetPayload<{
  select: typeof ROUTE_HEALTH_SELECT;
}>;

const REVIEWABLE_OCCURRENCE_STATUSES = new Set<PublicationOccurrenceStatus>([
  PublicationOccurrenceStatus.FAILED,
  PublicationOccurrenceStatus.PARTIAL,
  PublicationOccurrenceStatus.AMBIGUOUS,
]);

export type LegacyPublicationAbsenceNormalizationOptions = {
  apply: boolean;
  json: boolean;
  actorUserId: string | null;
  deliveryIds: string[];
};

type NormalizationIneligibleReason =
  | 'delivery_missing'
  | 'legacy_signature_mismatch'
  | 'occurrence_not_reviewable';
type NormalizationRouteResult =
  | 'not_applicable'
  | 'not_matching'
  | 'would_clear'
  | 'cleared'
  | 'cas_conflict';

export type LegacyPublicationAbsenceNormalizationOutcome = {
  deliveryId: string;
  result: 'would_apply' | 'applied' | 'ineligible' | 'cas_conflict' | 'error';
  reason: NormalizationIneligibleReason | null;
  routeResult: NormalizationRouteResult;
  wokenBroadcastCount: number;
  releasedDeliveryCount: number;
  error?: string;
};

export type LegacyPublicationAbsenceNormalizationSummary = {
  apply: boolean;
  requested: number;
  wouldApply: number;
  applied: number;
  ineligible: number;
  casConflicts: number;
  routeCasConflicts: number;
  routesCleared: number;
  errors: number;
  wokenBroadcastCount: number;
  releasedDeliveryCount: number;
  outcomes: LegacyPublicationAbsenceNormalizationOutcome[];
};

export const LEGACY_PUBLICATION_ABSENCE_NORMALIZATION_USAGE = [
  'Usage:',
  '  --delivery-id <id> [--delivery-id <id> ...] [--dry-run] [--json]',
  '  --apply --actor-user-id <id> --delivery-id <id> [--delivery-id <id> ...] [--json]',
  '',
  `Dry-run is the default. Between 1 and ${MAX_DELIVERY_IDS} unique delivery IDs are required.`,
  'Apply performs no MAX calls and never sends a message.',
].join('\n');

function readRequiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function readLegacyPublicationAbsenceNormalizationOptions(
  argv: readonly string[],
): LegacyPublicationAbsenceNormalizationOptions {
  let apply = false;
  let explicitDryRun = false;
  let json = false;
  let actorUserId: string | null = null;
  const deliveryIds: string[] = [];

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
      actorUserId = readRequiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--delivery-id') {
      const deliveryId = readRequiredValue(argv, index, arg);
      if (deliveryId.length > MAX_ID_LENGTH) {
        throw new Error(`--delivery-id must be at most ${MAX_ID_LENGTH} characters`);
      }
      deliveryIds.push(deliveryId);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(LEGACY_PUBLICATION_ABSENCE_NORMALIZATION_USAGE);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (apply && explicitDryRun) {
    throw new Error('--apply cannot be combined with --dry-run');
  }
  if (deliveryIds.length === 0) {
    throw new Error('At least one explicit --delivery-id is required');
  }
  if (deliveryIds.length > MAX_DELIVERY_IDS) {
    throw new Error(`At most ${MAX_DELIVERY_IDS} --delivery-id values are allowed`);
  }
  if (new Set(deliveryIds).size !== deliveryIds.length) {
    throw new Error('Each --delivery-id must be unique');
  }
  if (apply && !actorUserId) {
    throw new Error('--apply requires --actor-user-id');
  }

  return { apply, json, actorUserId, deliveryIds };
}

const normalizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
  return message.trim().slice(0, 1_000) || 'Unknown error';
};

function resolveIneligibleReason(
  candidate: LegacyAbsenceCandidate | null,
): NormalizationIneligibleReason | null {
  if (!candidate) {
    return 'delivery_missing';
  }
  if (!isLegacyAutomatedAbsenceFailure(candidate)) {
    return 'legacy_signature_mismatch';
  }
  if (
    !candidate.publicationOccurrence ||
    !REVIEWABLE_OCCURRENCE_STATUSES.has(candidate.publicationOccurrence.status)
  ) {
    return 'occurrence_not_reviewable';
  }
  return null;
}

function matchesExactDisappearanceRoute(
  membership: RouteHealthSnapshot | null,
  candidate: LegacyAbsenceCandidate,
): membership is RouteHealthSnapshot {
  return Boolean(
    membership &&
    candidate.botId &&
    candidate.sentAt &&
    membership.chatId === candidate.targetChatId &&
    membership.botId === candidate.botId &&
    membership.status === ChatBotMembershipStatus.ACTIVE &&
    membership.sendRouteFailureCount > 0 &&
    membership.sendRouteLastFailureCode === MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE &&
    membership.sendRouteLastFailureAt?.getTime() === candidate.sentAt.getTime(),
  );
}

async function loadCandidate(
  prisma: Pick<PrismaService, 'managedBroadcastDelivery'>,
  deliveryId: string,
): Promise<LegacyAbsenceCandidate | null> {
  return prisma.managedBroadcastDelivery.findUnique({
    where: { id: deliveryId },
    select: DELIVERY_SELECT,
  });
}

async function loadRouteHealth(
  prisma: Pick<PrismaService, 'chatBotMembership'>,
  candidate: LegacyAbsenceCandidate,
): Promise<RouteHealthSnapshot | null> {
  if (!candidate.botId) {
    return null;
  }
  return prisma.chatBotMembership.findFirst({
    where: { chatId: candidate.targetChatId, botId: candidate.botId },
    select: ROUTE_HEALTH_SELECT,
  });
}

async function previewOne(
  prisma: PrismaService,
  deliveryId: string,
): Promise<LegacyPublicationAbsenceNormalizationOutcome> {
  const candidate = await loadCandidate(prisma, deliveryId);
  const reason = resolveIneligibleReason(candidate);
  if (reason || !candidate) {
    return {
      deliveryId,
      result: 'ineligible',
      reason,
      routeResult: 'not_applicable',
      wokenBroadcastCount: 0,
      releasedDeliveryCount: 0,
    };
  }
  const membership = await loadRouteHealth(prisma, candidate);
  return {
    deliveryId,
    result: 'would_apply',
    reason: null,
    routeResult: matchesExactDisappearanceRoute(membership, candidate)
      ? 'would_clear'
      : candidate.botId
        ? 'not_matching'
        : 'not_applicable',
    wokenBroadcastCount: 0,
    releasedDeliveryCount: 0,
  };
}

class LegacyPublicationAbsenceNormalizationCasError extends Error {}

async function applyOne(
  prisma: PrismaService,
  deliveryId: string,
  actorUserId: string,
  normalizedAt: Date,
): Promise<LegacyPublicationAbsenceNormalizationOutcome> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const candidate = await loadCandidate(tx as never, deliveryId);
        const reason = resolveIneligibleReason(candidate);
        if (reason || !candidate || !candidate.publicationOccurrence) {
          return {
            deliveryId,
            result: 'ineligible' as const,
            reason,
            routeResult: 'not_applicable' as const,
            wokenBroadcastCount: 0,
            releasedDeliveryCount: 0,
          };
        }

        const transitionedDelivery = await tx.managedBroadcastDelivery.updateMany({
          where: {
            id: candidate.id,
            broadcastId: candidate.broadcastId,
            occurrenceIndex: candidate.occurrenceIndex,
            targetChatId: candidate.targetChatId,
            botId: candidate.botId,
            status: ManagedBroadcastDeliveryStatus.FAILED,
            remoteMessageId: candidate.remoteMessageId,
            remoteMessageVerifiedAt: null,
            remoteMessageVerificationAttemptCount: candidate.remoteMessageVerificationAttemptCount,
            remoteMessageVerificationAbsentCount: candidate.remoteMessageVerificationAbsentCount,
            remoteMessageVerificationPresentCount: 0,
            remoteMessageVerificationAttemptedAt: candidate.remoteMessageVerificationAttemptedAt,
            remoteMessageVerificationNextAt: null,
            remoteMessageVerificationLastError: candidate.remoteMessageVerificationLastError,
            remoteMessageVerificationSource: null,
            legacySentWithoutRemoteId: false,
            lastErrorCode: null,
            lastError: candidate.lastError,
            sentAt: candidate.sentAt,
            lockedAt: null,
            lockToken: null,
            publicationOccurrenceId: candidate.publicationOccurrenceId,
            updatedAt: candidate.updatedAt,
          },
          data: { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
        });
        if (transitionedDelivery.count !== 1) {
          throw new LegacyPublicationAbsenceNormalizationCasError('delivery CAS conflict');
        }

        const transitionedOccurrence = await tx.publicationOccurrence.updateMany({
          where: {
            id: candidate.publicationOccurrence.id,
            status: candidate.publicationOccurrence.status,
            updatedAt: candidate.publicationOccurrence.updatedAt,
          },
          data: { status: PublicationOccurrenceStatus.AMBIGUOUS },
        });
        if (transitionedOccurrence.count !== 1) {
          throw new LegacyPublicationAbsenceNormalizationCasError('occurrence CAS conflict');
        }

        const membership = await loadRouteHealth(tx as never, candidate);
        let routeResult: NormalizationRouteResult = candidate.botId
          ? 'not_matching'
          : 'not_applicable';
        let wokenBroadcastCount = 0;
        let releasedDeliveryCount = 0;
        if (matchesExactDisappearanceRoute(membership, candidate)) {
          const clearedRoute = await tx.chatBotMembership.updateMany({
            where: {
              id: membership.id,
              chatId: membership.chatId,
              botId: membership.botId,
              status: membership.status,
              sendRouteFailureCount: membership.sendRouteFailureCount,
              sendRouteQuarantinedUntil: membership.sendRouteQuarantinedUntil,
              sendRouteLastFailureAt: membership.sendRouteLastFailureAt,
              sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
              sendRouteLastSuccessAt: membership.sendRouteLastSuccessAt,
              updatedAt: membership.updatedAt,
            },
            data: {
              sendRouteFailureCount: 0,
              sendRouteQuarantinedUntil: null,
              sendRouteLastFailureAt: null,
              sendRouteLastFailureCode: null,
            },
          });
          if (clearedRoute.count === 1) {
            routeResult = 'cleared';
            const released = await releasePublicationRouteQuarantineBacklog(
              tx as never,
              candidate.targetChatId,
              normalizedAt,
            );
            wokenBroadcastCount = released.wokenBroadcastCount;
            releasedDeliveryCount = released.releasedDeliveryCount;
          } else {
            routeResult = 'cas_conflict';
          }
        }

        await tx.auditLog.create({
          data: {
            chatId: candidate.targetChatId,
            actorUserId,
            action: NORMALIZATION_AUDIT_ACTION,
            payload: {
              normalizationVersion: 1,
              reason: NORMALIZATION_REASON,
              deliveryId: candidate.id,
              broadcastId: candidate.broadcastId,
              publicationOccurrenceId: candidate.publicationOccurrenceId,
              occurrenceIndex: candidate.occurrenceIndex,
              botId: candidate.botId,
              previousStatus: ManagedBroadcastDeliveryStatus.FAILED,
              nextStatus: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
              verificationAttemptCount: candidate.remoteMessageVerificationAttemptCount,
              verificationAbsentCount: candidate.remoteMessageVerificationAbsentCount,
              routeResult,
              wokenBroadcastCount,
              releasedDeliveryCount,
              normalizedAt: normalizedAt.toISOString(),
            },
          },
        });

        return {
          deliveryId,
          result: 'applied' as const,
          reason: null,
          routeResult,
          wokenBroadcastCount,
          releasedDeliveryCount,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error: unknown) {
    if (error instanceof LegacyPublicationAbsenceNormalizationCasError) {
      return {
        deliveryId,
        result: 'cas_conflict',
        reason: null,
        routeResult: 'not_applicable',
        wokenBroadcastCount: 0,
        releasedDeliveryCount: 0,
      };
    }
    return {
      deliveryId,
      result: 'error',
      reason: null,
      routeResult: 'not_applicable',
      wokenBroadcastCount: 0,
      releasedDeliveryCount: 0,
      error: normalizeError(error),
    };
  }
}

export async function runLegacyPublicationAbsenceNormalization(
  prisma: PrismaService,
  options: LegacyPublicationAbsenceNormalizationOptions,
  now: () => Date = () => new Date(),
): Promise<LegacyPublicationAbsenceNormalizationSummary> {
  const outcomes: LegacyPublicationAbsenceNormalizationOutcome[] = [];
  for (const deliveryId of options.deliveryIds) {
    outcomes.push(
      options.apply
        ? await applyOne(prisma, deliveryId, options.actorUserId!, now())
        : await previewOne(prisma, deliveryId),
    );
  }

  return {
    apply: options.apply,
    requested: options.deliveryIds.length,
    wouldApply: outcomes.filter((outcome) => outcome.result === 'would_apply').length,
    applied: outcomes.filter((outcome) => outcome.result === 'applied').length,
    ineligible: outcomes.filter((outcome) => outcome.result === 'ineligible').length,
    casConflicts: outcomes.filter((outcome) => outcome.result === 'cas_conflict').length,
    routeCasConflicts: outcomes.filter((outcome) => outcome.routeResult === 'cas_conflict').length,
    routesCleared: outcomes.filter((outcome) => outcome.routeResult === 'cleared').length,
    errors: outcomes.filter((outcome) => outcome.result === 'error').length,
    wokenBroadcastCount: outcomes.reduce(
      (count, outcome) => count + outcome.wokenBroadcastCount,
      0,
    ),
    releasedDeliveryCount: outcomes.reduce(
      (count, outcome) => count + outcome.releasedDeliveryCount,
      0,
    ),
    outcomes,
  };
}

function printSummary(summary: LegacyPublicationAbsenceNormalizationSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Legacy publication absence normalization ${summary.apply ? 'apply' : 'dry-run'}: ` +
      `${summary.applied} applied, ${summary.wouldApply} eligible, ` +
      `${summary.ineligible} ineligible, ${summary.casConflicts} CAS conflicts, ` +
      `${summary.routesCleared} routes cleared, ${summary.routeCasConflicts} route CAS conflicts, ` +
      `${summary.errors} errors.\n`,
  );
}

async function main(): Promise<void> {
  const options = readLegacyPublicationAbsenceNormalizationOptions(process.argv.slice(2));
  const [{ PublicationSendRouteRecoveryModule }, { PrismaService }] = await Promise.all([
    import('./publication-send-route-recovery.module'),
    import('../prisma/prisma.service'),
  ]);
  const app = await NestFactory.createApplicationContext(PublicationSendRouteRecoveryModule, {
    logger: false,
  });
  try {
    const summary = await runLegacyPublicationAbsenceNormalization(app.get(PrismaService), options);
    printSummary(summary, options.json);
    if (
      summary.casConflicts > 0 ||
      summary.routeCasConflicts > 0 ||
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
