import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  armOperatorPause,
  buildOperatorMarker,
  classifyPause,
  clearOperatorPause,
  parseHeartbeat,
  validateOwnerToken,
} = require('./publisher-dispatch-rollout-control.cjs');

const OWNER = `publisher-rollout:${'a'.repeat(64)}`;
const OTHER_OWNER = `publisher-rollout:${'b'.repeat(64)}`;
const AUTH_PAUSE = JSON.stringify({
  version: 1,
  reason: 'unauthorized',
  statusCode: 401,
  observedAt: '2026-08-26T12:00:00.000Z',
  observedAtMs: 1_777_374_400_000,
});
const MISMATCH_PAUSE = JSON.stringify({
  version: 1,
  reason: 'identity_mismatch',
  statusCode: null,
  observedAt: '2026-08-26T12:01:00.000Z',
  observedAtMs: 1_777_374_460_000,
});

function makeStore(initial = null, hooks = {}) {
  const state = { raw: initial };
  const store = {
    get: async () => state.raw,
    setNx: async (value) => {
      await hooks.beforeSetNx?.(state);
      if (state.raw !== null) return false;
      state.raw = value;
      return true;
    },
    compareAndSet: async (expected, replacement) => {
      await hooks.beforeCompareAndSet?.(state);
      if (state.raw !== expected) return false;
      state.raw = replacement;
      return true;
    },
    clearOwned: async (owner) => {
      await hooks.beforeClear?.(state);
      const parsed = classifyPause(state.raw);
      if (parsed.kind !== 'operator') return false;
      const marker = JSON.parse(state.raw);
      if (marker.ownerToken !== owner) return false;
      state.raw = marker.preservedPauseRaw ?? null;
      return true;
    },
    close: async () => undefined,
  };
  return { state, store };
}

test('arms a new operator pause without an observedAtMs auto-clear field', async () => {
  const harness = makeStore();
  const result = await armOperatorPause(
    harness.store,
    OWNER,
    'enable',
    new Date('2026-08-26T12:00:00.000Z'),
  );
  assert.deepEqual(result, { result: 'acquired', pauseKind: 'operator' });
  const marker = JSON.parse(harness.state.raw);
  assert.equal(marker.reason, 'operator_rollout');
  assert.equal(marker.ownerToken, OWNER);
  assert.equal(Object.hasOwn(marker, 'observedAtMs'), false);
  assert.equal(Object.hasOwn(marker, 'preservedPauseRaw'), false);
});

test('enable refuses every existing pause without replacing it', async () => {
  for (const existing of [AUTH_PAUSE, buildOperatorMarker(OTHER_OWNER), 'malformed']) {
    const harness = makeStore(existing);
    const result = await armOperatorPause(harness.store, OWNER, 'enable');
    assert.equal(result.result, 'blocked');
    assert.equal(harness.state.raw, existing);
  }
});

test('disable adopts a prior operator pause so interrupted enable has a fixed recovery path', async () => {
  const oldMarker = buildOperatorMarker(OTHER_OWNER);
  const harness = makeStore(oldMarker);
  assert.deepEqual(await armOperatorPause(harness.store, OWNER, 'disable'), {
    result: 'acquired',
    pauseKind: 'operator',
  });
  assert.equal(JSON.parse(harness.state.raw).ownerToken, OWNER);
  assert.deepEqual(await clearOperatorPause(harness.store, OWNER), {
    result: 'cleared',
    pauseKind: 'missing',
  });
});

test('disable preserves an existing 401 pause across its owned operator marker', async () => {
  const harness = makeStore(AUTH_PAUSE);
  await armOperatorPause(harness.store, OWNER, 'disable');
  const marker = JSON.parse(harness.state.raw);
  assert.equal(marker.preservedPauseRaw, AUTH_PAUSE);
  assert.deepEqual(await clearOperatorPause(harness.store, OWNER), {
    result: 'cleared',
    pauseKind: 'authorization',
  });
  assert.equal(harness.state.raw, AUTH_PAUSE);
});

test('CAS clear cannot erase a newer authorization pause', async () => {
  const harness = makeStore(null, {
    beforeClear: async (state) => {
      state.raw = AUTH_PAUSE;
    },
  });
  await armOperatorPause(harness.store, OWNER, 'disable');
  assert.deepEqual(await clearOperatorPause(harness.store, OWNER), {
    result: 'not_owned',
    pauseKind: 'authorization',
  });
  assert.equal(harness.state.raw, AUTH_PAUSE);
});

test('restores a concurrent identity failure persisted inside the owned operator marker', async () => {
  const harness = makeStore();
  await armOperatorPause(harness.store, OWNER, 'enable');
  const operator = JSON.parse(harness.state.raw);
  operator.preservedPauseRaw = MISMATCH_PAUSE;
  harness.state.raw = JSON.stringify(operator);
  assert.deepEqual(await clearOperatorPause(harness.store, OWNER), {
    result: 'cleared',
    pauseKind: 'authorization',
  });
  assert.equal(harness.state.raw, MISMATCH_PAUSE);
});

test('rejects unknown pause adoption and strict owner token violations', async () => {
  const harness = makeStore('{"version":1,"reason":"unexpected"}');
  assert.deepEqual(await armOperatorPause(harness.store, OWNER, 'disable'), {
    result: 'blocked',
    pauseKind: 'unknown',
  });
  assert.throws(() => validateOwnerToken(`publisher-rollout:${'a'.repeat(63)}`), /invalid/u);
});

test('rejects nested operator and unknown preserved-pause payload abuse', async () => {
  for (const preservedPauseRaw of [
    buildOperatorMarker(OTHER_OWNER),
    JSON.stringify({ version: 1, reason: 'unexpected' }),
    'malformed',
  ]) {
    const raw = JSON.stringify({
      version: 1,
      reason: 'operator_rollout',
      ownerToken: OTHER_OWNER,
      observedAt: '2026-08-26T12:00:00.000Z',
      preservedPauseRaw,
    });
    assert.deepEqual(classifyPause(raw), { kind: 'unknown', adoptable: false });
    const harness = makeStore(raw);
    assert.deepEqual(await armOperatorPause(harness.store, OWNER, 'disable'), {
      result: 'blocked',
      pauseKind: 'unknown',
    });
    assert.equal(harness.state.raw, raw);
  }
});

test('accepts only fresh exact-bot heartbeats with an exact boolean state', () => {
  const now = Date.parse('2026-08-26T12:00:30.000Z');
  const raw = JSON.stringify({
    version: 1,
    botId: 'se14088825_bot',
    dispatchEnabled: false,
    observedAt: '2026-08-26T12:00:00.000Z',
    instanceId: 'instance-1',
  });
  assert.deepEqual(parseHeartbeat(raw, 'se14088825_bot', now), {
    kind: 'fresh',
    dispatchEnabled: false,
  });
  assert.equal(parseHeartbeat(raw, 'different_bot', now).kind, 'invalid');
  assert.equal(parseHeartbeat(raw, 'se14088825_bot', now + 20_000).kind, 'invalid');
});
