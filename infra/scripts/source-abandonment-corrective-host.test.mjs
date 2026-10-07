import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSourceAbandonmentCorrectiveHostRequest } from './source-abandonment-corrective-host.mjs';
import { CORRECTIVE_RUNTIME_SHA } from './source-abandonment-corrective-identity.mjs';

const request = () => ({
  version: 1,
  controllerSha: 'c'.repeat(40),
  runtimeRequest: {
    version: 1,
    operation: 'apply',
    targetSha: CORRECTIVE_RUNTIME_SHA,
    expectedJournalDigest: 'b'.repeat(64),
    reviewedPreviewDigest: 'd'.repeat(64),
    reviewedInventoryDigest: 'e'.repeat(64),
  },
});
const parse = (value) => parseSourceAbandonmentCorrectiveHostRequest(JSON.stringify(value));

test('corrective envelope preserves the exact existing reviewed runtime request', () => {
  for (const operation of ['apply', 'reconcile', 'retry-preview', 'refreeze-preview']) {
    const value = request();
    value.runtimeRequest.operation = operation;
    if (operation === 'retry-preview') {
      delete value.runtimeRequest.reviewedPreviewDigest;
      delete value.runtimeRequest.reviewedInventoryDigest;
    }
    assert.deepEqual(parse(value), value);
  }
});

test('the corrective entrypoint cannot admit new work or rewrite protected runtime context', () => {
  for (const operation of ['status', 'prepare', 'preflight', 'activate']) {
    const value = request();
    value.runtimeRequest.operation = operation;
    assert.throws(() => parse(value), /corrective_continuation_required/);
  }
  for (const patch of [
    { selection: { ownerWebhookEventIds: ['different'] } },
    { protocol: 'legacy' },
    { abandonBefore: '2026-10-08T00:00:00.000Z' },
    { imageId: 'replacement' },
    { expectedJournalDigest: undefined },
  ]) {
    const value = request();
    Object.assign(value.runtimeRequest, patch);
    assert.throws(() => parse(value));
  }
});

test('controller identity is separate, exact and cannot carry extra fields', () => {
  for (const patch of [
    { controllerSha: 'main' },
    { controllerSha: CORRECTIVE_RUNTIME_SHA },
    { bypass: true },
    { version: 2 },
    { runtimeRequest: null },
  ])
    assert.throws(() => parse({ ...request(), ...patch }));
  assert.throws(() => parseSourceAbandonmentCorrectiveHostRequest(' '.repeat(65537)), /budget/);
});

test('ordinary source attestation remains byte identical to the admitted runtime', () => {
  const after = readFileSync(new URL('./legacy-cold-host.mjs', import.meta.url), 'utf8');
  const functionSource = (source) =>
    source.slice(
      source.indexOf('function sourceIdentity('),
      source.indexOf('\n// FLAG: The host derives'),
    );
  // Frozen from the admitted runtime; CI shallow clones need no historical Git object.
  assert.equal(
    createHash('sha256').update(functionSource(after)).digest('hex'),
    '21e0395e36386ba06555697d573a458d11cb818eb43b4519ee95bed6a3c15b31',
  );
});
