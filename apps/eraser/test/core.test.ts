import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { config, type Config } from '../src/config.js';
import { MaxClient, MaxError } from '../src/max.js';
import { updateInput, protectionInput } from '../src/http.js';
import { parseMessage } from '../src/types.js';
import { protectionGap } from '../src/store.js';

const settings: Config = {
  databaseUrl: 'postgres://localhost/test',
  redisUrl: 'redis://localhost',
  controlToken: 'a'.repeat(32),
  webhookSecret: 'b'.repeat(32),
  botToken: 'private',
  botId: '123',
  apiBaseUrl: 'https://platform-api2.max.ru',
  port: 3000,
  enabled: true,
  maxRps: 20,
  commitSha: 'unit',
  webhookUrl: null,
};
const baseEnv = {
  ERASER_DATABASE_URL: settings.databaseUrl,
  ERASER_REDIS_URL: settings.redisUrl,
  ERASER_CONTROL_TOKEN: settings.controlToken,
};
const raw = (time: number) => ({
  timestamp: time,
  sender: { user_id: 5, is_bot: false },
  recipient: { chat_id: -1, chat_type: 'chat' },
  body: { mid: 'message' },
});

test('defaults are disabled and fail closed for malformed identity/retired API and excessive RPS', () => {
  assert.equal(config(baseEnv).enabled, false);
  assert.equal(config(baseEnv).maxRps, 20);
  assert.throws(() => config({ ...baseEnv, ERASER_ENABLED: 'true' }));
  assert.throws(() => config({ ...baseEnv, MAX_API_BASE_URL: 'https://platform-api.max.ru' }));
  assert.throws(() =>
    config({ ...baseEnv, MAX_API_BASE_URL: 'https://platform-api2.max.ru/?token=x' }),
  );
  assert.throws(() => config({ ...baseEnv, ERASER_MAX_RPS: '31' }));
});

test('policy supports all three periods and requires a UUID operation identity', () => {
  for (const hours of [24, 48, 168])
    assert.equal(
      updateInput({
        enabled: true,
        hours,
        expectedRevision: 0,
        operationId: randomUUID(),
        actorUserId: '5',
      }).hours,
      hours,
    );
  assert.throws(() =>
    updateInput({
      enabled: true,
      hours: 12,
      expectedRevision: 0,
      operationId: randomUUID(),
      actorUserId: '5',
    }),
  );
  assert.throws(() =>
    updateInput({
      enabled: true,
      hours: 24,
      expectedRevision: 0,
      operationId: 'retry',
      actorUserId: '5',
    }),
  );
  assert.equal(
    protectionInput({
      sourceRevision: 1,
      protectedMessageIds: [],
      protectedBotIds: [],
      holdMessageIds: [],
      completeThrough: null,
      complete: false,
    }).complete,
    false,
  );
});

test('message age uses original authenticated creation timestamp and exact group identity', () => {
  const time = Date.now() - 30 * 86_400_000;
  assert.equal(parseMessage(raw(time), '-1')?.sourceMs, time);
  assert.equal(parseMessage(raw(time), '-2'), null);
  assert.equal(parseMessage({ ...raw(time), timestamp: Date.now() + 120_000 }, '-1'), null);
  assert.equal(
    parseMessage({ ...raw(time), recipient: { chat_id: -1, chat_type: 'channel' } }, '-1'),
    null,
  );
});

test('module-bot history coverage validates its boundary and leaves independent authors eligible', () => {
  const input = {
    sourceRevision: 1,
    protectedMessageIds: [],
    protectedBotIds: ['900'],
    holdMessageIds: [],
    completeThrough: new Date(5000).toISOString(),
  };
  assert.equal(protectionInput(input).botHistoryCompleteFrom, null);
  assert.equal(
    protectionInput({ ...input, botHistoryCompleteFrom: new Date(2000).toISOString() })
      .botHistoryCompleteFrom,
    new Date(2000).toISOString(),
  );
  for (const floor of ['invalid', 1000, new Date(Date.now() + 120_000).toISOString()])
    assert.throws(() => protectionInput({ ...input, botHistoryCompleteFrom: floor }));
  const coverage = {
    ready: true,
    complete_through: new Date(5000),
    bot_history_complete_from: new Date(2000),
  };
  for (const isBot of [true, null]) {
    assert.equal(protectionGap({ isBot, sourceMs: 1999 }, true, coverage), 'history');
    assert.equal(protectionGap({ isBot, sourceMs: 2000 }, true, coverage), null);
    assert.equal(protectionGap({ isBot, sourceMs: 1999 }, false, coverage), null);
    assert.equal(protectionGap({ isBot, sourceMs: 5001 }, false, coverage), 'current');
    assert.equal(
      protectionGap({ isBot, sourceMs: 3000 }, true, {
        ...coverage,
        bot_history_complete_from: null,
      }),
      'history',
    );
  }
  assert.equal(protectionGap({ isBot: false, sourceMs: 1999 }, true, coverage), null);
});

test('transport budgets reads and every delete and never leaks a token into URL', async () => {
  const calls: string[] = [],
    admissions: Array<string | undefined> = [];
  const http: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(!url.includes(settings.botToken));
    assert.equal((init?.headers as Record<string, string>).Authorization, settings.botToken);
    calls.push(`${init?.method} ${new URL(url).pathname}`);
    const path = new URL(url).pathname;
    if (path.endsWith('/members/me'))
      return Response.json({
        user_id: 123,
        is_admin: true,
        permissions: ['read_all_messages', 'write'],
      });
    if (path.endsWith('/pin')) return Response.json({ message: null });
    if (init?.method === 'DELETE') return Response.json({ success: true });
    return Response.json({ messages: [raw(Date.now() - 86_400_000)] });
  };
  const max = new MaxClient(
    settings,
    {
      acquire: async (chat) => {
        admissions.push(chat);
      },
      cooldown: async () => {},
    },
    http,
  );
  await max.rights('-1');
  await max.pin('-1');
  await max.page('-1', Date.now());
  let guard = false;
  await max.remove('-1', 'message', async () => {
    guard = true;
  });
  assert.equal(guard, true);
  assert.equal(admissions.length, 4);
  assert.equal(admissions.at(-1), '-1');
  assert.equal(calls.length, 4);
});

test('bare 404 does not establish absence and success false does not certify deletion', async () => {
  let response = Response.json({ message: 'missing' }, { status: 404 });
  const max = new MaxClient(
    settings,
    { acquire: async () => {}, cooldown: async () => {} },
    async () => response,
  );
  await assert.rejects(
    max.presence('-1', 'message'),
    (e) => e instanceof MaxError && e.code === 'unclassified',
  );
  response = Response.json({ code: 'message.not.found' }, { status: 404 });
  assert.equal(await max.presence('-1', 'message'), 'absent');
  response = Response.json({ success: false });
  await assert.rejects(
    max.remove('-1', 'message', async () => {}),
    (e) => e instanceof MaxError && e.attempted && e.code === 'delete_unconfirmed',
  );
});

test('429 honors Retry-After and leaves the delete safe for a later guarded attempt', async () => {
  const cooldowns: number[] = [];
  const max = new MaxClient(
    settings,
    {
      acquire: async () => {},
      cooldown: async (ms) => {
        cooldowns.push(ms);
      },
    },
    async () =>
      Response.json({ code: 'rate.limit' }, { status: 429, headers: { 'Retry-After': '3' } }),
  );
  await assert.rejects(
    max.remove('-1', 'message', async () => {}),
    (e) => e instanceof MaxError && e.retryAfterMs === 3000 && !e.attempted,
  );
  assert.deepEqual(cooldowns, [3000]);
});

test('malformed/foreign history pages stop instead of manufacturing coverage', async () => {
  const max = new MaxClient(
    settings,
    { acquire: async () => {}, cooldown: async () => {} },
    async () =>
      Response.json({
        messages: [
          { ...raw(Date.now() - 86_400_000), recipient: { chat_id: -2, chat_type: 'chat' } },
        ],
      }),
  );
  await assert.rejects(
    max.page('-1', Date.now()),
    (e) => e instanceof MaxError && e.code === 'history_unknown',
  );
});

test('webhook registration verifies exact bot, rejects conflicting subscriptions and reads back success', async () => {
  const url = 'https://major-maksimov.ru/eraser/webhook';
  const calls: string[] = [];
  let registered = false;
  const max = new MaxClient(
    { ...settings, webhookUrl: url },
    { acquire: async () => {}, cooldown: async () => {} },
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method} ${path}`);
      if (path === '/me') return Response.json({ user_id: 123, is_bot: true });
      if (init?.method === 'POST') {
        registered = true;
        return Response.json({ success: true });
      }
      return Response.json({ subscriptions: registered ? [{ url }] : [] });
    },
  );
  await max.subscribe();
  assert.deepEqual(calls, [
    'GET /me',
    'GET /subscriptions',
    'POST /subscriptions',
    'GET /subscriptions',
  ]);
  const conflict = new MaxClient(
    { ...settings, webhookUrl: url },
    { acquire: async () => {}, cooldown: async () => {} },
    async (input) =>
      new URL(String(input)).pathname === '/me'
        ? Response.json({ user_id: 123, is_bot: true })
        : Response.json({ subscriptions: [{ url: 'https://other.invalid/webhook' }] }),
  );
  await assert.rejects(conflict.subscribe(), /Conflicting Eraser webhook subscription/);
});

test('standalone runtime image carries both Russian CAs, exact source identity and no API runtime dependency', async () => {
  const { readFile } = await import('node:fs/promises');
  const { X509Certificate } = await import('node:crypto');
  const docker = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(
    docker,
    /NODE_EXTRA_CA_CERTS=\/usr\/local\/share\/ca-certificates\/russian-trusted-ca-bundle\.crt/,
  );
  for (const name of ['root', 'sub']) {
    const pem = await readFile(
      new URL(`../../../infra/certs/russian-trusted-${name}-ca.pem`, import.meta.url),
      'utf8',
    );
    assert.equal(new X509Certificate(pem).ca, true);
    assert.match(docker, new RegExp(`COPY infra/certs/russian-trusted-${name}-ca\\.pem`));
  }
  assert.ok(
    docker.includes(
      "printf '\\n' >> /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt",
    ),
    'PEM files without trailing newlines require an explicit bundle separator',
  );
  assert.match(docker, /com\.maxim\.release-protected="true"/);
  assert.match(docker, /org\.opencontainers\.image\.revision=\$COMMIT_SHA/);
  assert.doesNotMatch(docker, /COPY apps\/api|MAX_BOT_TOKEN|MAX_PUBLISHER_BOT_TOKEN/);
});

test('bounded housekeeping drains terminal receipts faster than the maximum configured HTTP budget', async () => {
  const { HOUSEKEEPING_INTERVAL_MS, TERMINAL_PURGE_BATCH, WEBHOOK_PURGE_BATCH } =
    await import('../src/store.js');
  assert.ok(
    TERMINAL_PURGE_BATCH / (HOUSEKEEPING_INTERVAL_MS / 1000) >= 30,
    'seven-day terminal retention must not grow under the30HTTP/s platform ceiling',
  );
  assert.ok(
    WEBHOOK_PURGE_BATCH >= TERMINAL_PURGE_BATCH,
    'webhookreceipt cleanup has its own larger ingestion budget',
  );
  assert.ok(
    TERMINAL_PURGE_BATCH <= 5000 && WEBHOOK_PURGE_BATCH <= 20000,
    'housekeeping visits remain bounded',
  );
});

test('membership absence or malformed data does not manufacture a permanent access denial', async () => {
  let row: unknown = { user_id: 123 };
  const max = new MaxClient(
    settings,
    { acquire: async () => {}, cooldown: async () => {} },
    async () => Response.json(row),
  );
  await assert.rejects(
    max.rights('-1'),
    (error) => error instanceof MaxError && error.code === 'membership_unknown',
  );
  row = { user_id: 999, is_admin: false, permissions: [] };
  await assert.rejects(
    max.rights('-1'),
    (error) => error instanceof MaxError && error.code === 'membership_unknown',
  );
  row = { user_id: 123, is_admin: false, permissions: [] };
  await assert.rejects(
    max.rights('-1'),
    (error) => error instanceof MaxError && error.code === 'eraser_rights_missing',
  );
  row = { user_id: 123, is_admin: true };
  await assert.rejects(
    max.rights('-1'),
    (error) => error instanceof MaxError && error.code === 'membership_unknown',
  );
});
