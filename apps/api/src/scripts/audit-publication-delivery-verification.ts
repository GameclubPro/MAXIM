import { NestFactory } from '@nestjs/core';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import {
  ManagedBroadcastStatus,
  ManagedBroadcastDeliveryStatus,
  PublicationDeliveryVerificationSource,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_ERROR_LENGTH = 1_000;

export const PUBLICATION_VERIFICATION_AUDIT_USAGE = [
  'Usage:',
  '  --since <ISO> [--until <ISO>] [--limit 1..200] [--unverified | --apply] [--json]',
  '  --delivery-id <id> [--delivery-id <id> ...] [--limit 1..200] [--unverified | --apply] [--json]',
  '',
  'Dry-run is the default. The audit performs exact MAX reads but never replays a send.',
  '--unverified audits SENT deliveries still awaiting stable verification and cannot be applied.',
].join('\n');

export type PublicationVerificationAuditOptions = {
  apply: boolean;
  json: boolean;
  limit: number;
  since: Date | null;
  until: Date | null;
  deliveryIds: string[];
  unverified: boolean;
};

type LegacyVerificationCandidate = {
  id: string;
  broadcastId: string;
  occurrenceIndex: number;
  targetChatId: string;
  botId: string | null;
  status: ManagedBroadcastDeliveryStatus;
  remoteMessageId: string;
  remoteMessageVerifiedAt: Date | null;
  remoteMessageVerificationAttemptCount: number;
  remoteMessageVerificationAbsentCount: number;
  remoteMessageVerificationPresentCount: number;
  remoteMessageVerificationAttemptedAt: Date | null;
  remoteMessageVerificationNextAt: Date | null;
  remoteMessageVerificationLastError: string | null;
};

type AuditPresence =
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'error'; error: string }
  | { kind: 'no_bot'; error: string };

type AuditOutcome = {
  deliveryId: string;
  broadcastId: string;
  occurrenceIndex: number;
  targetChatId: string;
  botId: string | null;
  messageId: string;
  candidateState: 'legacy_verified' | 'unverified';
  presence: AuditPresence['kind'];
  classification: PublicationDeliveryVerificationSource | null;
  persistence: 'dry_run' | 'updated' | 'cas_conflict';
  error?: string;
};

export type PublicationVerificationAuditSummary = {
  apply: boolean;
  selected: number;
  present: number;
  absent: number;
  errors: number;
  noBot: number;
  unverifiedSelected: number;
  stableClassifications: number;
  legacyClassifications: number;
  casConflicts: number;
  outcomes: AuditOutcome[];
};

type AuditPrisma = Pick<PrismaService, 'managedBroadcastDelivery'>;
type AuditMaxClient = Pick<MaxClientService, 'getExactMessagePresences'>;

function readRequiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function readDate(value: string, option: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${option} must be a valid ISO timestamp`);
  }
  return parsed;
}

export function readPublicationVerificationAuditOptions(
  argv: readonly string[],
): PublicationVerificationAuditOptions {
  let apply = false;
  let json = false;
  let limit = DEFAULT_LIMIT;
  let since: Date | null = null;
  let until: Date | null = null;
  let unverified = false;
  const deliveryIds: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--unverified') {
      unverified = true;
      continue;
    }
    if (arg === '--limit') {
      const value = readRequiredValue(argv, index, arg);
      limit = Number(value);
      index += 1;
      continue;
    }
    if (arg === '--since') {
      since = readDate(readRequiredValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--until') {
      until = readDate(readRequiredValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--delivery-id') {
      deliveryIds.push(readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(PUBLICATION_VERIFICATION_AUDIT_USAGE);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (!since && deliveryIds.length === 0) {
    throw new Error('A bounded --since or at least one --delivery-id is required');
  }
  if (until && !since) {
    throw new Error('--until requires --since');
  }
  if (since && until && since > until) {
    throw new Error('--since must not be later than --until');
  }
  if (new Set(deliveryIds).size !== deliveryIds.length) {
    throw new Error('Each --delivery-id must be unique');
  }
  if (deliveryIds.length > MAX_LIMIT) {
    throw new Error(`At most ${MAX_LIMIT} --delivery-id values are allowed`);
  }
  if (unverified && apply) {
    throw new Error('--unverified is read-only and cannot be combined with --apply');
  }

  return { apply, json, limit, since, until, deliveryIds, unverified };
}

const resultKey = (chatId: string, messageId: string): string =>
  JSON.stringify([chatId, messageId]);

const normalizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
  return message.trim().slice(0, MAX_ERROR_LENGTH) || 'Unknown error';
};

async function loadCandidates(
  prisma: AuditPrisma,
  options: PublicationVerificationAuditOptions,
): Promise<LegacyVerificationCandidate[]> {
  return prisma.managedBroadcastDelivery.findMany({
    where: {
      publicationOccurrenceId: { not: null },
      status: ManagedBroadcastDeliveryStatus.SENT,
      remoteMessageId: { not: null },
      ...(options.unverified
        ? {
            broadcast: {
              is: {
                status: {
                  in: [
                    ManagedBroadcastStatus.ACTIVE,
                    ManagedBroadcastStatus.PARTIAL,
                    ManagedBroadcastStatus.FAILED,
                  ],
                },
              },
            },
            remoteMessageVerifiedAt: null,
            sentAt: {
              not: null,
              ...(options.since ? { gte: options.since } : {}),
              ...(options.until ? { lte: options.until } : {}),
            },
          }
        : {
            remoteMessageVerifiedAt: {
              not: null,
              ...(options.since ? { gte: options.since } : {}),
              ...(options.until ? { lte: options.until } : {}),
            },
          }),
      remoteMessageVerificationSource: null,
      ...(options.deliveryIds.length > 0 ? { id: { in: options.deliveryIds } } : {}),
    },
    orderBy: options.unverified
      ? [{ sentAt: 'asc' }, { id: 'asc' }]
      : [{ remoteMessageVerifiedAt: 'asc' }, { id: 'asc' }],
    take: Math.min(options.limit, options.deliveryIds.length || options.limit),
    select: {
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
    },
  }) as Promise<LegacyVerificationCandidate[]>;
}

async function readExactPresences(
  maxClient: AuditMaxClient,
  candidates: readonly LegacyVerificationCandidate[],
): Promise<Map<string, AuditPresence>> {
  const presences = new Map<string, AuditPresence>();
  const byBotId = new Map<string, LegacyVerificationCandidate[]>();
  for (const candidate of candidates) {
    const botId = candidate.botId?.trim();
    if (!botId) {
      presences.set(resultKey(candidate.targetChatId, candidate.remoteMessageId), {
        kind: 'no_bot',
        error: 'Delivery has no recorded bot route',
      });
      continue;
    }
    const rows = byBotId.get(botId) ?? [];
    rows.push(candidate);
    byBotId.set(botId, rows);
  }

  for (const [botId, rows] of byBotId) {
    let results: Awaited<ReturnType<AuditMaxClient['getExactMessagePresences']>>;
    try {
      results = await maxClient.getExactMessagePresences(
        rows.map((row) => ({ chatId: row.targetChatId, messageId: row.remoteMessageId })),
        {
          botId,
          bypassCache: true,
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
          timeoutMs: 5_000,
          ignoreFailureMetricStatuses: [404],
        },
      );
    } catch (error: unknown) {
      results = rows.map((row) => ({
        chatId: row.targetChatId,
        messageId: row.remoteMessageId,
        error,
      }));
    }

    for (const result of results) {
      const key = resultKey(result.chatId, result.messageId);
      if ('presence' in result) {
        presences.set(key, { kind: result.presence });
      } else {
        presences.set(key, { kind: 'error', error: normalizeError(result.error) });
      }
    }
  }
  return presences;
}

async function persistClassification(
  prisma: AuditPrisma,
  candidate: LegacyVerificationCandidate,
  presence: AuditPresence,
  auditedAt: Date,
): Promise<'updated' | 'cas_conflict'> {
  if (!candidate.remoteMessageVerifiedAt) {
    throw new Error('Unverified delivery audit results cannot be applied');
  }
  const stable = presence.kind === 'present';
  const classification = stable
    ? PublicationDeliveryVerificationSource.AUTOMATED_STABLE
    : PublicationDeliveryVerificationSource.LEGACY_SINGLE_OBSERVATION;
  const attempted = presence.kind !== 'no_bot';
  const updated = await prisma.managedBroadcastDelivery.updateMany({
    where: {
      id: candidate.id,
      status: candidate.status,
      remoteMessageId: candidate.remoteMessageId,
      remoteMessageVerifiedAt: candidate.remoteMessageVerifiedAt,
      remoteMessageVerificationSource: null,
      remoteMessageVerificationAttemptCount: candidate.remoteMessageVerificationAttemptCount,
      remoteMessageVerificationAbsentCount: candidate.remoteMessageVerificationAbsentCount,
      remoteMessageVerificationPresentCount: candidate.remoteMessageVerificationPresentCount,
      remoteMessageVerificationAttemptedAt: candidate.remoteMessageVerificationAttemptedAt,
      remoteMessageVerificationNextAt: candidate.remoteMessageVerificationNextAt,
      remoteMessageVerificationLastError: candidate.remoteMessageVerificationLastError,
    },
    data: stable
      ? {
          remoteMessageVerifiedAt: auditedAt,
          remoteMessageVerificationAttemptCount: Math.max(
            2,
            candidate.remoteMessageVerificationAttemptCount + 1,
          ),
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: Math.max(
            2,
            candidate.remoteMessageVerificationPresentCount + 1,
          ),
          remoteMessageVerificationAttemptedAt: auditedAt,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: null,
          remoteMessageVerificationSource: classification,
        }
      : {
          remoteMessageVerificationAttemptCount:
            candidate.remoteMessageVerificationAttemptCount + (attempted ? 1 : 0),
          remoteMessageVerificationAbsentCount:
            presence.kind === 'absent' ? candidate.remoteMessageVerificationAbsentCount + 1 : 0,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: attempted ? auditedAt : null,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError:
            presence.kind === 'absent'
              ? 'Bounded legacy audit observed exact absence after the original verification'
              : presence.error,
          remoteMessageVerificationSource: classification,
        },
  });
  return updated.count > 0 ? 'updated' : 'cas_conflict';
}

export async function runPublicationVerificationAudit(
  prisma: AuditPrisma,
  maxClient: AuditMaxClient,
  options: PublicationVerificationAuditOptions,
): Promise<PublicationVerificationAuditSummary> {
  const candidates = await loadCandidates(prisma, options);
  const presences = await readExactPresences(maxClient, candidates);
  const outcomes: AuditOutcome[] = [];

  for (const candidate of candidates) {
    const presence =
      presences.get(resultKey(candidate.targetChatId, candidate.remoteMessageId)) ??
      ({ kind: 'error', error: 'MAX exact lookup returned no result' } as const);
    const candidateState = candidate.remoteMessageVerifiedAt
      ? ('legacy_verified' as const)
      : ('unverified' as const);
    const classification = candidate.remoteMessageVerifiedAt
      ? presence.kind === 'present'
        ? PublicationDeliveryVerificationSource.AUTOMATED_STABLE
        : PublicationDeliveryVerificationSource.LEGACY_SINGLE_OBSERVATION
      : null;
    const persistence = options.apply
      ? await persistClassification(prisma, candidate, presence, new Date())
      : 'dry_run';
    outcomes.push({
      deliveryId: candidate.id,
      broadcastId: candidate.broadcastId,
      occurrenceIndex: candidate.occurrenceIndex,
      targetChatId: candidate.targetChatId,
      botId: candidate.botId,
      messageId: candidate.remoteMessageId,
      candidateState,
      presence: presence.kind,
      classification,
      persistence,
      ...('error' in presence ? { error: presence.error } : {}),
    });
  }

  return {
    apply: options.apply,
    selected: outcomes.length,
    present: outcomes.filter((outcome) => outcome.presence === 'present').length,
    absent: outcomes.filter((outcome) => outcome.presence === 'absent').length,
    errors: outcomes.filter((outcome) => outcome.presence === 'error').length,
    noBot: outcomes.filter((outcome) => outcome.presence === 'no_bot').length,
    unverifiedSelected: outcomes.filter((outcome) => outcome.candidateState === 'unverified').length,
    stableClassifications: outcomes.filter(
      (outcome) =>
        outcome.classification === PublicationDeliveryVerificationSource.AUTOMATED_STABLE &&
        outcome.persistence === 'updated',
    ).length,
    legacyClassifications: outcomes.filter(
      (outcome) =>
        outcome.classification ===
          PublicationDeliveryVerificationSource.LEGACY_SINGLE_OBSERVATION &&
        outcome.persistence === 'updated',
    ).length,
    casConflicts: outcomes.filter((outcome) => outcome.persistence === 'cas_conflict').length,
    outcomes,
  };
}

function printSummary(summary: PublicationVerificationAuditSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${summary.apply ? 'Applied' : 'Dry-run'} publication verification audit: ` +
      `${summary.selected} selected, ${summary.present} present, ${summary.absent} absent, ` +
      `${summary.errors} errors, ${summary.noBot} without bot, ` +
      `${summary.unverifiedSelected} unverified, ` +
      `${summary.casConflicts} CAS conflicts.\n`,
  );
}

async function main(): Promise<void> {
  const options = readPublicationVerificationAuditOptions(process.argv.slice(2));
  const [{ PublicationDeliveryVerificationAuditModule }, { PrismaService }, { MaxClientService }] =
    await Promise.all([
      import('./publication-delivery-verification-audit.module'),
      import('../prisma/prisma.service'),
      import('../max/max-client.service'),
    ]);
  const app = await NestFactory.createApplicationContext(
    PublicationDeliveryVerificationAuditModule,
  );
  try {
    const summary = await runPublicationVerificationAudit(
      app.get(PrismaService),
      app.get(MaxClientService),
      options,
    );
    printSummary(summary, options.json);
    if (summary.casConflicts > 0) {
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
