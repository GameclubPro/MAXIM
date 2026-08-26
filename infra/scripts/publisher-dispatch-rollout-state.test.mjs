import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  patchPublisherDispatchEnv,
  readPublisherDispatchEnv,
  verifyPublisherComposeConfig,
  verifyPublisherRuntimeEnvironment,
  writeFileAtomic,
} from './publisher-dispatch-rollout-state.mjs';

test('patches only the publisher dispatch assignment and preserves every unrelated byte', () => {
  const original =
    '# production\r\nSECRET="keep = this # exactly"\r\nMAX_PUBLISHER_DISPATCH_ENABLED=false\r\nUNICODE=тест\r\n';
  const patched = patchPublisherDispatchEnv(original, true);
  assert.equal(
    patched,
    '# production\r\nSECRET="keep = this # exactly"\r\nMAX_PUBLISHER_DISPATCH_ENABLED=true\r\nUNICODE=тест\r\n',
  );
  assert.deepEqual(readPublisherDispatchEnv(patched), { configured: true, enabled: true });
});

test('uses the fail-closed false default and appends without rewriting existing contents', () => {
  const original = 'A=one\nB=two';
  assert.deepEqual(readPublisherDispatchEnv(original), { configured: false, enabled: false });
  assert.equal(
    patchPublisherDispatchEnv(original, false),
    'A=one\nB=two\nMAX_PUBLISHER_DISPATCH_ENABLED=false',
  );
});

test('rejects duplicate, ambiguous, oversized, and non-boolean dispatch assignments', () => {
  assert.throws(
    () =>
      patchPublisherDispatchEnv(
        'MAX_PUBLISHER_DISPATCH_ENABLED=false\nMAX_PUBLISHER_DISPATCH_ENABLED=true\n',
        true,
      ),
    /Duplicate dotenv key/u,
  );
  assert.throws(
    () => patchPublisherDispatchEnv('MAX_PUBLISHER_DISPATCH_ENABLED="false"\n', true),
    /must be exactly true or false/u,
  );
  assert.throws(
    () => patchPublisherDispatchEnv(Buffer.alloc(1024 * 1024 + 1, 97), true),
    /at most/u,
  );
  assert.throws(
    () => patchPublisherDispatchEnv(Buffer.from([0xff]), true),
    /encoded data was not valid|encoding/u,
  );
});

test('atomically replaces the dotenv while preserving its mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'publisher-env-test-'));
  const path = join(directory, '.env');
  writeFileSync(path, 'A=1\nMAX_PUBLISHER_DISPATCH_ENABLED=false\n');
  chmodSync(path, 0o640);
  writeFileAtomic(path, patchPublisherDispatchEnv(readFileSync(path), true));
  assert.equal(readFileSync(path, 'utf8'), 'A=1\nMAX_PUBLISHER_DISPATCH_ENABLED=true\n');
  assert.equal(statSync(path).mode & 0o777, 0o640);
});

test('verifies exact service identity and dispatch parity', () => {
  assert.equal(
    verifyPublisherRuntimeEnvironment(
      {
        APP_SERVICE_NAME: 'api-publisher',
        APP_ROLE: 'publisher',
        MAX_PUBLISHER_DISPATCH_ENABLED: 'true',
      },
      true,
      'api-publisher',
    ),
    true,
  );
  assert.equal(
    verifyPublisherRuntimeEnvironment(
      {
        APP_SERVICE_NAME: 'api-publisher',
        APP_ROLE: 'action',
        MAX_PUBLISHER_DISPATCH_ENABLED: 'true',
      },
      true,
      'api-publisher',
    ),
    false,
  );
  assert.equal(
    verifyPublisherRuntimeEnvironment(
      {
        APP_SERVICE_NAME: 'api-publisher',
        APP_ROLE: 'publisher',
        MAX_PUBLISHER_DISPATCH_ENABLED: 'false',
      },
      'any',
      'api-publisher',
    ),
    true,
  );
  assert.equal(
    verifyPublisherRuntimeEnvironment(
      {
        APP_SERVICE_NAME: 'api-admin',
        APP_ROLE: 'admin',
      },
      'default-false',
      'api-admin',
    ),
    true,
  );
});

test('requires the exact 13-service Compose topology on one immutable image', () => {
  const image = `maxim-api:${'a'.repeat(40)}`;
  const roleByService = {
    'api-ingress': 'ingress',
    'api-admin': 'admin',
    'api-enqueue': 'enqueue',
    'api-moderation': 'moderation',
    'api-moderation-critical': 'moderation',
    'api-moderation-join': 'moderation',
    'api-moderation-realtime-b': 'moderation',
    'api-moderation-realtime-c': 'moderation',
    'api-moderation-realtime-d': 'moderation',
    'api-moderation-background': 'moderation',
    'api-media-analysis': 'moderation',
    'api-action': 'action',
    'api-publisher': 'publisher',
  };
  const services = Object.fromEntries(
    Object.entries(roleByService).map(([service, role]) => [
      service,
      {
        image,
        environment: {
          APP_SERVICE_NAME: service,
          APP_ROLE: role,
          MAX_PUBLISHER_DISPATCH_ENABLED: 'false',
        },
      },
    ]),
  );
  assert.equal(verifyPublisherComposeConfig({ services }, false, image), true);
  services['api-extra'] = {
    image,
    environment: {
      APP_SERVICE_NAME: 'api-extra',
      APP_ROLE: 'action',
      MAX_PUBLISHER_DISPATCH_ENABLED: 'false',
    },
  };
  assert.equal(verifyPublisherComposeConfig({ services }, false, image), false);
});
