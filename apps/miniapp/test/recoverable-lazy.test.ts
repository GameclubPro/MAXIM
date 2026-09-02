import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRecoverableNamedComponent } from '../src/lib/recoverable-lazy';

test('recoverable lazy loader returns the named component on success', async () => {
  const Component = () => null;
  const loaded = await loadRecoverableNamedComponent(async () => ({ Component }), 'Component');

  assert.equal(loaded.default, Component);
});

test('recoverable lazy loader handles a rejected stale chunk without rejecting the route', async () => {
  const Failure = () => null;
  const cause = new TypeError('Failed to fetch dynamically imported module: /assets/stale.js');
  let recoveredExport = '';
  let recoveredCause: unknown;

  const loaded = await loadRecoverableNamedComponent(
    async () => Promise.reject(cause),
    'AutoReplyMatchTester',
    {
      failureComponent: Failure,
      recover: (exportName, error) => {
        recoveredExport = exportName;
        recoveredCause = error;
        return false;
      },
    },
  );

  assert.equal(loaded.default, Failure);
  assert.equal(recoveredExport, 'AutoReplyMatchTester');
  assert.equal(recoveredCause, cause);
});

test('recoverable lazy loader still returns the fallback when automatic recovery throws', async () => {
  const Failure = () => null;
  const loaded = await loadRecoverableNamedComponent(
    async () => Promise.reject(new Error('stale chunk')),
    'BroadcastContentComposer',
    {
      failureComponent: Failure,
      recover: () => {
        throw new Error('session storage unavailable');
      },
    },
  );

  assert.equal(loaded.default, Failure);
});
