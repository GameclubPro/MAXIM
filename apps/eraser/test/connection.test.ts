import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { updateInput } from '../src/http.js';
import { MaxClient, MaxError } from '../src/max.js';

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

test('hour-long connection is an explicit enabled-only policy option', () => {
  const input = {
    enabled: true,
    hours: 48,
    expectedRevision: 0,
    operationId: randomUUID(),
    actorUserId: '5',
  };
  assert.equal(updateInput({ ...input, connectWhenReady: true }).connectWhenReady, true);
  assert.equal(updateInput(input).connectWhenReady, undefined);
  assert.notEqual(updateInput({ ...input, connectWhenReady: false }).connectWhenReady, true);
  for (const connectWhenReady of [null, 1, 'true', {}, []])
    assert.throws(() => updateInput({ ...input, connectWhenReady }));
  assert.throws(() => updateInput({ ...input, enabled: false, connectWhenReady: true }));
});

test('connection actor proof targets the exact requesting human and shares the HTTP budget', async () => {
  const calls: URL[] = [];
  let admissions = 0;
  const client = new MaxClient(
    settings,
    {
      acquire: async () => {
        admissions++;
      },
      cooldown: async () => {},
    },
    async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      assert.equal(init?.method, 'GET');
      assert.equal(url.pathname, '/chats/-1/members');
      assert.equal(url.searchParams.get('user_ids'), '5');
      assert.equal(url.searchParams.has('marker'), false);
      assert.equal(url.search.includes(settings.botToken), false);
      return Response.json({ members: [{ user_id: 5, is_bot: false, is_admin: true }] });
    },
  );
  await client.actorRights('-1', '5');
  assert.equal(admissions, 1);
  assert.equal(calls.length, 1);
});

test('connection actor proof accepts positive human administrator or owner evidence', async () => {
  for (const member of [
    { user_id: 5, is_bot: false, is_admin: true },
    { user_id: 5, is_bot: false, is_owner: true },
    { user_id: 5, is_bot: false, role: 'admin' },
  ]) {
    const client = new MaxClient(
      settings,
      { acquire: async () => {}, cooldown: async () => {} },
      async () => Response.json({ members: [member] }),
    );
    await client.actorRights('-1', '5');
  }
});

test('missing or malformed actor evidence never manufactures a cancellation or activation', async () => {
  for (const response of [
    {},
    { members: [] },
    { members: null },
    { members: [{ user_id: 6, is_bot: false, is_admin: true }] },
    { members: [{ user_id: 5, is_admin: true }] },
    { members: [{ user_id: 5, is_bot: true, is_admin: true }] },
    { members: [{ user_id: 5, is_bot: false }] },
    { members: [{ user_id: 5, is_bot: false, is_admin: 'true' }] },
  ]) {
    const client = new MaxClient(
      settings,
      { acquire: async () => {}, cooldown: async () => {} },
      async () => Response.json(response),
    );
    await assert.rejects(
      client.actorRights('-1', '5'),
      (error) => error instanceof MaxError && error.status === 0 && !error.attempted,
    );
  }
});

test('explicit human nonadministrator cannot authorize background activation', async () => {
  for (const member of [
    { user_id: 5, is_bot: false, is_admin: false },
    { user_id: 5, is_bot: false, role: 'member' },
  ]) {
    const client = new MaxClient(
      settings,
      { acquire: async () => {}, cooldown: async () => {} },
      async () => Response.json({ members: [member] }),
    );
    await assert.rejects(
      client.actorRights('-1', '5'),
      (error) => error instanceof MaxError && error.status === 403 && !error.attempted,
    );
  }
});

test('actor lookup preserves denial, unknown access and MAX retry-after semantics', async () => {
  const cooldowns: number[] = [];
  let status = 403;
  const client = new MaxClient(
    settings,
    {
      acquire: async () => {},
      cooldown: async (ms) => {
        cooldowns.push(ms);
      },
    },
    async () =>
      Response.json(
        { code: 'lookup.failed' },
        {
          status,
          headers: { 'Retry-After': '7' },
        },
      ),
  );
  for (status of [403, 404, 429, 503])
    await assert.rejects(
      client.actorRights('-1', '5'),
      (error) =>
        error instanceof MaxError &&
        error.status === status &&
        !error.attempted &&
        (status !== 429 || error.retryAfterMs === 7000),
    );
  assert.deepEqual(cooldowns, [7000]);
});

test('expired connection guard runs after rate admission and prevents every rights HTTP request', async () => {
  for (const target of ['bot', 'human'] as const) {
    let admitted = false;
    let requests = 0;
    const stopped = new Error('connection request expired while waiting for admission');
    const client = new MaxClient(
      settings,
      {
        acquire: async () => {
          admitted = true;
        },
        cooldown: async () => {},
      },
      async () => {
        requests++;
        return Response.json({});
      },
    );
    const before = async () => {
      assert.equal(admitted, true);
      throw stopped;
    };
    await assert.rejects(
      target === 'bot' ? client.rights('-1', before) : client.actorRights('-1', '5', before),
      (error) => error === stopped,
    );
    assert.equal(requests, 0);
  }
});
