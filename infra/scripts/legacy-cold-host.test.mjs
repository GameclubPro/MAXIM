import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLegacyColdHostRequest, readLegacyColdPublisherCatalog } from './legacy-cold-host.mjs';

test('pending pre-drain blocks every stock cold entry before lock, source or client work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-predrain-cold-host-'));
  const pending = join(directory, 'pending');
  try {
    for (const kind of ['partial-file', 'dangling-symlink']) {
      if (kind === 'partial-file') writeFileSync(pending, '{', { mode: 0o600 });
      else symlinkSync('absent', pending);
      // FLAG: The child executes the real entrypoint. Only its fixed sentinel
      // lstat is redirected to a local fixture; process execution is forbidden.
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.lstatSync;
fs.lstatSync = (path, ...args) => original(path === '/var/lib/maxim-deploy/queue-predrain-pending.json' ? ${JSON.stringify(pending)} : path, ...args);
childProcess.execFileSync = () => { throw new Error('unexpected_process_execution'); };
syncBuiltinESMExports();
delete process.env.MAXIM_DEPLOY_LOCK_VERSION;
const { runLegacyColdHost } = await import(${JSON.stringify(new URL('./legacy-cold-host.mjs', import.meta.url).href)});
for (const operation of ['preflight', 'prepare', 'apply', 'reconcile', 'retry-preview', 'refreeze-preview', 'abort-before-install']) {
  const options = { protocol: 'source-abandonment-v1', ...(['refreeze-preview','abort-before-install'].includes(operation) ? {controllerSha:'c'.repeat(40)} : {}) };
  await assert.rejects(runLegacyColdHost({operation}, options), /queue_predrain_restoration_required/);
}
await assert.rejects(runLegacyColdHost({operation:'status'}), /protected deploy lock unavailable/);
`,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(result.status, 0, result.stderr);
      rmSync(pending);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('host selection is finite and canonical, with distinct online and exact apply requests', () => {
  const request = {
    version: 1,
    operation: 'preflight',
    targetSha: 'a'.repeat(40),
    selection: { ownerWebhookEventIds: ['second', 'first'], majorBotIds: ['major'] },
  };
  assert.deepEqual(
    parseLegacyColdHostRequest(JSON.stringify(request)).selection.ownerWebhookEventIds,
    ['first', 'second'],
  );
  assert.deepEqual(parseLegacyColdHostRequest('{"version":1,"operation":"status"}'), {
    version: 1,
    operation: 'status',
  });
  const retry = {
    version: 1,
    operation: 'retry-preview',
    targetSha: 'a'.repeat(40),
    expectedJournalDigest: 'b'.repeat(64),
  };
  assert.deepEqual(parseLegacyColdHostRequest(JSON.stringify(retry)), retry);
  assert.deepEqual(
    parseLegacyColdHostRequest(JSON.stringify({ ...retry, operation: 'abort-before-install' })),
    { ...retry, operation: 'abort-before-install' },
  );
  assert.throws(
    () => parseLegacyColdHostRequest(JSON.stringify({ ...retry, selection: request.selection })),
    /unknown_request_field/,
  );
  assert.throws(
    () => parseLegacyColdHostRequest(JSON.stringify({ ...request, operation: 'apply' })),
    /unknown_request_field/,
  );
  for (const selection of [
    { ownerWebhookEventIds: ['first', 'first'], majorBotIds: ['major'] },
    { ownerWebhookEventIds: ['first'], majorBotIds: [] },
    { ownerWebhookEventIds: ['../path'], majorBotIds: ['major'] },
  ])
    assert.throws(
      () => parseLegacyColdHostRequest(JSON.stringify({ ...request, selection })),
      /finite_selection/,
    );
});

test('neither an environment override nor a guessed source enables a host request', () => {
  for (const value of [
    { version: 1, operation: 'status', bypass: true },
    { version: 1, operation: 'activate' },
    { version: 1, operation: 'prepare', targetSha: 'main' },
    {
      version: 1,
      operation: 'apply',
      targetSha: 'a'.repeat(40),
      expectedJournalDigest: 'b'.repeat(64),
      reviewedPreviewDigest: 'c'.repeat(64),
    },
  ])
    assert.throws(() => parseLegacyColdHostRequest(JSON.stringify(value)));
  assert.throws(() => parseLegacyColdHostRequest(' '.repeat(65537)), /budget/);
});

test('Publisher catalog is separate, generation-derived, exact and never supplied by an operator', () => {
  const admin = ['MAX_PUBLISHER_BOT_ID=publisher', 'MAX_BOT_ID=major'];
  const publisher = [
    'MAX_PUBLISHER_BOT_ID=publisher',
    'MAX_BOT_ID=publisher',
    'APP_ROLE=publisher',
  ];
  assert.equal(readLegacyColdPublisherCatalog(admin, publisher, ['major']), 'publisher');
  for (const [a, p, m] of [
    [[], publisher, ['major']],
    [[...admin, 'MAX_PUBLISHER_BOT_ID=publisher'], publisher, ['major']],
    [admin, [...publisher, 'MAX_BOT_ID=publisher'], ['major']],
    [
      admin,
      publisher.map((value) => (value === 'MAX_BOT_ID=publisher' ? 'MAX_BOT_ID=other' : value)),
      ['major'],
    ],
    [
      admin,
      publisher.map((value) => (value === 'APP_ROLE=publisher' ? 'APP_ROLE=admin' : value)),
      ['major'],
    ],
    [admin, publisher, ['major', 'publisher']],
    [['MAX_PUBLISHER_BOT_ID= publisher'], publisher, ['major']],
  ])
    assert.throws(() => readLegacyColdPublisherCatalog(a, p, m), /publisher_catalog_unproved/);
  const request = {
    version: 1,
    operation: 'preflight',
    targetSha: 'a'.repeat(40),
    selection: { ownerWebhookEventIds: ['owner'], majorBotIds: ['major'] },
  };
  assert.throws(
    () => parseLegacyColdHostRequest(JSON.stringify({ ...request, publisherBotId: 'publisher' })),
    /unknown_request_field/,
  );
  assert.throws(
    () =>
      parseLegacyColdHostRequest(
        JSON.stringify({
          ...request,
          selection: { ...request.selection, publisherBotId: 'publisher' },
        }),
      ),
    /unknown_request_field/,
  );
});
