import { createHash, randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

import { createPrismaClient, type Prisma } from '../prisma/prisma-client';
import { sanitizeCommercialCorpusText } from './commercial-corpus-sanitization.util';

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_LIMIT = 1_500;
const DEFAULT_SAMPLE = 20;
const MAX_LIMIT = 5_000;
const MAX_SAMPLE = 100;
const AUDIT_STATEMENT_TIMEOUT_MS = 10_000;

const AUDITED_RULE_CODES = [
  'PROFANITY',
  'PROFANITY_DELETE',
  'MESSAGE_BLOCKED_WORD',
  'MESSAGE_BLOCKED_WORD_DELETE',
] as const;

loadEnv({ quiet: true });
loadEnv({ path: resolve(__dirname, '../../../../.env'), override: false, quiet: true });

export type ProfanityAuditCliOptions = {
  since: Date;
  until: Date;
  limit: number;
  sample: number;
  json: boolean;
  includeSanitizedText: boolean;
};

export type ProfanityAuditEvent = {
  id: string;
  chatId: string;
  userId: string;
  messageId: string | null;
  ruleCode: string;
  action: string;
  maskedExcerpt: string | null;
  score: number;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
};

type ProfanityAuditDecision = ProfanityAuditEvent & {
  source: 'BUILT_IN' | 'CHAT_STOP_LIST';
  category: string;
  detectorVersion: string | null;
  sensitivity: string | null;
  rolloutMode: string | null;
  familyId: string | null;
  matchKind: string | null;
  matchedVariant: string | null;
  evidence: string[];
  deleted: boolean;
  sanctionAction: string;
};

type ProfanityAuditSample = {
  key: string;
  source: ProfanityAuditDecision['source'];
  category: string;
  detectorVersion: string | null;
  sensitivity: string | null;
  rolloutMode: string | null;
  familyId: string | null;
  matchKind: string | null;
  evidence: string[];
  deleted: boolean;
  sanctionAction: string;
  score: number;
  createdAt: string;
  matchedVariant?: string;
  sanitizedText?: string;
};

export type ProfanityAuditReport = {
  generatedAt: string;
  since: string;
  until: string;
  scannedEvents: number;
  uniqueDecisions: number;
  truncated: boolean;
  missingStructuredMetadata: number;
  sourceCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  sensitivityCounts: Record<string, number>;
  rolloutModeCounts: Record<string, number>;
  familyCounts: Record<string, number>;
  matchKindCounts: Record<string, number>;
  evidenceCounts: Record<string, number>;
  deletionCounts: Record<string, number>;
  sanctionActionCounts: Record<string, number>;
  samples: ProfanityAuditSample[];
};

export function readProfanityAuditCliOptions(
  argv: readonly string[],
  now = new Date(),
): ProfanityAuditCliOptions {
  const until = readDateOption(argv, '--until') ?? now;
  const since =
    readDateOption(argv, '--since') ??
    new Date(until.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000);
  const limit = readBoundedPositiveIntOption(argv, '--limit', MAX_LIMIT) ?? DEFAULT_LIMIT;
  const sample = readBoundedNonNegativeIntOption(argv, '--sample', MAX_SAMPLE) ?? DEFAULT_SAMPLE;

  if (since.getTime() > until.getTime()) {
    throw new Error('--since must be earlier than or equal to --until');
  }

  return {
    since,
    until,
    limit,
    sample,
    json: argv.includes('--json'),
    includeSanitizedText: argv.includes('--include-sanitized-text'),
  };
}

export function buildProfanityAuditReport(params: {
  events: readonly ProfanityAuditEvent[];
  options: ProfanityAuditCliOptions;
  generatedAt?: Date;
  pseudonymSalt?: string;
  truncated?: boolean;
}): ProfanityAuditReport {
  const decisions = dedupeProfanityAuditEvents(params.events);
  const pseudonymSalt = params.pseudonymSalt ?? randomBytes(16).toString('hex');
  const generatedAt = params.generatedAt ?? new Date();

  return {
    generatedAt: generatedAt.toISOString(),
    since: params.options.since.toISOString(),
    until: params.options.until.toISOString(),
    scannedEvents: params.events.length,
    uniqueDecisions: decisions.length,
    truncated: params.truncated ?? params.events.length > params.options.limit,
    missingStructuredMetadata: decisions.filter(
      (decision) => decision.source === 'BUILT_IN' && !hasCompleteStructuredMetadata(decision),
    ).length,
    sourceCounts: countBy(decisions, (decision) => decision.source),
    categoryCounts: countBy(decisions, (decision) => decision.category),
    sensitivityCounts: countBy(
      decisions,
      (decision) => decision.sensitivity ?? 'LEGACY_OR_UNKNOWN',
    ),
    rolloutModeCounts: countBy(
      decisions,
      (decision) => decision.rolloutMode ?? 'LEGACY_OR_UNKNOWN',
    ),
    familyCounts: countBy(decisions, (decision) => decision.familyId ?? 'UNKNOWN'),
    matchKindCounts: countBy(decisions, (decision) => decision.matchKind ?? 'UNKNOWN'),
    evidenceCounts: countStrings(decisions.flatMap((decision) => decision.evidence)),
    deletionCounts: countBy(decisions, (decision) =>
      decision.deleted ? 'DELETED' : 'NOT_CONFIRMED',
    ),
    sanctionActionCounts: countBy(decisions, (decision) => decision.sanctionAction),
    samples: decisions.slice(0, params.options.sample).map((decision) => ({
      key: pseudonymizeDecision(decision, pseudonymSalt),
      source: decision.source,
      category: decision.category,
      detectorVersion: decision.detectorVersion,
      sensitivity: decision.sensitivity,
      rolloutMode: decision.rolloutMode,
      familyId: decision.familyId,
      matchKind: decision.matchKind,
      evidence: decision.evidence,
      deleted: decision.deleted,
      sanctionAction: decision.sanctionAction,
      score: decision.score,
      createdAt: decision.createdAt.toISOString(),
      ...(params.options.includeSanitizedText && decision.matchedVariant
        ? { matchedVariant: decision.matchedVariant }
        : {}),
      ...(params.options.includeSanitizedText && decision.maskedExcerpt
        ? { sanitizedText: sanitizeProfanityAuditText(decision.maskedExcerpt) }
        : {}),
    })),
  };
}

export function dedupeProfanityAuditEvents(
  events: readonly ProfanityAuditEvent[],
): ProfanityAuditDecision[] {
  const decisions = new Map<string, ProfanityAuditDecision>();

  for (const event of events) {
    const source = event.ruleCode.startsWith('MESSAGE_BLOCKED_WORD')
      ? 'CHAT_STOP_LIST'
      : 'BUILT_IN';
    const baseRuleCode = source === 'CHAT_STOP_LIST' ? 'MESSAGE_BLOCKED_WORD' : 'PROFANITY';
    const key = [event.chatId, event.messageId ?? event.id, baseRuleCode].join(':');
    const metadata = asRecord(event.metadata);
    const existing = decisions.get(key);
    const category =
      source === 'CHAT_STOP_LIST'
        ? 'CHAT_STOP_LIST'
        : (readBoundedString(metadata?.category, 64) ?? 'LEGACY_OR_UNKNOWN');
    const candidate: ProfanityAuditDecision = {
      ...event,
      source,
      category,
      detectorVersion: readBoundedString(metadata?.detectorVersion, 128),
      sensitivity:
        readBoundedString(metadata?.sensitivity, 32) ??
        readBoundedString(asRecord(metadata?.appliedPolicy)?.sensitivity, 32),
      rolloutMode: readBoundedString(metadata?.rolloutMode, 32),
      familyId: readBoundedString(metadata?.familyId, 96),
      matchKind: readBoundedString(metadata?.matchKind, 64),
      matchedVariant: readBoundedString(metadata?.matchedVariant, 64),
      evidence: readBoundedStringArray(metadata?.evidence, 8, 64),
      deleted: isDeleteAuditEvent(event),
      sanctionAction: isDeleteAuditEvent(event) ? 'UNKNOWN' : event.action,
    };

    if (!existing) {
      decisions.set(key, candidate);
      continue;
    }

    const candidatePreferred = shouldPreferAuditEvent(candidate, existing);
    const preferred = candidatePreferred ? candidate : existing;
    const alternate = candidatePreferred ? existing : candidate;
    const primary = !candidate.ruleCode.endsWith('_DELETE')
      ? candidate
      : !existing.ruleCode.endsWith('_DELETE')
        ? existing
        : null;
    decisions.set(key, {
      ...preferred,
      maskedExcerpt: preferred.maskedExcerpt ?? alternate.maskedExcerpt,
      category: preferKnownValue(preferred.category, alternate.category, 'LEGACY_OR_UNKNOWN'),
      detectorVersion: preferred.detectorVersion ?? alternate.detectorVersion,
      sensitivity: preferred.sensitivity ?? alternate.sensitivity,
      rolloutMode: preferred.rolloutMode ?? alternate.rolloutMode,
      familyId: preferred.familyId ?? alternate.familyId,
      matchKind: preferred.matchKind ?? alternate.matchKind,
      matchedVariant: preferred.matchedVariant ?? alternate.matchedVariant,
      evidence: [...new Set([...preferred.evidence, ...alternate.evidence])],
      deleted: preferred.deleted || alternate.deleted,
      sanctionAction: primary?.action ?? 'UNKNOWN',
    });
  }

  return [...decisions.values()].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  );
}

function isDeleteAuditEvent(event: Pick<ProfanityAuditEvent, 'ruleCode' | 'action'>): boolean {
  return event.ruleCode.endsWith('_DELETE') || event.action === 'DELETE_MESSAGE';
}

function preferKnownValue(primary: string, alternate: string, unknown: string): string {
  return primary !== unknown ? primary : alternate;
}

export function sanitizeProfanityAuditText(value: string): string {
  const withoutDirectIdentities = value
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/gu, '[email]')
    .replace(/(^|[^\p{L}\p{N}_])@[\p{L}\p{N}_]{2,}/gu, '$1[handle]');
  return sanitizeCommercialCorpusText(withoutDirectIdentities);
}

function shouldPreferAuditEvent(
  candidate: ProfanityAuditDecision,
  existing: ProfanityAuditDecision,
): boolean {
  const candidateStructured = candidate.detectorVersion !== null;
  const existingStructured = existing.detectorVersion !== null;
  if (candidateStructured !== existingStructured) {
    return candidateStructured;
  }
  const candidateIsPrimary = !candidate.ruleCode.endsWith('_DELETE');
  const existingIsPrimary = !existing.ruleCode.endsWith('_DELETE');
  if (candidateIsPrimary !== existingIsPrimary) {
    return candidateIsPrimary;
  }
  return candidate.createdAt.getTime() > existing.createdAt.getTime();
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countStrings(items: readonly string[]): Record<string, number> {
  return countBy(items, (item) => item);
}

function hasCompleteStructuredMetadata(decision: ProfanityAuditDecision): boolean {
  return Boolean(
    decision.category !== 'LEGACY_OR_UNKNOWN' &&
      decision.detectorVersion &&
      decision.sensitivity &&
      decision.rolloutMode &&
      decision.familyId &&
      decision.matchKind &&
      decision.evidence.length > 0,
  );
}

function pseudonymizeDecision(decision: ProfanityAuditDecision, salt: string): string {
  return createHash('sha256')
    .update(salt)
    .update('\0')
    .update(decision.chatId)
    .update('\0')
    .update(decision.messageId ?? decision.id)
    .digest('hex')
    .slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readBoundedString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function readBoundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((item) => readBoundedString(item, maximumItemLength) ?? [])
    .slice(0, maximumItems);
}

function readDateOption(argv: readonly string[], name: string): Date | undefined {
  const value = readOptionValue(argv, name);
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid ISO-8601 date`);
  }
  return parsed;
}

function readBoundedPositiveIntOption(
  argv: readonly string[],
  name: string,
  maximum: number,
): number | undefined {
  const parsed = readIntegerOption(argv, name);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function readBoundedNonNegativeIntOption(
  argv: readonly string[],
  name: string,
  maximum: number,
): number | undefined {
  const parsed = readIntegerOption(argv, name);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return parsed;
}

function readIntegerOption(argv: readonly string[], name: string): number | undefined {
  const value = readOptionValue(argv, name);
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function readOptionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value.trim() || undefined;
}

async function main(): Promise<void> {
  const options = readProfanityAuditCliOptions(process.argv.slice(2));
  const prisma = createPrismaClient(undefined, {
    application_name: `maxim_profanity_audit_${process.pid}`,
    max: 1,
    options: '-c max_parallel_workers_per_gather=0',
    statement_timeout: AUDIT_STATEMENT_TIMEOUT_MS,
  });

  try {
    const loadedEvents = await prisma.moderationEvent.findMany({
      where: {
        createdAt: { gte: options.since, lte: options.until },
        ruleCode: { in: [...AUDITED_RULE_CODES] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      select: {
        id: true,
        chatId: true,
        userId: true,
        messageId: true,
        ruleCode: true,
        action: true,
        maskedExcerpt: true,
        score: true,
        metadata: true,
        createdAt: true,
      },
    });
    const truncated = loadedEvents.length > options.limit;
    const events = loadedEvents.slice(0, options.limit);
    const report = buildProfanityAuditReport({ events, options, truncated });

    if (!options.json) {
      process.stdout.write(
        [
          `Profanity audit ${report.since} .. ${report.until}`,
          `scanned_events=${report.scannedEvents}`,
          `unique_decisions=${report.uniqueDecisions}`,
          `truncated=${report.truncated}`,
          `missing_structured_metadata=${report.missingStructuredMetadata}`,
        ].join('\n') + '\n',
      );
    }
    process.stdout.write(`${JSON.stringify(report, null, options.json ? 2 : 0)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
