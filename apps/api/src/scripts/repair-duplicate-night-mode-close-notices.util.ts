import type { EnsureModerationDeleteIntentInput } from '../moderation/moderation-delete-intent.types';

export const DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE = 'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE';
export const DUPLICATE_CLOSE_NOTICE_REPAIR_REASON = 'Repair duplicate night mode close notice';
export const DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_WINDOW_HOURS = 24;
export const DUPLICATE_CLOSE_NOTICE_REPAIR_MAX_WINDOW_HOURS = 7 * 24;
export const DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_GLOBAL_CAP = 100;
export const DUPLICATE_CLOSE_NOTICE_REPAIR_MAX_GLOBAL_CAP = 1_000;
export const DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_SAMPLE_LIMIT = 30;
export const DUPLICATE_CLOSE_NOTICE_REPAIR_MAX_SAMPLE_LIMIT = 100;

export type DuplicateCloseNoticeRepairCliOptions = {
  since: Date;
  until: Date;
  execute: boolean;
  json: boolean;
  globalCap: number;
  sampleLimit: number;
};

export type DuplicateCloseNoticeRepairBootstrapMode =
  | 'direct_prisma_read_only'
  | 'admin_app_context';

export type DuplicateCloseNoticeRepairCandidate = {
  id: string;
  createdAt: Date;
  chatId: string;
  userId: string;
  messageId: string;
  botId: string | null;
  entityType: 'CHAT' | 'CHANNEL';
  maskedExcerpt: string | null;
  score: number;
  sessionKey: string;
  keptEventId: string;
  keptMessageId: string | null;
  duplicateEvents: number | bigint;
};

export type DuplicateCloseNoticeRepairCandidateDecision =
  | { eligible: true; originBotId: string }
  | {
      eligible: false;
      reason: 'missing_origin_bot' | 'same_as_kept_message' | 'unsupported_entity';
    };

export function readDuplicateCloseNoticeRepairCliOptions(
  argv: readonly string[],
  now: Date = new Date(),
): DuplicateCloseNoticeRepairCliOptions {
  validateKnownArguments(argv);
  const execute = argv.includes('--execute');
  if (execute && argv.includes('--dry-run')) {
    throw new Error('--execute and --dry-run cannot be used together');
  }

  const until = readDateOption(argv, '--until') ?? new Date(now);
  const explicitSince = readDateOption(argv, '--since');
  const windowHours = readBoundedPositiveNumberOption(
    argv,
    '--window-hours',
    DUPLICATE_CLOSE_NOTICE_REPAIR_MAX_WINDOW_HOURS,
  );
  if (explicitSince && windowHours !== undefined) {
    throw new Error('--since and --window-hours cannot be used together');
  }
  const since =
    explicitSince ??
    new Date(
      until.getTime() -
        (windowHours ?? DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_WINDOW_HOURS) * 60 * 60_000,
    );
  const windowMs = until.getTime() - since.getTime();
  if (windowMs <= 0) {
    throw new Error('--since must be earlier than --until');
  }
  if (windowMs > DUPLICATE_CLOSE_NOTICE_REPAIR_MAX_WINDOW_HOURS * 60 * 60_000) {
    throw new Error(
      `repair window cannot exceed ${DUPLICATE_CLOSE_NOTICE_REPAIR_MAX_WINDOW_HOURS} hours`,
    );
  }

  const globalCapOption = readBoundedPositiveIntOption(
    argv,
    '--global-cap',
    DUPLICATE_CLOSE_NOTICE_REPAIR_MAX_GLOBAL_CAP,
  );
  const legacyLimitOption = readBoundedPositiveIntOption(
    argv,
    '--limit',
    DUPLICATE_CLOSE_NOTICE_REPAIR_MAX_GLOBAL_CAP,
  );
  if (globalCapOption !== undefined && legacyLimitOption !== undefined) {
    throw new Error('--global-cap and --limit cannot be used together');
  }

  return {
    since,
    until,
    execute,
    json: argv.includes('--json'),
    globalCap:
      globalCapOption ?? legacyLimitOption ?? DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_GLOBAL_CAP,
    sampleLimit:
      readBoundedPositiveIntOption(
        argv,
        '--sample-limit',
        DUPLICATE_CLOSE_NOTICE_REPAIR_MAX_SAMPLE_LIMIT,
      ) ?? DUPLICATE_CLOSE_NOTICE_REPAIR_DEFAULT_SAMPLE_LIMIT,
  };
}

export function resolveDuplicateCloseNoticeRepairBootstrapMode(
  options: Pick<DuplicateCloseNoticeRepairCliOptions, 'execute'>,
  appRole: unknown,
): DuplicateCloseNoticeRepairBootstrapMode {
  if (!options.execute) {
    return 'direct_prisma_read_only';
  }
  if (appRole !== 'admin') {
    throw new Error(
      `--execute must run with exact APP_ROLE=admin; received ${formatUnknownValue(appRole)}`,
    );
  }
  return 'admin_app_context';
}

export function assertDuplicateCloseNoticeRepairExecutionMode(
  rolloutMode: unknown,
): asserts rolloutMode is 'canary' | 'on' {
  if (rolloutMode !== 'canary' && rolloutMode !== 'on') {
    throw new Error(
      `--execute requires MODERATION_DELETE_INTENT_MODE=canary or on; current mode is ${formatUnknownValue(
        rolloutMode,
      )}`,
    );
  }
}

export function evaluateDuplicateCloseNoticeRepairCandidate(
  candidate: DuplicateCloseNoticeRepairCandidate,
): DuplicateCloseNoticeRepairCandidateDecision {
  if (candidate.entityType !== 'CHAT') {
    return { eligible: false, reason: 'unsupported_entity' };
  }
  if (candidate.messageId === candidate.keptMessageId) {
    return { eligible: false, reason: 'same_as_kept_message' };
  }
  const originBotId = candidate.botId?.trim() ?? '';
  if (!originBotId) {
    return { eligible: false, reason: 'missing_origin_bot' };
  }
  return { eligible: true, originBotId };
}

export function buildDuplicateCloseNoticeRepairIntentInput(
  candidate: DuplicateCloseNoticeRepairCandidate,
  decision: Extract<DuplicateCloseNoticeRepairCandidateDecision, { eligible: true }>,
): EnsureModerationDeleteIntentInput {
  return {
    chatId: candidate.chatId,
    messageId: candidate.messageId,
    reasonKey: DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE,
    ruleCode: DUPLICATE_CLOSE_NOTICE_REPAIR_RULE_CODE,
    subjectUserId: candidate.userId,
    sourceMessageAt: candidate.createdAt,
    entityType: 'CHAT',
    messageAuthorKind: 'bot',
    originBotId: decision.originBotId,
    routingPolicy: 'origin_only',
    event: {
      userId: candidate.userId,
      eventType: 'SYSTEM',
      maskedExcerpt: candidate.maskedExcerpt,
      score: Number.isFinite(candidate.score) ? candidate.score : 1,
      metadata: {
        reason: DUPLICATE_CLOSE_NOTICE_REPAIR_REASON,
        repaired: true,
        originalEventId: candidate.id,
        originalBotId: decision.originBotId,
        sessionKey: candidate.sessionKey,
        keptEventId: candidate.keptEventId,
        keptMessageId: candidate.keptMessageId,
        duplicateEvents: Number(candidate.duplicateEvents),
      },
    },
  };
}

function validateKnownArguments(argv: readonly string[]): void {
  const booleanOptions = new Set(['--execute', '--dry-run', '--json']);
  const valueOptions = new Set([
    '--since',
    '--until',
    '--window-hours',
    '--global-cap',
    '--limit',
    '--sample-limit',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (booleanOptions.has(arg)) {
      continue;
    }
    if (!valueOptions.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
  }
}

function readDateOption(argv: readonly string[], name: string): Date | undefined {
  const value = readOptionValue(argv, name);
  if (value === undefined) {
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
  max: number,
): number | undefined {
  const value = readOptionValue(argv, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function readBoundedPositiveNumberOption(
  argv: readonly string[],
  name: string,
  max: number,
): number | undefined {
  const value = readOptionValue(argv, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a number greater than 0 and at most ${max}`);
  }
  return parsed;
}

function readOptionValue(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) {
    throw new Error(`${name} may be specified only once`);
  }
  const index = indexes[0];
  return index === undefined ? undefined : argv[index + 1];
}

function formatUnknownValue(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unset';
}
