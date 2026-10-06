import type { MaxActionJob } from '../max/max-client.service';
import { MAX_ACTION_ALL_QUEUE_NAMES } from '../max/max-action.queue';
import {
  legacySnapshotDigest,
  type LegacyChildHoldInput,
} from '../webhook/webhook-legacy-cold-install';
import { readLegacyActionSourceScopes } from '../webhook/webhook-legacy-hold.service';
import { isLegacyRecoveryWebhookQueue } from './legacy-recovery-queue-inventory';
import {
  legacyRecoveryLiveDigest,
  type LegacyRecoveryLiveIssue,
  type LegacyRecoveryLivePlanProof,
  type LegacyRecoveryLiveRequest,
} from './legacy-recovery-live-protocol';
import {
  LEGACY_RECOVERY_LIVE_QUEUE_NAMES,
  LEGACY_RECOVERY_LIVE_QUEUE_STATES,
} from './legacy-recovery-live-registry';
import type {
  LegacyRecoverySqlSourceInput,
  LegacyRecoverySqlSourceResult,
} from './legacy-recovery-sql-source-resolver';
import { legacyRecoverySourceClosureDigest } from './legacy-recovery-source-closure';

export type LegacyRecoveryLiveSourceResolver = (
  input: LegacyRecoverySqlSourceInput,
  allowance: LegacyRecoveryLiveRedisAllowance,
) => Promise<LegacyRecoverySqlSourceResult>;

export type LegacyRecoveryLiveRedis = {
  eval_ro(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
};
export type LegacyRecoveryLiveRedisSource = Readonly<{
  chatId: string;
  messageId: string;
  userId: string;
  sourceAt: Date;
}>;
export type LegacyRecoveryLiveRedisCost = {
  pages: number;
  rows: number;
  probes: number;
  bytes: number;
};
export type LegacyRecoveryLiveRedisAllowance = Readonly<
  LegacyRecoveryLiveRedisCost & { deadlineAtMs: number }
>;
export type LegacyRecoveryLiveRedisProof = Readonly<{
  descriptor: string;
  sha256: string;
  rows: number;
  complete: true;
}>;
export type LegacyRecoveryLiveRedisResult = Readonly<{
  children: readonly LegacyChildHoldInput[];
  proofs: readonly LegacyRecoveryLiveRedisProof[];
  stableDigest: string;
  cost: Readonly<LegacyRecoveryLiveRedisCost>;
  issues: readonly LegacyRecoveryLiveIssue[];
  sqlPlans?: readonly LegacyRecoveryLivePlanProof[];
}>;

const maximum = { pages: 512, rows: 10_000, probes: 50_000, bytes: 8 * 1024 * 1024 };
const replyBytes = 64 * 1024;
const actionQueues = new Set<string>(MAX_ACTION_ALL_QUEUE_NAMES);
const queueNames = [...LEGACY_RECOVERY_LIVE_QUEUE_NAMES].sort();
export const LEGACY_RECOVERY_LIVE_REDIS_REGISTRY_SHA256 = legacyRecoveryLiveDigest({
  queues: queueNames,
  states: LEGACY_RECOVERY_LIVE_QUEUE_STATES,
  webhookOwnership: 'selected_exact_owner_ids_with_sql_complement',
  payloadBytes: 32 * 1024,
});

// FLAG: Every collector command is EVAL_RO. Bounds apply on the server before a
// payload crosses the connection; neither Queue construction nor pause/cleanup is allowed.
const catalogScript = `-- legacy-live:catalog
local result = redis.call('SCAN', ARGV[1], 'MATCH', 'bull:*', 'COUNT', 128)
if #result[2] > 200 then return {0, 'CATALOG_PAGE_OVERSIZED'} end
local bytes = 0
for _, key in ipairs(result[2]) do
  bytes = bytes + string.len(key)
  if string.len(key) > 1024 or bytes > 65536 then return {0, 'CATALOG_PAGE_OVERSIZED'} end
end
return {1, #result[2] + 1, result[1], result[2]}
`;

const headerScript = `-- legacy-live:headers
local function kind(key) return redis.call('TYPE', key).ok end
local fence = 'maxim:webhook-rollout:pause-owner:v1'
if kind(fence) ~= 'string' or redis.call('STRLEN', fence) > 256 or redis.call('GET', fence) ~= ARGV[2] then
  return {0, 'QUEUE_FENCE_UNVERIFIED'}
end
local queues = cjson.decode(ARGV[1])
local states = {'wait','paused','active','delayed','prioritized','waiting-children','failed','completed'}
local rows = {}
local probes = 3
for _, name in ipairs(queues) do
  local prefix = 'bull:' .. name .. ':'
  local meta = prefix .. 'meta'
  local mk = kind(meta)
  probes = probes + 1
  if mk ~= 'none' and mk ~= 'hash' then return {0, 'QUEUE_METADATA_TYPE_INVALID'} end
  local paused = ''
  local version = ''
  if mk == 'hash' then
    if redis.call('HSTRLEN', meta, 'paused') > 16 or redis.call('HSTRLEN', meta, 'version') > 128 then
      return {0, 'QUEUE_METADATA_OVERSIZED'}
    end
    paused = redis.call('HGET', meta, 'paused') or ''
    version = redis.call('HGET', meta, 'version') or ''
    probes = probes + 4
  end
  local counter = prefix .. 'id'
  local ck = kind(counter)
  probes = probes + 1
  if ck ~= 'none' and ck ~= 'string' then return {0, 'QUEUE_COUNTER_TYPE_INVALID'} end
  local generation = ''
  if ck == 'string' then
    if redis.call('STRLEN', counter) > 20 then return {0, 'QUEUE_COUNTER_OVERSIZED'} end
    generation = redis.call('GET', counter)
    probes = probes + 2
  end
  local row = {name, generation, paused, version}
  for i, state in ipairs(states) do
    local key = prefix .. state
    local k = kind(key)
    local expected = i <= 3 and 'list' or 'zset'
    probes = probes + 1
    if k ~= 'none' and k ~= expected then return {0, 'QUEUE_STATE_TYPE_INVALID'} end
    local count = 0
    if k ~= 'none' then
      count = redis.call(i <= 3 and 'LLEN' or 'ZCARD', key)
      probes = probes + 1
    end
    table.insert(row, count)
  end
  local repeatKey = prefix .. 'repeat'
  local rk = kind(repeatKey)
  probes = probes + 1
  if rk ~= 'none' and rk ~= 'zset' then return {0, 'QUEUE_REPEAT_TYPE_INVALID'} end
  table.insert(row, rk == 'none' and 0 or redis.call('ZCARD', repeatKey))
  probes = probes + (rk == 'none' and 0 or 1)
  table.insert(rows, row)
end
return {1, probes, rows}
`;

// Hash field names/lengths are bounded before HGETALL. Unknown hash fields remain
// in the digest, so changing a parent envelope cannot evade the aggregate's second read.
const readHashLua = `
local function readHash(key, canRead)
  local k = redis.call('TYPE', key).ok
  probes = probes + 1
  if k == 'none' then return nil, 0 end
  if k ~= 'hash' then return nil, -1 end
  if canRead == false then return nil, -4 end
  local count = redis.call('HLEN', key)
  probes = probes + 1
  if count == 0 or count > 32 then return nil, -2 end
  local names = redis.call('HKEYS', key)
  local size = 0
  probes = probes + 1
  for _, field in ipairs(names) do
    if string.len(field) > 128 then return nil, -2 end
    local n = redis.call('HSTRLEN', key, field)
    probes = probes + 1
    if n > 32768 then return nil, -2 end
    size = size + n + string.len(field) + 16
    if size > 45000 then return nil, -2 end
  end
  if bytes + size > 48000 then return nil, -3 end
  bytes = bytes + size
  probes = probes + 1
  return redis.call('HGETALL', key), size
end
`;

const jobsScript = `-- legacy-live:jobs
local probes = 0
local bytes = 0
${readHashLua}
local prefix = ARGV[1]
local state = ARGV[2]
local offset = tonumber(ARGV[3])
local take = tonumber(ARGV[4])
local isList = state == 'wait' or state == 'paused' or state == 'active'
local ids
if isList then ids = redis.call('LRANGE', prefix .. state, offset, offset + take - 1)
else ids = redis.call('ZRANGE', prefix .. state, offset, offset + take - 1, 'WITHSCORES') end
probes = probes + 1
local rows = {}
local step = isList and 1 or 2
for i = 1, #ids, step do
  local id = ids[i]
  if string.len(id) == 0 or string.len(id) > 512 then return {0, 'JOB_ID_INVALID'} end
  bytes = bytes + string.len(id) + string.len(state) + 192
  local hash, size = readHash(prefix .. id)
  if size == -3 and #rows > 0 then break end
  if not hash then return {0, (size == -2 or size == -3) and 'JOB_PAYLOAD_OVERSIZED' or 'JOB_HASH_MISSING_OR_INVALID'} end
  table.insert(rows, {id, state, hash, offset + (i - 1) / step, isList and '' or ids[i + 1]})
end
return {1, probes, #rows, rows}
`;

const ownersScript = `-- legacy-live:owners
local probes = 0
local bytes = 0
${readHashLua}
local prefix = ARGV[1]
local owners = cjson.decode(ARGV[2])
local start = tonumber(ARGV[3])
local maxProbes = tonumber(ARGV[4])
local maxRows = tonumber(ARGV[5])
local states = {'wait','paused','active','delayed','prioritized','waiting-children','failed','completed'}
local rows = {}
local processed = 0
for i = start + 1, #owners do
  if #rows >= 32 then break end
  if maxRows > 0 and #rows >= maxRows then break end
  if probes + 64 > maxProbes then return {0, 'REDIS_PROBE_BUDGET_EXCEEDED'} end
  local id = owners[i]
  bytes = bytes + string.len(id) + 192
  local hash, size = readHash(prefix .. id, #rows < maxRows)
  if size == -3 and processed > 0 then break end
  if size < 0 then return {0, size == -4 and 'REDIS_ROW_BUDGET_EXCEEDED' or (size == -2 or size == -3) and 'JOB_PAYLOAD_OVERSIZED' or 'JOB_HASH_MISSING_OR_INVALID'} end
  local memberships = {}
  for j, state in ipairs(states) do
    local key = prefix .. state
    local found = false
    local position = -1
    local score = ''
    if j <= 3 then
      local n = redis.call('LLEN', key)
      probes = probes + 1
      if n > 0 then
        if probes + n + 64 > maxProbes then return {0, 'REDIS_PROBE_BUDGET_EXCEEDED'} end
        local p = redis.call('LPOS', key, id, 'MAXLEN', n)
        found = p ~= false
        if found then position = p end
        probes = probes + n
      end
    else
      local s = redis.call('ZSCORE', key, id)
      found = s ~= false
      if found then
        score = s
        position = redis.call('ZRANK', key, id)
        probes = probes + 1
      end
      probes = probes + 1
    end
    if found then table.insert(memberships, {state, position, score}) end
  end
  if #memberships > 1 or (hash and #memberships ~= 1) or (not hash and #memberships ~= 0) then
    return {0, 'WEBHOOK_OWNER_STATE_INCONSISTENT'}
  end
  if hash then table.insert(rows, {id, memberships[1][1], hash, memberships[1][2], memberships[1][3]}) end
  processed = processed + 1
end
return {1, probes, processed, rows}
`;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function identity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim()
  );
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
class Refused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
type JobRead = {
  id: string;
  state: string;
  hash: Record<string, string>;
  data: unknown;
  position: number;
  score: string;
};
function decodeJobs(value: unknown): JobRead[] {
  if (!Array.isArray(value) || value.length > 200) throw new Refused('REDIS_REPLY_INVALID');
  return value.map((raw) => {
    if (
      !Array.isArray(raw) ||
      raw.length !== 5 ||
      !identity(raw[0]) ||
      !identity(raw[1]) ||
      !Array.isArray(raw[2]) ||
      !integer(raw[3]) ||
      typeof raw[4] !== 'string' ||
      raw[4].length > 128 ||
      (raw[4] !== '' && !Number.isFinite(Number(raw[4])))
    )
      throw new Refused('REDIS_REPLY_INVALID');
    const fields = raw[2];
    if (
      fields.length === 0 ||
      fields.length > 64 ||
      fields.length % 2 !== 0 ||
      fields.some((v) => typeof v !== 'string')
    )
      throw new Refused('JOB_HASH_MISSING_OR_INVALID');
    const hash: Record<string, string> = Object.create(null) as Record<string, string>;
    for (let i = 0; i < fields.length; i += 2) {
      if (Object.hasOwn(hash, fields[i])) throw new Refused('JOB_HASH_DUPLICATE_FIELD');
      hash[fields[i]] = fields[i + 1];
    }
    if (!Object.hasOwn(hash, 'data')) throw new Refused('JOB_DATA_MISSING');
    let data: unknown;
    try {
      data = JSON.parse(hash.data);
    } catch {
      throw new Refused('JOB_DATA_INVALID');
    }
    return { id: raw[0], state: raw[1], hash, data, position: raw[3], score: raw[4] };
  });
}

const metadata = new Set([
  'meta',
  'id',
  'wait',
  'paused',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
  'failed',
  'completed',
  'stalled',
  'stalled-check',
  'limiter',
  'marker',
  'events',
  'pc',
  'repeat',
  'metrics:completed',
  'metrics:completed:data',
  'metrics:failed',
  'metrics:failed:data',
]);
const sourceUserKeys = new Set(['userId', 'subjectUserId', 'senderId', 'sourceUserId', 'authorId']);
const sourceMessageKeys = new Set(['messageId', 'sourceMessageId', 'parentMessageId', 'mid']);
const sourceChatKeys = new Set(['chatId', 'sourceChatId', 'originChatId', 'targetChatId']);
const opaqueKeys = new Set([
  'parentKey',
  'parent',
  'rootIntentKey',
  'intentId',
  'deleteIntentId',
  'deliveryId',
  'publicationId',
  'markerId',
  'sessionId',
  'observationId',
  'sourceSendJobId',
  'sourceJobId',
  'parentJobId',
  'rjk',
  'nrjid',
]);
const knownLedgerSources = new Set([
  'moderationSource',
  'moderationRuleNotice',
  'requiredSubscriptionNotice',
  'duplicateNotice',
]);
const nonSourceIdentityKeys = new Set(['idempotencyKey', 'botId', 'primaryBotId', 'requiredBotId']);
const knownNestedKeys = new Set([
  'ledgerContext',
  'routing',
  'options',
  'sendAutoDelete',
  'messageLink',
  'binding',
  'candidateBotIds',
  'attemptedBotIds',
  'backoff',
  'removeOnComplete',
  'removeOnFail',
  ...knownLedgerSources,
]);

// FLAG: Inspect every nested source/routing envelope before deciding independence.
// An unrelated destination, new child clock or caller-labelled explicit request is
// never proof that an opaque parent did not originate from a held automatic source.
function provenance(
  job: JobRead,
  sources: readonly LegacyRecoveryLiveRedisSource[],
  owners: ReadonlySet<string>,
  consumeProbe: () => void,
): { related: boolean; opaque: boolean; relatedUser?: string } {
  let related = false;
  let opaque = false;
  let relatedUser: string | undefined;
  const users = new Set(sources.map((s) => s.userId));
  const messages = new Set(sources.map((s) => s.messageId));
  const visit = (value: unknown, depth: number, inheritedChat: readonly string[] = []): void => {
    consumeProbe();
    if (depth > 16) throw new Refused('PROVENANCE_DEPTH_EXCEEDED');
    if (Array.isArray(value)) {
      for (const item of value)
        if (item && typeof item === 'object') visit(item, depth + 1, inheritedChat);
      return;
    }
    const row = record(value);
    if (!row) return;
    const ownChat = [...sourceChatKeys].flatMap((key) =>
      identity(row[key]) ? [row[key] as string] : [],
    );
    const chat = ownChat.length ? ownChat : inheritedChat;
    for (const [key, item] of Object.entries(row)) {
      consumeProbe();
      if (sourceUserKeys.has(key) && identity(item) && users.has(item)) {
        related = true;
        relatedUser ??= item;
      }
      if (sourceMessageKeys.has(key) && identity(item) && messages.has(item)) {
        if (chat.length === 0) opaque = true;
        if (sources.some((s) => s.messageId === item && chat.includes(s.chatId))) related = true;
      }
      if (/^(?:owner|source|parent)?WebhookEventId$/iu.test(key) && identity(item)) {
        if (owners.has(item)) related = true;
        else opaque = true; // SQL ownership proof is required for another receipt.
      }
      if (opaqueKeys.has(key) && item !== undefined && item !== null && item !== '') opaque = true;
      if (
        /(?:Id|Key|Ref)$/u.test(key) &&
        item !== undefined &&
        item !== null &&
        item !== '' &&
        !sourceUserKeys.has(key) &&
        !sourceMessageKeys.has(key) &&
        !sourceChatKeys.has(key) &&
        !nonSourceIdentityKeys.has(key) &&
        !(key === 'jobId' && depth === 0 && item === job.id) &&
        !/^(?:owner|source|parent)?WebhookEventId$/iu.test(key)
      )
        opaque = true;
      if (item && typeof item === 'object' && !knownNestedKeys.has(key)) opaque = true;
      if (/^(?:origin|ancestry|source|request|authority|parent)$/iu.test(key)) opaque = true;
      if (
        key === 'routing' &&
        (!record(item) ||
          Object.keys(record(item)!).some(
            (name) =>
              ![
                'purpose',
                'primaryBotId',
                'reason',
                'action',
                'routingVersion',
                'sendRouteHalfOpenProbe',
                'sendRouteStickyProbe',
                'requiredBotId',
              ].includes(name),
          ))
      )
        opaque = true;
      if (
        key === 'ledgerContext' &&
        (!record(item) || Object.keys(record(item)!).some((name) => !knownLedgerSources.has(name)))
      )
        opaque = true;
      if (item && typeof item === 'object') visit(item, depth + 1, chat);
    }
  };
  visit(job.data, 0);
  for (const key of ['parentKey', 'parent', 'rjk', 'nrjid']) if (job.hash[key]) opaque = true;
  if (job.hash.opts) {
    let opts: unknown;
    try {
      opts = JSON.parse(job.hash.opts);
    } catch {
      throw new Refused('JOB_OPTIONS_INVALID');
    }
    if (!record(opts)) throw new Refused('JOB_OPTIONS_INVALID');
    visit(opts, 0);
    if (record(opts)?.repeat) opaque = true;
  }
  return { related, opaque, ...(relatedUser ? { relatedUser } : {}) };
}

/** Read-only finite evidence. The caller must compare a second collection under
 * the same SQL ownership snapshot; this result alone never authorizes activation. */
export async function inventoryLegacyRecoveryLiveRedis(
  redis: LegacyRecoveryLiveRedis,
  request: LegacyRecoveryLiveRequest,
  sources: readonly LegacyRecoveryLiveRedisSource[],
  allowance: LegacyRecoveryLiveRedisAllowance,
  resolveSqlSource?: LegacyRecoveryLiveSourceResolver,
): Promise<LegacyRecoveryLiveRedisResult> {
  return inventoryLegacyRecoveryRedis(redis, request, sources, allowance, false, resolveSqlSource);
}

export async function inventoryLegacyRecoverySelectedRedis(
  redis: LegacyRecoveryLiveRedis,
  request: LegacyRecoveryLiveRequest,
  sources: readonly LegacyRecoveryLiveRedisSource[],
  allowance: LegacyRecoveryLiveRedisAllowance,
): Promise<LegacyRecoveryLiveRedisResult> {
  return inventoryLegacyRecoveryRedis(
    redis,
    request,
    sources,
    { ...allowance, bytes: Math.min(allowance.bytes, maximum.bytes) },
    true,
  );
}

async function inventoryLegacyRecoveryRedis(
  redis: LegacyRecoveryLiveRedis,
  request: LegacyRecoveryLiveRequest,
  sources: readonly LegacyRecoveryLiveRedisSource[],
  allowance: LegacyRecoveryLiveRedisAllowance,
  sourceClosure: boolean,
  resolveSqlSource?: LegacyRecoveryLiveSourceResolver,
): Promise<LegacyRecoveryLiveRedisResult> {
  const cost: LegacyRecoveryLiveRedisCost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
  const issues: LegacyRecoveryLiveIssue[] = [];
  const proofs: LegacyRecoveryLiveRedisProof[] = [];
  const sqlPlans: LegacyRecoveryLivePlanProof[] = [];
  const children = new Map<string, LegacyChildHoldInput>();
  const issue = (code: string, descriptor: string): void => {
    if (!issues.some((v) => v.code === code && v.descriptor === descriptor))
      issues.push({ code, descriptor });
  };
  const check = (): void => {
    if (Date.now() >= allowance.deadlineAtMs) throw new Refused('REDIS_DEADLINE_EXCEEDED');
    for (const key of ['pages', 'rows', 'probes', 'bytes'] as const)
      if (cost[key] > allowance[key]) throw new Refused('REDIS_TOTAL_BUDGET_EXCEEDED');
  };
  const probe = (): void => {
    if (cost.probes >= allowance.probes) throw new Refused('REDIS_TOTAL_BUDGET_EXCEEDED');
    cost.probes += 1;
    check();
  };
  const read = async (script: string, args: string[]): Promise<unknown[]> => {
    check();
    if (
      cost.pages >= allowance.pages ||
      allowance.bytes - cost.bytes < replyBytes ||
      cost.probes >= allowance.probes
    )
      throw new Refused('REDIS_TOTAL_BUDGET_EXCEEDED');
    const reserveProbes =
      script === headerScript
        ? queueNames.length * 32 + 4
        : script === catalogScript
          ? 201
          : script === jobsScript
            ? 1 + Number(args[3]) * 37
            : 64;
    if (allowance.probes - cost.probes < reserveProbes)
      throw new Refused('REDIS_TOTAL_BUDGET_EXCEEDED');
    cost.pages += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reply: unknown;
    try {
      reply = await Promise.race([
        redis.eval_ro(script, 0, ...args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Refused('REDIS_DEADLINE_EXCEEDED')),
            Math.max(1, allowance.deadlineAtMs - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const bytes = Buffer.byteLength(JSON.stringify(reply) ?? 'null');
    cost.bytes += bytes;
    if (bytes > replyBytes) throw new Refused('REDIS_REPLY_OVERSIZED');
    if (!Array.isArray(reply) || reply[0] !== 1) {
      const code =
        Array.isArray(reply) && typeof reply[1] === 'string' && /^[A-Z_]{1,64}$/u.test(reply[1])
          ? reply[1]
          : 'REDIS_REPLY_INVALID';
      throw new Refused(code);
    }
    if (!integer(reply[1])) throw new Refused('REDIS_COST_INVALID');
    cost.probes += reply[1];
    check();
    return reply;
  };
  let descriptor = 'redis-inventory';
  try {
    if (
      !integer(allowance.deadlineAtMs) ||
      allowance.deadlineAtMs <= Date.now() ||
      allowance.deadlineAtMs > Date.now() + 60_000
    )
      throw new Refused('REDIS_ALLOWANCE_INVALID');
    for (const key of ['pages', 'rows', 'probes', 'bytes'] as const)
      if (!integer(allowance[key]) || allowance[key] > maximum[key])
        throw new Refused('REDIS_ALLOWANCE_INVALID');
    if (
      !sources.length ||
      sources.length > 200 ||
      sources.some(
        (s) =>
          !identity(s.chatId) ||
          !identity(s.messageId) ||
          !identity(s.userId) ||
          !(s.sourceAt instanceof Date) ||
          !Number.isFinite(s.sourceAt.getTime()),
      )
    )
      throw new Refused('REDIS_SOURCE_SCOPE_INVALID');
    if (
      !request.selection.ownerWebhookEventIds.length ||
      request.selection.ownerWebhookEventIds.length > 200 ||
      request.selection.ownerWebhookEventIds.some((id) => !identity(id))
    )
      throw new Refused('REDIS_OWNER_SELECTION_INVALID');
    const owners = [...request.selection.ownerWebhookEventIds].sort();
    if (new Set(owners).size !== owners.length) throw new Refused('REDIS_OWNER_SELECTION_INVALID');
    const headerArgs = [JSON.stringify(queueNames), `rollout:${request.binding.queueFenceNonce}`];
    descriptor = 'redis-headers';
    const headersBefore = (await read(headerScript, headerArgs))[2];
    if (!Array.isArray(headersBefore) || headersBefore.length !== queueNames.length)
      throw new Refused('REDIS_HEADER_INCOMPLETE');
    const headers = new Map<string, unknown[]>();
    let effectRows = 0;
    for (const row of headersBefore) {
      if (
        !Array.isArray(row) ||
        row.length !== 13 ||
        typeof row[0] !== 'string' ||
        !queueNames.includes(row[0] as never) ||
        headers.has(row[0]) ||
        row.slice(4).some((n) => !integer(n))
      )
        throw new Refused('REDIS_HEADER_INVALID');
      headers.set(row[0], row);
      if (isLegacyRecoveryWebhookQueue(row[0]) && row[2] !== '1')
        issue('WEBHOOK_QUEUE_NOT_PAUSED', row[0]);
      if (!sourceClosure && row[12] !== 0) issue('FUTURE_SCHEDULER_PROVENANCE_UNKNOWN', row[0]);
      if (!isLegacyRecoveryWebhookQueue(row[0]))
        effectRows += row.slice(4, 12).reduce<number>((n, count) => n + (count as number), 0);
    }
    // FLAG: The aggregate requires two complete reads with one 10,000-row budget.
    // Refuse an impossible known lower bound before loading thousands of payloads.
    // Remaining allowance is not doubled here: this also runs during the second read.
    if (!sourceClosure && (!Number.isSafeInteger(effectRows) || effectRows * 2 > maximum.rows))
      throw new Refused('REDIS_DOUBLE_READ_ROW_BUDGET_EXCEEDED');
    const catalog = new Set<string>();
    let cursor = '0';
    const cursors = new Set<string>();
    if (!sourceClosure)
      do {
        descriptor = 'redis-catalog';
        const reply = await read(catalogScript, [cursor]);
        if (
          typeof reply[2] !== 'string' ||
          !/^[0-9]{1,20}$/u.test(reply[2]) ||
          !Array.isArray(reply[3]) ||
          reply[3].length > 200 ||
          reply[3].some((key) => typeof key !== 'string')
        )
          throw new Refused('REDIS_CATALOG_INVALID');
        cursor = reply[2];
        if (cursor !== '0' && cursors.has(cursor))
          throw new Refused('REDIS_CATALOG_CURSOR_REPEATED');
        cursors.add(cursor);
        for (const key of reply[3] as string[]) {
          const match = /^bull:([^:]+):(.+)$/u.exec(key);
          if (!match || !headers.has(match[1]))
            issue('UNKNOWN_QUEUE_NAMESPACE', legacyRecoveryLiveDigest(key));
          catalog.add(key);
        }
      } while (cursor !== '0');
    proofs.push({
      descriptor: sourceClosure ? 'reviewed-source-continuation-closure' : 'redis-catalog',
      sha256: sourceClosure
        ? legacyRecoverySourceClosureDigest(request.binding.sourceSha, request.binding.imageId)
        : legacyRecoveryLiveDigest([...catalog].sort()),
      rows: catalog.size,
      complete: true,
    });
    const selectedFound = new Set<string>();
    for (const name of queueNames) {
      descriptor = name;
      const row = headers.get(name)!;
      const jobs: JobRead[] = [];
      if (isLegacyRecoveryWebhookQueue(name)) {
        let offset = 0;
        do {
          const reply = await read(ownersScript, [
            `bull:${name}:`,
            JSON.stringify(owners),
            String(offset),
            String(allowance.probes - cost.probes),
            String(Math.min(32, allowance.rows - cost.rows)),
          ]);
          if (!integer(reply[2]) || reply[2] === 0 || offset + reply[2] > owners.length)
            throw new Refused('WEBHOOK_OWNER_INCOMPLETE');
          const page = decodeJobs(reply[3]);
          cost.rows += page.length;
          check();
          for (const job of page) {
            if (
              !owners.slice(offset, offset + reply[2]).includes(job.id) ||
              Object.keys(record(job.data) ?? {}).length !== 1 ||
              record(job.data)?.webhookEventId !== job.id
            )
              throw new Refused('WEBHOOK_OWNER_PAYLOAD_MISMATCH');
            if (selectedFound.has(job.id)) throw new Refused('WEBHOOK_OWNER_MULTIPLE_QUEUES');
            selectedFound.add(job.id);
            if (job.hash.parent || job.hash.parentKey || job.hash.rjk || job.hash.nrjid)
              throw new Refused('WEBHOOK_OWNER_ANCESTRY_UNKNOWN');
            if (job.hash.opts) {
              let opts: unknown;
              try {
                opts = JSON.parse(job.hash.opts);
              } catch {
                throw new Refused('JOB_OPTIONS_INVALID');
              }
              if (!record(opts) || record(opts)?.parent || record(opts)?.repeat)
                throw new Refused('WEBHOOK_OWNER_ANCESTRY_UNKNOWN');
            }
          }
          jobs.push(...page);
          offset += reply[2];
        } while (offset < owners.length);
      } else if (!sourceClosure) {
        const states = new Set<string>();
        for (let i = 0; i < LEGACY_RECOVERY_LIVE_QUEUE_STATES.length; i += 1) {
          const state = LEGACY_RECOVERY_LIVE_QUEUE_STATES[i];
          const count = row[i + 4] as number;
          let offset = 0;
          while (offset < count) {
            if (cost.rows >= allowance.rows) throw new Refused('REDIS_TOTAL_BUDGET_EXCEEDED');
            const reply = await read(jobsScript, [
              `bull:${name}:`,
              state,
              String(offset),
              String(Math.min(32, count - offset, allowance.rows - cost.rows)),
            ]);
            const page = decodeJobs(reply[3]);
            if (
              !integer(reply[2]) ||
              reply[2] !== page.length ||
              page.length === 0 ||
              offset + page.length > count
            )
              throw new Refused('QUEUE_STATE_INCOMPLETE');
            cost.rows += page.length;
            check();
            for (const job of page) {
              if (job.state !== state || states.has(job.id))
                throw new Refused('JOB_MULTIPLE_STATES');
              states.add(job.id);
              const p = provenance(job, sources, new Set(owners), probe);
              if (!actionQueues.has(name)) {
                if (
                  resolveSqlSource &&
                  (name === 'commercial-image-ocr' ||
                    name === 'photo-duplicates' ||
                    name === 'message-duplicates')
                ) {
                  // FLAG: Only this server-owned resolver can discharge an exact SQL
                  // receipt pointer. Bull flow/scheduler ancestry remains independently refused.
                  const envelope = provenance(
                    { ...job, data: {} },
                    sources,
                    new Set(owners),
                    probe,
                  );
                  if (envelope.related || envelope.opaque) {
                    issue('NON_MAX_PARENT_PROVENANCE_UNKNOWN', name);
                    continue;
                  }
                  check();
                  const resolved = await resolveSqlSource(
                    {
                      queueName: name,
                      jobId: job.id,
                      jobPayloadDigest: legacySnapshotDigest(job.data),
                      data: job.data,
                    },
                    {
                      pages: allowance.pages - cost.pages,
                      rows: allowance.rows - cost.rows,
                      probes: allowance.probes - cost.probes,
                      bytes: allowance.bytes - cost.bytes,
                      deadlineAtMs: allowance.deadlineAtMs,
                    },
                  );
                  for (const key of ['pages', 'rows', 'probes', 'bytes'] as const) {
                    if (!integer(resolved.cost[key])) throw new Refused('SQL_SOURCE_COST_INVALID');
                    cost[key] += resolved.cost[key];
                  }
                  check();
                  sqlPlans.push(...resolved.plans);
                  for (const row of resolved.issues) issue(row.code, row.descriptor);
                  proofs.push({
                    descriptor: `${name}:source:${legacyRecoveryLiveDigest(job.id)}`,
                    sha256: resolved.proofSha256,
                    rows: 1,
                    complete: true,
                  });
                  if (
                    resolved.decision !== 'INDEPENDENT' ||
                    !resolved.source ||
                    p.related ||
                    resolved.issues.length
                  ) {
                    issue(
                      resolved.decision === 'RELATED_UNSUPPORTED' || p.related
                        ? 'RELATED_NON_MAX_WORK_REQUIRES_DISPOSITION'
                        : 'NON_MAX_PARENT_PROVENANCE_UNKNOWN',
                      name,
                    );
                  }
                  continue;
                }
                issue(
                  p.related
                    ? 'RELATED_NON_MAX_WORK_REQUIRES_DISPOSITION'
                    : 'NON_MAX_PARENT_PROVENANCE_UNKNOWN',
                  name,
                );
                continue;
              }
              const data = record(job.data);
              if (
                !data ||
                !identity(data.idempotencyKey) ||
                !identity(data.chatId) ||
                ![
                  'SEND_MESSAGE',
                  'DELETE_MESSAGE',
                  'BAN_MEMBER',
                  'KICK_MEMBER',
                  'UNBAN_MEMBER',
                  'TRY_UNBAN_MEMBER',
                  'NOTIFY_MODERATORS',
                ].includes(String(data.actionType))
              ) {
                issue('MAX_CHILD_SOURCE_UNVERIFIED', name);
                continue;
              }
              let scopes: ReturnType<typeof readLegacyActionSourceScopes>;
              try {
                scopes = readLegacyActionSourceScopes(data as unknown as MaxActionJob);
              } catch {
                issue('MAX_CHILD_SOURCE_CONFLICT', name);
                continue;
              }
              const relatedScope = scopes.find((scope) =>
                sources.some(
                  (source) =>
                    scope.userId === source.userId ||
                    (scope.chatId === source.chatId && scope.messageId === source.messageId),
                ),
              );
              if (p.related || relatedScope) {
                const child: LegacyChildHoldInput = {
                  jobKey: data.idempotencyKey,
                  queueName: name,
                  jobPayloadDigest: legacySnapshotDigest(job.data),
                  chatId: data.chatId,
                  ...(identity(data.messageId) ? { messageId: data.messageId } : {}),
                  ...(identity(data.userId)
                    ? { userId: data.userId }
                    : p.relatedUser
                      ? { userId: p.relatedUser }
                      : relatedScope?.userId
                        ? { userId: relatedScope.userId }
                        : {}),
                };
                const prior = children.get(child.jobKey);
                if (prior && legacySnapshotDigest(prior) !== legacySnapshotDigest(child))
                  issue('MAX_CHILD_IDENTITY_CONFLICT', name);
                else children.set(child.jobKey, child);
                if (!sources.some((source) => source.chatId === child.chatId))
                  issue('CROSS_CHAT_CHILD_INSTALL_UNSUPPORTED', name);
              } else {
                const sourceProof = scopes.some(
                  (scope) => identity(scope.userId) && identity(scope.messageId),
                );
                const memberProof =
                  ['BAN_MEMBER', 'KICK_MEMBER', 'UNBAN_MEMBER', 'TRY_UNBAN_MEMBER'].includes(
                    String(data.actionType),
                  ) && identity(data.userId);
                if (!sourceProof && !memberProof) issue('MAX_CHILD_SOURCE_UNVERIFIED', name);
              }
              if (p.opaque) issue('MAX_CHILD_PARENT_PROVENANCE_UNKNOWN', name);
            }
            jobs.push(...page);
            offset += page.length;
          }
        }
        for (const key of catalog) {
          const prefix = `bull:${name}:`;
          if (!key.startsWith(prefix)) continue;
          const suffix = key.slice(prefix.length);
          if (metadata.has(suffix) || states.has(suffix)) continue;
          const auxiliary = /^(.*):(lock|logs|dependencies|processed|failed|unsuccessful)$/u.exec(
            suffix,
          );
          if (auxiliary && states.has(auxiliary[1]) && ['lock', 'logs'].includes(auxiliary[2]))
            continue;
          issue('UNCLASSIFIED_QUEUE_KEY', name);
        }
      }
      proofs.push({
        descriptor: name,
        sha256: legacyRecoveryLiveDigest({
          header: row,
          jobs: jobs
            .map((job) => ({
              id: job.id,
              state: job.state,
              hash: job.hash,
              position: job.position,
              score: job.score,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        }),
        rows: jobs.length,
        complete: true,
      });
    }
    descriptor = 'redis-headers';
    const headersAfter = (await read(headerScript, headerArgs))[2];
    if (legacyRecoveryLiveDigest(headersBefore) !== legacyRecoveryLiveDigest(headersAfter))
      throw new Refused('REDIS_GENERATION_CHANGED');
    proofs.push({
      descriptor: 'redis-generation',
      sha256: legacyRecoveryLiveDigest({ binding: request.binding, headers: headersBefore }),
      rows: headers.size,
      complete: true,
    });
  } catch (error) {
    issue(error instanceof Refused ? error.code : 'REDIS_READ_FAILED', descriptor);
  }
  const sortedChildren = [...children.values()].sort((a, b) => a.jobKey.localeCompare(b.jobKey));
  const sortedProofs = [...proofs].sort((a, b) => a.descriptor.localeCompare(b.descriptor));
  const sortedIssues = [...issues].sort(
    (a, b) => a.code.localeCompare(b.code) || a.descriptor.localeCompare(b.descriptor),
  );
  return Object.freeze({
    children: Object.freeze(sortedChildren),
    proofs: Object.freeze(sortedProofs),
    stableDigest: legacyRecoveryLiveDigest({
      registry: LEGACY_RECOVERY_LIVE_REDIS_REGISTRY_SHA256,
      binding: request.binding,
      selection: request.selection,
      sources,
      children: sortedChildren,
      proofs: sortedProofs,
      issues: sortedIssues,
    }),
    cost: Object.freeze(cost),
    issues: Object.freeze(sortedIssues),
    sqlPlans: Object.freeze(sqlPlans),
  });
}
