'use strict';

const { createHash } = require('node:crypto');

const CPU_LEASE_KEY = 'commercial-llm-shadow:v1:lease';
const CPU_RECOVERY_RECEIPT_PREFIX = 'commercial-llm-shadow:v1:cpu-recovery:receipt:';
const RECEIPT_MAX_BYTES = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT = /^[0-9a-f]{64}$/u;

// FLAG: Read only two exact keys. Check type and byte length before GET; raw CPU
// ownership remains inside this process and is never included in its public result.
const OBSERVE_LUA = `
local receiptType = redis.call('TYPE', KEYS[2]).ok
if receiptType ~= 'none' then
  if receiptType ~= 'string' then return {'invalid', 'receipt_type'} end
  local size = redis.call('STRLEN', KEYS[2])
  if size == 0 or size > tonumber(ARGV[1]) then return {'invalid', 'receipt_size'} end
  if redis.call('PTTL', KEYS[2]) ~= -1 then return {'invalid', 'receipt_ttl'} end
  return {'receipt', redis.call('GET', KEYS[2])}
end
local leaseType = redis.call('TYPE', KEYS[1]).ok
if leaseType == 'none' then return {'missing'} end
if leaseType ~= 'string' then return {'invalid', 'lease_type'} end
if redis.call('STRLEN', KEYS[1]) ~= 36 then return {'invalid', 'lease_size'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl ~= -1 and ttl <= 0 then return {'missing'} end
return {'lease', redis.call('GET', KEYS[1]), ttl}
`;

// FLAG: The host controller must first prove the exact dispatcher and model stopped.
// This CAS releases only the observed persistent UUID. A permanent operation receipt
// makes an unknown acknowledgement resumable without touching any subsequent lease.
// Reserve the receipt before DEL so an OOM cannot remove authority without evidence;
// check both write permissions before either write because Redis Lua has no rollback.
const RELEASE_LUA = `
local receiptType = redis.call('TYPE', KEYS[2]).ok
if receiptType ~= 'none' then
  if receiptType ~= 'string' then return {'invalid', 'receipt_type'} end
  local size = redis.call('STRLEN', KEYS[2])
  if size == 0 or size > tonumber(ARGV[3]) then return {'invalid', 'receipt_size'} end
  if redis.call('PTTL', KEYS[2]) ~= -1 then return {'invalid', 'receipt_ttl'} end
  if redis.call('GET', KEYS[2]) == ARGV[2] then return {'released_receipt', '1'} end
  return {'foreign', 'receipt_conflict'}
end
local leaseType = redis.call('TYPE', KEYS[1]).ok
if leaseType == 'none' then return {'missing'} end
if leaseType ~= 'string' then return {'invalid', 'lease_type'} end
if redis.call('STRLEN', KEYS[1]) ~= 36 then return {'invalid', 'lease_size'} end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'foreign', 'lease_changed'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl ~= -1 then return {'held_expiring', tostring(ttl)} end
if not redis.acl_check_cmd('SET', KEYS[2], ARGV[2], 'NX')
  or not redis.acl_check_cmd('DEL', KEYS[1]) then return {'invalid', 'write_authority'} end
if not redis.call('SET', KEYS[2], ARGV[2], 'NX') then return {'foreign', 'receipt_conflict'} end
redis.call('DEL', KEYS[1])
return {'released_receipt', '0'}
`;

function fingerprint(raw) {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw new Error('cpu_lease_invalid_uuid');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function keysFor(operationId, testKeys) {
  if (typeof operationId !== 'string' || !UUID.test(operationId))
    throw new Error('cpu_lease_invalid_operation');
  const id = operationId.toLowerCase();
  // FLAG: Key injection is an exported fixture seam only. The CLI never forwards
  // arguments or environment variables to it and always addresses the fixed CPU key.
  const leaseKey = testKeys?.leaseKey ?? CPU_LEASE_KEY;
  const receiptPrefix = testKeys?.receiptPrefix ?? CPU_RECOVERY_RECEIPT_PREFIX;
  if (
    typeof leaseKey !== 'string' ||
    typeof receiptPrefix !== 'string' ||
    !leaseKey ||
    !receiptPrefix ||
    leaseKey.length > 256 ||
    receiptPrefix.length > 256 ||
    /[^a-zA-Z0-9:_{}.-]/u.test(leaseKey + receiptPrefix) ||
    leaseKey === receiptPrefix + id
  )
    throw new Error('cpu_lease_invalid_keys');
  return { operationId: id, leaseKey, receiptKey: receiptPrefix + id };
}

function receiptFor(operationId, hash) {
  return JSON.stringify({ schemaVersion: 1, operationId, fingerprint: hash });
}

function parseReceipt(raw, operationId) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > RECEIPT_MAX_BYTES)
    return { state: 'invalid', reason: 'receipt_size' };
  try {
    const value = JSON.parse(raw);
    if (
      value?.schemaVersion !== 1 ||
      typeof value.operationId !== 'string' ||
      !UUID.test(value.operationId) ||
      typeof value.fingerprint !== 'string' ||
      !FINGERPRINT.test(value.fingerprint) ||
      receiptFor(value.operationId, value.fingerprint) !== raw
    )
      return { state: 'invalid', reason: 'receipt_schema' };
    if (value.operationId !== operationId) return { state: 'foreign', reason: 'receipt_operation' };
    return { state: 'released_receipt', fingerprint: value.fingerprint, alreadyReleased: true };
  } catch {
    return { state: 'invalid', reason: 'receipt_schema' };
  }
}

async function readSnapshot(redis, keys) {
  const reply = await redis.eval(OBSERVE_LUA, 2, keys.leaseKey, keys.receiptKey, RECEIPT_MAX_BYTES);
  if (!Array.isArray(reply)) throw new Error('cpu_lease_invalid_reply');
  if (reply[0] === 'receipt') return { result: parseReceipt(reply[1], keys.operationId) };
  if (reply[0] === 'missing') return { result: { state: 'missing' } };
  if (reply[0] === 'invalid') return { result: { state: 'invalid', reason: reply[1] } };
  if (reply[0] !== 'lease' || typeof reply[1] !== 'string' || !UUID.test(reply[1]))
    return { result: { state: 'invalid', reason: 'lease_uuid' } };
  const ttl = reply[2];
  if (!Number.isSafeInteger(ttl) || (ttl !== -1 && ttl <= 0))
    return { result: { state: 'invalid', reason: 'lease_ttl' } };
  return {
    raw: reply[1],
    result: {
      state: ttl === -1 ? 'held_persistent' : 'held_expiring',
      fingerprint: fingerprint(reply[1]),
      leaseTtlMs: ttl,
    },
  };
}

function project(operationId, result) {
  return { schemaVersion: 1, operationId, ...result };
}

async function observeLease(redis, operationId, testKeys) {
  const keys = keysFor(operationId, testKeys);
  return project(keys.operationId, (await readSnapshot(redis, keys)).result);
}

async function releaseLease(redis, operationId, expectedFingerprint, testKeys) {
  const keys = keysFor(operationId, testKeys);
  if (typeof expectedFingerprint !== 'string' || !FINGERPRINT.test(expectedFingerprint))
    throw new Error('cpu_lease_invalid_fingerprint');
  const snapshot = await readSnapshot(redis, keys);
  if (snapshot.result.fingerprint && snapshot.result.fingerprint !== expectedFingerprint)
    return project(keys.operationId, { state: 'foreign', reason: 'fingerprint_mismatch' });
  if (snapshot.result.state === 'released_receipt') {
    // FLAG: Recheck the exact receipt atomically before acknowledging an earlier release.
  } else if (snapshot.result.state !== 'held_persistent') {
    return project(keys.operationId, snapshot.result);
  }
  const reply = await redis.eval(
    RELEASE_LUA,
    2,
    keys.leaseKey,
    keys.receiptKey,
    snapshot.raw ?? '',
    receiptFor(keys.operationId, expectedFingerprint),
    RECEIPT_MAX_BYTES,
  );
  if (!Array.isArray(reply)) throw new Error('cpu_lease_invalid_reply');
  if (reply[0] === 'released_receipt')
    return project(keys.operationId, {
      state: 'released_receipt',
      fingerprint: expectedFingerprint,
      alreadyReleased: reply[1] === '1',
    });
  if (reply[0] === 'missing') return project(keys.operationId, { state: 'missing' });
  if (reply[0] === 'held_expiring')
    return project(keys.operationId, { state: 'held_expiring', leaseTtlMs: Number(reply[1]) });
  if (reply[0] === 'foreign' || reply[0] === 'invalid')
    return project(keys.operationId, { state: reply[0], reason: reply[1] });
  throw new Error('cpu_lease_invalid_reply');
}

async function runCli(argv = process.argv.slice(2)) {
  const [command, operationId, expectedFingerprint, ...extra] = argv;
  if (
    !['observe', 'release'].includes(command) ||
    !UUID.test(operationId ?? '') ||
    extra.length ||
    (command === 'observe' && expectedFingerprint !== undefined) ||
    (command === 'release' && !FINGERPRINT.test(expectedFingerprint ?? ''))
  )
    return { exitCode: 2, result: { schemaVersion: 1, state: 'invalid', reason: 'arguments' } };
  let redis;
  try {
    if (!process.env.REDIS_URL) throw new Error('cpu_lease_missing_dependency');
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      commandTimeout: 1000,
      connectTimeout: 1000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectionName: 'commercial-llm-cpu-recovery',
    });
    redis.on('error', () => {});
    await redis.connect();
    const result =
      command === 'observe'
        ? await observeLease(redis, operationId)
        : await releaseLease(redis, operationId, expectedFingerprint);
    const success =
      command === 'release'
        ? result.state === 'released_receipt'
        : ['held_persistent', 'held_expiring', 'released_receipt', 'missing'].includes(
            result.state,
          );
    return { exitCode: success ? 0 : 1, result };
  } catch {
    // FLAG: Redis errors can contain credentials or command arguments. Never print them.
    return {
      exitCode: 1,
      result: { schemaVersion: 1, state: 'invalid', reason: 'dependency_unavailable' },
    };
  } finally {
    redis?.disconnect();
  }
}

module.exports = {
  CPU_LEASE_KEY,
  CPU_RECOVERY_RECEIPT_PREFIX,
  RECEIPT_MAX_BYTES,
  OBSERVE_LUA,
  RELEASE_LUA,
  fingerprint,
  observeLease,
  releaseLease,
  runCli,
};

// FLAG: docker exec pipes this standalone helper through `node -`. Imported helpers
// in a different stdin program keep their file module ID and must never auto-run.
const stdinEntry = process.argv[1] === '-' && module.id === '[stdin]' && require.main === undefined;
if (require.main === module || stdinEntry)
  void runCli().then(({ exitCode, result }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = exitCode;
  });
