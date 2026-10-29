import { opendir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkPostgresBackupHealth(directory, now = Date.now(), profile = 'maxim') {
  if (!['maxim', 'eraser'].includes(profile)) throw new Error('Unknown backup profile');
  const receipts = { independent: [], restore: [] };
  let entries = 0;
  const problems = [];
  try {
    for await (const entry of await opendir(directory)) {
      if (++entries > 512) {
        problems.push('directory_cap_exceeded');
        break;
      }
      const match = new RegExp(
        '^' + profile + '_\\d{8}T\\d{6}Z\\.dump\\.(remote|restore)-verified\\.json$',
      ).exec(entry.name);
      if (!match) continue;
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 4096) {
        problems.push('invalid_receipt');
        continue;
      }
      try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        const at = Date.parse(value.verifiedAt);
        const kind = match[1] === 'remote' ? 'independent' : 'restore';
        const expected =
          kind === 'independent'
            ? 'full_ciphertext_readback'
            : profile === 'eraser'
              ? 'isolated_restore_and_eraser_schema'
              : 'isolated_restore_and_authority_schema';
        if (
          value.schemaVersion !== 1 ||
          (profile === 'eraser'
            ? value.profile !== 'eraser'
            : value.profile !== undefined && value.profile !== 'maxim') ||
          (kind === 'restore' &&
            profile === 'eraser' &&
            !/^[a-f0-9]{64}$/.test(value.schemaDigest ?? '')) ||
          value.verification !== expected ||
          !/^[a-f0-9]{64}$/.test(value.dumpSha256) ||
          !Number.isFinite(at) ||
          at > now + 60_000 ||
          value.dump !== entry.name.split('.dump.')[0] + '.dump' ||
          (kind === 'independent' && !/^[a-f0-9]{64}$/.test(value.cipherSha256)) ||
          (kind === 'restore' && value.network !== 'none')
        ) {
          problems.push('invalid_receipt');
          continue;
        }
        receipts[kind].push(at);
      } catch {
        problems.push('invalid_receipt');
      }
    }
  } catch {
    problems.push('receipt_directory_unavailable');
  }
  const age = (kind) =>
    receipts[kind].length ? Math.max(0, now - Math.max(...receipts[kind])) : null;
  const independentAgeMs = age('independent');
  const restoreAgeMs = age('restore');
  if (independentAgeMs === null || independentAgeMs > 28 * 60 * 60_000)
    problems.push('independent_backup_overdue');
  if (restoreAgeMs === null || restoreAgeMs > 8 * 24 * 60 * 60_000)
    problems.push('restore_overdue');
  return {
    schemaVersion: 1,
    profile,
    ok: problems.length === 0,
    observedAt: new Date(now).toISOString(),
    evidence: 'verified_receipts',
    independentAgeMs,
    restoreAgeMs,
    problems: [...new Set(problems)],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const directory = process.env.MAXIM_BACKUP_DIR;
  if (!directory || directory !== resolve(directory) || process.argv.length > 2) {
    throw new Error('Set an absolute MAXIM_BACKUP_DIR; this command accepts no arguments.');
  }
  const profile = process.env.MAXIM_BACKUP_PROFILE ?? 'maxim';
  const report = await checkPostgresBackupHealth(
    profile === 'eraser' ? join(directory, 'eraser') : directory,
    Date.now(),
    profile,
  );
  process.stdout.write(JSON.stringify(report) + '\n');
  if (!report.ok) process.exitCode = 1;
}
