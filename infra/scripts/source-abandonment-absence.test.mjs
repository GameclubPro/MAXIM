import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import vm from 'node:vm';
const code = readFileSync(new URL('./source-abandonment-absence.cjs', import.meta.url), 'utf8');
const request = { version: 1, certificateId: '33333333-3333-4333-8333-333333333333' };
const env = {
  APP_SOURCE_SHA: 'a'.repeat(40),
  MAXIM_SOURCE_ABANDONMENT_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
};
async function run(Client, input = request, databaseUrl) {
  const output = [],
    errors = [];
  const process = {
    env: { ...env, DATABASE_URL: databaseUrl },
    stdin: Readable.from([JSON.stringify(input)]),
    stdout: { write: (text) => output.push(text) },
    stderr: { write: (text) => errors.push(text) },
    exitCode: 0,
    exit() {
      throw new Error('deadline');
    },
  };
  await vm.runInNewContext(code, {
    require: () => ({ createRequire: () => () => ({ Client }) }),
    process,
    Buffer,
    setTimeout,
    clearTimeout,
  });
  return { output, errors, exitCode: process.exitCode };
}
test('absence probe executes only fixed read-only indexed primary-key queries', async () => {
  const queries = [];
  class Client {
    constructor(options) {
      assert.match(options.options, /default_transaction_read_only=on/);
    }
    async connect() {}
    async end() {}
    async query(text, params) {
      queries.push(text);
      if (text.startsWith('EXPLAIN'))
        return {
          rows: [
            {
              'QUERY PLAN': [
                {
                  Plan: {
                    'Node Type': 'Index Only Scan',
                    'Index Name': 'webhook_source_abandonment_certificates_pkey',
                    'Index Cond': '(id = expected)',
                  },
                },
              ],
            },
          ],
        };
      if (text.startsWith('SELECT')) {
        assert.equal(params[0], request.certificateId);
        return { rows: [] };
      }
      return { rows: [] };
    }
  }
  const result = await run(Client);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.output[0]).state, 'ABSENT');
  assert.deepEqual(queries, [
    'BEGIN READ ONLY',
    'SET LOCAL enable_seqscan = off',
    'SET LOCAL enable_bitmapscan = off',
    'EXPLAIN (FORMAT JSON) SELECT id FROM webhook_source_abandonment_certificates WHERE id = $1',
    'SELECT id FROM webhook_source_abandonment_certificates WHERE id = $1',
    'ROLLBACK',
  ]);
});
for (const mode of ['present', 'seqscan', 'timeout'])
  test(`absence probe refuses ${mode} without positive output`, async () => {
    class Client {
      async connect() {}
      async end() {}
      async query(text) {
        if (mode === 'timeout') throw new Error('private details must stay hidden');
        if (text.startsWith('EXPLAIN'))
          return {
            rows: [
              {
                'QUERY PLAN': [
                  {
                    Plan: {
                      'Node Type': mode === 'seqscan' ? 'Seq Scan' : 'Index Scan',
                      'Index Name': 'webhook_source_abandonment_certificates_pkey',
                      'Index Cond': '(id = expected)',
                    },
                  },
                ],
              },
            ],
          };
        return { rows: text.startsWith('SELECT') ? [{ id: request.certificateId }] : [] };
      }
    }
    const result = await run(Client);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, []);
    assert.equal(result.errors.join(''), 'Certificate absence unproved.\n');
  });
test('malformed request cannot open a database client', async () => {
  class Client {
    constructor() {
      assert.fail('client must remain closed');
    }
  }
  const result = await run(Client, { ...request, sql: 'arbitrary' });
  assert.equal(result.exitCode, 1);
});
test(
  'native PostgreSQL verifies the actual certificate primary-key plan and empty result',
  { skip: !process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL },
  async () => {
    const { Client } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('pg');
    const result = await run(Client, request, process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL);
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.output[0]).state, 'ABSENT');
  },
);
