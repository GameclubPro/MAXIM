import { multibotPreparationChecksums } from './multibot-prepare-diagnostics.mjs';

export const MULTIBOT_PREPARATION_RECOVERY_MIGRATION =
  '20261005016100_index_multibot_retention_cursor';
const parentMigrations = [
  '20261005015900_prepare_multibot_webhook_columns',
  '20261005016000_add_multibot_semantic_order_index',
];
const cutoffMigrations = [
  '20261005020000_add_multibot_order_fences',
  '20261005020200_preserve_semantic_execution_tombstones',
];
const replayPredicate =
  "((semantic_key IS NOT NULL) AND ((status = ANY (ARRAY['RECEIVED'::\"WebhookStatus\", 'QUEUED'::\"WebhookStatus\"])) OR ((status = 'FAILED'::\"WebhookStatus\") AND (next_enqueue_at IS NOT NULL)) OR (timeout_quarantine_expires_at IS NOT NULL) OR (COALESCE(error_message, ''::text) ~~* '%ambiguous%'::text) OR (COALESCE(error_message, ''::text) ~~ 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'::text)))";
const indexDefinitions = [
  {
    name: 'webhook_events_semantic_order_idx',
    keys: ['semantic_key', 'created_at', 'id'],
    predicate: '(semantic_key IS NOT NULL)',
  },
  {
    name: 'webhook_events_status_created_at_id_idx',
    keys: ['status', 'created_at', 'id'],
    predicate: null,
  },
  {
    name: 'webhook_events_semantic_replay_fence_idx',
    keys: ['semantic_key', 'id'],
    predicate: replayPredicate,
  },
];
const fixedCreateSql = Object.freeze({
  webhook_events_status_created_at_id_idx:
    'CREATE INDEX CONCURRENTLY "webhook_events_status_created_at_id_idx"\nON public."webhook_events" ("status", "created_at", "id");',
  webhook_events_semantic_replay_fence_idx: `CREATE INDEX CONCURRENTLY "webhook_events_semantic_replay_fence_idx"
ON public."webhook_events" ("semantic_key", "id")
WHERE "semantic_key" IS NOT NULL AND (
  "status" IN ('RECEIVED'::"WebhookStatus", 'QUEUED'::"WebhookStatus")
   OR ("status" = 'FAILED'::"WebhookStatus" AND "next_enqueue_at" IS NOT NULL)
   OR "timeout_quarantine_expires_at" IS NOT NULL
   OR COALESCE("error_message", '') ILIKE '%ambiguous%'
   OR COALESCE("error_message", '') LIKE 'WEBHOOK_HOT_PATH_TIMEOUT%QUARANTINED%'
);`,
});
const fixedReindexSql = Object.freeze(
  Object.fromEntries(
    Object.keys(fixedCreateSql).map((name) => [
      name,
      `REINDEX INDEX CONCURRENTLY public."${name}";`,
    ]),
  ),
);
const digestPattern = /^[0-9a-f]{64}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/u;
const fail = (code) => {
  throw new Error(`MULTIBOT_RECOVERY_${code}`);
};

function timestamp(value) {
  if (typeof value !== 'string' || !utcPattern.test(value)) fail('TIMESTAMP_INVALID');
  const result = Date.parse(value);
  if (
    !Number.isFinite(result) ||
    new Date(result).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    fail('TIMESTAMP_INVALID');
  return result;
}

// FLAG: An unfinished receipt, even one with empty logs, is not cancellation proof.
// The locked operator must independently attest the reviewed transition journal,
// observed attempt bounds and fresh absence of its exact owned session/container.
export function verifyMultibotPreparationCancellation(context, record) {
  const proof = context?.cancellationProof;
  const now = context?.nowMs ?? Date.now();
  if (
    !shaPattern.test(context?.sourceSha ?? '') ||
    !shaPattern.test(context?.cancelledSourceSha ?? '') ||
    !shaPattern.test(context?.expectedTransitionSourceSha ?? '') ||
    !digestPattern.test(context?.expectedTransitionJournalHash ?? '') ||
    !digestPattern.test(context?.expectedReceiptIdentityHash ?? '') ||
    proof?.sourceSha !== context.cancelledSourceSha ||
    proof.transitionSourceSha !== context.expectedTransitionSourceSha ||
    proof.transitionJournalHash !== context.expectedTransitionJournalHash ||
    proof.receiptIdentityHash !== context.expectedReceiptIdentityHash ||
    record.identity_hash !== context.expectedReceiptIdentityHash ||
    proof.attemptStartedAt !== context.attemptStartedAt ||
    proof.attemptAbortedAt !== context.attemptAbortedAt ||
    proof.taggedSessionsAbsent !== true ||
    proof.ownedContainerStopped !== true ||
    proof.baselineRuntimeAttested !== true ||
    !Number.isSafeInteger(now)
  )
    fail('CANCELLATION_PROOF_INVALID');
  const started = timestamp(context.attemptStartedAt);
  const aborted = timestamp(context.attemptAbortedAt);
  const cleanup = timestamp(proof.cleanupVerifiedAt);
  const receiptStarted = timestamp(record.started_at);
  if (
    started > aborted ||
    aborted > cleanup ||
    cleanup > now ||
    now - cleanup > 60_000 ||
    receiptStarted < started ||
    receiptStarted > aborted
  )
    fail('CANCELLATION_PROOF_STALE');
}

function verifyReport(report) {
  if (
    report?.schema_version !== 1 ||
    report.audit !== 'multibot_preparation' ||
    report.read_only !== true ||
    report.authority !== 'DIAGNOSTICS_ONLY' ||
    report.parent_kind !== 'r' ||
    report.metadata_limit_exceeded !== false ||
    report.metadata?.other_failed !== false ||
    report.repair_artifacts?.present !== false ||
    report.repair_artifacts?.sampled_count !== 0 ||
    report.repair_artifacts?.limited !== false ||
    report.builders?.statistics_visible !== true ||
    report.builders?.absent !== true ||
    report.builders?.limited !== false ||
    [
      'tagged_sessions',
      'active_tagged_sessions',
      'active_index_sessions',
      'progress_sessions',
      'prepared_transactions',
      'prepared_webhook_relation_locks',
    ].some((name) => report.builders[name] !== 0)
  )
    fail('ADMISSION_METADATA_INVALID');
  if (!Array.isArray(report.columns) || report.columns.length !== 2)
    fail('COLUMN_DEFINITION_DRIFT');
  for (const [name, type] of [
    ['semantic_key', 'text'],
    ['execution_deadline_at', 'timestamp(3) without time zone'],
  ]) {
    const columns = report.columns.filter((column) => column.name === name);
    if (
      columns.length !== 1 ||
      columns[0].present !== true ||
      columns[0].type !== type ||
      columns[0].not_null !== false ||
      columns[0].default_present !== false ||
      columns[0].identity !== '' ||
      columns[0].generated !== '' ||
      columns[0].default_collation !== true
    )
      fail('COLUMN_DEFINITION_DRIFT');
  }
}

function readReceipt(report, name, allowedStates) {
  const groups = report.metadata.migrations?.filter((entry) => entry.name === name);
  if (
    groups?.length !== 1 ||
    groups[0].limited !== false ||
    groups[0].expected_checksum !== multibotPreparationChecksums[name] ||
    !Array.isArray(groups[0].records) ||
    groups[0].records.length !== 1
  )
    fail('RECEIPT_AMBIGUOUS');
  const record = groups[0].records[0];
  if (
    !digestPattern.test(record.identity_hash ?? '') ||
    record.checksum !== multibotPreparationChecksums[name] ||
    record.checksum_matches !== true ||
    record.rolled_back_at !== null ||
    !allowedStates.includes(record.state) ||
    (record.state === 'APPLIED') !== (record.finished_at !== null)
  )
    fail('RECEIPT_INVALID');
  timestamp(record.started_at);
  if (record.finished_at !== null) {
    if (timestamp(record.finished_at) < timestamp(record.started_at)) fail('RECEIPT_INVALID');
  }
  return record;
}

function readRecoveryReceipt(report, context) {
  const groups = report.metadata.migrations.filter(
    (entry) => entry.name === MULTIBOT_PREPARATION_RECOVERY_MIGRATION,
  );
  if (
    groups.length !== 1 ||
    groups[0].limited !== false ||
    groups[0].expected_checksum !==
      multibotPreparationChecksums[MULTIBOT_PREPARATION_RECOVERY_MIGRATION] ||
    !Array.isArray(groups[0].records) ||
    ![1, 2].includes(groups[0].records.length)
  )
    fail('RECEIPT_AMBIGUOUS');
  const records = groups[0].records;
  const original = records.filter(
    (entry) => entry.identity_hash === context.expectedReceiptIdentityHash,
  );
  if (original.length !== 1) fail('RECEIPT_INVALID');
  for (const record of records) {
    if (
      !digestPattern.test(record.identity_hash ?? '') ||
      record.checksum !== multibotPreparationChecksums[MULTIBOT_PREPARATION_RECOVERY_MIGRATION] ||
      record.checksum_matches !== true
    )
      fail('RECEIPT_INVALID');
    timestamp(record.started_at);
  }
  const record = original[0];
  verifyMultibotPreparationCancellation(context, record);
  if (
    record.finished_at !== null ||
    !['NO_ERROR_RECORDED', 'QUERY_CANCELLED', 'CONNECTION_TERMINATED'].includes(record.failure_code)
  )
    fail('RECEIPT_INVALID');
  if (records.length === 1) {
    if (record.state !== 'UNFINISHED' || record.rolled_back_at !== null) fail('RECEIPT_INVALID');
    return { state: 'UNFINISHED', original: record };
  }
  // FLAG: Prisma resolve --applied preserves the old failed row as rolled back and
  // inserts a new applied receipt. A same-ID completion or missing old evidence
  // is outside this recovery path and must never pass the final proof.
  const applied = records.find((entry) => entry !== record);
  if (
    record.state !== 'ROLLED_BACK' ||
    record.rolled_back_at === null ||
    applied.state !== 'APPLIED' ||
    applied.rolled_back_at !== null ||
    applied.finished_at === null ||
    applied.started_at !== applied.finished_at ||
    timestamp(record.rolled_back_at) < timestamp(context.attemptAbortedAt) ||
    timestamp(applied.started_at) < timestamp(record.rolled_back_at) ||
    timestamp(applied.finished_at) > (context.nowMs ?? Date.now())
  )
    fail('RECEIPT_INVALID');
  return { state: 'APPLIED', original: record, applied };
}

function indexAction(report, expected) {
  const indexes = report.indexes?.filter((index) => index.name === expected.name);
  if (
    indexes?.length !== 1 ||
    JSON.stringify(indexes[0].expected_keys) !== JSON.stringify(expected.keys) ||
    indexes[0].expected_predicate !== expected.predicate
  )
    fail('INDEX_DEFINITION_DRIFT');
  const index = indexes[0];
  if (index.present === false && index.state === 'ABSENT' && index.definition_matches === false)
    return 'create';
  if (
    index.present !== true ||
    index.kind !== 'i' ||
    index.parent_matches !== true ||
    index.definition_matches !== true ||
    index.live !== true ||
    index.unique !== false ||
    index.primary !== false ||
    index.exclusion !== false ||
    index.method !== 'btree' ||
    index.key_count !== expected.keys.length ||
    index.attribute_count !== expected.keys.length ||
    typeof index.valid !== 'boolean' ||
    typeof index.ready !== 'boolean'
  )
    fail('INDEX_DEFINITION_DRIFT');
  if (index.valid && index.ready && index.state === 'READY') return 'ready';
  if (!index.valid && index.state === 'INCOMPLETE') return 'reindex';
  fail('INDEX_STATE_INVALID');
}

export function multibotPreparationRecoveryDdl(index, action) {
  if (typeof index !== 'string' || !Object.hasOwn(fixedCreateSql, index)) fail('DDL_OUTSIDE_SCOPE');
  const sql =
    action === 'create'
      ? fixedCreateSql[index]
      : action === 'reindex'
        ? fixedReindexSql[index]
        : undefined;
  if (!sql) fail('DDL_OUTSIDE_SCOPE');
  return sql;
}

export function planMultibotPreparationRecovery(report, context) {
  verifyReport(report);
  if (!Array.isArray(report.indexes) || report.indexes.length !== indexDefinitions.length)
    fail('INDEX_DEFINITION_DRIFT');
  if (!Array.isArray(report.metadata.migrations) || report.metadata.migrations.length !== 5)
    fail('RECEIPT_AMBIGUOUS');
  for (const name of parentMigrations) readReceipt(report, name, ['APPLIED']);
  for (const name of cutoffMigrations) {
    const groups = report.metadata.migrations.filter((entry) => entry.name === name);
    if (
      groups.length !== 1 ||
      groups[0].limited !== false ||
      groups[0].expected_checksum !== multibotPreparationChecksums[name] ||
      !Array.isArray(groups[0].records) ||
      groups[0].records.length !== 0
    )
      fail('CUTOFF_ALREADY_STARTED');
  }
  const receipt = readRecoveryReceipt(report, context);
  const actions = indexDefinitions.map((expected) => ({
    index: expected.name,
    action: indexAction(report, expected),
  }));
  if (actions[0].action !== 'ready') fail('COMPLETED_PARENT_INDEX_DRIFT');
  if (receipt.state === 'APPLIED' && actions.some((entry) => entry.action !== 'ready'))
    fail('APPLIED_MIGRATION_DRIFT');
  return {
    migration: MULTIBOT_PREPARATION_RECOVERY_MIGRATION,
    state: receipt.state === 'APPLIED' ? 'ALREADY_APPLIED' : 'RECOVERY_REQUIRED',
    actions: actions.filter((entry) => entry.action !== 'ready'),
  };
}

function receiptIdentity(report, context) {
  const record = report.metadata.migrations
    .find((entry) => entry.name === MULTIBOT_PREPARATION_RECOVERY_MIGRATION)
    .records.find((entry) => entry.identity_hash === context.expectedReceiptIdentityHash);
  return JSON.stringify([record.identity_hash, record.checksum, record.started_at]);
}

// FLAG: This pure state machine owns no SQL connection, deploy lock or live service.
// Its operations must use exact-SHA locked tooling and supervise every heavy statement;
// cancellation/DDL failure preserves receipts and artifacts, with no automatic retry.
export async function recoverMultibotPreparation(operations, context, { apply = false } = {}) {
  if (typeof apply !== 'boolean') fail('APPLY_MODE_INVALID');
  const read = async () => {
    const cancellationProof = await operations.attestCancellation();
    const report = await operations.readDiagnostic();
    const plan = planMultibotPreparationRecovery(report, {
      ...context,
      cancellationProof,
      nowMs: operations.now?.() ?? Date.now(),
    });
    return { report, plan, cancellationProof };
  };
  const initial = await read();
  if (!apply || initial.plan.state === 'ALREADY_APPLIED')
    return { ...initial.plan, applied: false };
  const identity = receiptIdentity(initial.report, context);
  const requireSameReceipt = (current) => {
    if (
      receiptIdentity(current.report, context) !== identity ||
      current.plan.state !== 'RECOVERY_REQUIRED'
    )
      fail('RECEIPT_CHANGED');
  };
  for (const action of initial.plan.actions) {
    await operations.assertAdmission();
    const before = await read();
    requireSameReceipt(before);
    if (
      !before.plan.actions.some(
        (entry) => entry.index === action.index && entry.action === action.action,
      )
    )
      fail('INDEX_STATE_CHANGED');
    await operations.repairIndex({
      ...action,
      sql: multibotPreparationRecoveryDdl(action.index, action.action),
    });
    const after = await read();
    requireSameReceipt(after);
    if (after.plan.actions.some((entry) => entry.index === action.index))
      fail('REPAIR_POSTCONDITION_FAILED');
  }
  await operations.assertAdmission();
  const beforeResolve = await read();
  requireSameReceipt(beforeResolve);
  if (beforeResolve.plan.actions.length) fail('REPAIR_POSTCONDITION_FAILED');
  const resolveStartedAt = operations.now?.() ?? Date.now();
  await operations.resolveMigration(MULTIBOT_PREPARATION_RECOVERY_MIGRATION);
  const final = await read();
  if (
    receiptIdentity(final.report, context) !== identity ||
    final.plan.state !== 'ALREADY_APPLIED' ||
    final.plan.actions.length
  )
    fail('RESOLVE_POSTCONDITION_FAILED');
  const finalReceipt = readRecoveryReceipt(final.report, {
    ...context,
    cancellationProof: final.cancellationProof,
    nowMs: operations.now?.() ?? Date.now(),
  });
  if (
    timestamp(finalReceipt.original.rolled_back_at) < resolveStartedAt ||
    timestamp(finalReceipt.applied.started_at) < resolveStartedAt
  )
    fail('RESOLVE_POSTCONDITION_FAILED');
  return { ...final.plan, applied: true };
}
