import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RedisCounterService } from '../moderation/redis-counter.service';

const MAX_PHASE_LENGTH = 80;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_ROUTE_LENGTH = 512;
const MAX_URL_LENGTH = 1024;
const MAX_UA_LENGTH = 512;
const MAX_PLATFORM_LENGTH = 80;
const MAX_ELAPSED_MS = 10 * 60 * 1_000;
const MAX_DETAILS_INPUT_JSON_LENGTH = 8 * 1_024;
const MAX_DETAILS_LOG_JSON_LENGTH = 4 * 1_024;
const MAX_DETAILS_DEPTH = 4;
const MAX_DETAILS_OBJECT_KEYS = 30;
const MAX_DETAILS_ARRAY_ITEMS = 20;
const MAX_DETAILS_STRING_LENGTH = 500;
const BOOT_TRACE_RATE_WINDOW_SECONDS = 60;
const BOOT_TRACE_GLOBAL_RATE_LIMIT = 300;
const BOOT_TRACE_SOURCE_SESSION_RATE_LIMIT = 30;
const MAX_LOCAL_RATE_BUCKETS = 2_048;
const REDACTED = '[redacted]';

const sensitiveKeyFragments = [
  'authorization',
  'cookie',
  'hash',
  'initdata',
  'initdataunsafe',
  'secret',
  'signature',
  'startapp',
  'startparam',
  'token',
  'webappstartparam',
  'webappdata',
];
const sensitiveExactKeys = new Set(['q', 'query', 'search']);

const miniappBootTraceBodySchema = z
  .object({
    phase: z.string().trim().min(1).max(MAX_PHASE_LENGTH),
    sessionId: z.string().trim().min(1).max(MAX_SESSION_ID_LENGTH).nullish(),
    sequence: z.number().int().min(1).max(10_000).nullish(),
    route: z.string().trim().min(1).max(MAX_ROUTE_LENGTH).nullish(),
    url: z.string().trim().min(1).max(MAX_URL_LENGTH).nullish(),
    elapsedMs: z.number().finite().min(0).max(MAX_ELAPSED_MS).nullish(),
    ua: z.string().trim().min(1).max(MAX_UA_LENGTH).nullish(),
    platform: z.string().trim().min(1).max(MAX_PLATFORM_LENGTH).nullish(),
    details: z.unknown().optional(),
  })
  .strip();

export type MiniappBootTraceLogPayload = {
  phase: string;
  sessionId?: string;
  sequence?: number;
  route?: string;
  url?: string;
  elapsedMs?: number;
  ua?: string;
  platform?: string;
  details?: unknown;
};

@Injectable()
export class MiniappBootTraceService {
  private readonly logger = new Logger(MiniappBootTraceService.name);
  private readonly localRateBuckets = new Map<string, { count: number; expiresAtMs: number }>();

  constructor(@Optional() private readonly redisCounter?: RedisCounterService) {}

  async record(payload: unknown, source = 'unknown'): Promise<boolean> {
    const trace = parseMiniappBootTracePayload(payload);
    if (!(await this.shouldLog(source, trace.sessionId))) {
      return false;
    }
    this.logger.log({ trace }, 'Mini app boot trace');
    return true;
  }

  private async shouldLog(source: string, sessionId: string | undefined): Promise<boolean> {
    const sourceSessionHash = createHash('sha256')
      .update(source.trim() || 'unknown')
      .update('\0')
      .update(sessionId ?? 'anonymous')
      .digest('hex');
    const globalKey = 'maxim:miniapp-boot-trace:v1:global';
    const sourceKey = `maxim:miniapp-boot-trace:v1:source:${sourceSessionHash}`;

    if (this.redisCounter) {
      try {
        const globalCount = await this.redisCounter.incrementWithTtl(
          globalKey,
          BOOT_TRACE_RATE_WINDOW_SECONDS,
        );
        if (globalCount > BOOT_TRACE_GLOBAL_RATE_LIMIT) {
          return false;
        }

        const sourceCount = await this.redisCounter.incrementWithTtl(
          sourceKey,
          BOOT_TRACE_RATE_WINDOW_SECONDS,
        );
        return sourceCount <= BOOT_TRACE_SOURCE_SESSION_RATE_LIMIT;
      } catch {
        // The diagnostic endpoint must not depend on Redis availability.
      }
    }

    if (this.incrementLocalRateBucket(globalKey) > BOOT_TRACE_GLOBAL_RATE_LIMIT) {
      return false;
    }

    return this.incrementLocalRateBucket(sourceKey) <= BOOT_TRACE_SOURCE_SESSION_RATE_LIMIT;
  }

  private incrementLocalRateBucket(key: string): number {
    const now = Date.now();
    const current = this.localRateBuckets.get(key);
    if (current && current.expiresAtMs > now) {
      current.count += 1;
      return current.count;
    }
    if (current) {
      this.localRateBuckets.delete(key);
    }

    if (this.localRateBuckets.size >= MAX_LOCAL_RATE_BUCKETS) {
      for (const [bucketKey, bucket] of this.localRateBuckets) {
        if (bucket.expiresAtMs <= now) {
          this.localRateBuckets.delete(bucketKey);
        }
      }
    }
    const boundedKey =
      this.localRateBuckets.has(key) || this.localRateBuckets.size < MAX_LOCAL_RATE_BUCKETS
        ? key
        : 'maxim:miniapp-boot-trace:v1:source:overflow';
    const boundedCurrent = this.localRateBuckets.get(boundedKey);
    if (boundedCurrent && boundedCurrent.expiresAtMs > now) {
      boundedCurrent.count += 1;
      return boundedCurrent.count;
    }

    this.localRateBuckets.set(boundedKey, {
      count: 1,
      expiresAtMs: now + BOOT_TRACE_RATE_WINDOW_SECONDS * 1_000,
    });
    return 1;
  }
}

export function parseMiniappBootTracePayload(payload: unknown): MiniappBootTraceLogPayload {
  const parsed = miniappBootTraceBodySchema.safeParse(payload);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  assertDetailsInputSize(parsed.data.details);

  const trace: MiniappBootTraceLogPayload = {
    phase: sanitizeText(parsed.data.phase, MAX_PHASE_LENGTH),
  };

  assignSanitized(trace, 'sessionId', parsed.data.sessionId, MAX_SESSION_ID_LENGTH);
  if (trace.phase !== 'publication_api') {
    assignSanitized(trace, 'route', parsed.data.route, MAX_ROUTE_LENGTH);
    assignSanitized(trace, 'url', parsed.data.url, MAX_URL_LENGTH);
  }
  assignSanitized(trace, 'ua', parsed.data.ua, MAX_UA_LENGTH);
  assignSanitized(trace, 'platform', parsed.data.platform, MAX_PLATFORM_LENGTH);

  if (parsed.data.elapsedMs != null) {
    trace.elapsedMs = parsed.data.elapsedMs;
  }
  if (parsed.data.sequence != null) {
    trace.sequence = parsed.data.sequence;
  }
  if (parsed.data.details !== undefined) {
    trace.details = limitDetailsLogSize(sanitizeDetails(parsed.data.details));
  }

  return trace;
}

function assignSanitized<K extends keyof MiniappBootTraceLogPayload>(
  target: MiniappBootTraceLogPayload,
  key: K,
  value: string | null | undefined,
  maxLength: number,
) {
  if (value != null) {
    target[key] = sanitizeText(value, maxLength) as MiniappBootTraceLogPayload[K];
  }
}

function assertDetailsInputSize(details: unknown) {
  if (details === undefined) {
    return;
  }

  const json = safeJsonStringify(details);
  if (json.length > MAX_DETAILS_INPUT_JSON_LENGTH) {
    throw new BadRequestException({
      details: [`details must be at most ${MAX_DETAILS_INPUT_JSON_LENGTH} JSON characters`],
    });
  }
}

function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeText(value, MAX_DETAILS_STRING_LENGTH);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (depth >= MAX_DETAILS_DEPTH) {
    return '[truncated-depth]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAILS_ARRAY_ITEMS).map((item) => sanitizeDetails(item, depth + 1));
  }

  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    const redactDialogPayloadToken = isChannelDialogLaunchPayload(value);
    for (const [key, nestedValue] of Object.entries(value).slice(0, MAX_DETAILS_OBJECT_KEYS)) {
      const sanitizedKey = sanitizeText(key, 80);
      sanitized[sanitizedKey] =
        isSensitiveKey(key) || (redactDialogPayloadToken && isDialogTokenKey(key))
          ? REDACTED
          : sanitizeDetails(nestedValue, depth + 1);
    }
    return sanitized;
  }

  return null;
}

function limitDetailsLogSize(details: unknown): unknown {
  const json = safeJsonStringify(details);
  if (json.length <= MAX_DETAILS_LOG_JSON_LENGTH) {
    return details;
  }

  return {
    truncated: true,
    preview: json.slice(0, MAX_DETAILS_LOG_JSON_LENGTH),
  };
}

function sanitizeText(value: string, maxLength: number): string {
  return redactSensitiveFragments(value).slice(0, maxLength);
}

function redactSensitiveFragments(value: string): string {
  const redactedQueryValues = value.replace(
    /(^|[?&#\s|,;])([^=?&#\s|,;]{1,100})=([^&#\s|,;]*)/g,
    (match: string, separator: string, key: string) => {
      return isSensitiveKey(decodeURIComponentSafe(key)) ? `${separator}${key}=${REDACTED}` : match;
    },
  );

  const redactedLaunchParamAssignments = redactedQueryValues.replace(
    /\b((?:WebAppStartParam|startapp|start[-_]?param)\s*=\s*)[^\s&#,;|]+/giu,
    (_match: string, prefix: string) => `${prefix}${REDACTED}`,
  );

  const redactedAuthorization = redactedLaunchParamAssignments.replace(
    /\b(authorization\s*[:=]\s*)((?:bearer|initdata)\s+)?[^\r\n,;]+/gi,
    (_match: string, prefix: string, scheme = '') => `${prefix}${scheme}${REDACTED}`,
  );

  return redactChannelDialogPayloadFragments(redactedAuthorization);
}

function isSensitiveKey(key: string): boolean {
  const exact = key.trim().toLowerCase();
  if (sensitiveExactKeys.has(exact)) {
    return true;
  }
  const normalized = exact.replace(/[^a-z0-9]/g, '');
  return sensitiveKeyFragments.some((fragment) => normalized.includes(fragment));
}

function isDialogTokenKey(key: string): boolean {
  return key.trim().toLowerCase() === 't';
}

function isChannelDialogLaunchPayload(value: object): boolean {
  const payload = value as Record<string, unknown>;
  return payload.k === 'channel-dialog' || payload.k === 'chat-dialog';
}

function redactChannelDialogPayloadFragments(value: string): string {
  const redactedPayload = value.replace(/\bcd-[A-Za-z0-9_-]{16,}/g, `cd-${REDACTED}`);
  if (!/["']k["']\s*:\s*["'](?:channel-dialog|chat-dialog)["']/u.test(redactedPayload)) {
    return redactedPayload;
  }

  return redactedPayload.replace(/(["']t["']\s*:\s*["'])[^"']{1,512}(["'])/gu, `$1${REDACTED}$2`);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
