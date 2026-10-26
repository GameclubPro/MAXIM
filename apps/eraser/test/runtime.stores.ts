import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpServer } from '../src/http.js';
import type { Config } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { Store } from '../src/store.js';
import { CleanupRuntime, MAX_WAKEUPS } from '../src/runtime.js';
import { HttpLimiter } from '../src/limiter.js';
import { MaxClient, MaxError, type MaxTransport } from '../src/max.js';
import type { Candidate, Message, Protection } from '../src/types.js';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl)
  throw new Error(
    'Native Eraser tests require MAXIM_TEST_POSTGRES_URL and MAXIM_TEST_REDIS_URL; use scripts/agent/with-test-stores.mjs',
  );
const schema = `eraser_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `-c search_path=${schema} -c timezone=UTC`,
});
const store = new Store(pool, true);
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
const prefix = `eraser:test:${randomUUID()}`;
const source = () => Date.now() - 8 * 86_400_000;
function protection(extra: Partial<Protection> = {}): Protection {
  return {
    sourceRevision: 1,
    protectedMessageIds: [],
    protectedBotIds: [],
    holdMessageIds: [],
    completeThrough: new Date().toISOString(),
    ...extra,
  };
}
async function enable(id = '-1', hours: 24 | 48 | 168 = 24) {
  await store.bootstrap(id, hours, protection());
  return store.update(id, {
    enabled: true,
    hours,
    expectedRevision: 0,
    operationId: randomUUID(),
    actorUserId: '5',
  });
}
async function reserve(id = '-1') {
  await pool.query(
    "UPDATE eraser_policies SET next_run_at=CASE WHEN chat_id=$1 THEN CURRENT_TIMESTAMP ELSE CURRENT_TIMESTAMP+INTERVAL '1 hour' END",
    [id],
  );
  const rows = await store.reserve(1);
  assert.equal(rows[0]?.chatId, id);
  return rows[0]!;
}
async function candidate(
  id = 'message',
  chat = '-1',
  isBot = false,
  author = '5',
): Promise<Candidate> {
  await pool.query(
    "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane) VALUES($1,$2,$3,$4,$5,'history')",
    [chat, id, author, isBot, source()],
  );
  return (
    await pool.query<Candidate>(
      'SELECT * FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2',
      [chat, id],
    )
  ).rows[0]!;
}
function transport(overrides: Partial<MaxTransport> = {}): MaxTransport {
  return {
    rights: async () => {},
    actorRights: async () => {},
    pin: async () => null,
    page: async () => [],
    presence: async () => 'unknown',
    remove: async (_chat, _mid, before) => {
      await before();
    },
    ...overrides,
  };
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await redis.ping();
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE eraser_policies,eraser_protection_state,eraser_protected_messages,eraser_protected_bots,eraser_held_authors,eraser_global_held_authors,eraser_global_message_holds,eraser_candidates,eraser_operations,eraser_webhook_receipts CASCADE',
  );
});

describe('real PostgreSQL ownership, journals and restart', () => {
  test('migration is immutable/idempotent and all periods survive snapshots', async () => {
    await migrate(pool);
    for (const [i, hours] of ([24, 48, 168] as const).entries()) {
      await enable(String(-i - 1), hours);
      assert.equal((await store.snapshot(String(-i - 1))).hours, hours);
    }
  });
  test('concurrent revision saves have one winner and a lost reply is exactly idempotent', async () => {
    await store.bootstrap('-1', 48, protection());
    const op = {
      enabled: true,
      hours: 24 as const,
      expectedRevision: 0,
      operationId: randomUUID(),
      actorUserId: '5',
    };
    const result = await Promise.allSettled([
      store.update('-1', op),
      store.update('-1', { ...op, hours: 168, operationId: randomUUID() }),
    ]);
    assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
    const winner = result.find((x) => x.status === 'fulfilled');
    assert.ok(winner?.status === 'fulfilled');
    if (winner.value.lastOperationId === op.operationId) {
      assert.deepEqual(await store.update('-1', op), winner.value);
      assert.deepEqual(await store.operation('-1', op), winner.value);
    }
    assert.equal((await store.snapshot('-1')).revision, 1);
  });
  test('final dispatch refuses disabled policy, expired lease and a longer period', async () => {
    await enable();
    const visit = await reserve();
    const row = await candidate();
    await pool.query(
      "UPDATE eraser_policies SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE chat_id='-1'",
    );
    await assert.rejects(
      store.assertAndMarkDispatch(row, visit.leaseToken, Date.now(), Date.now()),
    );
    await pool.query(
      "UPDATE eraser_policies SET lease_until=CURRENT_TIMESTAMP+INTERVAL '1 minute',enabled=false WHERE chat_id='-1'",
    );
    await assert.rejects(
      store.assertAndMarkDispatch(row, visit.leaseToken, Date.now(), Date.now()),
    );
    await pool.query("UPDATE eraser_policies SET enabled=true,hours=168 WHERE chat_id='-1'");
    await pool.query("UPDATE eraser_candidates SET source_ms=$1 WHERE chat_id='-1'", [
      Date.now() - 48 * 3_600_000,
    ]);
    await assert.rejects(
      store.assertAndMarkDispatch(row, visit.leaseToken, Date.now(), Date.now()),
    );
  });
  test('expired pin and rights evidence never acquire a dispatch journal', async () => {
    await enable();
    const visit = await reserve();
    const row = await candidate();
    await assert.rejects(
      store.assertAndMarkDispatch(row, visit.leaseToken, Date.now() - 30_001, Date.now()),
    );
    await assert.rejects(
      store.assertAndMarkDispatch(row, visit.leaseToken, Date.now(), Date.now() - 5001),
    );
    assert.equal(
      (await pool.query("SELECT state FROM eraser_candidates WHERE message_id='message'")).rows[0]
        .state,
      'pending',
    );
  });
  test('late exact rules/holds win the final destructive guard', async () => {
    await enable();
    const visit = await reserve();
    const row = await candidate();
    await store.protect('-1', protection({ sourceRevision: 2, protectedMessageIds: ['message'] }));
    await assert.rejects(
      store.assertAndMarkDispatch(row, visit.leaseToken, Date.now(), Date.now()),
      { code: 'ERASER_PROTECTED' },
    );
    const held = await candidate('held-author', '-1', false, '77');
    await store.protect('-1', protection({ sourceRevision: 3, holdAuthorIds: ['77'] }));
    await assert.rejects(
      store.assertAndMarkDispatch(held, visit.leaseToken, Date.now(), Date.now()),
      { code: 'ERASER_PROTECTED' },
    );
  });
  test('once-global held authors are protected in every chat without per-chat copies', async () => {
    await enable('-1');
    await enable('-2');
    await store.globalHolds(['77']);
    for (const chat of ['-1', '-2']) {
      const wake = await reserve(chat);
      const row = await candidate(`held-${chat}`, chat, false, '77');
      await assert.rejects(
        store.assertAndMarkDispatch(row, wake.leaseToken, Date.now(), Date.now()),
        { code: 'ERASER_PROTECTED' },
      );
      await store.finishVisit(chat, wake.leaseToken, null, 3600000);
    }
    assert.equal(
      (await pool.query('SELECT COUNT(*)::int AS count FROM eraser_global_held_authors')).rows[0]
        .count,
      1,
    );
  });
  test('hold acknowledgement refuses prior final decisions and fences future exact dispatch', async () => {
    await enable();
    const visit = await reserve();
    const row = await candidate('before-hold');
    await store.assertAndMarkDispatch(row, visit.leaseToken, Date.now(), Date.now());
    await assert.rejects(store.globalHolds([], [{ chatId: '-1', messageId: 'before-hold' }]), {
      code: 'ERASER_HOLD_EFFECT_PENDING',
    });
    assert.equal(
      (await pool.query('SELECT COUNT(*)::int AS count FROM eraser_global_message_holds')).rows[0]
        .count,
      1,
      'negative authority survives refusal',
    );
    await store.settle(row, 'uncertain', 'reconciliation');
    await assert.rejects(store.globalHolds([], [{ chatId: '-1', messageId: 'before-hold' }]), {
      code: 'ERASER_HOLD_EFFECT_PENDING',
    });
    await store.settle(row, 'deleted', 'confirmed_absence');
    await store.globalHolds([], [{ chatId: '-1', messageId: 'before-hold' }]);
    const future = await candidate('future-hold');
    await store.globalHolds([], [{ chatId: '-1', messageId: 'future-hold' }]);
    await assert.rejects(
      store.assertAndMarkDispatch(future, visit.leaseToken, Date.now(), Date.now()),
      { code: 'ERASER_PROTECTED' },
    );
  });
  test('hold fence waits for an uncommitted shared final decision before acknowledging', async () => {
    await enable();
    await candidate('overlap');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('eraser:effect-holds:v1'))");
      await client.query(
        "UPDATE eraser_candidates SET state='dispatching' WHERE chat_id='-1' AND message_id='overlap'",
      );
      const overlapping = store.globalHolds(['5']);
      let completed = false;
      void overlapping.then(
        () => {
          completed = true;
        },
        () => {
          completed = true;
        },
      );
      await delay(30);
      assert.equal(completed, false);
      await client.query('COMMIT');
      await assert.rejects(overlapping, { code: 'ERASER_HOLD_EFFECT_PENDING' });
      assert.equal(
        (await pool.query('SELECT COUNT(*)::int AS count FROM eraser_global_held_authors')).rows[0]
          .count,
        1,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  test('known missing administrator rights latch while a generic403 stays retryable', async () => {
    await enable();
    await candidate();
    const unknown = new CleanupRuntime(
      store,
      transport({
        rights: async () => {
          throw new MaxError(403, 'unclassified', false);
        },
      }),
      { enabled: true, redisUrl },
    );
    await unknown.visit(await reserve());
    assert.notEqual((await store.policy('-1'))?.connection_status, 'no_access');
    const known = new CleanupRuntime(
      store,
      transport({
        rights: async () => {
          throw new MaxError(403, 'eraser_rights_missing', false);
        },
      }),
      { enabled: true, redisUrl },
    );
    await known.visit(await reserve());
    assert.equal((await store.snapshot('-1')).connectionStatus, 'no_access');
    assert.equal((await store.reserve(1)).length, 0);
    await store.connection('-1', 'connected');
    assert.equal((await store.policy('-1'))?.connection_status, 'no_access');
  });
  test('unknown delete receipt survives restart and settles only authenticated removal', async () => {
    await enable();
    await candidate();
    let deletes = 0;
    const max = transport({
      remove: async (_chat, _mid, before) => {
        await before();
        deletes++;
        throw new MaxError(0, 'transport_unknown', true);
      },
    });
    const runtime = new CleanupRuntime(store, max, { enabled: true, redisUrl });
    await runtime.visit(await reserve());
    assert.equal(
      (await pool.query("SELECT state FROM eraser_candidates WHERE message_id='message'")).rows[0]
        .state,
      'uncertain',
    );
    for (const presence of ['present', 'unknown'] as const) {
      await pool.query(
        "UPDATE eraser_candidates SET next_attempt_at=CURRENT_TIMESTAMP WHERE message_id='message'",
      );
      const restarted = new CleanupRuntime(
        new Store(pool, true),
        transport({
          presence: async () => presence,
          remove: async () => {
            deletes++;
          },
        }),
        { enabled: true, redisUrl },
      );
      await restarted.visit(await reserve());
      assert.equal(deletes, 1);
      assert.equal((await store.snapshot('-1')).deletedCount, 0);
    }
    await store.ingest(
      { update_type: 'message_removed', chat_id: -1, message_id: 'message' },
      'reconciled-removal',
    );
    assert.equal((await store.snapshot('-1')).deletedCount, 1);
    assert.equal(deletes, 1);
  });
  for (const [status, state] of [
    [0, 'uncertain'],
    [403, 'dispatching'],
    [404, 'uncertain'],
    [500, 'dispatching'],
    [503, 'uncertain'],
  ] as const) {
    test(`reconciliation read ${status} preserves its ${state} journal while an independent delete proceeds`, async () => {
      await enable();
      await candidate('uncertain');
      await candidate('ordinary');
      const dispatchId = randomUUID();
      await pool.query(
        "UPDATE eraser_candidates SET state=$1,dispatch_id=$2,attempt_count=1 WHERE message_id='uncertain'",
        [state, dispatchId],
      );
      const removed: string[] = [];
      const runtime = new CleanupRuntime(
        store,
        transport({
          presence: async () => {
            throw new MaxError(status, 'lookup.failed', false);
          },
          remove: async (_chat, id, before) => {
            await before();
            removed.push(id);
          },
        }),
        { enabled: true, redisUrl },
      );
      const started = Date.now();
      await runtime.visit(await reserve());
      const journal = (
        await pool.query<Candidate>("SELECT * FROM eraser_candidates WHERE message_id='uncertain'")
      ).rows[0]!;
      assert.equal(journal.state, 'uncertain');
      assert.equal(journal.dispatch_id, dispatchId);
      assert.equal(journal.attempt_count, 1);
      assert.equal(journal.outcome_code, 'reconciliation_unavailable');
      assert.ok(journal.next_attempt_at.getTime() >= started + 290_000);
      assert.ok(journal.next_attempt_at.getTime() <= Date.now() + 310_000);
      assert.deepEqual(removed, ['ordinary']);
      assert.equal((await store.snapshot('-1')).deletedCount, 1);
      assert.equal((await store.snapshot('-1')).status, 'delayed');
    });
  }
  for (const status of [401, 429] as const) {
    test(`reconciliation read ${status} stops the visit before independent deletes`, async () => {
      await enable();
      await candidate('uncertain');
      await candidate('ordinary');
      const dispatchId = randomUUID();
      await pool.query(
        "UPDATE eraser_candidates SET state='uncertain',dispatch_id=$1,attempt_count=1 WHERE message_id='uncertain'",
        [dispatchId],
      );
      let rightsChecks = 0;
      const removed: string[] = [];
      const runtime = new CleanupRuntime(
        store,
        transport({
          presence: async () => {
            throw new MaxError(status, 'lookup.failed', false, 10_000);
          },
          rights: async () => {
            rightsChecks++;
          },
          remove: async (_chat, id) => {
            removed.push(id);
          },
        }),
        { enabled: true, redisUrl },
      );
      const started = Date.now();
      await runtime.visit(await reserve());
      assert.deepEqual(removed, []);
      assert.equal(rightsChecks, 0);
      const journal = (
        await pool.query<Candidate>("SELECT * FROM eraser_candidates WHERE message_id='uncertain'")
      ).rows[0]!;
      assert.equal(journal.state, 'uncertain');
      assert.equal(journal.dispatch_id, dispatchId);
      assert.equal(journal.attempt_count, 1);
      assert.equal((await store.snapshot('-1')).deletedCount, 0);
      const policy = (await store.policy('-1'))!;
      assert.equal(policy.last_error, 'lookup.failed');
      assert.ok(policy.next_run_at.getTime() >= started + (status === 429 ? 9500 : 4500));
    });
  }
  for (const code of [null, 'not.found', 'message.not.found']) {
    test(`issued DELETE 404 ${code ?? 'without code'} stays uncertain through ambiguous readback`, async () => {
      await enable();
      await candidate();
      const deleted: string[] = [];
      const max = new MaxClient(
        {
          databaseUrl: databaseUrl!,
          redisUrl: redisUrl!,
          controlToken: 'a'.repeat(32),
          webhookSecret: 'b'.repeat(32),
          botToken: 'private',
          botId: '123',
          apiBaseUrl: 'https://platform-api2.max.ru',
          port: 3000,
          enabled: true,
          maxRps: 20,
          commitSha: 'native',
          webhookUrl: null,
        },
        new HttpLimiter(redis, 20, `${prefix}:delete-404-${code ?? 'bare'}`),
        async (input, init) => {
          const url = new URL(String(input));
          if (init?.method === 'GET' && url.pathname === '/chats/-1/members/me')
            return Response.json({
              user_id: 123,
              is_admin: true,
              permissions: ['read_all_messages', 'write'],
            });
          if (init?.method === 'GET' && url.pathname === '/chats/-1/pin') return Response.json({});
          if (init?.method === 'GET' && url.pathname === '/messages')
            return Response.json({ messages: [] });
          if (init?.method === 'GET' && url.pathname === '/messages/message')
            return Response.json({ code: 'not.found' }, { status: 404 });
          assert.equal(init?.method, 'DELETE');
          assert.equal(url.pathname, '/messages');
          const messageId = url.searchParams.get('message_id');
          assert.ok(messageId === 'message' || messageId === 'ordinary');
          deleted.push(messageId);
          if (messageId === 'ordinary') return Response.json({ success: true });
          return Response.json(code === null ? {} : { code }, { status: 404 });
        },
      );
      const runtime = new CleanupRuntime(store, max, { enabled: true, redisUrl });
      await runtime.visit(await reserve());
      const readJournal = async () =>
        (await pool.query<Candidate>("SELECT * FROM eraser_candidates WHERE message_id='message'"))
          .rows[0]!;
      const issued = await readJournal();
      assert.equal(issued.state, 'uncertain');
      assert.ok(issued.dispatch_id);
      assert.equal(issued.attempt_count, 1);
      assert.equal((await store.snapshot('-1')).deletedCount, 0);
      await candidate('ordinary');
      await pool.query(
        "UPDATE eraser_candidates SET next_attempt_at=CURRENT_TIMESTAMP WHERE message_id='message'",
      );
      const started = Date.now();
      await runtime.visit(await reserve());
      const reconciled = await readJournal();
      assert.equal(reconciled.state, 'uncertain');
      assert.equal(reconciled.dispatch_id, issued.dispatch_id);
      assert.equal(reconciled.attempt_count, 1);
      assert.ok(reconciled.next_attempt_at.getTime() >= started + 290_000);
      assert.deepEqual(deleted, ['message', 'ordinary']);
      assert.equal((await store.snapshot('-1')).deletedCount, 1);
    });
  }
  test('authenticated removal duplicate releases counts once', async () => {
    await enable();
    await candidate();
    const removal = { update_type: 'message_removed', chat_id: -1, message_id: 'message' };
    await store.ingest(removal, 'receipt');
    await store.ingest(removal, 'receipt');
    await store.ingest(removal, 'other-mirror');
    assert.equal((await store.snapshot('-1')).deletedCount, 1);
  });
});

describe('bounded history and same-chat progress', () => {
  test('all authors are eligible, exact exceptions excluded, sync gaps defer bots without blocking humans', async () => {
    await enable();
    await store.protect(
      '-1',
      protection({
        sourceRevision: 2,
        completeThrough: null,
        protectedMessageIds: ['rules', 'giveaway', 'results'],
        holdMessageIds: ['hold'],
      }),
    );
    const visit = await reserve();
    const policy = (await store.active('-1', visit.leaseToken))!;
    const ids = ['human', 'admin', 'bot', 'rules', 'giveaway', 'results', 'hold'];
    const messages = ids.map(
      (id, i): Message => ({
        id,
        chatId: '-1',
        authorId: String(5 + i),
        isBot: i >= 2,
        sourceMs: source() + i,
      }),
    );
    await store.savePage(policy, 'history', messages);
    const pending = (await store.nextCandidates('-1')).map((row) => row.message_id);
    assert.deepEqual(pending, ['human', 'admin']);
    assert.equal((await store.snapshot('-1')).historyStatus, 'blocked');
    await store.protect('-1', protection({ sourceRevision: 3 }));
    const next = (await store.policy('-1'))!;
    assert.equal(next.history_complete, false);
    assert.ok(Number(next.history_cursor) >= messages[2]!.sourceMs);
  });
  test('old unproven module posts keep a durable gap while other authors delete and watermark updates do not rescan it', async () => {
    await enable();
    const at = source();
    const floor = new Date(at + 1000).toISOString();
    await store.protect(
      '-1',
      protection({
        sourceRevision: 2,
        protectedBotIds: ['900'],
        protectedMessageIds: ['adopted-human-rules'],
        botHistoryCompleteFrom: floor,
      }),
    );
    const visit = await reserve();
    const policy = (await store.active('-1', visit.leaseToken))!;
    const page: Message[] = [
      { id: 'module-post', authorId: '900', isBot: true },
      { id: 'unknown-module-post', authorId: '900', isBot: null },
      { id: 'independent-bot', authorId: '901', isBot: true },
      { id: 'human-admin', authorId: '5', isBot: false },
      { id: 'adopted-human-rules', authorId: '5', isBot: false },
    ].map((message, i) => ({ ...message, chatId: '-1', sourceMs: at - i }));
    await store.savePage(policy, 'history', page);
    const removed: string[] = [];
    const runtime = new CleanupRuntime(
      store,
      transport({
        remove: async (_chat, mid, before) => {
          await before();
          removed.push(mid);
        },
      }),
      { enabled: true, redisUrl },
    );
    await runtime.visit(visit);
    assert.deepEqual(new Set(removed), new Set(['independent-bot', 'human-admin']));
    const parked = (await store.policy('-1'))!;
    assert.equal(parked.history_complete, true);
    assert.equal(parked.historical_deferred_from, String(at - 1));
    assert.equal((await new Store(pool, true).snapshot('-1')).historyStatus, 'blocked');
    await store.protect(
      '-1',
      protection({
        sourceRevision: 3,
        botHistoryCompleteFrom: floor,
      }),
    );
    assert.equal((await store.policy('-1'))!.history_complete, true);
    assert.equal((await store.policy('-1'))!.history_cursor, parked.history_cursor);
    await store.protect(
      '-1',
      protection({
        sourceRevision: 4,
        complete: false,
        botHistoryCompleteFrom: new Date(at - 1000).toISOString(),
      }),
    );
    assert.equal((await store.policy('-1'))!.history_complete, true);
    await store.protect(
      '-1',
      protection({
        sourceRevision: 4,
        botHistoryCompleteFrom: floor,
      }),
    );
    assert.equal((await store.policy('-1'))!.history_complete, true);
    await store.protect(
      '-1',
      protection({
        sourceRevision: 5,
        botHistoryCompleteFrom: new Date(at - 1000).toISOString(),
      }),
    );
    const reopened = (await store.policy('-1'))!;
    assert.equal(reopened.historical_deferred_from, null);
    assert.equal(reopened.history_complete, false);
    assert.ok(Number(reopened.history_cursor) >= at);
    await runtime.close();
  });
  test('late historical coverage changes win dispatch and park only unissued module candidates', async () => {
    await enable();
    const wake = await reserve();
    const disputed = await candidate('module-late', '-1', true, '900');
    const ordinary = await candidate('ordinary-bot', '-1', true, '901');
    const exact = await candidate('exact-protected', '-1', true, '900');
    await store.protect(
      '-1',
      protection({
        sourceRevision: 2,
        protectedBotIds: ['900'],
        protectedMessageIds: ['exact-protected'],
        botHistoryCompleteFrom: null,
      }),
    );
    await assert.rejects(
      store.assertAndMarkDispatch(disputed, wake.leaseToken, Date.now(), Date.now()),
      { code: 'ERASER_PROTECTION_PENDING' },
    );
    await store.deferProtection(disputed);
    assert.equal(
      (await pool.query("SELECT 1 FROM eraser_candidates WHERE message_id='module-late'")).rowCount,
      0,
    );
    assert.equal((await store.snapshot('-1')).historyStatus, 'blocked');
    await assert.rejects(
      store.assertAndMarkDispatch(exact, wake.leaseToken, Date.now(), Date.now()),
      { code: 'ERASER_PROTECTED' },
    );
    await store.assertAndMarkDispatch(ordinary, wake.leaseToken, Date.now(), Date.now());
    await store.deferProtection(ordinary);
    assert.equal(
      (await pool.query("SELECT state FROM eraser_candidates WHERE message_id='ordinary-bot'"))
        .rows[0].state,
      'dispatching',
      'issued effects retain their reconciliation journal',
    );
  });
  test('pinned, uncertain and protected rows do not prevent an independent ordinary delete', async () => {
    await enable();
    await candidate('pin');
    await candidate('ordinary');
    await candidate('uncertain');
    await pool.query(
      "UPDATE eraser_candidates SET state='uncertain',next_attempt_at=CURRENT_TIMESTAMP+INTERVAL '5 minutes' WHERE message_id='uncertain'",
    );
    const removed: string[] = [];
    const runtime = new CleanupRuntime(
      store,
      transport({
        pin: async () => 'pin',
        remove: async (_chat, id, before) => {
          await before();
          removed.push(id);
        },
      }),
      { enabled: true, redisUrl },
    );
    await runtime.visit(await reserve());
    await runtime.visit(await reserve());
    assert.deepEqual(removed, ['ordinary']);
  });
  test('an empty MAX pin envelope permits a guarded ordinary deletion with a durable receipt', async () => {
    await enable();
    await candidate('ordinary');
    let pinRead = false;
    const removed: string[] = [];
    const max = new MaxClient(
      {
        databaseUrl: databaseUrl!,
        redisUrl: redisUrl!,
        controlToken: 'a'.repeat(32),
        webhookSecret: 'b'.repeat(32),
        botToken: 'private',
        botId: '123',
        apiBaseUrl: 'https://platform-api2.max.ru',
        port: 3000,
        enabled: true,
        maxRps: 20,
        commitSha: 'native',
        webhookUrl: null,
      },
      new HttpLimiter(redis, 20, `${prefix}:empty-pin`),
      async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'GET' && url.pathname === '/chats/-1/members/me')
          return Response.json({
            user_id: 123,
            is_admin: true,
            permissions: ['read_all_messages', 'write'],
          });
        if (init?.method === 'GET' && url.pathname === '/chats/-1/pin') {
          pinRead = true;
          return Response.json({});
        }
        if (init?.method === 'GET' && url.pathname === '/messages')
          return Response.json({ messages: [] });
        assert.equal(init?.method, 'DELETE');
        assert.equal(url.pathname, '/messages');
        assert.equal(url.searchParams.get('message_id'), 'ordinary');
        assert.equal(pinRead, true);
        assert.equal(
          (
            await pool.query(
              "SELECT state FROM eraser_candidates WHERE chat_id='-1' AND message_id='ordinary'",
            )
          ).rows[0].state,
          'dispatching',
        );
        removed.push('ordinary');
        return Response.json({ success: true });
      },
    );
    const runtime = new CleanupRuntime(store, max, { enabled: true, redisUrl });
    try {
      await runtime.visit(await reserve());
      assert.deepEqual(removed, ['ordinary']);
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM eraser_candidates WHERE chat_id='-1' AND message_id='ordinary'",
          )
        ).rows[0].state,
        'deleted',
      );
      assert.equal((await store.snapshot('-1')).deletedCount, 1);
    } finally {
      await runtime.close();
    }
  });
  test('newly due live messages take priority over already buffered historical candidates', async () => {
    await enable();
    await candidate('historical');
    const liveAt = Date.now() - 24 * 3600000 - 1000;
    await pool.query(
      "UPDATE eraser_policies SET live_floor=$1,live_upper=NULL,live_cursor=NULL WHERE chat_id='-1'",
      [liveAt - 1000],
    );
    const removed: string[] = [];
    const max = transport({
      page: async () => [
        { id: 'live', chatId: '-1', authorId: '5', isBot: false, sourceMs: liveAt },
      ],
      remove: async (_chat, id, before) => {
        await before();
        removed.push(id);
      },
    });
    const runtime = new CleanupRuntime(store, max, { enabled: true, redisUrl });
    await runtime.visit(await reserve());
    assert.deepEqual(removed, ['live', 'historical']);
  });
  test('repeated full timestamp boundary is exposed as incomplete rather than skipping history', async () => {
    await enable();
    const visit = await reserve();
    const p = (await store.active('-1', visit.leaseToken))!;
    const at = source();
    const page = Array.from(
      { length: 100 },
      (_, i): Message => ({ id: `p${i}`, chatId: '-1', authorId: '5', isBot: false, sourceMs: at }),
    );
    await store.protect(
      '-1',
      protection({ sourceRevision: 2, protectedMessageIds: page.map((m) => m.id) }),
    );
    await store.savePage(p, 'history', page);
    const updated = (await store.policy('-1'))!;
    await store.savePage(updated, 'history', page);
    const state = await store.snapshot('-1');
    assert.equal(state.historyStatus, 'blocked');
    assert.equal((await store.policy('-1'))!.history_complete, false);
  });
  test('virtual 100m history across 10000 chats admits bounded pages and rotates fairly', async () => {
    const at = source();
    await pool.query(
      `INSERT INTO eraser_policies(chat_id,enabled,hours,activation_id,history_cursor,live_floor,next_run_at) SELECT (-id)::text,true,24,$1,$2,$3,CURRENT_TIMESTAMP FROM generate_series(1,10000) id`,
      [randomUUID(), at, Date.now()],
    );
    const visited = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const batch = await store.reserve(MAX_WAKEUPS);
      assert.equal(batch.length, MAX_WAKEUPS);
      for (const wake of batch) {
        assert.ok(!visited.has(wake.chatId));
        visited.add(wake.chatId);
        const p = (await store.active(wake.chatId, wake.leaseToken))!;
        // Each chat's generator represents 10000 messages; only the admitted page materializes.
        const page = Array.from(
          { length: 100 },
          (_, i): Message => ({
            id: `${wake.chatId}-${i}`,
            chatId: wake.chatId,
            authorId: '5',
            isBot: false,
            sourceMs: at - i,
          }),
        );
        await store.savePage(p, 'history', page);
        await store.finishVisit(wake.chatId, wake.leaseToken, null, 3600000);
      }
    }
    assert.equal(visited.size, 192);
    const count = Number(
      (await pool.query('SELECT COUNT(*)::int AS count FROM eraser_candidates')).rows[0].count,
    );
    assert.equal(count, 19200);
    assert.ok(count < 100_000_000 / 1000);
    while (visited.size < 10000) {
      const batch = await store.reserve(MAX_WAKEUPS);
      assert.ok(batch.length > 0 && batch.length <= MAX_WAKEUPS);
      for (const wake of batch) {
        assert.ok(!visited.has(wake.chatId));
        visited.add(wake.chatId);
      }
      await pool.query(
        "UPDATE eraser_policies SET lease_token=NULL,lease_until=NULL,next_run_at=CURRENT_TIMESTAMP+INTERVAL '1 hour' WHERE chat_id=ANY($1::text[])",
        [batch.map((wake) => wake.chatId)],
      );
    }
    assert.equal(visited.size, 10000);
    assert.equal((await store.reserve(MAX_WAKEUPS)).length, 0);
  });
});

test('real Redis distributed admission enforces total spacing, per-chat1s and shared cooldown', async () => {
  const one = new HttpLimiter(redis, 20, `${prefix}:http`),
    two = new HttpLimiter(redis, 20, `${prefix}:http`);
  const times: number[] = [];
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      (i % 2 ? one : two).acquire().then(() => times.push(Date.now())),
    ),
  );
  times.sort();
  assert.ok(times.at(-1)! - times[0]! >= 180);
  const start = Date.now();
  await one.acquire('-1');
  await two.acquire('-1');
  assert.ok(Date.now() - start >= 950);
  await one.cooldown(1000);
  const cool = Date.now();
  await two.acquire();
  assert.ok(Date.now() - cool >= 950);
});

test('real BullMQ replicas share 64 durable wakeup slots and close their owned connections', async () => {
  const at = source();
  await pool.query(
    `INSERT INTO eraser_policies(chat_id,enabled,hours,activation_id,history_cursor,live_floor) SELECT (-id)::text,true,24,$1,$2,$3 FROM generate_series(1,200) id`,
    [randomUUID(), at, Date.now()],
  );
  const queuePrefix = `${prefix}:queue`;
  const slow = transport({
    page: async () => {
      await delay(100);
      return [];
    },
  });
  const first = new CleanupRuntime(store, slow, { enabled: true, redisUrl }, queuePrefix),
    second = new CleanupRuntime(store, slow, { enabled: true, redisUrl }, queuePrefix);
  const queue = new Queue('cleanup', {
    connection: { url: redisUrl, maxRetriesPerRequest: 1 },
    prefix: queuePrefix,
  });
  try {
    await first.start();
    await second.start();
    await Promise.all([first.tick(), second.tick()]);
    const counts = await queue.getJobCounts('active', 'waiting', 'delayed', 'prioritized');
    assert.ok(Object.values(counts).reduce((a, b) => a + b, 0) <= 64);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const progressed = await pool.query(
        'SELECT COUNT(*)::int AS count FROM eraser_policies WHERE history_complete',
      );
      if (progressed.rows[0].count >= 8) break;
      await delay(20);
    }
    assert.ok(
      (
        await pool.query(
          'SELECT COUNT(*)::int AS count FROM eraser_policies WHERE history_complete',
        )
      ).rows[0].count >= 8,
      'all occupied pool clients must progress without a nested pool checkout',
    );
    assert.equal(await queue.getGlobalConcurrency(), 8);
    assert.ok(first.health().schedulerLastSuccessfulAt);
    assert.ok(second.health().schedulerLastSuccessfulAt);
  } finally {
    await first.close();
    await second.close();
    await queue.close();
  }
});

test('control HTTP is authenticated and an unavailable service never falsely acknowledges enabling', async () => {
  const settings: Config = {
    databaseUrl: databaseUrl!,
    redisUrl: redisUrl!,
    controlToken: 'a'.repeat(32),
    webhookSecret: 'b'.repeat(32),
    botToken: 'private',
    botId: '123',
    apiBaseUrl: 'https://platform-api2.max.ru',
    port: 3000,
    enabled: true,
    maxRps: 20,
    commitSha: 'native',
    webhookUrl: null,
  };
  let rightsChecks = 0;
  let accessFailure: MaxError | null = null;
  const max = transport({
    rights: async () => {
      rightsChecks++;
      if (accessFailure) throw accessFailure;
    },
  });
  const server = createHttpServer(
    store,
    max,
    {
      health: () => ({
        schedulerLastSuccessfulAt: new Date().toISOString(),
        schedulerHealthy: true,
      }),
    },
    settings,
    () => redis.ping(),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/internal/v1/chats/-1/policy`)).status, 403);
    const headers = {
      Authorization: `Bearer ${settings.controlToken}`,
      'Content-Type': 'application/json',
    };
    await fetch(`${base}/internal/v1/chats/-1/bootstrap`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ hours: 168, ...protection() }),
    });
    const request = {
      enabled: true,
      hours: 168,
      expectedRevision: 0,
      operationId: randomUUID(),
      actorUserId: '5',
    };
    const saved = await fetch(`${base}/internal/v1/chats/-1/policy`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(request),
    });
    assert.equal(saved.status, 200);
    const first = await saved.json();
    const repeated = await fetch(`${base}/internal/v1/chats/-1/policy`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(request),
    });
    assert.deepEqual(await repeated.json(), first);
    await candidate('review-message');
    await pool.query(
      "UPDATE eraser_candidates SET state='uncertain' WHERE chat_id='-1' AND message_id='review-message'",
    );
    const reviewed = await fetch(`${base}/internal/v1/chats/-1/review`, { headers });
    const reviewBody = (await reviewed.json()) as {
      items: Array<{ intentStatus: string; retryAllowed: boolean }>;
    };
    assert.equal(reviewBody.items[0]?.intentStatus, 'AMBIGUOUS');
    assert.equal(reviewBody.items[0]?.retryAllowed, false);
    const checksBeforeRemoval = rightsChecks;
    await store.ingest({ update_type: 'bot_removed', chat_id: -1 }, 'authenticated-bot-removal');
    assert.equal((await store.snapshot('-1')).connectionStatus, 'missing');
    assert.equal((await store.snapshot('-1')).historyStatus, 'blocked');
    assert.equal((await store.reserve(1)).length, 0);
    await store.connection('-1', 'connected');
    const passive = new CleanupRuntime(store, max, { enabled: true, redisUrl });
    await passive.visit({ chatId: '-1', leaseToken: randomUUID() });
    assert.equal(rightsChecks, checksBeforeRemoval);
    assert.equal((await store.policy('-1'))?.connection_status, 'missing');
    accessFailure = new MaxError(429, 'rate.limit', false, 1000);
    const retryInput = { ...request, expectedRevision: 1, operationId: randomUUID() };
    const unavailable = await fetch(`${base}/internal/v1/chats/-1/policy`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(retryInput),
    });
    assert.equal(unavailable.status, 503);
    assert.equal((await store.policy('-1'))?.connection_status, 'missing');
    accessFailure = null;
    const confirmed = await fetch(`${base}/internal/v1/chats/-1/policy`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(retryInput),
    });
    assert.equal(confirmed.status, 200);
    assert.equal(
      ((await confirmed.json()) as { connectionStatus: string }).connectionStatus,
      'connected',
    );
    assert.equal((await store.reserve(1)).length, 1);
    const webhook = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(webhook.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
