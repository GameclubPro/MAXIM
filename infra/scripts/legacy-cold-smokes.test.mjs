import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLegacyColdSmokes } from './legacy-cold-smokes.mjs';

function fixture() {
  let time = Date.parse('2026-10-06T02:00:00Z');
  const state = {
    lag: 0,
    paused: 0,
    owner: false,
    stale: false,
    nativeFails: false,
    reads: 0,
    backlog: false,
    database: true,
    condition: 'queue_backlog',
  };
  const smokes = createLegacyColdSmokes({
    bindings: {
      targetSha: 'a'.repeat(40),
      targetImageId: `sha256:${'b'.repeat(64)}`,
      selectionDigest: 'c'.repeat(64),
      controllerNonce: '11111111-1111-4111-8111-111111111111',
    },
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    runtime: { readRuntimeIdentity: () => ({ auxiliaries: [{}, {}] }) },
    client: {
      invoke: () => ({ queueCount: 24, pausedCount: state.paused, ownerPresent: state.owner }),
    },
    run: async () => {
      if (state.nativeFails) throw new Error('fixture failure');
    },
    fetchImpl: async () => {
      state.reads += 1;
      return {
        ok: !state.backlog,
        status: state.backlog ? 503 : 200,
        json: async () => ({
          ok: !state.backlog,
          systemMode: { source: 'auto', condition: state.condition, manualMode: null },
          checks: {
            database: state.database,
            redis: true,
            queueLag: {
              rawOk: !state.backlog,
              effectiveLagSec: state.lag,
              sampleGeneratedAt: new Date(time - (state.stale ? 60_000 : 0)).toISOString(),
            },
          },
        }),
      };
    },
  });
  return { smokes, state };
}

test('three fresh ready samples and released queues positively prove recovery', async () => {
  const h = fixture();
  assert.equal((await h.smokes.readNativeIdentity()).exactGenerationCount, 2);
  const result = await h.smokes.strictSmokes();
  assert.equal(result.ingressReady, true);
  assert.equal(result.actionableLagSeconds, 0);
  assert.equal(h.state.reads, 6);
});

for (const [field, value] of [
  ['lag', 11],
  ['lag', NaN],
  ['paused', 1],
  ['owner', true],
  ['stale', true],
])
  test(`HTTP 200 cannot conceal unproved ${field}`, async () => {
    const h = fixture();
    h.state[field] = value;
    await assert.rejects(h.smokes.strictSmokes(), /strict_smoke_deadline/);
  });

test('container identity alone cannot replace actual native smokes', async () => {
  const h = fixture();
  h.state.nativeFails = true;
  await assert.rejects(h.smokes.readNativeIdentity(), /native_smokes_unproved/);
});

test('a different backlog stays visible without stopping a positively sealed fleet', async () => {
  const h = fixture();
  Object.assign(h.state, { backlog: true, lag: 40000 });
  const result = await h.smokes.strictSmokes();
  assert.equal(result.ingressReady, false);
  assert.equal(result.adminReady, false);
  assert.equal(result.dependenciesReady, true);
  assert.equal(result.queueBacklogOnly, true);
  assert.equal(result.actionableLagSeconds, 40000);
  assert.equal(h.state.reads, 6);
});
for (const extra of [{ database: false }, { condition: 'action_errors' }, { stale: true }])
  test(`queue backlog cannot hide another failure ${JSON.stringify(extra)}`, async () => {
    const h = fixture();
    Object.assign(h.state, { backlog: true, lag: 40000 }, extra);
    await assert.rejects(h.smokes.strictSmokes(), /strict_smoke_deadline/);
  });
