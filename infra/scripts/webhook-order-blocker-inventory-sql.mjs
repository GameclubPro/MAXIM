export const ORDER_BLOCKER_PAGE_SIZE = 200;
export const ORDER_BLOCKER_STATUSES = Object.freeze(['FAILED', 'QUEUED', 'RECEIVED']);

const check = (value, code = 'order_inventory_sql_request_refused') => {
  if (!value) throw new Error(code);
};
const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const clockPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/u;
const canonicalClock = (value) =>
  typeof value === 'string' &&
  clockPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 23) === value.slice(0, 23);
const pgClock = (value) =>
  value
    .slice(0, -1)
    .replace('T', ' ')
    .replace(/(\.\d*?)0+$/u, '$1')
    .replace(/\.$/u, '');
const clockKey = (value) => value.slice(0, -1).padEnd(26, '0');
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const iso = (value) => `to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function request(input) {
  check(input && typeof input === 'object' && !Array.isArray(input));
  check(Object.keys(input).every((key) => ['status', 'cutoff', 'pageSize', 'after'].includes(key)));
  check(ORDER_BLOCKER_STATUSES.includes(input.status));
  check(canonicalClock(input.cutoff) && Date.parse(input.cutoff) <= Date.now());
  check(input.pageSize === ORDER_BLOCKER_PAGE_SIZE);
  check(
    input.after === null ||
      (input.after &&
        typeof input.after === 'object' &&
        Object.keys(input.after).sort().join(',') === 'createdAt,id' &&
        typeof input.after.id === 'string' &&
        idPattern.test(input.after.id) &&
        canonicalClock(input.after.createdAt) &&
        clockKey(input.after.createdAt) < clockKey(input.cutoff)),
  );
  return input;
}

// FLAG: Limit the raw status index before metadata filtering and claim probes.
// The sentinel is never consumed; the next page starts after the last emitted row.
// Every old ordering anchor is retained, including later anchors in the same chat.
// FLAG: Known non-ordering history and positively released rows never probe claims;
// unknown ordering still requires the bounded probes and remains explicitly unknown.
function pageCtes(input, metadata = true) {
  const { status, cutoff, after } = request(input);
  const cursor = after
    ? `AND (created_at,id) > (${literal(after.createdAt)}::timestamp,${literal(after.id)})`
    : '';
  const raw = `raw_page AS MATERIALIZED (
 SELECT id,created_at FROM webhook_events
 WHERE status=${literal(status)}::"WebhookStatus" AND created_at<${literal(cutoff)}::timestamp
 ${cursor} ORDER BY created_at,id LIMIT 201
), picked AS MATERIALIZED (
 SELECT id,created_at FROM raw_page ORDER BY created_at,id LIMIT 200
)`;
  if (!metadata) return raw;
  return `${raw}, metadata AS MATERIALIZED (
 SELECT p.id,p.created_at,e.* FROM picked p CROSS JOIN LATERAL (
  SELECT status,bot_id,semantic_key,
   CASE WHEN legacy_disposition_id IS NOT NULL OR source_disposition_id IS NOT NULL THEN NULL
    WHEN status='FAILED' AND next_enqueue_at IS NULL AND (error_message IS NULL OR
      (pg_column_compression(error_message) IS NULL AND pg_column_size(error_message)<=8192
       AND LEFT(error_message,37)<>'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:')) THEN NULL
    ELSE normalized_payload END AS normalized_payload,
   next_enqueue_at,timeout_quarantine_expires_at,
   legacy_disposition_id IS NOT NULL AS legacy_released,source_disposition_id IS NOT NULL AS source_released,
   CASE WHEN error_message IS NULL THEN 'none'
    WHEN pg_column_compression(error_message) IS NOT NULL OR pg_column_size(error_message)>8192 THEN 'unavailable'
    WHEN error_message LIKE 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED%' THEN 'legacy_unverified'
    WHEN LEFT(error_message,37)='WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:' THEN 'timeout_quarantine'
    ELSE 'other' END AS error_family
  FROM webhook_events WHERE id=p.id LIMIT 1
 ) e
), bounded AS MATERIALIZED (
 SELECT *,CASE WHEN status='FAILED' AND next_enqueue_at IS NULL AND error_family IN ('none','other') THEN false
   WHEN (pg_column_compression(normalized_payload) IS NULL AND pg_column_size(normalized_payload)<=262144)
    OR (pg_column_compression(normalized_payload) IN ('pglz','lz4') AND pg_column_size(normalized_payload)<=8192)
    THEN octet_length(normalized_payload::text) BETWEEN 1 AND 262144 ELSE false END AS normalized_bounded
 FROM metadata
), routing AS MATERIALIZED (
 SELECT id,created_at,status,bot_id,semantic_key,next_enqueue_at,timeout_quarantine_expires_at,
  legacy_released,source_released,error_family,normalized_bounded,
  CASE WHEN normalized_bounded THEN LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'),''),
   NULLIF(BTRIM(normalized_payload->>'update_type'),''))) END AS update_type,
  CASE WHEN normalized_bounded THEN COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'),''),
   NULLIF(BTRIM(normalized_payload->>'chatId'),'')) END AS chat_id,
  CASE WHEN normalized_bounded THEN COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'messageId'),''),
   NULLIF(BTRIM(normalized_payload->'message'->>'message_id'),''),NULLIF(BTRIM(normalized_payload->>'messageId'),''),
   NULLIF(BTRIM(normalized_payload->>'message_id'),'')) END AS message_id
 FROM bounded
), classified AS MATERIALIZED (
 SELECT *,CASE WHEN status='FAILED' AND next_enqueue_at IS NULL AND error_family IN ('none','other') THEN false
   WHEN NOT normalized_bounded THEN NULL
   WHEN COALESCE(update_type=ANY(ARRAY['message_created','message_edited']) AND chat_id IS NOT NULL,false)=false THEN false
   WHEN status IN ('RECEIVED','QUEUED') OR next_enqueue_at IS NOT NULL THEN true
   WHEN error_family='unavailable' THEN NULL ELSE error_family IN ('timeout_quarantine','legacy_unverified') END AS ordered
 FROM routing
)`;
}

// FLAG: Diagnostics isolate one fixed phase without advancing the inventory journal.
// They are never accepted as inventory pages or as authority to modify an event.
export const ORDER_BLOCKER_DIAGNOSTIC_PHASES = Object.freeze(['raw_index', 'metadata']);
export function buildOrderBlockerDiagnosticSql(input, phase) {
  request(input);
  check(ORDER_BLOCKER_DIAGNOSTIC_PHASES.includes(phase));
  const relation = phase === 'raw_index' ? 'raw_page' : 'classified';
  const row =
    phase === 'raw_index'
      ? `json_build_object('id',id,'createdAt',${iso('created_at')})`
      : `json_build_object('id',id,'createdAt',${iso('created_at')},'status',status,
       'ordered',ordered,'normalizedBounded',normalized_bounded,'errorFamily',error_family,
       'legacyReleased',legacy_released,'sourceReleased',source_released,
       'chatId',CASE WHEN octet_length(chat_id)<=128 THEN chat_id END,
       'messageId',CASE WHEN octet_length(message_id)<=1024 THEN message_id END,
       'semanticKey',CASE WHEN octet_length(semantic_key)<=1024 THEN semantic_key END,
       'botId',CASE WHEN octet_length(bot_id)<=128 THEN bot_id END)`;
  return `WITH ${pageCtes(input, phase === 'metadata')}
SELECT json_build_object('version',1,'kind','order_blocker_phase_diagnostic',
 'readOnly',true,'phase',${literal(phase)},'status',${literal(input.status)},'cutoff',${literal(input.cutoff)},
 'rawCount',(SELECT count(*) FROM raw_page),'hasMore',(SELECT count(*)=201 FROM raw_page),
 'observedAt',${iso("statement_timestamp() AT TIME ZONE 'UTC'")},
 'rowCount',(SELECT count(*) FROM ${relation}),
 'rows',COALESCE((SELECT json_agg(${row} ORDER BY created_at,id) FROM ${relation}),'[]'::json),
 'coverage','DIAGNOSTIC_ONLY','mutationAuthorized',false,'inventoryAdvanceAuthorized',false)::text AS inventory_diagnostic;`;
}

export function buildOrderBlockerPageSql(input) {
  const { status, cutoff, after } = request(input);
  const afterJson = after
    ? `json_build_object('createdAt',${literal(after.createdAt)},'id',${literal(after.id)})`
    : 'NULL::json';
  return `WITH ${pageCtes(input)}, identities AS MATERIALIZED (
 SELECT r.*,s.id AS semantic_claim_id,d.count AS direct_count,d.id AS direct_claim_id,
  COALESCE(s.id,CASE WHEN d.count=1 THEN d.id END) AS chosen_id
 FROM classified r LEFT JOIN LATERAL (
  SELECT id FROM webhook_execution_claims WHERE r.ordered IS DISTINCT FROM false
   AND NOT (r.legacy_released OR r.source_released) AND kind='EXECUTION' AND semantic_key=r.semantic_key LIMIT 1
 ) s ON TRUE LEFT JOIN LATERAL (
  SELECT count(*) AS count,min(id) AS id FROM (
   SELECT id FROM webhook_execution_claims WHERE r.ordered IS DISTINCT FROM false
    AND NOT (r.legacy_released OR r.source_released) AND kind='EXECUTION' AND webhook_event_id=r.id LIMIT 2
  ) bounded
 ) d ON TRUE
), observed AS MATERIALIZED (
 SELECT r.*,c.webhook_event_id AS claim_owner,c.status AS claim_status,c.enforced,
  c.prepared_at IS NOT NULL AS prepared,c.business_started_at IS NOT NULL AS started,c.completed_at IS NOT NULL AS completed,
  c.lease_token,c.lease_expires_at,
  CASE WHEN chosen_id IS NULL THEN 'missing' WHEN c.command_result IS NULL THEN 'none'
   WHEN pg_column_compression(c.command_result) IS NOT NULL OR pg_column_size(c.command_result)>32768 THEN 'unavailable'
   WHEN c.command_result->>'kind'='EXECUTION_FINISHED' THEN 'finished_marker'
   WHEN c.command_result->>'kind'='EXECUTION_WAITING' THEN 'waiting_marker' ELSE 'other' END AS checkpoint
 FROM identities r LEFT JOIN LATERAL (
  SELECT webhook_event_id,status,enforced,prepared_at,business_started_at,completed_at,lease_token,lease_expires_at,command_result
  FROM webhook_execution_claims WHERE r.chosen_id IS NOT NULL AND id=r.chosen_id LIMIT 1
 ) c ON TRUE
), projected AS MATERIALIZED (
 SELECT id,created_at,json_build_object(
  'id',id,'createdAt',${iso('created_at')},'status',status,
  'normalizedBounded',normalized_bounded,
  'ordered',ordered,
  'chatId',CASE WHEN octet_length(chat_id)<=128 THEN chat_id END,
  'messageId',CASE WHEN octet_length(message_id)<=1024 THEN message_id END,
  'semanticKey',CASE WHEN octet_length(semantic_key)<=1024 THEN semantic_key END,
  'botId',CASE WHEN octet_length(bot_id)<=128 THEN bot_id END,
  'legacyReleased',legacy_released,'sourceReleased',source_released,
  'retry',CASE WHEN next_enqueue_at IS NULL THEN 'none' WHEN next_enqueue_at>statement_timestamp() AT TIME ZONE 'UTC' THEN 'future' ELSE 'due' END,
  'quarantine',CASE WHEN timeout_quarantine_expires_at IS NULL THEN 'none' WHEN timeout_quarantine_expires_at>statement_timestamp() AT TIME ZONE 'UTC' THEN 'live' ELSE 'expired' END,
  'errorFamily',error_family,
  'claim',json_build_object('semanticFound',semantic_claim_id IS NOT NULL,'directCount',direct_count,
   'conflict',direct_count>1 OR (semantic_claim_id IS NOT NULL AND direct_count=1 AND semantic_claim_id<>direct_claim_id),
   'id',chosen_id,'ownerId',claim_owner,
   'status',CASE WHEN chosen_id IS NULL THEN 'missing' WHEN claim_status IN ('PENDING','READY','COMPLETED') THEN claim_status::text ELSE 'other' END,
   'enforced',COALESCE(enforced,false),'prepared',prepared,'started',started,'completed',completed,
   'lease',CASE WHEN chosen_id IS NULL THEN 'missing' WHEN lease_token IS NULL AND lease_expires_at IS NULL THEN 'absent'
    WHEN lease_token IS NULL OR lease_expires_at IS NULL OR BTRIM(lease_token)='' OR NOT isfinite(lease_expires_at) THEN 'malformed'
    WHEN lease_expires_at>statement_timestamp() AT TIME ZONE 'UTC' THEN 'live' ELSE 'expired' END,'checkpoint',checkpoint
  )) AS value FROM observed
)
SELECT json_build_object('version',1,'kind','order_blocker_inventory_page','readOnly',true,
 'observedAt',${iso("statement_timestamp() AT TIME ZONE 'UTC'")},'status',${literal(status)},'cutoff',${literal(cutoff)},
 'pageSize',200,'after',${afterJson},'rawCount',(SELECT count(*) FROM raw_page),
 'hasMore',(SELECT count(*)=201 FROM raw_page),
 'nextCursor',(SELECT json_build_object('createdAt',${iso('created_at')},'id',id) FROM picked ORDER BY created_at DESC,id DESC LIMIT 1),
 'rows',COALESCE((SELECT json_agg(value ORDER BY created_at,id) FROM projected),'[]'::json),
 'coverage','ONLINE_PREVIEW','mutationAuthorized',false)::text AS inventory_page;`;
}

// FLAG: Plain EXPLAIN is mandatory before executing a new page query. Only five
// direct, bounded indexed probes are accepted; bounded CTE sorts cannot hide a
// sort or residual filter beneath a base-relation limit.
function validatePlan(value, input, phase) {
  const expected = request(input);
  const fail = (condition) => check(condition, 'order_inventory_plan_refused');
  fail(Array.isArray(value) && value.length === 1 && value[0]?.Plan);
  const nodes = [];
  const walk = (node, parents = []) => {
    fail(node && typeof node === 'object' && !Array.isArray(node));
    nodes.push({ node, parents });
    fail(nodes.length <= 128);
    for (const child of node.Plans ?? []) walk(child, [...parents, node]);
  };
  walk(value[0].Plan);
  const counts = { page: 0, metadata: 0, semantic: 0, direct: 0, claim: 0 };
  for (const { node, parents } of nodes) {
    fail(
      node['Parallel Aware'] !== true && !/Seq Scan|Bitmap|Gather/u.test(node['Node Type'] ?? ''),
    );
    if (!node['Relation Name']) continue;
    fail(['Index Scan', 'Index Only Scan'].includes(node['Node Type']) && !node.Filter);
    const position = parents.findLastIndex((p) => p['Node Type'] === 'Limit');
    fail(position >= 0 && parents.slice(position + 1).every((p) => !/Sort/u.test(p['Node Type'])));
    const limit = parents[position]['Plan Rows'];
    const condition = node['Index Cond'] ?? '';
    const index = node['Index Name'];
    if (index === 'webhook_events_status_created_at_id_idx') {
      fail(
        node['Relation Name'] === 'webhook_events' &&
          limit <= 201 &&
          condition.includes(`status = '${expected.status}'::"WebhookStatus"`) &&
          condition.includes(
            `created_at < '${pgClock(expected.cutoff)}'::timestamp without time zone`,
          ),
      );
      fail(
        expected.after === null ||
          (condition.includes('ROW(created_at, id) > ROW(') &&
            condition.includes(
              `'${pgClock(expected.after.createdAt)}'::timestamp without time zone`,
            ) &&
            condition.includes(`'${expected.after.id}'::text`)),
      );
      counts.page++;
    } else if (index === 'webhook_events_pkey') {
      fail(
        node['Relation Name'] === 'webhook_events' && limit <= 1 && /id = p\.id/u.test(condition),
      );
      counts.metadata++;
    } else if (index === 'webhook_execution_claims_kind_semantic_key') {
      fail(
        node['Relation Name'] === 'webhook_execution_claims' &&
          limit <= 1 &&
          condition.includes("kind = 'EXECUTION'") &&
          condition.includes('semantic_key = r.semantic_key'),
      );
      counts.semantic++;
    } else if (index === 'webhook_execution_claims_event_kind_idx') {
      fail(
        node['Relation Name'] === 'webhook_execution_claims' &&
          limit <= 2 &&
          condition.includes("kind = 'EXECUTION'") &&
          condition.includes('webhook_event_id = r.id'),
      );
      counts.direct++;
    } else if (index === 'webhook_execution_claims_pkey') {
      fail(
        node['Relation Name'] === 'webhook_execution_claims' &&
          limit <= 1 &&
          /id = r(?:_[0-9]+)?\.chosen_id/u.test(condition),
      );
      counts.claim++;
    } else fail(false);
  }
  const expectedCounts =
    phase === 'raw_index'
      ? [1, 0, 0, 0, 0]
      : phase === 'metadata'
        ? [1, 1, 0, 0, 0]
        : [1, 1, 1, 1, 1];
  fail(Object.values(counts).every((count, index) => count === expectedCounts[index]));
  const relationProbes = expectedCounts.reduce((sum, count) => sum + count, 0);
  return Object.freeze({
    operation: 'plain_explain',
    nodeCount: nodes.length,
    relationProbes,
    counts,
    rawRowCap: 201,
    metadataRowCap: phase === 'raw_index' ? 0 : 200,
    directClaimCap: phase === 'inventory' ? 2 : 0,
    directLimitsWithoutUnderlyingSort: true,
    privateLiteralsSuppressed: true,
  });
}

export function validateOrderBlockerPagePlan(value, input) {
  return validatePlan(value, input, 'inventory');
}
export function validateOrderBlockerDiagnosticPlan(value, input, phase) {
  check(ORDER_BLOCKER_DIAGNOSTIC_PHASES.includes(phase), 'order_inventory_plan_refused');
  return validatePlan(value, input, phase);
}
