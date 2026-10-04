export const MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY = 'message-duplicate:heavy-admission:v1';

export type DuplicateHeavyAdmissionResult =
  | { kind: 'granted'; startedAtMs: number }
  | { kind: 'deferred'; retryAtMs: number }
  | { kind: 'expired' };

// FLAG: A prior queue wait is credit, never a launch permit. Redis time and one shared
// atomic slot pace all heavy starts under slow pressure; no burst or replay exemption exists.
// Missing state first rebuilds a full slow interval, including after Redis eviction/restart.
export const DUPLICATE_HEAVY_ADMISSION_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local deadline = tonumber(ARGV[3])
local eligible = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
if now >= deadline or eligible >= deadline then return {0} end
local raw = redis.call('GET', KEYS[1])
local last = now
local previous_interval = interval
if raw then
  if string.len(raw) > 128 then return redis.error_reply('Invalid duplicate heavy admission state') end
  local ok, state = pcall(cjson.decode, raw)
  if not ok or type(state) ~= 'table' or type(state.at) ~= 'number' or
      type(state.interval) ~= 'number' or state.at < 0 or state.at ~= math.floor(state.at) or
      state.interval < 1000 or state.interval > 600000 or state.interval ~= math.floor(state.interval) then
    return redis.error_reply('Invalid duplicate heavy admission state')
  end
  last = state.at
  previous_interval = state.interval
end
if not raw then
  redis.call('SET', KEYS[1], cjson.encode({at = now, interval = interval}), 'PX', tostring(interval * 2))
end
local retry = math.max(eligible, last + math.max(interval, previous_interval))
if retry >= deadline then return {0} end
if now < retry then return {2, retry} end
redis.call('SET', KEYS[1], cjson.encode({at = now, interval = interval}), 'PX', tostring(interval * 2))
return {1, now}
`;

export function validateDuplicateHeavyAdmission(input: {
  eligibleAtMs: number;
  intervalMs: number;
  deadlineAtMs: number;
}): void {
  if (
    ![input.eligibleAtMs, input.intervalMs, input.deadlineAtMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    input.intervalMs < 1000 ||
    input.intervalMs > 600_000
  )
    throw new Error('Invalid duplicate heavy admission bounds');
}

export function parseDuplicateHeavyAdmission(raw: unknown): DuplicateHeavyAdmissionResult {
  if (!Array.isArray(raw)) throw new Error('Invalid duplicate heavy admission result');
  const code = Number(raw[0]);
  if (code === 0 && raw.length === 1) return { kind: 'expired' };
  const timestamp = Number(raw[1]);
  if (raw.length !== 2 || !Number.isSafeInteger(timestamp) || timestamp <= 0)
    throw new Error('Invalid duplicate heavy admission result');
  if (code === 1) return { kind: 'granted', startedAtMs: timestamp };
  if (code === 2) return { kind: 'deferred', retryAtMs: timestamp };
  throw new Error('Invalid duplicate heavy admission result');
}
