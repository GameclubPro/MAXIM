import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function eraserRestoreManifest() {
  const directory = fileURLToPath(new URL('../../apps/eraser/migrations/', import.meta.url));
  return readdirSync(directory)
    .filter((name) => /^\d[\w-]*\.sql$/.test(name))
    .sort()
    .map((name) => ({
      name,
      digest: createHash('sha256')
        .update(readFileSync(`${directory}/${name}`))
        .digest('hex'),
    }));
}
export function eraserRestoreSql(manifest = eraserRestoreManifest()) {
  if (
    !manifest.length ||
    manifest.some((row) => !/^\d[\w-]*\.sql$/.test(row.name) || !/^[a-f0-9]{64}$/.test(row.digest))
  )
    throw new Error('Invalid immutable migration manifest');
  // FLAG: This SQL is exclusively for the network-isolated restored database. Exact
  // migration digests and critical indexes prove schema readability, never replay authority.
  return `SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM (VALUES ${manifest.map((row) => `('${row.name}','${row.digest}')`).join(',')}) expected(name,digest)
    LEFT JOIN eraser_migrations actual USING(name) WHERE actual.digest IS DISTINCT FROM expected.digest
  ) AND (SELECT count(*) FROM eraser_migrations)=${manifest.length} AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('eraser_policies'),('eraser_candidates'),('eraser_webhook_receipts'),
      ('eraser_protection_state'),('eraser_protected_messages'),('eraser_protected_bots'),
      ('eraser_held_authors'),('eraser_global_held_authors'),('eraser_global_message_holds'),
      ('eraser_future_hours'),('eraser_rate_limits'),('eraser_connection_requests'),('eraser_operations')) critical(name)
    WHERE to_regclass('public.'||name) IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.'||name) AND indisprimary AND indisvalid AND indisready)
  ) AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('eraser_candidates_purge_idx'),('eraser_webhook_receipts_purge_idx'),
      ('eraser_candidates_due_idx'),('eraser_candidates_reconcile_idx'),('eraser_policies_due_idx'),
      ('eraser_policies_due_ready_idx'),('eraser_policies_safety_due_idx'),('eraser_candidates_due_24_idx'),
      ('eraser_candidates_due_48_idx'),('eraser_candidates_due_168_idx'),('eraser_connection_requests_due_idx')) critical(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.'||name) AND indisvalid AND indisready)
  ) THEN 1 ELSE 0 END;`;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.length !== 3 || !['--sql', '--digest'].includes(process.argv[2]))
    throw new Error('Use --sql or --digest');
  const manifest = eraserRestoreManifest();
  process.stdout.write(
    process.argv[2] === '--sql'
      ? eraserRestoreSql(manifest) + '\n'
      : createHash('sha256').update(JSON.stringify(manifest)).digest('hex') + '\n',
  );
}
