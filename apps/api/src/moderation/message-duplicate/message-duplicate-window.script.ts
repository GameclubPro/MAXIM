// FLAG: Duplicate windows are anchored to an accepted original. Rejected attempts never
// become evidence or extend its lifetime. This script is intentionally separate from burst
// and quota rolling counters. Work is bounded by 16 fingerprints and constant-size records.
export const MESSAGE_DUPLICATE_WINDOW_SCRIPT = `
local p = cjson.decode(ARGV[1])
local resetPrefix = KEYS[1]
local prefix = KEYS[1] .. 'v2:'
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
  local raw = redis.call('GET', resetPrefix .. 'reset:' .. author)
  return raw and cjson.decode(raw) or 0
end
if p.op == 'reset' then
  redis.call('SET', resetPrefix .. 'reset:' .. p.author, cjson.encode(math.max(now, epoch(p.author) + 1)), 'EX', ttl)
  return cjson.encode({ kind = 'ok' })
end
if p.op == 'remove' then
  write('removed:' .. p.member, true)
  return cjson.encode({ kind = 'ok' })
end
local function lifecycle(member, mode, at, source, publishedAt)
  local key = 'life:' .. member .. ':' .. mode
  local previous = read(key)
  if previous and at < previous.at then return nil end
  if previous and at == previous.at then
    if previous.source ~= source then
      previous.conflict = true
      previous.predecessorRevision = nil
      previous.revision = p.token
      write(key, previous)
    end
    return not previous.conflict and previous or nil
  end
  local changed = not previous or previous.source ~= source
  local life = {
    at = at, source = source, conflict = false,
    revision = previous and not changed and not previous.conflict and previous.revision or p.token,
    introducedAt = changed and at or (previous and previous.introducedAt or at),
    introducedKnown = changed or (previous and previous.introducedKnown or false),
    predecessorRevision = previous and (changed and not previous.conflict and previous.revision or (not changed and previous.predecessorRevision or nil)) or nil,
    materializedRevision = previous and previous.materializedRevision or nil,
  }
  if not previous then
    life.introducedAt = publishedAt or at
    life.introducedKnown = true
  end
  write(key, life)
  return life
end
if p.op == 'lifecycle' then
  for mode, source in pairs(p.sources) do lifecycle(p.member, mode, p.at, source, p.publishedAt) end
  return cjson.encode({ kind = 'ok' })
end
if p.op == 'invalidate' then
  for mode, source in pairs(p.sources) do
    local key = 'life:' .. p.member .. ':' .. mode
    local previous = read(key)
    if not previous or previous.source ~= source then
      write(key, { at = previous and previous.at or 0, source = source, conflict = true,
        revision = p.token, introducedAt = 0, introducedKnown = false })
    end
  end
  return cjson.encode({ kind = 'ok' })
end
local function stateKey(member) return 'message:' .. member .. ':' .. p.mode end
local function valid(evidence)
  if not evidence or not evidence.revision or not evidence.originalId or read('removed:' .. evidence.member) then return false end
  if epoch(evidence.author) ~= evidence.epoch then return false end
  local life = read('life:' .. evidence.member .. ':' .. p.mode)
  if not life or life.conflict or life.source ~= evidence.sourceDigest or life.revision ~= evidence.revision then return false end
  local state = read(stateKey(evidence.member))
  return state and state.epoch == evidence.epoch and state.source == evidence.sourceDigest
    and state.identity == evidence.contentDigest and state.revision == evidence.revision
    and state.originalId == evidence.originalId and state.publishedAt == evidence.publishedAtMs
end
local function groupKey(fingerprint) return 'group:' .. p.scope .. ':' .. fingerprint end
local function counterKey(fingerprint, original)
  return 'count:' .. p.author .. ':' .. fingerprint .. ':' .. original.originalId
    .. ':' .. original.epoch .. ':' .. epoch(p.author)
end
local function matching()
  if p.at <= epoch(p.author) then return nil end
  if read('removed:' .. p.member) and not p.afterDelete then return nil end
  local state = read(stateKey(p.member))
  if not p.revision or not state or state.revision ~= p.revision or state.at ~= p.at or state.epoch ~= epoch(p.author) or state.source ~= p.source
    or state.identity ~= p.identity then return nil end
  local life = read('life:' .. p.member .. ':' .. p.mode)
  if not life or life.conflict or life.source ~= p.source or life.revision ~= p.revision then return nil end
  for _, match in ipairs(state.matches or {}) do
    if match.fingerprint == p.fingerprint and match.original.member == p.original.member
      and match.original.originalId == p.original.originalId and match.original.revision == p.original.revision
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
local previous = read(stateKey(p.member))
local currentEpoch = epoch(p.author)
-- FLAG: A synthetic pending replay cannot replace proof for this exact event. Newer
-- incomplete content still invalidates the old revision before an early return.
if previous and previous.epoch == currentEpoch and p.at == previous.at and p.source == previous.source and p.identity == '' then
  local life = read('life:' .. p.member .. ':' .. p.mode)
  if life and not life.conflict and life.revision == previous.revision and life.source == previous.source then
    return cjson.encode({ kind = 'replayed', matches = previous.matches, observedAt = previous.at, revision = previous.revision })
  end
end
local life = lifecycle(p.member, p.mode, p.at, p.lifecycleSource or p.source, p.publishedAt)
if not life then return cjson.encode({ kind = 'stale' }) end
if not previous and life.materializedRevision then
  -- FLAG: Reconstructing missing evidence is a new incarnation. A surviving lifecycle
  -- record must not give an old binding authority over newly reconstructed message state.
  life.revision = p.token
  life.predecessorRevision = nil
end
if previous and previous.epoch == currentEpoch then
  if p.at < previous.at then return cjson.encode({ kind = 'stale' }) end
  if previous.context == p.context and previous.revision == life.revision and previous.source == p.source and (previous.identity == p.identity or (p.identity == '' and p.pendingSafe)) then
    return cjson.encode({ kind = 'replayed', matches = previous.matches, observedAt = previous.at, revision = previous.revision })
  end
  if previous.revision == life.revision and previous.identity ~= '' and p.identity ~= '' and previous.identity ~= p.identity then
    -- FLAG: Reused source IDs do not prove unchanged bytes. Independent proof of a
    -- different identity revokes the previous revision even when its locator is unchanged.
    life.revision = p.token
    life.predecessorRevision = nil
    life.introducedAt = p.at
    life.introducedKnown = true
    write('life:' .. p.member .. ':' .. p.mode, life)
  end
end
local publishedAt = life.introducedAt
local originalId = previous and previous.revision == life.revision and previous.originalId or p.token
local continuity = nil
if previous and previous.source ~= p.source and previous.identity ~= '' and previous.revision == life.predecessorRevision then
  continuity = { revision = previous.revision, identity = previous.identity,
    publishedAt = previous.publishedAt, originalId = previous.originalId, context = previous.context,
    accepted = previous.accepted, matches = previous.matches }
elseif previous and previous.revision == life.revision and previous.continuity and previous.continuity.revision == life.predecessorRevision then
  continuity = previous.continuity
end
local verifiedContinuity = continuity and p.identity ~= '' and p.identity == continuity.identity and life.introducedKnown and life.source == p.source
local preserveOccurrences = verifiedContinuity and continuity.context == p.context
if verifiedContinuity then
  -- FLAG: Only one observed locator transition plus independently equal content can
  -- retain an original's counter/window. An intermediate transition loses this proof.
  publishedAt = continuity.publishedAt
  originalId = continuity.originalId
  life.introducedAt = publishedAt
  write('life:' .. p.member .. ':' .. p.mode, life)
end
local accepted = {}
if preserveOccurrences then
  for _, fingerprint in ipairs(p.fingerprints) do
    if continuity.accepted and continuity.accepted[fingerprint] then accepted[fingerprint] = true end
  end
end
local state = { at = p.at, publishedAt = publishedAt, source = p.source, identity = p.identity, context = p.context,
  epoch = currentEpoch, revision = life.revision, originalId = originalId,
  accepted = accepted, matches = {} }
if p.identity == '' and p.pendingSafe and continuity and life.source == p.source then state.continuity = continuity end
life.materializedRevision = life.revision
write('life:' .. p.member .. ':' .. p.mode, life)
write(stateKey(p.member), state)
if p.identity == '' or not life.introducedKnown then return cjson.encode({ kind = 'ok', matches = {}, revision = life.revision }) end
-- FLAG: An old post edited without a content change must never become today's original.
if p.periodStart and (publishedAt < p.periodStart or publishedAt >= p.periodEnd) then
  return cjson.encode({ kind = 'ok', matches = {} })
end
local writes = {}
local newlyAccepted = {}
for _, fingerprint in ipairs(p.fingerprints) do
  local key = groupKey(fingerprint)
  local original = read(key)
  if not valid(original) or (p.periodStart and original.publishedAtMs < p.periodStart) then original = nil end
  if not original or publishedAt >= original.expiresAtMs then
    -- FLAG: An old edit or delayed observation cannot start a fresh window at processing time.
    -- The publication clock is immutable, including for a newly verified media baseline.
    local expiresAt = p.periodEnd or (publishedAt + p.windowMs)
    if expiresAt > p.at then
      original = { member = p.member, author = p.author, messageId = p.messageId,
        senderId = p.senderId, publishedAtMs = publishedAt, observedAtMs = p.at,
        expiresAtMs = expiresAt, sourceDigest = p.source,
        contentDigest = p.identity, mediaHashes = p.mediaHashes, epoch = currentEpoch,
        revision = life.revision, originalId = originalId }
      table.insert(writes, { key = key, value = original })
    end
  elseif original.member ~= p.member and publishedAt > original.publishedAtMs and p.at < original.expiresAtMs then
    local counter = counterKey(fingerprint, original)
    local count = read(counter) or { accepted = 0, qualified = 0 }
    if state.accepted[fingerprint] then
      -- FLAG: Independently unchanged content remains the same accepted occurrence.
    elseif count.accepted < p.allowed then
      count.accepted = count.accepted + 1
      newlyAccepted[fingerprint] = true
      table.insert(writes, { key = counter, value = count })
    else
      local snapshot = nil
      if preserveOccurrences then
        for _, match in ipairs(continuity.matches or {}) do
          if match.fingerprint == fingerprint and match.original.originalId == original.originalId and match.original.revision == original.revision then snapshot = match end
        end
      end
      table.insert(state.matches, snapshot or { fingerprint = fingerprint, original = original,
        count = math.min(20, p.allowed + count.qualified + 1) })
    end
  end
end
if #state.matches == 0 then
  for _, entry in ipairs(writes) do write(entry.key, entry.value) end
  for fingerprint, _ in pairs(newlyAccepted) do state.accepted[fingerprint] = true end
end
write(stateKey(p.member), state)
return cjson.encode({ kind = 'ok', matches = state.matches, observedAt = state.at, revision = state.revision })
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
  revision: string;
  originalId: string;
};

export type DuplicateWindowResult = {
  kind: 'ok' | 'replayed' | 'stale' | 'deadline_exceeded';
  count?: number;
  qualified?: number;
  observedAt?: number;
  revision?: string;
  matches?: {
    fingerprint: string;
    original: DuplicateWindowOriginal;
    count: number;
    qualified?: number;
  }[];
};
