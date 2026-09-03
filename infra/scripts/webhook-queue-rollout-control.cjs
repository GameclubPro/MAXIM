'use strict';

const LEGACY_WEBHOOK_QUEUE = 'moderation';
const WEBHOOK_QUEUE_CRITICAL = 'moderation-critical';
const WEBHOOK_QUEUE_BACKGROUND = 'moderation-background';
const LEGACY_DEFAULT_WEBHOOK_QUEUE = 'moderation-default';
const JOIN_WEBHOOK_SHARD_COUNT = 4;
const DEFAULT_WEBHOOK_SHARD_COUNT = 16;
const POLL_INTERVAL_MS = 1_000;
const WEBHOOK_ROLLOUT_OWNER_KEY = 'maxim:webhook-rollout:pause-owner:v1';
const WEBHOOK_ROLLOUT_OWNER_TOKEN_PATTERN = /^rollout:[0-9a-f]{64}$/u;
const WEBHOOK_QUEUE_ACTIONS = new Set(['pause', 'wait-drained', 'resume', 'status']);

const COMPARE_AND_SET_OWNER_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

const COMPARE_AND_DELETE_OWNER_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
`;

// FLAG: Keep this host-side registry aligned with current API queues and append historical queue
// names only. A target or rollback image may still have work in a queue absent from current code.
const WEBHOOK_QUEUE_NAMES = Object.freeze([
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_CRITICAL,
  ...Array.from({ length: JOIN_WEBHOOK_SHARD_COUNT }, (_, index) => `moderation-join-${index}`),
  ...Array.from(
    { length: DEFAULT_WEBHOOK_SHARD_COUNT },
    (_, index) => `moderation-default-${index}`,
  ),
  WEBHOOK_QUEUE_BACKGROUND,
  LEGACY_DEFAULT_WEBHOOK_QUEUE,
]);

function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/u.test(value ?? '')) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function validateOwnerToken(ownerToken) {
  if (!WEBHOOK_ROLLOUT_OWNER_TOKEN_PATTERN.test(ownerToken ?? '')) {
    throw new Error('Webhook rollout owner token has an invalid format.');
  }
}

function validateQueueNames(queueNames) {
  if (
    queueNames.length === 0 ||
    new Set(queueNames).size !== queueNames.length ||
    queueNames.some(
      (name) =>
        !/^moderation(?:-(?:critical|background|default|join-\d+|default-\d+))?$/u.test(name),
    )
  ) {
    throw new Error('Webhook rollout queue topology is invalid.');
  }
}

function validateOwnershipStore(ownershipStore) {
  const requiredMethods = [
    'waitUntilReady',
    'getOwner',
    'acquire',
    'compareAndSet',
    'compareAndDelete',
    'close',
  ];
  if (
    !ownershipStore ||
    requiredMethods.some((method) => typeof ownershipStore[method] !== 'function')
  ) {
    throw new Error('Webhook rollout ownership store is invalid.');
  }
}

function parseRedisBoolean(value, operation) {
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  throw new Error(`Redis returned an invalid ${operation} result.`);
}

function createRedisOwnershipStore(redis, key = WEBHOOK_ROLLOUT_OWNER_KEY) {
  return {
    waitUntilReady: async () => {
      if (redis.status === 'wait') {
        await redis.connect();
      } else if (redis.status !== 'ready') {
        throw new Error('Webhook rollout ownership Redis is unavailable.');
      }
    },
    getOwner: async () => {
      const owner = await redis.get(key);
      if (owner !== null && typeof owner !== 'string') {
        throw new Error('Redis returned an invalid webhook rollout owner.');
      }
      return owner;
    },
    acquire: async (ownerToken) => {
      const result = await redis.set(key, ownerToken, 'NX');
      if (result === 'OK') return true;
      if (result === null) return false;
      throw new Error('Redis returned an invalid webhook rollout owner acquisition result.');
    },
    compareAndSet: async (expectedOwner, nextOwner) =>
      parseRedisBoolean(
        await redis.eval(COMPARE_AND_SET_OWNER_SCRIPT, 1, key, expectedOwner, nextOwner),
        'webhook rollout owner takeover',
      ),
    compareAndDelete: async (expectedOwner) =>
      parseRedisBoolean(
        await redis.eval(COMPARE_AND_DELETE_OWNER_SCRIPT, 1, key, expectedOwner),
        'webhook rollout owner release',
      ),
    close: async () => {
      if (redis.status !== 'ready') {
        redis.disconnect();
        return;
      }
      try {
        await redis.quit();
      } finally {
        if (redis.status !== 'end') redis.disconnect();
      }
    },
  };
}

async function readSummary(queues, includeLegacyDefaultState = false) {
  const results = await Promise.allSettled(
    queues.map(async ({ name, queue }) => {
      const [paused, active] = await Promise.all([queue.isPaused(), queue.getActiveCount()]);
      if (typeof paused !== 'boolean' || !Number.isSafeInteger(active) || active < 0) {
        throw new Error('Webhook queue returned an invalid rollout state.');
      }
      return { name, paused, active };
    }),
  );
  const failure = results.find(({ status }) => status === 'rejected');
  if (failure) throw failure.reason;
  const states = results.map((result) => result.value);
  const activeCount = states.reduce((total, { active }) => total + active, 0);
  if (!Number.isSafeInteger(activeCount)) {
    throw new Error('Webhook queue rollout active total is unsafe.');
  }
  const summary = {
    queueCount: states.length,
    pausedCount: states.filter(({ paused }) => paused).length,
    activeCount,
  };
  if (!includeLegacyDefaultState) return summary;
  const legacyDefault = states.find(({ name }) => name === LEGACY_DEFAULT_WEBHOOK_QUEUE);
  if (!legacyDefault) throw new Error('Legacy default webhook queue is missing from the registry.');
  return { ...summary, legacyDefaultPaused: legacyDefault.paused };
}

async function assertOwnership(ownershipStore, ownerToken) {
  if ((await ownershipStore.getOwner()) !== ownerToken) {
    throw new Error('Webhook rollout pause ownership was lost.');
  }
}

async function readOwnedSummary(queues, ownershipStore, ownerToken) {
  await assertOwnership(ownershipStore, ownerToken);
  try {
    return await readSummary(queues);
  } finally {
    await assertOwnership(ownershipStore, ownerToken);
  }
}

async function readStatusSummary(queues, ownershipStore) {
  const ownerBefore = await ownershipStore.getOwner();
  const summary = await readSummary(queues, true);
  const ownerAfter = await ownershipStore.getOwner();
  if (ownerBefore !== ownerAfter) {
    throw new Error('Webhook rollout pause ownership changed during status inspection.');
  }
  return { ...summary, ownerPresent: ownerAfter !== null };
}

async function claimPauseOwnership(
  ownershipStore,
  ownerToken,
  { adoptExistingPause, queuesAlreadyPaused },
) {
  const observedOwner = await ownershipStore.getOwner();
  if (observedOwner === ownerToken) return 'retained';

  if (observedOwner === null) {
    if (queuesAlreadyPaused && !adoptExistingPause) {
      throw new Error('Webhook queues already have an unowned global pause.');
    }
    if (await ownershipStore.acquire(ownerToken)) return 'acquired';
    await assertOwnership(ownershipStore, ownerToken);
    return 'retained';
  }

  if (!adoptExistingPause) {
    throw new Error('Webhook rollout pause is owned by another rollout.');
  }
  if (!(await ownershipStore.compareAndSet(observedOwner, ownerToken))) {
    throw new Error('Webhook rollout pause owner changed during explicit adoption.');
  }
  return 'adopted';
}

async function runQueueOperation(queues, operation, failureMessage) {
  const results = await Promise.allSettled(
    queues.map(({ queue }) => Promise.resolve().then(() => queue[operation]())),
  );
  if (results.some(({ status }) => status === 'rejected')) {
    throw new Error(failureMessage);
  }
}

async function waitForDrain(
  queues,
  timeoutMs,
  now = Date.now,
  wait = setTimeout,
  assertOwned = async () => undefined,
) {
  const deadlineAt = now() + timeoutMs;
  while (true) {
    await assertOwned();
    let summary;
    try {
      summary = await readSummary(queues);
    } finally {
      await assertOwned();
    }
    if (summary.pausedCount !== summary.queueCount) {
      throw new Error('Webhook queues lost the global rollout pause.');
    }
    if (summary.activeCount === 0) {
      return summary;
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      throw new Error('Active webhook jobs did not drain before the rollout deadline.');
    }
    await assertOwned();
    try {
      await new Promise((resolve) => wait(resolve, Math.min(POLL_INTERVAL_MS, remainingMs)));
    } finally {
      await assertOwned();
    }
  }
}

async function closeResources(queues, ownershipStore) {
  await Promise.allSettled([
    ...queues.map(({ queue }) => Promise.resolve().then(() => queue.close())),
    Promise.resolve().then(() => ownershipStore.close()),
  ]);
}

async function controlWebhookQueues(action, options) {
  validateOwnershipStore(options.ownershipStore);
  const queues = [];
  try {
    if (!WEBHOOK_QUEUE_ACTIONS.has(action)) {
      throw new Error('Unknown webhook rollout queue action.');
    }
    if (action !== 'status') validateOwnerToken(options.ownerToken);
    const queueNames = options.queueNames ?? WEBHOOK_QUEUE_NAMES;
    validateQueueNames(queueNames);
    if (typeof options.createQueue !== 'function') {
      throw new Error('Webhook rollout queue factory is invalid.');
    }
    if (
      action === 'wait-drained' &&
      (!Number.isSafeInteger(options.drainTimeoutMs) || options.drainTimeoutMs <= 0)
    ) {
      throw new Error('Webhook rollout drain timeout is invalid.');
    }

    for (const name of queueNames) {
      queues.push({ name, queue: options.createQueue(name) });
    }
    const readiness = await Promise.allSettled([
      options.ownershipStore.waitUntilReady(),
      ...queues.map(({ queue }) => queue.waitUntilReady()),
    ]);
    if (readiness.some(({ status }) => status === 'rejected')) {
      throw new Error('Webhook rollout queue control dependencies are unavailable.');
    }

    if (action === 'status') {
      return await readStatusSummary(queues, options.ownershipStore);
    }

    if (action === 'pause') {
      const preliminary = await readSummary(queues);
      const claim = await claimPauseOwnership(options.ownershipStore, options.ownerToken, {
        adoptExistingPause: options.adoptExistingPause === true,
        queuesAlreadyPaused: preliminary.pausedCount !== 0,
      });
      const before = await readOwnedSummary(queues, options.ownershipStore, options.ownerToken);
      if (preliminary.pausedCount === 0 && before.pausedCount !== 0 && claim === 'acquired') {
        throw new Error('Webhook queue pause state changed while ownership was acquired.');
      }
      await assertOwnership(options.ownershipStore, options.ownerToken);
      try {
        await runQueueOperation(queues, 'pause', 'Webhook queues could not be paused globally.');
      } finally {
        await assertOwnership(options.ownershipStore, options.ownerToken);
      }
      const summary = await readOwnedSummary(queues, options.ownershipStore, options.ownerToken);
      if (summary.pausedCount !== summary.queueCount) {
        throw new Error('Webhook queues could not be paused globally.');
      }
      return summary;
    }

    if (action === 'wait-drained') {
      return await waitForDrain(
        queues,
        options.drainTimeoutMs,
        options.now ?? Date.now,
        options.wait ?? setTimeout,
        () => assertOwnership(options.ownershipStore, options.ownerToken),
      );
    }

    const before = await readOwnedSummary(queues, options.ownershipStore, options.ownerToken);
    if (before.pausedCount !== before.queueCount || before.activeCount !== 0) {
      throw new Error('Webhook queues are not safely drained for rollout resume.');
    }
    await assertOwnership(options.ownershipStore, options.ownerToken);
    try {
      await runQueueOperation(queues, 'resume', 'Webhook queues could not be resumed globally.');
    } finally {
      await assertOwnership(options.ownershipStore, options.ownerToken);
    }
    const summary = await readOwnedSummary(queues, options.ownershipStore, options.ownerToken);
    if (summary.pausedCount !== 0) {
      throw new Error('Webhook queues could not be resumed globally.');
    }
    if (!(await options.ownershipStore.compareAndDelete(options.ownerToken))) {
      throw new Error('Webhook rollout pause ownership changed before release.');
    }
    return summary;
  } finally {
    await closeResources(queues, options.ownershipStore);
  }
}

function createBullQueue(name, Queue, redisUrl, connectionOptions) {
  const queue = new Queue(name, {
    skipMetasUpdate: true,
    connection: { url: redisUrl, ...connectionOptions },
  });
  queue.on('error', () => undefined);
  return queue;
}

async function main() {
  const { Queue } = require('bullmq');
  const Redis = require('ioredis');
  const action = process.argv[2];
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('Redis configuration is unavailable.');
  }
  const drainTimeoutMs =
    action === 'wait-drained'
      ? parsePositiveInteger(
          process.env.MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_MS,
          'MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_MS',
        )
      : 1;
  const connectionOptions = {
    commandTimeout: 5_000,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  };
  const redis = new Redis(redisUrl, { ...connectionOptions, lazyConnect: true });
  redis.on('error', () => undefined);
  const summary = await controlWebhookQueues(action, {
    adoptExistingPause: process.env.MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE === '1',
    drainTimeoutMs,
    ownerToken: process.env.MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN,
    ownershipStore: createRedisOwnershipStore(redis),
    createQueue: (name) => createBullQueue(name, Queue, redisUrl, connectionOptions),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

module.exports = {
  COMPARE_AND_DELETE_OWNER_SCRIPT,
  COMPARE_AND_SET_OWNER_SCRIPT,
  DEFAULT_WEBHOOK_SHARD_COUNT,
  JOIN_WEBHOOK_SHARD_COUNT,
  WEBHOOK_QUEUE_NAMES,
  WEBHOOK_ROLLOUT_OWNER_KEY,
  assertOwnership,
  claimPauseOwnership,
  controlWebhookQueues,
  createBullQueue,
  createRedisOwnershipStore,
  parsePositiveInteger,
  readStatusSummary,
  readSummary,
  validateOwnerToken,
  validateQueueNames,
  waitForDrain,
};

if (require.main === module || __filename === '[stdin]') {
  main().catch(() => {
    process.stderr.write('Webhook rollout queue control failed closed.\n');
    process.exitCode = 1;
  });
}
