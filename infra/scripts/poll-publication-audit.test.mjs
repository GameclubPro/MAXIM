import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  buildPollPublicationAuditSql,
  buildPollPublicationPrivilegesSql,
  buildPollPublicationIndexReadinessSql,
  POLL_AUDIT_COLUMNS,
} from './poll-publication-audit.mjs';

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE ROLE maxim_audit;
    CREATE TABLE managed_polls (id text PRIMARY KEY, chat_id text, status text,
      publication_message_id text, publication_bot_id text, render_revision int,
      rendered_revision int, render_format_version int, last_render_error text,
      published_at timestamp, closed_at timestamp, updated_at timestamp,
      question text, images jsonb, actor_user_id text);
    CREATE TABLE chat_bot_memberships (chat_id text, bot_id text, status text,
      bot_access_state text, bot_access_checked_at timestamp, bot_access_source text,
      lifecycle_event_at timestamp, permissions_snapshot jsonb,
      UNIQUE(chat_id, bot_id));`);
  return db;
}

test('poll report rejects SQL syntax and bounds the exact ID before emitting a query', () => {
  for (const value of ['', "poll' OR true --", 'poll;SELECT 1', 'a'.repeat(129), null])
    assert.throws(() => buildPollPublicationAuditSql(value));
  assert.match(buildPollPublicationAuditSql('poll-1', true), /^EXPLAIN \(FORMAT JSON\)/u);
  assert.doesNotMatch(buildPollPublicationAuditSql('poll-1', true), /EXPLAIN.*ANALYZE/u);
});

test('exact poll/original-bot metadata distinguishes missing membership without exposing content or claiming absence', async (t) => {
  const db = await fixture(t);
  await db.exec(`INSERT INTO managed_polls VALUES ('poll-1','secret-chat','ACTIVE','secret-message',
    'secret-bot',5,3,1,'Request failed with status code 404 secret-detail',now(),NULL,now(),
    'secret-question','{"secret":"image"}','secret-actor');`);
  let result = (await db.query(buildPollPublicationAuditSql('poll-1'))).rows[0].json_build_object;
  assert.equal(result.found, true);
  assert.equal(result.render_error_kind, 'http_404_unknown_presence');
  assert.equal(result.original_membership_exists, false);
  assert.equal(result.remote_presence_proven, false);
  assert.doesNotMatch(JSON.stringify(result), /secret/u);
  await db.exec(`INSERT INTO chat_bot_memberships VALUES ('secret-chat','secret-bot','ACTIVE',
    'CONFIRMED_ADMIN',now(),'explicit_start',now(),'{"private":"permissions"}');`);
  result = (await db.query(buildPollPublicationAuditSql('poll-1'))).rows[0].json_build_object;
  assert.equal(result.original_access_state, 'CONFIRMED_ADMIN');
  assert.equal(result.capabilities_and_activation_checked, false);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|explicit_start/u);
  assert.equal(
    (await db.query(buildPollPublicationAuditSql('missing'))).rows[0].json_build_object.found,
    false,
  );
});

test('poll privileges accept no grant or the complete exact group and refuse partial, sensitive and whole-table grants', async (t) => {
  const db = await fixture(t);
  const query = (required) => buildPollPublicationPrivilegesSql(required).split('\\gset')[0];
  const ready = async (required) =>
    (await db.query(query(required))).rows[0].poll_publication_audit_ready;
  assert.equal(await ready(false), true);
  assert.equal(await ready(true), false);
  await db.exec('GRANT SELECT (id) ON managed_polls TO maxim_audit');
  assert.equal(await ready(false), false);
  for (const [table, columns] of Object.entries(POLL_AUDIT_COLUMNS))
    await db.exec(`GRANT SELECT (${columns.join(',')}) ON ${table} TO maxim_audit`);
  assert.equal(await ready(true), true);
  await db.exec('GRANT SELECT (question) ON managed_polls TO maxim_audit');
  assert.equal(await ready(true), false);
  await db.exec('REVOKE SELECT (question) ON managed_polls FROM maxim_audit');
  await db.exec('GRANT SELECT ON managed_polls TO maxim_audit');
  assert.equal(await ready(true), false);
});

test('poll index admission refuses a missing exact membership index', async (t) => {
  const db = await fixture(t);
  const sql = buildPollPublicationIndexReadinessSql().split('\\gset')[0];
  assert.equal((await db.query(sql)).rows[0].poll_publication_indexes_ready, true);
  await db.exec(
    'ALTER TABLE chat_bot_memberships DROP CONSTRAINT chat_bot_memberships_chat_id_bot_id_key',
  );
  assert.equal((await db.query(sql)).rows[0].poll_publication_indexes_ready, false);
});

test(
  'native retained poll history uses the two exact indexes',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL },
  async (t) => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert.ok(
      ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname.includes('race_test'),
    );
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    const prefix = `poll-audit-${randomUUID()}`;
    t.after(async () => {
      await client.query('DELETE FROM chats WHERE id = ANY($1)', [
        Array.from({ length: 5000 }, (_, index) => `${prefix}-${index + 1}`),
      ]);
      await client.end();
    });
    await client.query(
      "INSERT INTO chats (id,title,updated_at) SELECT $1 || '-' || n,$2,now() FROM generate_series(1,5000) n",
      [prefix, 'Local plan fixture'],
    );
    await client.query(
      `INSERT INTO managed_polls (id,chat_id,actor_user_id,question,identity_salt,
    publication_bot_id,publication_message_id,updated_at)
    SELECT $1 || '-' || n, $1 || '-' || n, 'fixture-actor', 'fixture-question', repeat('a',32),
      $1 || '-bot-' || (n % 6), $1 || '-message-' || n, now() FROM generate_series(1,5000) n`,
      [prefix],
    );
    await client.query(
      `INSERT INTO chat_bot_memberships (id,chat_id,bot_id,updated_at)
    SELECT $1 || '-member-' || n || '-' || b, $1 || '-' || n, $1 || '-bot-' || b, now()
      FROM generate_series(1,5000) n CROSS JOIN generate_series(0,5) b`,
      [prefix],
    );
    await client.query('ANALYZE managed_polls; ANALYZE chat_bot_memberships');
    const { rows } = await client.query(buildPollPublicationAuditSql(`${prefix}-4000`, true));
    const flatten = (node) => [node, ...(node.Plans ?? []).flatMap(flatten)];
    const nodes = flatten(rows[0]['QUERY PLAN'][0].Plan);
    assert.ok(nodes.some((node) => node['Index Name'] === 'managed_polls_pkey'));
    assert.ok(
      nodes.some((node) => node['Index Name'] === 'chat_bot_memberships_chat_id_bot_id_key'),
      JSON.stringify(
        nodes.map((node) => ({
          type: node['Node Type'],
          index: node['Index Name'],
          rows: node['Plan Rows'],
        })),
      ),
    );
    assert.ok(nodes.every((node) => !['Seq Scan', 'Sort'].includes(node['Node Type'])));
  },
);
