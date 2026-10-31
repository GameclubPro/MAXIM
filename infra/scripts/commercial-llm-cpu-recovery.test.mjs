import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCpuRecoveryGeneration,
  assertCpuRecoveryJournal,
  assertCpuRecoveryPlan,
  cpuRecoveryPlanSha256,
  recoverCommercialLlmCpuQuarantine,
} from './commercial-llm-cpu-recovery.mjs';

const sourceSha = 'a'.repeat(40);
const operationId = '11111111-1111-4111-8111-111111111111';
const fingerprint = 'c'.repeat(64);
const startedAt = '2026-10-31T06:42:01.123456789Z';
const restartedAt = '2026-10-31T07:42:01.123456789Z';
const copy = (value) => structuredClone(value);

function fixture() {
  const state = {
    model: {
      id: '1'.repeat(64),
      imageId: `sha256:${'2'.repeat(64)}`,
      startedAt,
      restartCount: 0,
      running: true,
    },
    dispatcher: {
      id: '3'.repeat(64),
      imageId: `sha256:${'4'.repeat(64)}`,
      startedAt,
      restartCount: 0,
      running: true,
    },
    lease: { state: 'held', fingerprint, ttlMs: -1 },
    receipt: null,
    journal: undefined,
    calls: [],
    crash: null,
    onSnapshot: null,
  };
  const crash = (method, when) => {
    if (state.crash?.method === method && state.crash?.when === when) {
      state.crash = null;
      throw new Error('simulated_crash');
    }
  };
  const mutate = async (method, expected, body) => {
    state.calls.push(method);
    if (expected) {
      const target = /Dispatcher/u.test(method) ? state.dispatcher : state.model;
      assert.deepEqual(
        {
          id: target.id,
          imageId: target.imageId,
          startedAt: target.startedAt,
          restartCount: target.restartCount,
        },
        expected,
      );
    }
    crash(method, 'before');
    body?.();
    crash(method, 'after');
  };
  const io = {
    async snapshot() {
      state.calls.push('snapshot');
      state.onSnapshot?.(state);
      return copy({ model: state.model, dispatcher: state.dispatcher });
    },
    async readJournal(op) {
      state.calls.push('readJournal');
      assert.equal(op, operationId);
      return copy(state.journal);
    },
    async writeJournal(value) {
      await mutate(`write:${value.phase}`, null, () => {
        state.journal = copy(value);
      });
    },
    async leaseStatus(op) {
      state.calls.push('leaseStatus');
      assert.equal(op, operationId);
      return copy(state.receipt ?? state.lease);
    },
    async stopDispatcher(expected) {
      await mutate('stopDispatcher', expected, () => {
        state.dispatcher.running = false;
      });
    },
    async stopModel(expected) {
      await mutate('stopModel', expected, () => {
        state.model.running = false;
      });
    },
    async startModel(expected) {
      await mutate('startModel', expected, () => {
        state.model.running = true;
        state.model.startedAt = restartedAt;
      });
    },
    async startDispatcher(expected) {
      await mutate('startDispatcher', expected, () => {
        state.dispatcher.running = true;
        state.dispatcher.startedAt = restartedAt;
      });
    },
    async releaseLease(op, expected) {
      assert.equal(op, operationId);
      assert.equal(state.model.running, false);
      assert.equal(state.dispatcher.running, false);
      await mutate('releaseLease', null, () => {
        assert.equal(state.lease.state, 'held');
        assert.equal(state.lease.fingerprint, expected);
        assert.equal(state.lease.ttlMs, -1);
        state.lease = { state: 'missing' };
        state.receipt = { state: 'released_receipt', fingerprint: expected };
      });
    },
    async waitModelReady(expected) {
      assert.equal(state.model.running, true);
      assert.equal(state.dispatcher.running, false);
      await mutate('waitModelReady', expected);
    },
    async waitDispatcherReady(expected) {
      assert.equal(state.model.running, true);
      assert.equal(state.dispatcher.running, true);
      await mutate('waitDispatcherReady', expected);
    },
  };
  const options = { sourceSha, operationId, io };
  return {
    state,
    io,
    options,
    preview: () => recoverCommercialLlmCpuQuarantine(options),
    apply: (expectedPlanSha256) =>
      recoverCommercialLlmCpuQuarantine({ ...options, apply: true, expectedPlanSha256 }),
  };
}

const effects = (calls) =>
  calls.filter((call) => !['readJournal', 'snapshot', 'leaseStatus'].includes(call));

test('preview is deterministic and performs no writes or service operations', async () => {
  const f = fixture();
  const first = await f.preview();
  assert.deepEqual(await f.preview(), first);
  assert.equal(first.result, 'preview');
  assert.equal(first.phase, 'not_started');
  assert.equal(cpuRecoveryPlanSha256(first.plan), first.planSha256);
  assert.deepEqual(effects(f.state.calls), []);
  assert.equal(f.state.journal, undefined);
});

test('only the reviewed plan can stop the exact dispatcher and model before lease release', async () => {
  const f = fixture();
  const { planSha256 } = await f.preview();
  await assert.rejects(f.apply('0'.repeat(64)), /reviewed_plan_required/u);
  assert.deepEqual(effects(f.state.calls), []);
  const result = await f.apply(planSha256);
  assert.equal(result.result, 'recovered');
  assert.equal(f.state.journal.phase, 'complete');
  assertCpuRecoveryJournal(f.state.journal);
  assert.deepEqual(
    effects(f.state.calls).filter((call) => !call.startsWith('write:')),
    [
      'stopDispatcher',
      'stopModel',
      'releaseLease',
      'startModel',
      'waitModelReady',
      'startDispatcher',
      'waitDispatcherReady',
    ],
  );
});

test('completed replay returns the terminal result without touching a later lease or runtime', async () => {
  const f = fixture();
  const { planSha256 } = await f.preview();
  await f.apply(planSha256);
  f.state.lease = { state: 'held', fingerprint: 'e'.repeat(64), ttlMs: -1 };
  f.state.receipt = null;
  f.state.model.id = 'f'.repeat(64);
  f.state.calls.length = 0;
  const result = await f.apply(planSha256);
  assert.equal(result.result, 'already_recovered');
  assert.deepEqual(f.state.calls, ['readJournal']);
  assert.equal(f.state.lease.fingerprint, 'e'.repeat(64));
});

for (const method of [
  'stopDispatcher',
  'stopModel',
  'releaseLease',
  'startModel',
  'waitModelReady',
  'startDispatcher',
  'waitDispatcherReady',
  ...[
    'prepared',
    'stopping_dispatcher',
    'dispatcher_stopped',
    'stopping_model',
    'model_stopped',
    'releasing_lease',
    'lease_released',
    'starting_model',
    'model_ready',
    'starting_dispatcher',
    'dispatcher_ready',
    'complete',
  ].map((phase) => `write:${phase}`),
]) {
  for (const when of ['before', 'after']) {
    test(`crash ${when} ${method} resumes its durable intent without another release`, async () => {
      const f = fixture();
      const { planSha256 } = await f.preview();
      f.state.crash = { method, when };
      await assert.rejects(f.apply(planSha256), /simulated_crash/u);
      const committedReleases = f.state.receipt ? 1 : 0;
      const priorCalls = f.state.calls.filter((call) => call === 'releaseLease').length;
      const result = await f.apply(planSha256);
      assert.ok(['recovered', 'already_recovered'].includes(result.result));
      assert.equal(f.state.journal.phase, 'complete');
      const calls = f.state.calls.filter((call) => call === 'releaseLease').length;
      assert.equal(
        calls,
        committedReleases ? priorCalls : method === 'releaseLease' && when === 'before' ? 2 : 1,
      );
    });
  }
}

for (const [field, replacement] of [
  ['id', 'f'.repeat(64)],
  ['imageId', `sha256:${'f'.repeat(64)}`],
  ['startedAt', restartedAt],
  ['restartCount', 1],
]) {
  test(`drift in ${field} invalidates the reviewed preview before any service mutation`, async () => {
    const f = fixture();
    const { planSha256 } = await f.preview();
    f.state.model[field] = replacement;
    await assert.rejects(f.apply(planSha256), /reviewed_plan_required/u);
    assert.deepEqual(effects(f.state.calls), []);
  });
}

for (const invalidLease of [
  { state: 'missing' },
  { state: 'foreign' },
  { state: 'held', fingerprint, ttlMs: 500 },
  { state: 'held', fingerprint: 'not-a-digest', ttlMs: -1 },
]) {
  test(`preview refuses an unproved persistent hold: ${JSON.stringify(invalidLease)}`, async () => {
    const f = fixture();
    f.state.lease = invalidLease;
    await assert.rejects(f.preview(), /persistent_lease_required/u);
    assert.deepEqual(effects(f.state.calls), []);
  });
}

test('missing lease without the exact atomic release receipt leaves both services stopped', async () => {
  const f = fixture();
  const { planSha256 } = await f.preview();
  f.state.crash = { method: 'releaseLease', when: 'before' };
  await assert.rejects(f.apply(planSha256), /simulated_crash/u);
  f.state.lease = { state: 'missing' };
  const offset = f.state.calls.length;
  await assert.rejects(f.apply(planSha256), /release_unproved/u);
  assert.deepEqual(effects(f.state.calls.slice(offset)), []);
  assert.equal(f.state.model.running, false);
  assert.equal(f.state.dispatcher.running, false);
});

test('a foreign lease at the release boundary is never passed to the CAS', async () => {
  const f = fixture();
  const { planSha256 } = await f.preview();
  f.state.crash = { method: 'write:releasing_lease', when: 'after' };
  await assert.rejects(f.apply(planSha256), /simulated_crash/u);
  f.state.lease.fingerprint = 'f'.repeat(64);
  const offset = f.state.calls.length;
  await assert.rejects(f.apply(planSha256), /lease_changed/u);
  assert.deepEqual(effects(f.state.calls.slice(offset)), []);
});

test('changed generation during release preparation prevents the CAS despite an idle-looking model', async () => {
  const f = fixture();
  const { planSha256 } = await f.preview();
  f.state.crash = { method: 'write:releasing_lease', when: 'after' };
  await assert.rejects(f.apply(planSha256), /simulated_crash/u);
  let observations = 0;
  f.state.onSnapshot = (state) => {
    if (++observations === 2) state.model.startedAt = restartedAt;
  };
  const offset = f.state.calls.length;
  await assert.rejects(f.apply(planSha256), /generation_drift/u);
  assert.deepEqual(effects(f.state.calls.slice(offset)), []);
});

test('a changed dispatcher after model restart remains stopped and is not adopted', async () => {
  const f = fixture();
  const { planSha256 } = await f.preview();
  f.state.crash = { method: 'write:model_ready', when: 'after' };
  await assert.rejects(f.apply(planSha256), /simulated_crash/u);
  f.state.dispatcher.id = 'f'.repeat(64);
  const offset = f.state.calls.length;
  await assert.rejects(f.apply(planSha256), /generation_drift/u);
  assert.deepEqual(effects(f.state.calls.slice(offset)), []);
});

test('an unplanned restart in a stop-intent phase is not adopted', async () => {
  const f = fixture();
  const { planSha256 } = await f.preview();
  f.state.crash = { method: 'write:stopping_model', when: 'after' };
  await assert.rejects(f.apply(planSha256), /simulated_crash/u);
  f.state.model.startedAt = restartedAt;
  const offset = f.state.calls.length;
  await assert.rejects(f.apply(planSha256), /generation_drift/u);
  assert.deepEqual(effects(f.state.calls.slice(offset)), []);
});

test('a new lease after dispatcher start is preserved while receipt-backed recovery completes', async () => {
  const f = fixture();
  const { planSha256 } = await f.preview();
  f.state.crash = { method: 'startDispatcher', when: 'after' };
  await assert.rejects(f.apply(planSha256), /simulated_crash/u);
  f.state.lease = { state: 'held', fingerprint: 'e'.repeat(64), ttlMs: -1 };
  const releaseCalls = f.state.calls.filter((call) => call === 'releaseLease').length;
  assert.equal((await f.apply(planSha256)).result, 'recovered');
  assert.equal(f.state.calls.filter((call) => call === 'releaseLease').length, releaseCalls);
  assert.equal(f.state.lease.fingerprint, 'e'.repeat(64));
});

test('journal identity, digest, phase and restart evidence cannot be fabricated into completion', async () => {
  const f = fixture();
  const { planSha256, plan } = await f.preview();
  await assert.rejects(
    recoverCommercialLlmCpuQuarantine({
      ...f.options,
      apply: 'true',
      expectedPlanSha256: planSha256,
    }),
    /identity_invalid/u,
  );
  f.state.crash = { method: 'write:prepared', when: 'after' };
  await assert.rejects(f.apply(planSha256), /simulated_crash/u);
  const original = copy(f.state.journal);
  for (const change of [
    { planSha256: 'f'.repeat(64) },
    { phase: 'complete' },
    { phase: 'unknown' },
    { modelRestart: plan.model },
    { plan: { ...plan, operationId: '22222222-2222-4222-8222-222222222222' } },
    { plan: { ...plan, sourceSha: 'b'.repeat(40) } },
  ]) {
    f.state.journal = { ...copy(original), ...change };
    const offset = f.state.calls.length;
    await assert.rejects(f.apply(planSha256), /commercial_llm_cpu_recovery_/u);
    assert.deepEqual(effects(f.state.calls.slice(offset)), []);
  }
});

test('generation and plan validators reject malformed clocks, ownership fields and digests', async () => {
  const f = fixture();
  const { plan } = await f.preview();
  assertCpuRecoveryPlan(plan);
  for (const change of [
    { id: 'bad' },
    { imageId: 'latest' },
    { startedAt: '2026-02-30T06:42:01.123Z' },
    { restartCount: -1 },
    { restartCount: 0.5 },
    { extra: 'unreviewed' },
  ])
    assert.throws(
      () => assertCpuRecoveryGeneration({ ...plan.model, ...change }),
      /generation_invalid/u,
    );
  assert.throws(() => assertCpuRecoveryPlan({ ...plan, dispatcher: plan.model }), /plan_invalid/u);
  assert.throws(() => assertCpuRecoveryPlan({ ...plan, leaseFingerprint: 'bad' }), /plan_invalid/u);
});
