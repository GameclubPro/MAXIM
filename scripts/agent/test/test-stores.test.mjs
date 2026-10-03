import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parseArgs } from '../with-test-stores.mjs';

const root = resolve(import.meta.dirname, '../../..');
const runner = resolve(root, 'scripts/agent/with-test-stores.mjs');

test('store runner rejects a missing child command and unknown setup options', () => {
  for (const args of [[], ['--'], ['npm', 'test'], ['--remote', '--', 'npm', 'test']]) {
    assert.throws(() => parseArgs(args), /Usage/u);
  }
  assert.deepEqual(parseArgs(['--migrate', '--', 'npm', 'test', '--', 'fixture']), {
    migrate: true,
    command: ['npm', 'test', '--', 'fixture'],
  });
});

const realStores = process.env.MAXIM_AGENT_TEST_STORES === '1';
const childSource = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {Client} = require('pg');
const Redis = require('ioredis');
(async () => {
  const pgUrl = new URL(process.env.DATABASE_URL);
  const redisUrl = new URL(process.env.REDIS_URL);
  assert.equal(pgUrl.hostname, '127.0.0.1');
  assert.equal(redisUrl.hostname, '127.0.0.1');
  assert.match(pgUrl.pathname, /race_test/);
  assert.equal(process.env.DATABASE_URL, process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL);
  assert.equal(process.env.DATABASE_URL, process.env.MAXIM_TEST_POSTGRES_URL);
  assert.equal(process.env.REDIS_URL, process.env.MAXIM_TEST_REDIS_URL);
  assert.equal(process.env.TZ, 'UTC');
  const pg = new Client({connectionString: process.env.DATABASE_URL});
  // Existing integration fixtures intentionally use CI-compatible host/port connections.
  const redis = new Redis({host: redisUrl.hostname, port: Number(redisUrl.port)});
  try {
    await pg.connect();
    assert.equal((await pg.query('SHOW TimeZone')).rows[0].TimeZone, 'UTC');
    assert.equal((await pg.query('SELECT count(*) FROM pg_tables WHERE schemaname=\'public\'')).rows[0].count, '0');
    assert.equal(await redis.dbsize(), 0);
    await pg.query('CREATE TABLE fixture(value integer)');
    await pg.query('INSERT INTO fixture VALUES(42)');
    assert.equal((await pg.query('SELECT value FROM fixture')).rows[0].value, 42);
    await redis.set('fixture', 'ok');
    assert.equal(await redis.get('fixture'), 'ok');
    const directory = path.dirname((await pg.query('SHOW data_directory')).rows[0].data_directory);
    fs.writeFileSync(process.env.MAXIM_STORE_TEST_RESULT, JSON.stringify({
      directory, postgresPort: Number(pgUrl.port), redisPort: Number(redisUrl.port)
    }));
  } finally { await pg.end(); redis.disconnect(); }
  if (process.env.MAXIM_STORE_TEST_HOLD === '1') setInterval(() => {}, 1000);
  else process.exitCode = 7;
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

for (const hold of [false, true]) {
  test(
    `real stores override remote URLs and clean up after ${hold ? 'SIGTERM' : 'command failure'}`,
    {
      skip: !realStores,
      timeout: 60_000,
    },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'maxim-store-runner-test-'));
      const resultPath = join(directory, 'result.json');
      const child = spawn(process.execPath, [runner, '--', process.execPath, '-e', childSource], {
        cwd: root,
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://invalid.invalid/never',
          REDIS_URL: 'redis://invalid.invalid',
          CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL: 'postgresql://invalid.invalid/never',
          MAXIM_TEST_POSTGRES_URL: 'postgresql://invalid.invalid/never',
          MAXIM_TEST_REDIS_URL: 'redis://invalid.invalid',
          MAXIM_STORE_TEST_RESULT: resultPath,
          MAXIM_STORE_TEST_HOLD: hold ? '1' : '0',
          TZ: 'Europe/Moscow',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const done = new Promise((resolve) => child.once('close', (code) => resolve(code)));
      try {
        if (hold) {
          const deadline = Date.now() + 40_000;
          while (!existsSync(resultPath) && child.exitCode === null && Date.now() < deadline)
            await delay(50);
          assert.ok(existsSync(resultPath), output);
          child.kill('SIGTERM');
        }
        assert.equal(await done, hold ? 143 : 7, output);
        const info = JSON.parse(await readFile(resultPath, 'utf8'));
        assert.equal(existsSync(info.directory), false, 'temporary data must be removed');
        assert.equal(await portOpen(info.postgresPort), false, 'PostgreSQL must be stopped');
        assert.equal(await portOpen(info.redisPort), false, 'Redis must be stopped');
        assert.match(output, /Owned processes stopped/u);
        assert.doesNotMatch(output, /postgresql:\/\//u, 'credentials/URLs must not be printed');
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await done;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
