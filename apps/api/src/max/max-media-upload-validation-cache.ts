import { createHash } from 'node:crypto';
import {
  type MaxValidatedImageUpload,
  type MaxValidatedMediaUpload,
  type MaxValidatedVideoUpload,
  validateMaxMediaUploadPayload,
} from './max-media-upload-validation';

const DEFAULT_MAX_MEDIA_VALIDATION_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_MEDIA_VALIDATION_CACHE_ENTRIES = 256;
const DEFAULT_MAX_MEDIA_VALIDATION_IN_FLIGHT = 2;
const MAX_MEDIA_VALIDATION_HASH_CHUNK_BYTES = 4 * 1024 * 1024;

type MaxMediaUploadValidator = (
  uploadType: 'image' | 'video',
  data: Buffer,
) => Promise<MaxValidatedMediaUpload>;

type MaxMediaUploadValidationCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  maxInFlight?: number;
  now?: () => number;
  validator?: MaxMediaUploadValidator;
};

type CompletedValidation = {
  expiresAtMs: number;
  value: MaxValidatedMediaUpload;
};

const defaultValidator: MaxMediaUploadValidator = (uploadType, data) =>
  uploadType === 'image'
    ? validateMaxMediaUploadPayload('image', data)
    : validateMaxMediaUploadPayload('video', data);

export class MaxMediaUploadValidationCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxInFlight: number;
  private readonly now: () => number;
  private readonly validator: MaxMediaUploadValidator;
  private readonly completed = new Map<string, CompletedValidation>();
  private readonly inFlight = new Map<string, Promise<MaxValidatedMediaUpload>>();
  private readonly validationSlotWaiters: Array<() => void> = [];
  private activeValidations = 0;
  private generation = 0;

  constructor(options: MaxMediaUploadValidationCacheOptions = {}) {
    this.ttlMs = this.normalizePositiveInteger(
      options.ttlMs,
      DEFAULT_MAX_MEDIA_VALIDATION_CACHE_TTL_MS,
    );
    this.maxEntries = this.normalizePositiveInteger(
      options.maxEntries,
      DEFAULT_MAX_MEDIA_VALIDATION_CACHE_ENTRIES,
    );
    this.maxInFlight = this.normalizePositiveInteger(
      options.maxInFlight,
      DEFAULT_MAX_MEDIA_VALIDATION_IN_FLIGHT,
    );
    this.now = options.now ?? Date.now;
    this.validator = options.validator ?? defaultValidator;
  }

  validate(uploadType: 'image', data: Buffer): Promise<MaxValidatedImageUpload>;
  validate(uploadType: 'video', data: Buffer): Promise<MaxValidatedVideoUpload>;
  async validate(uploadType: 'image' | 'video', data: Buffer): Promise<MaxValidatedMediaUpload> {
    const generation = this.generation;
    const key = await this.buildKey(uploadType, data);
    if (generation !== this.generation) {
      return this.runUncachedValidation(uploadType, data);
    }
    const cached = this.readCompleted(key);
    if (cached) {
      return Promise.resolve(cached);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const validation = this.runValidationWithAdmission(uploadType, data, key, generation).finally(
      () => {
        if (this.inFlight.get(key) === validation) {
          this.inFlight.delete(key);
        }
      },
    );
    this.inFlight.set(key, validation);
    return validation;
  }

  private async runValidationWithAdmission(
    uploadType: 'image' | 'video',
    data: Buffer,
    key: string,
    generation: number,
  ): Promise<MaxValidatedMediaUpload> {
    const admission = this.acquireValidationSlot();
    if (admission) {
      await admission;
    }
    try {
      return await this.runValidation(uploadType, data, key, generation);
    } finally {
      this.releaseValidationSlot();
    }
  }

  private async runUncachedValidation(
    uploadType: 'image' | 'video',
    data: Buffer,
  ): Promise<MaxValidatedMediaUpload> {
    const admission = this.acquireValidationSlot();
    if (admission) {
      await admission;
    }
    try {
      return await this.validator(uploadType, data);
    } finally {
      this.releaseValidationSlot();
    }
  }

  clear(): void {
    this.generation += 1;
    this.completed.clear();
    this.inFlight.clear();
  }

  private async runValidation(
    uploadType: 'image' | 'video',
    data: Buffer,
    key: string,
    generation: number,
  ): Promise<MaxValidatedMediaUpload> {
    const value = await this.validator(uploadType, data);
    if (generation === this.generation) {
      this.writeCompleted(key, value);
    }
    return value;
  }

  private acquireValidationSlot(): Promise<void> | null {
    if (this.activeValidations < this.maxInFlight && this.validationSlotWaiters.length === 0) {
      this.activeValidations += 1;
      return null;
    }
    return new Promise<void>((resolve) => this.validationSlotWaiters.push(resolve));
  }

  private releaseValidationSlot(): void {
    const next = this.validationSlotWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.activeValidations = Math.max(0, this.activeValidations - 1);
  }

  private readCompleted(key: string): MaxValidatedMediaUpload | null {
    const entry = this.completed.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs <= this.now()) {
      this.completed.delete(key);
      return null;
    }

    this.completed.delete(key);
    this.completed.set(key, entry);
    return entry.value;
  }

  private writeCompleted(key: string, value: MaxValidatedMediaUpload): void {
    const now = this.now();
    for (const [cachedKey, entry] of this.completed) {
      if (entry.expiresAtMs <= now) {
        this.completed.delete(cachedKey);
      }
    }

    this.completed.delete(key);
    this.completed.set(key, {
      expiresAtMs: now + this.ttlMs,
      value,
    });
    while (this.completed.size > this.maxEntries) {
      const oldestKey = this.completed.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.completed.delete(oldestKey);
    }
  }

  private async buildKey(uploadType: 'image' | 'video', data: Buffer): Promise<string> {
    const hash = createHash('sha256');
    for (let offset = 0; offset < data.length; offset += MAX_MEDIA_VALIDATION_HASH_CHUNK_BYTES) {
      const end = Math.min(offset + MAX_MEDIA_VALIDATION_HASH_CHUNK_BYTES, data.length);
      hash.update(data.subarray(offset, end));
      if (end < data.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return `${uploadType}:${hash.digest('hex')}`;
  }

  private normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 1
      ? Math.floor(value)
      : fallback;
  }
}
