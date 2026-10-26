#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import {
  constants,
  fstatSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertEraserConnectionRequestSource,
  installEraserConnectionRequestFloor,
} from './assert-eraser-source.mjs';

export function parseEraserBootstrap(raw) {
  if (Buffer.byteLength(raw) > 4096) throw new Error('Lastik bootstrap request is too large.');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid Lastik bootstrap request.');
  }
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'botId,botToken,sourceSha' ||
    typeof value.botId !== 'string' ||
    !/^[1-9][0-9]{0,31}$/u.test(value.botId) ||
    !/^[a-zA-Z0-9_-]{32,512}$/u.test(value.botToken ?? '') ||
    !/^[a-f0-9]{40}$/u.test(value.sourceSha ?? '')
  )
    throw new Error('Invalid Lastik bootstrap request.');
  return value;
}

export function patchEraserBridgeEnv(raw, token) {
  const updates = {
    ERASER_ENABLED: 'true',
    ERASER_CONTROL_URL: 'http://eraser:3000',
    ERASER_CONTROL_TOKEN: token,
  };
  const seen = new Set();
  const lines = raw.split(/\r?\n/u).map((line) => {
    const key = /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1];
    if (!Object.hasOwn(updates, key ?? '')) return line;
    if (seen.has(key)) throw new Error('Duplicate Lastik bridge environment key.');
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates))
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  return `${lines.join('\n').trimEnd()}\n`;
}

function readPrivate(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      (st.mode & 0o777) !== 0o600 ||
      st.uid !== process.getuid() ||
      st.size < 1 ||
      st.size > 4096
    )
      throw new Error('Lastik request requires a bounded owned 0600 file.');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function atomicPrivate(path, value) {
  const temporary = `${path}.lastik-${process.pid}`;
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

export function installEraserSecrets(
  request,
  { secretsDir, envPath, sourceSha, readerMarkerPath, connectionReaderMarkerPath },
) {
  if (request.sourceSha !== sourceSha)
    throw new Error('Lastik bootstrap source does not match the synchronized checkout.');
  const directory = lstatSync(secretsDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o022)
    throw new Error('Lastik secrets directory is unsafe.');
  const envStat = lstatSync(envPath);
  if (
    !envStat.isFile() ||
    envStat.isSymbolicLink() ||
    (envStat.mode & 0o777) !== 0o600 ||
    envStat.nlink !== 1
  )
    throw new Error('Canonical environment requires a regular 0600 file.');
  const serviceEnv = resolve(secretsDir, 'eraser.env');
  const passwordPath = resolve(secretsDir, 'eraser-postgres-password');
  if (existsSync(serviceEnv) || existsSync(passwordPath))
    throw new Error(
      'Lastik secrets already exist; use --stores-only for interrupted startup, or a reviewed rotation.',
    );
  const password = randomBytes(32).toString('hex');
  const control = randomBytes(32).toString('hex');
  const webhook = randomBytes(32).toString('hex');
  const patched = patchEraserBridgeEnv(readFileSync(envPath, 'utf8'), control);
  const service = [
    'ERASER_ENABLED=true',
    `ERASER_BOT_ID=${request.botId}`,
    `ERASER_BOT_TOKEN=${request.botToken}`,
    `ERASER_CONTROL_TOKEN=${control}`,
    `ERASER_WEBHOOK_SECRET=${webhook}`,
    `ERASER_DATABASE_URL=postgresql://eraser:${password}@eraser-postgres:5432/eraser`,
    'ERASER_REDIS_URL=redis://eraser-redis:6379/0',
    'MAX_API_BASE_URL=https://platform-api2.max.ru',
    '',
  ].join('\n');
  // FLAG: Install the permanent reader floor before any configuration can enable a takeover.
  if (readerMarkerPath) {
    if (existsSync(readerMarkerPath)) {
      const marker = lstatSync(readerMarkerPath);
      if (
        !marker.isFile() ||
        marker.isSymbolicLink() ||
        readFileSync(readerMarkerPath, 'utf8') !== '1\n'
      )
        throw new Error('Lastik ownership reader marker is invalid.');
    } else writeFileSync(readerMarkerPath, '1\n', { flag: 'wx', mode: 0o600 });
  }
  if (connectionReaderMarkerPath) installEraserConnectionRequestFloor(connectionReaderMarkerPath);
  // FLAG: Secrets are never emitted; a partial installation is preserved for reviewed recovery.
  writeFileSync(passwordPath, `${password}\n`, { flag: 'wx', mode: 0o600 });
  writeFileSync(serviceEnv, service, { flag: 'wx', mode: 0o600 });
  atomicPrivate(envPath, patched);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (process.argv[2] === 'validate') {
      parseEraserBootstrap(readPrivate(process.argv[3]));
    } else if (process.argv[2] === 'install') {
      const request = parseEraserBootstrap(readFileSync(0).toString('utf8'));
      if (request.sourceSha !== process.argv[3])
        throw new Error('Lastik bootstrap source does not match the synchronized checkout.');
      assertEraserConnectionRequestSource(process.argv[3]);
      installEraserSecrets(request, {
        secretsDir: '/var/lib/maxim-secrets',
        envPath: resolve('.env'),
        sourceSha: process.argv[3],
        readerMarkerPath: '/var/lib/maxim-deploy/eraser-reader-version',
        connectionReaderMarkerPath: '/var/lib/maxim-deploy/eraser-connection-request-version',
      });
      process.stdout.write(
        'Lastik secrets and bridge configuration installed; chat policies remain off.\n',
      );
    } else throw new Error('Expected validate <private-request> or install <exact-sha>.');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
