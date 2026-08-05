import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import {
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  matchPhotoAlbums,
  type PhotoAlbumFingerprint,
  type PhotoFingerprint,
  type PhotoMatchPreset,
} from './photo-fingerprint';

const HISTORY_NAMESPACE = 'photo-duplicate:history:v1';
const DEFAULT_HISTORY_MAX_ITEMS = 250;
const MAX_HISTORY_TTL_SECONDS = 31 * 24 * 60 * 60;
const MAX_CACHE_BATCH_SIZE = 10;

// FLAG: Replay lookup must stay before every mutation. Multi-bot deliveries of one logical MAX
// message must return the stored result without inserting history or incrementing sanctions again.
const OBSERVE_PHOTO_ALBUM_SCRIPT = `
local replay_status = redis.call('HGET', KEYS[1], 'classification')
if replay_status then
  return {
    2,
    replay_status,
    redis.call('HGET', KEYS[1], 'cluster_id') or '',
    redis.call('HGET', KEYS[1], 'match_kind') or '',
    redis.call('HGET', KEYS[1], 'distance') or '',
    redis.call('HGET', KEYS[1], 'repeat_count') or '0',
    redis.call('HGET', KEYS[1], 'previous_message_id') or ''
  }
end

local occurred_at = tonumber(ARGV[2])
local cutoff_at = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])
local max_items = tonumber(ARGV[5])
local current_message_id = ARGV[1]
local deterministic_cluster_id = ARGV[6]
local forced_cluster_id = ARGV[7]
local forced_previous_message_id = ARGV[8]
local exact_match_kind = ARGV[9]
local forced_match_kind = ARGV[10]
local forced_distance = ARGV[11]
local commit_violation = ARGV[12]

redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff_at)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', cutoff_at)

local classification = 'new'
local cluster_id = deterministic_cluster_id
local match_kind = ''
local distance = ''
local previous_message_id = ''

if forced_cluster_id ~= '' and forced_previous_message_id ~= '' then
  classification = 'duplicate'
  cluster_id = forced_cluster_id
  previous_message_id = forced_previous_message_id
  match_kind = forced_match_kind
  distance = forced_distance
else
  local prior_rows = redis.call(
    'ZREVRANGEBYSCORE',
    KEYS[2],
    tostring(occurred_at),
    cutoff_at,
    'LIMIT',
    0,
    2
  )
  local prior = nil
  for _, candidate in ipairs(prior_rows) do
    local candidate_message_id = string.sub(candidate, 66)
    if candidate_message_id ~= current_message_id then
      prior = candidate
      break
    end
  end
  if prior then
    classification = 'duplicate'
    cluster_id = string.sub(prior, 1, 64)
    previous_message_id = string.sub(prior, 66)
    match_kind = exact_match_kind
    distance = '0'
  else
    local newer = redis.call(
      'ZRANGEBYSCORE',
      KEYS[2],
      '(' .. tostring(occurred_at),
      '+inf',
      'LIMIT',
      0,
      1
    )
    if newer[1] then
      classification = 'out_of_order'
    end
  end
end

redis.call('ZADD', KEYS[2], occurred_at, cluster_id .. ':' .. current_message_id)
local exact_size = redis.call('ZCARD', KEYS[2])
if exact_size > max_items then
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, exact_size - max_items - 1)
end
redis.call('PEXPIRE', KEYS[2], ttl_ms)

if ARGV[13] ~= '' then
  local recent_record = cjson.decode(ARGV[13])
  recent_record.clusterId = cluster_id
  recent_record.messageId = current_message_id
  redis.call('ZADD', KEYS[3], occurred_at, cjson.encode(recent_record))
  local recent_size = redis.call('ZCARD', KEYS[3])
  if recent_size > max_items then
    redis.call('ZREMRANGEBYRANK', KEYS[3], 0, recent_size - max_items - 1)
  end
  redis.call('PEXPIRE', KEYS[3], ttl_ms)
end

local repeat_count = 0
if classification == 'new' then
  redis.call('HDEL', KEYS[4], cluster_id)
elseif classification == 'duplicate' then
  if commit_violation == '1' then
    repeat_count = redis.call('HINCRBY', KEYS[4], cluster_id, 1)
    redis.call('PEXPIRE', KEYS[4], ttl_ms)
  else
    repeat_count = tonumber(redis.call('HGET', KEYS[4], cluster_id) or '0')
  end
end

local counter_size = redis.call('HLEN', KEYS[4])
if counter_size > max_items then
  local counter_clusters = redis.call('HKEYS', KEYS[4])
  local remove_count = counter_size - max_items
  for _, candidate_cluster_id in ipairs(counter_clusters) do
    if remove_count <= 0 then
      break
    end
    if candidate_cluster_id ~= cluster_id then
      redis.call('HDEL', KEYS[4], candidate_cluster_id)
      remove_count = remove_count - 1
    end
  end
end

redis.call(
  'HSET',
  KEYS[1],
  'classification', classification,
  'cluster_id', cluster_id,
  'match_kind', match_kind,
  'distance', distance,
  'repeat_count', tostring(repeat_count),
  'previous_message_id', previous_message_id
)
redis.call('PEXPIRE', KEYS[1], ttl_ms)

return {
  1,
  classification,
  cluster_id,
  match_kind,
  distance,
  repeat_count,
  previous_message_id
}
`;

export type PhotoDuplicateScope = 'SAME_AUTHOR' | 'CHAT';
export type PhotoHistoryMatchKind = 'platform_id' | 'canonical_sha256' | 'pdq';

export type PhotoHistoryObservationResult =
  | {
      kind: 'available';
      inserted: boolean;
      replayed: boolean;
      classification: 'new' | 'duplicate' | 'out_of_order';
      clusterId: string;
      matchKind: PhotoHistoryMatchKind | null;
      matchedDistance: number | null;
      repeatCount: number;
      duplicateOfMessageId: string | null;
    }
  | { kind: 'unavailable' };

export type PhotoFingerprintCacheLookupResult =
  | { kind: 'available'; fingerprints: Array<PhotoFingerprint | null> }
  | { kind: 'unavailable' };

export type ObservePhotoAlbumInput = {
  chatId: string;
  senderId: string;
  messageId: string;
  occurredAtMs: number;
  ttlSeconds: number;
  scope: PhotoDuplicateScope;
  fingerprintVersion: string;
  albumHash: string;
  exactMatchKind: Exclude<PhotoHistoryMatchKind, 'pdq'>;
  perceptualAlbum?: PhotoAlbumFingerprint;
  allowPerceptualMatch?: boolean;
  perceptualPreset?: PhotoMatchPreset;
  commitViolation: boolean;
};

type StoredPerceptualCandidate = {
  schemaVersion: 1;
  clusterId: string;
  messageId: string;
  occurredAtMs: number;
  album: PhotoAlbumFingerprint;
};

@Injectable()
export class PhotoDuplicateHistoryStore implements OnModuleDestroy {
  private readonly logger = new Logger(PhotoDuplicateHistoryStore.name);
  private readonly redis: Redis;
  private readonly maxItems: number;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.maxItems = parseMaxItems(
      configService.get<string | number>('PHOTO_DUPLICATE_HISTORY_MAX_ITEMS'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async observeAlbum(input: ObservePhotoAlbumInput): Promise<PhotoHistoryObservationResult> {
    const normalized = validateInput(input);
    try {
      const keys = buildKeys(normalized);
      const perceptualMatch =
        normalized.allowPerceptualMatch && normalized.perceptualAlbum
          ? await this.findPerceptualMatch(normalized, keys.recentKey)
          : null;
      const deterministicClusterId = buildClusterId(
        normalized.fingerprintVersion,
        normalized.albumHash,
      );
      const recentRecord = normalized.perceptualAlbum
        ? JSON.stringify({
            schemaVersion: 1,
            clusterId: deterministicClusterId,
            messageId: '',
            occurredAtMs: normalized.occurredAtMs,
            album: normalized.perceptualAlbum,
          } satisfies StoredPerceptualCandidate)
        : '';
      const ttlMs = normalized.ttlSeconds * 1_000;
      const response = (await this.redis.eval(
        OBSERVE_PHOTO_ALBUM_SCRIPT,
        4,
        keys.replayKey,
        keys.exactHistoryKey,
        keys.recentKey,
        keys.authorCounterKey,
        normalized.messageId,
        String(normalized.occurredAtMs),
        String(normalized.occurredAtMs - ttlMs),
        String(ttlMs),
        String(this.maxItems),
        deterministicClusterId,
        perceptualMatch?.clusterId ?? '',
        perceptualMatch?.messageId ?? '',
        normalized.exactMatchKind,
        perceptualMatch ? 'pdq' : '',
        perceptualMatch ? String(perceptualMatch.distance) : '',
        normalized.commitViolation ? '1' : '0',
        recentRecord,
      )) as Array<number | string | Buffer>;

      return parseObservationResponse(response);
    } catch {
      this.logger.warn('Photo duplicate history unavailable; continuing fail-open');
      return { kind: 'unavailable' };
    }
  }

  async observeExactAlbum(
    input: Omit<
      ObservePhotoAlbumInput,
      'perceptualAlbum' | 'allowPerceptualMatch' | 'perceptualPreset'
    >,
  ): Promise<PhotoHistoryObservationResult> {
    return this.observeAlbum({
      ...input,
      allowPerceptualMatch: false,
    });
  }

  async getCachedPhotoFingerprints(
    photoIds: readonly string[],
  ): Promise<PhotoFingerprintCacheLookupResult> {
    const normalizedPhotoIds = validatePhotoIdBatch(photoIds);
    try {
      const values = await this.redis.mget(
        ...normalizedPhotoIds.map(buildPhotoFingerprintCacheKey),
      );
      return {
        kind: 'available',
        fingerprints: values.map(parseCachedPhotoFingerprint),
      };
    } catch {
      this.logger.warn('Photo fingerprint cache unavailable; continuing fail-open');
      return { kind: 'unavailable' };
    }
  }

  async cachePhotoFingerprints(
    entries: readonly { photoId: string; fingerprint: PhotoFingerprint }[],
    ttlSeconds: number,
  ): Promise<boolean> {
    if (entries.length === 0 || entries.length > MAX_CACHE_BATCH_SIZE) {
      throw new Error('Photo fingerprint cache batch size is invalid');
    }
    const normalizedTtlSeconds = validateCacheTtl(ttlSeconds);
    const normalizedEntries = entries.map(({ photoId, fingerprint }) => ({
      photoId: validateIdentifier(photoId, 'photoId'),
      fingerprint: validateCachedPhotoFingerprint(fingerprint),
    }));
    try {
      await Promise.all(
        normalizedEntries.map(({ photoId, fingerprint }) =>
          this.redis.set(
            buildPhotoFingerprintCacheKey(photoId),
            JSON.stringify(fingerprint),
            'EX',
            normalizedTtlSeconds,
          ),
        ),
      );
      return true;
    } catch {
      this.logger.warn('Photo fingerprint cache write failed; continuing fail-open');
      return false;
    }
  }

  private async findPerceptualMatch(
    input: ReturnType<typeof validateInput>,
    recentKey: string,
  ): Promise<{ clusterId: string; messageId: string; distance: number } | null> {
    if (!input.perceptualAlbum) {
      return null;
    }
    const cutoffAtMs = input.occurredAtMs - input.ttlSeconds * 1_000;
    const rows = await this.redis.zrevrangebyscore(
      recentKey,
      String(input.occurredAtMs),
      String(cutoffAtMs),
      'LIMIT',
      0,
      this.maxItems,
    );
    let best: { clusterId: string; messageId: string; distance: number } | null = null;
    for (const row of rows) {
      const candidate = parseStoredCandidate(row);
      if (!candidate || candidate.messageId === input.messageId) {
        continue;
      }
      const match = matchPhotoAlbums(input.perceptualAlbum, candidate.album, {
        preset: input.perceptualPreset ?? 'SAME_IMAGE',
      });
      if (!match.matched || !match.usedPerceptualHash || match.strongestDistance === null) {
        continue;
      }
      if (!best || match.strongestDistance < best.distance) {
        best = {
          clusterId: candidate.clusterId,
          messageId: candidate.messageId,
          distance: match.strongestDistance,
        };
      }
    }
    return best;
  }
}

function validateInput(input: ObservePhotoAlbumInput): ObservePhotoAlbumInput {
  const chatId = validateIdentifier(input.chatId, 'chatId');
  const senderId = validateIdentifier(input.senderId, 'senderId');
  const messageId = validateIdentifier(input.messageId, 'messageId');
  const fingerprintVersion = input.fingerprintVersion.trim();
  const albumHash = input.albumHash.trim().toLowerCase();
  if (!fingerprintVersion || fingerprintVersion.length > 128) {
    throw new Error('fingerprintVersion is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(albumHash)) {
    throw new Error('albumHash must be a 256-bit hexadecimal value');
  }
  if (!Number.isSafeInteger(input.occurredAtMs) || input.occurredAtMs <= 0) {
    throw new Error('occurredAtMs must be a positive integer');
  }
  if (
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds <= 0 ||
    input.ttlSeconds > MAX_HISTORY_TTL_SECONDS
  ) {
    throw new Error('ttlSeconds is outside the supported range');
  }
  if (input.perceptualAlbum && input.perceptualAlbum.albumHash !== albumHash) {
    throw new Error('perceptualAlbum and albumHash must describe the same album');
  }

  return {
    ...input,
    chatId,
    senderId,
    messageId,
    fingerprintVersion,
    albumHash,
  };
}

function validateIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function buildKeys(input: ObservePhotoAlbumInput): {
  replayKey: string;
  exactHistoryKey: string;
  recentKey: string;
  authorCounterKey: string;
} {
  const chatHash = shortHash(input.chatId);
  const senderHash = shortHash(input.senderId);
  const messageHash = shortHash(input.messageId);
  const versionHash = shortHash(input.fingerprintVersion);
  const policyHash = buildPolicyHash(input.scope, input.perceptualPreset);
  const scopeHash =
    input.scope === 'CHAT' ? `chat:${chatHash}` : `author:${chatHash}:${senderHash}`;
  return {
    replayKey: `${HISTORY_NAMESPACE}:replay:${versionHash}:${policyHash}:${chatHash}:${messageHash}`,
    exactHistoryKey: `${HISTORY_NAMESPACE}:exact:${versionHash}:${policyHash}:${scopeHash}:${input.albumHash}`,
    recentKey: `${HISTORY_NAMESPACE}:recent:${versionHash}:${policyHash}:${scopeHash}`,
    authorCounterKey: `${HISTORY_NAMESPACE}:author-count:${versionHash}:${policyHash}:${chatHash}:${senderHash}`,
  };
}

function buildPolicyHash(scope: PhotoDuplicateScope, preset: PhotoMatchPreset | undefined): string {
  return shortHash(`${scope}:${preset ?? 'EXACT_ONLY'}`);
}

function buildClusterId(fingerprintVersion: string, albumHash: string): string {
  return createHash('sha256')
    .update('photo-cluster-v1')
    .update('\0')
    .update(fingerprintVersion)
    .update('\0')
    .update(albumHash)
    .digest('hex');
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function parseObservationResponse(
  response: Array<number | string | Buffer>,
): PhotoHistoryObservationResult {
  const writeStatus = Number(readRedisValue(response[0]));
  const classification = readRedisValue(response[1]);
  const clusterId = readRedisValue(response[2]);
  const rawMatchKind = readRedisValue(response[3]);
  const rawDistance = readRedisValue(response[4]);
  const repeatCount = Number(readRedisValue(response[5]));
  const duplicateOfMessageId = readRedisValue(response[6]) || null;
  if (
    (writeStatus !== 1 && writeStatus !== 2) ||
    !['new', 'duplicate', 'out_of_order'].includes(classification) ||
    !/^[0-9a-f]{64}$/.test(clusterId) ||
    !Number.isSafeInteger(repeatCount) ||
    repeatCount < 0
  ) {
    throw new Error('Redis returned an invalid photo history result');
  }
  const matchKind = rawMatchKind || null;
  if (matchKind && !['platform_id', 'canonical_sha256', 'pdq'].includes(matchKind)) {
    throw new Error('Redis returned an invalid photo match kind');
  }
  const matchedDistance = rawDistance === '' ? null : Number(rawDistance);
  if (
    matchedDistance !== null &&
    (!Number.isSafeInteger(matchedDistance) || matchedDistance < 0 || matchedDistance > 256)
  ) {
    throw new Error('Redis returned an invalid photo match distance');
  }

  return {
    kind: 'available',
    inserted: writeStatus === 1,
    replayed: writeStatus === 2,
    classification: classification as 'new' | 'duplicate' | 'out_of_order',
    clusterId,
    matchKind: matchKind as PhotoHistoryMatchKind | null,
    matchedDistance,
    repeatCount,
    duplicateOfMessageId,
  };
}

function parseStoredCandidate(raw: string): StoredPerceptualCandidate | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPerceptualCandidate>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.clusterId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.clusterId) ||
      typeof parsed.messageId !== 'string' ||
      !parsed.messageId ||
      !Number.isSafeInteger(parsed.occurredAtMs) ||
      !parsed.album ||
      !Array.isArray(parsed.album.images) ||
      parsed.album.images.length === 0 ||
      parsed.album.images.length > 10
    ) {
      return null;
    }
    return parsed as StoredPerceptualCandidate;
  } catch {
    return null;
  }
}

function validatePhotoIdBatch(photoIds: readonly string[]): string[] {
  if (photoIds.length === 0 || photoIds.length > MAX_CACHE_BATCH_SIZE) {
    throw new Error('Photo fingerprint cache batch size is invalid');
  }
  return photoIds.map((photoId) => validateIdentifier(photoId, 'photoId'));
}

function validateCacheTtl(ttlSeconds: number): number {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MAX_HISTORY_TTL_SECONDS
  ) {
    throw new Error('Photo fingerprint cache TTL is outside the supported range');
  }
  return ttlSeconds;
}

function buildPhotoFingerprintCacheKey(photoId: string): string {
  return `${HISTORY_NAMESPACE}:fingerprint-cache:${shortHash(
    PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  )}:${shortHash(photoId)}`;
}

function parseCachedPhotoFingerprint(raw: string | null): PhotoFingerprint | null {
  if (!raw) {
    return null;
  }
  try {
    return validateCachedPhotoFingerprint(JSON.parse(raw) as PhotoFingerprint);
  } catch {
    return null;
  }
}

function validateCachedPhotoFingerprint(fingerprint: PhotoFingerprint): PhotoFingerprint {
  if (
    fingerprint?.algorithmVersion !== PHOTO_FINGERPRINT_ALGORITHM_VERSION ||
    !/^[0-9a-f]{64}$/.test(fingerprint.canonicalHash) ||
    !/^[0-9a-f]{64}$/.test(fingerprint.pdqHash) ||
    !Number.isSafeInteger(fingerprint.pdqQuality) ||
    fingerprint.pdqQuality < 0 ||
    fingerprint.pdqQuality > 100
  ) {
    throw new Error('Photo fingerprint cache value is invalid');
  }
  return {
    algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    canonicalHash: fingerprint.canonicalHash,
    pdqHash: fingerprint.pdqHash,
    pdqQuality: fingerprint.pdqQuality,
  };
}

function readRedisValue(value: number | string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

function parseMaxItems(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_000) {
    return DEFAULT_HISTORY_MAX_ITEMS;
  }
  return parsed;
}
