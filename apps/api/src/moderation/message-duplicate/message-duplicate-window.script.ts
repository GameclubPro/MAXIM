// FLAG: Duplicate windows are anchored to an accepted original. Rejected attempts never
// become evidence or extend its lifetime. This script is intentionally separate from burst
// and quota rolling counters. Work is bounded by 16 fingerprints and constant-size records.
export const MESSAGE_DUPLICATE_WINDOW_SCRIPT = `
local p = cjson.decode(ARGV[1])
local prefix = KEYS[1]
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if now > p.deadline then return cjson.encode({ kind = 'deadline_exceeded' }) end
local ttl = p.windowMs and math.floor(p.windowMs / 1000) * 2 + 61 or 1209661
local function read(key)
  local raw = redis.call('GET', prefix .. key)
  if raw then return cjson.decode(raw) end
  return nil
end
local function write(key, value)
  redis.call('SET', prefix .. key, cjson.encode(value), 'EX', ttl)
end
local function epoch(author)
  return read('reset:' .. author) or 0
end
if p.op == 'reset' then
  write('reset:' .. p.author, math.max(now, epoch(p.author) + 1))
  return cjson.encode({ kind = 'ok' })
end
if p.op == 'remove' then
  write('removed:' .. p.member, true)
  return cjson.encode({ kind = 'ok' })
end
local function lifecycle(member, mode, at, source)
  local key = 'life:' .. member .. ':' .. mode
  local previous = read(key)
  if previous and at < previous.at then return previous.source == source and not previous.conflict end
  if previous and at == previous.at then
    if previous.source ~= source then
      previous.conflict = true
      write(key, previous)
    end
    return not previous.conflict
  end
  write(key, { at = at, source = source, conflict = false })
  return true
end
if p.op == 'lifecycle' then
  for mode, source in pairs(p.sources) do lifecycle(p.member, mode, p.at, source) end
  return cjson.encode({ kind = 'ok' })
end
local function stateKey(member) return 'message:' .. member .. ':' .. p.mode end
local function valid(evidence)
  if not evidence or read('removed:' .. evidence.member) then return false end
  if epoch(evidence.author) ~= evidence.epoch then return false end
  local life = read('life:' .. evidence.member .. ':' .. p.mode)
  if life and (life.conflict or life.source ~= evidence.sourceDigest) then return false end
  local state = read(stateKey(evidence.member))
  return state and state.epoch == evidence.epoch and state.source == evidence.sourceDigest
    and state.identity == evidence.contentDigest
end
local function groupKey(fingerprint) return 'group:' .. p.scope .. ':' .. fingerprint end
local function counterKey(fingerprint, original)
  return 'count:' .. p.author .. ':' .. fingerprint .. ':' .. original.member .. ':' .. original.observedAtMs
    .. ':' .. original.epoch .. ':' .. epoch(p.author)
end
local function matching()
  if p.at <= epoch(p.author) then return nil end
  if read('removed:' .. p.member) and not p.afterDelete then return nil end
  local state = read(stateKey(p.member))
  if not state or state.at ~= p.at or state.epoch ~= epoch(p.author) or state.source ~= p.source
    or state.identity ~= p.identity then return nil end
  local life = read('life:' .. p.member .. ':' .. p.mode)
  if life and (life.conflict or life.source ~= p.source) then return nil end
  for _, match in ipairs(state.matches or {}) do
    if match.fingerprint == p.fingerprint and match.original.member == p.original.member
      and match.original.observedAtMs == p.original.observedAtMs
      and match.original.epoch == p.original.epoch and valid(match.original)
      and p.at > match.original.publishedAtMs and p.at < match.original.expiresAtMs then
      return match, state
    end
  end
  return nil
end
if p.op == 'check' or p.op == 'qualify' then
  local match, state = matching()
  if not match then return cjson.encode({ kind = 'stale' }) end
  if p.op == 'check' then return cjson.encode({ kind = 'ok', count = match.qualified or match.count, qualified = match.qualified }) end
  if not match.qualified then
    local qualificationKey = 'qualification:' .. p.member
    local qualification = read(qualificationKey)
    if qualification and qualification.epoch == epoch(p.author) then return cjson.encode({ kind = 'stale' }) end
    local key = counterKey(p.fingerprint, match.original)
    local count = read(key) or { accepted = p.allowed, qualified = 0 }
    count.qualified = math.min(20 - p.allowed, count.qualified + 1)
    write(key, count)
    match.qualified = math.min(20, p.allowed + count.qualified)
    write(qualificationKey, { epoch = epoch(p.author) })
    write(stateKey(p.member), state)
  end
  return cjson.encode({ kind = 'ok', count = match.qualified })
end
if p.op ~= 'observe' then return cjson.encode({ kind = 'stale' }) end
if read('removed:' .. p.member) or p.at <= epoch(p.author) then return cjson.encode({ kind = 'stale' }) end
if not lifecycle(p.member, p.mode, p.at, p.source) then return cjson.encode({ kind = 'stale' }) end
local previous = read(stateKey(p.member))
local currentEpoch = epoch(p.author)
if previous and previous.epoch == currentEpoch then
  if p.at < previous.at then return cjson.encode({ kind = 'stale' }) end
  if previous.source == p.source and (previous.identity == p.identity or (p.identity == '' and p.at == previous.at)) then
    return cjson.encode({ kind = 'replayed', matches = previous.matches, observedAt = previous.at })
  end
end
local publishedAt = p.publishedAt
if previous then
  if previous.source ~= p.source then
    -- FLAG: A known material edit introduces new content. Cosmetic edits replay above;
    -- using the old message's age here would allow replacing any old post with fresh spam.
    publishedAt = p.at
  else
    publishedAt = math.min(publishedAt, previous.publishedAt)
  end
end
local state = { at = p.at, publishedAt = publishedAt, source = p.source, identity = p.identity,
  epoch = currentEpoch, matches = {} }
write(stateKey(p.member), state)
if p.identity == '' then return cjson.encode({ kind = 'ok', matches = {} }) end
local writes = {}
for _, fingerprint in ipairs(p.fingerprints) do
  local key = groupKey(fingerprint)
  local original = read(key)
  if not valid(original) then original = nil end
  if not original or publishedAt >= original.expiresAtMs then
    -- FLAG: An old edit or delayed observation cannot start a fresh window at processing time.
    -- The publication clock is immutable, including for a newly verified media baseline.
    if publishedAt + p.windowMs > p.at then
      original = { member = p.member, author = p.author, messageId = p.messageId,
        senderId = p.senderId, publishedAtMs = publishedAt, observedAtMs = p.at,
        expiresAtMs = publishedAt + p.windowMs, sourceDigest = p.source,
        contentDigest = p.identity, mediaHashes = p.mediaHashes, epoch = currentEpoch }
      table.insert(writes, { key = key, value = original })
    end
  elseif original.member ~= p.member and publishedAt > original.publishedAtMs and p.at < original.expiresAtMs then
    local counter = counterKey(fingerprint, original)
    local count = read(counter) or { accepted = 0, qualified = 0 }
    if count.accepted < p.allowed then
      count.accepted = count.accepted + 1
      table.insert(writes, { key = counter, value = count })
    else
      table.insert(state.matches, { fingerprint = fingerprint, original = original,
        count = math.min(20, p.allowed + count.qualified + 1) })
    end
  end
end
if #state.matches == 0 then
  for _, entry in ipairs(writes) do write(entry.key, entry.value) end
end
write(stateKey(p.member), state)
return cjson.encode({ kind = 'ok', matches = state.matches, observedAt = state.at })
`;

export type DuplicateWindowOriginal = {
  member: string;
  author: string;
  messageId: string;
  senderId: string;
  publishedAtMs: number;
  observedAtMs: number;
  expiresAtMs: number;
  sourceDigest: string;
  contentDigest: string;
  mediaHashes: string[];
  epoch: number;
};

export type DuplicateWindowResult = {
  kind: 'ok' | 'replayed' | 'stale' | 'deadline_exceeded';
  count?: number;
  qualified?: number;
  observedAt?: number;
  matches?: {
    fingerprint: string;
    original: DuplicateWindowOriginal;
    count: number;
    qualified?: number;
  }[];
};
