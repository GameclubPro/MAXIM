import {
  duplicateObservationOutcomeSchema,
  type DuplicateObservationDiagnostics,
  type DuplicateObservationOutcome,
} from '@maxim/contracts/settings';
import { digestDuplicateContent } from './message-duplicate-content';

export const DUPLICATE_TELEMETRY_BUCKET_MS = 15 * 60_000;
export const DUPLICATE_TELEMETRY_BUCKETS = 4;
export const DUPLICATE_TELEMETRY_TTL_SECONDS = 2 * 60 * 60;
export const DUPLICATE_TELEMETRY_COUNTER_LIMIT = 1_000_000_000;
export const DUPLICATE_TELEMETRY_FIELDS = [
  'supported',
  'verified',
  ...duplicateObservationOutcomeSchema.options,
] as const;
export type DuplicateTelemetryField = (typeof DUPLICATE_TELEMETRY_FIELDS)[number];
export type DuplicateTelemetryCounters = Partial<Record<DuplicateTelemetryField, number>>;
const fields: ReadonlySet<string> = new Set(DUPLICATE_TELEMETRY_FIELDS);

export function duplicateTelemetryKey(chatId: string, bucket: number): string {
  return `message-duplicate:diagnostics:v1:${digestDuplicateContent(chatId)}:${bucket}`;
}

export function parseDuplicateTelemetry(raw: unknown): DuplicateTelemetryCounters | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.length > DUPLICATE_TELEMETRY_FIELDS.length) return null;
    if (
      entries.some(
        ([key, count]) =>
          !fields.has(key) ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > DUPLICATE_TELEMETRY_COUNTER_LIMIT,
      )
    )
      return null;
    return value as DuplicateTelemetryCounters;
  } catch {
    return null;
  }
}

export function duplicateObservationIsVerified(outcome: DuplicateObservationOutcome): boolean {
  return [
    'COMPARED_NO_MATCH',
    'MATCHED_INELIGIBLE',
    'MATCHED_OBSERVE',
    'MATCHED_ACTION_FAILED',
    'ENFORCEMENT_REQUESTED',
  ].includes(outcome);
}

export function emptyDuplicateObservationDiagnostics(
  state: 'NO_DATA' | 'UNAVAILABLE',
  now = Date.now(),
): DuplicateObservationDiagnostics {
  const bucket = Math.floor(now / DUPLICATE_TELEMETRY_BUCKET_MS);
  return {
    state,
    since: new Date(
      (bucket - DUPLICATE_TELEMETRY_BUCKETS + 1) * DUPLICATE_TELEMETRY_BUCKET_MS,
    ).toISOString(),
    until: new Date(now).toISOString(),
    basis: 'ATTEMPTS',
    completeness: 'BEST_EFFORT',
    supportedAttempts: null,
    verifiedAttempts: null,
    coverage: null,
    outcomes: [],
  };
}

// FLAG: This is best-effort attempt telemetry, never action authority. Fixed fields, a
// server-side deadline, saturating counts and TTL bound both stale writes and retained bytes.
export const MERGE_DUPLICATE_TELEMETRY_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if now >= tonumber(ARGV[3]) then return 0 end
local allowed = cjson.decode(ARGV[4])
local delta = cjson.decode(ARGV[1])
local current = {}
local raw = redis.call('GET', KEYS[1])
if raw then
  if string.len(raw) > 4096 then return 0 end
  local ok, parsed = pcall(cjson.decode, raw)
  if not ok or type(parsed) ~= 'table' then return 0 end
  current = parsed
end
local result = {}
for _, key in ipairs(allowed) do
  local old = current[key] or 0
  local add = delta[key] or 0
  if type(old) ~= 'number' or type(add) ~= 'number' or old < 0 or add < 0 then return 0 end
  if old + add > 0 then result[key] = math.min(${DUPLICATE_TELEMETRY_COUNTER_LIMIT}, old + add) end
end
redis.call('SET', KEYS[1], cjson.encode(result), 'EX', ARGV[2])
return 1
`;
