import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionConnectionLedger } from './source-abandonment-session-connection-ledger.mjs';

const connectionName = 'maxim-source-session:023bd9c1-069c-4adc-840c-d46e9069c413';
const identity = (clientId) => ({ clientId, connectionName });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-queue-connection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const parameters = { directory, connectionName, assertLock() {}, ...options };
  return { directory, parameters, ledger: createSessionConnectionLedger(parameters) };
}
test('durable identity survives a new controller and stale CAS cannot replace it', (t) => {
  const { parameters, ledger } = fixture(t);
  assert.equal(ledger.read(), null);
  ledger.compareAndSet(null, identity(10));
  const nextController = createSessionConnectionLedger(parameters);
  assert.deepEqual(nextController.read(), identity(10));
  nextController.compareAndSet(digest(identity(10)), identity(11));
  assert.throws(
    () => ledger.compareAndSet(digest(identity(10)), identity(12)),
    /connection_changed/u,
  );
  assert.deepEqual(ledger.read(), identity(11));
});
for (const phase of ['before_commit', 'after_commit'])
  test(`interruption ${phase} preserves the truthful last durable client`, (t) => {
    const { parameters, ledger } = fixture(t);
    ledger.compareAndSet(null, identity(10));
    const interrupted = createSessionConnectionLedger({
      ...parameters,
      checkpoint(stage) {
        if (stage === phase) throw new Error('interrupted');
      },
    });
    assert.throws(
      () => interrupted.compareAndSet(digest(identity(10)), identity(11)),
      /interrupted/u,
    );
    assert.deepEqual(
      createSessionConnectionLedger(parameters).read(),
      identity(phase === 'before_commit' ? 10 : 11),
    );
  });
test('foreign nonce, extra fields and lost deploy lock cannot alter the ledger', (t) => {
  const { directory, parameters, ledger } = fixture(t);
  ledger.compareAndSet(null, identity(10));
  const before = readFileSync(join(directory, 'queue-connection.json'));
  for (const value of [
    { ...identity(11), connectionName: connectionName.replace('023b', '123b') },
    { ...identity(11), extra: true },
  ])
    assert.throws(() => ledger.compareAndSet(digest(identity(10)), value), /identity_refused/u);
  const locked = createSessionConnectionLedger({
    ...parameters,
    assertLock() {
      throw new Error('lock-lost');
    },
  });
  assert.throws(() => locked.compareAndSet(digest(identity(10)), identity(11)), /lock-lost/u);
  assert.deepEqual(readFileSync(join(directory, 'queue-connection.json')), before);
});
for (const shape of ['mode', 'symlink', 'hardlink', 'malformed'])
  test(`refuses ${shape} ledger evidence`, (t) => {
    const { directory, ledger } = fixture(t);
    const file = join(directory, 'queue-connection.json'),
      other = join(directory, 'other.json');
    writeFileSync(other, JSON.stringify(identity(10)), { mode: 0o600 });
    if (shape === 'symlink') symlinkSync(other, file);
    else if (shape === 'hardlink') linkSync(other, file);
    else {
      writeFileSync(file, shape === 'malformed' ? '{' : JSON.stringify(identity(10)), {
        mode: 0o600,
      });
      if (shape === 'mode') chmodSync(file, 0o644);
    }
    assert.throws(() => ledger.read());
  });
