import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  buildChatMessageWindowAuditSql,
  buildChatMessageWindowIndexSql,
  parseChatMessageWindowAuditArgs,
  validateChatMessageWindow,
} from './chat-message-window-audit.mjs';
import {
  SOURCE_ENVELOPE_MAX_BYTES,
  SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES,
  SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES,
  SOURCE_ENVELOPE_COMPRESSION_POLICY,
  SOURCE_ENVELOPE_COMPRESSION_ASSUMPTION,
} from './webhook-source-envelope-audit.mjs';

const minute = '2026-10-13T19:33:00Z';
const fixture = `CREATE TYPE "WebhookStatus" AS ENUM
  ('RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED','QUARANTINED');
CREATE TABLE webhook_events (
 id text PRIMARY KEY, status "WebhookStatus" NOT NULL, created_at timestamp(3) NOT NULL,
 processed_at timestamp(3), queued_at timestamp(3), normalized_payload jsonb, raw_payload jsonb, error_message text
);
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status, created_at, id);
CREATE TABLE moderation_delete_intents (
 id text PRIMARY KEY DEFAULT 'intent',
 chat_id text NOT NULL, message_id text NOT NULL, status text NOT NULL, attempt_count integer DEFAULT 0,
 last_error_code text, last_error text, last_status_code integer, delete_dispatch_started_at timestamp, remote_delete_succeeded_at timestamp,
 completed_at timestamp, retry_until_at timestamp, last_attempt_at timestamp, next_attempt_at timestamp
);
CREATE UNIQUE INDEX moderation_delete_intents_chat_message_key ON moderation_delete_intents(chat_id, message_id);
CREATE TABLE moderation_delete_intent_reasons (intent_id text, reason_key text, rule_code text);
CREATE UNIQUE INDEX moderation_delete_intent_reasons_intent_reason_key ON moderation_delete_intent_reasons(intent_id, reason_key);`;
const hash = (s) => createHash('md5').update(s).digest('hex');

test('index admission fails through SQL errors instead of ignored psql quit arguments', () => {
  const sql = buildChatMessageWindowIndexSql();
  assert.doesNotMatch(sql, /\\quit/u);
  for (const marker of ['INTENT', 'REASON']) {
    assert.match(
      sql,
      new RegExp(`MAXIM_MESSAGE_WINDOW_${marker}_INDEX_UNAVAILABLE\\nSELECT 1 / 0;`, 'u'),
    );
  }
});

test('hash admission preserves the uncompressed cap and pins compressed budgets to PG16', () => {
  const sql = buildChatMessageWindowAuditSql('-123', minute);
  for (const column of ['normalized_payload', 'raw_payload']) {
    const boundedCase = `WHEN pg_column_compression(${column}) IS NULL
    THEN pg_column_size(${column}) <= 65536
  WHEN current_setting('server_version_num')::integer / 10000 <> 16 THEN false
  WHEN pg_column_compression(${column}) = 'pglz'
    THEN pg_column_size(${column}) <= ${SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES}
  WHEN pg_column_compression(${column}) = 'lz4'
    THEN pg_column_size(${column}) <= ${SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES}
  ELSE false END THEN
    CASE WHEN jsonb_typeof(${column}) = 'object'`;
    assert.ok(sql.includes(boundedCase), column);
  }
});

test('requires an exact valid UTC minute and rejects SQL, paths and overflowing dates', () => {
  validateChatMessageWindow('-123', minute);
  for (const chat of ['1', '-0', "-1'; SELECT 1", '/tmp/query.sql', '-123\n']) {
    assert.throws(() => validateChatMessageWindow(chat, minute));
  }
  for (const time of [
    '2026-02-30T00:00:00Z',
    '2026-10-13T19:33:01Z',
    '2026-10-13T22:33:00+03:00',
    'SELECT 1',
  ]) {
    assert.throws(() => validateChatMessageWindow('-123', time));
  }
});

test('keeps minute arguments compatible and accepts only fixed slice integers', () => {
  assert.deepEqual(parseChatMessageWindowAuditArgs(['-123', minute]), {
    chatId: '-123',
    from: minute,
    explain: false,
    slice: null,
  });
  assert.equal(parseChatMessageWindowAuditArgs(['-123', minute, '--explain']).explain, true);
  for (const slice of [0, 11]) {
    validateChatMessageWindow('-123', minute, slice);
    for (const options of [
      ['--slice', String(slice), '--explain'],
      ['--explain', '--slice', String(slice)],
    ]) {
      assert.deepEqual(parseChatMessageWindowAuditArgs(['-123', minute, ...options]), {
        chatId: '-123',
        from: minute,
        explain: true,
        slice,
      });
    }
  }
  for (const slice of [-1, 12, 0.5, NaN, Infinity, '0', "0'; SELECT 1"]) {
    assert.throws(() => buildChatMessageWindowAuditSql('-123', minute, false, slice));
  }
  for (const options of [
    ['--slice'],
    ['--slice', '-1'],
    ['--slice', '12'],
    ['--slice', '01'],
    ['--slice', '1.0'],
    ['--slice', '1\n'],
    ['--slice', "0'; SELECT 1"],
    ['--slice', '0', '--slice', '1'],
    ['--explain', '--explain'],
    ['--unknown'],
  ]) {
    assert.throws(() => parseChatMessageWindowAuditArgs(['-123', minute, ...options]));
  }
});

test('slices keep exact half-open five-second bounds and independent head sentinels', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events (id,status,created_at,normalized_payload)
    SELECT 'head-'||lpad(n::text,4,'0'),'PROCESSED','2026-10-13 19:33:00',
      '{"message":{"chatId":"-123"}}'::jsonb FROM generate_series(1,513) n;
    INSERT INTO webhook_events (id,status,created_at,normalized_payload) VALUES
      ('five','PROCESSED','2026-10-13 19:33:05','{"message":{"chatId":"-123"}}'),
      ('fifty-four','PROCESSED','2026-10-13 19:33:54.999','{"message":{"chatId":"-123"}}'),
      ('fifty-five','PROCESSED','2026-10-13 19:33:55','{"message":{"chatId":"-123"}}'),
      ('last','PROCESSED','2026-10-13 19:33:59.999','{"message":{"chatId":"-123"}}'),
      ('end','PROCESSED','2026-10-13 19:34:00','{"message":{"chatId":"-123"}}');`);
  const report = async (slice) =>
    (await db.query(buildChatMessageWindowAuditSql('-123', minute, false, slice))).rows[0]
      .json_build_object;
  const full = await report(null);
  assert.equal(full.window_seconds, 60);
  assert.equal(full.slice, null);
  assert.equal(full.sample_truncated, true);
  const first = await report(0);
  assert.equal(first.window_seconds, 5);
  assert.equal(first.slice, 0);
  assert.equal(first.from_at, '2026-10-13T19:33:00');
  assert.equal(first.until_at, '2026-10-13T19:33:05');
  assert.equal(first.matched_receipts, 512);
  assert.equal(first.sample_truncated, true);
  const last = await report(11);
  assert.equal(last.from_at, '2026-10-13T19:33:55');
  assert.equal(last.until_at, '2026-10-13T19:34:00');
  assert.equal(last.matched_receipts, 2);
  assert.equal(last.sample_truncated, false);
  assert.deepEqual(
    last.rows.map((row) => row.message_hash),
    [null, null],
  );
});

test('isolates the chat and minute, preserves receipt outcomes and omits private content', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  async function add(id, chat, time, status, error, types) {
    await db.query(
      `INSERT INTO webhook_events
      (id, status, created_at, normalized_payload, raw_payload, error_message)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [
        id,
        status,
        time,
        JSON.stringify({
          type: 'message_created',
          message: { chatId: chat, messageId: id, senderId: 'private-user' },
        }),
        JSON.stringify({
          message: {
            body: {
              text: 'private-content',
              attachments: types.map((type) => ({ type, payload: { url: 'private-url' } })),
            },
          },
        }),
        error,
      ],
    );
  }
  await add('private-voice', '-123', '2026-10-13T19:33:10Z', 'PROCESSED', null, ['audio']);
  await add(
    'private-dormant',
    '-123',
    '2026-10-13T19:33:11Z',
    'PROCESSED',
    'DORMANT_BOT_OBSERVATION_V1',
    ['voice'],
  );
  await add('private-held', '-123', '2026-10-13T19:33:12Z', 'QUARANTINED', 'private-error', [
    'private-type',
  ]);
  await add('private-neighbor', '-456', '2026-10-13T19:33:13Z', 'FAILED', null, ['audio']);
  await add('private-end', '-123', '2026-10-13T19:34:00Z', 'FAILED', null, []);
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  assert.equal(report.matched_receipts, 3);
  assert.equal(report.sampled_receipts, 4);
  assert.equal(report.sample_truncated, false);
  assert.equal(report.remote_effect_proven, false);
  assert.equal(report.policy_checked, false);
  assert.deepEqual(
    report.rows.map((x) => x.status),
    ['PROCESSED', 'PROCESSED', 'QUARANTINED'],
  );
  assert.equal(report.rows[0].message_hash, hash('private-voice'));
  assert.equal(report.rows[0].source_basis, 'sampled_raw');
  assert.equal(report.rows[0].source_body_text_md5, hash('private-content'));
  assert.deepEqual(report.rows[0].raw_attachment_types, ['audio']);
  assert.equal(report.rows[1].diagnostic_family, 'dormant_observation');
  assert.equal(report.rows[2].diagnostic_family, 'other');
  assert.deepEqual(report.rows[2].raw_attachment_types, ['other']);
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-|raw_payload|normalized_payload|senderId|chatId/u,
  );
});

test('reads the source moderation consumed when independent raw sampling omitted the body', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.query(
    `INSERT INTO webhook_events
    (id,status,created_at,normalized_payload,raw_payload) VALUES
    ('voice','PROCESSED','2026-10-13 19:33:20',$1::jsonb,'{}')`,
    [
      JSON.stringify({
        type: 'message_created',
        message: { chatId: '-123', messageId: 'private-voice' },
        raw: {
          message: { body: { attachments: [{ type: 'audio', payload: { url: 'private-url' } }] } },
        },
      }),
    ],
  );
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  assert.equal(report.rows[0].source_basis, 'normalized_raw');
  assert.deepEqual(report.rows[0].raw_attachment_types, ['audio']);
  assert.doesNotMatch(JSON.stringify(report), /private-/u);
});

test('keeps an admitted delete distinct from dispatch and remote success', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events (id,status,created_at,normalized_payload)
    VALUES ('source','PROCESSED','2026-10-13 19:33:20','{"message":{"chatId":"-123","messageId":"private-voice"}}');
    INSERT INTO moderation_delete_intents (chat_id,message_id,status,attempt_count,last_status_code)
    VALUES ('-123','private-voice','WAITING_CAPABILITY',2,200);
    INSERT INTO moderation_delete_intent_reasons VALUES ('intent','private-reason','VOICE_BLOCKED_DELETE');`);
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  assert.equal(report.rows[0].delete_intent.status, 'WAITING_CAPABILITY');
  assert.equal(report.rows[0].delete_intent.dispatch_started_at, null);
  assert.equal(report.rows[0].delete_intent.remote_succeeded_at, null);
  assert.deepEqual(report.rows[0].delete_intent.reason_sample, {
    voice_blocked: true,
    link_blocked: false,
    mute_active: false,
    night_mode: false,
    manual_close: false,
    truncated: false,
  });
  assert.equal(report.remote_effect_proven, false);
  assert.doesNotMatch(JSON.stringify(report), /private-voice/u);
});

test('classifies only the persisted exact-source guard failure and never exposes raw errors', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events (id,status,created_at,normalized_payload)
    VALUES ('source','PROCESSED','2026-10-13 19:33:20','{"message":{"chatId":"-123","messageId":"private-voice"}}');
    INSERT INTO moderation_delete_intents (chat_id,message_id,status)
    VALUES ('-123','private-voice','RETRYABLE');`);
  const sourceError = 'MAX direct message lookup returned a response without the requested id';
  for (const [code, error, expected] of [
    ['delete_pre_dispatch_guard_rejected', sourceError, 'predispatch_exact_source_missing_id'],
    ['delete_pre_dispatch_guard_rejected', `${sourceError} private-secret`, 'predispatch_other'],
    ['private-code', sourceError, 'other'],
    [
      'delete_pre_dispatch_guard_rejected',
      'Message limits author access unavailable',
      'predispatch_author_access_unavailable',
    ],
    ['route_lookup_failed', 'private-secret', 'route_lookup_failed'],
    [
      'message_limits_delete_no_longer_authorized',
      'private-secret',
      'message_limits_no_longer_authorized',
    ],
    ...[
      'max_action_executor_proof_rejected',
      'unverified_message_not_found',
      'delete_candidates_exhausted',
      'no_delete_capable_bot',
      'predelete_presence_unknown',
      'moderation_state_delete_no_longer_authorized',
      'closed_chat_delete_no_longer_authorized',
      'snapshot_missing',
      'not_admin_or_owner',
      'entity_type_unknown',
      'missing_chat_delete_permission',
      'missing_channel_delete_permission',
      'chat_not_found',
      'no_active_membership',
      'snapshot_stale',
      'access_state_unconfirmed',
      'access_denied',
      'bot_not_actionable',
    ].map((code) => [code, 'private-secret', code]),
    [null, null, 'none'],
    [null, 'private-secret', 'other'],
  ]) {
    await db.query('UPDATE moderation_delete_intents SET last_error_code=$1,last_error=$2', [
      code,
      error,
    ]);
    const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
      .json_build_object;
    assert.equal(report.rows[0].delete_intent.last_failure_family, expected);
    assert.equal(report.rows[0].delete_intent.dispatch_started_at, null);
    assert.equal(report.remote_effect_proven, false);
    assert.doesNotMatch(JSON.stringify(report), /private-|MAX direct|last_error/u);
  }
});

test('reports independent restriction reasons without exposing metadata', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events (id,status,created_at,normalized_payload)
    VALUES ('source','PROCESSED','2026-10-13 19:33:20','{"message":{"chatId":"-123","messageId":"private-voice"}}');
    INSERT INTO moderation_delete_intents (chat_id,message_id,status)
    VALUES ('-123','private-voice','RETRYABLE');
    INSERT INTO moderation_delete_intent_reasons VALUES
      ('intent','private-mute','MUTE_ACTIVE_DELETE'),
      ('intent','private-night','NIGHT_MODE_DELETE'),
      ('intent','private-manual','MANUAL_GROUP_CLOSE_DELETE');`);
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  assert.equal(report.schema_version, 5);
  assert.equal(report.source_hash_bound_policy, SOURCE_ENVELOPE_COMPRESSION_POLICY);
  assert.equal(report.source_hash_bound_assumption, SOURCE_ENVELOPE_COMPRESSION_ASSUMPTION);
  assert.equal(report.source_hash_uncompressed_max_bytes, 65536);
  assert.equal(report.source_hash_compressed_max_decoded_bytes, SOURCE_ENVELOPE_MAX_BYTES);
  assert.deepEqual(report.source_hash_compressed_physical_caps, {
    pglz: SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES,
    lz4: SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES,
  });
  assert.deepEqual(report.rows[0].delete_intent.reason_sample, {
    voice_blocked: false,
    link_blocked: false,
    mute_active: true,
    night_mode: true,
    manual_close: true,
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(report), /private-|metadata/u);
});

test('hashes bounded source text and sender labels without exposing them or embedded URLs', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const text = 'Закрытый текст https://max.ru/join/private-invite';
  const label = 'Закрытый автор';
  await db.query(
    `INSERT INTO webhook_events (id,status,created_at,normalized_payload,raw_payload)
    VALUES ('source','PROCESSED','2026-10-13 19:33:20',$1::jsonb,$2::jsonb)`,
    [
      JSON.stringify({
        type: 'message_created',
        message: { chatId: '-123', messageId: 'private-message' },
        raw: { message: { body: { text }, sender: { name: label } } },
      }),
      JSON.stringify({
        message: { body: { text: 'wrong sampled source' }, sender: { name: 'wrong author' } },
      }),
    ],
  );
  await db.exec(`INSERT INTO moderation_delete_intents (chat_id,message_id,status)
    VALUES ('-123','private-message','PENDING');
    INSERT INTO moderation_delete_intent_reasons VALUES ('intent','private-reason','LINK_BLOCKED_DELETE');`);
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  const row = report.rows[0];
  assert.equal(row.source_basis, 'normalized_raw');
  assert.equal(row.source_hash_admission, 'bounded_object');
  assert.equal(row.source_hash_storage, 'uncompressed');
  assert.equal(row.source_body_text_hash_admission, 'bounded_string');
  assert.equal(row.source_body_text_md5, hash(text));
  assert.equal(row.source_sender_label_hash_admission, 'bounded_string');
  assert.equal(row.source_sender_label_md5, hash(label));
  assert.equal(row.plain_max_join_url, true);
  assert.equal(row.raw_message_removed_exact, false);
  assert.equal(row.delete_intent.reason_sample.link_blocked, true);
  assert.doesNotMatch(JSON.stringify(report), /Закрытый|https:|max\.ru|private-|wrong/u);
});

test('rejects oversized hash inputs and leaves missing sources explicitly unknown', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec('ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET STORAGE EXTERNAL');
  const read = async (raw) => {
    await db.query(
      `INSERT INTO webhook_events (id,status,created_at,normalized_payload)
      VALUES ('source','PROCESSED','2026-10-13 19:33:20',$1::jsonb)
      ON CONFLICT(id) DO UPDATE SET normalized_payload=EXCLUDED.normalized_payload`,
      [
        JSON.stringify({
          type: 'message_created',
          message: { chatId: '-123' },
          ...(raw === undefined ? {} : { raw }),
        }),
      ],
    );
    return (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
      .json_build_object.rows[0];
  };
  const limits = await read({
    message: { body: { text: 'я'.repeat(4097) }, sender: { name: 'я'.repeat(129) } },
  });
  assert.equal(limits.source_hash_admission, 'bounded_object');
  assert.equal(limits.source_body_text_hash_admission, 'oversized_not_inspected');
  assert.equal(limits.source_sender_label_hash_admission, 'oversized_not_inspected');
  assert.equal(limits.source_body_text_md5, null);
  assert.equal(limits.source_sender_label_md5, null);
  assert.equal(limits.plain_max_join_url, null);
  const oversized = await read({
    message: { body: { text: 'private-small' }, sender: { name: 'private-small' } },
    padding: 'x'.repeat(65536),
  });
  assert.equal(oversized.source_hash_admission, 'oversized_not_inspected');
  assert.equal(oversized.source_body_text_md5, null);
  assert.equal(oversized.source_sender_label_md5, null);
  assert.equal(oversized.raw_message_removed_exact, null);
  const missing = await read(undefined);
  assert.equal(missing.source_hash_admission, 'absent');
  assert.equal(missing.source_body_text_hash_admission, 'source_not_admitted');
  assert.equal(missing.source_body_text_md5, null);
  assert.equal(missing.plain_max_join_url, null);
  const split = await read({
    message: {
      body: { text: 'ordinary text' },
      sender: { first_name: 'Имя', last_name: 'Фамилия' },
    },
  });
  assert.equal(split.source_sender_label_md5, hash('Имя Фамилия'));
  assert.equal(split.plain_max_join_url, false);
});

test('recognizes only exact official group removal proof, independently of moderation deletion', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const baseline = {
    type: 'message_removed',
    botId: 'private-bot',
    message: { chatId: '-123', messageId: 'private-message', entityType: 'chat' },
    raw: { update_type: 'message_removed', chat_id: -123, message_id: 'private-message' },
  };
  for (const [name, change, expected] of [
    ['official', (value) => value, true],
    [
      'string chat',
      (value) => {
        value.raw.chat_id = '-123';
      },
      true,
    ],
    [
      'nullable post',
      (value) => {
        value.raw.post_id = null;
      },
      true,
    ],
    [
      'wrong chat',
      (value) => {
        value.raw.chat_id = -456;
      },
      false,
    ],
    [
      'wrong message',
      (value) => {
        value.raw.message_id = 'other-message';
      },
      false,
    ],
    [
      'numeric message',
      (value) => {
        value.raw.message_id = 123;
        value.message.messageId = '123';
      },
      false,
    ],
    [
      'wrong raw event',
      (value) => {
        value.raw.update_type = 'message_edited';
      },
      false,
    ],
    [
      'wrong normalized event',
      (value) => {
        value.type = 'message_created';
      },
      false,
    ],
    [
      'raw post',
      (value) => {
        value.raw.post_id = 'private-post';
      },
      false,
    ],
    [
      'normalized post',
      (value) => {
        value.message.postId = 'private-post';
      },
      false,
    ],
    [
      'channel',
      (value) => {
        value.message.entityType = 'channel';
      },
      false,
    ],
    [
      'no bot',
      (value) => {
        delete value.botId;
      },
      false,
    ],
  ]) {
    const value = structuredClone(baseline);
    change(value);
    await db.query(
      `INSERT INTO webhook_events (id,status,created_at,normalized_payload)
      VALUES ('source','PROCESSED','2026-10-13 19:33:20',$1::jsonb)
      ON CONFLICT(id) DO UPDATE SET normalized_payload=EXCLUDED.normalized_payload`,
      [JSON.stringify(value)],
    );
    const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
      .json_build_object;
    assert.equal(report.rows[0].raw_message_removed_exact, expected, name);
    assert.equal(report.rows[0].delete_intent, null);
    assert.equal(report.remote_effect_proven, false);
    assert.doesNotMatch(JSON.stringify(report), /private-|other-message/u);
  }
});

test('reports omitted receipts and bounds attachment projection even with malformed payloads', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events (id,status,created_at,normalized_payload,raw_payload)
    SELECT 'row-'||lpad(n::text,4,'0'),'PROCESSED','2026-10-13 19:33:10',
      '{"type":"message_created","message":{"chatId":"-123"}}'::jsonb,
      CASE WHEN n=1 THEN '{"message":{"body":{"attachments":{}}}}'::jsonb
      ELSE jsonb_build_object('message',jsonb_build_object('body',jsonb_build_object('attachments',
        (SELECT jsonb_agg(jsonb_build_object('type','audio')) FROM generate_series(1,40))))) END
    FROM generate_series(1,513) n;`);
  const report = (await db.query(buildChatMessageWindowAuditSql('-123', minute))).rows[0]
    .json_build_object;
  assert.equal(report.sampled_receipts, 512);
  assert.equal(report.sample_truncated, true);
  assert.deepEqual(report.rows[0].raw_attachment_types, []);
  assert.equal(report.rows[1].raw_attachment_types.length, 32);
  assert.equal(report.rows[1].attachments_truncated, true);
});

const native = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'native psql refuses missing or incompatible intent and reason indexes before the report',
  { skip: !native, timeout: 30_000 },
  () => {
    const address = new URL(native);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname));
    for (const [name, change, refusedMarker] of [
      ['valid', '', null],
      ['missing_intent', 'DROP INDEX moderation_delete_intents_chat_message_key;', 'INTENT'],
      [
        'missing_reason',
        'DROP INDEX moderation_delete_intent_reasons_intent_reason_key;',
        'REASON',
      ],
      [
        'nonunique_intent',
        `DROP INDEX moderation_delete_intents_chat_message_key;
        CREATE INDEX moderation_delete_intents_chat_message_key
          ON moderation_delete_intents(chat_id, message_id);`,
        'INTENT',
      ],
      [
        'reversed_reason',
        `DROP INDEX moderation_delete_intent_reasons_intent_reason_key;
        CREATE UNIQUE INDEX moderation_delete_intent_reasons_intent_reason_key
          ON moderation_delete_intent_reasons(reason_key, intent_id);`,
        'REASON',
      ],
    ]) {
      const schema = `message_window_admission_${process.pid}_${name}`;
      // FLAG: Every fixture exists only in the psql transaction. Refusal disconnects
      // and rolls it back; no public schema or shared index is ever changed.
      const admission = buildChatMessageWindowIndexSql().replaceAll('public.', `${schema}.`);
      const result = spawnSync(
        'psql',
        [
          '-X',
          '--no-password',
          '-qAt',
          '-v',
          'ON_ERROR_STOP=1',
          '-v',
          'VERBOSITY=terse',
          '-v',
          'SHOW_CONTEXT=never',
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            ...process.env,
            PGHOST: address.hostname,
            PGPORT: address.port || '5432',
            PGUSER: decodeURIComponent(address.username),
            PGPASSWORD: decodeURIComponent(address.password),
            PGDATABASE: decodeURIComponent(address.pathname.slice(1)),
            PGOPTIONS:
              '-c statement_timeout=2500ms -c lock_timeout=250ms -c idle_in_transaction_session_timeout=4s -c work_mem=1MB',
          },
          input: `BEGIN;
CREATE SCHEMA ${schema};
SET LOCAL search_path TO ${schema}, pg_catalog;
${fixture}
${change}
${admission}
${buildChatMessageWindowAuditSql('-123', minute, false, 11)}
SELECT 'report-index-admission-passed';
ROLLBACK;`,
        },
      );
      assert.equal(result.error, undefined, name);
      assert.equal(result.status, refusedMarker ? 3 : 0, `${name}: ${result.stderr}`);
      if (refusedMarker) {
        assert.match(
          result.stdout,
          new RegExp(`MAXIM_MESSAGE_WINDOW_${refusedMarker}_INDEX_UNAVAILABLE`, 'u'),
        );
        assert.match(result.stderr, /division by zero/u);
        assert.doesNotMatch(result.stdout, /chat_message_window|report-index-admission-passed/u);
      } else {
        assert.match(result.stdout, /chat_message_window/u);
        assert.match(result.stdout, /report-index-admission-passed/u);
      }
      assert.doesNotMatch(result.stdout, /PGPASSWORD|postgresql:\/\//u);
    }
  },
);

test(
  'native retained-history plan bounds index heads before JSON reads',
  { skip: !native },
  async (t) => {
    const url = new URL(native);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    const client = new pg.Client({ connectionString: native });
    await client.connect();
    t.after(async () => {
      try {
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    });
    await client.query('BEGIN');
    // FLAG: Disposable transaction-local schema isolates this fixture from other native suites.
    const schema = `message_window_${process.pid}`;
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}; ${fixture}`);
    await client.query(`INSERT INTO webhook_events (id,status,created_at,normalized_payload)
    SELECT 'history-'||n, 'PROCESSED', '2026-10-12 00:00:00'::timestamp + n*interval '1 ms',
      '{"message":{"chatId":"-123"}}'::jsonb FROM generate_series(1,20000) n;
    INSERT INTO webhook_events (id,status,created_at,normalized_payload)
    VALUES ('current','PROCESSED','2026-10-13 19:33:10','{"message":{"chatId":"-123"}}');
    ANALYZE webhook_events;`);
    const sql = buildChatMessageWindowAuditSql('-123', minute);
    const plan = (await client.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + sql)).rows[0][
      'QUERY PLAN'
    ][0].Plan;
    const nodes = [];
    const walk = (n) => {
      nodes.push(n);
      for (const child of n.Plans ?? []) walk(child);
    };
    walk(plan);
    assert.ok(nodes.some((n) => n['Index Name'] === 'webhook_events_status_created_at_id_idx'));
    assert.ok(
      nodes
        .filter((n) => n['Relation Name'] === 'webhook_events')
        .every(
          (n) =>
            n['Node Type'] !== 'Seq Scan' &&
            (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'] <= 4096,
        ),
    );
    assert.equal((await client.query(sql)).rows[0].json_build_object.matched_receipts, 1);

    // FLAG: Exercise real compressed original columns. Decoded-size measurement
    // below is fixture-only; the collector admits solely through reviewed codec caps.
    for (const [method, physicalCap] of [
      ['pglz', SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES],
      ['lz4', SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES],
    ]) {
      await t.test(
        `${method} bounded source hashes and oversized/older-major refusal`,
        async (subtest) => {
          await client.query('SAVEPOINT compression_method');
          try {
            await client.query(`ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET COMPRESSION ${method};
            ALTER TABLE webhook_events ALTER COLUMN raw_payload SET COMPRESSION ${method};`);
          } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT compression_method');
            if (method === 'lz4' && error.code === '0A000') {
              subtest.skip('Native PostgreSQL built without LZ4 support');
              return;
            }
            throw error;
          }
          await client.query(`DELETE FROM webhook_events WHERE id LIKE 'compressed-%'`);
          const text = 'private-link https://max.ru/join/private-invite';
          const label = 'private-author';
          for (const [index, length] of [131072, 400000].entries()) {
            const source = {
              message: { body: { text }, sender: { name: label } },
              padding: 'x'.repeat(length),
            };
            await client.query(
              `INSERT INTO webhook_events
            (id,status,created_at,normalized_payload,raw_payload) VALUES
            ($1,'PROCESSED',$2,$3::jsonb,'{}'),
            ($4,'PROCESSED',$5,$6::jsonb,$7::jsonb)`,
              [
                `compressed-normalized-${index}`,
                `2026-10-13 19:33:${55 + index * 2}`,
                JSON.stringify({
                  type: 'message_created',
                  message: { chatId: '-123' },
                  raw: source,
                }),
                `compressed-sampled-${index}`,
                `2026-10-13 19:33:${56 + index * 2}`,
                JSON.stringify({ type: 'message_created', message: { chatId: '-123' } }),
                JSON.stringify(source),
              ],
            );
          }
          const storage = (
            await client.query(`SELECT id,
          CASE WHEN id LIKE 'compressed-normalized-%' THEN pg_column_compression(normalized_payload)
            ELSE pg_column_compression(raw_payload) END AS compression,
          CASE WHEN id LIKE 'compressed-normalized-%' THEN pg_column_size(normalized_payload)
            ELSE pg_column_size(raw_payload) END AS physical_size,
          CASE WHEN id LIKE 'compressed-normalized-%' THEN pg_column_size(normalized_payload || '{}'::jsonb)
            ELSE pg_column_size(raw_payload || '{}'::jsonb) END AS decoded_size
          FROM webhook_events WHERE id LIKE 'compressed-%' ORDER BY created_at`)
          ).rows;
          assert.equal(storage.length, 4);
          for (const [index, row] of storage.entries()) {
            assert.equal(row.compression, method);
            assert.equal(row.physical_size <= physicalCap, index < 2);
            assert.equal(row.decoded_size <= SOURCE_ENVELOPE_MAX_BYTES, index < 2);
          }
          const compressedSql = buildChatMessageWindowAuditSql('-123', minute, false, 11);
          const compressedReport = (await client.query(compressedSql)).rows[0].json_build_object;
          assert.equal(compressedReport.matched_receipts, 4);
          for (const [index, row] of compressedReport.rows.entries()) {
            assert.equal(row.source_hash_storage, method);
            if (index < 2) {
              assert.equal(row.source_hash_admission, 'bounded_object');
              assert.equal(row.source_body_text_md5, hash(text));
              assert.equal(row.source_sender_label_md5, hash(label));
              assert.equal(row.plain_max_join_url, true);
            } else {
              assert.equal(row.source_hash_admission, 'compressed_not_inspected');
              assert.equal(row.source_body_text_hash_admission, 'source_not_admitted');
              assert.equal(row.source_body_text_md5, null);
              assert.equal(row.source_sender_label_md5, null);
              assert.equal(row.plain_max_join_url, null);
              assert.equal(row.raw_message_removed_exact, null);
            }
          }
          for (const major of [15, 17]) {
            const foreignMajorSql = compressedSql.replaceAll(
              "current_setting('server_version_num')",
              `'${major * 10000}'`,
            );
            const refused = (await client.query(foreignMajorSql)).rows[0].json_build_object;
            for (const row of refused.rows) {
              assert.equal(row.source_hash_admission, 'compressed_not_inspected');
              assert.equal(row.source_body_text_md5, null);
              assert.equal(row.source_sender_label_md5, null);
            }
          }
          assert.doesNotMatch(JSON.stringify(compressedReport), /private-|padding/u);
          await client.query('RELEASE SAVEPOINT compression_method');
        },
      );
    }
  },
);
