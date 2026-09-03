'use strict';

const { lstatSync, readFileSync } = require('node:fs');

const LEGACY_DEFAULT_WEBHOOK_QUEUE = 'moderation-default';
const DEFAULT_WEBHOOK_SHARD_COUNT = 16;
const MAX_LEGACY_JOBS = 1_000;
const OBLITERATE_BATCH_SIZE = MAX_LEGACY_JOBS + 1;
const MAX_PRIVATE_SNAPSHOT_BYTES = 256 * 1024;
const REMOTE_APPLY_DEADLINE_MIN_FUTURE_MS = 1_000;
const REMOTE_APPLY_DEADLINE_MAX_FUTURE_MS = 120_000;
const REMOTE_APPLY_WATCHDOG_EXIT_CODE = 124;
const SETTLEMENT_STABILITY_MS = 1_000;
const LEGACY_JOB_MIN_TIMESTAMP_MS = Date.parse('2026-03-30T00:00:00.000Z');
const LEGACY_JOB_MAX_TIMESTAMP_MS = Date.parse('2026-03-31T00:00:00.000Z');
const LEGACY_WEBHOOK_PRIORITIES = new Set([5]);
const LEGACY_BULLMQ_VERSIONS = new Set(['bullmq:5.70.1', 'bullmq:5.77.6']);
const PRODUCTION_API_SERVICES = Object.freeze([
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
]);
const EXPECTED_ACTIVE_WEBHOOK_QUEUES = Object.freeze([
  'moderation-critical',
  ...Array.from({ length: 4 }, (_, index) => `moderation-join-${index}`),
  ...Array.from(
    { length: DEFAULT_WEBHOOK_SHARD_COUNT },
    (_, index) => `moderation-default-${index}`,
  ),
  'moderation-background',
]);
const EXPECTED_REGISTERED_WEBHOOK_QUEUES = Object.freeze([
  'moderation',
  ...EXPECTED_ACTIVE_WEBHOOK_QUEUES,
]);
const QUEUE_STATES = Object.freeze([
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'paused',
  'prioritized',
  'waiting-children',
]);
const RETIRABLE_STATES = Object.freeze(['prioritized', 'failed']);
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;

class LegacyDefaultQueuePreconditionError extends Error {
  constructor(code, summary = null) {
    super(code);
    this.name = 'LegacyDefaultQueuePreconditionError';
    this.code = code;
    this.summary = summary;
  }
}

const SAFE_PRECONDITION_CODES = new Set([
  ...QUEUE_STATES.flatMap((state) => [`invalid_${state}_count`, `missing_${state}_count`]),
  'active_jobs_after_pause',
  'active_jobs_before_pause',
  'duplicate_legacy_job_id',
  'invalid_job_scheduler_count',
  'invalid_worker_count',
  'legacy_job_cap_exceeded',
  'legacy_job_count_mismatch',
  'legacy_job_dependencies_present',
  'legacy_job_dependency_counts_invalid',
  'legacy_job_dependency_probe_missing',
  'legacy_job_shape_invalid',
  'legacy_job_snapshot_incomplete',
  'legacy_queue_settlement_unstable',
  'legacy_queue_snapshot_changed',
  'legacy_queue_version_missing',
  'obliterate_not_confirmed',
  'pause_not_confirmed',
  'queue_metadata_invalid',
  'remote_apply_deadline_invalid',
  'remote_apply_deadline_reached',
  'unexpected_legacy_job_scheduler',
  'unexpected_legacy_job_state',
  'workers_present_after_pause',
  'workers_present_before_pause',
]);

function formatFailureDiagnostic(error) {
  const suffix =
    error instanceof LegacyDefaultQueuePreconditionError && SAFE_PRECONDITION_CODES.has(error.code)
      ? ` code=${error.code}`
      : '';
  return `Legacy default webhook queue retirement failed closed.${suffix}\n`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function attestWebhookProducerRuntime({ appRole, queues, topology }) {
  if (
    !isRecord(appRole) ||
    !isRecord(queues) ||
    !isRecord(topology) ||
    typeof appRole.roleRunsEnqueue !== 'function' ||
    !isRecord(topology.RUNTIME_SERVICE_PROFILES)
  ) {
    throw new Error('Webhook producer runtime exports are invalid.');
  }
  const expectedRuntimeServices = ['api-all', ...PRODUCTION_API_SERVICES];
  const profileNames = Object.keys(topology.RUNTIME_SERVICE_PROFILES);
  const productionProducers = PRODUCTION_API_SERVICES.filter(
    (service) => topology.RUNTIME_SERVICE_PROFILES[service]?.capabilities?.enqueueEnabled === true,
  );
  const enqueueRoles = appRole.APP_ROLES?.filter((role) => appRole.roleRunsEnqueue(role));
  if (
    !sameStrings(topology.RUNTIME_SERVICE_NAMES, expectedRuntimeServices) ||
    !sameStrings(profileNames, expectedRuntimeServices) ||
    !sameStrings(productionProducers, ['api-enqueue']) ||
    !sameStrings(appRole.APP_ROLES, [
      'all',
      'ingress',
      'admin',
      'enqueue',
      'moderation',
      'action',
      'publisher',
    ]) ||
    !sameStrings(enqueueRoles, ['all', 'enqueue']) ||
    !sameStrings(queues.ACTIVE_WEBHOOK_QUEUE_NAMES, EXPECTED_ACTIVE_WEBHOOK_QUEUES) ||
    !sameStrings(queues.ALL_WEBHOOK_QUEUE_NAMES, EXPECTED_REGISTERED_WEBHOOK_QUEUES) ||
    queues.ALL_WEBHOOK_QUEUE_NAMES.includes(LEGACY_DEFAULT_WEBHOOK_QUEUE)
  ) {
    throw new Error('Webhook producer runtime topology is not retirement-safe.');
  }
  return Object.freeze({
    version: 1,
    productionServiceCount: PRODUCTION_API_SERVICES.length,
    productionEnqueueProducerCount: productionProducers.length,
    enqueueRoleCount: enqueueRoles.length,
    activeWebhookQueueCount: EXPECTED_ACTIVE_WEBHOOK_QUEUES.length,
    registeredWebhookQueueCount: EXPECTED_REGISTERED_WEBHOOK_QUEUES.length,
    retiredDefaultQueueRegistered: false,
  });
}

function readCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LegacyDefaultQueuePreconditionError(`invalid_${field}_count`);
  }
  return value;
}

function readOwnCount(record, field) {
  if (!isRecord(record) || !Object.hasOwn(record, field)) {
    throw new LegacyDefaultQueuePreconditionError(`missing_${field}_count`);
  }
  return readCount(record[field], field);
}

function validateRemoteApplyDeadline(value, nowMs = Date.now()) {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{12}$/u.test(value) ||
    !Number.isSafeInteger(nowMs)
  ) {
    throw new LegacyDefaultQueuePreconditionError('remote_apply_deadline_invalid');
  }
  const deadlineAtMs = Number(value);
  const remainingMs = deadlineAtMs - nowMs;
  if (
    !Number.isSafeInteger(deadlineAtMs) ||
    remainingMs < REMOTE_APPLY_DEADLINE_MIN_FUTURE_MS ||
    remainingMs > REMOTE_APPLY_DEADLINE_MAX_FUTURE_MS
  ) {
    throw new LegacyDefaultQueuePreconditionError('remote_apply_deadline_invalid');
  }
  return deadlineAtMs;
}

function armRemoteApplyWatchdog(
  deadlineAtMs,
  {
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    terminate = (exitCode) => process.exit(exitCode),
    writeError = (message) => process.stderr.write(message),
  } = {},
) {
  const validatedDeadlineAtMs = validateRemoteApplyDeadline(String(deadlineAtMs), now());
  const timer = setTimer(() => {
    writeError('Legacy default webhook queue remote apply deadline exceeded.\n');
    terminate(REMOTE_APPLY_WATCHDOG_EXIT_CODE);
  }, validatedDeadlineAtMs - now());
  return Object.freeze({
    assertBeforeMutation() {
      if (now() >= validatedDeadlineAtMs) {
        throw new LegacyDefaultQueuePreconditionError('remote_apply_deadline_reached');
      }
    },
    clear() {
      clearTimer(timer);
    },
  });
}

function hasLegacyJobLinkage(job) {
  const opts = isRecord(job?.opts) ? job.opts : {};
  return (
    job?.parentKey != null ||
    job?.parent != null ||
    job?.repeatJobKey != null ||
    job?.nextRepeatableJobId != null ||
    job?.nextRepeatableJobKey != null ||
    opts.parent != null ||
    opts.repeat != null ||
    opts.repeatJobKey != null ||
    opts.prevMillis != null ||
    opts.failParentOnFailure != null ||
    opts.removeDependencyOnFailure != null ||
    opts.ignoreDependencyOnFailure != null ||
    opts.continueParentOnFailure != null
  );
}

async function assertNoLegacyJobDependencies(job) {
  if (typeof job?.getDependenciesCount !== 'function') {
    throw new LegacyDefaultQueuePreconditionError('legacy_job_dependency_probe_missing');
  }
  const counts = await job.getDependenciesCount({
    processed: true,
    unprocessed: true,
    ignored: true,
    failed: true,
  });
  const fields = ['processed', 'unprocessed', 'ignored', 'failed'];
  if (
    !isRecord(counts) ||
    Object.keys(counts).length !== fields.length ||
    fields.some(
      (field) =>
        !Object.hasOwn(counts, field) || !Number.isSafeInteger(counts[field]) || counts[field] < 0,
    )
  ) {
    throw new LegacyDefaultQueuePreconditionError('legacy_job_dependency_counts_invalid');
  }
  if (fields.some((field) => counts[field] !== 0)) {
    throw new LegacyDefaultQueuePreconditionError('legacy_job_dependencies_present');
  }
}

function validateQueue(queue, expectedName = LEGACY_DEFAULT_WEBHOOK_QUEUE) {
  const methods = [
    'close',
    'getJobCounts',
    'getJobs',
    'getJobSchedulersCount',
    'getVersion',
    'getWorkersCount',
    'isPaused',
    'obliterate',
    'pause',
    'waitUntilReady',
  ];
  if (
    queue?.name !== expectedName ||
    methods.some((method) => typeof queue?.[method] !== 'function')
  ) {
    throw new Error('Legacy default webhook queue handle is invalid.');
  }
}

function validateLegacyJob(job, state) {
  const id = job?.id;
  const timestamp = job?.timestamp;
  const priority = job?.opts?.priority;
  const data = job?.data;
  if (
    !JOB_ID_PATTERN.test(id ?? '') ||
    job?.name !== 'process-webhook-event' ||
    !isRecord(data) ||
    Object.keys(data).length !== 1 ||
    data.webhookEventId !== id ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < LEGACY_JOB_MIN_TIMESTAMP_MS ||
    timestamp >= LEGACY_JOB_MAX_TIMESTAMP_MS ||
    !Number.isSafeInteger(priority) ||
    !LEGACY_WEBHOOK_PRIORITIES.has(priority) ||
    hasLegacyJobLinkage(job) ||
    !RETIRABLE_STATES.includes(state)
  ) {
    throw new LegacyDefaultQueuePreconditionError('legacy_job_shape_invalid');
  }
  return Object.freeze({ id, state, timestamp, priority });
}

function summarizeSnapshot(snapshot) {
  return Object.freeze({
    version: 1,
    queue: LEGACY_DEFAULT_WEBHOOK_QUEUE,
    present: snapshot.summary.present,
    paused: snapshot.summary.paused,
    workerCount: snapshot.summary.workerCount,
    jobSchedulerCount: snapshot.summary.jobSchedulerCount,
    totalJobs: snapshot.summary.totalJobs,
    counts: snapshot.summary.counts,
    priorityCounts: snapshot.summary.priorityCounts,
    oldestJobAt: snapshot.summary.oldestJobAt,
    newestJobAt: snapshot.summary.newestJobAt,
  });
}

function buildSnapshotSummary({
  libraryVersion,
  paused,
  workerCount,
  jobSchedulerCount,
  counts,
  records,
}) {
  const priorityCounts = {};
  for (const record of records) {
    const key = String(record.priority);
    priorityCounts[key] = (priorityCounts[key] ?? 0) + 1;
  }
  const timestamps = records.map((record) => record.timestamp);
  const totalJobs = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    present:
      libraryVersion !== null ||
      paused ||
      workerCount > 0 ||
      jobSchedulerCount > 0 ||
      totalJobs > 0,
    paused,
    workerCount,
    jobSchedulerCount,
    totalJobs,
    counts: Object.freeze({ ...counts }),
    priorityCounts: Object.freeze(priorityCounts),
    oldestJobAt: timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null,
    newestJobAt: timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null,
  });
}

async function inspectLegacyDefaultWebhookQueue(queue) {
  validateQueue(queue);
  await queue.waitUntilReady();
  const [libraryVersion, paused, workerCountRaw, jobSchedulerCountRaw, rawCounts] =
    await Promise.all([
      queue.getVersion(),
      queue.isPaused(),
      queue.getWorkersCount(),
      queue.getJobSchedulersCount(),
      queue.getJobCounts(...QUEUE_STATES),
    ]);
  if (
    (libraryVersion !== null && !LEGACY_BULLMQ_VERSIONS.has(libraryVersion)) ||
    typeof paused !== 'boolean' ||
    !isRecord(rawCounts)
  ) {
    throw new LegacyDefaultQueuePreconditionError('queue_metadata_invalid');
  }
  const workerCount = readCount(workerCountRaw, 'worker');
  const jobSchedulerCount = readCount(jobSchedulerCountRaw, 'job_scheduler');
  if (jobSchedulerCount !== 0) {
    throw new LegacyDefaultQueuePreconditionError('unexpected_legacy_job_scheduler');
  }
  const counts = Object.fromEntries(
    QUEUE_STATES.map((state) => [state, readOwnCount(rawCounts, state)]),
  );
  const totalJobs = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(totalJobs) || totalJobs > MAX_LEGACY_JOBS) {
    throw new LegacyDefaultQueuePreconditionError('legacy_job_cap_exceeded');
  }
  if (QUEUE_STATES.some((state) => !RETIRABLE_STATES.includes(state) && counts[state] !== 0)) {
    throw new LegacyDefaultQueuePreconditionError('unexpected_legacy_job_state');
  }

  const records = [];
  for (const state of RETIRABLE_STATES) {
    const jobs =
      counts[state] === 0 ? [] : await queue.getJobs([state], 0, counts[state] - 1, true);
    if (!Array.isArray(jobs) || jobs.length !== counts[state]) {
      throw new LegacyDefaultQueuePreconditionError('legacy_job_snapshot_incomplete');
    }
    for (const job of jobs) {
      const record = validateLegacyJob(job, state);
      await assertNoLegacyJobDependencies(job);
      records.push(record);
    }
  }
  records.sort(
    (left, right) =>
      left.state.localeCompare(right.state) ||
      left.timestamp - right.timestamp ||
      left.id.localeCompare(right.id),
  );
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new LegacyDefaultQueuePreconditionError('duplicate_legacy_job_id');
  }
  const summary = buildSnapshotSummary({
    libraryVersion,
    paused,
    workerCount,
    jobSchedulerCount,
    counts,
    records,
  });
  if (summary.present && libraryVersion === null) {
    throw new LegacyDefaultQueuePreconditionError('legacy_queue_version_missing', summary);
  }
  if (summary.totalJobs !== records.length) {
    throw new LegacyDefaultQueuePreconditionError('legacy_job_count_mismatch', summary);
  }
  return Object.freeze({
    version: 1,
    queue: LEGACY_DEFAULT_WEBHOOK_QUEUE,
    libraryVersion,
    records: Object.freeze(records),
    summary,
  });
}

function validatePrivateSnapshot(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.queue !== LEGACY_DEFAULT_WEBHOOK_QUEUE ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_LEGACY_JOBS ||
    !isRecord(value.summary) ||
    (value.libraryVersion !== null && !LEGACY_BULLMQ_VERSIONS.has(value.libraryVersion)) ||
    typeof value.summary.paused !== 'boolean'
  ) {
    throw new Error('Private legacy queue snapshot is invalid.');
  }
  const records = value.records.map((record) => {
    if (
      !isRecord(record) ||
      !JOB_ID_PATTERN.test(record.id ?? '') ||
      !RETIRABLE_STATES.includes(record.state) ||
      !Number.isSafeInteger(record.timestamp) ||
      record.timestamp < LEGACY_JOB_MIN_TIMESTAMP_MS ||
      record.timestamp >= LEGACY_JOB_MAX_TIMESTAMP_MS ||
      !Number.isSafeInteger(record.priority) ||
      !LEGACY_WEBHOOK_PRIORITIES.has(record.priority)
    ) {
      throw new Error('Private legacy queue record is invalid.');
    }
    return Object.freeze({
      id: record.id,
      state: record.state,
      timestamp: record.timestamp,
      priority: record.priority,
    });
  });
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error('Private legacy queue snapshot contains duplicate jobs.');
  }
  const counts = Object.fromEntries(
    QUEUE_STATES.map((state) => [state, readOwnCount(value.summary.counts, state)]),
  );
  if (
    Object.values(counts).reduce((sum, count) => sum + count, 0) !== records.length ||
    counts.prioritized !== records.filter((record) => record.state === 'prioritized').length ||
    counts.failed !== records.filter((record) => record.state === 'failed').length ||
    QUEUE_STATES.some((state) => !RETIRABLE_STATES.includes(state) && counts[state] !== 0)
  ) {
    throw new Error('Private legacy queue snapshot counts are inconsistent.');
  }
  const workerCount = readCount(value.summary.workerCount, 'worker');
  if (workerCount !== 0) {
    throw new Error('Private legacy queue snapshot has a live worker.');
  }
  const jobSchedulerCount = readCount(value.summary.jobSchedulerCount, 'job_scheduler');
  if (jobSchedulerCount !== 0) {
    throw new Error('Private legacy queue snapshot has a job scheduler.');
  }
  const summary = buildSnapshotSummary({
    libraryVersion: value.libraryVersion,
    paused: value.summary.paused,
    workerCount,
    jobSchedulerCount,
    counts,
    records,
  });
  if (summary.present && value.libraryVersion === null) {
    throw new Error('Private legacy queue snapshot has no compatible BullMQ version.');
  }
  return Object.freeze({
    version: 1,
    queue: LEGACY_DEFAULT_WEBHOOK_QUEUE,
    libraryVersion: value.libraryVersion,
    records: Object.freeze(records),
    summary,
  });
}

function snapshotIdentity(snapshot) {
  return JSON.stringify({
    libraryVersion: snapshot.libraryVersion,
    jobSchedulerCount: snapshot.summary.jobSchedulerCount,
    counts: snapshot.summary.counts,
    records: snapshot.records,
  });
}

function assertSnapshotUnchanged(expected, actual) {
  if (snapshotIdentity(expected) !== snapshotIdentity(actual)) {
    throw new LegacyDefaultQueuePreconditionError(
      'legacy_queue_snapshot_changed',
      summarizeSnapshot(actual),
    );
  }
}

async function retireLegacyDefaultWebhookQueue(
  queue,
  expectedSnapshot,
  deadlineAtMs,
  watchdogOptions,
) {
  validateQueue(queue);
  const validatedDeadlineAtMs = validateRemoteApplyDeadline(String(deadlineAtMs));
  const expected = validatePrivateSnapshot(expectedSnapshot);
  const before = await inspectLegacyDefaultWebhookQueue(queue);
  assertSnapshotUnchanged(expected, before);
  if (!before.summary.present && before.summary.totalJobs === 0) {
    return Object.freeze({
      version: 1,
      mode: 'apply',
      result: 'already_absent',
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(before),
    });
  }
  if (before.summary.workerCount !== 0) {
    throw new LegacyDefaultQueuePreconditionError(
      'workers_present_before_pause',
      summarizeSnapshot(before),
    );
  }
  if (before.summary.counts.active !== 0) {
    throw new LegacyDefaultQueuePreconditionError(
      'active_jobs_before_pause',
      summarizeSnapshot(before),
    );
  }

  // FLAG: The referenced watchdog is armed immediately before the first mutation. Its hard exit
  // bounds a detached docker-exec process; the host waits past this deadline before recovery.
  const watchdog = armRemoteApplyWatchdog(validatedDeadlineAtMs, watchdogOptions);
  try {
    watchdog.assertBeforeMutation();
    await queue.pause();
    watchdog.assertBeforeMutation();
    const paused = await inspectLegacyDefaultWebhookQueue(queue);
    watchdog.assertBeforeMutation();
    assertSnapshotUnchanged(expected, paused);
    if (!paused.summary.paused) {
      throw new LegacyDefaultQueuePreconditionError(
        'pause_not_confirmed',
        summarizeSnapshot(paused),
      );
    }
    if (paused.summary.workerCount !== 0) {
      throw new LegacyDefaultQueuePreconditionError(
        'workers_present_after_pause',
        summarizeSnapshot(paused),
      );
    }
    if (paused.summary.counts.active !== 0) {
      throw new LegacyDefaultQueuePreconditionError(
        'active_jobs_after_pause',
        summarizeSnapshot(paused),
      );
    }

    watchdog.assertBeforeMutation();
    await queue.obliterate({ force: false, count: OBLITERATE_BATCH_SIZE });
    watchdog.assertBeforeMutation();
    const after = await inspectLegacyDefaultWebhookQueue(queue);
    watchdog.assertBeforeMutation();
    if (after.summary.present || after.summary.totalJobs !== 0 || after.summary.workerCount !== 0) {
      throw new LegacyDefaultQueuePreconditionError(
        'obliterate_not_confirmed',
        summarizeSnapshot(after),
      );
    }
    return Object.freeze({
      version: 1,
      mode: 'apply',
      result: 'obliterated',
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
    });
  } finally {
    watchdog.clear();
  }
}

function exactSnapshotIdentity(snapshot) {
  return JSON.stringify({
    libraryVersion: snapshot.libraryVersion,
    records: snapshot.records,
    summary: snapshot.summary,
  });
}

async function inspectLegacyDefaultWebhookQueueSettlement(queue, wait = setTimeout) {
  const first = await inspectLegacyDefaultWebhookQueue(queue);
  await new Promise((resolve) => wait(resolve, SETTLEMENT_STABILITY_MS));
  const second = await inspectLegacyDefaultWebhookQueue(queue);
  if (exactSnapshotIdentity(first) !== exactSnapshotIdentity(second)) {
    throw new LegacyDefaultQueuePreconditionError(
      'legacy_queue_settlement_unstable',
      summarizeSnapshot(second),
    );
  }
  return Object.freeze({
    version: 1,
    mode: 'settlement',
    settled: true,
    queue: summarizeSnapshot(second),
  });
}

async function inspectDefaultWebhookShards(createQueue) {
  if (typeof createQueue !== 'function') throw new Error('Webhook shard queue factory is invalid.');
  const queues = Array.from({ length: DEFAULT_WEBHOOK_SHARD_COUNT }, (_, index) =>
    createQueue(`moderation-default-${index}`),
  );
  try {
    const rows = await Promise.all(
      queues.map(async (queue) => {
        await queue.waitUntilReady();
        const [paused, counts] = await Promise.all([
          queue.isPaused(),
          queue.getJobCounts(...QUEUE_STATES),
        ]);
        if (typeof paused !== 'boolean' || !isRecord(counts)) {
          throw new Error('Webhook shard queue returned invalid state.');
        }
        const totalJobs = QUEUE_STATES.reduce((sum, state) => sum + readOwnCount(counts, state), 0);
        if (!Number.isSafeInteger(totalJobs)) {
          throw new Error('Webhook shard queue returned an unsafe job total.');
        }
        return {
          paused,
          totalJobs,
        };
      }),
    );
    const totalJobs = rows.reduce((sum, row) => sum + row.totalJobs, 0);
    if (!Number.isSafeInteger(totalJobs)) {
      throw new Error('Webhook shard queues returned an unsafe aggregate job total.');
    }
    return Object.freeze({
      version: 1,
      queueCount: rows.length,
      pausedQueueCount: rows.filter((row) => row.paused).length,
      totalJobs,
    });
  } finally {
    await Promise.allSettled(queues.map((queue) => queue.close()));
  }
}

function readPrivateSnapshotFile(path) {
  const stats = lstatSync(path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size <= 0 ||
    stats.size > MAX_PRIVATE_SNAPSHOT_BYTES ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stats.uid !== process.getuid())
  ) {
    throw new Error('Private legacy queue snapshot file is unsafe.');
  }
  return validatePrivateSnapshot(JSON.parse(readFileSync(path, 'utf8')));
}

function readBoundedStdin() {
  const input = readFileSync(0);
  if (input.byteLength === 0 || input.byteLength > MAX_PRIVATE_SNAPSHOT_BYTES) {
    throw new Error('Private legacy queue snapshot input is invalid.');
  }
  return validatePrivateSnapshot(JSON.parse(input.toString('utf8')));
}

function createQueue(name, Queue, redisUrl) {
  const queue = new Queue(name, {
    skipMetasUpdate: true,
    connection: {
      url: redisUrl,
      commandTimeout: 5_000,
      connectTimeout: 2_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    },
  });
  queue.on('error', () => undefined);
  return queue;
}

async function runRemote(action) {
  if (action === 'runtime-proof') {
    const runtimeRoot = '/app/apps/api/dist/apps/api/src';
    return attestWebhookProducerRuntime({
      appRole: require(`${runtimeRoot}/runtime/app-role.js`),
      queues: require(`${runtimeRoot}/webhook/webhook-queues.js`),
      topology: require(`${runtimeRoot}/runtime/runtime-topology.js`),
    });
  }
  const { Queue } = require('bullmq');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('Redis configuration is unavailable.');
  if (action === 'shards') {
    return inspectDefaultWebhookShards((name) => createQueue(name, Queue, redisUrl));
  }
  const queue = createQueue(LEGACY_DEFAULT_WEBHOOK_QUEUE, Queue, redisUrl);
  try {
    if (action === 'snapshot') return inspectLegacyDefaultWebhookQueue(queue);
    if (action === 'settlement') return inspectLegacyDefaultWebhookQueueSettlement(queue);
    if (action === 'apply') {
      const deadlineAtMs = validateRemoteApplyDeadline(
        process.env.MAXIM_LEGACY_DEFAULT_QUEUE_REMOTE_DEADLINE_MS,
      );
      return retireLegacyDefaultWebhookQueue(queue, readBoundedStdin(), deadlineAtMs);
    }
    throw new Error('Unknown legacy default webhook queue action.');
  } finally {
    await queue.close().catch(() => undefined);
  }
}

async function main() {
  const offset = __filename === '[eval]' ? 1 : 2;
  const action = process.argv[offset];
  if (action === 'validate-snapshot') {
    readPrivateSnapshotFile(process.argv[offset + 1]);
    return;
  }
  if (action === 'summarize') {
    process.stdout.write(
      `${JSON.stringify(summarizeSnapshot(readPrivateSnapshotFile(process.argv[offset + 1])))}\n`,
    );
    return;
  }
  const result = await runRemote(action);
  // FLAG: Snapshot output is redirected only to an owner-private transient file by the wrapper.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  DEFAULT_WEBHOOK_SHARD_COUNT,
  JOB_ID_PATTERN,
  LEGACY_DEFAULT_WEBHOOK_QUEUE,
  LEGACY_BULLMQ_VERSIONS,
  LEGACY_JOB_MAX_TIMESTAMP_MS,
  LEGACY_JOB_MIN_TIMESTAMP_MS,
  LEGACY_WEBHOOK_PRIORITIES,
  MAX_LEGACY_JOBS,
  OBLITERATE_BATCH_SIZE,
  PRODUCTION_API_SERVICES,
  QUEUE_STATES,
  REMOTE_APPLY_DEADLINE_MAX_FUTURE_MS,
  REMOTE_APPLY_DEADLINE_MIN_FUTURE_MS,
  REMOTE_APPLY_WATCHDOG_EXIT_CODE,
  RETIRABLE_STATES,
  SETTLEMENT_STABILITY_MS,
  LegacyDefaultQueuePreconditionError,
  armRemoteApplyWatchdog,
  assertNoLegacyJobDependencies,
  attestWebhookProducerRuntime,
  formatFailureDiagnostic,
  assertSnapshotUnchanged,
  inspectDefaultWebhookShards,
  inspectLegacyDefaultWebhookQueue,
  inspectLegacyDefaultWebhookQueueSettlement,
  readPrivateSnapshotFile,
  retireLegacyDefaultWebhookQueue,
  summarizeSnapshot,
  validateLegacyJob,
  validatePrivateSnapshot,
  validateRemoteApplyDeadline,
};

if (require.main === module || __filename === '[eval]') {
  main().catch((error) => {
    process.stderr.write(formatFailureDiagnostic(error));
    process.exitCode = 1;
  });
}
