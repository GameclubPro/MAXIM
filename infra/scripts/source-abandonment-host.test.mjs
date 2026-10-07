import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertColdProtocolContext, parseLegacyColdHostRequest } from './legacy-cold-host.mjs';
import { parseSourceAbandonmentHostRequest } from './source-abandonment-host.mjs';

const protocol = 'source-abandonment-v1';
const request = () => ({
  version: 1,
  operation: 'prepare',
  targetSha: 'a'.repeat(40),
  selection: {
    ownerWebhookEventIds: ['owner-b', 'owner-a'],
    majorBotIds: ['major'],
    protocol,
    abandonBefore: '2026-10-07T03:00:00.000Z',
  },
});
const now = Date.parse('2026-10-07T05:00:00.000Z');
test('source abandonment binds a fixed elapsed cutoff and at most eight distinct owners', () => {
  const result = parseSourceAbandonmentHostRequest(JSON.stringify(request()), now);
  assert.deepEqual(result.selection.ownerWebhookEventIds, ['owner-a', 'owner-b']);
  assert.equal(result.selection.abandonBefore, request().selection.abandonBefore);
  assert.equal(result.selection.protocol, protocol);
  for (const patch of [
    { protocol: 'legacy' },
    { protocol: undefined },
    { abandonBefore: '2026-10-07T03:00:00Z' },
    { abandonBefore: '2026-10-07T06:00:00.000Z' },
    { abandonBefore: 'invalid' },
    { ownerWebhookEventIds: Array.from({ length: 9 }, (_, n) => `owner-${n}`) },
    { userId: 'global-user' },
  ])
    assert.throws(() =>
      parseSourceAbandonmentHostRequest(
        JSON.stringify({
          ...request(),
          selection: { ...request().selection, ...patch },
        }),
        now,
      ),
    );
  assert.throws(
    () => parseLegacyColdHostRequest(JSON.stringify(request())),
    /unknown_request_field/,
  );
});
test('review operations cannot change selection, cutoff or protocol', () => {
  const apply = {
    version: 1,
    operation: 'apply',
    targetSha: 'a'.repeat(40),
    expectedJournalDigest: 'b'.repeat(64),
    reviewedPreviewDigest: 'c'.repeat(64),
    reviewedInventoryDigest: 'd'.repeat(64),
  };
  assert.deepEqual(parseSourceAbandonmentHostRequest(JSON.stringify(apply), now), apply);
  assert.throws(() =>
    parseSourceAbandonmentHostRequest(
      JSON.stringify({ ...apply, selection: request().selection }),
      now,
    ),
  );
});
test('a shared maintenance journal never crosses recovery domains', () => {
  assert.doesNotThrow(() => assertColdProtocolContext('legacy', { selection: {} }));
  assert.doesNotThrow(() =>
    assertColdProtocolContext(protocol, { protocol, selection: request().selection }),
  );
  assert.throws(() => assertColdProtocolContext(protocol, { selection: {} }), /context_changed/);
  assert.throws(
    () => assertColdProtocolContext('legacy', { protocol, selection: request().selection }),
    /context_changed/,
  );
  assert.throws(
    () => assertColdProtocolContext(protocol, { protocol, selection: {} }),
    /selection_changed/,
  );
});
test('modern entrypoint retains inherited deployment lock and twenty GiB admission reserve', () => {
  const wrapper = readFileSync(new URL('./vps-source-abandonment.sh', import.meta.url), 'utf8');
  assert.ok(wrapper.indexOf('acquire_deploy_lock') < wrapper.indexOf('exec node'));
  assert.ok(wrapper.includes('MAXIM_EXPECTED_DEPLOY_SHA'));
  const host = readFileSync(new URL('./legacy-cold-host.mjs', import.meta.url), 'utf8');
  assert.ok(host.includes("protocol === 'source-abandonment-v1' ? 20n : 10n"));
});
