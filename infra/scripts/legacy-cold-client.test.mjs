import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createLegacyColdClient } from './legacy-cold-client.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cold-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceSha = 'b'.repeat(40);
  const imageId = `sha256:${'a'.repeat(64)}`;
  const controllerNonce = '11111111-1111-4111-8111-111111111111';
  const id = 'c'.repeat(64);
  const environmentFile = join(directory, 'client.env');
  const inventoryPath = join(directory, 'inventory.json');
  const queueControlPath = join(directory, 'queue-control.cjs');
  const queueControlBytes = 'reviewed fixture queue controller';
  writeFileSync(queueControlPath, queueControlBytes, { mode: 0o600 });
  writeFileSync(
    environmentFile,
    'DATABASE_URL=postgresql://private.fixture/db\nREDIS_URL=redis://private.fixture/0\n',
    { mode: 0o600 },
  );
  writeFileSync(inventoryPath, '{}\n', { mode: 0o600 });
  const calls = [];
  let exists = false;
  const state = {
    failStart: false,
    failCreate: false,
    failRemove: false,
    foreign: false,
    response: { version: 1, activationAuthorized: false, state: 'SEALED' },
    responseExit: false,
  };
  const run = (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'ps') return exists ? id : '';
    if (args[0] === 'image')
      return JSON.stringify([
        { Id: imageId, Config: { Labels: { 'org.opencontainers.image.revision': sourceSha } } },
      ]);
    if (args[0] === 'create') {
      exists = true;
      if (state.failCreate) throw new Error('private create response lost');
      return id;
    }
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Id: id,
          Image: imageId,
          Name: `/maxim-legacy-recovery-${state.foreign ? 'foreign' : controllerNonce}`,
          Config: { Labels: { 'com.maxim.legacy-recovery-client': controllerNonce } },
        },
      ]);
    if (args[0] === 'start') {
      if (state.failStart) throw new Error('private inventory payload must not escape');
      if (state.responseExit)
        throw Object.assign(new Error('private Docker stderr'), {
          status: 1,
          stdout: JSON.stringify(state.response),
        });
      return JSON.stringify(state.response);
    }
    if (args[0] === 'rm') {
      if (state.failRemove) throw new Error('private remove failure');
      exists = false;
      return id;
    }
    throw new Error('unexpected Docker call');
  };
  const client = createLegacyColdClient({
    ...options,
    sourceSha,
    imageId,
    controllerNonce,
    networkId: 'd'.repeat(64),
    environmentFile,
    inventoryPath,
    queueControlPath,
    queueControlSha256: createHash('sha256').update(queueControlBytes).digest('hex'),
    run,
  });
  return {
    client,
    calls,
    state,
    environmentFile,
    inventoryPath,
    queueControlPath,
    exists: () => exists,
    id,
  };
}

test('modern exact-source client uses only its fixed collector/store and separate environment domain', (t) => {
  const h = fixture(t, { protocol: 'source-abandonment-v1' });
  h.client.invoke('store', { version: 1, operation: 'readback' });
  const create = h.calls.find((call) => call.args[0] === 'create').args;
  assert.ok(create.includes('apps/api/dist/apps/api/src/scripts/source-abandonment-store.js'));
  assert.ok(create.includes('APP_SERVICE_NAME=source-abandonment-store'));
  assert.ok(create.includes('MAXIM_SOURCE_ABANDONMENT_OFFLINE=1'));
  assert.ok(create.includes('MAXIM_SOURCE_ABANDONMENT_STORE_MODE=readback'));
  assert.equal(
    create.filter((arg) => arg === 'MAXIM_SOURCE_ABANDONMENT_PROTOCOL=source-abandonment-v1')
      .length,
    1,
  );
  assert.equal(
    create.some((arg) => arg.startsWith('MAXIM_LEGACY_RECOVERY_')),
    false,
  );
  assert.equal(h.exists(), false);
  h.calls.length = 0;
  h.state.response = { version: 1, decision: 'READY_FOR_COLD_REVIEW', activationAuthorized: false };
  h.client.invoke('admission', { version: 1, operation: 'admission_preview' });
  const collect = h.calls.find((call) => call.args[0] === 'create').args;
  assert.ok(collect.includes('apps/api/dist/apps/api/src/scripts/source-abandonment-collect.js'));
  assert.ok(collect.includes('APP_SERVICE_NAME=source-abandonment-collect'));
  assert.equal(
    collect.some((arg) => arg.includes('STORE_MODE=')),
    false,
  );
});

test('unknown controller protocol is refused before creating a client', (t) => {
  assert.throws(() => fixture(t, { protocol: 'source-abandonment-v2' }), /invalid_client_binding/);
});

test('store uses an immutable bounded client with readonly inventory and exact cleanup', (t) => {
  const h = fixture(t);
  const result = h.client.invoke('store', { version: 1, operation: 'readback' });
  assert.equal(result.state, 'SEALED');
  assert.equal(h.exists(), false);
  const create = h.calls.find((call) => call.args[0] === 'create').args;
  assert.ok(create.includes('MAXIM_LEGACY_RECOVERY_STORE_MODE=readback'));
  assert.ok(create.includes('--read-only'));
  assert.ok(create.includes('ALL'));
  assert.ok(create.includes('--memory'));
  assert.ok(create.includes('0.5'));
  assert.ok(
    create.includes(
      `type=bind,source=${h.inventoryPath},target=/run/maxim-legacy-recovery/inventory.json,readonly`,
    ),
  );
  assert.equal(create.includes('--privileged'), false);
  assert.deepEqual(h.calls.find((call) => call.args[0] === 'rm').args, ['rm', '-f', h.id]);
  assert.equal(h.calls.at(-1).args[0], 'ps');
  assert.equal(h.calls.filter((call) => call.args[0] === 'start').length, 1);
});

test('a bounded read-only DENY survives exit 1 without leaking stderr or allowing a writer retry', (t) => {
  const h = fixture(t);
  h.state.response = {
    version: 1,
    operation: 'admission_preview',
    decision: 'DENY',
    applied: false,
    activationAuthorized: false,
    issues: [{ code: 'source_unproved' }],
  };
  h.state.responseExit = true;
  const result = h.client.invoke('admission', { version: 1, operation: 'admission_preview' });
  assert.equal(result.decision, 'DENY');
  assert.equal(h.exists(), false);
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'install' }),
    /result_unknown/,
  );
  assert.equal(h.exists(), false);
});

test('queue operations bind a reviewed helper and operation-specific owner without adoption', (t) => {
  const h = fixture(t);
  h.state.response = { queueCount: 24, pausedCount: 24, activeCount: 0 };
  assert.equal(h.client.invoke('queues', { version: 1, operation: 'wait-drained' }).version, 1);
  const create = h.calls.find((call) => call.args[0] === 'create').args;
  assert.equal(create.at(-1), 'wait-drained');
  assert.ok(
    create.some((arg) => /^MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN=rollout:[0-9a-f]{64}$/u.test(arg)),
  );
  assert.ok(create.includes('MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_MS=1000'));
  assert.equal(
    create.some((arg) => arg.includes('ADOPT_EXISTING')),
    false,
  );
  assert.equal(h.exists(), false);
  writeFileSync(h.queueControlPath, 'changed helper');
  assert.throws(
    () => h.client.invoke('queues', { version: 1, operation: 'resume' }),
    /binding_unproved/,
  );
});

test('invalid queue output never proves quiescence and the client is still removed', (t) => {
  const h = fixture(t);
  h.state.response = { queueCount: 23, pausedCount: 23, activeCount: 0 };
  assert.throws(
    () => h.client.invoke('queues', { version: 1, operation: 'wait-drained' }),
    /result_unknown/,
  );
  assert.equal(h.exists(), false);
});

for (const field of ['failCreate', 'failStart'])
  test(`lost ${field} response is cleaned without a retry or private error`, (t) => {
    const h = fixture(t);
    h.state[field] = true;
    assert.throws(
      () => h.client.invoke('store', { version: 1, operation: 'install' }),
      (error) =>
        error.message === 'client_result_unknown' &&
        error.outcomeUnknown === true &&
        error.cause === undefined,
    );
    assert.equal(h.exists(), false);
    assert.equal(h.calls.filter((call) => call.args[0] === 'create').length, 1);
    assert.ok(h.calls.filter((call) => call.args[0] === 'start').length <= 1);
  });

test('unknown removal and foreign ownership never become permission for another client', (t) => {
  const h = fixture(t);
  h.state.failRemove = true;
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'install' }),
    /client_removal_unproved/,
  );
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'readback' }),
    /requires_cleanup/,
  );
  h.state.foreign = true;
  const removals = h.calls.filter((call) => call.args[0] === 'rm').length;
  assert.throws(() => h.client.remove(), /ownership_unproved/);
  assert.equal(h.calls.filter((call) => call.args[0] === 'rm').length, removals);
});

test('MAX credentials, oversized stdin and unsafe input files are refused before creation', (t) => {
  const h = fixture(t);
  writeFileSync(
    h.environmentFile,
    'DATABASE_URL=postgresql://fixture/db\nMAX_BOT_TOKEN=not-a-real-token\n',
  );
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'install' }),
    /environment_not_allowlisted/,
  );
  assert.throws(
    () => h.client.invoke('store', { version: 1, input: 'x'.repeat(65_536) }),
    /request_budget/,
  );
  writeFileSync(h.environmentFile, 'DATABASE_URL=postgresql://fixture/db\n');
  chmodSync(h.inventoryPath, 0o644);
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'install' }),
    /unsafe_client_input/,
  );
  assert.equal(h.calls.length, 0);
});
