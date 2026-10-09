export const ORDERED_ANCHOR_PAGE_SIZE = 200;
export const FROZEN_ORDERED_ANCHOR_PAGE_SIZE = 1000;
export const FROZEN_ORDERED_ANCHOR_OUTPUT_BYTES = 2 * 1024 * 1024 - 4096;

const check = (value, code = 'ordered_inventory_sql_request_refused') => {
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
function request(input, frozen = false) {
  check(input && typeof input === 'object' && !Array.isArray(input));
  check(Object.keys(input).every((key) => ['cutoff', 'pageSize', 'after'].includes(key)));
  check(canonicalClock(input.cutoff) && Date.parse(input.cutoff) <= Date.now());
  check(
    input.pageSize === ORDERED_ANCHOR_PAGE_SIZE ||
      (frozen && input.pageSize === FROZEN_ORDERED_ANCHOR_PAGE_SIZE),
  );
  check(
    input.after === null ||
      (input.after &&
        typeof input.after === 'object' &&
        Object.keys(input.after).sort().join(',') === 'chatId,createdAt,id' &&
        typeof input.after.chatId === 'string' &&
        input.after.chatId.trim() === input.after.chatId &&
        input.after.chatId.length > 0 &&
        Buffer.byteLength(input.after.chatId) <= 4096 &&
        // eslint-disable-next-line no-control-regex -- Reject control bytes in private SQL cursor keys.
        !/[\u0000-\u001f\u007f]/u.test(input.after.chatId) &&
        typeof input.after.id === 'string' &&
        idPattern.test(input.after.id) &&
        canonicalClock(input.after.createdAt) &&
        /\.\d{6}Z$/u.test(input.after.createdAt) &&
        clockKey(input.after.createdAt) < clockKey(input.cutoff)),
  );
  return input;
}

const chatExpression = `COALESCE(NULLIF(btrim(((normalized_payload -> 'message'::text) ->> 'chatId'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'chatId'::text)), ''::text))`;
const headPredicate = `(((status = ANY (ARRAY['RECEIVED'::"WebhookStatus", 'QUEUED'::"WebhookStatus"])) OR ((status = 'FAILED'::"WebhookStatus") AND ((next_enqueue_at IS NOT NULL) OR ("left"(COALESCE(error_message, ''::text), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'::text)))) AND (lower(COALESCE(NULLIF(btrim((normalized_payload ->> 'type'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'update_type'::text)), ''::text))) = ANY (ARRAY['message_created'::text, 'message_edited'::text])))`;

// FLAG: Walk the exact ordered-head partial index across all statuses and chats.
// The non-NULL chat key, timestamp cutoff and keyset cursor must all be index
// conditions. No status postfilter or first-head-only reduction may hide anchors.
// Released and unavailable metadata remains explicit, without granting authority.
function pageCtes(input, frozen = false) {
  const { cutoff, after, pageSize } = request(input, frozen);
  const cursor = after
    ? `AND (${chatExpression},created_at,id) > (${literal(after.chatId)},${literal(after.createdAt)}::timestamp,${literal(after.id)})`
    : '';
  const raw = `raw_page AS MATERIALIZED (
 SELECT ${chatExpression} AS order_chat_id,id,created_at FROM webhook_events
 WHERE ${headPredicate} AND ${chatExpression} IS NOT NULL AND created_at<${literal(cutoff)}::timestamp
 ${cursor} ORDER BY ${chatExpression},created_at,id LIMIT ${pageSize + 1}
), picked AS MATERIALIZED (
 SELECT order_chat_id,id,created_at FROM raw_page ORDER BY order_chat_id,created_at,id LIMIT ${pageSize}
)`;
  return `${raw}, metadata AS MATERIALIZED (
 SELECT p.order_chat_id,p.id,p.created_at,e.* FROM picked p CROSS JOIN LATERAL (
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
 SELECT order_chat_id,id,created_at,status,bot_id,semantic_key,next_enqueue_at,timeout_quarantine_expires_at,
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

function buildPageSql(input, frozen = false) {
  const { cutoff, after, pageSize } = request(input, frozen);
  const afterJson = after
    ? `json_build_object('chatId',${literal(after.chatId)},'createdAt',${literal(after.createdAt)},'id',${literal(after.id)})`
    : 'NULL::json';
  const query = `WITH ${pageCtes(input, frozen)}, identities AS MATERIALIZED (
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
 SELECT order_chat_id,id,created_at,json_build_object(
  'orderChatId',CASE WHEN octet_length(order_chat_id)<=4096 THEN order_chat_id END,
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
SELECT json_build_object('version',${frozen ? 3 : 2},'kind','${frozen ? 'frozen_ordered_anchor_inventory_page' : 'ordered_anchor_inventory_page'}','readOnly',true,
 'observedAt',${iso("statement_timestamp() AT TIME ZONE 'UTC'")},'cutoff',${literal(cutoff)},
 'pageSize',${pageSize},'after',${afterJson},'rawCount',(SELECT count(*) FROM raw_page),
 'hasMore',(SELECT count(*)=${pageSize + 1} FROM raw_page),
 'nextCursor',(SELECT json_build_object('chatId',CASE WHEN octet_length(order_chat_id)<=4096 THEN order_chat_id END,'createdAt',${iso('created_at')},'id',id) FROM picked ORDER BY order_chat_id DESC,created_at DESC,id DESC LIMIT 1),
 'rows',COALESCE((SELECT json_agg(value ORDER BY order_chat_id,created_at,id) FROM projected),'[]'::json),
 'coverage','${frozen ? 'STOPPED_METADATA' : 'ONLINE_PREVIEW'}','mutationAuthorized',false)::text AS inventory_page`;
  if (!frozen) return `${query};`;
  // FLAG: Evaluate the bounded page once. Oversized projected metadata emits only
  // a typed refusal; the caller may retry the same cursor at 200, never a timeout.
  // Reserve 4096 bytes for the unchanged audit wrapper's markers and framing.
  return `WITH bounded_document AS MATERIALIZED (${query})
SELECT CASE WHEN octet_length(inventory_page)<=${FROZEN_ORDERED_ANCHOR_OUTPUT_BYTES} THEN inventory_page
 ELSE json_build_object('version',3,'kind','frozen_ordered_anchor_page_refused','reason','output_budget',
  'readOnly',true,'cutoff',${literal(cutoff)},'pageSize',${pageSize},'after',${afterJson},
  'rawCount',(inventory_page::json->>'rawCount')::integer,'mutationAuthorized',false)::text END AS inventory_page
FROM bounded_document;`;
}

export const buildOrderedAnchorPageSql = (input) => buildPageSql(input);
export const buildFrozenOrderedAnchorPageSql = (input) => buildPageSql(input, true);

// FLAG: Plain EXPLAIN is mandatory before executing a new page query. Only five
// direct, bounded indexed probes are accepted; bounded CTE sorts cannot hide a
// sort or residual filter beneath a base-relation limit.
function validatePagePlan(value, input, frozen = false) {
  const expected = request(input, frozen);
  const fail = (condition) => check(condition, 'ordered_inventory_plan_refused');
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
    if (index === 'webhook_events_ordered_chat_head_idx') {
      fail(
        node['Relation Name'] === 'webhook_events' &&
          limit <= expected.pageSize + 1 &&
          condition.includes(`${chatExpression} IS NOT NULL`) &&
          condition.includes(
            `created_at < '${pgClock(expected.cutoff)}'::timestamp without time zone`,
          ),
      );
      fail(
        expected.after === null ||
          (condition.includes(`ROW(${chatExpression}, created_at, id) > ROW(`) &&
            condition.includes(`${literal(expected.after.chatId)}::text`) &&
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
  fail(Object.values(counts).every((count) => count === 1));
  return Object.freeze({
    operation: 'plain_explain',
    nodeCount: nodes.length,
    relationProbes: 5,
    counts,
    rawRowCap: expected.pageSize + 1,
    metadataRowCap: expected.pageSize,
    directClaimCap: 2,
    directLimitsWithoutUnderlyingSort: true,
    privateLiteralsSuppressed: true,
  });
}

export const validateOrderedAnchorPagePlan = (value, input) => validatePagePlan(value, input);
export const validateFrozenOrderedAnchorPagePlan = (value, input) =>
  validatePagePlan(value, input, true);
