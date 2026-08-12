import type { RedisOptions } from 'ioredis';

const COMMERCIAL_OCR_REDIS_TIMEOUT_MS = 1_000;

export const COMMERCIAL_OCR_REDIS_OPTIONS = {
  commandTimeout: COMMERCIAL_OCR_REDIS_TIMEOUT_MS,
  connectTimeout: COMMERCIAL_OCR_REDIS_TIMEOUT_MS,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
} as const satisfies RedisOptions;
