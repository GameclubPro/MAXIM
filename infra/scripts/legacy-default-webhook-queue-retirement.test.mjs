import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import queueModule from './legacy-default-webhook-queue-retirement.cjs';
import {
  LegacyDefaultWebhookDbAuditBlockedError,
  buildLegacyDefaultWebhookDbAuditSql,
  normalizeLegacyDefaultWebhookDbAuditSummary,
} from './legacy-default-webhook-db-audit.mjs';

const root = resolve(import.meta.dirname, '../..');
const queueHelperPath = resolve(root, 'infra/scripts/legacy-default-webhook-queue-retirement.cjs');
const {
  LEGACY_DEFAULT_WEBHOOK_QUEUE,
  LEGACY_JOB_MIN_TIMESTAMP_MS,
  MAX_LEGACY_JOBS,
  OBLITERATE_BATCH_SIZE,
  PRODUCTION_API_SERVICES,
  QUEUE_STATES,
  REMOTE_APPLY_WATCHDOG_EXIT_CODE,
  LegacyDefaultQueuePreconditionError,
  armRemoteApplyWatchdog,
  attestWebhookProducerRuntime,
  formatFailureDiagnostic,
  inspectDefaultWebhookShards,
  inspectLegacyDefaultWebhookQueue,
  inspectLegacyDefaultWebhookQueueSettlement,
  retireLegacyDefaultWebhookQueue,
  summarizeSnapshot,
  validatePrivateSnapshot,
  validateRemoteApplyDeadline,
} = queueModule;

test('failure diagnostics expose only allowlisted precondition codes', () => {
  assert.equal(
    formatFailureDiagnostic(new LegacyDefaultQueuePreconditionError('legacy_job_shape_invalid')),
    'Legacy default webhook queue retirement failed closed. code=legacy_job_shape_invalid\n',
  );
  assert.equal(
    formatFailureDiagnostic(new LegacyDefaultQueuePreconditionError('private-job-id')),
    'Legacy default webhook queue retirement failed closed.\n',
  );
  assert.equal(
    formatFailureDiagnostic(new Error('sensitive failure detail')),
    'Legacy default webhook queue retirement failed closed.\n',
  );
});

test('remote queue actions await completion before closing the Redis connection', () => {
  const source = readFileSync(queueHelperPath, 'utf8');

  assert.match(
    source,
    /if \(action === 'snapshot'\) return await inspectLegacyDefaultWebhookQueue\(queue\);/u,
  );
  assert.match(source, /return await inspectLegacyDefaultWebhookQueueSettlement\(queue\);/u);
  assert.match(
    source,
    /return await retireLegacyDefaultWebhookQueue\(queue, readBoundedStdin\(\), deadlineAtMs\);/u,
  );
  assert.match(source, /finally \{\s+await queue\.close\(\)\.catch/u);
});

function validRuntimeModules() {
  const appRoles = ['all', 'ingress', 'admin', 'enqueue', 'moderation', 'action', 'publisher'];
  const runtimeServices = ['api-all', ...PRODUCTION_API_SERVICES];
  const activeQueues = [
    'moderation-critical',
    ...Array.from({ length: 4 }, (_, index) => `moderation-join-${index}`),
    ...Array.from({ length: 16 }, (_, index) => `moderation-default-${index}`),
    'moderation-background',
  ];
  return {
    appRole: {
      APP_ROLES: appRoles,
      roleRunsEnqueue: (role) => role === 'all' || role === 'enqueue',
    },
    queues: {
      ACTIVE_WEBHOOK_QUEUE_NAMES: activeQueues,
      ALL_WEBHOOK_QUEUE_NAMES: ['moderation', ...activeQueues],
    },
    topology: {
      RUNTIME_SERVICE_NAMES: runtimeServices,
      RUNTIME_SERVICE_PROFILES: Object.fromEntries(
        runtimeServices.map((service) => [
          service,
          { capabilities: { enqueueEnabled: service === 'api-all' || service === 'api-enqueue' } },
        ]),
      ),
    },
  };
}

function validJob(id, options = {}) {
  return {
    id,
    name: options.name ?? 'process-webhook-event',
    data: options.data ?? { webhookEventId: id },
    timestamp: options.timestamp ?? LEGACY_JOB_MIN_TIMESTAMP_MS + 60_000,
    opts: { priority: options.priority ?? 5, ...(options.opts ?? {}) },
    getDependenciesCount: async () =>
      options.dependencyCounts ?? {
        processed: 0,
        unprocessed: 0,
        ignored: 0,
        failed: 0,
      },
    ...(options.linkage ?? {}),
  };
}

function remoteDeadline() {
  return Date.now() + 60_000;
}

class FakeQueue {
  constructor(records = {}, options = {}) {
    this.name = options.name ?? LEGACY_DEFAULT_WEBHOOK_QUEUE;
    this.records = Object.fromEntries(
      QUEUE_STATES.map((state) => [state, [...(records[state] ?? [])]]),
    );
    this.version = Object.hasOwn(options, 'version') ? options.version : 'bullmq:5.77.6';
    this.pausedState = options.paused ?? false;
    this.workerCount = options.workerCount ?? 0;
    this.jobSchedulerCount = options.jobSchedulerCount ?? 0;
    this.onPause = options.onPause;
    this.omitCount = options.omitCount;
    this.pauseCalls = 0;
    this.obliterateCalls = [];
  }

  async waitUntilReady() {}
  async getVersion() {
    return this.version;
  }
  async isPaused() {
    return this.pausedState;
  }
  async getWorkersCount() {
    return this.workerCount;
  }
  async getJobSchedulersCount() {
    return this.jobSchedulerCount;
  }
  async getJobCounts(...states) {
    return Object.fromEntries(
      states
        .filter((state) => state !== this.omitCount)
        .map((state) => [state, this.records[state].length]),
    );
  }
  async getJobs(states, start, end) {
    assert.equal(states.length, 1);
    return this.records[states[0]].slice(start, end + 1);
  }
  async pause() {
    this.pauseCalls += 1;
    this.pausedState = true;
    this.onPause?.(this);
  }
  async obliterate(options) {
    this.obliterateCalls.push(options);
    for (const state of QUEUE_STATES) this.records[state] = [];
    this.version = null;
    this.pausedState = false;
  }
  async close() {}
}

function writePrivateSnapshot(snapshot) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-legacy-default-snapshot-'));
  const path = join(directory, 'snapshot.json');
  writeFileSync(path, JSON.stringify(snapshot), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function allowedDbSummary(requestedCount) {
  return {
    schema_version: 1,
    audit: 'legacy_default_webhook_jobs',
    requested_count: requestedCount,
    absent_count: Math.max(0, requestedCount - 2),
    processed_count: requestedCount > 0 ? 1 : 0,
    duplicate_count: requestedCount > 1 ? 1 : 0,
    received_count: 0,
    queued_count: 0,
    failed_count: 0,
    quarantined_count: 0,
    retryable_failed_count: 0,
  };
}

test('snapshots only the bounded historical prioritized and failed cohort', async () => {
  const queue = new FakeQueue({
    prioritized: [validJob('event-0001'), validJob('event-0002')],
    failed: [validJob('event-0003')],
  });
  const snapshot = await inspectLegacyDefaultWebhookQueue(queue);

  assert.equal(snapshot.records.length, 3);
  assert.equal(snapshot.summary.counts.prioritized, 2);
  assert.equal(snapshot.summary.counts.failed, 1);
  assert.equal(snapshot.summary.jobSchedulerCount, 0);
  assert.deepEqual(snapshot.summary.priorityCounts, { 5: 3 });
  assert.doesNotMatch(JSON.stringify(summarizeSnapshot(snapshot)), /event-000/u);
});

test('rejects oversized, active, malformed, and out-of-window legacy cohorts', async () => {
  const oversized = new FakeQueue({
    prioritized: Array.from({ length: MAX_LEGACY_JOBS + 1 }, (_, index) =>
      validJob(`event-${String(index).padStart(5, '0')}`),
    ),
  });
  await assert.rejects(
    inspectLegacyDefaultWebhookQueue(oversized),
    (error) =>
      error instanceof LegacyDefaultQueuePreconditionError &&
      error.code === 'legacy_job_cap_exceeded',
  );
  await assert.rejects(
    inspectLegacyDefaultWebhookQueue(new FakeQueue({ active: [validJob('event-active')] })),
    (error) =>
      error instanceof LegacyDefaultQueuePreconditionError &&
      error.code === 'unexpected_legacy_job_state',
  );
  await assert.rejects(
    inspectLegacyDefaultWebhookQueue(new FakeQueue({}, { jobSchedulerCount: 1 })),
    (error) =>
      error instanceof LegacyDefaultQueuePreconditionError &&
      error.code === 'unexpected_legacy_job_scheduler',
  );
  for (const job of [
    validJob('event-bad-data', { data: { webhookEventId: 'different' } }),
    validJob('event-bad-priority', { priority: 1 }),
    validJob('event-bad-time', { timestamp: LEGACY_JOB_MIN_TIMESTAMP_MS - 1 }),
  ]) {
    await assert.rejects(
      inspectLegacyDefaultWebhookQueue(new FakeQueue({ prioritized: [job] })),
      (error) =>
        error instanceof LegacyDefaultQueuePreconditionError &&
        error.code === 'legacy_job_shape_invalid',
    );
  }
  await assert.rejects(
    inspectLegacyDefaultWebhookQueue(new FakeQueue({}, { omitCount: 'failed' })),
    /missing_failed_count/u,
  );
  await assert.rejects(
    inspectLegacyDefaultWebhookQueue(new FakeQueue({}, { version: 'bullmq:5.99.0' })),
    /queue_metadata_invalid/u,
  );
});

test('treats an absent queue as an idempotent no-write success', async () => {
  const queue = new FakeQueue({}, { version: null });
  const snapshot = await inspectLegacyDefaultWebhookQueue(queue);
  const result = await retireLegacyDefaultWebhookQueue(queue, snapshot, remoteDeadline());

  assert.equal(snapshot.summary.present, false);
  assert.equal(result.result, 'already_absent');
  assert.equal(queue.pauseCalls, 0);
  assert.deepEqual(queue.obliterateCalls, []);
  assert.doesNotThrow(() => validatePrivateSnapshot(snapshot));
});

test('rejects BullMQ parent, repeat, and dependency linkage before obliteration', async () => {
  const linkedJobs = [
    validJob('event-parent-key', { linkage: { parentKey: 'bull:other:parent-1' } }),
    validJob('event-parent-data', {
      linkage: { parent: { id: 'parent-1', queueKey: 'bull:other' } },
    }),
    validJob('event-parent-opts', {
      opts: { parent: { id: 'parent-1', queue: 'other' } },
    }),
    validJob('event-repeat-key', { linkage: { repeatJobKey: 'repeat-1' } }),
    validJob('event-repeat-opts', { opts: { repeat: { every: 60_000 } } }),
    validJob('event-dependencies', {
      dependencyCounts: { processed: 0, unprocessed: 1, ignored: 0, failed: 0 },
    }),
  ];

  for (const job of linkedJobs) {
    const queue = new FakeQueue({ prioritized: [job] });
    await assert.rejects(
      inspectLegacyDefaultWebhookQueue(queue),
      LegacyDefaultQueuePreconditionError,
    );
    assert.equal(queue.pauseCalls, 0);
    assert.deepEqual(queue.obliterateCalls, []);
  }

  const racedJob = validJob('event-parent-race');
  const raced = new FakeQueue(
    { prioritized: [racedJob] },
    { onPause: () => Object.assign(racedJob, { parentKey: 'bull:other:parent-2' }) },
  );
  const expected = await inspectLegacyDefaultWebhookQueue(raced);
  await assert.rejects(
    retireLegacyDefaultWebhookQueue(raced, expected, remoteDeadline()),
    LegacyDefaultQueuePreconditionError,
  );
  assert.equal(raced.pausedState, true);
  assert.deepEqual(raced.obliterateCalls, []);
});

test('remote apply deadline uses a referenced hard-exit watchdog', () => {
  const nowMs = 1_800_000_000_000;
  const deadlineAtMs = validateRemoteApplyDeadline(String(nowMs + 10_000), nowMs);
  let callback;
  let cleared = false;
  let unrefCalls = 0;
  let exitCode = null;
  let errorOutput = '';
  const timer = { unref: () => (unrefCalls += 1) };
  const watchdog = armRemoteApplyWatchdog(deadlineAtMs, {
    now: () => nowMs,
    setTimer: (handler, delayMs) => {
      callback = handler;
      assert.equal(delayMs, 10_000);
      return timer;
    },
    clearTimer: (value) => {
      assert.equal(value, timer);
      cleared = true;
    },
    terminate: (value) => {
      exitCode = value;
    },
    writeError: (value) => {
      errorOutput += value;
    },
  });

  assert.equal(unrefCalls, 0);
  watchdog.assertBeforeMutation();
  callback();
  assert.equal(exitCode, REMOTE_APPLY_WATCHDOG_EXIT_CODE);
  assert.match(errorOutput, /remote apply deadline exceeded/u);
  watchdog.clear();
  assert.equal(cleared, true);
  assert.throws(
    () => validateRemoteApplyDeadline(String(nowMs + 121_000), nowMs),
    /remote_apply_deadline_invalid/u,
  );
});

test('remote watchdog terminates a process stuck in the first queue mutation', () => {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
const helper = require(${JSON.stringify(queueHelperPath)});
const counts = Object.fromEntries(helper.QUEUE_STATES.map((state) => [state, 0]));
const queue = {
  name: helper.LEGACY_DEFAULT_WEBHOOK_QUEUE,
  close: async () => undefined,
  getJobCounts: async () => ({ ...counts }),
  getJobs: async () => [],
  getJobSchedulersCount: async () => 0,
  getVersion: async () => 'bullmq:5.77.6',
  getWorkersCount: async () => 0,
  isPaused: async () => false,
  obliterate: async () => { throw new Error('obliterate must not run'); },
  pause: async () => new Promise(() => undefined),
  waitUntilReady: async () => undefined,
};
void helper.inspectLegacyDefaultWebhookQueue(queue).then((snapshot) =>
  helper.retireLegacyDefaultWebhookQueue(queue, snapshot, Date.now() + 2_000)
);
`,
    ],
    { cwd: root, encoding: 'utf8', timeout: 5_000 },
  );

  assert.equal(result.status, REMOTE_APPLY_WATCHDOG_EXIT_CODE, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /remote apply deadline exceeded/u);
  assert.ok(Date.now() - startedAt < 4_500);
});

test('settlement proof requires two identical strict queue snapshots', async () => {
  const queue = new FakeQueue({ prioritized: [validJob('event-settlement')] }, { paused: true });
  const result = await inspectLegacyDefaultWebhookQueueSettlement(queue, (resolve) => resolve());

  assert.equal(result.settled, true);
  assert.equal(result.queue.paused, true);
  assert.doesNotMatch(JSON.stringify(result), /event-settlement/u);
});

test('attests the exact runtime queue registry and sole production enqueue role', () => {
  const modules = validRuntimeModules();
  const proof = attestWebhookProducerRuntime(modules);
  assert.deepEqual(proof, {
    version: 1,
    productionServiceCount: 13,
    productionEnqueueProducerCount: 1,
    enqueueRoleCount: 2,
    activeWebhookQueueCount: 22,
    registeredWebhookQueueCount: 23,
    retiredDefaultQueueRegistered: false,
  });

  modules.queues.ALL_WEBHOOK_QUEUE_NAMES.push('moderation-default');
  assert.throws(() => attestWebhookProducerRuntime(modules), /not retirement-safe/u);
  modules.queues.ALL_WEBHOOK_QUEUE_NAMES.pop();
  modules.topology.RUNTIME_SERVICE_PROFILES['api-admin'].capabilities.enqueueEnabled = true;
  assert.throws(() => attestWebhookProducerRuntime(modules), /not retirement-safe/u);
});

test('active shard inspection rejects an omitted queue count', async () => {
  await assert.rejects(
    inspectDefaultWebhookShards(
      (name) => new FakeQueue({}, { name, omitCount: 'waiting-children' }),
    ),
    /missing_waiting-children_count/u,
  );
});

test('pauses only the exact legacy queue and obliterates without force after an unchanged snapshot', async () => {
  const queue = new FakeQueue({
    prioritized: [validJob('event-apply-1')],
    failed: [validJob('event-apply-2')],
  });
  const expected = await inspectLegacyDefaultWebhookQueue(queue);
  const result = await retireLegacyDefaultWebhookQueue(queue, expected, remoteDeadline());

  assert.equal(queue.name, LEGACY_DEFAULT_WEBHOOK_QUEUE);
  assert.equal(queue.pauseCalls, 1);
  assert.deepEqual(queue.obliterateCalls, [{ force: false, count: OBLITERATE_BATCH_SIZE }]);
  assert.equal(result.result, 'obliterated');
  assert.equal(result.before.totalJobs, 2);
  assert.equal(result.after.totalJobs, 0);
  assert.doesNotMatch(JSON.stringify(result), /event-apply/u);
});

test('blocks workers and a queue mutation raced across the pause boundary', async () => {
  const withWorker = new FakeQueue(
    { prioritized: [validJob('event-worker-1')] },
    { workerCount: 1 },
  );
  const workerSnapshot = await inspectLegacyDefaultWebhookQueue(withWorker);
  await assert.rejects(
    retireLegacyDefaultWebhookQueue(withWorker, workerSnapshot, remoteDeadline()),
    /live worker/u,
  );

  const raced = new FakeQueue(
    { prioritized: [validJob('event-race-1')] },
    {
      onPause: (queue) => queue.records.prioritized.push(validJob('event-race-2')),
    },
  );
  const expected = await inspectLegacyDefaultWebhookQueue(raced);
  await assert.rejects(
    retireLegacyDefaultWebhookQueue(raced, expected, remoteDeadline()),
    (error) =>
      error instanceof LegacyDefaultQueuePreconditionError &&
      error.code === 'legacy_queue_snapshot_changed',
  );
  assert.equal(raced.obliterateCalls.length, 0);
  assert.equal(raced.pausedState, true);
});

test('database audit is primary-key bounded and allows only terminal or absent rows', async () => {
  const queue = new FakeQueue({
    prioritized: [validJob('event-db-0001'), validJob('event-db-0002')],
    failed: [validJob('event-db-0003')],
  });
  const snapshot = await inspectLegacyDefaultWebhookQueue(queue);
  const snapshotPath = writePrivateSnapshot(snapshot);
  const sql = buildLegacyDefaultWebhookDbAuditSql(snapshotPath);

  assert.match(sql, /webhook_events_pkey/u);
  assert.match(sql, /requested\(id\) AS MATERIALIZED/u);
  assert.match(
    sql,
    /LEFT JOIN public\.webhook_events AS webhook_events ON webhook_events\.id = requested\.id/u,
  );
  assert.match(sql, /status = 'RECEIVED'/u);
  assert.match(sql, /status = 'QUEUED'/u);
  assert.match(sql, /status = 'FAILED'/u);
  assert.match(sql, /WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED/u);
  assert.doesNotMatch(sql, /raw_payload|normalized_payload|source_ip|chat_id|user_id/u);

  const normalized = normalizeLegacyDefaultWebhookDbAuditSummary(allowedDbSummary(3), 3);
  assert.deepEqual(normalized, {
    schemaVersion: 1,
    audit: 'legacy_default_webhook_jobs',
    requestedCount: 3,
    absentCount: 1,
    processedCount: 1,
    duplicateCount: 1,
    receivedCount: 0,
    queuedCount: 0,
    failedCount: 0,
    quarantinedCount: 0,
    retryableFailedCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(normalized), /event-db/u);
});

test('database audit blocks every live, failed, and quarantined lifecycle state', () => {
  for (const field of [
    'received_count',
    'queued_count',
    'failed_count',
    'quarantined_count',
    'retryable_failed_count',
  ]) {
    const summary = allowedDbSummary(1);
    summary.absent_count = 0;
    summary.processed_count = 0;
    if (field === 'quarantined_count' || field === 'retryable_failed_count') {
      summary.failed_count = 1;
      summary[field] = 1;
    } else {
      summary[field] = 1;
    }
    assert.throws(
      () => normalizeLegacyDefaultWebhookDbAuditSummary(summary, 1),
      LegacyDefaultWebhookDbAuditBlockedError,
      field,
    );
  }
  const inconsistentSubset = allowedDbSummary(1);
  inconsistentSubset.absent_count = 0;
  inconsistentSubset.processed_count = 1;
  inconsistentSubset.retryable_failed_count = 1;
  assert.throws(
    () => normalizeLegacyDefaultWebhookDbAuditSummary(inconsistentSubset, 1),
    /counts are inconsistent/u,
  );

  const missingCount = allowedDbSummary(1);
  delete missingCount.queued_count;
  assert.throws(
    () => normalizeLegacyDefaultWebhookDbAuditSummary(missingCount, 1),
    /omitted queued_count/u,
  );
});

test('host wrapper keeps apply behind release, database, pause, and postcheck guards', () => {
  const wrapper = readFileSync(
    resolve(root, 'infra/scripts/vps-retire-legacy-default-webhook-queue.sh'),
    'utf8',
  );
  const connect = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
  const postgresAudit = readFileSync(resolve(root, 'infra/scripts/vps-postgres-audit.sh'), 'utf8');

  assert.match(wrapper, /acquire_deploy_lock/u);
  assert.match(wrapper, /validate-current/u);
  assert.doesNotMatch(
    wrapper,
    /find[^\n]*current\.invalid/u,
    'release-manifest validate-current owns exact unresolved-journal classification',
  );
  assert.match(wrapper, /git merge-base --is-ancestor "\$SHARDING_FLOOR_SHA"/u);
  assert.match(wrapper, /git grep[\s\S]*moderation-default/u);
  assert.match(wrapper, /run_database_crosscheck[\s\S]*apply_retirement/u);
  assert.match(
    wrapper,
    /create_private_snapshot[\s\S]*verify_queue_fence_released "\$LEGACY_QUEUE_PAUSED_COUNT"/u,
  );
  assert.match(wrapper, /verify_queue_fence_released 0/u);
  assert.match(wrapper, /verify_webhook_producer_topology/u);
  assert.match(wrapper, /runtime-proof/u);
  assert.match(
    wrapper,
    /if \[\[ "\$ACTION" == "preview" \]\]; then[\s\S]*return 0[\s\S]*stop_enqueue_service/u,
  );
  assert.match(
    wrapper,
    /stop_enqueue_service\s+refresh_private_snapshot[\s\S]*run_database_crosscheck[\s\S]*apply_retirement/u,
  );
  assert.match(wrapper, /ENQUEUE_SERVICE_STOPPED[\s\S]*restore_enqueue_service/u);
  assert.match(wrapper, /stable_samples == 2/u);
  assert.match(wrapper, /acquire_deploy_lock\s+arm_cleanup_traps/u);
  assert.match(wrapper, /trap cleanup EXIT/u);
  assert.match(wrapper, /trap 'exit 129' HUP/u);
  assert.match(wrapper, /trap 'exit 130' INT/u);
  assert.match(wrapper, /trap 'exit 143' TERM/u);
  assert.match(wrapper, /REMOTE_APPLY_TIMEOUT_MARGIN_SEC=10/u);
  assert.match(wrapper, /COMMAND_TIMEOUT_SEC - REMOTE_APPLY_TIMEOUT_MARGIN_SEC/u);
  assert.match(wrapper, /MAXIM_LEGACY_DEFAULT_QUEUE_REMOTE_DEADLINE_MS/u);
  assert.match(
    wrapper,
    /wait_for_remote_apply_deadline[\s\S]*prove_remote_apply_settled[\s\S]*restore_enqueue_service/u,
  );
  assert.match(wrapper, /REMOTE_APPLY_AMBIGUOUS=0\s+printf 'legacy-default-retirement/u);
  const helper = readFileSync(queueHelperPath, 'utf8');
  assert.match(helper, /OBLITERATE_BATCH_SIZE = MAX_LEGACY_JOBS \+ 1/u);
  assert.match(
    helper,
    /armRemoteApplyWatchdog[\s\S]*watchdog\.assertBeforeMutation\(\);\s+await queue\.pause\(\)[\s\S]*watchdog\.assertBeforeMutation\(\);\s+await queue\.obliterate/u,
  );
  assert.match(wrapper, /node -e "\$CONTROL_SOURCE" apply <"\$PRIVATE_SNAPSHOT"/u);
  assert.match(wrapper, /inspect_active_shards[\s\S]*run_readiness_smokes/u);
  assert.match(
    wrapper,
    /MAXIM_LEGACY_DEFAULT_QUEUE_RETIRE_TIMEOUT_SEC must be between 30 and 120/u,
  );
  assert.match(postgresAudit, /MAXIM_INTERNAL_LEGACY_DEFAULT_WEBHOOK_AUDIT/u);
  assert.match(postgresAudit, /legacy-default-webhook-jobs/u);
  assert.match(connect, /moderation-default-retire-legacy-queue/u);
  assert.doesNotMatch(wrapper, /docker compose[\s\S]*(stop|restart) (postgres|redis)/u);
});
