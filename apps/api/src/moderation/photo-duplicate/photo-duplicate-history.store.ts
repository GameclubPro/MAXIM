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
import {
  PHOTO_DUPLICATE_MATCH_KINDS,
  type PhotoDuplicateMatchKind,
} from './photo-duplicate.runtime';

const HISTORY_NAMESPACE = 'photo-duplicate:history:v2';
const DEFAULT_HISTORY_MAX_ITEMS = 250;
const MAX_HISTORY_TTL_SECONDS = 31 * 24 * 60 * 60;
const MAX_CACHE_BATCH_SIZE = 10;

// FLAG: Observation records matching evidence only. Sanction counters are committed separately,
// after execution-time moderation guards, so this script must never increment a counter.
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
    redis.call('HGET', KEYS[1], 'previous_message_id') or '',
    redis.call('HGET', KEYS[1], 'sanction_cluster_id') or '',
    redis.call('HGET', KEYS[1], 'violation_committed') or '0',
    redis.call('HGET', KEYS[1], 'action_authorized') or '0',
    redis.call('HGET', KEYS[1], 'authorization_digest') or ''
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
local recent_record_json = ARGV[12]
local canonical_sanction_cluster_id = ARGV[13]
local perceptual_sanction_cluster_id = ARGV[14]
local authorization_eligible = ARGV[15]
local authorization_digest = ARGV[16]
local authorization_match_kinds = ARGV[17]

local classification = 'new'
local cluster_id = deterministic_cluster_id
local match_kind = ''
local distance = ''
local previous_message_id = ''
local sanction_cluster_id = canonical_sanction_cluster_id

-- FLAG: An older delivery must be completely read-only. Inserting it into exact or perceptual
-- history can make a later stale delivery look like an actionable duplicate.
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
  return {
    3,
    'out_of_order',
    deterministic_cluster_id,
    '',
    '',
    0,
    '',
    canonical_sanction_cluster_id,
    0,
    0,
    authorization_digest
  }
end

redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff_at)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', cutoff_at)

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

-- FLAG: Exact history must win over a perceptual candidate. Otherwise A -> near B -> exact B is
-- classified as PDQ forever and canonical-only enforcement can never count B.
if prior then
  classification = 'duplicate'
  cluster_id = string.sub(prior, 1, 64)
  previous_message_id = string.sub(prior, 66)
  match_kind = exact_match_kind
  distance = '0'
elseif forced_cluster_id ~= '' and forced_previous_message_id ~= '' then
  classification = 'duplicate'
  cluster_id = forced_cluster_id
  previous_message_id = forced_previous_message_id
  match_kind = forced_match_kind
  distance = forced_distance
  sanction_cluster_id = perceptual_sanction_cluster_id
end

redis.call('ZADD', KEYS[2], occurred_at, cluster_id .. ':' .. current_message_id)
local exact_size = redis.call('ZCARD', KEYS[2])
if exact_size > max_items then
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, exact_size - max_items - 1)
end
redis.call('PEXPIRE', KEYS[2], ttl_ms)

if recent_record_json ~= '' then
  local recent_record = cjson.decode(recent_record_json)
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
  redis.call('HDEL', KEYS[4], sanction_cluster_id)
elseif classification == 'duplicate' then
  repeat_count = tonumber(redis.call('HGET', KEYS[4], sanction_cluster_id) or '0') + 1
end

local action_authorized = '0'
local match_kind_allowed = string.find(
  authorization_match_kinds,
  ',' .. match_kind .. ',',
  1,
  true
) ~= nil
if authorization_eligible == '1' and (classification ~= 'duplicate' or match_kind_allowed) then
  action_authorized = '1'
end

redis.call(
  'HSET',
  KEYS[1],
  'classification', classification,
  'cluster_id', cluster_id,
  'album_cluster_id', deterministic_cluster_id,
  'match_kind', match_kind,
  'distance', distance,
  'repeat_count', tostring(repeat_count),
  'previous_message_id', previous_message_id,
  'sanction_cluster_id', sanction_cluster_id,
  'violation_committed', '0',
  'action_authorized', action_authorized,
  'authorization_digest', authorization_digest
)
redis.call('PEXPIRE', KEYS[1], ttl_ms)

return {
  1,
  classification,
  cluster_id,
  match_kind,
  distance,
  repeat_count,
  previous_message_id,
  sanction_cluster_id,
  0,
  action_authorized,
  authorization_digest
}
`;

// FLAG: This is the only photo-duplicate sanction counter mutation. Replay state, observation
// binding, match-kind policy and the expected next count must remain in the same Redis script.
const COMMIT_PHOTO_VIOLATION_SCRIPT = `
local classification = redis.call('HGET', KEYS[1], 'classification')
if classification ~= 'duplicate' then
  return {0, '0', '', '', '', '0'}
end

local match_kind = redis.call('HGET', KEYS[1], 'match_kind') or ''
local cluster_id = redis.call('HGET', KEYS[1], 'cluster_id') or ''
local album_cluster_id = redis.call('HGET', KEYS[1], 'album_cluster_id') or ''
local sanction_cluster_id = redis.call('HGET', KEYS[1], 'sanction_cluster_id') or ''
if match_kind ~= ARGV[1]
  or cluster_id ~= ARGV[2]
  or sanction_cluster_id ~= ARGV[3]
  or album_cluster_id ~= ARGV[11]
then
  return {0, '0', '', '', '', '0'}
end

local expected_repeat_count = tonumber(ARGV[4])
local stored_repeat_count = tonumber(redis.call('HGET', KEYS[1], 'repeat_count') or '-1')
local stored_action = redis.call('HGET', KEYS[1], 'violation_action') or ''
local stored_binding_digest = redis.call('HGET', KEYS[1], 'violation_binding_digest') or ''
if stored_action ~= '' then
  local request_matches = '1'
  local match_kind_allowed = string.find(ARGV[7], ',' .. match_kind .. ',', 1, true) ~= nil
  if stored_repeat_count ~= expected_repeat_count
    or redis.call('HGET', KEYS[1], 'action_authorized') ~= '1'
    or redis.call('HGET', KEYS[1], 'authorization_digest') ~= ARGV[8]
    or not match_kind_allowed
    or stored_action ~= ARGV[9]
    or stored_binding_digest ~= ARGV[10]
  then
    request_matches = '0'
  end
  return {
    2,
    tostring(stored_repeat_count),
    sanction_cluster_id,
    stored_action,
    stored_binding_digest,
    request_matches
  }
end

if redis.call('HGET', KEYS[1], 'violation_committed') == '1' then
  return {0, '0', '', '', '', '0'}
end

local match_kind_allowed = string.find(ARGV[7], ',' .. match_kind .. ',', 1, true) ~= nil
if stored_repeat_count ~= expected_repeat_count
  or redis.call('HGET', KEYS[1], 'action_authorized') ~= '1'
  or redis.call('HGET', KEYS[1], 'authorization_digest') ~= ARGV[8]
  or not match_kind_allowed
then
  return {0, '0', '', '', '', '0'}
end

local current_repeat_count = tonumber(redis.call('HGET', KEYS[2], sanction_cluster_id) or '0')
if current_repeat_count + 1 ~= expected_repeat_count then
  return {0, '0', '', '', '', '0'}
end

local repeat_count = redis.call('HINCRBY', KEYS[2], sanction_cluster_id, 1)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[5]))
redis.call(
  'HSET',
  KEYS[1],
  'repeat_count', tostring(repeat_count),
  'violation_committed', '1',
  'violation_action', ARGV[9],
  'violation_binding_digest', ARGV[10]
)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))

local counter_size = redis.call('HLEN', KEYS[2])
if counter_size > tonumber(ARGV[6]) then
  local counter_clusters = redis.call('HKEYS', KEYS[2])
  local remove_count = counter_size - tonumber(ARGV[6])
  for _, candidate_cluster_id in ipairs(counter_clusters) do
    if remove_count <= 0 then
      break
    end
    if candidate_cluster_id ~= sanction_cluster_id then
      redis.call('HDEL', KEYS[2], candidate_cluster_id)
      remove_count = remove_count - 1
    end
  end
end

return {1, tostring(repeat_count), sanction_cluster_id, ARGV[9], ARGV[10], '1'}
`;

export type PhotoDuplicateScope = 'SAME_AUTHOR' | 'CHAT';
export type PhotoHistoryMatchKind = PhotoDuplicateMatchKind;
export type PhotoHistoryViolationAction = 'NONE' | 'HIT' | 'WARN' | 'MUTE' | 'BAN';

// FLAG: Callers hash semantic policy/settings only. Revisions, timestamps and rollout expiry do not
// belong in this digest because replay compatibility must describe behavior, not storage metadata.
export type PhotoHistoryObservationAuthorization = {
  authorized: boolean;
  configDigest: string;
};

export type PhotoHistoryObservationAuthorizationInput = {
  eligible: boolean;
  configDigest: string;
  allowedMatchKinds: readonly PhotoHistoryMatchKind[];
};

export type PhotoHistoryViolationActionBinding = {
  intendedAction: PhotoHistoryViolationAction;
  configDigest: string;
};

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
      sanctionClusterId: string;
      violationCommitted: boolean;
      authorization: PhotoHistoryObservationAuthorization;
    }
  | { kind: 'unavailable' };

export type PhotoHistoryViolationCommitResult =
  | {
      kind: 'available';
      committed: boolean;
      replayed: boolean;
      repeatCount: number;
      sanctionClusterId: string;
      bindingMatches: boolean;
      actionBinding: PhotoHistoryViolationActionBinding;
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
  authorization: PhotoHistoryObservationAuthorizationInput;
};

export type CommitPhotoViolationInput = {
  chatId: string;
  senderId: string;
  messageId: string;
  ttlSeconds: number;
  scope: PhotoDuplicateScope;
  fingerprintVersion: string;
  albumHash: string;
  perceptualPreset?: PhotoMatchPreset;
  observationClusterId: string;
  matchKind: PhotoHistoryMatchKind;
  expectedRepeatCount: number;
  allowedMatchKinds: readonly PhotoHistoryMatchKind[];
  authorizationConfigDigest: string;
  actionBinding: PhotoHistoryViolationActionBinding;
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
      const canonicalSanctionClusterId = buildCanonicalSanctionClusterId(
        normalized.fingerprintVersion,
        normalized.albumHash,
      );
      const perceptualSanctionClusterId = perceptualMatch
        ? buildPerceptualSanctionClusterId(normalized.fingerprintVersion, perceptualMatch.clusterId)
        : '';
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
        recentRecord,
        canonicalSanctionClusterId,
        perceptualSanctionClusterId,
        normalized.authorization.eligible ? '1' : '0',
        normalized.authorization.configDigest,
        encodeMatchKinds(normalized.authorization.allowedMatchKinds),
      )) as Array<number | string | Buffer>;

      return parseObservationResponse(response);
    } catch {
      this.logger.warn('Photo duplicate history unavailable; continuing fail-open');
      return { kind: 'unavailable' };
    }
  }

  async commitViolation(
    input: CommitPhotoViolationInput,
  ): Promise<PhotoHistoryViolationCommitResult> {
    const normalized = validateCommitInput(input);
    try {
      const keys = buildKeys(normalized);
      const ttlMs = normalized.ttlSeconds * 1_000;
      const response = (await this.redis.eval(
        COMMIT_PHOTO_VIOLATION_SCRIPT,
        2,
        keys.replayKey,
        keys.authorCounterKey,
        normalized.matchKind,
        normalized.observationClusterId,
        buildViolationSanctionClusterId(normalized),
        String(normalized.expectedRepeatCount),
        String(ttlMs),
        String(this.maxItems),
        encodeMatchKinds(normalized.allowedMatchKinds),
        normalized.authorizationConfigDigest,
        normalized.actionBinding.intendedAction,
        normalized.actionBinding.configDigest,
        buildClusterId(normalized.fingerprintVersion, normalized.albumHash),
      )) as Array<number | string | Buffer>;

      return parseViolationCommitResponse(response);
    } catch {
      this.logger.warn('Photo duplicate violation commit unavailable; continuing fail-open');
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
  const authorization = validateObservationAuthorization(input.authorization);

  return {
    ...input,
    chatId,
    senderId,
    messageId,
    fingerprintVersion,
    albumHash,
    authorization,
  };
}

function validateCommitInput(input: CommitPhotoViolationInput): CommitPhotoViolationInput {
  const chatId = validateIdentifier(input.chatId, 'chatId');
  const senderId = validateIdentifier(input.senderId, 'senderId');
  const messageId = validateIdentifier(input.messageId, 'messageId');
  const fingerprintVersion = input.fingerprintVersion.trim();
  const albumHash = input.albumHash.trim().toLowerCase();
  const observationClusterId = input.observationClusterId.trim().toLowerCase();
  if (!fingerprintVersion || fingerprintVersion.length > 128) {
    throw new Error('fingerprintVersion is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(albumHash)) {
    throw new Error('albumHash must be a 256-bit hexadecimal value');
  }
  if (!/^[0-9a-f]{64}$/.test(observationClusterId)) {
    throw new Error('observationClusterId must be a 256-bit hexadecimal value');
  }
  if (
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds <= 0 ||
    input.ttlSeconds > MAX_HISTORY_TTL_SECONDS
  ) {
    throw new Error('ttlSeconds is outside the supported range');
  }
  if (!Number.isSafeInteger(input.expectedRepeatCount) || input.expectedRepeatCount <= 0) {
    throw new Error('expectedRepeatCount must be a positive integer');
  }
  if (!PHOTO_DUPLICATE_MATCH_KINDS.includes(input.matchKind)) {
    throw new Error('matchKind is unsupported');
  }
  const allowedMatchKinds = Array.from(new Set(input.allowedMatchKinds));
  if (allowedMatchKinds.some((kind) => !PHOTO_DUPLICATE_MATCH_KINDS.includes(kind))) {
    throw new Error('allowedMatchKinds contains an unsupported match kind');
  }
  const authorizationConfigDigest = validateDigest(
    input.authorizationConfigDigest,
    'authorizationConfigDigest',
  );
  const actionBinding = validateActionBinding(input.actionBinding);

  return {
    ...input,
    chatId,
    senderId,
    messageId,
    fingerprintVersion,
    albumHash,
    observationClusterId,
    allowedMatchKinds,
    authorizationConfigDigest,
    actionBinding,
  };
}

function validateObservationAuthorization(
  input: PhotoHistoryObservationAuthorizationInput,
): PhotoHistoryObservationAuthorizationInput {
  if (!input || typeof input.eligible !== 'boolean') {
    throw new Error('authorization eligibility is invalid');
  }
  const allowedMatchKinds = Array.from(new Set(input.allowedMatchKinds));
  if (allowedMatchKinds.some((kind) => !PHOTO_DUPLICATE_MATCH_KINDS.includes(kind))) {
    throw new Error('authorization allowedMatchKinds contains an unsupported match kind');
  }
  return {
    eligible: input.eligible,
    configDigest: validateDigest(input.configDigest, 'authorization configDigest'),
    allowedMatchKinds,
  };
}

function validateActionBinding(
  input: PhotoHistoryViolationActionBinding,
): PhotoHistoryViolationActionBinding {
  if (!input || !['NONE', 'HIT', 'WARN', 'MUTE', 'BAN'].includes(input.intendedAction)) {
    throw new Error('actionBinding intendedAction is invalid');
  }
  return {
    intendedAction: input.intendedAction,
    configDigest: validateDigest(input.configDigest, 'actionBinding configDigest'),
  };
}

function validateDigest(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 256-bit hexadecimal value`);
  }
  return normalized;
}

function encodeMatchKinds(matchKinds: readonly PhotoHistoryMatchKind[]): string {
  return `,${matchKinds.join(',')},`;
}

function validateIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function buildKeys(
  input: Pick<
    CommitPhotoViolationInput,
    | 'chatId'
    | 'senderId'
    | 'messageId'
    | 'fingerprintVersion'
    | 'scope'
    | 'albumHash'
    | 'perceptualPreset'
  >,
): {
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

function buildCanonicalSanctionClusterId(fingerprintVersion: string, albumHash: string): string {
  return createHash('sha256')
    .update('photo-sanction-cluster-v2:canonical')
    .update('\0')
    .update(fingerprintVersion)
    .update('\0')
    .update(albumHash)
    .digest('hex');
}

function buildPerceptualSanctionClusterId(
  fingerprintVersion: string,
  observationClusterId: string,
): string {
  return createHash('sha256')
    .update('photo-sanction-cluster-v2:pdq')
    .update('\0')
    .update(fingerprintVersion)
    .update('\0')
    .update(observationClusterId)
    .digest('hex');
}

function buildViolationSanctionClusterId(input: CommitPhotoViolationInput): string {
  return input.matchKind === 'pdq'
    ? buildPerceptualSanctionClusterId(input.fingerprintVersion, input.observationClusterId)
    : buildCanonicalSanctionClusterId(input.fingerprintVersion, input.albumHash);
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
  const sanctionClusterId = readRedisValue(response[7]);
  const rawViolationCommitted = readRedisValue(response[8]);
  const rawActionAuthorized = readRedisValue(response[9]);
  const authorizationConfigDigest = readRedisValue(response[10]);
  if (
    (writeStatus !== 1 && writeStatus !== 2 && writeStatus !== 3) ||
    (writeStatus === 3 && classification !== 'out_of_order') ||
    !['new', 'duplicate', 'out_of_order'].includes(classification) ||
    !/^[0-9a-f]{64}$/.test(clusterId) ||
    !/^[0-9a-f]{64}$/.test(sanctionClusterId) ||
    !Number.isSafeInteger(repeatCount) ||
    repeatCount < 0 ||
    (rawViolationCommitted !== '0' && rawViolationCommitted !== '1') ||
    (rawActionAuthorized !== '0' && rawActionAuthorized !== '1') ||
    !/^[0-9a-f]{64}$/.test(authorizationConfigDigest)
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
    sanctionClusterId,
    violationCommitted: rawViolationCommitted === '1',
    authorization: {
      authorized: rawActionAuthorized === '1',
      configDigest: authorizationConfigDigest,
    },
  };
}

function parseViolationCommitResponse(
  response: Array<number | string | Buffer>,
): PhotoHistoryViolationCommitResult {
  const status = Number(readRedisValue(response[0]));
  const repeatCount = Number(readRedisValue(response[1]));
  const sanctionClusterId = readRedisValue(response[2]);
  const intendedAction = readRedisValue(response[3]);
  const configDigest = readRedisValue(response[4]);
  const rawBindingMatches = readRedisValue(response[5]);
  if (
    (status !== 1 && status !== 2) ||
    !Number.isSafeInteger(repeatCount) ||
    repeatCount <= 0 ||
    !/^[0-9a-f]{64}$/.test(sanctionClusterId) ||
    !['NONE', 'HIT', 'WARN', 'MUTE', 'BAN'].includes(intendedAction) ||
    !/^[0-9a-f]{64}$/.test(configDigest) ||
    (rawBindingMatches !== '0' && rawBindingMatches !== '1')
  ) {
    return { kind: 'unavailable' };
  }
  return {
    kind: 'available',
    committed: status === 1,
    replayed: status === 2,
    repeatCount,
    sanctionClusterId,
    bindingMatches: rawBindingMatches === '1',
    actionBinding: {
      intendedAction: intendedAction as PhotoHistoryViolationAction,
      configDigest,
    },
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
