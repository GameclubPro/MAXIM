import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  applyStopRetirement,
  attestRetirementIndexes,
  buildRetirementBlockerQuery,
  buildStopRetirementSourceQuery,
  classifyStopRetirementSnapshot,
  initialStopRetirementCursors,
  inspectRetirementReadPlan,
  previewStopRetirement,
  readStopRetirementSnapshot,
  RETIREMENT_CUTOFF,
  RETIREMENT_STOP_STATUSES,
  retirementSnapshotDigest,
} from './publisher-obsolete-retirement.mjs';

const fixture = readFileSync(
  new URL('./test-fixtures/publisher-obsolete-retirement.sql', import.meta.url),
  'utf8',
);
const botId = 'private-bot';
const incompleteStatuses = ['SCHEDULED', 'IN_PROGRESS', 'FAILED', 'PARTIAL', 'AMBIGUOUS'];
const tables = [
  'publications',
  'publication_schedules',
  'publication_occurrences',
  'publication_targets',
  'managed_broadcasts',
  'managed_broadcast_occurrences',
  'managed_broadcast_deliveries',
  'max_action_ledger',
];
const source = (id) => ({ id, publication_id: 'p-' + id, schedule_id: 's-' + id });
const envelopeIds = (id) => ['b-' + id + '-CHAT', 'b-' + id + '-CHANNEL'];

async function lite(t) {
  const store = new PGlite({
    parsers: { 1114: (value) => new Date(value.replace(' ', 'T') + 'Z') },
  });
  t.after(() => store.close());
  await store.exec(fixture);
  return {
    query: async (query, values) => {
      const result = await (typeof query === 'string'
        ? store.query(query, values)
        : store.query(query.text, query.values));
      return { ...result, rowCount: result.affectedRows };
    },
  };
}

async function seed(db, id, status = 'SCHEDULED') {
  await db.query('INSERT INTO publications(id) VALUES ($1)', ['p-' + id]);
  await db.query('INSERT INTO publication_schedules(id,publication_id) VALUES ($1,$2)', [
    's-' + id,
    'p-' + id,
  ]);
  await db.query(
    'INSERT INTO publication_occurrences(id,publication_id,schedule_id,status) VALUES ($1,$2,$3,$4)',
    [id, 'p-' + id, 's-' + id, status],
  );
  await db.query(
    "INSERT INTO publication_occurrences(id,publication_id,schedule_id,scheduled_at) VALUES ($1,$2,$3,'2026-10-20T05:00:00')",
    ['future-' + id, 'p-' + id, 's-' + id],
  );
  for (const [position, entity] of ['CHAT', 'CHANNEL'].entries()) {
    const envelope = 'b-' + id + '-' + entity;
    await db.query(
      'INSERT INTO publication_targets(id,publication_id,target_chat_id,entity_type,position) VALUES ($1,$2,$3,$4,$5)',
      ['target-' + id + '-' + entity, 'p-' + id, 'old-target-' + entity, entity, position],
    );
    await db.query(
      "INSERT INTO managed_broadcasts(id,entity_type,status,publication_occurrence_id,sent_count,locked_at,lock_token,last_error,target_chat_ids) VALUES ($1,$2,$3,$4,$5,'2026-10-19T22:00:01',$6,$7,$8::jsonb)",
      [
        envelope,
        entity,
        position === 0 ? 'ACTIVE' : 'PARTIAL',
        id,
        position + 1,
        'private-envelope-token-' + envelope,
        'retained uncertain result',
        JSON.stringify({ mismatched: ['historical-target'], entity }),
      ],
    );
    await db.query(
      "INSERT INTO managed_broadcast_occurrences(id,broadcast_id,status) VALUES ($1,$2,'PARTIAL')",
      ['slot-' + envelope, envelope],
    );
    for (const [attempt, deliveryStatus] of ['SENDING', 'SENT', 'AMBIGUOUS'].entries()) {
      const delivery = 'delivery-' + envelope + '-' + attempt;
      const target = 'actual-target-' + entity + '-' + attempt;
      await db.query(
        [
          'INSERT INTO managed_broadcast_deliveries(',
          'id,broadcast_id,target_chat_id,publication_occurrence_id,status,attempt_count,',
          'remote_message_id,remote_message_verified_at,remote_message_verification_attempt_count,',
          'remote_message_verification_absent_count,remote_message_verification_present_count,',
          'remote_message_verification_attempted_at,remote_message_verification_next_at,',
          'remote_message_verification_last_error,remote_message_verification_source,',
          'legacy_sent_without_remote_id,sent_at,post_actions_next_at,post_actions_token,',
          'subscription_delete_id,pin_status,pin_attempt_count,pin_error,delete_status,',
          'delete_at,deleted_at,delete_attempt_count,delete_error,locked_at,lock_token,',
          'bot_id,dialog_bot_id,last_error_code,last_error)',
          "VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-10-19T22:01:00',3,1,2,",
          "'2026-10-19T22:00:30','2026-10-20T01:00:00','retained verification error',",
          "'AUTOMATED_STABLE',true,'2026-10-19T22:00:10','2026-10-20T02:00:00',",
          "$8,$9,'FAILED',2,'retained pin error','PENDING','2026-10-21T02:00:00',",
          "'2026-10-19T22:02:00',4,'retained delete error','2026-10-19T22:00:01',",
          "$10,'private-bot','private-bot','PUBLIK_LEDGER_DISPATCH_V1','retained send error')",
        ].join(' '),
        [
          delivery,
          envelope,
          target,
          id,
          deliveryStatus,
          attempt + 1,
          'private-remote-' + delivery,
          'private-post-action-token-' + delivery,
          'private-subscription-' + delivery,
          'private-delivery-token-' + delivery,
        ],
      );
      await db.query('INSERT INTO max_action_ledger(id,job_id) VALUES ($1,$2)', [
        'ledger-' + delivery,
        'managed-broadcast:send:' +
          envelope +
          ':occurrence:1:target:' +
          target +
          ':content:publication-private-content',
      ]);
    }
  }
  await db.query('UPDATE publication_occurrences SET legacy_broadcast_id=$1 WHERE id=$2', [
    envelopeIds(id)[0],
    id,
  ]);
}

async function evidence(db) {
  const result = {};
  for (const table of tables)
    result[table] = (await db.query('SELECT * FROM ' + table + ' ORDER BY id')).rows;
  return result;
}

function without(row, names) {
  return Object.fromEntries(Object.entries(row).filter(([name]) => !names.includes(name)));
}

function assertOnlyStopChanges(before, after, canceledOccurrences, stoppedEnvelopes) {
  const occurrenceSet = new Set(canceledOccurrences);
  const envelopeSet = new Set(stoppedEnvelopes);
  for (const table of tables) {
    const previous = before[table];
    const current = after[table];
    assert.equal(current.length, previous.length, table + ' row count');
    if (!['publication_occurrences', 'managed_broadcasts'].includes(table)) {
      assert.deepEqual(current, previous, table + ' must remain byte-for-byte unchanged');
      continue;
    }
    for (const [index, row] of previous.entries()) {
      const actual = current[index];
      assert.equal(actual.id, row.id);
      if (table === 'publication_occurrences' && occurrenceSet.has(row.id)) {
        assert.equal(actual.status, 'CANCELED');
        assert.deepEqual(
          without(actual, ['status', 'updated_at']),
          without(row, ['status', 'updated_at']),
        );
      } else if (table === 'managed_broadcasts' && envelopeSet.has(row.id)) {
        assert.equal(actual.status, 'CANCELED');
        assert.equal(actual.next_send_at, null);
        assert.deepEqual(
          without(actual, ['status', 'next_send_at', 'updated_at']),
          without(row, ['status', 'next_send_at', 'updated_at']),
        );
      } else assert.deepEqual(actual, row, table + ' unrelated/terminal row ' + row.id);
    }
  }
}

function assertStopSql(sql) {
  const compact = sql.trim().replace(/\s+/gu, ' ');
  if (/^SELECT\b/iu.test(compact)) {
    assert.doesNotMatch(
      compact,
      /\b(?:managed_broadcast_deliveries|max_action_ledger|publication_targets|target_chat_ids)\b/iu,
    );
    const allowed = new Set([
      'publications',
      'publication_schedules',
      'publication_occurrences',
      'managed_broadcasts',
      'managed_broadcast_occurrences',
    ]);
    for (const match of compact.matchAll(/\b(?:FROM|JOIN) public\.([a-z_]+)/giu))
      assert.ok(allowed.has(match[1]), 'unexpected stop read: ' + match[1]);
    return;
  }
  const mutation =
    /^UPDATE public\.(publication_occurrences|managed_broadcasts) SET (.+?) WHERE\b/iu.exec(
      compact,
    );
  if (mutation) {
    const allowed =
      mutation[1] === 'publication_occurrences'
        ? ['status', 'updated_at']
        : ['status', 'next_send_at', 'updated_at'];
    for (const assignment of mutation[2].split(','))
      assert.ok(
        allowed.includes(assignment.split('=')[0].trim()),
        'unexpected stop write: ' + compact,
      );
    return;
  }
  assert.ok(
    ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(compact),
    'unexpected stop statement: ' + compact,
  );
}

function stopDb(db, log = []) {
  return {
    query: async (query, values) => {
      const text = typeof query === 'string' ? query : query.text;
      const parameters = typeof query === 'string' ? values : query.values;
      assertStopSql(text);
      const result = await db.query(text, parameters);
      log.push({ text, values: parameters, rows: result.rows });
      return result;
    },
  };
}

async function planFor(db, id) {
  const snapshot = await readStopRetirementSnapshot(db, source(id));
  const result = classifyStopRetirementSnapshot(snapshot, botId);
  assert.equal(result.safe, true);
  assert.equal(result.noAction, false);
  return {
    candidates: [
      {
        source: source(id),
        snapshotDigest: retirementSnapshotDigest(snapshot),
        cancelOccurrence: result.cancelOccurrence,
        envelopes: result.envelopes,
      },
    ],
  };
}

test('stop-only cancels five incomplete states, preserves SENT/CANCELED parents and all child evidence', async (t) => {
  const db = await lite(t);
  for (const status of RETIREMENT_STOP_STATUSES) await seed(db, status, status);
  await db.query("UPDATE managed_broadcasts SET status='FAILED' WHERE id='b-FAILED-CHANNEL'");
  const before = await evidence(db);
  const traced = stopDb(db);
  const preview = await previewStopRetirement(traced, { botId });
  assert.deepEqual(
    preview.candidates.map((row) => row.source.id).sort(),
    [...RETIREMENT_STOP_STATUSES].sort(),
  );
  assert.equal(preview.report.occurrencesToCancel, 5);
  assert.equal(preview.report.envelopes, 14);
  const applied = await applyStopRetirement(traced, preview, botId);
  assert.deepEqual(applied, {
    stopped: 7,
    canceled: 5,
    envelopes: 14,
    preservedOccurrences: 2,
    refused: {},
  });
  assertOnlyStopChanges(
    before,
    await evidence(db),
    incompleteStatuses,
    RETIREMENT_STOP_STATUSES.flatMap(envelopeIds),
  );
});

test('stop-only accepts late child ACK and lease changes between preview and apply', async (t) => {
  const db = await lite(t);
  await seed(db, 'late-ack', 'AMBIGUOUS');
  const traced = stopDb(db);
  const preview = await planFor(traced, 'late-ack');
  await db.query(
    "UPDATE managed_broadcast_deliveries SET status='SENT',remote_message_id='private-late-ack',attempt_count=8,lock_token='private-new-owner',post_actions_token='private-new-post-action',updated_at='2026-10-20T00:01:00' WHERE id='delivery-b-late-ack-CHAT-0'",
  );
  await db.query(
    "UPDATE managed_broadcast_occurrences SET status='COMPLETED',updated_at='2026-10-20T00:01:00' WHERE broadcast_id='b-late-ack-CHAT'",
  );
  await db.query(
    "UPDATE managed_broadcasts SET sent_count=12,lock_token='private-new-envelope-owner',locked_at='2026-10-20T00:01:00',updated_at='2026-10-20T00:01:00' WHERE id='b-late-ack-CHAT'",
  );
  const before = await evidence(db);
  const applied = await applyStopRetirement(traced, preview, botId);
  assert.equal(applied.stopped, 1);
  assert.deepEqual(applied.refused, {});
  assertOnlyStopChanges(before, await evidence(db), ['late-ack'], envelopeIds('late-ack'));
});

test('stop-only preserves scope, calendar shape and exact identity refusals', async (t) => {
  const db = await lite(t);
  await seed(db, 'scope');
  const original = await readStopRetirementSnapshot(stopDb(db), source('scope'));
  const mutations = [
    [
      'newer_plan',
      (row) => {
        row.occurrence.scheduled_at = '2026-10-19T23:00:00.001Z';
      },
    ],
    ...['publication', 'schedule', 'occurrence'].map((key) => [
      'newer_plan',
      (row) => {
        row[key].created_at = '2026-10-19T23:00:00.001Z';
      },
    ]),
    [
      'newer_explicit_retry',
      (row) => {
        row.occurrence.retry_authorized_at = '2026-10-19T23:00:00.001Z';
      },
    ],
    [
      'newer_explicit_retry',
      (row) => {
        row.occurrence.dispatch_blocker_code = 'PUBLISHER_EXPLICIT_RETRY';
        row.occurrence.dispatch_blocked_at = '2026-10-19T23:00:00.001Z';
      },
    ],
    [
      'newer_explicit_retry',
      (row) => {
        row.occurrence.dispatch_blocker_code = 'PUBLISHER_EXPLICIT_RETRY';
        row.occurrence.dispatch_blocked_at = null;
      },
    ],
    [
      'not_scheduled_mode',
      (row) => {
        row.schedule.mode = 'NOW';
      },
    ],
    [
      'dynamic_audience',
      (row) => {
        row.publication.audience_mode = 'DYNAMIC';
      },
    ],
    [
      'future_or_mismatched_envelope_slots',
      (row) => {
        row.envelopes[0].cycle_enabled = true;
      },
    ],
    [
      'future_or_mismatched_envelope_slots',
      (row) => {
        row.envelopes[0].cycle_count = 2;
      },
    ],
    [
      'future_or_mismatched_envelope_slots',
      (row) => {
        row.envelopeOccurrences[0].rows.push({
          ...row.envelopeOccurrences[0].rows[0],
          id: 'second',
          occurrence_index: 2,
        });
      },
    ],
    [
      'future_or_mismatched_envelope_slots',
      (row) => {
        row.envelopeOccurrences[0].rows[0].occurrence_index = 2;
      },
    ],
    [
      'future_or_mismatched_envelope_slots',
      (row) => {
        row.envelopeOccurrences[0].rows[0].scheduled_at = '2026-10-20T05:00:00.000Z';
      },
    ],
    [
      'foreign_bot_or_profile',
      (row) => {
        row.occurrence.required_bot_id = 'foreign';
      },
    ],
    [
      'foreign_bot_or_profile',
      (row) => {
        row.publication.dispatch_profile = 'LEGACY_ROUTED';
      },
    ],
    [
      'parent_mismatch',
      (row) => {
        row.schedule.publication_id = 'foreign';
      },
    ],
    [
      'foreign_legacy_envelope',
      (row) => {
        row.occurrence.legacy_broadcast_id = 'foreign';
      },
    ],
    [
      'envelope_identity_mismatch',
      (row) => {
        row.envelopes[0].required_bot_id = 'foreign';
      },
    ],
  ];
  for (const [reason, mutate] of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.deepEqual(classifyStopRetirementSnapshot(changed, botId), { safe: false, reason });
  }
  const cutoff = structuredClone(original);
  cutoff.occurrence.scheduled_at = RETIREMENT_CUTOFF;
  cutoff.occurrence.retry_authorized_at = RETIREMENT_CUTOFF;
  for (const entry of cutoff.envelopeOccurrences)
    for (const slot of entry.rows) slot.scheduled_at = RETIREMENT_CUTOFF;
  assert.equal(classifyStopRetirementSnapshot(cutoff, botId).safe, true);
});

test('stop-only allows historical canonical, schedule and audience drift without inspecting targets', async (t) => {
  const db = await lite(t);
  await seed(db, 'historical');
  await db.query(
    "UPDATE publications SET canonical_content_revision_id='new-parent-content' WHERE id='p-historical'",
  );
  await db.query("UPDATE publication_schedules SET revision=7 WHERE id='s-historical'");
  await db.query("DELETE FROM publication_targets WHERE publication_id='p-historical'");
  await db.query(
    "UPDATE managed_broadcasts SET target_chat_ids=jsonb_build_object('opaque',repeat('private-',20000)),publication_content_revision_id='different-envelope-content',apply_to_all_chats=true WHERE publication_occurrence_id='historical'",
  );
  const before = await evidence(db);
  const log = [];
  const traced = stopDb(db, log);
  const preview = await planFor(traced, 'historical');
  assert.equal((await applyStopRetirement(traced, preview, botId)).stopped, 1);
  assertOnlyStopChanges(before, await evidence(db), ['historical'], envelopeIds('historical'));
  assert.ok(log.some((row) => /^UPDATE public\.publication_occurrences/iu.test(row.text)));
  assert.ok(log.some((row) => /^UPDATE public\.managed_broadcasts/iu.test(row.text)));
});

test('stop-only visits every status/blocker at equal times within the global 96-row page cap', async (t) => {
  const db = await lite(t);
  await db.query("INSERT INTO publications(id) VALUES ('p-discovery')");
  await db.query(
    "INSERT INTO publication_schedules(id,publication_id) VALUES ('s-discovery','p-discovery')",
  );
  const expected = [];
  for (const status of RETIREMENT_STOP_STATUSES) {
    await db.query(
      "INSERT INTO publication_occurrences(id,publication_id,schedule_id,status) SELECT $1||lpad(n::text,3,'0'),'p-discovery','s-discovery',$2::\"PublicationOccurrenceStatus\" FROM generate_series(1,40) n",
      ['scan-' + status + '-', status],
    );
    for (let number = 1; number <= 40; number++)
      expected.push('scan-' + status + '-' + String(number).padStart(3, '0'));
    await db.query(
      "INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,dispatch_blocker_code) VALUES ($1,'p-discovery','s-discovery',$2,'bot_not_admin')",
      ['named-' + status, status],
    );
    expected.push('named-' + status);
  }
  await db.query(
    "INSERT INTO publication_occurrences(id,publication_id,schedule_id,scheduled_at) VALUES ('future-discovery','p-discovery','s-discovery','2026-10-20T00:00:00')",
  );
  let cursors = initialStopRetirementCursors();
  const initial = structuredClone(cursors);
  const visited = [];
  const eligible = [];
  let noAction = 0;
  let completed = false;
  for (let page = 0; page < 20; page++) {
    const log = [];
    const preview = await previewStopRetirement(stopDb(db, log), { botId, cursors });
    assert.ok(preview.report.sampled <= 96);
    assert.ok(preview.candidates.length <= 96);
    assert.ok(preview.report.heads.every((head) => head.sampled <= 32));
    if (page === 0) {
      assert.equal(preview.report.sampled, 96);
      for (const status of ['SENT', 'PARTIAL', 'AMBIGUOUS', 'CANCELED'])
        assert.deepEqual(preview.nextCursors[status], initial[status]);
      assert.equal(preview.report.sourceComplete, false);
    }
    const reads = log.filter((row) =>
      /^SELECT id,publication_id,schedule_id,scheduled_at FROM public\.publication_occurrences/iu.test(
        row.text,
      ),
    );
    assert.equal(reads.length, preview.report.heads.length);
    for (const [index, head] of preview.report.heads.entries()) {
      assert.equal(reads[index].values[0], head.status);
      visited.push(...reads[index].rows.slice(0, head.sampled).map((row) => row.id));
    }
    eligible.push(...preview.candidates.map((row) => row.source.id));
    noAction += preview.report.noAction;
    cursors = preview.nextCursors;
    if (preview.report.sourceComplete) {
      completed = true;
      break;
    }
  }
  assert.equal(completed, true);
  assert.deepEqual(visited.sort(), expected.sort());
  assert.equal(new Set(visited).size, visited.length);
  assert.equal(eligible.length, 5 * 41);
  assert.equal(new Set(eligible).size, eligible.length);
  assert.equal(noAction, 2 * 41);
  assert.ok(Object.values(cursors).every((cursor) => cursor.done));
});

test('stop-only does not nominate settled SENT/CANCELED envelopes or terminal parents without envelopes', async (t) => {
  const db = await lite(t);
  for (const status of ['SENT', 'CANCELED']) {
    await seed(db, 'settled-' + status, status);
    await db.query(
      "UPDATE managed_broadcasts SET status=CASE WHEN entity_type='CHAT' THEN 'COMPLETED'::\"ManagedBroadcastStatus\" ELSE 'CANCELED'::\"ManagedBroadcastStatus\" END WHERE publication_occurrence_id=$1",
      ['settled-' + status],
    );
  }
  const before = await evidence(db);
  const preview = await previewStopRetirement(stopDb(db), { botId });
  assert.equal(preview.report.noAction, 2);
  assert.equal(preview.report.eligible, 0);
  assert.equal(preview.report.sourceComplete, true);
  assert.deepEqual(preview.candidates, []);
  assert.deepEqual(await applyStopRetirement(stopDb(db), preview, botId), {
    stopped: 0,
    canceled: 0,
    envelopes: 0,
    preservedOccurrences: 0,
    refused: {},
  });
  assert.deepEqual(await evidence(db), before);
});

const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'native PostgreSQL stop-only preserves evidence across ACKs, rolls back atomically, refuses races and bounds all read shapes',
  { skip: !nativeUrl, timeout: 90_000 },
  async (t) => {
    const address = new URL(nativeUrl);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname));
    assert.match(address.pathname, /^\/(?:race_test|maxim_race_test_[a-f0-9]+)$/u);
    const { default: pg } = await import('pg');
    const types = new pg.TypeOverrides();
    types.setTypeParser(1114, (value) => new Date(value.replace(' ', 'T') + 'Z'));
    const database = 'race_test_publik_stop_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Client({ connectionString: address.href });
    const child = new URL(address);
    child.pathname = '/' + database;
    const db = new pg.Client({
      connectionString: child.href,
      types,
      options:
        '-c timezone=Asia/Tokyo -c statement_timeout=5000 -c lock_timeout=150 -c max_parallel_workers_per_gather=0 -c enable_seqscan=off -c enable_bitmapscan=off -c plan_cache_mode=force_custom_plan',
    });
    const rival = new pg.Client({ connectionString: child.href, types });
    await admin.connect();
    await admin.query('CREATE DATABASE "' + database + '" TEMPLATE template0');
    t.after(async () => {
      await rival.end();
      await db.end();
      await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)');
      await admin.end();
    });
    await db.connect();
    await rival.connect();
    await db.query(fixture);
    await attestRetirementIndexes(db);
    const checkedPlans = new Map();
    const checkedReads = {
      query: async (query, values) => {
        const text = typeof query === 'string' ? query : query.text;
        const parameters = typeof query === 'string' ? values : query.values;
        assertStopSql(text);
        if (/^SELECT\b/iu.test(text) && /\bpublic\./u.test(text) && !checkedPlans.has(text))
          checkedPlans.set(text, await inspectRetirementReadPlan(db, text, parameters));
        return db.query(text, parameters);
      },
    };
    for (const status of RETIREMENT_STOP_STATUSES) await seed(db, 'native-' + status, status);
    await db.query(
      "UPDATE publications SET canonical_content_revision_id='new-parent-content' WHERE id='p-native-SCHEDULED'",
    );
    await db.query("UPDATE publication_schedules SET revision=7 WHERE id='s-native-SCHEDULED'");
    await db.query(
      "UPDATE managed_broadcasts SET target_chat_ids=jsonb_build_object('opaque',repeat('private-',20000)),apply_to_all_chats=true WHERE publication_occurrence_id='native-SCHEDULED'",
    );
    const preview = await previewStopRetirement(checkedReads, { botId });
    assert.equal(preview.report.eligible, 7);
    await rival.query(
      "UPDATE managed_broadcast_deliveries SET status='SENT',remote_message_id='private-native-late-ack',attempt_count=9,lock_token='private-replacement-claim',post_actions_token='private-replacement-action',updated_at='2026-10-20T00:02:00' WHERE id='delivery-b-native-AMBIGUOUS-CHAT-0'",
    );
    const before = await evidence(db);
    const applied = await applyStopRetirement(stopDb(db), preview, botId);
    assert.deepEqual(applied, {
      stopped: 7,
      canceled: 5,
      envelopes: 14,
      preservedOccurrences: 2,
      refused: {},
    });
    assertOnlyStopChanges(
      before,
      await evidence(db),
      incompleteStatuses.map((status) => 'native-' + status),
      RETIREMENT_STOP_STATUSES.flatMap((status) => envelopeIds('native-' + status)),
    );

    const refusalUpdates = [
      [
        'cycle',
        "UPDATE managed_broadcasts SET cycle_enabled=true WHERE publication_occurrence_id='refuse-cycle'",
      ],
      [
        'multi-slot',
        "INSERT INTO managed_broadcast_occurrences(id,broadcast_id,occurrence_index) VALUES ('extra-slot','b-refuse-multi-slot-CHAT',2)",
      ],
      [
        'slot-time',
        "UPDATE managed_broadcast_occurrences SET scheduled_at='2026-10-20T05:00:00' WHERE broadcast_id='b-refuse-slot-time-CHAT'",
      ],
      [
        'retry',
        "UPDATE publication_occurrences SET retry_authorized_at='2026-10-19T23:00:00.001' WHERE id='refuse-retry'",
      ],
      [
        'new-plan',
        "UPDATE publication_schedules SET created_at='2026-10-19T23:00:00.001' WHERE id='s-refuse-new-plan'",
      ],
      ['now', "UPDATE publication_schedules SET mode='NOW' WHERE id='s-refuse-now'"],
      ['dynamic', "UPDATE publications SET audience_mode='DYNAMIC' WHERE id='p-refuse-dynamic'"],
      [
        'legacy',
        "UPDATE publication_occurrences SET legacy_broadcast_id='foreign-pointer' WHERE id='refuse-legacy'",
      ],
    ];
    for (const [name, mutation] of refusalUpdates) {
      await seed(db, 'refuse-' + name);
      await db.query(mutation);
      const snapshot = await readStopRetirementSnapshot(checkedReads, source('refuse-' + name));
      assert.equal(classifyStopRetirementSnapshot(snapshot, botId).safe, false, name);
    }
    const refusedBefore = await evidence(db);
    const refusals = await previewStopRetirement(checkedReads, { botId });
    assert.equal(refusals.report.eligible, 0);
    assert.equal(
      Object.values(refusals.report.refusals).reduce((sum, count) => sum + count, 0),
      refusalUpdates.length,
    );
    assert.equal((await applyStopRetirement(stopDb(db), refusals, botId)).stopped, 0);
    assert.deepEqual(await evidence(db), refusedBefore);

    await seed(db, 'rollback');
    const rollbackPlan = await planFor(stopDb(db), 'rollback');
    const rollbackBefore = await evidence(db);
    await db.query(
      "CREATE FUNCTION refuse_stop_second_envelope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='b-rollback-CHANNEL' AND NEW.status='CANCELED' THEN RAISE EXCEPTION 'test stop refusal'; END IF; RETURN NEW; END $$",
    );
    await db.query(
      'CREATE TRIGGER refuse_stop_second BEFORE UPDATE ON managed_broadcasts FOR EACH ROW EXECUTE FUNCTION refuse_stop_second_envelope()',
    );
    await assert.rejects(
      applyStopRetirement(stopDb(db), rollbackPlan, botId),
      /test stop refusal/u,
    );
    assert.deepEqual(await evidence(db), rollbackBefore);
    await db.query('DROP TRIGGER refuse_stop_second ON managed_broadcasts');

    await seed(db, 'locked');
    const lockedPlan = await planFor(stopDb(db), 'locked');
    const lockedBefore = await evidence(db);
    for (const lock of [
      "SELECT id FROM publications WHERE id='p-locked' FOR UPDATE",
      "SELECT id FROM managed_broadcasts WHERE id='b-locked-CHANNEL' FOR UPDATE",
      "SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))",
    ]) {
      await rival.query('BEGIN');
      try {
        await rival.query(lock);
        const result = await applyStopRetirement(stopDb(db), lockedPlan, botId);
        assert.equal(result.stopped, 0);
        assert.equal(result.refused.writer_busy, 1);
      } finally {
        await rival.query('ROLLBACK');
      }
      assert.deepEqual(await evidence(db), lockedBefore);
    }

    await seed(db, 'parent-race');
    const racePlan = await planFor(stopDb(db), 'parent-race');
    await rival.query(
      "UPDATE publications SET version=version+1,updated_at='2026-10-20T00:03:00' WHERE id='p-parent-race'",
    );
    const raceBefore = await evidence(db);
    const raced = await applyStopRetirement(stopDb(db), racePlan, botId);
    assert.equal(raced.stopped, 0);
    assert.equal(raced.refused.snapshot_changed, 1);
    assert.deepEqual(await evidence(db), raceBefore);

    await seed(db, 'cas-race');
    const casPlan = await planFor(stopDb(db), 'cas-race');
    const casBefore = await evidence(db);
    await db.query(
      "CREATE FUNCTION refuse_stop_occurrence_cas() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='cas-race' AND NEW.status='CANCELED' THEN RETURN NULL; END IF; RETURN NEW; END $$",
    );
    await db.query(
      'CREATE TRIGGER refuse_stop_cas BEFORE UPDATE ON publication_occurrences FOR EACH ROW EXECUTE FUNCTION refuse_stop_occurrence_cas()',
    );
    await assert.rejects(
      applyStopRetirement(stopDb(db), casPlan, botId),
      /stop_occurrence_cas_failed/u,
    );
    assert.deepEqual(await evidence(db), casBefore);
    await db.query('DROP TRIGGER refuse_stop_cas ON publication_occurrences');

    await db.query(
      "INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,dispatch_blocker_code) SELECT 'stop-skew-'||n,'p-native-SENT','s-native-SENT','SENT',CASE WHEN n<=10000 THEN NULL ELSE 'bot_not_admin' END FROM generate_series(1,20000) n",
    );
    await db.query('ANALYZE');
    const boundedHeads = [];
    for (const cursor of [
      { blocker: null, after: null },
      { blocker: 'bot_not_admin', after: null },
      {
        blocker: 'bot_not_admin',
        after: { scheduledAt: '2026-10-19T22:00:00.000Z', id: 'stop-skew-10050' },
      },
    ]) {
      const query = buildStopRetirementSourceQuery('SENT', cursor);
      const bounded = await inspectRetirementReadPlan(db, query);
      assert.ok(bounded.estimatedRows <= 33);
      const plan = (
        await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.text, query.values)
      ).rows[0]['QUERY PLAN'][0].Plan;
      assert.equal(plan['Node Type'], 'Limit');
      const scan = plan.Plans[0];
      assert.ok(['Index Scan', 'Index Only Scan'].includes(scan['Node Type']));
      assert.equal(scan['Index Name'], 'publication_occurrences_ready_dispatch_idx');
      assert.equal(scan.Filter, undefined);
      assert.ok(scan['Actual Rows'] <= 33);
      assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
      for (const name of ['dispatch_profile', 'status', 'dispatch_blocker_code', 'scheduled_at'])
        assert.ok(scan['Index Cond'].includes(name));
      boundedHeads.push({ rows: scan['Actual Rows'], index: scan['Index Name'] });
    }
    for (const previous of [null, 'a']) {
      const query = buildRetirementBlockerQuery('SENT', previous);
      assert.ok((await inspectRetirementReadPlan(db, query)).estimatedRows <= 1);
    }
    const required = new Set([
      'publications_pkey',
      'publication_schedules_pkey',
      'publication_occurrences_pkey',
      'managed_broadcasts_pub_occurrence_entity_key',
      'managed_broadcast_occurrences_broadcast_occurrence_key',
      'publication_occurrences_ready_dispatch_idx',
    ]);
    const observed = new Set([...checkedPlans.values()].flatMap((plan) => plan.indexes));
    assert.deepEqual(observed, required);
    t.diagnostic(
      JSON.stringify({
        incompleteCanceled: 5,
        terminalParentsPreserved: 2,
        lateAckPreserved: true,
        allChildEvidencePreserved: true,
        secondEnvelopeRollback: true,
        rowAndCalendarLockRefusals: true,
        parentEditAndCasRefusals: true,
        checkedReadShapes: checkedPlans.size,
        boundedHeads,
      }),
    );
  },
);
