import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const {
  COMPARE_AND_DELETE_OWNER_SCRIPT,
  COMPARE_AND_SET_OWNER_SCRIPT,
  WEBHOOK_QUEUE_NAMES,
  WEBHOOK_ROLLOUT_OWNER_KEY,
  controlWebhookQueues,
  createBullQueue,
  createRedisOwnershipStore,
  parsePositiveInteger,
  validateOwnerToken,
  validateQueueNames,
  waitForDrain,
} = require('./webhook-queue-rollout-control.cjs');

const OWNER_TOKEN = `rollout:${'a'.repeat(64)}`;
const OTHER_OWNER_TOKEN = `rollout:${'b'.repeat(64)}`;
const REPLACEMENT_OWNER_TOKEN = `rollout:${'c'.repeat(64)}`;

function makeQueues({ activeByName = {}, hooks = {}, paused = false, pausedByName = {} } = {}) {
  const states = new Map(
    WEBHOOK_QUEUE_NAMES.map((name) => [
      name,
      { active: activeByName[name] ?? 0, closeCalls: 0, paused: pausedByName[name] ?? paused },
    ]),
  );
  const queues = new Map(
    WEBHOOK_QUEUE_NAMES.map((name) => [
      name,
      {
        close: async () => {
          states.get(name).closeCalls += 1;
          await hooks.onClose?.(name, states.get(name));
        },
        getActiveCount: async () => {
          await hooks.onGetActiveCount?.(name, states.get(name));
          return states.get(name).active;
        },
        isPaused: async () => {
          await hooks.onIsPaused?.(name, states.get(name));
          return states.get(name).paused;
        },
        pause: async () => {
          await hooks.onPause?.(name, states.get(name));
          states.get(name).paused = true;
        },
        resume: async () => {
          await hooks.onResume?.(name, states.get(name));
          states.get(name).paused = false;
        },
        waitUntilReady: async () => hooks.onWaitUntilReady?.(name, states.get(name)),
      },
    ]),
  );
  return { createQueue: (name) => queues.get(name), queues, states };
}

function makeOwnershipStore(initialOwner = null, hooks = {}) {
  const backend = { owner: initialOwner };
  const calls = {
    acquire: 0,
    close: 0,
    compareAndDelete: 0,
    compareAndSet: 0,
    getOwner: 0,
    waitUntilReady: 0,
  };
  const store = {
    acquire: async (ownerToken) => {
      calls.acquire += 1;
      await hooks.beforeAcquire?.(backend);
      if (backend.owner !== null) return false;
      backend.owner = ownerToken;
      return true;
    },
    close: async () => {
      calls.close += 1;
      await hooks.beforeClose?.(backend);
    },
    compareAndDelete: async (expectedOwner) => {
      calls.compareAndDelete += 1;
      await hooks.beforeCompareAndDelete?.(backend);
      if (backend.owner !== expectedOwner) return false;
      backend.owner = null;
      return true;
    },
    compareAndSet: async (expectedOwner, nextOwner) => {
      calls.compareAndSet += 1;
      await hooks.beforeCompareAndSet?.(backend);
      if (backend.owner !== expectedOwner) return false;
      backend.owner = nextOwner;
      return true;
    },
    getOwner: async () => {
      calls.getOwner += 1;
      await hooks.beforeGetOwner?.(backend);
      return backend.owner;
    },
    waitUntilReady: async () => {
      calls.waitUntilReady += 1;
      await hooks.beforeWaitUntilReady?.(backend);
    },
  };
  return { backend, calls, store };
}

function controlOptions(harness, ownership, overrides = {}) {
  return {
    createQueue: harness.createQueue,
    drainTimeoutMs: 1,
    ownerToken: OWNER_TOKEN,
    ownershipStore: ownership.store,
    ...overrides,
  };
}

test('keeps the host-side queue topology append-only across API queue generations', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/webhook/webhook-queues.ts'), 'utf8');
  assert.match(source, /JOIN_WEBHOOK_SHARD_COUNT = 4/u);
  assert.match(source, /DEFAULT_WEBHOOK_SHARD_COUNT = 16/u);
  const priorRegistry = [
    'moderation',
    'moderation-critical',
    ...Array.from({ length: 4 }, (_, index) => `moderation-join-${index}`),
    ...Array.from({ length: 16 }, (_, index) => `moderation-default-${index}`),
    'moderation-background',
  ];
  assert.deepEqual(WEBHOOK_QUEUE_NAMES, [...priorRegistry, 'moderation-default']);
});

test('validates strong rollout owner tokens without exposing them', () => {
  assert.doesNotThrow(() => validateOwnerToken(OWNER_TOKEN));
  assert.throws(() => validateOwnerToken(''), /invalid format/u);
  assert.throws(() => validateOwnerToken(`rollout:${'a'.repeat(63)}`), /invalid format/u);
  assert.throws(() => validateOwnerToken(`rollout:${'A'.repeat(64)}`), /invalid format/u);
  assert.throws(() => validateOwnerToken(`other:${'a'.repeat(64)}`), /invalid format/u);
});

test('reports queue pause ownership without mutating queues or requiring an owner token', async () => {
  const harness = makeQueues({ activeByName: { moderation: 2 } });
  const ownership = makeOwnershipStore();
  const summary = await controlWebhookQueues(
    'status',
    controlOptions(harness, ownership, { ownerToken: undefined }),
  );

  assert.deepEqual(summary, {
    queueCount: 24,
    pausedCount: 0,
    activeCount: 2,
    legacyDefaultPaused: false,
    ownerPresent: false,
  });
  assert.equal(ownership.calls.acquire, 0);
  assert.equal(ownership.calls.compareAndSet, 0);
  assert.equal(ownership.calls.compareAndDelete, 0);
  assert.equal(ownership.calls.getOwner, 2);
  assert.ok(
    [...harness.states.values()].every(({ closeCalls, paused }) => closeCalls === 1 && !paused),
  );
});

test('opens absent queue handles without creating BullMQ metadata', () => {
  let constructed;
  class QueueProbe {
    constructor(name, options) {
      constructed = { name, options };
    }
    on() {}
  }

  createBullQueue('moderation-default', QueueProbe, 'redis://fixture', {
    enableOfflineQueue: false,
  });
  assert.equal(constructed.name, 'moderation-default');
  assert.equal(constructed.options.skipMetasUpdate, true);
  assert.deepEqual(constructed.options.connection, {
    url: 'redis://fixture',
    enableOfflineQueue: false,
  });
});

test('status exposes an existing owner and fails closed if ownership changes during inspection', async () => {
  const ownedHarness = makeQueues();
  const owned = makeOwnershipStore(OTHER_OWNER_TOKEN);
  const ownedSummary = await controlWebhookQueues(
    'status',
    controlOptions(ownedHarness, owned, { ownerToken: undefined }),
  );
  assert.equal(ownedSummary.ownerPresent, true);
  assert.equal(owned.backend.owner, OTHER_OWNER_TOKEN);

  const racingHarness = makeQueues();
  const racing = makeOwnershipStore(null, {
    beforeGetOwner: async (backend) => {
      if (racing.calls.getOwner === 2) backend.owner = OTHER_OWNER_TOKEN;
    },
  });
  await assert.rejects(
    controlWebhookQueues(
      'status',
      controlOptions(racingHarness, racing, { ownerToken: undefined }),
    ),
    /ownership changed during status inspection/u,
  );
  assert.equal(racing.calls.acquire, 0);
  assert.equal(racing.calls.compareAndDelete, 0);
});

test('status identifies a sole paused retired default queue without exposing queue details', async () => {
  const harness = makeQueues({ pausedByName: { 'moderation-default': true } });
  const ownership = makeOwnershipStore();
  const summary = await controlWebhookQueues(
    'status',
    controlOptions(harness, ownership, { ownerToken: undefined }),
  );

  assert.deepEqual(summary, {
    queueCount: 24,
    pausedCount: 1,
    activeCount: 0,
    legacyDefaultPaused: true,
    ownerPresent: false,
  });
});

test('status rejects an unsafe aggregate active count', async () => {
  const harness = makeQueues({
    activeByName: {
      moderation: Number.MAX_SAFE_INTEGER,
      'moderation-critical': 1,
    },
  });
  const ownership = makeOwnershipStore();
  await assert.rejects(
    controlWebhookQueues(
      'status',
      controlOptions(harness, ownership, { ownerToken: undefined }),
    ),
    /active total is unsafe/u,
  );
});

test('acquires ownership with SET NX semantics before pausing every queue', async () => {
  const harness = makeQueues();
  const ownership = makeOwnershipStore();
  const summary = await controlWebhookQueues('pause', controlOptions(harness, ownership));

  assert.deepEqual(summary, { queueCount: 24, pausedCount: 24, activeCount: 0 });
  assert.equal(ownership.backend.owner, OWNER_TOKEN);
  assert.equal(ownership.calls.acquire, 1);
  assert.equal(ownership.calls.compareAndSet, 0);
  assert.equal(ownership.calls.compareAndDelete, 0);
  assert.equal(ownership.calls.close, 1);
  assert.ok(
    [...harness.states.values()].every(({ closeCalls, paused }) => closeCalls === 1 && paused),
  );
});

test('requires explicit adoption and atomically takes over the observed owner', async () => {
  const harness = makeQueues({ paused: true });
  const ownership = makeOwnershipStore(OTHER_OWNER_TOKEN);

  await assert.rejects(
    controlWebhookQueues('pause', controlOptions(harness, ownership)),
    /owned by another rollout/u,
  );
  assert.equal(ownership.backend.owner, OTHER_OWNER_TOKEN);
  assert.equal(ownership.calls.compareAndSet, 0);

  const summary = await controlWebhookQueues(
    'pause',
    controlOptions(harness, ownership, { adoptExistingPause: true }),
  );
  assert.deepEqual(summary, { queueCount: 24, pausedCount: 24, activeCount: 0 });
  assert.equal(ownership.backend.owner, OWNER_TOKEN);
  assert.equal(ownership.calls.compareAndSet, 1);
});

test('explicit adoption cannot overwrite an owner replaced before its CAS', async () => {
  const harness = makeQueues({ paused: true });
  const ownership = makeOwnershipStore(OTHER_OWNER_TOKEN, {
    beforeCompareAndSet: async (backend) => {
      backend.owner = REPLACEMENT_OWNER_TOKEN;
    },
  });

  await assert.rejects(
    controlWebhookQueues('pause', controlOptions(harness, ownership, { adoptExistingPause: true })),
    /owner changed during explicit adoption/u,
  );
  assert.equal(ownership.backend.owner, REPLACEMENT_OWNER_TOKEN);
  assert.ok([...harness.states.values()].every(({ paused }) => paused));
});

test('new pause cannot overwrite an owner acquired during its SET NX race', async () => {
  const harness = makeQueues();
  const ownership = makeOwnershipStore(null, {
    beforeAcquire: async (backend) => {
      backend.owner = OTHER_OWNER_TOKEN;
    },
  });

  await assert.rejects(
    controlWebhookQueues('pause', controlOptions(harness, ownership)),
    /ownership was lost/u,
  );
  assert.equal(ownership.backend.owner, OTHER_OWNER_TOKEN);
  assert.ok([...harness.states.values()].every(({ paused }) => !paused));
});

test('explicitly adopts an already-paused topology whose owner key is absent', async () => {
  const harness = makeQueues({ paused: true });
  const ownership = makeOwnershipStore();

  await assert.rejects(
    controlWebhookQueues('pause', controlOptions(harness, ownership)),
    /unowned global pause/u,
  );
  assert.equal(ownership.backend.owner, null);

  await controlWebhookQueues(
    'pause',
    controlOptions(harness, ownership, { adoptExistingPause: true }),
  );
  assert.equal(ownership.backend.owner, OWNER_TOKEN);
  assert.equal(ownership.calls.acquire, 1);
});

test('preserves acquired ownership and closes resources after a partial pause failure', async () => {
  const harness = makeQueues({
    hooks: {
      onPause: async (name) => {
        if (name === 'moderation-critical') throw new Error('simulated queue failure');
      },
    },
  });
  const ownership = makeOwnershipStore();

  await assert.rejects(
    controlWebhookQueues('pause', controlOptions(harness, ownership)),
    /could not be paused globally/u,
  );
  assert.equal(ownership.backend.owner, OWNER_TOKEN);
  assert.equal(ownership.calls.compareAndDelete, 0);
  assert.equal(ownership.calls.close, 1);
  assert.ok([...harness.states.values()].every(({ closeCalls }) => closeCalls === 1));
  assert.equal(harness.states.get('moderation-critical').paused, false);
  assert.equal(harness.states.get('moderation').paused, true);
});

test('wait-drained fences queue reads and sleeps with ownership checks', async () => {
  const harness = makeQueues({ activeByName: { moderation: 1 }, paused: true });
  const ownership = makeOwnershipStore(OWNER_TOKEN);
  let nowMs = 0;

  const summary = await controlWebhookQueues(
    'wait-drained',
    controlOptions(harness, ownership, {
      drainTimeoutMs: 2_000,
      now: () => nowMs,
      wait: (resolve, delayMs) => {
        nowMs += delayMs;
        harness.states.get('moderation').active = 0;
        resolve();
      },
    }),
  );

  assert.deepEqual(summary, { queueCount: 24, pausedCount: 24, activeCount: 0 });
  assert.ok(ownership.calls.getOwner >= 6);
  assert.equal(ownership.backend.owner, OWNER_TOKEN);
});

test('wait-drained keeps queue and ownership resources open until reads settle', async () => {
  let markReadStarted;
  let releaseRead;
  let readStarted = false;
  const readStartedPromise = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const harness = makeQueues({
    hooks: {
      onIsPaused: async () => {
        if (!readStarted) {
          readStarted = true;
          markReadStarted();
        }
        await readGate;
      },
    },
    paused: true,
  });
  const ownership = makeOwnershipStore(OWNER_TOKEN);

  const operation = controlWebhookQueues('wait-drained', controlOptions(harness, ownership));
  await readStartedPromise;
  const closedBeforeReadSettled =
    ownership.calls.close !== 0 ||
    [...harness.states.values()].some(({ closeCalls }) => closeCalls !== 0);
  releaseRead();

  const summary = await operation;
  assert.equal(closedBeforeReadSettled, false);
  assert.deepEqual(summary, { queueCount: 24, pausedCount: 24, activeCount: 0 });
  assert.equal(ownership.calls.close, 1);
  assert.ok([...harness.states.values()].every(({ closeCalls }) => closeCalls === 1));
});

test('wait-drained fails closed when ownership is replaced during a queue read', async () => {
  const ownership = makeOwnershipStore(OWNER_TOKEN);
  let replaced = false;
  const harness = makeQueues({
    hooks: {
      onIsPaused: async () => {
        if (!replaced) {
          ownership.backend.owner = OTHER_OWNER_TOKEN;
          replaced = true;
        }
      },
    },
    paused: true,
  });

  await assert.rejects(
    controlWebhookQueues('wait-drained', controlOptions(harness, ownership)),
    /ownership was lost/u,
  );
  assert.equal(ownership.backend.owner, OTHER_OWNER_TOKEN);
  assert.equal(ownership.calls.compareAndDelete, 0);
});

test('wait-drained fails closed when ownership is lost during its bounded wait', async () => {
  const harness = makeQueues({ activeByName: { moderation: 1 }, paused: true });
  const ownership = makeOwnershipStore(OWNER_TOKEN);
  let nowMs = 0;

  await assert.rejects(
    controlWebhookQueues(
      'wait-drained',
      controlOptions(harness, ownership, {
        drainTimeoutMs: 2_000,
        now: () => nowMs,
        wait: (resolve, delayMs) => {
          nowMs += delayMs;
          ownership.backend.owner = null;
          resolve();
        },
      }),
    ),
    /ownership was lost/u,
  );
  assert.equal(ownership.calls.compareAndDelete, 0);
});

test('resume verifies the drained pause and compare-deletes only its own token', async () => {
  const harness = makeQueues({ paused: true });
  const ownership = makeOwnershipStore(OWNER_TOKEN);

  const summary = await controlWebhookQueues('resume', controlOptions(harness, ownership));

  assert.deepEqual(summary, { queueCount: 24, pausedCount: 0, activeCount: 0 });
  assert.equal(ownership.backend.owner, null);
  assert.equal(ownership.calls.compareAndDelete, 1);
  assert.ok([...harness.states.values()].every(({ paused }) => !paused));
});

test('resume does not delete a replacement owner installed during queue resume', async () => {
  const ownership = makeOwnershipStore(OWNER_TOKEN);
  let replaced = false;
  const harness = makeQueues({
    hooks: {
      onResume: async () => {
        if (!replaced) {
          ownership.backend.owner = OTHER_OWNER_TOKEN;
          replaced = true;
        }
      },
    },
    paused: true,
  });

  await assert.rejects(
    controlWebhookQueues('resume', controlOptions(harness, ownership)),
    /ownership was lost/u,
  );
  assert.equal(ownership.backend.owner, OTHER_OWNER_TOKEN);
  assert.equal(ownership.calls.compareAndDelete, 0);
});

test('resume compare-delete detects a last-moment owner replacement', async () => {
  const harness = makeQueues({ paused: true });
  const ownership = makeOwnershipStore(OWNER_TOKEN, {
    beforeCompareAndDelete: async (backend) => {
      backend.owner = OTHER_OWNER_TOKEN;
    },
  });

  await assert.rejects(
    controlWebhookQueues('resume', controlOptions(harness, ownership)),
    /ownership changed before release/u,
  );
  assert.equal(ownership.backend.owner, OTHER_OWNER_TOKEN);
  assert.equal(ownership.calls.compareAndDelete, 1);
});

test('refuses resume while active, partially paused, or not owned', async () => {
  const activeHarness = makeQueues({ activeByName: { moderation: 1 }, paused: true });
  const activeOwnership = makeOwnershipStore(OWNER_TOKEN);
  await assert.rejects(
    controlWebhookQueues('resume', controlOptions(activeHarness, activeOwnership)),
    /not safely drained/u,
  );
  assert.equal(activeOwnership.backend.owner, OWNER_TOKEN);

  const partialHarness = makeQueues({ paused: true });
  partialHarness.states.get('moderation-background').paused = false;
  const partialOwnership = makeOwnershipStore(OWNER_TOKEN);
  await assert.rejects(
    controlWebhookQueues('resume', controlOptions(partialHarness, partialOwnership)),
    /not safely drained/u,
  );
  assert.equal(partialOwnership.backend.owner, OWNER_TOKEN);

  const unownedHarness = makeQueues({ paused: true });
  const unowned = makeOwnershipStore();
  await assert.rejects(
    controlWebhookQueues('resume', controlOptions(unownedHarness, unowned)),
    /ownership was lost/u,
  );
});

test('Redis ownership store uses SET NX and Lua compare operations', async () => {
  const calls = [];
  const redis = {
    owner: null,
    status: 'ready',
    connect: async () => undefined,
    disconnect: () => {
      redis.status = 'end';
    },
    eval: async (script, keyCount, key, ...arguments_) => {
      calls.push(['eval', script, keyCount, key]);
      if (script === COMPARE_AND_SET_OWNER_SCRIPT) {
        const [expectedOwner, nextOwner] = arguments_;
        if (redis.owner !== expectedOwner) return 0;
        redis.owner = nextOwner;
        return 1;
      }
      if (script === COMPARE_AND_DELETE_OWNER_SCRIPT) {
        const [expectedOwner] = arguments_;
        if (redis.owner !== expectedOwner) return 0;
        redis.owner = null;
        return 1;
      }
      throw new Error('unexpected script');
    },
    get: async (key) => {
      calls.push(['get', key]);
      return redis.owner;
    },
    quit: async () => {
      calls.push(['quit']);
      redis.status = 'end';
    },
    set: async (key, value, modifier) => {
      calls.push(['set', key, modifier]);
      if (modifier !== 'NX' || redis.owner !== null) return null;
      redis.owner = value;
      return 'OK';
    },
  };
  const store = createRedisOwnershipStore(redis);

  assert.equal(await store.acquire(OWNER_TOKEN), true);
  assert.equal(await store.acquire(OTHER_OWNER_TOKEN), false);
  assert.equal(await store.compareAndSet(OTHER_OWNER_TOKEN, OWNER_TOKEN), false);
  assert.equal(await store.compareAndSet(OWNER_TOKEN, OTHER_OWNER_TOKEN), true);
  assert.equal(await store.compareAndDelete(OWNER_TOKEN), false);
  assert.equal(await store.compareAndDelete(OTHER_OWNER_TOKEN), true);
  assert.equal(await store.getOwner(), null);
  await store.close();

  assert.ok(calls.some((call) => call[0] === 'set' && call[1] === WEBHOOK_ROLLOUT_OWNER_KEY));
  assert.equal(redis.status, 'end');
});

test('waitForDrain rejects a lost global queue pause even with stable ownership', async () => {
  const harness = makeQueues({ paused: true });
  harness.states.get('moderation-background').paused = false;
  await assert.rejects(
    waitForDrain(
      [...harness.states].map(([name]) => ({ name, queue: harness.createQueue(name) })),
      1,
    ),
    /lost the global rollout pause/u,
  );
});

test('rejects malformed topology, timeout, owner, and actions', async () => {
  assert.throws(() => validateQueueNames(['moderation', 'moderation']), /topology/u);
  assert.throws(() => validateQueueNames(['max-actions']), /topology/u);
  assert.equal(parsePositiveInteger('960000', 'timeout'), 960_000);
  assert.throws(() => parsePositiveInteger('0', 'timeout'), /positive integer/u);

  const harness = makeQueues();
  const ownership = makeOwnershipStore();
  await assert.rejects(
    controlWebhookQueues('unknown', controlOptions(harness, ownership)),
    /Unknown webhook rollout queue action/u,
  );
  assert.equal(ownership.calls.close, 1);

  const malformedOwnerStore = makeOwnershipStore();
  await assert.rejects(
    controlWebhookQueues(
      'pause',
      controlOptions(harness, malformedOwnerStore, { ownerToken: 'invalid' }),
    ),
    /owner token has an invalid format/u,
  );
  assert.equal(malformedOwnerStore.calls.close, 1);
});
