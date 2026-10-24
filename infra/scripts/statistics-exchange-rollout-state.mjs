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
const CENTRAL_ENABLED = 'STATISTICS_CENTRAL_ENABLED';
const CENTRAL_MODE = 'STATISTICS_CENTRAL_MODE';
const CENTRAL_EPOCH = 'STATISTICS_CENTRAL_EXCHANGE_EPOCH';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const exchangeFields = { [KEY]: (value) => MODES.has(value) };
const centralFields = {
  [CENTRAL_ENABLED]: (value) => MODES.has(value),
  [CENTRAL_MODE]: (value) => value === 'LEGACY' || value === 'CENTRAL',
  [CENTRAL_EPOCH]: (value) => UUID.test(value),
};

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

function inspect(contents, fields = exchangeFields) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (bytes.length > MAX_BYTES)
    throw new Error('Statistics exchange dotenv exceeds its byte limit.');
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (decoded.includes('\0')) throw new Error('Statistics exchange dotenv contains NUL bytes.');
  const lines = decoded.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const assignments = new Map();
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
    if (!assignment || !Object.hasOwn(fields, assignment[1])) continue;
    const key = assignment[1];
    const match = /^[ \t]*(?:export[ \t]+)?[\w.-]+[ \t]*=([^\r\n]*)\r?\n?$/u.exec(line);
    const value = match?.[1].trim();
    if (value === undefined || !fields[key](value))
      throw new Error('Malformed statistics dotenv setting.');
    if (assignments.has(key)) throw new Error('Duplicate statistics dotenv setting.');
    assignments.set(key, { index, mode: value });
  }
  if (multilineQuote !== null) throw new Error('Unterminated quoted dotenv value.');
  return { decoded, lines, assignments };
}

export function readStatisticsExchangeEnv(contents) {
  return inspect(contents).assignments.get(KEY)?.mode ?? 'false';
}

function patchSettings(state, settings) {
  const missing = [];
  for (const [key, value] of Object.entries(settings)) {
    const assignment = state.assignments.get(key);
    if (!assignment) {
      missing.push(`${key}=${value}`);
      continue;
    }
    const index = assignment.index;
    const original = state.lines[index];
    const bom = index === 0 && original.startsWith('\uFEFF') ? '\uFEFF' : '';
    const ending = original.endsWith('\r\n') ? '\r\n' : original.endsWith('\n') ? '\n' : '';
    state.lines[index] = `${bom}${key}=${value}${ending}`;
  }
  const updated = state.lines.join('');
  if (!missing.length) return updated;
  const ending = state.decoded.includes('\r\n') ? '\r\n' : '\n';
  return `${updated}${updated && !updated.endsWith('\n') ? ending : ''}${missing.join(ending)}${ending}`;
}

export function patchStatisticsExchangeEnv(contents, mode) {
  targetMode(mode);
  return patchSettings(inspect(contents), { [KEY]: mode });
}

function privateRegularFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
    throw new Error('Statistics exchange dotenv must be a regular, singly linked protected file.');
  }
  if (process.getuid() !== 0 && stat.uid !== process.getuid()) {
    throw new Error('Statistics exchange dotenv must belong to the invoking operator.');
  }
}

function patchEnvFile(path, patch) {
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
    const patched = patch(contents);
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

export function patchStatisticsExchangeEnvFile(path, mode) {
  targetMode(mode);
  patchEnvFile(path, (contents) => patchStatisticsExchangeEnv(contents, mode));
}

export function validateStatisticsCentralEpoch(epoch) {
  if (typeof epoch !== 'string' || !UUID.test(epoch))
    throw new Error('Central statistics activation requires a canonical producer UUID.');
  return epoch;
}

export function readStatisticsCentralEnv(contents) {
  const state = inspect(contents, centralFields);
  const enabled = state.assignments.get(CENTRAL_ENABLED)?.mode ?? 'false';
  const mode = state.assignments.get(CENTRAL_MODE)?.mode ?? 'LEGACY';
  const epoch = state.assignments.get(CENTRAL_EPOCH)?.mode ?? null;
  if ((enabled === 'true') !== (mode === 'CENTRAL') || (enabled === 'true' && !epoch))
    throw new Error('Central statistics dotenv state is inconsistent.');
  return { enabled, mode, epoch };
}

export function patchStatisticsCentralEnv(contents, epoch) {
  validateStatisticsCentralEpoch(epoch);
  const current = readStatisticsCentralEnv(contents);
  // The producer identity is persistent, including after a failed rollout. A retry never rotates it.
  if (current.epoch !== null && current.epoch !== epoch)
    throw new Error('Central statistics producer epoch cannot be replaced.');
  return patchSettings(inspect(contents, centralFields), {
    [CENTRAL_ENABLED]: 'true',
    [CENTRAL_MODE]: 'CENTRAL',
    [CENTRAL_EPOCH]: epoch,
  });
}

export function patchStatisticsCentralEnvFile(path, epoch) {
  validateStatisticsCentralEpoch(epoch);
  patchEnvFile(path, (contents) => patchStatisticsCentralEnv(contents, epoch));
}

export function verifyStatisticsCentralRuntimeEnv(value, epoch) {
  validateStatisticsCentralEpoch(epoch);
  if (!Array.isArray(value)) throw new Error('Central statistics runtime environment is absent.');
  for (const [key, expected] of Object.entries({
    [CENTRAL_ENABLED]: 'true',
    [CENTRAL_MODE]: 'CENTRAL',
    [CENTRAL_EPOCH]: epoch,
  })) {
    const matches = value.filter(
      (entry) => typeof entry === 'string' && entry.startsWith(`${key}=`),
    );
    if (matches.length !== 1 || matches[0] !== `${key}=${expected}`)
      throw new Error('Central statistics runtime setting does not match activation.');
  }
}

export function verifyStatisticsCentralCompose(config, epoch, services) {
  validateStatisticsCentralEpoch(epoch);
  if (services.length !== 14 || new Set(services).size !== 14)
    throw new Error('Central statistics verification requires the complete API topology.');
  for (const service of services) {
    const environment = config?.services?.[service]?.environment;
    verifyStatisticsCentralRuntimeEnv(
      environment && Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      epoch,
    );
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
  } else if (command === 'validate-central-epoch' && args.length === 1) {
    validateStatisticsCentralEpoch(args[0]);
  } else if (command === 'read-central-env' && args.length === 1) {
    process.stdout.write(`${JSON.stringify(readStatisticsCentralEnv(readFileSync(args[0])))}\n`);
  } else if (command === 'patch-central-env' && args.length === 2) {
    patchStatisticsCentralEnvFile(args[0], args[1]);
  } else if (command === 'check-central-env' && args.length === 2) {
    patchStatisticsCentralEnv(readFileSync(args[0]), args[1]);
  } else if (command === 'verify-central-runtime-env' && args.length === 1) {
    verifyStatisticsCentralRuntimeEnv(JSON.parse(readFileSync(0).toString('utf8')), args[0]);
  } else if (command === 'verify-central-compose' && args.length === 15) {
    verifyStatisticsCentralCompose(
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
