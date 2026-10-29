import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const root = new URL('../../../../', import.meta.url).pathname;
const require = createRequire(root + '/package.json');
const pg = require('pg');
const { Store, HOUSEKEEPING_INTERVAL_MS, TERMINAL_PURGE_BATCH, WEBHOOK_PURGE_BATCH } = await import(
  root + '/apps/eraser/src/store.ts'
);
const { migrate } = await import(root + '/apps/eraser/src/migrate.ts');
const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
if (url.hostname !== '127.0.0.1' || !/^\/maxim_race_test_[a-f0-9]+$/.test(url.pathname))
  throw Error('Disposable wrapper required');
const schema = 'eraser_benchmark_' + randomUUID().replaceAll('-', '');
const admin = new pg.Pool({ connectionString: url.toString(), max: 1 });
const pool = new pg.Pool({
  connectionString: url.toString(),
  max: 2,
  options: '-c search_path=' + schema + ' -c timezone=UTC -c statement_timeout=30000',
});
const elapsed = async (fn) => {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
};
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(pool);
  const walStart = (await pool.query('SELECT pg_current_wal_insert_lsn() AS lsn')).rows[0].lsn;
  const seed = await elapsed(async () => {
    await pool.query(
      "INSERT INTO eraser_policies(chat_id,activation_id,enabled,history_complete,normal_next_at,safety_next_at,next_run_at) SELECT '-'||n,gen_random_uuid(),true,true,now()+interval '6 hours',now()+interval '6 hours',now()+interval '6 hours' FROM generate_series(1,20000)n",
    );
    await pool.query(
      "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,state,updated_at) SELECT '-'||(1+n%20000),'fixture-message-'||n,'10',false,1,'live','deleted',now()-interval '8 days' FROM generate_series(1,100000)n",
    );
    await pool.query(
      "INSERT INTO eraser_webhook_receipts(receipt_key,received_at) SELECT md5(n::text)||md5(('receipt-'||n)::text),now()-interval '8 days' FROM generate_series(1,200000)n",
    );
    await pool.query(
      'ANALYZE eraser_policies; ANALYZE eraser_candidates; ANALYZE eraser_webhook_receipts',
    );
  });
  const sizes = (
    await pool.query(
      "SELECT relname,pg_table_size(oid)::text table_bytes,pg_indexes_size(oid)::text index_bytes FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('eraser_policies','eraser_candidates','eraser_webhook_receipts')",
      [schema],
    )
  ).rows;
  const wal = (
    await pool.query('SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1)::text bytes', [
      walStart,
    ])
  ).rows[0].bytes;
  const store = new Store(pool, true);
  const passes = [];
  let selects = [];
  for (let i = 0; i < 5; i++) {
    const result = await elapsed(() => store.housekeeping());
    passes.push({ ms: result.ms, ...store.housekeepingHealth() });
  }
  for (let i = 0; i < 10; i++) selects.push((await elapsed(() => store.reserve(62))).ms);
  console.log(
    JSON.stringify(
      {
        kind: 'isolated_native_adaptive_housekeeping',
        rows: { policies: 20000, candidates: 100000, receipts: 200000 },
        sizes,
        seedMs: seed.ms,
        seedWalBytes: wal,
        maintenanceMs: passes,
        emptySelectionMs: selects,
        configured: {
          intervalMs: HOUSEKEEPING_INTERVAL_MS,
          candidates: TERMINAL_PURGE_BATCH,
          receipts: WEBHOOK_PURGE_BATCH,
        },
        rssBytes: process.memoryUsage().rss,
        limitation:
          'Local sample, not steady-state production capacity; linear extrapolation excludes bloat and workload concurrency.',
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
  await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
  await admin.end();
}
