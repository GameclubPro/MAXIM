'use strict';

const LEGACY_VK_PUBLISH_QUEUE = 'vk-parsing-publish';
const OBLITERATE_BATCH_SIZE = 1_000;
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

class QueueCleanupPreconditionError extends Error {
  constructor(code, snapshot) {
    super(code);
    this.name = 'QueueCleanupPreconditionError';
    this.code = code;
    this.snapshot = snapshot;
  }
}

function validateQueue(queue) {
  const methods = [
    'close',
    'getJobCounts',
    'getVersion',
    'getWorkersCount',
    'isPaused',
    'obliterate',
    'pause',
    'waitUntilReady',
  ];
  if (
    queue?.name !== LEGACY_VK_PUBLISH_QUEUE ||
    methods.some((method) => typeof queue?.[method] !== 'function')
  ) {
    throw new Error('Legacy VK publish queue handle is invalid.');
  }
}

function readCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Legacy VK publish queue returned an invalid ${name} count.`);
  }
  return value;
}

async function inspectLegacyVkPublishQueue(queue) {
  validateQueue(queue);
  await queue.waitUntilReady();
  const [libraryVersion, paused, workerCountRaw, rawCounts] = await Promise.all([
    queue.getVersion(),
    queue.isPaused(),
    queue.getWorkersCount(),
    queue.getJobCounts(...QUEUE_STATES),
  ]);
  if (libraryVersion !== null && typeof libraryVersion !== 'string') {
    throw new Error('Legacy VK publish queue returned an invalid metadata state.');
  }
  if (typeof paused !== 'boolean' || !rawCounts || typeof rawCounts !== 'object') {
    throw new Error('Legacy VK publish queue returned an invalid state snapshot.');
  }

  const counts = Object.fromEntries(
    QUEUE_STATES.map((state) => [state, readCount(rawCounts[state] ?? 0, state)]),
  );
  const workerCount = readCount(workerCountRaw, 'worker');
  const totalJobs = Object.values(counts).reduce((total, count) => {
    const next = total + count;
    if (!Number.isSafeInteger(next)) {
      throw new Error('Legacy VK publish queue returned an invalid total count.');
    }
    return next;
  }, 0);
  const present = libraryVersion !== null || paused || workerCount > 0 || totalJobs > 0;
  return Object.freeze({
    present,
    paused,
    workerCount,
    totalJobs,
    counts: Object.freeze(counts),
  });
}

async function cleanupLegacyVkPublishQueue(queue, { apply = false } = {}) {
  validateQueue(queue);
  const before = await inspectLegacyVkPublishQueue(queue);
  if (!apply) {
    return Object.freeze({
      version: 1,
      mode: 'dry-run',
      queue: LEGACY_VK_PUBLISH_QUEUE,
      result: before.present ? 'would_obliterate' : 'already_absent',
      before,
    });
  }
  if (!before.present) {
    return Object.freeze({
      version: 1,
      mode: 'apply',
      queue: LEGACY_VK_PUBLISH_QUEUE,
      result: 'already_absent',
      before,
      after: before,
    });
  }
  if (before.workerCount !== 0) {
    throw new QueueCleanupPreconditionError('workers_present_before_pause', before);
  }

  await queue.pause();
  const paused = await inspectLegacyVkPublishQueue(queue);
  if (!paused.paused) {
    throw new QueueCleanupPreconditionError('pause_not_confirmed', paused);
  }
  if (paused.workerCount !== 0) {
    throw new QueueCleanupPreconditionError('workers_present_after_pause', paused);
  }
  if (paused.counts.active !== 0) {
    throw new QueueCleanupPreconditionError('active_jobs_after_pause', paused);
  }

  await queue.obliterate({ force: false, count: OBLITERATE_BATCH_SIZE });
  const after = await inspectLegacyVkPublishQueue(queue);
  if (after.present || after.totalJobs !== 0 || after.workerCount !== 0) {
    throw new QueueCleanupPreconditionError('obliterate_not_confirmed', after);
  }
  return Object.freeze({
    version: 1,
    mode: 'apply',
    queue: LEGACY_VK_PUBLISH_QUEUE,
    result: 'obliterated',
    before,
    after,
  });
}

async function main() {
  const { Queue } = require('bullmq');
  const action = process.argv[2];
  if (action !== 'preview' && action !== 'apply') {
    throw new Error('Unknown legacy VK publish queue cleanup action.');
  }
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('Redis configuration is unavailable.');
  }
  const queue = new Queue(LEGACY_VK_PUBLISH_QUEUE, {
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
  try {
    const summary = await cleanupLegacyVkPublishQueue(queue, { apply: action === 'apply' });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await queue.close().catch(() => undefined);
  }
}

module.exports = {
  LEGACY_VK_PUBLISH_QUEUE,
  OBLITERATE_BATCH_SIZE,
  QUEUE_STATES,
  QueueCleanupPreconditionError,
  cleanupLegacyVkPublishQueue,
  inspectLegacyVkPublishQueue,
};

if (require.main === module || __filename === '[stdin]') {
  main().catch((error) => {
    if (error instanceof QueueCleanupPreconditionError) {
      process.stdout.write(
        `${JSON.stringify({
          version: 1,
          mode: 'apply',
          queue: LEGACY_VK_PUBLISH_QUEUE,
          result: 'blocked',
          code: error.code,
          state: error.snapshot,
        })}\n`,
      );
      process.exitCode = 3;
      return;
    }
    process.stderr.write('Legacy VK publish queue cleanup failed closed.\n');
    process.exitCode = 1;
  });
}
