import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  buildPublisherAccessCensusReadinessSql,
  buildPublisherAccessCensusSql,
  PUBLISHER_ACCESS_CENSUS_CAP,
} from './publisher-access-census.mjs';

const schema = `CREATE TABLE publisher_entity_bindings (
  chat_id text PRIMARY KEY, publisher_bot_id text NOT NULL, status text NOT NULL,
  bot_access_state text NOT NULL, bot_access_checked_at timestamp, bot_access_expires_at timestamp,
  capabilities jsonb
);
CREATE ROLE maxim_audit;
GRANT USAGE ON SCHEMA public TO maxim_audit;
GRANT SELECT (chat_id, publisher_bot_id, status, bot_access_state,
  bot_access_checked_at, bot_access_expires_at) ON publisher_entity_bindings TO maxim_audit;`;
const report = async (db) =>
  (await db.query(buildPublisherAccessCensusSql())).rows[0].json_build_object;
const readiness = buildPublisherAccessCensusReadinessSql().split('\\gset')[0];

test('census matches runtime SHA-256 cohorts and keeps identities inside SQL', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  const bot = 'private-bot-"\\\nЮ';
  const entities = Array.from({ length: 1000 }, (_, n) => `private-chat-${n}-😀`);
  const expected = { legacy: 0, separated: 0 };
  for (const chat of entities) {
    const bucket = createHash('sha256')
      .update(JSON.stringify([bot, chat]))
      .digest()
      .readUInt32BE(0);
    expected[bucket % 10 === 0 ? 'separated' : 'legacy'] += 1;
  }
  await db.query(
    `INSERT INTO publisher_entity_bindings
    SELECT unnest($1::text[]), $2, 'ACTIVE', 'CONFIRMED_ADMIN', now(), now() + interval '15 minutes', '{}'`,
    [entities, bot],
  );
  await db.exec('SET SESSION AUTHORIZATION maxim_audit;');
  const result = await report(db);
  assert.equal(result.source_rows_sampled, 1000);
  assert.equal(result.source_truncated, false);
  assert.equal(result.active_bot_scopes, 1);
  for (const row of result.cohorts) {
    assert.equal(row.active_bindings, expected[row.cohort]);
    assert.equal(row.fresh_admin_bindings, expected[row.cohort]);
    assert.equal(row.expired_admin_bindings, 0);
    assert.equal(row.missing_admin_expiry, 0);
  }
  assert.doesNotMatch(JSON.stringify(result), /private-|chat_id|publisher_bot_id|capabilities/u);
  await assert.rejects(
    db.query('SELECT capabilities FROM publisher_entity_bindings'),
    /permission denied/u,
  );
});

test('census distinguishes expired, missing, future, stale, denied and inactive evidence', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  await db.exec(`INSERT INTO publisher_entity_bindings VALUES
    ('fresh', 'bot', 'ACTIVE', 'CONFIRMED_OWNER', now(), now() + interval '10 minutes', '{}'),
    ('soon', 'bot', 'ACTIVE', 'CONFIRMED_ADMIN', now(), now() + interval '30 seconds', '{}'),
    ('expired', 'bot', 'ACTIVE', 'CONFIRMED_ADMIN', now() - interval '16 minutes', now() - interval '1 minute', '{}'),
    ('missing', 'bot', 'ACTIVE', 'CONFIRMED_ADMIN', NULL, NULL, '{}'),
    ('future', 'bot', 'ACTIVE', 'CONFIRMED_ADMIN', now() + interval '1 minute', now() + interval '16 minutes', '{}'),
    ('stale', 'bot', 'ACTIVE', 'CONFIRMED_ADMIN', now() - interval '16 minutes', now() + interval '1 minute', '{}'),
    ('denied', 'bot', 'ACTIVE', 'DENIED', now(), now() + interval '15 minutes', '{}'),
    ('inactive', 'old-bot', 'REMOVED', 'CONFIRMED_ADMIN', now(), now() + interval '15 minutes', '{}');`);
  const result = await report(db);
  const sum = (key) => result.cohorts.reduce((n, row) => n + row[key], 0);
  assert.equal(result.active_bot_scopes, 1);
  assert.equal(sum('active_bindings'), 7);
  assert.equal(sum('confirmed_admin_bindings'), 6);
  assert.equal(sum('fresh_admin_bindings'), 2);
  assert.equal(sum('expired_admin_bindings'), 1);
  assert.equal(sum('missing_admin_expiry'), 1);
  assert.equal(sum('expiring_admin_in_60s'), 1);
  assert.equal(sum('invalid_or_stale_admin_check'), 4);
  await db.exec(
    `UPDATE publisher_entity_bindings SET status = 'ACTIVE' WHERE chat_id = 'inactive';`,
  );
  assert.equal((await report(db)).active_bot_scopes, 2);
});

test('unfiltered indexed source is bounded even when every row is inactive', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  await db.exec(`INSERT INTO publisher_entity_bindings
    SELECT 'private-' || i, 'bot', 'REMOVED', 'DENIED', NULL, NULL, '{}'
    FROM generate_series(1, ${PUBLISHER_ACCESS_CENSUS_CAP + 10}) i;
    ANALYZE; SET enable_seqscan = off; SET enable_bitmapscan = off;`);
  const result = await report(db);
  assert.equal(result.source_rows_sampled, PUBLISHER_ACCESS_CENSUS_CAP);
  assert.equal(result.source_truncated, true);
  assert.equal(result.active_bot_scopes, 0);
  assert.equal(
    result.cohorts.reduce((n, row) => n + row.active_bindings, 0),
    0,
  );
  const plan = (await db.query(buildPublisherAccessCensusSql(true))).rows[0]['QUERY PLAN'][0].Plan;
  const nodes = [];
  const walk = (node) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  const source = nodes.find((node) => node['Subplan Name'] === 'CTE source');
  assert.equal(source['Node Type'], 'Limit');
  assert.equal(source['Plan Rows'], PUBLISHER_ACCESS_CENSUS_CAP + 1);
  assert.equal(source.Plans[0]['Index Name'], 'publisher_entity_bindings_pkey');
  assert.equal(
    nodes.some((node) => node['Node Type'] === 'Seq Scan'),
    false,
  );
  await db.exec(`UPDATE publisher_entity_bindings SET status = 'ACTIVE',
    bot_access_state = 'CONFIRMED_ADMIN', bot_access_checked_at = now(),
    bot_access_expires_at = now() + interval '15 minutes';
    SET work_mem = '1MB'; SET temp_file_limit = '8MB'; SET statement_timeout = '2500ms';`);
  const full = await report(db);
  assert.equal(full.source_truncated, true);
  assert.equal(
    full.cohorts.reduce((n, row) => n + row.fresh_admin_bindings, 0),
    PUBLISHER_ACCESS_CENSUS_CAP,
  );
});

test('census fails closed without the primary key or required existing column grants', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  assert.equal((await db.query(readiness)).rows[0].publisher_access_census_ready, true);
  await db.exec(
    'REVOKE SELECT (bot_access_expires_at) ON publisher_entity_bindings FROM maxim_audit;',
  );
  assert.equal((await db.query(readiness)).rows[0].publisher_access_census_ready, false);
  await db.exec(
    'GRANT SELECT (bot_access_expires_at) ON publisher_entity_bindings TO maxim_audit; ALTER TABLE publisher_entity_bindings DROP CONSTRAINT publisher_entity_bindings_pkey;',
  );
  assert.equal((await db.query(readiness)).rows[0].publisher_access_census_ready, false);
});

test('CLI accepts only fixed SQL or plain EXPLAIN, never operator SQL or identifiers', () => {
  const script = resolve(import.meta.dirname, 'publisher-access-census.mjs');
  for (const args of [
    ['SELECT 1'],
    ['--file', '/tmp/private'],
    ['private-id'],
    ['--explain', 'extra'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
