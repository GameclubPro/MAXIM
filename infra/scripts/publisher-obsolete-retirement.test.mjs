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
  RETIREMENT_STOP_OPERATION,
  retirementPlanMatchesOperation,
  retirementSendKey,
} from './publisher-obsolete-retirement.mjs';
import {
  captureRetirementRuntime,
  executeRetirementCommand,
  parseRetirementArgs,
  probeRetirementAdminHealth,
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

test('host accepts only digest-nominated maintenance commands', () => {
  assert.deepEqual(parseRetirementArgs([]), { action: 'preview' });
  assert.equal(
    parseRetirementArgs(['preview', '--after-digest', 'a'.repeat(64)]).afterDigest,
    'a'.repeat(64),
  );
  assert.equal(parseRetirementArgs(['apply', '--reviewed-digest', 'b'.repeat(64)]).action, 'apply');
  assert.deepEqual(parseRetirementArgs(['stop-preview']), {
    action: 'preview',
    operation: RETIREMENT_STOP_OPERATION,
  });
  assert.deepEqual(parseRetirementArgs(['stop-preview', '--after-digest', 'a'.repeat(64)]), {
    action: 'preview',
    operation: RETIREMENT_STOP_OPERATION,
    afterDigest: 'a'.repeat(64),
  });
  assert.deepEqual(parseRetirementArgs(['stop-apply', '--reviewed-digest', 'b'.repeat(64)]), {
    action: 'apply',
    operation: RETIREMENT_STOP_OPERATION,
    reviewedDigest: 'b'.repeat(64),
  });
  for (const args of [
    ['apply'],
    ['--all'],
    ['preview', '--cutoff', RETIREMENT_CUTOFF],
    ['apply', '--reviewed-digest', '../private'],
    ['stop-apply'],
    ['stop-apply', '--reviewed-digest', '../private'],
    ['stop-preview', '--all'],
  ])
    assert.throws(() => parseRetirementArgs(args));
});

test('host binds reviewed plans and continuation digests to their exact operation', () => {
  const untouched = { version: 1 };
  const stop = { version: 2, operation: RETIREMENT_STOP_OPERATION };
  assert.equal(retirementPlanMatchesOperation(untouched), true);
  assert.equal(retirementPlanMatchesOperation(stop, RETIREMENT_STOP_OPERATION), true);
  assert.equal(retirementPlanMatchesOperation(untouched, RETIREMENT_STOP_OPERATION), false);
  assert.equal(retirementPlanMatchesOperation(stop), false);
  assert.equal(retirementPlanMatchesOperation({ ...untouched, operation: 'stop-only' }), false);
  assert.equal(retirementPlanMatchesOperation({ ...stop, version: 1 }, 'stop-only'), false);
  assert.equal(retirementPlanMatchesOperation({ version: 2 }, 'stop-only'), false);
  assert.equal(retirementPlanMatchesOperation(untouched, 'unknown'), false);
});

function runtimeFixture(t) {
  const sha = 'c'.repeat(40),
    image = `sha256:${'a'.repeat(64)}`;
  const oldExpected = process.env.MAXIM_EXPECTED_DEPLOY_SHA;
  process.env.MAXIM_EXPECTED_DEPLOY_SHA = sha;
  t.after(() => {
    if (oldExpected === undefined) delete process.env.MAXIM_EXPECTED_DEPLOY_SHA;
    else process.env.MAXIM_EXPECTED_DEPLOY_SHA = oldExpected;
  });
  const rows = new Map(
    ['api-admin', 'api-publisher'].map((service) => {
      const admin = service === 'api-admin';
      return [
        service,
        {
          Id: (admin ? 'a' : 'b').repeat(64),
          Image: image,
          RestartCount: 0,
          State: {
            Running: true,
            Status: 'running',
            StartedAt: '2026-10-19T00:00:00Z',
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
      ];
    }),
  );
  const context = {
    rows,
    calls: [],
    proof: JSON.stringify({ live: true, ready: true }),
    afterProbe: () => {},
  };
  context.run = (command, args, options) => {
    context.calls.push({ command, args, options });
    if (command === 'git') return args[0] === 'rev-parse' ? sha : '';
    assert.equal(command, 'docker');
    if (args[0] === 'compose') return rows.get(args.at(-1))?.Id ?? '';
    if (args[0] === 'image')
      return JSON.stringify([
        {
          Id: image,
          Config: { Labels: { 'org.opencontainers.image.revision': 'd'.repeat(40) } },
        },
      ]);
    if (args[0] === 'exec') {
      assert.deepEqual(args.slice(0, 5), [
        'exec',
        'a'.repeat(64),
        'node',
        '--input-type=module',
        '-e',
      ]);
      assert.equal(options.timeout, 10_000);
      assert.equal(options.maxBuffer, 1024);
      context.afterProbe();
      return context.proof;
    }
    assert.equal(args[0], 'inspect');
    const row = [...rows.values()].find((value) => value.Id === args[1]);
    return JSON.stringify(row ? [row] : []);
  };
  return context;
}

test('host captures exact headless Publisher and admin generations without Docker Health', (t) => {
  const context = runtimeFixture(t);
  const result = captureRetirementRuntime(context.run);
  assert.equal(result.runtimeSha, 'd'.repeat(40));
  assert.equal(result.generations.length, 2);
  assert.ok([...context.rows.values()].every((row) => !Object.hasOwn(row.State, 'Health')));
  assert.equal(context.calls.filter((call) => call.args[0] === 'exec').length, 1);
  assert.equal(context.calls.filter((call) => call.args[0] === 'inspect').length, 4);
});

test('host refuses missing roles, non-running generations and optional unhealthy Docker Health', (t) => {
  const context = runtimeFixture(t);
  for (const service of ['api-admin', 'api-publisher']) {
    const original = structuredClone(context.rows.get(service));
    context.rows.delete(service);
    assert.throws(() => captureRetirementRuntime(context.run), /exact_running_roles_required/u);
    context.rows.set(service, original);
    for (const health of [null, {}, { Status: 'starting' }, { Status: 'unhealthy' }]) {
      original.State.Health = health;
      assert.throws(() => captureRetirementRuntime(context.run), /runtime_generation_unproved/u);
    }
    delete original.State.Health;
    for (const status of ['paused', 'restarting', 'exited']) {
      original.State.Status = status;
      assert.throws(() => captureRetirementRuntime(context.run), /runtime_generation_unproved/u);
    }
    original.State.Status = 'running';
    original.State.Running = false;
    assert.throws(() => captureRetirementRuntime(context.run), /runtime_generation_unproved/u);
    original.State.Running = true;
    original.State.Health = { Status: 'healthy' };
    assert.equal(captureRetirementRuntime(context.run).runtimeSha, 'd'.repeat(40));
    delete original.State.Health;
  }
});

test('host refuses generation replacement or restart during exact admin health proof', (t) => {
  const context = runtimeFixture(t);
  for (const service of ['api-admin', 'api-publisher']) {
    const original = structuredClone(context.rows.get(service));
    for (const mutation of [
      (row) => (row.Id = 'e'.repeat(64)),
      (row) => (row.RestartCount += 1),
      (row) => (row.State.StartedAt = '2026-10-20T00:00:00Z'),
      (row) => (row.Image = `sha256:${'e'.repeat(64)}`),
      (row) => (row.Config.Labels['com.docker.compose.project'] = 'foreign'),
    ]) {
      context.afterProbe = () => mutation(context.rows.get(service));
      assert.throws(
        () => captureRetirementRuntime(context.run),
        /runtime_changed_during_health_probe|publisher_identity_unproved|runtime_generation_unproved/u,
      );
      context.rows.set(service, structuredClone(original));
    }
  }
});

test('host refuses missing health acknowledgement and sanitizes HTTP command failures', (t) => {
  const context = runtimeFixture(t);
  for (const proof of ['', '{}', '{"live":true}', '{"live":true,"ready":false}', 'null']) {
    context.proof = proof;
    assert.throws(() => captureRetirementRuntime(context.run), /^Error: runtime_health_unproved$/u);
  }
  context.afterProbe = () => {
    throw new Error('private HTTP response and credentials must not escape');
  };
  assert.throws(() => captureRetirementRuntime(context.run), /^Error: runtime_health_unproved$/u);
});

test('host administrative health uses strict bounded local live and ready JSON contracts', async () => {
  const calls = [];
  const result = await probeRetirementAdminHealth(async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.accept, 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return Response.json({ ok: true });
  });
  assert.deepEqual(result, { live: true, ready: true });
  assert.deepEqual(calls, [
    'http://127.0.0.1:3001/api/health/live',
    'http://127.0.0.1:3001/api/health/ready',
  ]);
});

test('host administrative health refuses failed HTTP, redirects, missing or malformed JSON and timeouts', async () => {
  for (const endpoint of ['live', 'ready']) {
    for (const response of [
      () => Response.json({ ok: true }, { status: 503 }),
      () => new Response(null, { status: 302, headers: { location: 'https://external.invalid' } }),
      () => new Response(null, { status: 204 }),
      () => Response.json({}),
      () => Response.json({ ok: false }),
      () => Response.json({ ok: 'true' }),
      () => new Response('malformed'),
      () => {
        throw new TypeError('network or redirect unavailable');
      },
      () => {
        throw new DOMException('request timeout', 'TimeoutError');
      },
    ])
      await assert.rejects(
        probeRetirementAdminHealth(async (url) =>
          url.endsWith(`/${endpoint}`) ? response() : Response.json({ ok: true }),
        ),
      );
  }
});

test('host administrative health bounds declared and streamed response bytes before JSON parsing', async () => {
  await assert.rejects(
    probeRetirementAdminHealth(async () =>
      Response.json({ ok: true }, { headers: { 'content-length': String(256 * 1024 + 1) } }),
    ),
    /runtime_health_unproved/u,
  );
  let canceled = false;
  await assert.rejects(
    probeRetirementAdminHealth(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(256 * 1024));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    ),
    /runtime_health_unproved/u,
  );
  assert.equal(canceled, true);
});

test('host command boundary pipes supplied helper source into a real child stdin', () => {
  const source = 'process.stdout.write(JSON.stringify({ helperRan: true }));\n';
  assert.equal(
    executeRetirementCommand(process.execPath, ['--input-type=module', '-'], {
      input: source,
      timeout: 1000,
      maxBuffer: 1024,
    }),
    '{"helperRan":true}',
  );
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
