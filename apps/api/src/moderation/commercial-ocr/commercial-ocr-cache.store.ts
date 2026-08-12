import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { validateCommercialOcrVersion } from './commercial-ocr.queue';
import { COMMERCIAL_OCR_REDIS_OPTIONS } from './commercial-ocr-redis.options';

const SINGLEFLIGHT_NAMESPACE = 'commercial-ocr:singleflight:v3';
export const COMMERCIAL_OCR_CACHE_SCHEMA_VERSION = 2 as const;
const MAX_TEXT_LENGTH = 8_000;
const MAX_WORDS = 1_024;
const MAX_WORD_LENGTH = 256;
const MAX_CACHE_TTL_SECONDS = 31 * 24 * 60 * 60;
const MAX_LOCAL_CACHE_ENTRIES = 512;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_SINGLEFLIGHT_TTL_MS = 1_000;
const MAX_SINGLEFLIGHT_TTL_MS = 60_000;
const REDIS_OPERATION_TIMEOUT_MS = 1_000;

const COMMIT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export type CommercialOcrCacheValue = Readonly<{
  schemaVersion: typeof COMMERCIAL_OCR_CACHE_SCHEMA_VERSION;
  status: 'recognized' | 'no_text';
  text: string;
  confidencePermille: number;
  words: readonly CommercialOcrCachedWord[];
}>;

export type CommercialOcrCachedWord = Readonly<{
  text: string;
  start: number;
  end: number;
  confidencePermille: number;
}>;

export type CommercialOcrCacheIdentity = Readonly<{
  contentSha256: string;
  ocrVersion: string;
  pass: 'primary' | 'confirmation';
  preprocessProfile: string;
  psm: 6 | 11;
}>;

export type CommercialOcrCacheLookup =
  | { kind: 'hit'; value: CommercialOcrCacheValue }
  | { kind: 'miss' }
  | { kind: 'unavailable' };

export type CommercialOcrSingleflightClaim =
  | { kind: 'acquired'; token: string }
  | { kind: 'busy' }
  | { kind: 'unavailable' };

type LocalCacheEntry = {
  expiresAtMs: number;
  value: CommercialOcrCacheValue;
};

@Injectable()
export class CommercialOcrCacheStore implements OnModuleDestroy {
  private readonly logger = new Logger(CommercialOcrCacheStore.name);
  private readonly redis: Redis;
  // OCR output can contain personal data. Keep exact results process-local and bounded so Redis
  // persistence never retains recognized text; a restart may lose only this optimization.
  private readonly localEntries = new Map<string, LocalCacheEntry>();
  private expiryTimer: NodeJS.Timeout | null = null;
  private expiryTimerDueAtMs: number | null = null;
  private destroyed = false;

  constructor(configService: ConfigService) {
    this.redis = new Redis(
      configService.getOrThrow<string>('REDIS_URL'),
      COMMERCIAL_OCR_REDIS_OPTIONS,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.clearExpiryTimer();
    this.localEntries.clear();
    if (this.redis.status === 'ready') {
      await this.redis.quit();
      return;
    }
    this.redis.disconnect();
  }

  async read(identity: CommercialOcrCacheIdentity): Promise<CommercialOcrCacheLookup> {
    const key = buildCacheKey(validateIdentity(identity));
    const entry = this.localEntries.get(key);
    if (!entry) {
      return { kind: 'miss' };
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.localEntries.delete(key);
      this.scheduleExpiryPurge();
      return { kind: 'miss' };
    }
    this.localEntries.delete(key);
    this.localEntries.set(key, entry);
    return { kind: 'hit', value: entry.value };
  }

  async write(
    identity: CommercialOcrCacheIdentity,
    value: CommercialOcrCacheValue,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = buildCacheKey(validateIdentity(identity));
    const normalizedValue = validateValue(value);
    const normalizedTtlSeconds = validateCacheTtl(ttlSeconds);
    this.writeLocal(key, normalizedValue, normalizedTtlSeconds);
    return true;
  }

  async claimSingleflight(
    identity: CommercialOcrCacheIdentity,
    leaseTtlMs: number,
  ): Promise<CommercialOcrSingleflightClaim> {
    const key = buildCacheKey(validateIdentity(identity));
    const normalizedLeaseTtlMs = validateSingleflightTtl(leaseTtlMs);
    const token = randomUUID();
    try {
      const acquired = await this.runRedisOperation(
        this.redis.set(`${SINGLEFLIGHT_NAMESPACE}:${key}`, token, 'PX', normalizedLeaseTtlMs, 'NX'),
      );
      return acquired === 'OK' ? { kind: 'acquired', token } : { kind: 'busy' };
    } catch {
      this.logger.warn('Commercial OCR singleflight claim unavailable');
      return { kind: 'unavailable' };
    }
  }

  async commitSingleflight(params: {
    identity: CommercialOcrCacheIdentity;
    token: string;
    value: CommercialOcrCacheValue;
    ttlSeconds: number;
  }): Promise<boolean> {
    const key = buildCacheKey(validateIdentity(params.identity));
    const token = validateToken(params.token);
    const value = validateValue(params.value);
    const ttlSeconds = validateCacheTtl(params.ttlSeconds);
    try {
      const committed =
        Number(
          await this.runRedisOperation(
            this.redis.eval(COMMIT_SCRIPT, 1, `${SINGLEFLIGHT_NAMESPACE}:${key}`, token),
          ),
        ) === 1;
      if (committed) {
        this.writeLocal(key, value, ttlSeconds);
      }
      return committed;
    } catch {
      this.logger.warn('Commercial OCR singleflight commit unavailable');
      return false;
    }
  }

  async releaseSingleflight(identity: CommercialOcrCacheIdentity, token: string): Promise<boolean> {
    const key = buildCacheKey(validateIdentity(identity));
    const normalizedToken = validateToken(token);
    try {
      return (
        Number(
          await this.runRedisOperation(
            this.redis.eval(RELEASE_SCRIPT, 1, `${SINGLEFLIGHT_NAMESPACE}:${key}`, normalizedToken),
          ),
        ) === 1
      );
    } catch {
      this.logger.warn('Commercial OCR singleflight release unavailable');
      return false;
    }
  }

  private runRedisOperation<T>(operation: Promise<T>): Promise<T> {
    return raceWithTimeout({
      operation,
      timeoutMs: REDIS_OPERATION_TIMEOUT_MS,
      onTimeout: () => {
        throw new Error('Commercial OCR cache Redis operation timed out');
      },
    });
  }

  private writeLocal(key: string, value: CommercialOcrCacheValue, ttlSeconds: number): void {
    const nowMs = Date.now();
    this.purgeExpiredLocalEntries(nowMs);
    this.localEntries.delete(key);
    this.localEntries.set(key, {
      expiresAtMs: nowMs + ttlSeconds * 1_000,
      value,
    });
    while (this.localEntries.size > MAX_LOCAL_CACHE_ENTRIES) {
      const oldestKey = this.localEntries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.localEntries.delete(oldestKey);
    }
    this.scheduleExpiryPurge(nowMs);
  }

  private purgeExpiredLocalEntries(nowMs = Date.now()): void {
    for (const [key, entry] of this.localEntries) {
      if (entry.expiresAtMs <= nowMs) {
        this.localEntries.delete(key);
      }
    }
  }

  private scheduleExpiryPurge(nowMs = Date.now()): void {
    if (this.destroyed || this.localEntries.size === 0) {
      this.clearExpiryTimer();
      return;
    }

    let earliestExpiryAtMs = Number.POSITIVE_INFINITY;
    for (const entry of this.localEntries.values()) {
      earliestExpiryAtMs = Math.min(earliestExpiryAtMs, entry.expiresAtMs);
    }
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliestExpiryAtMs - nowMs));
    const dueAtMs = nowMs + delayMs;
    if (
      this.expiryTimer &&
      this.expiryTimerDueAtMs !== null &&
      this.expiryTimerDueAtMs <= dueAtMs
    ) {
      return;
    }

    this.clearExpiryTimer();
    this.expiryTimerDueAtMs = dueAtMs;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expiryTimerDueAtMs = null;
      this.purgeExpiredLocalEntries();
      this.scheduleExpiryPurge();
    }, delayMs);
    this.expiryTimer.unref?.();
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
    }
    this.expiryTimer = null;
    this.expiryTimerDueAtMs = null;
  }
}

function validateIdentity(identity: CommercialOcrCacheIdentity): CommercialOcrCacheIdentity {
  const contentSha256 = identity.contentSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
    throw new Error('contentSha256 is invalid');
  }
  return {
    contentSha256,
    ocrVersion: validateCommercialOcrVersion(identity.ocrVersion),
    pass: validatePass(identity.pass),
    preprocessProfile: validateProfile(identity.preprocessProfile),
    psm: validatePsm(identity.psm),
  };
}

function buildCacheKey(identity: CommercialOcrCacheIdentity): string {
  return createHash('sha256')
    .update(identity.ocrVersion)
    .update('\0')
    .update(identity.pass)
    .update('\0')
    .update(identity.preprocessProfile)
    .update('\0')
    .update(String(identity.psm))
    .update('\0')
    .update(identity.contentSha256)
    .digest('hex');
}

function validateValue(value: CommercialOcrCacheValue): CommercialOcrCacheValue {
  if (value.schemaVersion !== COMMERCIAL_OCR_CACHE_SCHEMA_VERSION) {
    throw new Error('Commercial OCR cache schema version is invalid');
  }
  if (value.status !== 'recognized' && value.status !== 'no_text') {
    throw new Error('Commercial OCR cache status is invalid');
  }
  if (typeof value.text !== 'string' || value.text.length > MAX_TEXT_LENGTH) {
    throw new Error('Commercial OCR cache text is invalid');
  }
  if (value.status === 'recognized' ? value.text.trim().length === 0 : value.text.length !== 0) {
    throw new Error('Commercial OCR cache text does not match its status');
  }
  if (
    !Number.isSafeInteger(value.confidencePermille) ||
    value.confidencePermille < 0 ||
    value.confidencePermille > 1_000
  ) {
    throw new Error('Commercial OCR cache confidence is invalid');
  }
  if (!Array.isArray(value.words) || value.words.length > MAX_WORDS) {
    throw new Error('Commercial OCR cache words are invalid');
  }
  let previousEnd = 0;
  const words = value.words.map((word) => {
    const normalizedWord = validateWord(word, value.text);
    if (normalizedWord.start < previousEnd) {
      throw new Error('Commercial OCR cache word ordering is invalid');
    }
    previousEnd = normalizedWord.end;
    return normalizedWord;
  });
  if (value.status === 'no_text' ? words.length !== 0 : words.length === 0) {
    throw new Error('Commercial OCR cache words do not match its status');
  }
  return Object.freeze({ ...value, words: Object.freeze(words) });
}

function validateWord(word: CommercialOcrCachedWord, text: string): CommercialOcrCachedWord {
  if (
    !word ||
    typeof word.text !== 'string' ||
    word.text.length === 0 ||
    word.text.length > MAX_WORD_LENGTH ||
    !Number.isSafeInteger(word.start) ||
    !Number.isSafeInteger(word.end) ||
    word.start < 0 ||
    word.end <= word.start ||
    word.end > text.length ||
    text.slice(word.start, word.end) !== word.text ||
    !Number.isSafeInteger(word.confidencePermille) ||
    word.confidencePermille < 0 ||
    word.confidencePermille > 1_000
  ) {
    throw new Error('Commercial OCR cache word is invalid');
  }
  return Object.freeze({ ...word });
}

function validateCacheTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CACHE_TTL_SECONDS) {
    throw new Error('Commercial OCR cache TTL is invalid');
  }
  return value;
}

function validateSingleflightTtl(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_SINGLEFLIGHT_TTL_MS ||
    value > MAX_SINGLEFLIGHT_TTL_MS
  ) {
    throw new Error('Commercial OCR singleflight TTL is invalid');
  }
  return value;
}

function validateToken(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9-]{16,128}$/u.test(normalized)) {
    throw new Error('Commercial OCR singleflight token is invalid');
  }
  return normalized;
}

function validatePass(value: string): 'primary' | 'confirmation' {
  if (value !== 'primary' && value !== 'confirmation') {
    throw new Error('Commercial OCR cache pass is invalid');
  }
  return value;
}

function validateProfile(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error('Commercial OCR cache preprocess profile is invalid');
  }
  return normalized;
}

function validatePsm(value: number): 6 | 11 {
  if (value !== 6 && value !== 11) {
    throw new Error('Commercial OCR cache PSM is invalid');
  }
  return value;
}
