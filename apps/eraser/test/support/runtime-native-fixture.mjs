import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createHttpServer } from '../../src/http.ts';
import { migrate } from '../../src/migrate.ts';
import { Store } from '../../src/store.ts';

// This child belongs to one native API test. Its schema and HTTP server are isolated;
// private store URLs arrive only through the public wrapper's inherited environment.
const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl || !process.send)
  throw new Error('Use the public native-store wrapper and an IPC child');

const schema = `eraser_runtime_fixture_${randomUUID().replaceAll('-', '')}`;
let admin;
let pool;
let server;
let created = false;
let queries = 0;
let stopped = false;
let commands = Promise.resolve();
const send = (value) => {
  if (process.connected) process.send(value);
};

async function close() {
  if (stopped) return;
  stopped = true;
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (pool) await pool.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    if (admin) await admin.end();
  }
}

async function command(value) {
  if (value?.type === 'start') {
    if (
      admin ||
      !Array.isArray(value.chatIds) ||
      value.chatIds.length > 50 ||
      value.chatIds.some((id) => typeof id !== 'string' || !/^-[1-9]\d*$/.test(id)) ||
      new Set(value.chatIds).size !== value.chatIds.length
    )
      throw new Error('Invalid fixture initialization');
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    await migrate(pool);
    const store = new Store(pool, true);
    for (const chatId of value.chatIds) await store.bootstrap(chatId, 24);
    const forbidden = async () => {
      throw new Error('Diagnostic fixture cannot call MAX');
    };
    server = createHttpServer(
      store,
      {
        rights: forbidden,
        actorRights: forbidden,
        pin: forbidden,
        page: forbidden,
        presence: forbidden,
        remove: forbidden,
      },
      { health: () => ({ schedulerHealthy: true, schedulerLastSuccessfulAt: null }) },
      {
        databaseUrl,
        redisUrl,
        controlToken: 'a'.repeat(32),
        webhookSecret: 'b'.repeat(32),
        botToken: 'native-test',
        botId: '1',
        apiBaseUrl: 'https://example.invalid',
        port: 3000,
        enabled: true,
        maxRps: 20,
        commitSha: 'native-cross-store',
        webhookUrl: null,
      },
      async () => 'PONG',
    );
    const query = pool.query.bind(pool);
    pool.query = (...args) => {
      queries++;
      return query(...args);
    };
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    send({ type: 'ready', url: `http://127.0.0.1:${server.address().port}` });
  } else if (value?.type === 'stats' && server && !stopped) {
    send({ type: 'stats', queries });
  } else if (value?.type === 'stop') {
    await close();
    send({ type: 'stopped' });
    process.disconnect();
  } else {
    throw new Error('Invalid fixture command');
  }
}

function enqueue(action) {
  commands = commands.then(action).catch(async () => {
    send({ type: 'error', code: 'NATIVE_FIXTURE_FAILED' });
    process.exitCode = 1;
    try {
      await close();
    } finally {
      if (process.connected) process.disconnect();
    }
  });
}
process.on('message', (value) => enqueue(() => command(value)));
process.on('disconnect', () => enqueue(close));
const stop = async () => {
  await close();
  if (process.connected) process.disconnect();
};
process.once('SIGTERM', () => enqueue(stop));
process.once('SIGINT', () => enqueue(stop));
