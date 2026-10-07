import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';

// FLAG: MATCH does not index Redis keys. This separate structural pass traverses
// the whole bounded database, including orphan job hashes without queue metadata.
// COUNT is a work hint, not a hard bound on buckets visited by one Redis command.
// Cardinality, page, reply, matched-key, wall-time and observed latency limits all
// fail closed; they do not replace the independent owner/job/SQL proof budget.
export const SOURCE_ABANDONMENT_CATALOG_BUDGET = Object.freeze({
  databaseKeys: 12_000_000,
  scanCount: 4096,
  pages: 4096,
  matchedKeys: 300_000,
  keyBytes: 64 * 1024 * 1024,
  bytes: 4 * 1024 * 1024,
  pageKeys: 8192,
  pageKeyBytes: 512 * 1024,
  pageReplyBytes: 16 * 1024,
  durationMs: 15_000,
  callDurationUs: 50_000,
  pagePauseMs: 1,
});

const budget = SOURCE_ABANDONMENT_CATALOG_BUDGET;
export const SOURCE_ABANDONMENT_NAMESPACE_CATALOG_SCRIPT = `-- source-abandonment:namespace-catalog-v2
local started = redis.call('TIME')
local size = redis.call('DBSIZE')
if size > ${budget.databaseKeys} then return {0, 'CATALOG_DATABASE_LIMIT'} end
local result = redis.call('SCAN', ARGV[1], 'MATCH', 'bull:*', 'COUNT', ${budget.scanCount})
if #result[2] > ${budget.pageKeys} then return {0, 'CATALOG_PAGE_LIMIT'} end
local allowed = {${LEGACY_RECOVERY_LIVE_QUEUE_NAMES.map((name) => `['${name}']=true`).join(',')}}
local counts = {}
local bytes = 0
for _, key in ipairs(result[2]) do
  bytes = bytes + string.len(key)
  if string.len(key) > 1024 or bytes > ${budget.pageKeyBytes} then return {0, 'CATALOG_PAGE_LIMIT'} end
  local name, suffix = string.match(key, '^bull:([^:]+):(.+)$')
  if not name or not suffix or not allowed[name] then return {0, 'UNKNOWN_QUEUE_NAMESPACE'} end
  counts[name] = (counts[name] or 0) + 1
end
local rows = {}
for name, count in pairs(counts) do table.insert(rows, {name, count}) end
size = math.max(size, redis.call('DBSIZE'))
if size > ${budget.databaseKeys} then return {0, 'CATALOG_DATABASE_LIMIT'} end
local ended = redis.call('TIME')
local elapsed = (ended[1] - started[1]) * 1000000 + ended[2] - started[2]
if elapsed < 0 or elapsed > ${budget.callDurationUs} then return {0, 'CATALOG_CALL_LATENCY_LIMIT'} end
return {1, size, result[1], #result[2], bytes, elapsed, rows}
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
        'bytes,databaseKeysMax,durationMs,keyBytes,matchedKeys,maxCallDurationUs,pages,scanCountHints,serverDurationUs' ||
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
  redis: { eval_ro(script: string, keys: number, ...args: string[]): Promise<unknown> },
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reply: unknown;
      try {
        reply = await Promise.race([
          redis.eval_ro(SOURCE_ABANDONMENT_NAMESPACE_CATALOG_SCRIPT, 0, cursor),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('CATALOG_DEADLINE_EXCEEDED')),
              Math.max(1, deadlineAt - Date.now()),
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      cost.pages++;
      cost.scanCountHints += budget.scanCount;
      const bytes = Buffer.byteLength(JSON.stringify(reply));
      cost.bytes += bytes;
      if (bytes > budget.pageReplyBytes || !Array.isArray(reply))
        throw new Error('CATALOG_REPLY_UNPROVED');
      if (reply[0] === 0 && refusalCodes.has(reply[1])) throw new Error(reply[1]);
      if (
        reply.length !== 7 ||
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
        reply[6].length > known.size
      )
        throw new Error('CATALOG_REPLY_UNPROVED');
      cost.databaseKeysMax = Math.max(cost.databaseKeysMax, reply[1]);
      cost.matchedKeys += reply[3];
      cost.keyBytes += reply[4];
      cost.serverDurationUs += reply[5];
      cost.maxCallDurationUs = Math.max(cost.maxCallDurationUs, reply[5]);
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
      if (cursor !== '0' && cursors.has(cursor)) throw new Error('CATALOG_CURSOR_REPEAT');
      cursors.add(cursor);
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
