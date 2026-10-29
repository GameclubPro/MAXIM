import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkPostgresBackupHealth } from './check-postgres-backup-health.mjs';

test('backup health requires independent readback and recent isolated restore, not dump existence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maxim-backup-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-13T10:00:00Z');
  const dump = 'maxim_20261013T090000Z.dump';
  await writeFile(join(dir, dump), 'unverified bytes');
  assert.equal((await checkPostgresBackupHealth(dir, now)).ok, false);
  const common = {
    schemaVersion: 1,
    dump,
    dumpSha256: 'a'.repeat(64),
    verifiedAt: new Date(now - 3600_000).toISOString(),
  };
  await writeFile(
    join(dir, `${dump}.remote-verified.json`),
    JSON.stringify({
      ...common,
      cipherSha256: 'b'.repeat(64),
      verification: 'full_ciphertext_readback',
    }),
  );
  assert.deepEqual((await checkPostgresBackupHealth(dir, now)).problems, ['restore_overdue']);
  await writeFile(
    join(dir, `${dump}.restore-verified.json`),
    JSON.stringify({
      ...common,
      network: 'none',
      verification: 'isolated_restore_and_authority_schema',
    }),
  );
  assert.equal((await checkPostgresBackupHealth(dir, now)).ok, true);
  assert.deepEqual((await checkPostgresBackupHealth(dir, now + 29 * 3600_000)).problems, [
    'independent_backup_overdue',
  ]);
  assert.deepEqual((await checkPostgresBackupHealth(dir, now + 9 * 86400_000)).problems, [
    'independent_backup_overdue',
    'restore_overdue',
  ]);
});

test('backup health refuses future evidence and symlinked receipts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maxim-backup-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dump = 'maxim_20261013T090000Z.dump';
  const file = join(dir, `${dump}.remote-verified.json`);
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      dump,
      dumpSha256: 'a'.repeat(64),
      cipherSha256: 'b'.repeat(64),
      verifiedAt: new Date(Date.now() + 86400_000).toISOString(),
      verification: 'full_ciphertext_readback',
    }),
  );
  assert.ok((await checkPostgresBackupHealth(dir)).problems.includes('invalid_receipt'));
  await symlink(file, join(dir, `${dump}.restore-verified.json`));
  assert.equal((await checkPostgresBackupHealth(dir)).ok, false);
});

test('Lastik health cannot be satisfied by primary receipts or a mismatched profile', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'eraser-backup-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now(),
    dump = 'eraser_20261029T000000Z.dump';
  const receipt = {
    schemaVersion: 1,
    profile: 'eraser',
    dump,
    dumpSha256: 'a'.repeat(64),
    verifiedAt: new Date(now).toISOString(),
  };
  for (const [suffix, extra] of [
    ['remote', { cipherSha256: 'b'.repeat(64), verification: 'full_ciphertext_readback' }],
    [
      'restore',
      {
        schemaDigest: 'c'.repeat(64),
        network: 'none',
        verification: 'isolated_restore_and_eraser_schema',
      },
    ],
  ])
    await writeFile(
      join(dir, `${dump}.${suffix}-verified.json`),
      JSON.stringify({ ...receipt, ...extra }),
    );
  assert.equal((await checkPostgresBackupHealth(dir, now, 'eraser')).ok, true);
  assert.equal((await checkPostgresBackupHealth(dir, now, 'maxim')).ok, false);
  await writeFile(
    join(dir, `${dump}.restore-verified.json`),
    JSON.stringify({
      ...receipt,
      profile: 'maxim',
      schemaDigest: 'c'.repeat(64),
      network: 'none',
      verification: 'isolated_restore_and_eraser_schema',
    }),
  );
  assert.ok(
    (await checkPostgresBackupHealth(dir, now, 'eraser')).problems.includes('invalid_receipt'),
  );
  await assert.rejects(checkPostgresBackupHealth(dir, now, 'arbitrary'));
});
