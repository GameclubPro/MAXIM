import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const root = new URL('../../../../', import.meta.url).pathname;
const pg = createRequire(root + '/package.json')('pg');
const { Store } = await import(root + '/apps/eraser/src/store.ts');
const { migrate } = await import(root + '/apps/eraser/src/migrate.ts');
const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
if (url.hostname !== '127.0.0.1' || !/^\/maxim_race_test_[a-f0-9]+$/.test(url.pathname))
  throw Error('Disposable wrapper required');
const schema = 'eraser_ingest_' + randomUUID().replaceAll('-', '');
const admin = new pg.Pool({ connectionString: url.toString(), max: 1 });
const pool = new pg.Pool({
  connectionString: url.toString(),
  max: 4,
  options: '-c search_path=' + schema + ' -c timezone=UTC -c statement_timeout=30000',
});
try {
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(pool);
  await pool.query(
    "INSERT INTO eraser_policies(chat_id,activation_id,enabled,history_complete,normal_next_at,safety_next_at,next_run_at) SELECT '-'||n,gen_random_uuid(),true,true,now()+interval '6 hours',now()+interval '6 hours',now()+interval '6 hours' FROM generate_series(1,20000)n",
  );
  const store = new Store(pool, true);
  const output = [];
  for (const profile of ['uniform', 'one_percent_eighty_percent']) {
    const start = performance.now();
    const latencies = [];
    let next = 0;
    const events = 11000;
    const wal = (await pool.query('SELECT pg_current_wal_insert_lsn() AS lsn')).rows[0].lsn;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < events) {
          const n = next++;
          const chatId =
            '-' +
            (profile === 'uniform'
              ? 1 + (n % 20000)
              : n % 5 === 0
                ? 201 + (n % 19800)
                : 1 + (n % 200));
          const t = performance.now();
          const messageId = 'native-' + profile + '-' + n;
          const phase = n % 11;
          if (phase < 5)
            await store.ingest({}, messageId, {
              chatId,
              messageId,
              authorId: '10',
              isBot: false,
              sourceMs: Date.now(),
            });
          else if (phase < 10)
            await store.ingest(
              { update_type: 'message_removed', chat_id: chatId, message_id: messageId },
              messageId,
            );
          else await store.ingest({ update_type: 'message_edited' }, messageId);
          latencies.push(performance.now() - t);
        }
      }),
    );
    latencies.sort((a, b) => a - b);
    output.push({
      profile,
      events,
      elapsedMs: performance.now() - start,
      p95Ms: latencies[Math.floor(events * 0.95)],
      p99Ms: latencies[Math.floor(events * 0.99)],
      walBytes: (
        await pool.query('SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1)::text bytes', [
          wal,
        ])
      ).rows[0].bytes,
    });
  }
  console.log(
    JSON.stringify(
      {
        kind: 'isolated_native_ingestion_sample',
        profiles: output,
        rssBytes: process.memoryUsage().rss,
        limitations:
          'Synthetic local PostgreSQL 16, four clients, not sustained production throughput; five creations/five absent-candidate removals/one edit per eleven events. MAX never called.',
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
