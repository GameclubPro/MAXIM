import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { buildWebhookWorkloadAuditSql } from './webhook-workload-audit.mjs';

const fixture = `SET TIME ZONE 'UTC';
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED',
  'NO_REPLAY_HELD','CANCELLED','QUARANTINED');
CREATE TABLE webhook_events (id text PRIMARY KEY, status "WebhookStatus" NOT NULL,
  created_at timestamp(3) NOT NULL, semantic_key text, normalized_payload jsonb);
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);`;
const query = buildWebhookWorkloadAuditSql();
const payload = (attachments, patch = {}) => ({
  type: 'message_created',
  message: { entityType: 'chat', text: 'private-message', chatId: 'private-chat' },
  raw: {
    message: {
      body: { text: 'private-message', ...(attachments === undefined ? {} : { attachments }) },
    },
  },
  ...patch,
});
async function insert(db, id, source, status = 'PROCESSED', key = 'private-key') {
  await db.query(
    `INSERT INTO webhook_events VALUES ($1, $2, now() - interval '32 seconds', $3, $4)`,
    [id, status, key, JSON.stringify(source)],
  );
}
function report(db) {
  return db.query(query).then((r) => r.rows[0].json_build_object);
}
function classes(value) {
  return Object.fromEntries(value.rows.map((row) => [row.content_class, row.receipts]));
}

test('workload classifies finite direct shapes and keeps unknown/linked variants visible', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await insert(db, 'text', payload());
  for (const type of ['image', 'video', 'audio', 'sticker', 'file', 'share'])
    await insert(db, type, payload([{ type, payload: { url: 'https://private.invalid/secret' } }]));
  await insert(db, 'mixed', payload([{ type: 'image' }, null]));
  await insert(db, 'malformed', payload('private-not-an-array'));
  await insert(db, 'too-many', payload(Array.from({ length: 17 }, () => ({ type: 'image' }))));
  await insert(
    db,
    'linked',
    payload([], { raw: { message: { link: { type: 'forward' }, body: {} } } }),
  );
  await insert(
    db,
    'alternative',
    payload([], { raw: { message: { attachments: [{ type: 'image' }], body: {} } } }),
  );
  await insert(db, 'callback', payload([], { type: 'message_callback' }));
  await insert(db, 'unknown', payload([], { type: 'private-unknown-type' }));
  const result = await report(db);
  assert.equal(result.sample_complete, true);
  assert.equal(result.sampled_receipts, 14);
  assert.equal(result.classifications_complete, false);
  assert.deepEqual(classes(result), {
    alternative_shape: 1,
    attachment_limit: 1,
    direct_audio: 1,
    direct_file: 1,
    direct_image: 1,
    direct_share: 1,
    direct_sticker: 1,
    direct_video: 1,
    linked_message: 1,
    mixed_or_unknown_attachments: 1,
    non_message: 1,
    text_or_empty: 1,
    unknown_event: 1,
    unknown_shape: 1,
  });
  assert.equal(result.remote_effects_proven, false);
  assert.equal(result.moderation_decisions_proven, false);
  assert.doesNotMatch(JSON.stringify(result), /private-|https:|secret/u);
});

test('every status participates; saved-key multiplicity is separate from decisions', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  for (const status of [
    'RECEIVED',
    'QUEUED',
    'PROCESSED',
    'DUPLICATE',
    'FAILED',
    'NO_REPLAY_HELD',
    'CANCELLED',
    'QUARANTINED',
  ])
    await insert(db, 'private-' + status, payload(), status);
  await insert(db, 'private-missing', payload(), 'PROCESSED', null);
  await insert(db, 'private-empty', payload(), 'PROCESSED', '');
  await insert(db, 'private-key-overflow', payload(), 'PROCESSED', 'k'.repeat(2049));
  const result = await report(db);
  assert.equal(result.rows.length, 8);
  assert.equal(result.classifications_complete, true);
  assert.equal(
    result.rows.reduce((total, row) => total + row.receipts, 0),
    11,
  );
  assert.equal(result.saved_key_groups, 1);
  assert.equal(result.missing_or_invalid_saved_keys, 3);
  assert.deepEqual(result.receipts_per_saved_key, [{ receipts: 8, groups: 1 }]);
  assert.doesNotMatch(JSON.stringify(result), /private-|kkkk/u);
});

test('empty, removed and oversized payloads cannot silently become plain text', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const empty = await report(db);
  assert.equal(empty.nonempty, false);
  assert.equal(empty.classifications_complete, false);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.receipts_per_saved_key, []);
  for (const [id, source] of [
    ['absent', null],
    ['scalar', 'private-value'],
    ['large', payload([], { secret: 'x'.repeat(65537) })],
    ['no-raw', payload([], { raw: {} })],
  ])
    await insert(db, id, source);
  const result = await report(db);
  assert.deepEqual(classes(result), { unavailable_or_oversize: 3, unknown_shape: 1 });
  assert.doesNotMatch(JSON.stringify(result), /private-|secret|xxxxx/u);
});

test('global cap precedes payload reads; a clipped five-second window is incomplete', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events (id,status,created_at) SELECT 'old-'||n,
    'PROCESSED', now()-interval '2 days' FROM generate_series(1,5000) n;
    INSERT INTO webhook_events (id,status,created_at) SELECT 'new-'||n,
    'PROCESSED', now()-interval '32 seconds' FROM generate_series(1,514) n;
    INSERT INTO webhook_events (id,status,created_at) VALUES
      ('recent','RECEIVED',now()-interval '3 seconds'),
      ('future','RECEIVED',now()+interval '3 seconds');`);
  const result = await report(db);
  assert.equal(result.sample_complete, false);
  assert.equal(result.sampled_receipts, 512);
  assert.equal(result.captured_receipts_lower_bound, 513);
  assert.equal(result.rows[0].receipts, 512);
});

const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() ?? '';
const local = (() => {
  try {
    const u = new URL(nativeUrl);
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.pathname.includes('race_test')
    );
  } catch {
    return false;
  }
})();
test(
  'native retained-history plan bounds covered heads and exact payload lookups',
  { skip: !local },
  async (t) => {
    const db = new pg.Client({ connectionString: nativeUrl, statement_timeout: 5000 });
    await db.connect();
    t.after(async () => {
      await db.query('ROLLBACK').catch(() => {});
      await db.end();
    });
    await db.query(
      'BEGIN; CREATE SCHEMA webhook_workload_fixture; SET LOCAL search_path TO webhook_workload_fixture, public;',
    );
    await db.query(fixture);
    await db.query(`INSERT INTO webhook_events (id,status,created_at) SELECT 'old-'||n,
    'PROCESSED', now()-interval '2 days' FROM generate_series(1,60000) n;
    INSERT INTO webhook_events (id,status,created_at) SELECT 'new-'||n,
    'PROCESSED', clock_timestamp()-interval '32 seconds' FROM generate_series(1,1200) n;
    ANALYZE webhook_events; SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off;
    SET LOCAL max_parallel_workers_per_gather=0;`);
    // FLAG: ANALYZE executes only against this owned disposable test schema.
    const plan = (await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query)).rows[0][
      'QUERY PLAN'
    ][0].Plan;
    const scans = [];
    const walk = (n) => {
      if (n['Relation Name'] === 'webhook_events') scans.push(n);
      for (const child of n.Plans ?? []) walk(child);
    };
    walk(plan);
    assert.equal(scans.length, 2);
    assert.deepEqual(scans.map((n) => n['Index Name']).sort(), [
      'webhook_events_pkey',
      'webhook_events_status_created_at_id_idx',
    ]);
    for (const scan of scans) {
      assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
      assert.ok(scan['Actual Rows'] <= 513);
      assert.ok(scan['Actual Loops'] <= 512);
    }
    const result = await report(db);
    assert.equal(result.sample_complete, false);
    assert.equal(result.sampled_receipts, 512);
  },
);

test('workload CLI accepts only plain EXPLAIN and never operator SQL or a wider window', () => {
  for (const args of [
    ['--apply'],
    ['SELECT 1'],
    ['--seconds=60'],
    ['--short'],
    ['--explain', '--explain'],
    ['/tmp/private.sql'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [new URL('./webhook-workload-audit.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.throws(() => buildWebhookWorkloadAuditSql('true'));
  const result = spawnSync(
    process.execPath,
    [new URL('./webhook-workload-audit.mjs', import.meta.url).pathname, '--explain'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /webhook_cohort_index_ready/u);
  assert.match(result.stdout, /EXPLAIN \(FORMAT JSON\)/u);
  assert.doesNotMatch(result.stdout, /EXPLAIN ANALYZE/u);
});
