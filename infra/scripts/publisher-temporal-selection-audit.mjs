#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from './publisher-dispatch-rollout-state.mjs';

const DIRECTORY = 'publisher-selection-rollouts';
const MODES = new Set(['off', 'test', '5', '25', '100']);
const OPERATION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const MAX_BYTES = 4096;

function requireDirectory(path, privateMode = false) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (privateMode && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()))
  ) {
    throw new Error('Selection audit requires an owned protected directory.');
  }
}

function syncDirectory(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function validate(record) {
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    record.version !== 1 ||
    record.operation !== 'selection' ||
    !OPERATION.test(record.operationId) ||
    !/^[a-f0-9]{40}$/u.test(record.sourceSha) ||
    !MODES.has(record.fromMode) ||
    !MODES.has(record.toMode) ||
    typeof record.fromConfigured !== 'boolean' ||
    typeof record.dispatchEnabled !== 'boolean' ||
    typeof record.dispatchConfigured !== 'boolean' ||
    typeof record.runtimeVerified !== 'boolean' ||
    !['started', 'completed', 'failed'].includes(record.status) ||
    typeof record.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.startedAt))
  ) {
    throw new Error('Invalid selection audit record.');
  }
  if (
    (!record.fromConfigured && record.fromMode !== 'off') ||
    (!record.dispatchConfigured && record.dispatchEnabled) ||
    (record.toMode !== 'off' && !record.dispatchEnabled)
  ) {
    throw new Error('Inconsistent selection audit configuration.');
  }
}

function encode(record) {
  validate(record);
  const contents = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(contents) > MAX_BYTES)
    throw new Error('Selection audit record is too large.');
  return contents;
}

export function startSelectionAudit(stateDir, input) {
  const root = resolve(stateDir);
  requireDirectory(root);
  const directory = resolve(root, DIRECTORY);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  requireDirectory(directory, true);
  const record = {
    version: 1,
    operation: 'selection',
    operationId: randomUUID(),
    sourceSha: input.sourceSha,
    fromMode: input.fromMode,
    fromConfigured: input.fromConfigured,
    toMode: input.toMode,
    dispatchEnabled: input.dispatchEnabled,
    dispatchConfigured: input.dispatchConfigured,
    status: 'started',
    startedAt: new Date().toISOString(),
    runtimeVerified: false,
  };
  const contents = encode(record);
  const path = resolve(directory, `${record.operationId}.json`);
  const temporary = resolve(directory, `.${record.operationId}.pending`);
  // FLAG: This is operational evidence only. It never authorizes recovery or modifies
  // the release manifest; the existing deploy lock and pause remain the authority.
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(descriptor, contents, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    // FLAG: Publish a complete fsynced record atomically without replacing another operation.
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  syncDirectory(directory);
  syncDirectory(root);
  return path;
}

export function finishSelectionAudit(path, status, exitCode, runtimeVerified) {
  const target = resolve(path);
  const directory = dirname(target);
  if (
    basename(directory) !== DIRECTORY ||
    !OPERATION.test(basename(target, '.json')) ||
    !target.endsWith('.json') ||
    !['completed', 'failed'].includes(status) ||
    !Number.isInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255 ||
    typeof runtimeVerified !== 'boolean' ||
    (status === 'completed' && (exitCode !== 0 || !runtimeVerified)) ||
    (status === 'failed' && exitCode === 0)
  ) {
    throw new Error('Invalid selection audit completion.');
  }
  requireDirectory(directory, true);
  const stat = lstatSync(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_BYTES ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error('Selection audit requires a bounded owned private record.');
  }
  const record = JSON.parse(readFileSync(target, 'utf8'));
  validate(record);
  if (record.status !== 'started' || record.operationId !== basename(target, '.json')) {
    throw new Error('Selection audit is already terminal or has a different identity.');
  }
  writeFileAtomic(
    target,
    encode({ ...record, status, exitCode, runtimeVerified, finishedAt: new Date().toISOString() }),
  );
}

function boolean(value) {
  if (value !== 'true' && value !== 'false') throw new Error('Selection audit expects a boolean.');
  return value === 'true';
}

function main([command, ...args]) {
  if (command === 'start' && args.length === 7) {
    const [
      directory,
      sourceSha,
      fromMode,
      fromConfigured,
      toMode,
      dispatchEnabled,
      dispatchConfigured,
    ] = args;
    process.stdout.write(
      `${startSelectionAudit(directory, {
        sourceSha,
        fromMode,
        fromConfigured: boolean(fromConfigured),
        toMode,
        dispatchEnabled: boolean(dispatchEnabled),
        dispatchConfigured: boolean(dispatchConfigured),
      })}\n`,
    );
    return;
  }
  if (command === 'finish' && args.length === 4) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(args[2])) throw new Error('Invalid audit exit code.');
    finishSelectionAudit(args[0], args[1], Number(args[2]), boolean(args[3]));
    return;
  }
  throw new Error(
    'Usage: publisher-temporal-selection-audit.mjs start stateDir sha fromMode fromConfigured toMode dispatch dispatchConfigured | finish recordPath completed|failed exitCode runtimeVerified',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch {
    // FLAG: Avoid serializing filesystem errors or the input record into operational logs.
    process.stderr.write(
      'Selection audit could not be recorded; retain the current runtime and inspect private evidence.\n',
    );
    process.exitCode = 1;
  }
}
