import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

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
const REDACTED = '[redacted]';

const sensitiveKeyFragments = [
  'authorization',
  'cookie',
  'hash',
  'initdata',
  'initdataunsafe',
  'secret',
  'signature',
  'token',
  'webappdata',
];

const miniappBootTraceBodySchema = z
  .object({
    phase: z.string().trim().min(1).max(MAX_PHASE_LENGTH),
    sessionId: z.string().trim().min(1).max(MAX_SESSION_ID_LENGTH).optional(),
    sequence: z.number().int().min(1).max(10_000).optional(),
    route: z.string().trim().min(1).max(MAX_ROUTE_LENGTH).optional(),
    url: z.string().trim().min(1).max(MAX_URL_LENGTH).optional(),
    elapsedMs: z.number().finite().min(0).max(MAX_ELAPSED_MS).optional(),
    ua: z.string().trim().min(1).max(MAX_UA_LENGTH).optional(),
    platform: z.string().trim().min(1).max(MAX_PLATFORM_LENGTH).optional(),
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

  record(payload: unknown): void {
    const trace = parseMiniappBootTracePayload(payload);
    this.logger.log({ trace }, 'Mini app boot trace');
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
  assignSanitized(trace, 'route', parsed.data.route, MAX_ROUTE_LENGTH);
  assignSanitized(trace, 'url', parsed.data.url, MAX_URL_LENGTH);
  assignSanitized(trace, 'ua', parsed.data.ua, MAX_UA_LENGTH);
  assignSanitized(trace, 'platform', parsed.data.platform, MAX_PLATFORM_LENGTH);

  if (parsed.data.elapsedMs !== undefined) {
    trace.elapsedMs = parsed.data.elapsedMs;
  }
  if (parsed.data.sequence !== undefined) {
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
  value: string | undefined,
  maxLength: number,
) {
  if (value !== undefined) {
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
    return value
      .slice(0, MAX_DETAILS_ARRAY_ITEMS)
      .map((item) => sanitizeDetails(item, depth + 1));
  }

  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, MAX_DETAILS_OBJECT_KEYS)) {
      const sanitizedKey = sanitizeText(key, 80);
      sanitized[sanitizedKey] = isSensitiveKey(key)
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
    /([?&#])([^=&#]{1,100})=([^&#]*)/g,
    (match: string, separator: string, key: string) => {
      return isSensitiveKey(decodeURIComponentSafe(key))
        ? `${separator}${key}=${REDACTED}`
        : match;
    },
  );

  return redactedQueryValues.replace(
    /\b(authorization\s*[:=]\s*)((?:bearer|initdata)\s+)?[^\r\n,;]+/gi,
    (_match: string, prefix: string, scheme = '') => `${prefix}${scheme}${REDACTED}`,
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return sensitiveKeyFragments.some((fragment) => normalized.includes(fragment));
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
