'use strict';

const { createHash } = require('node:crypto');

const LEGACY_VK_PUBLISH_QUEUE = 'vk-parsing-publish';
const OBLITERATE_BATCH_SIZE = 1_000;
const ORPHAN_LIMITS = Object.freeze({
  databaseKeys: 12_000_000,
  scanCount: 4096,
  scanPages: 4096,
  workHints: 16_000_000,
  keys: 10_000,
  keyBytes: 4 * 1024 * 1024,
  hashBytes: 32 * 1024 * 1024,
  passMs: 15_000,
  callMs: 50,
  batch: 32,
});
const ORPHAN_PREFIX = `bull:${LEGACY_VK_PUBLISH_QUEUE}:`;
const ORPHAN_FIELDS = Object.freeze(['data', 'delay', 'name', 'opts', 'priority', 'timestamp']);
const EMPTY_QUEUE_SUFFIXES = Object.freeze([
  'active',
  'wait',
  'paused',
  'delayed',
  'prioritized',
  'waiting-children',
  'completed',
  'failed',
  'repeat',
  'meta',
  'id',
  'events',
  'stalled',
  'stalled-check',
  'limiter',
  'marker',
  'pc',
  'de',
  'scheduler',
]);

// FLAG: SCAN must reach cursor zero over the entire keyspace. COUNT is only a work
// hint; both returned bytes and actual Redis script time are bounded independently.
const ORPHAN_SCAN_LUA = `-- legacy-vk-orphan:scan
local began = redis.call('TIME')
if redis.call('DBSIZE') > 12000000 then return {'database_budget'} end
local page = redis.call('SCAN', ARGV[1], 'MATCH', 'bull:vk-parsing-publish:*', 'COUNT', 4096)
if #page[2] > 512 then return {'page_key_budget'} end
local bytes = 0
for _, key in ipairs(page[2]) do
  if #key > 1024 then return {'key_budget'} end
  bytes = bytes + #key
end
if bytes > 131072 then return {'page_byte_budget'} end
local ended = redis.call('TIME')
local micros = (tonumber(ended[1])-tonumber(began[1]))*1000000 + tonumber(ended[2])-tonumber(began[2])
if micros > 50000 then return {'call_budget'} end
return {'ok', page[1], page[2], micros}
`;

// FLAG: Only the exact initial hash emitted by the retired producer is eligible.
// Absence of attempt fields is a queue-state proof, never proof of remote outcome.
// Unknown fields, result/attempt evidence and all related keys remain untouched.
const ORPHAN_HASH_GUARD_LUA = `
local prefix = 'bull:vk-parsing-publish:'
local fields = {'data','delay','name','opts','priority','timestamp'}
local stateKeys = {'active','wait','paused','delayed','prioritized','waiting-children','completed','failed','repeat','meta','id','events','stalled','stalled-check','limiter','marker','pc','de','scheduler'}
local function fail(code) return {code} end
local function exactKeys(value, allowed)
  if type(value) ~= 'table' then return false end
  local count = 0
  for key, _ in pairs(value) do
    local known = false
    for _, expected in ipairs(allowed) do if key == expected then known = true end end
    if not known then return false end
    count = count + 1
  end
  return count == #allowed
end
local function identity(value)
  return type(value) == 'string' and #value > 0 and #value <= 512 and string.match(value, '^[%w_-]+$') ~= nil
end
for _, suffix in ipairs(stateKeys) do
  if redis.call('EXISTS', prefix .. suffix) ~= 0 then return fail('ordinary_queue_key_present') end
end
if #KEYS < 1 or #KEYS > 32 then return fail('hash_batch_budget') end
local rows = {}
for _, key in ipairs(KEYS) do
  if #key > 1024 or string.sub(key, 1, #prefix) ~= prefix then return fail('key_scope_unproved') end
  if redis.call('TYPE', key).ok ~= 'hash' or redis.call('PTTL', key) ~= -1 or redis.call('HLEN', key) ~= 6 then return fail('initial_hash_unproved') end
  for _, suffix in ipairs({':lock',':logs',':dependencies',':processed',':failed',':unsuccessful',':waiting-children',':repeat',':parent'}) do
    if redis.call('EXISTS', key .. suffix) ~= 0 then return fail('related_key_present') end
  end
  local values = {}
  local bytes = #key
  for _, field in ipairs(fields) do
    local size = redis.call('HSTRLEN', key, field)
    if size < 1 or size > 4096 then return fail('hash_field_budget') end
    bytes = bytes + size
    if bytes > 8192 then return fail('hash_byte_budget') end
    table.insert(values, redis.call('HGET', key, field))
  end
  local okData, data = pcall(cjson.decode, values[1])
  local okOpts, opts = pcall(cjson.decode, values[4])
  if not okData or not okOpts or
    not exactKeys(data, {'postId','chatId','reason','idempotencyKey','retryPolicyName','createdAt'}) or
    not exactKeys(opts, {'attempts','delay','jobId','removeOnComplete','backoff','removeOnFail'}) or
    not exactKeys(opts.backoff, {'type','delay'}) then return fail('producer_envelope_unproved') end
  if not identity(data.postId) or not identity(data.idempotencyKey) or
    type(data.chatId) ~= 'string' or #data.chatId > 128 or not string.match(data.chatId, '^%-[%w_-]+$') or
    (data.reason ~= 'autopublish' and data.reason ~= 'manual-retry' and data.reason ~= 'manual-schedule') or
    data.retryPolicyName ~= 'vk-parsing-publish' or type(data.createdAt) ~= 'string' or
    not string.match(data.createdAt, '^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$') or
    opts.jobId ~= 'vk-parsing-publish__' .. data.postId .. '__' .. data.idempotencyKey or
    key ~= prefix .. opts.jobId or opts.attempts ~= 5 or opts.removeOnComplete ~= true or
    opts.removeOnFail ~= 1000 or opts.backoff.type ~= 'exponential' or opts.backoff.delay ~= 5000 or
    type(opts.delay) ~= 'number' or opts.delay < 0 or opts.delay > 9007199254740991 or opts.delay ~= math.floor(opts.delay) or
    values[2] ~= tostring(opts.delay) or values[3] ~= 'publish-vk-post' or values[5] ~= '0' or
    not string.match(values[6], '^%d+$') or tonumber(values[6]) <= 0 or tonumber(values[6]) > 9007199254740991
    then return fail('producer_values_unproved') end
  table.insert(rows, {key, values})
end
`;
const ORPHAN_READ_LUA = `-- legacy-vk-orphan:read
local began = redis.call('TIME')
${ORPHAN_HASH_GUARD_LUA}
local ended = redis.call('TIME')
local micros = (tonumber(ended[1])-tonumber(began[1]))*1000000 + tonumber(ended[2])-tonumber(began[2])
if micros > 50000 then return {'call_budget'} end
return {'ok', rows, micros}
`;
const ORPHAN_DELETE_LUA = `-- legacy-vk-orphan:delete
local began = redis.call('TIME')
local deadline = tonumber(ARGV[1])
local currentMs = tonumber(began[1])*1000 + math.floor(tonumber(began[2])/1000)
if not deadline or currentMs >= deadline or deadline-currentMs > 120000 then return {'apply_deadline'} end
${ORPHAN_HASH_GUARD_LUA}
if #ARGV ~= 1 + #rows * 6 then return {'cas_shape'} end
for i, row in ipairs(rows) do
  for j, value in ipairs(row[2]) do
    if value ~= ARGV[1 + (i-1)*6 + j] then return {'hash_changed'} end
  end
end
local checked = redis.call('TIME')
local micros = (tonumber(checked[1])-tonumber(began[1]))*1000000 + tonumber(checked[2])-tonumber(began[2])
if micros > 50000 or tonumber(checked[1])*1000 + math.floor(tonumber(checked[2])/1000) >= deadline then return {'apply_deadline'} end
local removed = 0
for _, row in ipairs(rows) do removed = removed + redis.call('DEL', row[1]) end
return {'ok', removed}
`;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function validateOrphanBinding(binding) {
  if (
    !binding ||
    !/^[0-9a-f]{40}$/u.test(binding.sourceSha ?? '') ||
    !/^sha256:[0-9a-f]{64}$/u.test(binding.imageId ?? '') ||
    !/^[0-9a-f]{64}$/u.test(binding.fleetDigest ?? '') ||
    Object.keys(binding).sort().join(',') !== 'fleetDigest,imageId,sourceSha'
  )
    throw new QueueCleanupPreconditionError('exact_retired_runtime_required');
  return binding;
}
async function collectLegacyVkPublishOrphans(queue) {
  const client = await queue.client;
  if (typeof client?.eval_ro !== 'function')
    throw new QueueCleanupPreconditionError('redis_readonly_required');
  const started = Date.now();
  const cost = { pages: 0, workHints: 0, keys: 0, keyBytes: 0, hashBytes: 0, calls: 0 };
  const keys = new Set();
  const invoke = async (script, keyCount, ...args) => {
    if (Date.now() - started >= ORPHAN_LIMITS.passMs)
      throw new QueueCleanupPreconditionError('namespace_time_budget');
    const before = Date.now();
    const result = await client.eval_ro(script, keyCount, ...args);
    cost.calls += 1;
    if (Date.now() - before > ORPHAN_LIMITS.callMs || Date.now() - started >= ORPHAN_LIMITS.passMs)
      throw new QueueCleanupPreconditionError('namespace_time_budget');
    if (
      Array.isArray(result) &&
      [
        'database_budget',
        'page_key_budget',
        'key_budget',
        'page_byte_budget',
        'call_budget',
        'hash_field_budget',
        'hash_byte_budget',
      ].includes(result[0])
    )
      throw new QueueCleanupPreconditionError(`namespace_${result[0]}`);
    if (!Array.isArray(result) || result[0] !== 'ok')
      throw new QueueCleanupPreconditionError('namespace_shape_unproved');
    return result;
  };
  let cursor = '0';
  do {
    cost.pages += 1;
    cost.workHints += ORPHAN_LIMITS.scanCount;
    if (cost.pages > ORPHAN_LIMITS.scanPages || cost.workHints > ORPHAN_LIMITS.workHints)
      throw new QueueCleanupPreconditionError('namespace_scan_budget');
    const page = await invoke(ORPHAN_SCAN_LUA, 0, cursor);
    if (
      typeof page[1] !== 'string' ||
      !/^[0-9]+$/u.test(page[1]) ||
      !Array.isArray(page[2]) ||
      page[2].length > 512 ||
      !Number.isSafeInteger(page[3]) ||
      page[3] < 0 ||
      page[3] > 50_000
    )
      throw new QueueCleanupPreconditionError('namespace_page_unproved');
    cursor = page[1];
    for (const key of page[2]) {
      if (
        typeof key !== 'string' ||
        !key.startsWith(ORPHAN_PREFIX) ||
        Buffer.byteLength(key) > 1024
      )
        throw new QueueCleanupPreconditionError('namespace_key_unproved');
      cost.keyBytes += Buffer.byteLength(key);
      if (!keys.has(key)) {
        keys.add(key);
        cost.keys += 1;
      }
      if (cost.keys > ORPHAN_LIMITS.keys || cost.keyBytes > ORPHAN_LIMITS.keyBytes)
        throw new QueueCleanupPreconditionError('namespace_key_budget');
    }
  } while (cursor !== '0');
  const sorted = [...keys].sort();
  const rows = [];
  for (let offset = 0; offset < sorted.length; offset += ORPHAN_LIMITS.batch) {
    const batch = sorted.slice(offset, offset + ORPHAN_LIMITS.batch);
    const result = await invoke(ORPHAN_READ_LUA, batch.length, ...batch);
    if (!Array.isArray(result[1]) || result[1].length !== batch.length)
      throw new QueueCleanupPreconditionError('namespace_hash_unproved');
    for (let index = 0; index < batch.length; index += 1) {
      const row = result[1][index];
      if (
        !Array.isArray(row) ||
        row[0] !== batch[index] ||
        !Array.isArray(row[1]) ||
        row[1].length !== ORPHAN_FIELDS.length ||
        row[1].some((value) => typeof value !== 'string' || Buffer.byteLength(value) > 4096)
      )
        throw new QueueCleanupPreconditionError('namespace_hash_unproved');
      // FLAG: The historical producer used JSON.stringify. Reject duplicate JSON
      // keys or lossy numeric/calendar forms before binding exact bytes to a CAS.
      try {
        const data = JSON.parse(row[1][0]);
        const opts = JSON.parse(row[1][3]);
        const timestamp = Number(row[1][5]);
        if (
          JSON.stringify(data) !== row[1][0] ||
          JSON.stringify(opts) !== row[1][3] ||
          new Date(data.createdAt).toISOString() !== data.createdAt ||
          !Number.isSafeInteger(timestamp) ||
          timestamp <= 0 ||
          String(timestamp) !== row[1][5]
        )
          throw new Error('noncanonical');
      } catch {
        throw new QueueCleanupPreconditionError('producer_encoding_unproved');
      }
      cost.hashBytes += row[1].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
      if (cost.hashBytes > ORPHAN_LIMITS.hashBytes)
        throw new QueueCleanupPreconditionError('namespace_hash_budget');
      rows.push(row);
    }
  }
  return { rows, cost };
}

async function cleanupLegacyVkPublishOrphans(
  queue,
  { apply, reviewedDigest, binding, before, deadlineMs },
) {
  const checkAbsentCounters = async () => {
    const state = await inspectLegacyVkPublishQueue(queue);
    if (state.present || state.workerCount || state.totalJobs)
      throw new QueueCleanupPreconditionError('orphan_queue_became_active', state);
  };
  await checkAbsentCounters();
  const first = await collectLegacyVkPublishOrphans(queue);
  await checkAbsentCounters();
  const common = {
    version: 2,
    mode: apply ? 'apply' : 'dry-run',
    queue: LEGACY_VK_PUBLISH_QUEUE,
    before,
  };
  if (!first.rows.length)
    return Object.freeze({
      ...common,
      result: 'already_absent',
      namespaceComplete: true,
      cost: first.cost,
      ...(apply ? { after: before } : {}),
    });
  validateOrphanBinding(binding);
  const previewDigest = digest({ version: 1, binding, rows: first.rows });
  const evidence = {
    ...common,
    namespaceComplete: true,
    orphanCount: first.rows.length,
    previewDigest,
    binding,
    cost: first.cost,
  };
  if (!apply) return Object.freeze({ ...evidence, result: 'would_remove_never_started_orphans' });
  if (!/^[0-9a-f]{64}$/u.test(reviewedDigest ?? '') || reviewedDigest !== previewDigest)
    throw new QueueCleanupPreconditionError('reviewed_orphan_digest_required', {
      ...evidence,
      removed: 0,
    });
  const second = await collectLegacyVkPublishOrphans(queue);
  await checkAbsentCounters();
  if (digest({ version: 1, binding, rows: second.rows }) !== previewDigest)
    throw new QueueCleanupPreconditionError('orphan_inventory_changed', {
      ...evidence,
      removed: 0,
    });
  const client = await queue.client;
  const deadline = deadlineMs;
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 120_000)
    throw new QueueCleanupPreconditionError('orphan_apply_deadline_required');
  let removed = 0;
  try {
    for (let offset = 0; offset < first.rows.length; offset += ORPHAN_LIMITS.batch) {
      await checkAbsentCounters();
      const batch = first.rows.slice(offset, offset + ORPHAN_LIMITS.batch);
      const result = await client.eval(
        ORPHAN_DELETE_LUA,
        batch.length,
        ...batch.map((row) => row[0]),
        String(deadline),
        ...batch.flatMap((row) => row[1]),
      );
      if (!Array.isArray(result) || result[0] !== 'ok' || result[1] !== batch.length)
        throw new Error('cas_refused');
      removed += result[1];
    }
    const after = await collectLegacyVkPublishOrphans(queue);
    await checkAbsentCounters();
    if (after.rows.length) throw new Error('remaining_namespace');
    return Object.freeze({
      ...evidence,
      result: 'never_started_orphans_removed',
      removed,
      after: { namespaceComplete: true, orphanCount: 0, cost: after.cost },
    });
  } catch {
    // FLAG: A timed-out CAS has an unknown acknowledgement, not a safe retry.
    // Only a new full preview can establish the remaining fixed-key scope.
    throw new QueueCleanupPreconditionError('orphan_apply_requires_fresh_preview', {
      ...evidence,
      confirmedRemoved: removed,
      outcomeMayBePartial: true,
    });
  }
}
const QUEUE_STATES = Object.freeze([
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'paused',
  'prioritized',
  'waiting-children',
]);

class QueueCleanupPreconditionError extends Error {
  constructor(code, snapshot) {
    super(code);
    this.name = 'QueueCleanupPreconditionError';
    this.code = code;
    this.snapshot = snapshot;
  }
}

function validateQueue(queue) {
  const methods = [
    'close',
    'getJobCounts',
    'getVersion',
    'getWorkersCount',
    'isPaused',
    'obliterate',
    'pause',
    'waitUntilReady',
  ];
  if (
    queue?.name !== LEGACY_VK_PUBLISH_QUEUE ||
    methods.some((method) => typeof queue?.[method] !== 'function')
  ) {
    throw new Error('Legacy VK publish queue handle is invalid.');
  }
}

function readCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Legacy VK publish queue returned an invalid ${name} count.`);
  }
  return value;
}

async function inspectLegacyVkPublishQueue(queue) {
  validateQueue(queue);
  await queue.waitUntilReady();
  const [libraryVersion, paused, workerCountRaw, rawCounts] = await Promise.all([
    queue.getVersion(),
    queue.isPaused(),
    queue.getWorkersCount(),
    queue.getJobCounts(...QUEUE_STATES),
  ]);
  if (libraryVersion !== null && typeof libraryVersion !== 'string') {
    throw new Error('Legacy VK publish queue returned an invalid metadata state.');
  }
  if (typeof paused !== 'boolean' || !rawCounts || typeof rawCounts !== 'object') {
    throw new Error('Legacy VK publish queue returned an invalid state snapshot.');
  }

  const counts = Object.fromEntries(
    QUEUE_STATES.map((state) => [state, readCount(rawCounts[state] ?? 0, state)]),
  );
  const workerCount = readCount(workerCountRaw, 'worker');
  const totalJobs = Object.values(counts).reduce((total, count) => {
    const next = total + count;
    if (!Number.isSafeInteger(next)) {
      throw new Error('Legacy VK publish queue returned an invalid total count.');
    }
    return next;
  }, 0);
  const present = libraryVersion !== null || paused || workerCount > 0 || totalJobs > 0;
  return Object.freeze({
    present,
    paused,
    workerCount,
    totalJobs,
    counts: Object.freeze(counts),
  });
}

async function cleanupLegacyVkPublishQueue(
  queue,
  { apply = false, reviewedDigest, binding, deadlineMs = Date.now() + 110_000 } = {},
) {
  validateQueue(queue);
  const before = await inspectLegacyVkPublishQueue(queue);
  if (reviewedDigest && before.present)
    throw new QueueCleanupPreconditionError('orphan_queue_became_active', before);
  if (!before.present)
    return cleanupLegacyVkPublishOrphans(queue, {
      apply,
      reviewedDigest,
      binding,
      before,
      deadlineMs,
    });
  if (!apply) {
    return Object.freeze({
      version: 1,
      mode: 'dry-run',
      queue: LEGACY_VK_PUBLISH_QUEUE,
      result: before.present ? 'would_obliterate' : 'already_absent',
      before,
    });
  }
  if (before.workerCount !== 0) {
    throw new QueueCleanupPreconditionError('workers_present_before_pause', before);
  }

  await queue.pause();
  const paused = await inspectLegacyVkPublishQueue(queue);
  if (!paused.paused) {
    throw new QueueCleanupPreconditionError('pause_not_confirmed', paused);
  }
  if (paused.workerCount !== 0) {
    throw new QueueCleanupPreconditionError('workers_present_after_pause', paused);
  }
  if (paused.counts.active !== 0) {
    throw new QueueCleanupPreconditionError('active_jobs_after_pause', paused);
  }

  await queue.obliterate({ force: false, count: OBLITERATE_BATCH_SIZE });
  const after = await inspectLegacyVkPublishQueue(queue);
  if (after.present || after.totalJobs !== 0 || after.workerCount !== 0) {
    throw new QueueCleanupPreconditionError('obliterate_not_confirmed', after);
  }
  return Object.freeze({
    version: 1,
    mode: 'apply',
    queue: LEGACY_VK_PUBLISH_QUEUE,
    result: 'obliterated',
    before,
    after,
  });
}

async function main() {
  const { Queue } = require('bullmq');
  const action = process.argv[2];
  if (action !== 'preview' && action !== 'apply') {
    throw new Error('Unknown legacy VK publish queue cleanup action.');
  }
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('Redis configuration is unavailable.');
  }
  const queue = new Queue(LEGACY_VK_PUBLISH_QUEUE, {
    skipMetasUpdate: true,
    connection: {
      url: redisUrl,
      commandTimeout: 5_000,
      connectTimeout: 2_000,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      retryStrategy: null,
      maxRetriesPerRequest: 1,
    },
  });
  queue.on('error', () => undefined);
  try {
    const binding = validateOrphanBinding(
      JSON.parse(process.env.MAXIM_LEGACY_VK_RETIRE_BINDING ?? 'null'),
    );
    const deadlineMs = Number(process.env.MAXIM_LEGACY_VK_RETIRE_DEADLINE_MS);
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs <= Date.now() ||
      deadlineMs > Date.now() + 120_000
    )
      throw new QueueCleanupPreconditionError('orphan_apply_deadline_required');
    const summary = await cleanupLegacyVkPublishQueue(queue, {
      apply: action === 'apply',
      reviewedDigest: process.argv[3],
      binding,
      deadlineMs,
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await queue.close().catch(() => undefined);
  }
}

module.exports = {
  LEGACY_VK_PUBLISH_QUEUE,
  OBLITERATE_BATCH_SIZE,
  QUEUE_STATES,
  QueueCleanupPreconditionError,
  cleanupLegacyVkPublishQueue,
  inspectLegacyVkPublishQueue,
  collectLegacyVkPublishOrphans,
  ORPHAN_LIMITS,
  ORPHAN_FIELDS,
  EMPTY_QUEUE_SUFFIXES,
  ORPHAN_SCAN_LUA,
  ORPHAN_READ_LUA,
  ORPHAN_DELETE_LUA,
};

if (require.main === module || __filename === '[stdin]') {
  main().catch((error) => {
    if (error instanceof QueueCleanupPreconditionError) {
      process.stdout.write(
        `${JSON.stringify({
          version: 1,
          mode: process.argv[2] === 'preview' ? 'dry-run' : 'apply',
          queue: LEGACY_VK_PUBLISH_QUEUE,
          result: 'blocked',
          namespaceComplete: false,
          code: error.code,
          state: error.snapshot,
        })}\n`,
      );
      process.exitCode = 3;
      return;
    }
    process.stderr.write('Legacy VK publish queue cleanup failed closed.\n');
    process.exitCode = 1;
  });
}
