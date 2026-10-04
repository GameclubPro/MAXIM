import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import {
  snapshotTargetEnvironment,
  snapshotCopyColumns,
  snapshotRowInWindow,
  snapshotPhysicalLines,
  restoreAntiduplicateSnapshot,
} from './restore-antiduplicate-snapshot.mjs';

const run = promisify(execFile);
test('physical archive rows preserve Unicode separators and UTF8 across chunk boundaries', async () => {
  const bytes = Buffer.from('first\t{"text":"строка\u2028другая\u2029третья"}\r\nsecond\n');
  const stream = Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])));
  const rows = [];
  for await (const row of snapshotPhysicalLines(stream)) rows.push(row);
  assert.deepEqual(rows, ['first\t{"text":"строка\u2028другая\u2029третья"}', 'second']);
});
test('restore admits only disposable loopback database names and removes application secrets', () => {
  for (const value of [
    'postgresql://u:p@db/maxim_antiduplicate_replay_x',
    'postgresql://u:p@127.0.0.1/maxim',
    'https://127.0.0.1/maxim_race_test_x',
  ])
    assert.throws(() => snapshotTargetEnvironment(value));
  const env = snapshotTargetEnvironment(
    'postgresql://u:p@127.0.0.1:1234/maxim_race_test_x?schema=public',
    { PATH: '/tools', MAX_BOT_TOKEN: 'synthetic' },
  );
  assert.equal(env.PGHOST, '127.0.0.1');
  assert.equal(env.PGPORT, '1234');
  assert.equal(env.MAX_BOT_TOKEN, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test('COPY selection respects receipt UTC window, escaping and exact table/columns', () => {
  const columns = snapshotCopyColumns(
    'COPY public.webhook_events (id, raw_payload, created_at) FROM stdin;',
    'webhook_events',
  );
  assert.deepEqual(columns, ['id', 'raw_payload', 'created_at']);
  assert.equal(
    snapshotCopyColumns('COPY public.bots (id, token) FROM stdin;', 'webhook_events'),
    null,
  );
  const from = Date.parse('2026-08-13T00:00:00Z');
  const until = Date.parse('2026-08-27T00:00:00Z');
  assert.equal(
    snapshotRowInWindow(
      'a\t{"text":"one\\ttwo\\nthree"}\t2026-08-13 00:00:00',
      columns,
      from,
      until,
    ),
    true,
  );
  assert.equal(snapshotRowInWindow('a\t{}\t2026-08-27 00:00:00', columns, from, until), false);
  assert.equal(
    snapshotRowInWindow('a\t{}\t2026-08-12 23:59:59.999999', columns, from, until),
    false,
  );
  assert.equal(snapshotRowInWindow('a\t{}\t2026-08-13 03:00:00+03', columns, from, until), true);
  assert.throws(() => snapshotRowInWindow('a\t{}\t\\N', columns, from, until));
  assert.throws(() => snapshotRowInWindow('a\t{}', columns, from, until));
});

test(
  'private archive restores settings and bounded receipts without foreign credentials or foreign-key dependencies',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL },
  async () => {
    const stores = snapshotTargetEnvironment(process.env.MAXIM_TEST_POSTGRES_URL);
    const sourceName = `maxim_antiduplicate_replay_fixture_${randomUUID().replaceAll('-', '')}`;
    const source = { ...stores, PGDATABASE: sourceName };
    const targetName = `maxim_antiduplicate_replay_restore_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(tmpdir(), 'maxim-antiduplicate-restore-fixture-'));
    const input = join(directory, 'fixture.dump');
    const targetUrl = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    targetUrl.pathname = `/${targetName}`;
    const previous = process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL;
    try {
      await run('createdb', [sourceName], { env: stores });
      await run(
        'psql',
        [
          '-X',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `
      CREATE TABLE chats (id text PRIMARY KEY);
      CREATE TABLE chat_settings (chat_id text PRIMARY KEY REFERENCES chats(id), anti_duplicate_enabled boolean);
      CREATE TABLE bots (id text, token text);
      CREATE TABLE webhook_events (id text, raw_payload jsonb, created_at timestamp);
      INSERT INTO chats VALUES ('fixture'); INSERT INTO chat_settings VALUES ('fixture', true);
      INSERT INTO bots VALUES ('fixture', 'synthetic-secret');
      INSERT INTO webhook_events VALUES ('old', '{}', '2026-08-12'), ('inside', '{}', '2026-08-20'), ('edge', '{}', '2026-08-27');
    `,
        ],
        { env: source },
      );
      await run('pg_dump', ['--format=custom', '--file', input], { env: source });
      await chmod(input, 0o600);
      await run('createdb', [targetName], { env: source });
      process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL = targetUrl.href;
      const sha = createHash('sha256')
        .update(await readFile(input))
        .digest('hex');
      const summary = await restoreAntiduplicateSnapshot([
        '--input',
        input,
        '--expected-sha256',
        sha,
        '--snapshot-at',
        '2026-08-27T03:38:17Z',
      ]);
      assert.equal(summary.restored, 1);
      assert.equal(summary.scanned, 3);
      const { stdout } = await run(
        'psql',
        [
          '-X',
          '-A',
          '-t',
          '-c',
          'SELECT (SELECT count(*) FROM chat_settings), (SELECT count(*) FROM bots), (SELECT id FROM webhook_events)',
        ],
        { env: snapshotTargetEnvironment(targetUrl.href) },
      );
      assert.equal(stdout.trim(), '1|0|inside');
    } finally {
      if (previous === undefined) delete process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL;
      else process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL = previous;
      await run('dropdb', ['--if-exists', targetName], { env: stores });
      await run('dropdb', ['--if-exists', sourceName], { env: stores });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
