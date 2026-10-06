import type { Prisma } from '../prisma/prisma-client';
import { inventoryLegacyRecoveryLiveSql } from './legacy-recovery-live-sql';
import { isLegacyRecoveryWebhookQueue } from './legacy-recovery-queue-inventory';
import {
  LEGACY_RECOVERY_LIVE_QUEUE_NAMES,
  LEGACY_RECOVERY_LIVE_QUEUE_STATES,
} from './legacy-recovery-live-registry';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import {
  LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES,
  LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES,
  legacyRecoveryLiveDigest,
  type LegacyRecoveryLiveIssue,
  type LegacyRecoveryLiveOutput,
  type LegacyRecoveryLiveRequest,
} from './legacy-recovery-live-protocol';
import type { LegacyRecoveryLiveRedis } from './legacy-recovery-live-redis';

export type LegacyRecoveryAdmissionRequest = Readonly<{
  version: 1;
  operation: 'admission_preview';
  sourceSha: string;
  imageId: string;
  selection: LegacyRecoveryLiveRequest['selection'];
}>;
export type LegacyRecoveryAdmissionOutput = Readonly<{
  version: 1;
  operation: 'admission_preview';
  applied: false;
  activationAuthorized: false;
  stoppingAuthorized: false;
  sourceSha: string;
  imageId: string;
  selectionSha256: string;
  decision: 'DENY';
  sourceCoverageComplete: false;
  selectedOwners: LegacyRecoveryLiveOutput['selectedOwners'];
  sqlPlans: LegacyRecoveryLiveOutput['sqlPlans'];
  queueCounts: readonly Readonly<{ queueName: string; states: readonly number[] }>[];
  minimumEffectRowsForTwoReads: number;
  issues: readonly LegacyRecoveryLiveIssue[];
  cost: LegacyRecoveryLiveOutput['cost'];
}>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid admission request');
  return value as Record<string, unknown>;
}
function strictKeys(row: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    throw new Error('Unknown admission field');
}
function ids(value: unknown, max: number): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > max ||
    value.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new Error('Invalid admission selection');
  return Object.freeze([...value].sort());
}

// FLAG: A live admission request deliberately contains no stopped-role assertion.
// This separate discriminator can neither fabricate offline proof nor authorize a stop.
export function parseLegacyRecoveryAdmissionRequest(input: string): LegacyRecoveryAdmissionRequest {
  if (Buffer.byteLength(input) > LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES)
    throw new Error('Admission request budget exceeded');
  const row = object(JSON.parse(input));
  strictKeys(row, ['version', 'operation', 'sourceSha', 'imageId', 'selection']);
  if (
    row.version !== 1 ||
    row.operation !== 'admission_preview' ||
    typeof row.sourceSha !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(row.sourceSha) ||
    typeof row.imageId !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(row.imageId)
  )
    throw new Error('Invalid admission identity');
  const selection = object(row.selection);
  strictKeys(selection, ['ownerWebhookEventIds', 'majorBotIds']);
  return Object.freeze({
    version: 1,
    operation: 'admission_preview',
    sourceSha: row.sourceSha,
    imageId: row.imageId,
    selection: Object.freeze({
      ownerWebhookEventIds: ids(selection.ownerWebhookEventIds, 200),
      majorBotIds: ids(selection.majorBotIds, 100),
    }),
  });
}

const onlineCounts = `-- legacy-live:online-admission-counts
local queues = cjson.decode(ARGV[1])
local states = {'wait','paused','active','delayed','prioritized','waiting-children','failed','completed'}
local result = {}
local probes = 0
for _, queue in ipairs(queues) do
  local row = {queue}
  for index, state in ipairs(states) do
    local key = 'bull:' .. queue .. ':' .. state
    local kind = redis.call('TYPE', key).ok
    probes = probes + 1
    local expected = index <= 3 and 'list' or 'zset'
    if kind ~= 'none' and kind ~= expected then return {0} end
    local count = 0
    if kind ~= 'none' then
      count = redis.call(index <= 3 and 'LLEN' or 'ZCARD', key)
      probes = probes + 1
    end
    table.insert(row, count)
  end
  table.insert(result, row)
end
local encoded = cjson.encode(result)
if string.len(encoded) > 65536 then return {0} end
return {1, probes, encoded}
`;

// FLAG: The current catalog still has unresolved SQL-parent families. Even an idle
// live preview is DENY. Only a future reviewed, complete collector may admit host review.
export async function collectLegacyRecoveryAdmission(
  tx: Prisma.TransactionClient,
  redis: LegacyRecoveryLiveRedis,
  request: LegacyRecoveryAdmissionRequest,
): Promise<LegacyRecoveryAdmissionOutput> {
  request = parseLegacyRecoveryAdmissionRequest(JSON.stringify(request));
  const issues: LegacyRecoveryLiveIssue[] = [
    { code: 'collector_source_coverage_incomplete', descriptor: 'inventory' },
  ];
  const cost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
  let minimumEffectRowsForTwoReads = 0;
  let queueCounts: { queueName: string; states: number[] }[] = [];
  let selectedOwners: LegacyRecoveryLiveOutput['selectedOwners'] = [];
  let sqlPlans: LegacyRecoveryLiveOutput['sqlPlans'] = [];
  const deadlineAtMs = Date.now() + LEGACY_RECOVERY_LIVE_BUDGET.durationMs;
  const charge = (next: typeof cost): void => {
    if (Date.now() >= deadlineAtMs) throw new Error('Online admission deadline exceeded');
    for (const key of ['pages', 'rows', 'probes', 'bytes'] as const) {
      if (
        !Number.isSafeInteger(next[key]) ||
        next[key] < 0 ||
        !Number.isSafeInteger(cost[key] + next[key]) ||
        cost[key] + next[key] > LEGACY_RECOVERY_LIVE_BUDGET[key]
      )
        throw new Error('Online admission accounting refused');
    }
    for (const key of ['pages', 'rows', 'probes', 'bytes'] as const) cost[key] += next[key];
  };
  try {
    const reply = await redis.eval_ro(
      onlineCounts,
      0,
      JSON.stringify(LEGACY_RECOVERY_LIVE_QUEUE_NAMES),
    );
    if (
      !Array.isArray(reply) ||
      reply.length !== 3 ||
      reply[0] !== 1 ||
      !Number.isSafeInteger(reply[1]) ||
      reply[1] < 0 ||
      typeof reply[2] !== 'string' ||
      Buffer.byteLength(reply[2]) > 64 * 1024
    )
      throw new Error('Online queue header refused');
    charge({ pages: 1, rows: 0, probes: reply[1], bytes: Buffer.byteLength(reply[2]) });
    const rows: unknown = JSON.parse(reply[2]);
    if (!Array.isArray(rows) || rows.length !== LEGACY_RECOVERY_LIVE_QUEUE_NAMES.length)
      throw new Error('Online queue catalog refused');
    queueCounts = rows.map((value, index) => {
      if (
        !Array.isArray(value) ||
        value.length !== LEGACY_RECOVERY_LIVE_QUEUE_STATES.length + 1 ||
        value[0] !== LEGACY_RECOVERY_LIVE_QUEUE_NAMES[index] ||
        value.slice(1).some((count) => !Number.isSafeInteger(count) || count < 0)
      )
        throw new Error('Online queue state refused');
      return { queueName: value[0] as string, states: value.slice(1) as number[] };
    });
    const effectRows = queueCounts
      .filter((row) => !isLegacyRecoveryWebhookQueue(row.queueName))
      .reduce((sum, row) => sum + row.states.reduce((a, b) => a + b, 0), 0);
    minimumEffectRowsForTwoReads = effectRows * 2;
    if (
      !Number.isSafeInteger(minimumEffectRowsForTwoReads) ||
      minimumEffectRowsForTwoReads > LEGACY_RECOVERY_LIVE_BUDGET.rows
    ) {
      issues.push({ code: 'effect_rows_exceed_two_read_budget', descriptor: 'redis:all' });
    } else {
      const sql = await inventoryLegacyRecoveryLiveSql(
        tx,
        { selection: request.selection },
        {
          ...LEGACY_RECOVERY_LIVE_BUDGET,
          pages: LEGACY_RECOVERY_LIVE_BUDGET.pages - cost.pages,
          probes: LEGACY_RECOVERY_LIVE_BUDGET.probes - cost.probes,
          bytes: LEGACY_RECOVERY_LIVE_BUDGET.bytes - cost.bytes,
          deadlineAtMs,
        },
      );
      charge(sql.cost);
      selectedOwners = sql.selectedOwners;
      sqlPlans = sql.proofs;
      issues.push(...sql.issues);
    }
  } catch {
    issues.push({ code: 'online_admission_store_or_budget_refused', descriptor: 'inventory' });
  }
  const result: LegacyRecoveryAdmissionOutput = {
    version: 1,
    operation: 'admission_preview',
    applied: false,
    activationAuthorized: false,
    stoppingAuthorized: false,
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    selectionSha256: legacyRecoveryLiveDigest(request.selection),
    decision: 'DENY',
    sourceCoverageComplete: false,
    selectedOwners,
    sqlPlans,
    queueCounts,
    minimumEffectRowsForTwoReads,
    issues,
    cost,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES)
    return {
      ...result,
      selectedOwners: [],
      sqlPlans: [],
      queueCounts: [],
      issues: [{ code: 'online_admission_output_budget_exceeded', descriptor: 'inventory' }],
    };
  return result;
}
