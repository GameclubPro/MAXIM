import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  buildSourceEnvelopeAuditSql,
  emitSourceEnvelopeAuditSql,
  SOURCE_ENVELOPE_MAX_BYTES,
  SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES,
  SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES,
  SOURCE_ENVELOPE_COMPRESSION_POLICY,
} from './webhook-source-envelope-audit.mjs';

import pg from 'pg';

const id = 'local-compression-owner';
const secret = 'LOCAL_PRIVATE_TEXT_URL_TOKEN_ID';
const limits = {
  pglz: SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES,
  lz4: SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES,
};
const observations = [];
const payload = (length = 20000, tail = '') => ({
  botId: secret,
  message: { chatId: '-101', messageId: secret, text: `${secret}${'x'.repeat(length)}${tail}` },
  raw: {
    message: {
      sender: { user_id: secret, is_bot: false },
      recipient: { chat_id: '-101', chat_type: 'chat' },
      timestamp: 1,
      body: { mid: secret, seq: 1, text: '', attachments: [] },
      link: {
        type: 'forward',
        chat_id: '-101',
        sender: null,
        message: {
          mid: secret,
          text: null,
          attachments: [
            {
              type: 'image',
              payload: { photo_id: secret, url: `https://example.invalid/${secret}` },
            },
          ],
        },
      },
    },
  },
});
function projected(value) {
  assert.equal(value.schema_version, 2);
  assert.equal(value.authority, 'DIAGNOSTICS_ONLY');
  assert.equal(value.read_only, true);
  for (const key of ['remote_effects_proven', 'replay_authorized', 'settlement_authorized'])
    assert.equal(value[key], false);
  assert.equal(value.source_validation, 'not_evaluated');
  assert.equal(value.effect_completeness, 'unknown');
  assert.equal(value.payload_bound_policy, SOURCE_ENVELOPE_COMPRESSION_POLICY);
  assert.equal(value.payload_bound_assumption, 'valid_postgresql_compressed_storage');
  assert.equal(value.payload_max_bytes, 262144);
  assert.equal(value.compressed_payload_max_raw_bytes, 262144);
  assert.deepEqual(value.compressed_physical_caps, { pglz: 2880, lz4: 1028 });
  assert.doesNotMatch(
    JSON.stringify(value),
    /LOCAL_PRIVATE|local-compression-owner|-101|https?:\/\//u,
  );
  return value;
}
async function report(db, owner = id) {
  return projected((await db.query(buildSourceEnvelopeAuditSql(owner))).rows[0].jsonb_build_object);
}
async function seed(db, value) {
  await db.query('INSERT INTO webhook_events VALUES($1,$2)', [id, JSON.stringify(value)]);
}
async function storage(db) {
  // FLAG: Known finite locally-generated fixture ONLY. Object concat makes a new
  // uncompressed binary datum for an independent decoded size measurement. This
  // value operation is never an admission predicate or production collector.
  return (
    await db.query(
      `SELECT pg_column_compression(normalized_payload) AS method,
    pg_column_size(normalized_payload) AS physical,
    pg_column_size(normalized_payload || '{}'::jsonb) AS raw,
    pg_relation_size((SELECT reltoastrelid FROM pg_class WHERE oid='webhook_events'::regclass)) AS toast_bytes
    FROM webhook_events WHERE id=$1`,
      [id],
    )
  ).rows[0];
}
async function reset(db, method, external) {
  assert.ok(method === 'pglz' || method === 'lz4');
  await db.query(`TRUNCATE webhook_events;
    ALTER TABLE webhook_events SET (toast_tuple_target=${external ? 128 : 8160});
    ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET STORAGE ${external ? 'EXTENDED' : 'MAIN'};
    ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET COMPRESSION ${method};`);
}

// These format assertions are independent of SQL admission and cover the largest
// pglz tag and long LZ4 match-extension chains from the pinned primary format specs.
test('source-proved compression ceilings retain the 262144 binary cap at exact boundaries', () => {
  assert.equal(SOURCE_ENVELOPE_MAX_BYTES, 262144);
  assert.equal(4 + 91 * limits.pglz, 262084);
  assert.ok(4 + 91 * (limits.pglz + 1) > SOURCE_ENVELOPE_MAX_BYTES);
  assert.equal(4 + 255 * limits.lz4, 262144);
  assert.ok(4 + 255 * (limits.lz4 + 1) > SOURCE_ENVELOPE_MAX_BYTES);
  for (let length = 3; length <= 273; length++) assert.ok(length <= 91 * (length <= 17 ? 2 : 3));
  for (const extensions of [0, 1, 2, 17, 255, 1024]) {
    // One leading literal, token+offset, extensions incl final zero, final5 literals.
    const decoded = 1 + 19 + 255 * extensions + 5;
    const stream = 1 + 1 + 2 + extensions + 1 + 1 + 5;
    assert.ok(decoded <= 255 * stream);
  }
  const sql = emitSourceEnvelopeAuditSql(id);
  assert.match(sql, /'schema_version', 2/u);
  assert.match(sql, /server_version_num/u);
  assert.match(
    sql,
    /WHEN pg_column_compression\(normalized_payload\) = 'pglz'\s+THEN pg_column_size\(normalized_payload\) <= 2880/u,
  );
  assert.match(
    sql,
    /WHEN pg_column_compression\(normalized_payload\) = 'lz4'\s+THEN pg_column_size\(normalized_payload\) <= 1028/u,
  );
  assert.match(sql, /ELSE false END\s+THEN normalized_payload ELSE NULL END AS normalized/u);
  assert.doesNotMatch(
    sql.slice(0, sql.indexOf('), parts AS MATERIALIZED')),
    /normalized_payload\s*(?:->|#>)/u,
  );
  assert.doesNotMatch(sql, /EXPLAIN ANALYZE|CREATE EXTENSION|GRANT /u);
});

const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'native PG16 compressed diagnostic admission: inline/external, shapes, privacy, bounds and exact PK',
  { skip: !nativeUrl, timeout: 120000 },
  async (t) => {
    const url = new URL(nativeUrl);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
    );
    const name = `race_test_compression_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: url.href });
    const childUrl = new URL(url);
    childUrl.pathname = `/${name}`;
    const db = new pg.Client({
      connectionString: childUrl.href,
      options: '-c timezone=UTC -c statement_timeout=10000 -c lock_timeout=250',
    });
    let created = false;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      await db.connect();
      const version = (await db.query('SHOW server_version')).rows[0].server_version;
      assert.match(version, /^16\./u);
      await db.query('CREATE TABLE webhook_events(id text PRIMARY KEY, normalized_payload jsonb)');
      for (const method of ['pglz', 'lz4']) {
        await t.test(
          `${method}: real inline and external compressed values and conservative rejection`,
          async (alg) => {
            try {
              await reset(db, method, false);
            } catch (error) {
              if (method === 'lz4' && error.code === '0A000') {
                alg.skip('Native PostgreSQL built without LZ4 support');
                return;
              }
              throw error;
            }
            for (const external of [false, true]) {
              await reset(db, method, external);
              await seed(db, payload());
              const meta = await storage(db);
              assert.equal(meta.method, method);
              assert.ok(meta.physical <= limits[method]);
              assert.ok(
                meta.raw <= SOURCE_ENVELOPE_MAX_BYTES &&
                  meta.raw <= 4 + (method === 'pglz' ? 91 : 255) * meta.physical,
              );
              assert.equal(
                Number(meta.toast_bytes) > 0,
                external,
                `${method} fixture must prove its real storage placement`,
              );
              const r = await report(db);
              assert.equal(r.payload_admission, 'bounded');
              assert.equal(r.payload_storage, method);
              assert.equal(r.shape.link_type, 'forward');
              assert.equal(r.shape.linked_sender.kind, 'null');
              assert.equal(r.shape.linked_body.attachments.items[0].type, 'image');
              assert.equal(r.shape.linked_body.text_kind, 'null');
              observations.push({
                method,
                external,
                physicalBytes: meta.physical,
                rawDatumBytes: meta.raw,
                admitted: true,
              });
            }
            for (const length of [180000, 240000, 262144, 400000]) {
              await reset(db, method, true);
              await seed(db, payload(length));
              const meta = await storage(db);
              assert.equal(meta.method, method);
              const r = await report(db);
              assert.equal(
                r.payload_admission,
                meta.physical <= limits[method] ? 'bounded' : 'compressed_not_inspected',
              );
              assert.equal(r.shape !== null, r.payload_admission === 'bounded');
              if (meta.raw > SOURCE_ENVELOPE_MAX_BYTES)
                assert.equal(r.payload_admission, 'compressed_not_inspected');
              if (r.payload_admission === 'bounded')
                assert.ok(meta.raw <= 4 + (method === 'pglz' ? 91 : 255) * meta.physical);
              observations.push({
                method,
                physicalBytes: meta.physical,
                rawDatumBytes: meta.raw,
                admitted: r.payload_admission === 'bounded',
              });
            }
            const entropy = Array.from({ length: 400 }, (_, n) =>
              createHash('sha256').update(`fixed-local-${n}`).digest('hex'),
            ).join('');
            await reset(db, method, true);
            await seed(db, payload(80000, entropy));
            const meta = await storage(db);
            const r = await report(db);
            assert.equal(meta.method, method);
            assert.ok(meta.raw < SOURCE_ENVELOPE_MAX_BYTES && meta.physical > limits[method]);
            assert.equal(r.payload_admission, 'compressed_not_inspected');
            assert.equal(r.shape, null);
            observations.push({
              method,
              physicalBytes: meta.physical,
              rawDatumBytes: meta.raw,
              admitted: false,
              sufficientNotNecessary: true,
            });
          },
        );
      }
      await db.query(
        `TRUNCATE webhook_events; ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET STORAGE EXTERNAL;`,
      );
      await seed(db, payload(1000));
      assert.equal((await report(db)).payload_storage, 'uncompressed');
      assert.equal((await report(db)).payload_admission, 'bounded');
      await db.query('UPDATE webhook_events SET normalized_payload=NULL');
      assert.equal((await report(db)).payload_admission, 'absent');
      assert.equal((await report(db)).shape, null);
      assert.equal((await report(db, 'missing-owner')).payload_storage, 'missing_receipt');
      await db.query('TRUNCATE webhook_events');
      await seed(db, payload(400000));
      assert.equal((await report(db)).payload_admission, 'oversized_not_inspected');
      await db.query('TRUNCATE webhook_events');
      await seed(db, payload());
      await db.query(`INSERT INTO webhook_events SELECT 'retained-'||n,'{}'::jsonb FROM generate_series(1,50000)n;
        ANALYZE webhook_events; SET enable_seqscan=off; SET enable_bitmapscan=off; SET jit=off;
        SET max_parallel_workers_per_gather=0; SET work_mem='1MB'; SET temp_file_limit='8MB'; SET statement_timeout=2500;`);
      const plan = (
        await db.query(`EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) ${buildSourceEnvelopeAuditSql(id)}`)
      ).rows[0]['QUERY PLAN'][0].Plan;
      const walk = (n) => [n, ...(n.Plans ?? []).flatMap(walk)];
      const scans = walk(plan).filter((n) => n['Relation Name'] === 'webhook_events');
      assert.equal(scans.length, 1);
      assert.equal(scans[0]['Index Name'], 'webhook_events_pkey');
      assert.equal(scans[0]['Actual Rows'] * scans[0]['Actual Loops'], 1);
      assert.equal(scans[0]['Rows Removed by Filter'] ?? 0, 0);
      const locker = new pg.Client({ connectionString: childUrl.href });
      await locker.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM webhook_events WHERE id=$1 FOR UPDATE', [id]);
        await report(db);
      } finally {
        await locker.query('ROLLBACK');
        await locker.end();
      }
      const role = `compression_audit_${randomUUID().replaceAll('-', '')}`;
      await db.query(
        `CREATE ROLE ${role}; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT(id,normalized_payload) ON webhook_events TO ${role}; SET ROLE ${role}`,
      );
      try {
        await report(db);
      } finally {
        await db.query(`RESET ROLE; DROP OWNED BY ${role}; DROP ROLE ${role}`);
      }
      t.diagnostic(
        JSON.stringify({
          authority: 'LOCAL_FIXTURES_ONLY',
          nativeServerMajor: 16,
          observations,
          exactPkRows: 1,
          retainedRows: 50000,
          lockedRowRead: true,
          minimalColumnGrants: true,
          productionCalls: 0,
          sourceValidation: 'not_evaluated',
          remoteEffectsProven: false,
        }),
      );
    } finally {
      await db.end();
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
