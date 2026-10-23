#!/usr/bin/env node

import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const KEY = 'STATISTICS_EXCHANGE_V3_ENABLED';
const MODES = new Set(['false', 'true']);
const MAX_BYTES = 1024 * 1024;

function targetMode(mode) {
  if (mode !== 'false' && mode !== 'true') {
    throw new Error('Statistics exchange deploy flag must be true or false.');
  }
  return mode;
}

function closesQuote(text, quote) {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== quote) continue;
    let escapes = 0;
    for (let previous = index - 1; previous >= 0 && text[previous] === '\\'; previous--) escapes++;
    if (escapes % 2 === 0) return true;
  }
  return false;
}

function inspect(contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (bytes.length > MAX_BYTES)
    throw new Error('Statistics exchange dotenv exceeds its byte limit.');
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (decoded.includes('\0')) throw new Error('Statistics exchange dotenv contains NUL bytes.');
  const lines = decoded.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const assignments = [];
  let multilineQuote = null;
  for (let index = 0; index < lines.length; index++) {
    const line = index === 0 ? lines[index].replace(/^\uFEFF/u, '') : lines[index];
    // FLAG: Apparent flag assignments inside another quoted dotenv value are secret bytes, not settings.
    if (multilineQuote !== null) {
      if (closesQuote(line, multilineQuote)) multilineQuote = null;
      continue;
    }
    const assignment = /^[ \t]*(?:export[ \t]+)?([\w.-]+)(?:[ \t]*=|:[ \t]+)[ \t]*([^\r\n]*)/u.exec(
      line,
    );
    if (assignment && ['"', "'", '`'].includes(assignment[2][0])) {
      const quote = assignment[2][0];
      if (!closesQuote(assignment[2].slice(1), quote)) multilineQuote = quote;
    }
    const match =
      /^[ \t]*(?:export[ \t]+)?STATISTICS_EXCHANGE_V3_ENABLED[ \t]*=([^\r\n]*)\r?\n?$/u.exec(line);
    if (!match) {
      if (assignment?.[1] === KEY) throw new Error('Malformed statistics exchange dotenv flag.');
      continue;
    }
    const value = match[1].trim();
    if (!MODES.has(value)) throw new Error('Malformed statistics-exchange dotenv mode.');
    assignments.push({ index, mode: value });
  }
  if (multilineQuote !== null) throw new Error('Unterminated quoted dotenv value.');
  if (assignments.length > 1) throw new Error('Duplicate statistics-exchange dotenv mode.');
  return { decoded, lines, assignment: assignments[0] };
}

export function readStatisticsExchangeEnv(contents) {
  return inspect(contents).assignment?.mode ?? 'false';
}

export function patchStatisticsExchangeEnv(contents, mode) {
  targetMode(mode);
  const state = inspect(contents);
  const replacement = `${KEY}=${mode}`;
  if (state.assignment) {
    const index = state.assignment.index;
    const original = state.lines[index];
    const bom = index === 0 && original.startsWith('\uFEFF') ? '\uFEFF' : '';
    const ending = original.endsWith('\r\n') ? '\r\n' : original.endsWith('\n') ? '\n' : '';
    state.lines[index] = `${bom}${replacement}${ending}`;
    return state.lines.join('');
  }
  const ending = state.decoded.includes('\r\n') ? '\r\n' : '\n';
  return state.decoded
    ? `${state.decoded}${state.decoded.endsWith('\n') ? '' : ending}${replacement}${ending}`
    : `${replacement}${ending}`;
}

function privateRegularFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
    throw new Error('Statistics exchange dotenv must be a regular, singly linked protected file.');
  }
  if (process.getuid() !== 0 && stat.uid !== process.getuid()) {
    throw new Error('Statistics exchange dotenv must belong to the invoking operator.');
  }
}

export function patchStatisticsExchangeEnvFile(path, mode) {
  targetMode(mode);
  const filename = resolve(path);
  const previous = lstatSync(filename);
  privateRegularFile(previous);
  let input;
  let output;
  let temporary;
  try {
    input = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(input);
    privateRegularFile(opened);
    if (opened.dev !== previous.dev || opened.ino !== previous.ino || opened.size > MAX_BYTES) {
      throw new Error('Statistics exchange dotenv identity changed or exceeds its byte limit.');
    }
    const contents = readFileSync(input);
    const patched = patchStatisticsExchangeEnv(contents, mode);
    if (patched === contents.toString('utf8')) return;
    temporary = resolve(
      dirname(filename),
      `.${basename(filename)}.statistics-exchange-${randomUUID()}`,
    );
    output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    fchownSync(output, previous.uid, previous.gid);
    fchmodSync(output, previous.mode & 0o777);
    writeFileSync(output, patched);
    fsyncSync(output);
    closeSync(output);
    output = undefined;
    const current = lstatSync(filename);
    privateRegularFile(current);
    if (
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size ||
      current.mtimeMs !== opened.mtimeMs ||
      current.ctimeMs !== opened.ctimeMs ||
      !readFileSync(filename).equals(contents)
    )
      throw new Error('Statistics exchange dotenv changed before atomic replacement.');
    renameSync(temporary, filename);
    temporary = undefined;
    const directory = openSync(dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
    if (temporary !== undefined) rmSync(temporary, { force: true });
  }
}

export function verifyStatisticsExchangeRuntimeEnv(value, mode) {
  targetMode(mode);
  if (!Array.isArray(value))
    throw new Error('Statistics exchange runtime environment is unavailable.');
  const matches = value.filter((entry) => typeof entry === 'string' && entry.startsWith(`${KEY}=`));
  if (matches.length !== 1 || matches[0] !== `${KEY}=${mode}`) {
    throw new Error('Statistics exchange runtime mode does not match the requested deploy mode.');
  }
}

export function verifyStatisticsExchangeCompose(config, mode, services) {
  targetMode(mode);
  if (services.length !== 14 || new Set(services).size !== 14) {
    throw new Error('Statistics exchange Compose verification requires the complete API topology.');
  }
  for (const service of services) {
    if (config?.services?.[service]?.environment?.[KEY] !== mode) {
      throw new Error('Statistics exchange Compose mode does not match the requested deploy mode.');
    }
  }
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'read-env' && args.length === 1) {
    process.stdout.write(`${readStatisticsExchangeEnv(readFileSync(args[0]))}\n`);
  } else if (command === 'patch-env' && args.length === 2) {
    patchStatisticsExchangeEnvFile(args[0], args[1]);
  } else if (command === 'verify-runtime-env' && args.length === 1) {
    verifyStatisticsExchangeRuntimeEnv(JSON.parse(readFileSync(0).toString('utf8')), args[0]);
  } else if (command === 'verify-compose' && args.length === 15) {
    verifyStatisticsExchangeCompose(
      JSON.parse(readFileSync(0).toString('utf8')),
      args[0],
      args.slice(1),
    );
  } else throw new Error('Invalid statistics-exchange deploy state command.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    process.stderr.write('Statistics exchange deploy environment verification failed.\n');
    process.exitCode = 1;
  }
}
