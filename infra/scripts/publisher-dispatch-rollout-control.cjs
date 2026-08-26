'use strict';

const PUBLISHER_PAUSE_KEY_PREFIX = 'publisher:dispatch:pause:v1:';
const PUBLISHER_HEARTBEAT_KEY_PREFIX = 'publisher:runtime:v1:';
const OWNER_TOKEN_PATTERN = /^publisher-rollout:[a-f0-9]{64}$/u;
const BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/u;
const MAX_PAUSE_BYTES = 20 * 1024;
const MAX_PRESERVED_PAUSE_BYTES = 16 * 1024;
const HEARTBEAT_TTL_MS = 45_000;
const AUTHORIZATION_PAUSE_REASONS = new Set([
  'unauthorized',
  'identity_authorization_failed',
  'identity_mismatch',
]);

const ADOPT_OPERATOR_PAUSE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

const CLEAR_OPERATOR_PAUSE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, decoded = pcall(cjson.decode, current)
if not ok or decoded['version'] ~= 1 or decoded['reason'] ~= 'operator_rollout' or decoded['ownerToken'] ~= ARGV[1] then
  return 0
end
local preserved = decoded['preservedPauseRaw']
if type(preserved) == 'string' and string.len(preserved) > 0 then
  redis.call('SET', KEYS[1], preserved)
else
  redis.call('DEL', KEYS[1])
end
return 1
`;

function validateBotId(botId) {
  if (!BOT_ID_PATTERN.test(botId ?? '')) {
    throw new Error('Publisher bot id is invalid.');
  }
}

function validateOwnerToken(ownerToken) {
  if (!OWNER_TOKEN_PATTERN.test(ownerToken ?? '')) {
    throw new Error('Publisher rollout owner token is invalid.');
  }
}

function buildPauseKey(botId) {
  validateBotId(botId);
  return `${PUBLISHER_PAUSE_KEY_PREFIX}${encodeURIComponent(botId)}`;
}

function buildHeartbeatKey(botId) {
  validateBotId(botId);
  return `${PUBLISHER_HEARTBEAT_KEY_PREFIX}${encodeURIComponent(botId)}`;
}

function classifyPause(raw) {
  if (raw === null) return Object.freeze({ kind: 'missing', adoptable: true });
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PAUSE_BYTES) {
    return Object.freeze({ kind: 'unknown', adoptable: false });
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
      return Object.freeze({ kind: 'unknown', adoptable: false });
    }
    if (AUTHORIZATION_PAUSE_REASONS.has(value.reason)) {
      return Object.freeze({ kind: 'authorization', adoptable: true });
    }
    if (
      value.reason === 'operator_rollout' &&
      OWNER_TOKEN_PATTERN.test(value.ownerToken ?? '') &&
      (value.preservedPauseRaw === undefined ||
        (typeof value.preservedPauseRaw === 'string' &&
          Buffer.byteLength(value.preservedPauseRaw, 'utf8') <= MAX_PRESERVED_PAUSE_BYTES &&
          classifyPause(value.preservedPauseRaw).kind === 'authorization'))
    ) {
      return Object.freeze({ kind: 'operator', adoptable: true });
    }
    return Object.freeze({ kind: 'unknown', adoptable: false });
  } catch {
    return Object.freeze({ kind: 'unknown', adoptable: false });
  }
}

function parseHeartbeat(raw, expectedBotId, nowMs = Date.now()) {
  if (raw === null) return Object.freeze({ kind: 'missing', dispatchEnabled: null });
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PAUSE_BYTES) {
    return Object.freeze({ kind: 'invalid', dispatchEnabled: null });
  }
  try {
    const value = JSON.parse(raw);
    const observedAtMs = Date.parse(typeof value?.observedAt === 'string' ? value.observedAt : '');
    if (
      value?.version !== 1 ||
      value.botId !== expectedBotId ||
      typeof value.dispatchEnabled !== 'boolean' ||
      typeof value.instanceId !== 'string' ||
      value.instanceId.length < 1 ||
      !Number.isFinite(observedAtMs) ||
      observedAtMs > nowMs + 30_000 ||
      nowMs - observedAtMs > HEARTBEAT_TTL_MS
    ) {
      return Object.freeze({ kind: 'invalid', dispatchEnabled: null });
    }
    return Object.freeze({ kind: 'fresh', dispatchEnabled: value.dispatchEnabled });
  } catch {
    return Object.freeze({ kind: 'invalid', dispatchEnabled: null });
  }
}

function buildOperatorMarker(ownerToken, preservedPauseRaw = null, now = new Date()) {
  validateOwnerToken(ownerToken);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Publisher rollout marker time is invalid.');
  }
  const marker = {
    version: 1,
    reason: 'operator_rollout',
    ownerToken,
    observedAt: now.toISOString(),
  };
  if (preservedPauseRaw !== null) {
    if (
      typeof preservedPauseRaw !== 'string' ||
      Buffer.byteLength(preservedPauseRaw, 'utf8') > MAX_PRESERVED_PAUSE_BYTES
    ) {
      throw new Error('Preserved publisher pause is invalid.');
    }
    marker.preservedPauseRaw = preservedPauseRaw;
  }
  return JSON.stringify(marker);
}

function validateStore(store) {
  for (const method of ['get', 'setNx', 'compareAndSet', 'clearOwned', 'close']) {
    if (typeof store?.[method] !== 'function') {
      throw new Error('Publisher rollout Redis store is invalid.');
    }
  }
}

async function armOperatorPause(store, ownerToken, mode, now = new Date()) {
  validateStore(store);
  validateOwnerToken(ownerToken);
  if (mode !== 'enable' && mode !== 'disable') {
    throw new Error('Publisher operator pause mode must be enable or disable.');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.get();
    const pause = classifyPause(current);
    if (current === null) {
      const marker = buildOperatorMarker(ownerToken, null, now);
      if (await store.setNx(marker)) {
        return Object.freeze({ result: 'acquired', pauseKind: 'operator' });
      }
      continue;
    }
    if (mode === 'enable') {
      return Object.freeze({ result: 'blocked', pauseKind: pause.kind });
    }
    if (!pause.adoptable || pause.kind === 'unknown') {
      return Object.freeze({ result: 'blocked', pauseKind: pause.kind });
    }

    let preserved = current;
    if (pause.kind === 'operator') {
      const decoded = JSON.parse(current);
      preserved = typeof decoded.preservedPauseRaw === 'string' ? decoded.preservedPauseRaw : null;
    }
    const marker = buildOperatorMarker(ownerToken, preserved, now);
    if (await store.compareAndSet(current, marker)) {
      return Object.freeze({ result: 'acquired', pauseKind: 'operator' });
    }
  }
  return Object.freeze({ result: 'blocked', pauseKind: classifyPause(await store.get()).kind });
}

async function clearOperatorPause(store, ownerToken) {
  validateStore(store);
  validateOwnerToken(ownerToken);
  const cleared = await store.clearOwned(ownerToken);
  const pause = classifyPause(await store.get());
  return Object.freeze({ result: cleared ? 'cleared' : 'not_owned', pauseKind: pause.kind });
}

function createRedisStore(redis, pauseKey) {
  return {
    get: () => redis.get(pauseKey),
    setNx: async (value) => {
      const result = await redis.set(pauseKey, value, 'NX');
      if (result === 'OK') return true;
      if (result === null) return false;
      throw new Error('Redis returned an invalid publisher pause acquisition result.');
    },
    compareAndSet: async (expected, replacement) => {
      const result = await redis.eval(
        ADOPT_OPERATOR_PAUSE_SCRIPT,
        1,
        pauseKey,
        expected,
        replacement,
      );
      if (result === 1 || result === '1') return true;
      if (result === 0 || result === '0') return false;
      throw new Error('Redis returned an invalid publisher pause adoption result.');
    },
    clearOwned: async (ownerToken) => {
      const result = await redis.eval(CLEAR_OPERATOR_PAUSE_SCRIPT, 1, pauseKey, ownerToken);
      if (result === 1 || result === '1') return true;
      if (result === 0 || result === '0') return false;
      throw new Error('Redis returned an invalid publisher pause clear result.');
    },
    close: async () => {
      if (redis.status !== 'ready') {
        redis.disconnect();
        return;
      }
      try {
        await redis.quit();
      } finally {
        if (redis.status !== 'end') redis.disconnect();
      }
    },
  };
}

async function main() {
  const Redis = require('ioredis');
  const action = process.argv[2];
  const botId = process.env.MAX_PUBLISHER_BOT_ID;
  const redisUrl = process.env.REDIS_URL;
  validateBotId(botId);
  if (!redisUrl) throw new Error('Publisher rollout Redis configuration is unavailable.');
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 5_000,
  });
  redis.on('error', () => undefined);
  const store = createRedisStore(redis, buildPauseKey(botId));
  try {
    if (redis.status === 'wait') await redis.connect();
    let summary;
    if (action === 'arm-enable' || action === 'arm-disable') {
      summary = await armOperatorPause(
        store,
        process.env.MAXIM_PUBLISHER_ROLLOUT_OWNER_TOKEN,
        action === 'arm-enable' ? 'enable' : 'disable',
      );
    } else if (action === 'clear') {
      summary = await clearOperatorPause(store, process.env.MAXIM_PUBLISHER_ROLLOUT_OWNER_TOKEN);
    } else if (action === 'status' || action === 'assert-heartbeat') {
      const [pauseRaw, heartbeatRaw] = await Promise.all([
        store.get(),
        redis.get(buildHeartbeatKey(botId)),
      ]);
      const pause = classifyPause(pauseRaw);
      const heartbeat = parseHeartbeat(heartbeatRaw, botId);
      summary = {
        result: 'observed',
        pauseKind: pause.kind,
        heartbeatKind: heartbeat.kind,
        heartbeatEnabled: heartbeat.dispatchEnabled,
      };
      if (action === 'assert-heartbeat') {
        const expected = process.env.MAXIM_PUBLISHER_EXPECTED_HEARTBEAT;
        if (
          (expected !== 'true' && expected !== 'false') ||
          heartbeat.kind !== 'fresh' ||
          heartbeat.dispatchEnabled !== (expected === 'true')
        ) {
          process.exitCode = 3;
        }
      }
    } else {
      throw new Error('Unknown publisher rollout control action.');
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await store.close();
  }
}

module.exports = {
  ADOPT_OPERATOR_PAUSE_SCRIPT,
  AUTHORIZATION_PAUSE_REASONS,
  CLEAR_OPERATOR_PAUSE_SCRIPT,
  armOperatorPause,
  buildHeartbeatKey,
  buildOperatorMarker,
  buildPauseKey,
  classifyPause,
  clearOperatorPause,
  createRedisStore,
  parseHeartbeat,
  validateBotId,
  validateOwnerToken,
};

if (require.main === module || __filename === '[stdin]') {
  main().catch(() => {
    process.stderr.write('Publisher rollout control failed closed.\n');
    process.exitCode = 1;
  });
}
