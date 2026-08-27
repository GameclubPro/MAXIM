import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildPublisherSecretBundle,
  derivePublisherDialogSigningKey,
  validatePublisherSecretBundle,
} from './publisher-secret-bundle.mjs';

const token = 'T'.repeat(48);

test('derives a validation-only WebAppData key without copying the token', () => {
  const bundle = buildPublisherSecretBundle(`${token}\n`, 'se14088825_bot');
  const expectedKey = createHmac('sha256', 'WebAppData').update(token).digest('base64');

  assert.equal(bundle.initData.keys[0], expectedKey);
  assert.notEqual(bundle.initData.keys[0], token);
  assert.equal(Buffer.from(bundle.initData.keys[0], 'base64').length, 32);
  assert.equal(bundle.dialogSigning.keys[0], derivePublisherDialogSigningKey(token));
  assert.notEqual(bundle.dialogSigning.keys[0], bundle.initData.keys[0]);
  assert.doesNotThrow(() => validatePublisherSecretBundle(bundle));
});

test('stages a domain-separated dialog key from older bundles without widening bot-token access', () => {
  const bundle = buildPublisherSecretBundle(token, 'se14088825_bot');
  const legacyBundle = { ...bundle };
  delete legacyBundle.dialogSigning;
  const validated = validatePublisherSecretBundle(legacyBundle);

  assert.equal(validated.dialogSigning.keys[0], derivePublisherDialogSigningKey(token));
});

test('pack and stage create only bounded owner-private files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-publisher-bundle-'));
  const tokenPath = join(directory, 'token');
  const bundlePath = join(directory, 'bundle.json');
  const outputDirectory = join(directory, 'output');
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });

  try {
    const pack = spawnSync(
      process.execPath,
      [
        'infra/scripts/publisher-secret-bundle.mjs',
        'pack',
        tokenPath,
        'se14088825_bot',
        bundlePath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(pack.status, 0, pack.stderr);
    assert.equal(pack.stdout, '');
    const stage = spawnSync(
      process.execPath,
      ['infra/scripts/publisher-secret-bundle.mjs', 'stage', bundlePath, outputDirectory],
      { encoding: 'utf8' },
    );
    assert.equal(stage.status, 0, stage.stderr);
    assert.equal(stage.stdout, '');

    for (const name of [
      'publik-bot-token',
      'publik-webhook.json',
      'publik-init-data-keys.json',
      'publik-dialog-signing-keys.json',
    ]) {
      assert.equal(statSync(join(outputDirectory, name)).mode & 0o777, 0o600);
    }
    assert.equal(readFileSync(join(outputDirectory, 'publik-bot-token'), 'utf8').trim(), token);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects malformed and mismatched bundle fields', () => {
  const bundle = buildPublisherSecretBundle(token, 'se14088825_bot');
  assert.throws(
    () => validatePublisherSecretBundle({ ...bundle, actionToken: 'short' }),
    /fields are invalid/u,
  );
  assert.throws(
    () =>
      validatePublisherSecretBundle({
        ...bundle,
        webhook: { ...bundle.webhook, botId: 'different-bot' },
      }),
    /fields are invalid/u,
  );
});
