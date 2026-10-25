import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import Redis from 'ioredis';
import bridge from './support-chat-bridge.cjs';
import { verifySupportContainer } from './support-chat-remote.mjs';
const { CHAT_ID, sourceMessage, PilotFence, PilotHistory, deliverAnswer } = bridge;
const row = (text = 'Как подключить бота?') => ({
  recipient: { chat_id: CHAT_ID },
  sender: { user_id: 42, is_bot: false },
  timestamp: Date.now(),
  body: { mid: 'question-1', text },
});

test('source boundary requires exact test chat, explicit human and fresh creation', () => {
  assert.ok(sourceMessage(row()));
  assert.equal(sourceMessage({ ...row(), recipient: { chat_id: 'another-chat' } }), null);
  assert.equal(sourceMessage({ ...row(), sender: { user_id: 42, is_bot: true } }), null);
  assert.equal(sourceMessage({ ...row(), sender: { user_id: 42 } }), null);
  assert.equal(sourceMessage({ ...row(), timestamp: Date.now() - 181000 }), null);
});

test('followups use bounded context of the same participant', () => {
  const history = new PilotHistory();
  history.push('alice', { role: 'user', text: 'Как настроить бота?' });
  assert.deepEqual(history.read('bob'), []);
  for (let i = 0; i < 20; i++) history.push('alice', { role: 'user', text: String(i) });
  assert.equal(history.read('alice').length, 6);
  for (let i = 0; i < 40; i++) history.push(String(i), { role: 'user', text: 'Привет' });
  assert.equal(history.users.size, 32);
});

test('bridge refuses unhealthy, mismatched or foreign containers', () => {
  const value = {
    Id: 'a'.repeat(64),
    Image: 'sha256:fixture',
    State: { Running: true },
    Config: {
      Labels: {
        'com.maxim.release-protected': 'true',
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': 'api-action',
      },
      Env: ['APP_SERVICE_NAME=api-action', 'APP_ROLE=action'],
    },
  };
  assert.equal(verifySupportContainer([value], value.Image), value.Id);
  assert.throws(() => verifySupportContainer([value], 'wrong'), /refused/u);
  assert.throws(
    () => verifySupportContainer([{ ...value, State: { Running: false } }], value.Image),
    /refused/u,
  );
});

test(
  'real Redis fences duplicate workers, expired sources and uncertain SEND without replay',
  { timeout: 20000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-support-redis-'));
    const socket = join(directory, 'redis.sock');
    const server = spawn(
      'redis-server',
      [
        '--port',
        '0',
        '--unixsocket',
        socket,
        '--unixsocketperm',
        '700',
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        directory,
      ],
      { stdio: 'ignore' },
    );
    const exited = once(server, 'exit');
    const redis = new Redis({
      path: socket,
      lazyConnect: true,
      retryStrategy: null,
      maxRetriesPerRequest: 0,
    });
    redis.on('error', () => {});
    try {
      let connected = false;
      for (let i = 0; i < 100; i++) {
        try {
          await redis.connect();
          connected = true;
          break;
        } catch {
          await pause(20);
        }
      }
      assert.equal(connected, true, 'private Redis must actually start');
      const owner = new PilotFence(redis, 'owner'),
        other = new PilotFence(redis, 'other');
      assert.equal(await owner.acquire(), true);
      assert.equal(await other.acquire(), false);
      assert.equal(await owner.prepare('expired'), true);
      assert.equal(await owner.begin('expired', Date.now() - 1), false);
      const raw = row(),
        source = sourceMessage(raw);
      assert.equal(await owner.prepare(source.id), true);
      let sends = 0;
      const runtime = {
        options: () => ({ botId: 'assigned-fixture' }),
        assertSourceAllowed: async () => {},
        assertAccess: async () => {},
        client: {
          getExactMessageRow: async () => raw,
          async sendMessageImmediateWithId(chatId, text, options) {
            assert.equal(chatId, CHAT_ID);
            await options.beforeSend();
            sends++;
            throw new Error('simulated lost acknowledgement');
          },
        },
      };
      const bounds = {
        signal: new AbortController().signal,
        sessionEnd: Date.now() + 180000,
        heartbeatAt: () => Date.now(),
      };
      assert.equal(await deliverAnswer(runtime, owner, source, 'Инструкция', bounds), 'unknown');
      assert.equal(sends, 1);
      assert.equal(await redis.get(owner.key(source.id)), 'UNKNOWN');
      assert.equal(await owner.prepare(source.id), false);
      assert.equal(await owner.begin(source.id, Date.now() + 1000), false);
      await owner.close();
      assert.equal(await other.acquire(), true);
      assert.equal(await other.prepare(source.id), false);
      assert.equal(await owner.begin(source.id, Date.now() + 1000), false);
      const changed = { ...source, id: 'changed-source' };
      assert.equal(await other.prepare(changed.id), true);
      runtime.client.getExactMessageRow = async () => ({
        ...raw,
        body: { mid: changed.id, text: 'Текст изменён' },
      });
      assert.equal(await deliverAnswer(runtime, other, changed, 'Ответ', bounds), 'refused');
      assert.equal(sends, 1);
      await other.close();
    } finally {
      redis.disconnect();
      server.kill('SIGTERM');
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
