import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  buildPublisherPublicationsAuditSql,
  buildPublisherPublicationPrivilegesSql,
  buildPublisherPublicationIndexReadinessSql,
  PUBLISHER_PUBLICATION_AUDIT_COLUMNS,
} from './publisher-publications-audit.mjs';

const fixture = readFileSync(
  resolve(import.meta.dirname, 'test-fixtures/publisher-publications.sql'),
  'utf8',
);
const query = buildPublisherPublicationsAuditSql();
const readinessQuery = (sql) => sql.slice(0, sql.indexOf('\\gset'));

test('publication audit classifies exact-bot access without exposing content or identities', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`
    INSERT INTO publications VALUES ('private-publication', 'private-actor', 'ACTIVE', 'SNAPSHOT', 'SELECTED', 'PUBLIK_V1', 'private-bot', 'private-title');
    INSERT INTO publication_schedules VALUES ('private-schedule', 'ONCE', 'ACTIVE', 1, '{"private":"content"}');
    INSERT INTO publication_occurrences VALUES ('private-occurrence', 'private-publication', 'private-schedule', 'SCHEDULED', now() - interval '1 hour', 'PUBLIK_V1', 'private-bot', 'PUBLISHER_ACTOR_ACCESS_REQUIRED', 'private-content');
    INSERT INTO publication_targets VALUES ('private-publication', 'private-chat', 'CHANNEL', 0);
    INSERT INTO chats VALUES ('private-chat', 'CHANNEL', 'private-title');
    INSERT INTO publisher_entity_bindings (chat_id, publisher_bot_id, status, bot_access_state, bot_access_expires_at)
      VALUES ('private-chat', 'private-bot', 'ACTIVE', 'CONFIRMED_ADMIN', now() + interval '10 minutes');
    INSERT INTO managed_bot_chat_catalog VALUES ('private-bot', 'private-chat', 'ACTIVE', 'CHANNEL', 'private-title');
    INSERT INTO managed_broadcast_deliveries VALUES ('private-delivery', 'private-occurrence', now(), 'AMBIGUOUS', 1, 'private-message', 'private-error');
  `);
  const report = async () => (await db.query(query)).rows[0].json_build_object;
  const missing = await report();
  assert.equal(missing.target_reasons[0].reason, 'actor_edge_missing');
  assert.equal(missing.delivery_states[0].status, 'AMBIGUOUS');
  assert.equal(missing.delivery_states[0].has_remote_id, true);
  assert.doesNotMatch(JSON.stringify(missing), /private-/u);

  await db.exec(`INSERT INTO managed_entity_access_edges VALUES
    ('private-chat', 'private-actor', 'private-bot', 'GRANTED', 'ADMIN', 'CHANNEL', now() - interval '8 days', NULL, NULL, 'private-error');`);
  assert.equal((await report()).target_reasons[0].reason, 'actor_edge_expired');
  await db.exec(`UPDATE managed_entity_access_edges SET expires_at = now() + interval '1 day';`);
  assert.equal((await report()).target_reasons[0].reason, 'metadata_ready');
  await db.exec(`UPDATE managed_bot_chat_catalog SET status = 'REMOVED';`);
  assert.equal((await report()).target_reasons[0].reason, 'catalog_missing_or_inactive');
  await db.exec(
    `INSERT INTO managed_entity_publication_policies (chat_id, publik_enabled) VALUES ('private-chat', false);`,
  );
  assert.equal((await report()).target_reasons[0].reason, 'policy_disabled');
  await db.exec(`UPDATE publisher_entity_bindings SET publisher_bot_id = 'private-other-bot';`);
  assert.equal((await report()).target_reasons[0].reason, 'binding_missing_or_wrong_bot');
});

test('source samples are capped and indexed, with explicit truncation', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`
    INSERT INTO publications SELECT 'p-' || i, 'u-' || i, 'ACTIVE', 'SNAPSHOT', 'SELECTED', 'PUBLIK_V1', 'bot', 'private-title' FROM generate_series(1, 5000) i;
    INSERT INTO publication_schedules SELECT 's-' || i, 'ONCE', 'ACTIVE', 1, '{}' FROM generate_series(1, 5000) i;
    INSERT INTO publication_occurrences SELECT 'o-' || i, 'p-' || i, 's-' || i, 'SCHEDULED', now() - i * interval '1 second', 'PUBLIK_V1', 'bot', NULL, NULL FROM generate_series(1, 5000) i;
    INSERT INTO publication_targets SELECT 'p-5000', 'private-chat-' || i, 'CHAT', i FROM generate_series(1, 500) i;
    INSERT INTO managed_broadcast_deliveries SELECT 'd-' || i, 'o-5000', now() - i * interval '1 second', 'PENDING', 0, NULL, 'private-error' FROM generate_series(1, 500) i;
    ANALYZE;
    SET enable_seqscan = off;
    SET enable_bitmapscan = off;
  `);
  const result = (await db.query(query)).rows[0].json_build_object;
  assert.equal(result.occurrences[0].sampled, 32);
  assert.equal(result.occurrences[0].saturated, true);
  assert.equal(result.target_samples_truncated, 1);
  assert.equal(result.delivery_samples_truncated, 1);
  assert.equal(
    result.target_reasons.reduce((n, row) => n + row.targets, 0),
    8,
  );
  assert.equal(
    result.delivery_states.reduce((n, row) => n + row.deliveries, 0),
    8,
  );
  assert.doesNotMatch(JSON.stringify(result), /private-/u);
  const plan = JSON.stringify((await db.query(buildPublisherPublicationsAuditSql(true))).rows);
  for (const name of [
    'publication_occurrences_dispatch_status_scheduled_idx',
    'publication_targets_publication_position_key',
    'managed_broadcast_deliveries_pub_occurrence_created_id_idx',
  ]) {
    assert.match(plan, new RegExp(name, 'u'));
  }
  const readiness = readinessQuery(buildPublisherPublicationIndexReadinessSql());
  assert.equal((await db.query(readiness)).rows[0].publisher_publication_indexes_ready, true);
  await db.exec('DROP INDEX publication_occurrences_dispatch_status_scheduled_idx;');
  assert.equal((await db.query(readiness)).rows[0].publisher_publication_indexes_ready, false);
});

test('column grants are sufficient, deny content and reject extra effective grants', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec('CREATE ROLE maxim_audit; GRANT USAGE ON SCHEMA public TO maxim_audit;');
  const optional = readinessQuery(buildPublisherPublicationPrivilegesSql(false));
  const required = readinessQuery(buildPublisherPublicationPrivilegesSql(true));
  assert.equal((await db.query(optional)).rows[0].publisher_publication_audit_ready, true);
  assert.equal((await db.query(required)).rows[0].publisher_publication_audit_ready, false);
  for (const [table, columns] of Object.entries(PUBLISHER_PUBLICATION_AUDIT_COLUMNS)) {
    await db.exec(`GRANT SELECT (${columns.join(', ')}) ON ${table} TO maxim_audit;`);
  }
  await db.exec(`
    GRANT SELECT (chat_id, publisher_bot_id, status, bot_access_state, bot_access_expires_at, last_webhook_at)
      ON publisher_entity_bindings TO maxim_audit;
    GRANT SELECT (chat_id, publik_enabled) ON managed_entity_publication_policies TO maxim_audit;
  `);
  assert.equal((await db.query(required)).rows[0].publisher_publication_audit_ready, true);
  await db.exec('SET SESSION AUTHORIZATION maxim_audit;');
  assert.equal((await db.query(query)).rows[0].json_build_object.audit, 'publisher_publications');
  for (const sql of [
    'SELECT title FROM publications',
    'SELECT rule FROM publication_schedules',
    'SELECT last_error FROM managed_broadcast_deliveries',
    'SELECT last_max_error_message FROM managed_entity_access_edges',
  ]) {
    await assert.rejects(db.query(sql), /permission denied/u);
  }
  await db.exec(
    'SET SESSION AUTHORIZATION postgres; GRANT SELECT (title) ON publications TO PUBLIC;',
  );
  assert.equal((await db.query(optional)).rows[0].publisher_publication_audit_ready, false);
});

test('CLI accepts no identifiers, SQL, arbitrary paths or extra options', () => {
  const script = resolve(import.meta.dirname, 'publisher-publications-audit.mjs');
  for (const args of [['SELECT 1'], ['--file', '/tmp/private'], ['--explain', 'extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
