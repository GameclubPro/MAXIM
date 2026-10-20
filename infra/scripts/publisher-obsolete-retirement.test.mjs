import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  applyRetirement,
  attestRetirementIndexes,
  buildRetirementBlockerQuery,
  buildRetirementSourceQuery,
  classifyRetirementSnapshot,
  initialRetirementCursors,
  inspectRetirementReadPlan,
  previewRetirement,
  readRetirementSnapshot,
  RETIREMENT_CUTOFF,
  retirementSendKey,
} from './publisher-obsolete-retirement.mjs';
import {
  captureRetirementRuntime,
  parseRetirementArgs,
} from './publisher-obsolete-retirement-host.mjs';

const fixture = readFileSync(
  new URL('./test-fixtures/publisher-obsolete-retirement.sql', import.meta.url),
  'utf8',
);
const botId = 'private-bot';
const source = (id) => ({ id, publication_id: `p-${id}`, schedule_id: `s-${id}` });
async function seed(db, id, count = 2) {
  await db.query('INSERT INTO publications(id) VALUES ($1)', [`p-${id}`]);
  await db.query('INSERT INTO publication_schedules(id,publication_id) VALUES ($1,$2)', [
    `s-${id}`,
    `p-${id}`,
  ]);
  await db.query(
    'INSERT INTO publication_occurrences(id,publication_id,schedule_id) VALUES ($1,$2,$3)',
    [id, `p-${id}`, `s-${id}`],
  );
  await db.query('INSERT INTO managed_broadcasts(id,publication_occurrence_id) VALUES ($1,$2)', [
    `b-${id}`,
    id,
  ]);
  await db.query('INSERT INTO managed_broadcast_occurrences(id,broadcast_id) VALUES ($1,$2)', [
    `bo-${id}`,
    `b-${id}`,
  ]);
  for (let position = 0; position < count; position++) {
    await db.query(
      'INSERT INTO publication_targets(id,publication_id,target_chat_id,position) VALUES ($1,$2,$3,$4)',
      [`t-${id}-${position}`, `p-${id}`, `chat-${position}`, position],
    );
    await db.query(
      'INSERT INTO managed_broadcast_deliveries(id,broadcast_id,target_chat_id,publication_occurrence_id) VALUES ($1,$2,$3,$4)',
      [`d-${id}-${position}`, `b-${id}`, `chat-${position}`, id],
    );
  }
  await db.query('UPDATE managed_broadcasts SET target_chat_ids=$1::jsonb WHERE id=$2', [
    JSON.stringify(Array.from({ length: count }, (_, position) => `chat-${position}`)),
    `b-${id}`,
  ]);
}
async function lite(t) {
  const store = new PGlite({
    parsers: { 1114: (value) => new Date(`${value.replace(' ', 'T')}Z`) },
  });
  t.after(() => store.close());
  await store.exec(fixture);
  return {
    query: (sql, params) =>
      typeof sql === 'string' ? store.query(sql, params) : store.query(sql.text, sql.values),
  };
}

test('retirement preserves uncertainty, new plans, retries, NOW and dynamic audiences', async (t) => {
  const db = await lite(t);
  await seed(db, 'safe');
  const safe = await readRetirementSnapshot(db, source('safe'));
  assert.equal(classifyRetirementSnapshot(safe, botId).safe, true);
  for (const mutate of [
    (row) => {
      row.occurrence.retry_authorized_at = '2026-10-19T23:00:00.001Z';
    },
    (row) => {
      row.occurrence.created_at = '2026-10-19T23:00:00.001Z';
    },
    (row) => {
      row.schedule.mode = 'NOW';
    },
    (row) => {
      row.publication.audience_mode = 'DYNAMIC';
    },
    (row) => {
      row.deliveries[0].attempt_count = 1;
    },
    (row) => {
      row.deliveries[1].remote_message_id = 'private-remote';
    },
    (row) => {
      row.deliveries[1].remote_message_verification_attempt_count = 1;
    },
    (row) => {
      row.deliveries[1].has_post_actions_token = true;
    },
    (row) => {
      row.deliveries[1].pin_attempt_count = 1;
    },
    (row) => {
      row.envelopes[0].has_lock_token = true;
    },
    (row) => {
      row.envelopes[0].cycle_enabled = true;
    },
    (row) => {
      row.envelopes[0].apply_to_all_chats = true;
    },
    (row) => {
      row.envelopes[0].target_chat_ids = [];
    },
    (row) => {
      row.envelopes[0].last_error_present = true;
    },
    (row) => {
      row.deliveries[0].last_error_code = 'unknown_http_result';
    },
    (row) => {
      row.envelopeDeliveries[0].rows[0].publication_occurrence_id = 'foreign';
    },
    (row) => {
      row.deliveries[0].required_bot_id = 'foreign';
    },
    (row) => {
      row.targets = Array.from({ length: 129 }, (_, position) => ({
        ...row.targets[0],
        target_chat_id: `chat-${position}`,
        position,
      }));
    },
  ]) {
    const changed = structuredClone(safe);
    mutate(changed);
    assert.equal(classifyRetirementSnapshot(changed, botId).safe, false, mutate.toString());
  }
  const intent = structuredClone(safe);
  intent.deliveries[0].pin_status = 'PENDING';
  intent.deliveries[0].delete_status = 'PENDING';
  intent.deliveries[0].delete_at = '2026-10-20T23:00:00.000Z';
  assert.equal(classifyRetirementSnapshot(intent, botId).safe, true);
});

test('envelope JSON is refused by storage size/compression before parsing an oversized audience', async (t) => {
  const db = await lite(t);
  await seed(db, 'oversized');
  await db.query(
    "UPDATE managed_broadcasts SET target_chat_ids=jsonb_build_array(repeat('private-large-audience-',4000)) WHERE id='b-oversized'",
  );
  const snapshot = await readRetirementSnapshot(db, source('oversized'));
  assert.equal(snapshot.envelopes[0].target_ids_type, null);
  assert.equal(snapshot.envelopes[0].target_chat_ids, null);
  assert.equal(classifyRetirementSnapshot(snapshot, botId).safe, false);
});

test('private cursor visits every equal-time row and named blocker without widening cutoff', async (t) => {
  const db = await lite(t);
  await seed(db, 'origin', 1);
  for (let n = 0; n < 70; n++) {
    await db.query(
      'INSERT INTO publication_occurrences(id,publication_id,schedule_id) VALUES ($1,$2,$3)',
      [`old-${String(n).padStart(3, '0')}`, 'p-origin', 's-origin'],
    );
  }
  await db.query(
    "INSERT INTO publication_occurrences(id,publication_id,schedule_id,dispatch_blocker_code) VALUES ('blocked','p-origin','s-origin','bot_not_admin')",
  );
  await db.query(
    "INSERT INTO publication_occurrences(id,publication_id,schedule_id,scheduled_at) VALUES ('future','p-origin','s-origin','2026-10-20T00:00:00')",
  );
  let cursors = initialRetirementCursors();
  const visited = [];
  for (let page = 0; page < 6; page++) {
    const preview = await previewRetirement(db, { botId, cursors });
    visited.push(...preview.candidates.map((row) => row.source.id));
    assert.ok(preview.report.heads.every((head) => head.sampled <= 32));
    cursors = preview.nextCursors;
    if (preview.report.sourceComplete) break;
  }
  assert.equal(visited.length, 72);
  assert.equal(new Set(visited).size, visited.length);
  assert.ok(!visited.includes('future'));
  assert.ok(Object.values(cursors).every((cursor) => cursor.done));
});

test('every saved first SEND ledger state refuses the whole occurrence', async (t) => {
  const db = await lite(t);
  await seed(db, 'ledger');
  const snapshot = await readRetirementSnapshot(db, source('ledger'));
  await db.query('INSERT INTO max_action_ledger(id,job_id) VALUES ($1,$2)', [
    'private-ledger',
    retirementSendKey(snapshot.deliveries[1]),
  ]);
  const preview = await previewRetirement(db, { botId });
  assert.equal(preview.report.eligible, 0);
  assert.equal(preview.report.refusals.ledger_evidence, 1);
});

test('host accepts only digest-nominated maintenance commands and exact runtime identities', () => {
  assert.deepEqual(parseRetirementArgs([]), { action: 'preview' });
  assert.equal(
    parseRetirementArgs(['preview', '--after-digest', 'a'.repeat(64)]).afterDigest,
    'a'.repeat(64),
  );
  assert.equal(parseRetirementArgs(['apply', '--reviewed-digest', 'b'.repeat(64)]).action, 'apply');
  for (const args of [
    ['apply'],
    ['--all'],
    ['preview', '--cutoff', RETIREMENT_CUTOFF],
    ['apply', '--reviewed-digest', '../private'],
  ])
    assert.throws(() => parseRetirementArgs(args));
  const sha = 'c'.repeat(40),
    image = `sha256:${'a'.repeat(64)}`;
  const oldExpected = process.env.MAXIM_EXPECTED_DEPLOY_SHA;
  process.env.MAXIM_EXPECTED_DEPLOY_SHA = sha;
  try {
    const run = (command, args) => {
      if (command === 'git') return args[0] === 'rev-parse' ? sha : '';
      if (args[0] === 'compose') return (args.at(-1) === 'api-admin' ? 'a' : 'b').repeat(64);
      if (args[0] === 'image')
        return JSON.stringify([
          {
            Id: image,
            Config: { Labels: { 'org.opencontainers.image.revision': 'd'.repeat(40) } },
          },
        ]);
      const admin = args[1] === 'a'.repeat(64);
      const service = admin ? 'api-admin' : 'api-publisher';
      return JSON.stringify([
        {
          Id: args[1],
          Image: image,
          RestartCount: 0,
          State: {
            Running: true,
            StartedAt: '2026-10-19T00:00:00Z',
            Health: { Status: 'healthy' },
          },
          Config: {
            Env: [
              `APP_ROLE=${admin ? 'admin' : 'publisher'}`,
              `MAX_PUBLISHER_BOT_ID=${botId}`,
              `MAX_BOT_ID=${admin ? 'private-major' : botId}`,
            ],
            Labels: {
              'com.docker.compose.project': 'infra',
              'com.docker.compose.service': service,
            },
          },
        },
      ]);
    };
    assert.equal(captureRetirementRuntime(run).runtimeSha, 'd'.repeat(40));
    assert.throws(() =>
      captureRetirementRuntime((command, args) =>
        command === 'docker' && args[0] === 'inspect'
          ? run(command, args).replace('healthy', 'unhealthy')
          : run(command, args),
      ),
    );
  } finally {
    if (oldExpected === undefined) delete process.env.MAXIM_EXPECTED_DEPLOY_SHA;
    else process.env.MAXIM_EXPECTED_DEPLOY_SHA = oldExpected;
  }
});

const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'native PostgreSQL atomically retires all targets, refuses uncertain neighbors and races, and bounds skewed index heads',
  { skip: !nativeUrl, timeout: 90_000 },
  async (t) => {
    const address = new URL(nativeUrl);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname));
    assert.match(address.pathname, /^\/(?:race_test|maxim_race_test_[a-f0-9]+)$/u);
    const { default: pg } = await import('pg');
    const types = new pg.TypeOverrides();
    types.setTypeParser(1114, (value) => new Date(`${value.replace(' ', 'T')}Z`));
    const database = `race_test_publik_retirement_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: address.href });
    const child = new URL(address);
    child.pathname = `/${database}`;
    const db = new pg.Client({
      connectionString: child.href,
      types,
      options: '-c timezone=Asia/Tokyo -c statement_timeout=5000 -c lock_timeout=150',
    });
    const rival = new pg.Client({ connectionString: child.href, types });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    t.after(async () => {
      await rival.end();
      await db.end();
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await admin.end();
    });
    await db.connect();
    await rival.connect();
    await db.query(fixture);
    await attestRetirementIndexes(db);
    for (const id of [
      'safe',
      'uncertain',
      'raced',
      'ledger-race',
      'locked',
      'retry',
      'newer',
      'immediate',
    ])
      await seed(db, id);
    const checkedShapes = new Set();
    const checkedReads = {
      query: async (query, params) => {
        const sql = typeof query === 'string' ? query : query.text;
        if (/^SELECT\b/iu.test(sql) && /\bpublic\./u.test(sql) && !checkedShapes.has(sql)) {
          await inspectRetirementReadPlan(db, query, params);
          checkedShapes.add(sql);
        }
        return db.query(query, params);
      },
    };
    await db.query('SET enable_seqscan=off; SET enable_bitmapscan=off;');
    await db.query(
      "UPDATE managed_broadcast_deliveries SET pin_status='PENDING',delete_status='PENDING',delete_at='2026-10-20T23:00:00' WHERE id='d-safe-0'",
    );
    await db.query(
      "UPDATE managed_broadcast_deliveries SET remote_message_id='private-uncertain',status='AMBIGUOUS',attempt_count=1 WHERE id='d-uncertain-1'",
    );
    await db.query(
      "UPDATE publication_occurrences SET retry_authorized_at='2026-10-19T23:00:00.001' WHERE id='retry'",
    );
    await db.query(
      "UPDATE publication_occurrences SET created_at='2026-10-19T23:00:00.001' WHERE id='newer'",
    );
    await db.query("UPDATE publication_schedules SET mode='NOW' WHERE id='s-immediate'");
    const preview = await previewRetirement(checkedReads, { botId });
    assert.deepEqual(preview.candidates.map((row) => row.source.id).sort(), [
      'ledger-race',
      'locked',
      'raced',
      'safe',
    ]);
    await db.query(
      "UPDATE managed_broadcast_deliveries SET attempt_count=1,status='SENDING' WHERE id='d-raced-0'",
    );
    const ledgerSnapshot = await readRetirementSnapshot(db, source('ledger-race'));
    await db.query('INSERT INTO max_action_ledger(id,job_id) VALUES ($1,$2)', [
      'private-ledger',
      retirementSendKey(ledgerSnapshot.deliveries[0]),
    ]);
    await rival.query('BEGIN');
    await rival.query(
      "SELECT id FROM managed_broadcast_deliveries WHERE id='d-locked-0' FOR UPDATE",
    );
    const applied = await applyRetirement(db, preview, botId);
    await rival.query('ROLLBACK');
    assert.equal(applied.canceled, 1);
    assert.equal(applied.deliveries, 2);
    assert.equal(applied.refused.writer_busy, 1);
    assert.equal(applied.refused.ledger_evidence, 1);
    assert.equal(applied.refused.delivery_started_or_uncertain, 1);
    const statuses = (await db.query('SELECT id,status FROM publication_occurrences ORDER BY id'))
      .rows;
    assert.equal(statuses.find((row) => row.id === 'safe').status, 'CANCELED');
    assert.ok(
      statuses.filter((row) => row.id !== 'safe').every((row) => row.status === 'SCHEDULED'),
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT status,delete_at FROM managed_broadcast_deliveries WHERE publication_occurrence_id='safe' ORDER BY id",
        )
      ).rows.map((row) => row.status),
      ['CANCELED', 'CANCELED'],
    );
    assert.ok(
      (await db.query("SELECT delete_at FROM managed_broadcast_deliveries WHERE id='d-safe-0'"))
        .rows[0].delete_at,
    );
    assert.equal(
      (await db.query("SELECT status FROM managed_broadcasts WHERE id='b-safe'")).rows[0].status,
      'CANCELED',
    );
    assert.equal(
      (await db.query("SELECT lifecycle FROM publications WHERE id='p-safe'")).rows[0].lifecycle,
      'ACTIVE',
    );
    assert.equal(
      (await db.query("SELECT status FROM publication_schedules WHERE id='s-safe'")).rows[0].status,
      'ACTIVE',
    );
    // A failed second-target update proves that no sibling/envelope/occurrence
    // cancellation commits until every target succeeds.
    await seed(db, 'rollback');
    const rollbackPlan = await previewRetirement(db, { botId });
    const selected = {
      candidates: rollbackPlan.candidates.filter((row) => row.source.id === 'rollback'),
    };
    await db.query(`CREATE FUNCTION fail_retirement_second_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='d-rollback-0' AND NEW.status='CANCELED' THEN RAISE EXCEPTION 'test refusal'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_retirement BEFORE UPDATE ON managed_broadcast_deliveries FOR EACH ROW EXECUTE FUNCTION fail_retirement_second_target();`);
    await assert.rejects(applyRetirement(db, selected, botId));
    assert.ok(
      (
        await db.query(
          "SELECT status FROM managed_broadcast_deliveries WHERE publication_occurrence_id='rollback'",
        )
      ).rows.every((row) => row.status === 'PENDING'),
    );
    assert.equal(
      (await db.query("SELECT status FROM managed_broadcasts WHERE id='b-rollback'")).rows[0]
        .status,
      'ACTIVE',
    );
    await db.query(`INSERT INTO publication_occurrences(id,publication_id,schedule_id,scheduled_at,dispatch_blocker_code)
    SELECT 'skew-'||n,'p-safe','s-safe','2026-10-19T22:00:00',CASE WHEN n<=10000 THEN NULL ELSE 'bot_not_admin' END FROM generate_series(1,20000) n;
    ANALYZE; SET enable_seqscan=off; SET enable_bitmapscan=off; SET max_parallel_workers_per_gather=0; SET work_mem='1MB';`);
    const evidence = [];
    for (const cursor of [
      { blocker: null, after: null },
      { blocker: 'bot_not_admin', after: null },
      {
        blocker: 'bot_not_admin',
        after: { scheduledAt: '2026-10-19T22:00:00.000Z', id: 'skew-10050' },
      },
    ]) {
      const query = buildRetirementSourceQuery('SCHEDULED', cursor);
      const plan = (
        await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, query.values)
      ).rows[0]['QUERY PLAN'][0].Plan;
      assert.equal(plan['Node Type'], 'Limit');
      const scan = plan.Plans[0];
      assert.equal(scan['Index Name'], 'publication_occurrences_ready_dispatch_idx');
      assert.ok(['Index Scan', 'Index Only Scan'].includes(scan['Node Type']));
      assert.equal(scan.Filter, undefined);
      assert.ok(scan['Actual Rows'] <= 33);
      for (const key of ['dispatch_profile', 'status', 'dispatch_blocker_code', 'scheduled_at'])
        assert.ok(scan['Index Cond'].includes(key));
      evidence.push({
        index: scan['Index Name'],
        rows: scan['Actual Rows'],
        removed: scan['Rows Removed by Filter'] ?? 0,
      });
    }
    const query = buildRetirementBlockerQuery('SCHEDULED', null);
    const plan = (
      await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, query.values)
    ).rows[0]['QUERY PLAN'][0].Plan;
    assert.equal(plan['Node Type'], 'Limit');
    assert.equal(plan.Plans[0]['Index Name'], 'publication_occurrences_ready_dispatch_idx');
    assert.ok(plan.Plans[0]['Actual Rows'] <= 1);
    t.diagnostic(
      JSON.stringify({
        atomicTargets: 2,
        uncertainNeighborPreserved: true,
        racingClaimPreserved: true,
        ledgerRacePreserved: true,
        lockedWriterPreserved: true,
        rollbackAtomic: true,
        boundedHeads: evidence,
      }),
    );
  },
);
