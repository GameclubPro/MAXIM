'use strict';

const ADMISSION_METADATA_KEY = 'commercial-ocr:admission:v2:global:metadata';
const ADMISSION_UNITS_KEY = 'commercial-ocr:admission:v2:global:units';
const COMMERCIAL_OCR_QUEUE = 'commercial-image-ocr';

const ADMISSION_SCAN_LIMITS = Object.freeze({
  maxEntries: 50_000,
  maxLogicalBytes: 8 * 1024 * 1024,
  maxRedisBytes: 16 * 1024 * 1024,
  maxPages: 4_096,
  pageCount: 128,
  timeoutMs: 5_000,
});
const MIN_PROBE_TIMEOUT_MS = 250;

// Recheck HLEN atomically so exact MEMORY traversal never runs on an oversized hash after a race.
const READ_ADMISSION_METADATA_BOUNDS_SCRIPT = `
local entries = redis.call('HLEN', KEYS[1])
if entries > tonumber(ARGV[1]) then
  return {1, entries, 0}
end
local redis_bytes = redis.call('MEMORY', 'USAGE', KEYS[1], 'SAMPLES', 0)
if redis_bytes == false then
  redis_bytes = 0
end
return {0, entries, redis_bytes}
`;

// One Redis round-trip examines one bounded HSCAN page and returns scalar aggregates only.
const SCAN_ADMISSION_METADATA_PAGE_SCRIPT = `
local page = redis.call('HSCAN', KEYS[1], ARGV[1], 'COUNT', ARGV[2])
local values = page[2]
local entries = 0
local logical_bytes = 0
local held = 0
local malformed = 0
for index = 1, #values, 2 do
  local field = values[index]
  local metadata = values[index + 1]
  entries = entries + 1
  logical_bytes = logical_bytes + string.len(field) + string.len(metadata)
  if string.match(metadata, '^[^|]+|%d+|[PAO]|[01]$') == nil then
    malformed = malformed + 1
  end
  if string.match(metadata, '|1$') ~= nil then
    held = held + 1
  end
end
return {page[1], entries, logical_bytes, held, malformed}
`;

function parseNonNegativeSafeInteger(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Admission metadata scan returned an invalid scalar summary.');
  }
  return parsed;
}

function parseProbeTimeoutMs(value) {
  if (value === undefined) return ADMISSION_SCAN_LIMITS.timeoutMs;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error('Commercial OCR drain probe timeout is invalid.');
  }
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_PROBE_TIMEOUT_MS ||
    timeoutMs > ADMISSION_SCAN_LIMITS.timeoutMs
  ) {
    throw new Error('Commercial OCR drain probe timeout is invalid.');
  }
  return timeoutMs;
}

function readTransactionValue(response, index) {
  const item = response?.[index];
  if (!Array.isArray(item) || item.length !== 2 || item[0] !== null) {
    throw new Error('Admission metadata bounds could not be verified.');
  }
  return item[1];
}

function parseBoundsSummary(response) {
  if (!Array.isArray(response) || response.length !== 3) {
    throw new Error('Admission metadata bounds could not be verified.');
  }
  return {
    status: parseNonNegativeSafeInteger(response[0]),
    entries: parseNonNegativeSafeInteger(response[1]),
    redisBytes: parseNonNegativeSafeInteger(response[2]),
  };
}

function parsePageSummary(response) {
  if (!Array.isArray(response) || response.length !== 5) {
    throw new Error('Admission metadata scan returned an invalid scalar summary.');
  }
  const cursor = String(response[0]);
  if (!/^\d{1,20}$/u.test(cursor)) {
    throw new Error('Admission metadata scan returned an invalid cursor.');
  }
  return {
    cursor,
    entries: parseNonNegativeSafeInteger(response[1]),
    logicalBytes: parseNonNegativeSafeInteger(response[2]),
    held: parseNonNegativeSafeInteger(response[3]),
    malformed: parseNonNegativeSafeInteger(response[4]),
  };
}

async function scanAdmissionMetadata(redis, options = {}) {
  const limits = options.limits ?? ADMISSION_SCAN_LIMITS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let watchArmed = false;

  try {
    await redis.watch(ADMISSION_METADATA_KEY);
    watchArmed = true;

    const fastEntries = parseNonNegativeSafeInteger(await redis.hlen(ADMISSION_METADATA_KEY));
    if (fastEntries > limits.maxEntries) {
      throw new Error('Admission metadata exceeds bounded scan limits.');
    }
    const bounds = parseBoundsSummary(
      await redis.eval(
        READ_ADMISSION_METADATA_BOUNDS_SCRIPT,
        1,
        ADMISSION_METADATA_KEY,
        String(limits.maxEntries),
      ),
    );
    if (
      bounds.status !== 0 ||
      bounds.entries > limits.maxEntries ||
      bounds.redisBytes > limits.maxRedisBytes
    ) {
      throw new Error('Admission metadata exceeds bounded scan limits.');
    }
    const expectedEntries = bounds.entries;

    let cursor = '0';
    let pages = 0;
    let scannedEntries = 0;
    let scannedLogicalBytes = 0;
    let held = 0;
    let malformed = 0;
    do {
      pages += 1;
      if (pages > limits.maxPages || now() - startedAt > limits.timeoutMs) {
        throw new Error('Admission metadata bounded scan did not complete.');
      }
      const pageResponse = await redis.eval(
        SCAN_ADMISSION_METADATA_PAGE_SCRIPT,
        1,
        ADMISSION_METADATA_KEY,
        cursor,
        String(limits.pageCount),
      );
      if (now() - startedAt > limits.timeoutMs) {
        throw new Error('Admission metadata bounded scan did not complete.');
      }
      const page = parsePageSummary(pageResponse);
      cursor = page.cursor;
      scannedEntries += page.entries;
      scannedLogicalBytes += page.logicalBytes;
      held += page.held;
      malformed += page.malformed;
      if (
        scannedEntries > limits.maxEntries ||
        scannedLogicalBytes > limits.maxLogicalBytes ||
        held > limits.maxEntries ||
        malformed > limits.maxEntries
      ) {
        throw new Error('Admission metadata exceeds bounded scan limits.');
      }
    } while (cursor !== '0');

    const finalRead = await redis.multi([['hlen', ADMISSION_METADATA_KEY]]).exec();
    watchArmed = false;
    if (finalRead === null) {
      throw new Error('Admission metadata changed during bounded scan.');
    }
    const finalEntries = parseNonNegativeSafeInteger(readTransactionValue(finalRead, 0));
    if (finalEntries !== expectedEntries || scannedEntries !== expectedEntries) {
      throw new Error('Admission metadata bounded scan was incomplete.');
    }
    return { held, malformed };
  } finally {
    if (watchArmed) {
      await redis.unwatch().catch(() => undefined);
    }
  }
}

async function collectDrainSummary(queue, redis, states, options = {}) {
  await Promise.all([queue.waitUntilReady(), redis.connect()]);
  const [counts, unitsRaw] = await Promise.all([
    queue.getJobCounts(...states),
    redis.get(ADMISSION_UNITS_KEY),
  ]);
  const units = unitsRaw === null ? 0 : Number(unitsRaw);
  const { held, malformed } = await scanAdmissionMetadata(redis, options);
  return { counts, units, held, malformed };
}

async function main() {
  const { Queue } = require('bullmq');
  const Redis = require('ioredis');
  const states = process.argv.slice(2);
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('Redis configuration is unavailable.');
  const probeTimeoutMs = parseProbeTimeoutMs(
    process.env.MAXIM_COMMERCIAL_OCR_DRAIN_PROBE_TIMEOUT_MS,
  );
  const redisCommandTimeoutMs = Math.min(1_000, probeTimeoutMs);
  const queue = new Queue(COMMERCIAL_OCR_QUEUE, {
    connection: {
      url: redisUrl,
      commandTimeout: redisCommandTimeoutMs,
      connectTimeout: redisCommandTimeoutMs,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    },
  });
  const redis = new Redis(redisUrl, {
    commandTimeout: redisCommandTimeoutMs,
    connectTimeout: redisCommandTimeoutMs,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  queue.on('error', () => undefined);
  redis.on('error', () => undefined);
  try {
    const summary = await collectDrainSummary(queue, redis, states, {
      limits: { ...ADMISSION_SCAN_LIMITS, timeoutMs: probeTimeoutMs },
    });
    process.stdout.write(JSON.stringify(summary));
  } finally {
    await queue.close().catch(() => queue.disconnect());
    if (redis.status === 'ready') await redis.quit();
    else redis.disconnect();
  }
}

module.exports = {
  ADMISSION_SCAN_LIMITS,
  READ_ADMISSION_METADATA_BOUNDS_SCRIPT,
  SCAN_ADMISSION_METADATA_PAGE_SCRIPT,
  collectDrainSummary,
  parseProbeTimeoutMs,
  scanAdmissionMetadata,
};

if (require.main === module || __filename === '[stdin]') {
  main().catch(() => {
    process.stderr.write('Commercial OCR drain probe failed closed.\n');
    process.exitCode = 1;
  });
}
