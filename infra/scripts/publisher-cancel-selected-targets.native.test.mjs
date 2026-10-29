import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  CANCELLATION_CATALOG_PAGE_SQL,
  applySelectedTargetCancellation,
  previewSelectedTargetCancellation,
  verifySelectedTargetCancellation,
} from './publisher-cancel-selected-targets.mjs';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const bot = 'publisher-fixture';
const request = {
  version: 1,
  operationId: randomUUID(),
  expectedRuntimeSha: 'a'.repeat(40),
  cutoff: '2026-10-29T06:00:00.000Z',
  reason: 'Explicit operator fixture scope',
  targets: [
    { name: 'First', link: 'https://max.ru/join/' + 'a'.repeat(40) },
    { name: 'Second', link: 'https://max.ru/join/' + 'b'.repeat(40) },
  ],
};
const redigest = (preview) => {
  const body = structuredClone(preview);
  delete body.digest;
  return { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
};

describe('selected Publisher cancellation on migrated PostgreSQL', { skip: !databaseUrl }, () => {
  let db;
  const schema = 'target_cancel_' + randomUUID().replaceAll('-', '');
  const tables = [
    'managed_bot_chat_catalog',
    'publications',
    'publication_targets',
    'publication_schedules',
    'publication_mutation_records',
    'audit_logs',
    'managed_broadcast_deliveries',
    'managed_broadcast_calendar_reservations',
  ];
  before(async () => {
    const url = new URL(databaseUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
      'Disposable local race_test required',
    );
    const { default: pg } = await import('pg');
    db = new pg.Client({
      connectionString: databaseUrl,
      options: '-c timezone=UTC',
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    for (const table of tables)
      await db.query(
        `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      );
    for (const [name, table, columns] of [
      ['managed_bot_chat_catalog_pkey', 'managed_bot_chat_catalog', 'bot_id,chat_id'],
      ['publication_targets_target_type_idx', 'publication_targets', 'target_chat_id,entity_type'],
      [
        'publication_targets_publication_target_key',
        'publication_targets',
        'publication_id,target_chat_id',
      ],
      ['publications_pkey', 'publications', 'id'],
      ['publication_targets_pkey', 'publication_targets', 'id'],
      ['publication_schedules_publication_id_key', 'publication_schedules', 'publication_id'],
      [
        'publication_mutation_records_actor_request_key',
        'publication_mutation_records',
        'actor_user_id,request_id',
      ],
      ['audit_logs_pkey', 'audit_logs', 'id'],
    ])
      await db.query(
        `CREATE ${name.endsWith('_idx') ? '' : 'UNIQUE '}INDEX ${name} ON ${table} (${columns})`,
      );
  });
  after(async () => {
    if (db) {
      try {
        await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await db.end();
      }
    }
  });
  beforeEach(async () => {
    await db.query(`TRUNCATE ${tables.join(',')}`);
    for (const [index, chat] of ['-100', '-200'].entries())
      await db.query(
        "INSERT INTO managed_bot_chat_catalog (bot_id,chat_id,entity_type,link,title,updated_at) VALUES ($1,$2,'CHAT',$3,$4,now())",
        [bot, chat, request.targets[index].link, request.targets[index].name],
      );
    await db.query(
      "INSERT INTO managed_bot_chat_catalog (bot_id,chat_id,entity_type,link,title,updated_at) VALUES ('other-bot','-100','CHAT',$1,'Same group',now())",
      [request.targets[0].link],
    );
  });
  async function seed(
    id,
    chats,
    { lifecycle = 'ACTIVE', profile = 'PUBLIK_V1', created = '2026-10-28', requiredBot = bot } = {},
  ) {
    await db.query(
      "INSERT INTO publications (id,actor_user_id,request_id,lifecycle,dispatch_profile,required_bot_id,created_at,updated_at) VALUES ($1,'blocked-author',$1,$2,$3,$4,$5,now())",
      [id, lifecycle, profile, profile === 'LEGACY_ROUTED' ? null : requiredBot, created],
    );
    await db.query(
      "INSERT INTO publication_schedules (id,publication_id,mode,status,next_materialize_at,updated_at) VALUES ($1,$2,'RECURRENCE','ACTIVE','2026-11-01',now())",
      ['schedule-' + id, id],
    );
    for (const [position, chat] of chats.entries())
      await db.query(
        "INSERT INTO publication_targets (id,publication_id,target_chat_id,entity_type,position) VALUES ($1,$2,$3,'CHAT',$4)",
        [id + chat, id, chat, position],
      );
  }
  const preview = () => previewSelectedTargetCancellation(db, request, bot);
  const markers = async () =>
    (await db.query('SELECT id,canceled_at FROM publication_targets ORDER BY id')).rows;
  async function evidence() {
    const result = {};
    for (const table of ['managed_broadcast_deliveries', 'managed_broadcast_calendar_reservations'])
      result[table] = (
        await db.query(`SELECT row_to_json(t)::text AS bytes FROM ${table} t ORDER BY id`)
      ).rows;
    return result;
  }

  test('stops selected future recipients, preserves foreign schedules, receipts and calendar evidence, and replays idempotently', async () => {
    await seed('mixed', ['-100', '-300']);
    await seed('all', ['-100', '-200']);
    await seed('foreign', ['-300']);
    for (const [index, status] of ['PENDING', 'SENDING', 'AMBIGUOUS', 'SENT'].entries()) {
      await db.query(
        "INSERT INTO managed_broadcast_deliveries (id,broadcast_id,occurrence_index,target_chat_id,status,attempt_count,locked_at,lock_token,remote_message_id,publication_occurrence_id,dispatch_profile,required_bot_id,dialog_bot_id,publication_policy_revision,publisher_dialog_context,sent_at,updated_at) VALUES ($1,'broadcast',$2,'-100',$3,$4,$5,$6,$7,'occurrence','PUBLIK_V1',$8,$8,1,$9::jsonb,$10,now())",
        [
          'delivery-' + index,
          index,
          status,
          index === 0 ? 0 : 1,
          status === 'SENDING' ? new Date() : null,
          status === 'SENDING' ? 'preserved-lock' : null,
          status === 'SENT' ? 'preserved-remote-id' : null,
          bot,
          JSON.stringify({ version: 1, dialogBotId: bot, buttons: [], reference: null }),
          status === 'SENT' ? new Date() : null,
        ],
      );
      await db.query(
        "INSERT INTO managed_broadcast_calendar_reservations (id,broadcast_id,source_chat_id,occurrence_index,target_chat_id,scheduled_at) VALUES ($1,'broadcast','-100',$2,'-100',$3)",
        ['reservation-' + index, index, new Date(Date.UTC(2026, 10, 1, index))],
      );
    }
    const before = await evidence();
    const reviewed = await preview();
    assert.equal(reviewed.groups[0].chatId, '-100');
    assert.equal(reviewed.plans.length, 2);
    assert.ok(
      (await markers()).every((row) => row.canceled_at === null),
      'Preview is read only',
    );
    const applied = await applySelectedTargetCancellation(db, request, reviewed, bot);
    assert.deepEqual(
      applied.groups.map((g) => g.canceledTargets),
      [2, 1],
    );
    assert.deepEqual(
      (await db.query('SELECT id,lifecycle,version FROM publications ORDER BY id')).rows,
      [
        { id: 'all', lifecycle: 'CANCELED', version: 2 },
        { id: 'foreign', lifecycle: 'ACTIVE', version: 1 },
        { id: 'mixed', lifecycle: 'ACTIVE', version: 2 },
      ],
    );
    const schedules = (
      await db.query(
        'SELECT publication_id,status,next_materialize_at FROM publication_schedules ORDER BY publication_id',
      )
    ).rows;
    assert.equal(schedules[0].status, 'CANCELED');
    assert.equal(schedules[0].next_materialize_at, null);
    assert.ok(schedules.slice(1).every((s) => s.status === 'ACTIVE' && s.next_materialize_at));
    assert.deepEqual(
      (await markers()).filter((row) => row.canceled_at === null).map((row) => row.id),
      ['foreign-300', 'mixed-300'],
    );
    const replay = await applySelectedTargetCancellation(db, request, reviewed, bot);
    assert.equal(replay.publications, 2);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM publication_mutation_records')).rows[0].n,
      2,
    );
    assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n, 2);
    assert.deepEqual(await verifySelectedTargetCancellation(db, reviewed), { verifiedTargets: 3 });
    assert.deepEqual(await evidence(), before);
    assert.equal((await preview()).plans.length, 0);
  });

  test('excludes drafts, completed, legacy, another bot, post-cutoff and previously canceled recipients', async () => {
    for (const [id, options] of [
      ['draft', { lifecycle: 'DRAFT' }],
      ['complete', { lifecycle: 'COMPLETED' }],
      ['legacy', { profile: 'LEGACY_ROUTED' }],
      ['other', { requiredBot: 'foreign-bot' }],
      ['later', { created: '2026-10-29T06:00:00.001Z' }],
    ])
      await seed(id, ['-100'], options);
    await seed('previous', ['-100']);
    await db.query(
      "UPDATE publication_targets SET canceled_at=now() WHERE publication_id='previous'",
    );
    assert.equal((await preview()).plans.length, 0);
  });

  test('stale parent version rolls the entire operation back including earlier parents', async () => {
    await seed('aaa', ['-100']);
    await seed('zzz', ['-200']);
    const reviewed = await preview();
    await db.query("UPDATE publications SET version=version+1 WHERE id='zzz'");
    await assert.rejects(
      applySelectedTargetCancellation(db, request, reviewed, bot),
      /changed after preview/u,
    );
    assert.ok((await markers()).every((row) => row.canceled_at === null));
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM publication_mutation_records')).rows[0].n,
      0,
    );
  });

  test('changed or forged invite metadata refuses all writes even with recomputed digest', async () => {
    await seed('all', ['-100', '-200']);
    const reviewed = await preview();
    const forged = structuredClone(reviewed);
    forged.groups[0].chatId = '-300';
    forged.plans[0].targets[0].chatId = '-300';
    await assert.rejects(
      applySelectedTargetCancellation(db, request, redigest(forged), bot),
      /Invite metadata changed/u,
    );
    await db.query("UPDATE managed_bot_chat_catalog SET link=NULL WHERE chat_id='-200'");
    await assert.rejects(
      applySelectedTargetCancellation(db, request, reviewed, bot),
      /Invite metadata changed/u,
    );
    assert.ok((await markers()).every((row) => row.canceled_at === null));
  });

  test('missing and ambiguous links fail closed; paged inventory uses the primary index', async () => {
    await db.query(
      "INSERT INTO managed_bot_chat_catalog (bot_id,chat_id,entity_type,updated_at) SELECT 'history', '-' || g::text,'CHAT',now() FROM generate_series(1000,20999) g",
    );
    await db.query('ANALYZE managed_bot_chat_catalog');
    const plan = JSON.stringify(
      (await db.query('EXPLAIN (FORMAT JSON) ' + CANCELLATION_CATALOG_PAGE_SQL, ['', ''])).rows,
    );
    assert.match(plan, /Index (Only )?Scan/u);
    assert.doesNotMatch(plan, /Seq Scan/u);
    assert.equal((await preview()).groups.length, 2);
    await db.query(
      "INSERT INTO managed_bot_chat_catalog (bot_id,chat_id,entity_type,link,updated_at) VALUES ('conflict','-300','CHAT',$1,now())",
      [request.targets[0].link],
    );
    await assert.rejects(preview(), /missing or maps to multiple/u);
    await db.query(
      "DELETE FROM managed_bot_chat_catalog WHERE bot_id='conflict' OR chat_id='-200'",
    );
    await assert.rejects(preview(), /missing or maps to multiple/u);
  });

  test('history sentinel refuses a truncated selection; missing index refuses before writes', async () => {
    await db.query(
      "INSERT INTO publication_targets (id,publication_id,target_chat_id,entity_type,position) SELECT 't' || g,'p' || g,'-100','CHAT',0 FROM generate_series(1,501) g",
    );
    await assert.rejects(preview(), /Target history inventory is incomplete/u);
    await db.query('DROP INDEX publication_targets_target_type_idx');
    try {
      await assert.rejects(preview(), /Required metadata indexes are missing/u);
    } finally {
      await db.query(
        'CREATE INDEX publication_targets_target_type_idx ON publication_targets (target_chat_id,entity_type)',
      );
    }
  });
});
