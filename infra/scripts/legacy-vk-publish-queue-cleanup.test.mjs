import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const {
  LEGACY_VK_PUBLISH_QUEUE,
  OBLITERATE_BATCH_SIZE,
  QUEUE_STATES,
  QueueCleanupPreconditionError,
  cleanupLegacyVkPublishQueue,
} = require('./legacy-vk-publish-queue-cleanup.cjs');

function makeQueue({
  present = true,
  paused = false,
  workerCount = 0,
  counts = {},
  hooks = {},
} = {}) {
  const state = {
    present,
    paused,
    workerCount,
    counts: Object.fromEntries(QUEUE_STATES.map((name) => [name, counts[name] ?? 0])),
  };
  const calls = { close: 0, inspect: 0, obliterate: [], pause: 0, ready: 0 };
  const queue = {
    name: LEGACY_VK_PUBLISH_QUEUE,
    close: async () => {
      calls.close += 1;
    },
    getJobCounts: async (...names) => {
      calls.inspect += 1;
      assert.deepEqual(names, QUEUE_STATES);
      return Object.fromEntries(names.map((name) => [name, state.counts[name]]));
    },
    getVersion: async () => (state.present ? 'bullmq:test' : null),
    getWorkersCount: async () => state.workerCount,
    isPaused: async () => state.paused,
    obliterate: async (options) => {
      calls.obliterate.push(options);
      await hooks.beforeObliterate?.(state);
      assert.equal(state.paused, true);
      assert.equal(state.counts.active, 0);
      state.present = false;
      state.paused = false;
      for (const name of QUEUE_STATES) state.counts[name] = 0;
    },
    pause: async () => {
      calls.pause += 1;
      state.present = true;
      state.paused = true;
      await hooks.afterPause?.(state);
    },
    waitUntilReady: async () => {
      calls.ready += 1;
    },
  };
  return { calls, queue, state };
}

test('dry-run reports fixed counters without pausing or deleting the queue', async () => {
  const harness = makeQueue({
    workerCount: 2,
    counts: { waiting: 7, active: 1, delayed: 3, failed: 4 },
  });

  const result = await cleanupLegacyVkPublishQueue(harness.queue);

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.result, 'would_obliterate');
  assert.equal(result.before.workerCount, 2);
  assert.equal(result.before.totalJobs, 15);
  assert.deepEqual(Object.keys(result.before.counts), QUEUE_STATES);
  assert.equal(harness.calls.pause, 0);
  assert.deepEqual(harness.calls.obliterate, []);
  assert.doesNotMatch(JSON.stringify(result), /jobId|payload|redis|url/iu);
});

test('apply fails before mutation when a legacy worker is still connected', async () => {
  const harness = makeQueue({ workerCount: 1, counts: { waiting: 2 } });

  await assert.rejects(
    cleanupLegacyVkPublishQueue(harness.queue, { apply: true }),
    (error) =>
      error instanceof QueueCleanupPreconditionError &&
      error.code === 'workers_present_before_pause',
  );
  assert.equal(harness.calls.pause, 0);
  assert.deepEqual(harness.calls.obliterate, []);
});

test('apply leaves the queue paused and refuses active work without force', async () => {
  const harness = makeQueue({ counts: { active: 2, waiting: 4 } });

  await assert.rejects(
    cleanupLegacyVkPublishQueue(harness.queue, { apply: true }),
    (error) =>
      error instanceof QueueCleanupPreconditionError && error.code === 'active_jobs_after_pause',
  );
  assert.equal(harness.calls.pause, 1);
  assert.equal(harness.state.paused, true);
  assert.deepEqual(harness.calls.obliterate, []);
});

test('apply rechecks workers after pause and leaves the queue paused on a race', async () => {
  const harness = makeQueue({
    counts: { waiting: 4 },
    hooks: {
      afterPause: async (state) => {
        state.workerCount = 1;
      },
    },
  });

  await assert.rejects(
    cleanupLegacyVkPublishQueue(harness.queue, { apply: true }),
    (error) =>
      error instanceof QueueCleanupPreconditionError &&
      error.code === 'workers_present_after_pause',
  );
  assert.equal(harness.state.paused, true);
  assert.deepEqual(harness.calls.obliterate, []);
});

test('apply pauses, rechecks, and obliterates only the exact legacy queue without force', async () => {
  const harness = makeQueue({ counts: { waiting: 4, delayed: 3, failed: 2 } });

  const result = await cleanupLegacyVkPublishQueue(harness.queue, { apply: true });

  assert.equal(result.result, 'obliterated');
  assert.equal(result.before.totalJobs, 9);
  assert.equal(result.after.present, false);
  assert.equal(result.after.totalJobs, 0);
  assert.equal(harness.calls.pause, 1);
  assert.deepEqual(harness.calls.obliterate, [{ force: false, count: OBLITERATE_BATCH_SIZE }]);
});

test('an absent queue is an idempotent apply success with no Redis mutation', async () => {
  const harness = makeQueue({ present: false });

  const first = await cleanupLegacyVkPublishQueue(harness.queue, { apply: true });
  const second = await cleanupLegacyVkPublishQueue(harness.queue, { apply: true });

  assert.equal(first.result, 'already_absent');
  assert.equal(second.result, 'already_absent');
  assert.equal(harness.calls.pause, 0);
  assert.deepEqual(harness.calls.obliterate, []);
});

test('fails closed on invalid or unbounded queue counters', async () => {
  const harness = makeQueue();
  harness.state.counts.waiting = Number.MAX_SAFE_INTEGER + 1;

  await assert.rejects(cleanupLegacyVkPublishQueue(harness.queue), /invalid waiting count/u);
  assert.equal(harness.calls.pause, 0);
});

test('wires the guarded command through vps-connect and keeps the monitor sentinel', () => {
  const entrypointPath = resolve(root, 'infra/scripts/vps-retire-legacy-vk-publish-queue.sh');
  const entrypoint = readFileSync(entrypointPath, 'utf8');
  const helper = readFileSync(
    resolve(root, 'infra/scripts/legacy-vk-publish-queue-cleanup.cjs'),
    'utf8',
  );
  const connect = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
  const monitor = readFileSync(resolve(root, 'infra/scripts/vps-monitor-readonly.sh'), 'utf8');
  const queueMetrics = readFileSync(
    resolve(root, 'apps/api/src/system/queue-metrics.service.ts'),
    'utf8',
  );
  const runbook = readFileSync(resolve(root, 'docs/runbook.md'), 'utf8');

  assert.match(entrypoint, /source "\$ROOT_DIR\/infra\/scripts\/lib\/deploy-lock\.sh"/u);
  assert.match(entrypoint, /acquire_deploy_lock/u);
  assert.match(
    entrypoint,
    /docker compose "\$\{COMPOSE_FILES\[@\]\}" exec -T api-admin node - "\$ACTION"/u,
  );
  assert.match(entrypoint, /timeout --foreground --kill-after=5s/u);
  assert.doesNotMatch(entrypoint, /psql|postgres|DATABASE_URL/u);
  assert.match(helper, /const LEGACY_VK_PUBLISH_QUEUE = 'vk-parsing-publish'/u);
  assert.match(helper, /skipMetasUpdate: true/u);
  assert.match(helper, /queue\.obliterate\(\{ force: false, count: OBLITERATE_BATCH_SIZE \}\)/u);
  assert.doesNotMatch(helper, /force: true/u);
  assert.match(connect, /vk-parsing-retire-legacy-queue \[--apply\]/u);
  assert.match(connect, /vps-retire-legacy-vk-publish-queue\.sh/u);
  assert.equal([...monitor.matchAll(/^ {2}vk-parsing-publish$/gmu)].length, 1);
  assert.doesNotMatch(queueMetrics, /VK_PARSING_PUBLISH_QUEUE/u);
  assert.match(
    runbook,
    /Keep the legacy queue in `monitor-readonly` as a zero-count regression sentinel/u,
  );

  const invalid = spawnSync('bash', [entrypointPath, '--unexpected'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Usage:/u);
  assert.doesNotMatch(invalid.stderr, /REDIS_URL|DATABASE_URL/u);

  const help = spawnSync('bash', [entrypointPath, '--help'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /read-only preview/u);
});
