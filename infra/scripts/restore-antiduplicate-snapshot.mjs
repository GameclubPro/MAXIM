#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

export function snapshotTargetEnvironment(value, base = process.env) {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/(?:maxim_(?:race_test|antiduplicate_replay)_[a-z0-9_]+)$/u.test(url.pathname)
  )
    throw new Error('Snapshot restore requires an isolated disposable loopback database');
  return {
    PATH: base.PATH,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    PGHOST: url.hostname === '[::1]' ? '::1' : url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
    PGAPPNAME: 'maxim_antiduplicate_local_restore',
    PGOPTIONS: '-c timezone=UTC -c max_parallel_workers_per_gather=0 -c statement_timeout=60000',
  };
}

export function snapshotCopyColumns(line, table) {
  const pattern = new RegExp(`^COPY public\\.${table} \\(([^)]+)\\) FROM stdin;$`, 'u');
  const match = pattern.exec(line);
  if (!match) return null;
  const columns = match[1].split(', ').map((x) => x.replace(/^"|"$/gu, ''));
  if (columns.some((x) => !/^[a-z_][a-z0-9_]*$/u.test(x)))
    throw new Error('Unexpected archive COPY columns');
  return columns;
}

export function snapshotRowInWindow(line, columns, fromMs, untilMs) {
  const cells = line.split('\t');
  if (cells.length !== columns.length) throw new Error('Malformed archive COPY row');
  const position = columns.indexOf('created_at');
  if (position < 0) throw new Error('Archive has no event receipt time');
  const value = cells[position];
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::?\d{2})?)?$/u.test(value))
    throw new Error('Invalid archive event receipt time');
  const withZone = /[+-]\d{2}(?::?\d{2})?$/u.test(value);
  const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})$/u, '$1:00');
  const at = Date.parse(normalized + (withZone ? '' : 'Z'));
  if (!Number.isFinite(at)) throw new Error('Invalid archive event receipt time');
  return at >= fromMs && at < untilMs;
}

export async function* snapshotPhysicalLines(input) {
  input.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk;
    let from = 0;
    let end;
    while ((end = buffer.indexOf('\n', from)) >= 0) {
      if (end - from > 32 * 1024 * 1024)
        throw new Error('Archive row exceeds private restore budget');
      yield buffer.slice(from, end).replace(/\r$/u, '');
      from = end + 1;
    }
    buffer = buffer.slice(from);
    if (buffer.length > 32 * 1024 * 1024)
      throw new Error('Archive row exceeds private restore budget');
  }
  if (buffer) yield buffer.replace(/\r$/u, '');
}

async function child(command, args, env) {
  const process = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0;
  for (const stream of [process.stdout, process.stderr])
    stream.on('data', (chunk) => {
      bytes += chunk.length;
    });
  const code = await new Promise((done) => {
    process.once('error', () => done(-1));
    process.once('close', done);
  });
  if (code !== 0)
    throw new Error(
      `${command} failed during private local restore (${bytes} diagnostic bytes withheld)`,
    );
}

export async function restoreAntiduplicateSnapshot(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      input: { type: 'string' },
      'expected-sha256': { type: 'string' },
      'snapshot-at': { type: 'string' },
      'max-events': { type: 'string', default: '5000000' },
    },
  });
  if (
    !values.input ||
    !/^[a-f0-9]{64}$/u.test(values['expected-sha256'] ?? '') ||
    !Number.isFinite(Date.parse(values['snapshot-at'] ?? ''))
  )
    throw new Error(
      'Usage: --input <verified-private.dump> --expected-sha256 <sha> --snapshot-at <UTC-ISO> [--max-events 5000000]',
    );
  const cap = Number(values['max-events']);
  if (!Number.isInteger(cap) || cap < 1 || cap > 10_000_000)
    throw new Error('Invalid restore event cap');
  const target =
    process.env.MAXIM_ANTIDUPLICATE_SNAPSHOT_URL ?? process.env.MAXIM_TEST_POSTGRES_URL;
  if (!target) throw new Error('Missing isolated snapshot database');
  const env = snapshotTargetEnvironment(target);
  const stat = await lstat(values.input);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid()
  )
    throw new Error('Archive must be an owner-private regular file');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(values.input)) digest.update(chunk);
  if (digest.digest('hex') !== values['expected-sha256'])
    throw new Error('Snapshot checksum mismatch');
  process.stderr.write('private_restore_stage=verified_archive\n');
  // FLAG: Schema is restored into an empty disposable database. Only settings and bounded
  // webhook receipts receive data; bot catalog/token tables remain empty, and no workers run.
  await child(
    'pg_restore',
    [
      '--schema-only',
      '--section=pre-data',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--dbname',
      env.PGDATABASE,
      values.input,
    ],
    env,
  );
  process.stderr.write('private_restore_stage=empty_schema_restored\n');
  await child(
    'pg_restore',
    [
      '--data-only',
      '--table',
      'chat_settings',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--dbname',
      env.PGDATABASE,
      values.input,
    ],
    env,
  );
  process.stderr.write('private_restore_stage=settings_restored\n');
  const until = new Date(values['snapshot-at']);
  until.setUTCHours(0, 0, 0, 0);
  const from = new Date(until.getTime() - 14 * 86_400_000);
  const reader = spawn(
    'pg_restore',
    ['--data-only', '--table', 'webhook_events', '--file', '-', values.input],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const writer = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], {
    env: { ...env, PGOPTIONS: '-c timezone=UTC -c statement_timeout=0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  reader.stderr.on('data', () => undefined);
  writer.stderr.on('data', (chunk) => {
    const diagnostic = String(chunk);
    const causes = [
      'extra data after last expected column',
      'missing data for column',
      'invalid input syntax',
      'unterminated',
      'permission denied',
      'connection refused',
      'out of memory',
      'does not exist',
    ];
    const cause = causes.find((value) => diagnostic.includes(value));
    if (cause) process.stderr.write(`private_restore_writer_cause=${cause.replaceAll(' ', '_')}\n`);
  });
  writer.stdout.on('data', () => undefined);
  const readerDone = new Promise((done) => {
    reader.once('error', () => done(-1));
    reader.once('close', done);
  });
  const writerDone = new Promise((done) => {
    writer.once('error', () => done(-1));
    writer.once('close', done);
  });
  let writerFailed = false;
  writer.stdin.on('error', () => {
    writerFailed = true;
    reader.kill('SIGTERM');
    reader.stdout.destroy();
  });
  writer.on('close', () => {
    if (!writer.stdin.writableFinished) {
      writerFailed = true;
      reader.kill('SIGTERM');
      reader.stdout.destroy();
    }
  });
  const deadline = setTimeout(() => {
    writerFailed = true;
    reader.kill('SIGTERM');
    writer.kill('SIGTERM');
  }, 30 * 60_000);
  let columns = null;
  let inCopy = false;
  let scanned = 0;
  let restored = 0;
  let oldest = null;
  let newest = null;
  const write = async (line) => {
    if (writerFailed || writer.stdin.destroyed) throw new Error('Private restore writer stopped');
    if (!writer.stdin.write(`${line}\n`)) await once(writer.stdin, 'drain');
  };
  // FLAG: Node readline also splits U+2028/U+2029, which are valid JSON/COPY content.
  // Only physical LF frames archive records; never interpret user prose as a new row.
  const lines = snapshotPhysicalLines(reader.stdout);
  try {
    for await (const line of lines) {
      if (!inCopy) {
        columns = snapshotCopyColumns(line, 'webhook_events');
        if (columns) {
          inCopy = true;
          await write(line);
        }
        continue;
      }
      if (line === '\\.') {
        await write(line);
        inCopy = false;
        continue;
      }
      ++scanned;
      let selected;
      try {
        selected = snapshotRowInWindow(line, columns, from.getTime(), until.getTime());
      } catch (error) {
        process.stderr.write(
          `private_restore_row_shape=${JSON.stringify({ scanned, restored, cells: line.split('\t').length, expected: columns.length, characters: line.length, writerFailed })}\n`,
        );
        throw error;
      }
      if (!selected) continue;
      if (++restored > cap)
        throw new Error('Snapshot restore cap reached; no incomplete corpus is accepted');
      const at = line.split('\t')[columns.indexOf('created_at')];
      oldest = oldest === null || at < oldest ? at : oldest;
      newest = newest === null || at > newest ? at : newest;
      await write(line);
      if (restored % 100000 === 0) process.stderr.write(`restored_private_receipts=${restored}\n`);
    }
    writer.stdin.end();
    const [readerCode, writerCode] = await Promise.all([readerDone, writerDone]);
    if (readerCode !== 0 || writerCode !== 0 || writerFailed || inCopy || !restored)
      throw new Error('Snapshot receipt restore failed or is empty');
    const summary = {
      sourceSnapshotAt: values['snapshot-at'],
      sourceSnapshotSha256: values['expected-sha256'],
      restoredFrom: from.toISOString(),
      restoredUntil: until.toISOString(),
      scanned,
      restored,
      oldest,
      newest,
      isolated: true,
      botCredentialsRestored: false,
      applicationWorkersStarted: false,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    clearTimeout(deadline);
    reader.stdout.destroy();
    reader.kill('SIGTERM');
    writer.kill('SIGTERM');
    await Promise.all([readerDone, writerDone]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void restoreAntiduplicateSnapshot(process.argv.slice(2)).catch((error) => {
    const message =
      error instanceof Error &&
      (/^(?:pg_restore|psql) failed during private local restore \(\d+ diagnostic bytes withheld\)$/u.test(
        error.message,
      ) ||
        [
          'Snapshot checksum mismatch',
          'Archive must be an owner-private regular file',
          'Snapshot restore requires an isolated disposable loopback database',
          'Snapshot receipt restore failed or is empty',
          'Missing isolated snapshot database',
          'Invalid archive event receipt time',
          'Malformed archive COPY row',
        ].includes(error.message))
        ? error.message
        : 'Private snapshot restore failed';
    process.stderr.write(`${message}; archive data and credentials were withheld.\n`);
    process.exitCode = 1;
  });
