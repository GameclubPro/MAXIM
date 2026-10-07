import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';

// FLAG: MATCH does not index Redis keys. This separate structural pass traverses
// the whole bounded database, including orphan job hashes without queue metadata.
// COUNT is a work hint, not a hard bound on buckets visited by one Redis command.
// Cardinality, page, reply, matched-key, wall-time and observed latency limits all
// fail closed; they do not replace the independent owner/job/SQL proof budget.
// At most two COUNT steps per measured read bound uninterrupted server work;
// the returned cursor trace charges every underlying page and detects cycles.
export const SOURCE_ABANDONMENT_CATALOG_BUDGET = Object.freeze({
  databaseKeys: 12_000_000,
  scanCount: 4096,
  pages: 4096,
  matchedKeys: 300_000,
  keyBytes: 64 * 1024 * 1024,
  bytes: 4 * 1024 * 1024,
  measurementBytes: 16 * 1024 * 1024,
  pageKeys: 8192,
  pageKeyBytes: 512 * 1024,
  pageReplyBytes: 16 * 1024,
  durationMs: 15_000,
  callDurationUs: 50_000,
  pagePauseMs: 1,
});

const budget = SOURCE_ABANDONMENT_CATALOG_BUDGET;
const commandstatsProjectionBytes = 512;
type ReadOnlyCostTransaction = {
  eval_ro(script: string, keys: number, ...args: string[]): ReadOnlyCostTransaction;
  exec(): Promise<unknown>;
};
export type SourceAbandonmentCatalogReader = {
  eval_ro(script: string, keys: number, ...args: string[]): Promise<unknown>;
  multi?(): ReadOnlyCostTransaction;
};

// FLAG: Bound and validate the full internal INFO before projecting its original
// decimal text. Lua numbers must never round the lifetime command counters.
// The 16 MiB measurement budget counts returned metadata, not internal INFO work.
export const SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT = `-- source-abandonment:commandstats-projection-v1
local raw = redis.call('INFO', 'commandstats')
local header = '# Commandstats\\r\\n'
local function fail() return redis.error_reply('CATALOG_SERVER_COST_UNPROVED') end
if type(raw) ~= 'string' or #raw > 65536 or string.sub(raw, 1, #header) ~= header or string.sub(raw, -2) ~= '\\r\\n' then return fail() end
local offset = #header + 1
local lines = 2
local selected = nil
while offset <= #raw do
  local finish = string.find(raw, '\\r\\n', offset, true)
  if not finish then return fail() end
  local line = string.sub(raw, offset, finish - 1)
  offset = finish + 2
  lines = lines + 1
  if lines > 512 then return fail() end
  if line ~= '' then
    local name, calls, usec, average, rejected, failed = string.match(line, '^cmdstat_([^:%s]+):calls=(%d+),usec=(%d+),usec_per_call=([%d%.]+),rejected_calls=(%d+),failed_calls=(%d+)$')
    if not name or #name > 128 or #calls > 20 or #usec > 20 or #rejected > 20 or #failed > 20 or not (string.match(average, '^%d+$') or string.match(average, '^%d+%.%d+$')) then return fail() end
    if name == 'eval_ro' then
      if selected then return fail() end
      selected = line
    end
  end
end
local projected = header .. (selected and (selected .. '\\r\\n') or '')
if #projected > ${commandstatsProjectionBytes} then return fail() end
return projected`;

function parseCommandstats(value: unknown) {
  const fail = (): never => {
    throw new Error('CATALOG_SERVER_COST_UNPROVED');
  };
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > commandstatsProjectionBytes ||
    !value.startsWith('# Commandstats\r\n')
  )
    return fail();
  if (value === '# Commandstats\r\n') return { calls: 0, usec: 0, rejected: 0, failed: 0 };
  const lines = value.split('\r\n');
  if (lines.length !== 3 || lines[2] !== '') return fail();
  const match =
    /^cmdstat_eval_ro:calls=(\d{1,16}),usec=(\d{1,16}),usec_per_call=\d+(?:\.\d+)?,rejected_calls=(\d{1,16}),failed_calls=(\d{1,16})$/u.exec(
      lines[1],
    );
  if (!match) return fail();
  const values = match.slice(1).map(Number);
  if (values.some((n) => !Number.isSafeInteger(n) || n < 0)) return fail();
  const [calls, usec, rejected, failed] = values;
  return { calls, usec, rejected, failed };
}

export async function readMeasuredSourceCatalogScript(
  redis: SourceAbandonmentCatalogReader,
  script: string,
  keys: number,
  ...args: string[]
): Promise<{ reply: unknown; serverDurationUs: number; measurementBytes: number }> {
  if (typeof redis.multi !== 'function') throw new Error('CATALOG_SERVER_COST_UNPROVED');
  // FLAG: MULTI/EXEC excludes interleaved scripts and CONFIG RESETSTAT. The final
  // projection sees the completed first meter plus target: exactly two EVAL_ROs.
  // Their reported cost conservatively includes the whole target; the final
  // meter is outside that delta. This is an observed limit, not preemption or a
  // hard wall-clock bound. Redis 7.2+ freezes Lua TIME; client RTT adds delay.
  const result = await redis
    .multi()
    .eval_ro(SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT, 0)
    .eval_ro(script, keys, ...args)
    .eval_ro(SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT, 0)
    .exec();
  if (
    !Array.isArray(result) ||
    result.length !== 3 ||
    result.some((row: unknown) => !Array.isArray(row) || row.length !== 2 || row[0] !== null)
  )
    throw new Error('CATALOG_SERVER_COST_UNPROVED');
  const before = parseCommandstats(result[0][1]);
  const after = parseCommandstats(result[2][1]);
  if (
    after.calls - before.calls !== 2 ||
    after.usec < before.usec ||
    after.failed !== before.failed ||
    after.rejected !== before.rejected
  )
    throw new Error('CATALOG_SERVER_COST_UNPROVED');
  const serverDurationUs = after.usec - before.usec;
  if (serverDurationUs > budget.callDurationUs) throw new Error('CATALOG_CALL_LATENCY_LIMIT');
  return {
    reply: result[1][1] as unknown,
    serverDurationUs,
    measurementBytes:
      Buffer.byteLength(result[0][1] as string) + Buffer.byteLength(result[2][1] as string),
  };
}

export const SOURCE_ABANDONMENT_NAMESPACE_CATALOG_SCRIPT = `-- source-abandonment:namespace-catalog-v2
local started = redis.call('TIME')
local size = redis.call('DBSIZE')
if size > ${budget.databaseKeys} then return {0, 'CATALOG_DATABASE_LIMIT'} end
local limit = tonumber(ARGV[2])
if limit ~= 1 and limit ~= 2 and limit ~= 3 and limit ~= 4 then return {0, 'CATALOG_PAGE_LIMIT'} end
local cursor = ARGV[1]
local cursors = {}
local matched = 0
local allowed = {${LEGACY_RECOVERY_LIVE_QUEUE_NAMES.map((name) => `['${name}']=true`).join(',')}}
local counts = {}
local bytes = 0
for _ = 1, limit do
  local result = redis.call('SCAN', cursor, 'MATCH', 'bull:*', 'COUNT', ${budget.scanCount})
  for _, key in ipairs(result[2]) do
    matched = matched + 1
    bytes = bytes + string.len(key)
    if matched > ${budget.pageKeys} or string.len(key) > 1024 or bytes > ${budget.pageKeyBytes} then return {0, 'CATALOG_PAGE_LIMIT'} end
    local name, suffix = string.match(key, '^bull:([^:]+):(.+)$')
    if not name or not suffix or not allowed[name] then return {0, 'UNKNOWN_QUEUE_NAMESPACE'} end
    counts[name] = (counts[name] or 0) + 1
  end
  cursor = result[1]
  table.insert(cursors, cursor)
  if cursor == '0' then break end
end
local rows = {}
for name, count in pairs(counts) do table.insert(rows, {name, count}) end
size = math.max(size, redis.call('DBSIZE'))
if size > ${budget.databaseKeys} then return {0, 'CATALOG_DATABASE_LIMIT'} end
local ended = redis.call('TIME')
local elapsed = (ended[1] - started[1]) * 1000000 + ended[2] - started[2]
if elapsed < 0 or elapsed > ${budget.callDurationUs} then return {0, 'CATALOG_CALL_LATENCY_LIMIT'} end
return {1, size, cursor, matched, bytes, elapsed, rows, cursors}
`;

export type SourceAbandonmentCatalogProof = Readonly<{
  version: 2;
  complete: boolean;
  namespaceKeyCounts: Readonly<Record<string, number>>;
  cost: Readonly<{
    pages: number;
    scanCountHints: number;
    matchedKeys: number;
    keyBytes: number;
    bytes: number;
    measurementBytes: number;
    databaseKeysMax: number;
    serverDurationUs: number;
    maxCallDurationUs: number;
    durationMs: number;
  }>;
  issue: string | null;
}>;

const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const known = new Set<string>(LEGACY_RECOVERY_LIVE_QUEUE_NAMES);
const refusalCodes = new Set([
  'CATALOG_DATABASE_LIMIT',
  'CATALOG_PAGE_LIMIT',
  'CATALOG_CALL_LATENCY_LIMIT',
  'UNKNOWN_QUEUE_NAMESPACE',
]);

// FLAG: Artifact hashing authenticates bytes, not their structural meaning. An
// installer independently requires both complete bounded catalogs and identical
// namespace counts; unknown namespaces or invented costs never grant authority.
export function assertSourceAbandonmentCatalogProofs(
  value: unknown,
): asserts value is readonly SourceAbandonmentCatalogProof[] {
  const object = (row: unknown): row is Record<string, unknown> =>
    row !== null && typeof row === 'object' && !Array.isArray(row);
  const reject = () => {
    throw new Error('Invalid source namespace catalog proof');
  };
  if (!Array.isArray(value) || value.length !== 2) return reject();
  const canonicalCounts: string[] = [];
  for (const proof of value) {
    if (
      !object(proof) ||
      Object.keys(proof).sort().join(',') !== 'complete,cost,issue,namespaceKeyCounts,version' ||
      proof.version !== 2 ||
      proof.complete !== true ||
      proof.issue !== null ||
      !object(proof.namespaceKeyCounts) ||
      !object(proof.cost)
    )
      return reject();
    const counts = Object.entries(proof.namespaceKeyCounts);
    if (counts.some(([name, count]) => !known.has(name) || !integer(count) || count < 1))
      return reject();
    const cost = proof.cost;
    if (
      Object.keys(cost).sort().join(',') !==
        'bytes,databaseKeysMax,durationMs,keyBytes,matchedKeys,maxCallDurationUs,measurementBytes,pages,scanCountHints,serverDurationUs' ||
      Object.values(cost).some((n) => !integer(n))
    )
      return reject();
    const n = cost as SourceAbandonmentCatalogProof['cost'];
    if (
      n.pages < 1 ||
      n.pages > budget.pages ||
      n.scanCountHints !== n.pages * budget.scanCount ||
      n.databaseKeysMax > budget.databaseKeys ||
      n.matchedKeys > budget.matchedKeys ||
      n.matchedKeys !== counts.reduce((sum, [, count]) => sum + (count as number), 0) ||
      n.keyBytes > budget.keyBytes ||
      (n.keyBytes === 0) !== (n.matchedKeys === 0) ||
      n.bytes > budget.bytes ||
      n.measurementBytes < 1 ||
      n.measurementBytes > budget.measurementBytes ||
      n.bytes > n.pages * budget.pageReplyBytes ||
      n.durationMs > budget.durationMs ||
      n.maxCallDurationUs > budget.callDurationUs ||
      n.serverDurationUs < n.maxCallDurationUs ||
      n.serverDurationUs > n.pages * budget.callDurationUs
    )
      return reject();
    canonicalCounts.push(JSON.stringify(counts.sort(([a], [b]) => a.localeCompare(b))));
  }
  if (canonicalCounts[0] !== canonicalCounts[1]) reject();
}

export async function inventorySourceAbandonmentNamespaces(
  redis: SourceAbandonmentCatalogReader,
  sharedDeadlineAtMs: number,
): Promise<SourceAbandonmentCatalogProof> {
  const startedAt = Date.now();
  const deadlineAt = Math.min(sharedDeadlineAtMs, startedAt + budget.durationMs);
  const counts = new Map<string, number>();
  const cursors = new Set<string>();
  const cost = {
    pages: 0,
    scanCountHints: 0,
    matchedKeys: 0,
    keyBytes: 0,
    bytes: 0,
    measurementBytes: 0,
    databaseKeysMax: 0,
    serverDurationUs: 0,
    maxCallDurationUs: 0,
    durationMs: 0,
  };
  let cursor = '0';
  let complete = false;
  let issue: string | null = null;
  try {
    do {
      if (Date.now() >= deadlineAt) throw new Error('CATALOG_DEADLINE_EXCEEDED');
      if (
        cost.pages >= budget.pages ||
        cost.matchedKeys + budget.pageKeys > budget.matchedKeys ||
        cost.keyBytes + budget.pageKeyBytes > budget.keyBytes ||
        cost.bytes + budget.pageReplyBytes > budget.bytes
      )
        throw new Error('CATALOG_BUDGET_EXCEEDED');
      // FLAG: Namespace artifact bytes and projected measurement bytes are
      // separate bounded replies; reserve the maximum pair before dispatch.
      if (cost.measurementBytes + 2 * commandstatsProjectionBytes > budget.measurementBytes)
        throw new Error('CATALOG_MEASUREMENT_BUDGET');
      const pageAllowance = Math.min(2, budget.pages - cost.pages);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reply: unknown;
      let serverDurationUs: number;
      try {
        const measured = await Promise.race([
          readMeasuredSourceCatalogScript(
            redis,
            SOURCE_ABANDONMENT_NAMESPACE_CATALOG_SCRIPT,
            0,
            cursor,
            String(pageAllowance),
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('CATALOG_DEADLINE_EXCEEDED')),
              Math.max(1, deadlineAt - Date.now()),
            );
          }),
        ]);
        reply = measured.reply;
        serverDurationUs = measured.serverDurationUs;
        cost.measurementBytes += measured.measurementBytes;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const bytes = Buffer.byteLength(JSON.stringify(reply));
      cost.bytes += bytes;
      if (bytes > budget.pageReplyBytes || !Array.isArray(reply))
        throw new Error('CATALOG_REPLY_UNPROVED');
      if (reply[0] === 0 && refusalCodes.has(reply[1])) throw new Error(reply[1]);
      if (
        reply.length !== 8 ||
        reply[0] !== 1 ||
        !integer(reply[1]) ||
        reply[1] > budget.databaseKeys ||
        typeof reply[2] !== 'string' ||
        !/^[0-9]{1,20}$/u.test(reply[2]) ||
        !integer(reply[3]) ||
        reply[3] > budget.pageKeys ||
        !integer(reply[4]) ||
        reply[4] > budget.pageKeyBytes ||
        !integer(reply[5]) ||
        reply[5] > budget.callDurationUs ||
        !Array.isArray(reply[6]) ||
        reply[6].length > known.size ||
        !Array.isArray(reply[7]) ||
        reply[7].length < 1 ||
        reply[7].length > pageAllowance ||
        (reply[2] !== '0' && reply[7].length !== pageAllowance) ||
        reply[7].at(-1) !== reply[2] ||
        reply[7].some(
          (value: unknown, index: number) =>
            typeof value !== 'string' ||
            !/^[0-9]{1,20}$/u.test(value) ||
            (value === '0' && index !== reply[7].length - 1),
        )
      )
        throw new Error('CATALOG_REPLY_UNPROVED');
      cost.pages += reply[7].length;
      cost.scanCountHints += reply[7].length * budget.scanCount;
      cost.databaseKeysMax = Math.max(cost.databaseKeysMax, reply[1]);
      cost.matchedKeys += reply[3];
      cost.keyBytes += reply[4];
      cost.serverDurationUs += serverDurationUs;
      cost.maxCallDurationUs = Math.max(cost.maxCallDurationUs, serverDurationUs);
      let matched = 0;
      const pageNames = new Set<string>();
      for (const row of reply[6]) {
        if (
          !Array.isArray(row) ||
          row.length !== 2 ||
          typeof row[0] !== 'string' ||
          !known.has(row[0]) ||
          pageNames.has(row[0]) ||
          !integer(row[1]) ||
          row[1] < 1
        )
          throw new Error('CATALOG_NAMESPACE_UNPROVED');
        pageNames.add(row[0]);
        matched += row[1];
        counts.set(row[0], (counts.get(row[0]) ?? 0) + row[1]);
      }
      if (matched !== reply[3]) throw new Error('CATALOG_ACCOUNTING_UNPROVED');
      cursor = reply[2];
      for (const next of reply[7] as string[]) {
        if (next !== '0' && cursors.has(next)) throw new Error('CATALOG_CURSOR_REPEAT');
        cursors.add(next);
      }
      if (Date.now() >= deadlineAt) throw new Error('CATALOG_DEADLINE_EXCEEDED');
      complete = cursor === '0';
      if (!complete) await new Promise((resolve) => setTimeout(resolve, budget.pagePauseMs));
    } while (!complete);
  } catch (error) {
    issue =
      error instanceof Error && /^CATALOG_[A-Z_]+$|^UNKNOWN_QUEUE_NAMESPACE$/u.test(error.message)
        ? error.message
        : 'CATALOG_STORE_REFUSED';
  }
  cost.durationMs = Date.now() - startedAt;
  return {
    version: 2,
    complete,
    namespaceKeyCounts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
    cost,
    issue,
  };
}
