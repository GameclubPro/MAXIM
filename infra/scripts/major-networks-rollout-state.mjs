import {
  readFileSync,
  readSync,
  writeFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  linkSync,
  rmSync,
  constants,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PUBLISHER_PRODUCTION_ROLE_BY_SERVICE,
  writeFileAtomic,
} from './publisher-dispatch-rollout-state.mjs';

const KEY = 'MAJOR_NETWORKS_ROLLOUT';
const MODES = new Set(['off', 'test', 'on']);
const requireMode = (mode) => {
  if (!MODES.has(mode)) throw new Error('Major networks mode must be off, test or on.');
  return mode;
};

function inspect(contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
  if (bytes.length > 1024 * 1024) throw new Error('Production dotenv exceeds its byte limit.');
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (decoded.includes('\0')) throw new Error('Production dotenv contains NUL bytes.');
  const lines = decoded.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let quoted = null;
  let assignment;
  for (let index = 0; index < lines.length; index++) {
    const line = index === 0 ? lines[index].replace(/^\uFEFF/u, '') : lines[index];
    let offset = 0;
    if (!quoted) {
      if (/^[ \t]*(?:export[ \t]+)?['"]?MAJOR_NETWORKS_ROLLOUT(?=$|[^A-Za-z0-9_])/u.test(line)) {
        const match =
          /^[ \t]*(?:export[ \t]+)?MAJOR_NETWORKS_ROLLOUT[ \t]*=[ \t]*(off|test|on)[ \t]*\r?\n?$/u.exec(
            line,
          );
        if (!match || assignment)
          throw new Error('Duplicate or malformed Major networks dotenv mode.');
        assignment = { index, mode: match[1] };
      }
      const start = /^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*(['"`])/u.exec(
        line,
      );
      if (!start) continue;
      quoted = start[1];
      offset = start[0].length;
    }
    // FLAG: Key-shaped text within a different quoted value is data, not authority.
    for (; offset < line.length; offset++) {
      if (line[offset] === '\\') offset++;
      else if (line[offset] === quoted) {
        quoted = null;
        break;
      }
    }
  }
  if (quoted) throw new Error('Production dotenv contains an unterminated quoted value.');
  return { decoded, lines, assignment };
}

export function readMajorNetworksEnv(contents) {
  const { assignment } = inspect(contents);
  return { mode: assignment?.mode ?? 'off', configured: Boolean(assignment) };
}

export function patchMajorNetworksEnv(contents, mode) {
  requireMode(mode);
  const state = inspect(contents);
  const replacement = `${KEY}=${mode}`;
  if (state.assignment) {
    const index = state.assignment.index;
    const previous = state.lines[index];
    const bom = index === 0 && previous.startsWith('\uFEFF') ? '\uFEFF' : '';
    const ending = previous.endsWith('\r\n') ? '\r\n' : previous.endsWith('\n') ? '\n' : '';
    state.lines[index] = `${bom}${replacement}${ending}`;
    return state.lines.join('');
  }
  const ending = state.decoded.includes('\r\n') ? '\r\n' : '\n';
  return `${state.decoded}${state.decoded && !state.decoded.endsWith('\n') ? ending : ''}${replacement}${ending}`;
}

export function verifyMajorNetworksEnvironment(environment, mode, service) {
  if (mode !== 'default-off') requireMode(mode);
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment) ||
    !Object.hasOwn(PUBLISHER_PRODUCTION_ROLE_BY_SERVICE, service) ||
    environment.APP_SERVICE_NAME !== service ||
    environment.APP_ROLE !== PUBLISHER_PRODUCTION_ROLE_BY_SERVICE[service]
  )
    throw new Error('Major networks requires the exact reviewed API role.');
  if (mode === 'default-off' ? Object.hasOwn(environment, KEY) : environment[KEY] !== mode)
    throw new Error('Major networks runtime mode differs from production dotenv.');
}

export function verifyMajorNetworksCompose(config, mode, image) {
  if (!/^maxim-api:[a-f0-9]{40}$/u.test(image)) throw new Error('Exact active API image required.');
  for (const service of Object.keys(PUBLISHER_PRODUCTION_ROLE_BY_SERVICE)) {
    if (config?.services?.[service]?.image !== image)
      throw new Error('Major networks Compose image differs from the active release.');
    verifyMajorNetworksEnvironment(config.services[service].environment, mode, service);
  }
}

export function verifyMajorNetworksSource(root) {
  const source = (path) => readFileSync(resolve(root, path), 'utf8');
  if (
    !/MAJOR_NETWORKS_ROLLOUT:\s*z\.enum\(\['off', 'test', 'on'\]\)\.default\('off'\)/u.test(
      source('apps/api/src/config/env.schema.ts'),
    )
  )
    throw new Error('Installed image source lacks the validated networks rollout.');
  const gate = source('apps/api/src/admin/major-networks-rollout.ts');
  for (const marker of [
    "profile !== 'moderation'",
    "mode === 'on'",
    "mode === 'test'",
    'testUserIds.has',
  ])
    if (!gate.includes(marker))
      throw new Error('Installed networks gate lacks a required boundary.');
  const managed = source('apps/api/src/admin/managed-entities.service.ts');
  for (const marker of [
    'majorNetworksEnabled(',
    'networksEnabled: true',
    'MAJOR_NETWORKS_ROLLOUT',
    'systemAccessConfig.systemAdminUserIds',
  ])
    if (!managed.includes(marker))
      throw new Error('Installed Me response does not consume the networks gate.');
}

function protectedFile(path) {
  const state = lstatSync(path);
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    (state.mode & 0o022) !== 0 ||
    (process.getuid() !== 0 && state.uid !== process.getuid())
  )
    throw new Error('Major networks state requires an operator-owned protected regular file.');
}

function protectedDirectory(path, privateOnly = false) {
  const state = lstatSync(path);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (state.mode & (privateOnly ? 0o077 : 0o022)) !== 0 ||
    (process.getuid() !== 0 && state.uid !== process.getuid())
  )
    throw new Error('Major networks audit requires a protected operator-owned directory.');
}

function syncDirectory(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function startMajorNetworksAudit(
  directory,
  sha,
  from,
  configured,
  to,
  dispatch,
  dispatchConfigured,
  selection,
  selectionConfigured,
  rollup,
  rollupConfigured,
) {
  if (
    !/^[a-f0-9]{40}$/u.test(sha) ||
    !['true', 'false'].includes(configured) ||
    !['true', 'false'].includes(dispatch) ||
    !['true', 'false'].includes(dispatchConfigured) ||
    !['true', 'false'].includes(selectionConfigured) ||
    !['true', 'false'].includes(rollupConfigured) ||
    !['off', 'test', '5', '25', '100'].includes(selection) ||
    !['off', 'test', '5', '25', '100'].includes(rollup)
  )
    throw new Error('Invalid Major networks audit identity.');
  requireMode(from);
  requireMode(to);
  const root = resolve(directory);
  protectedDirectory(root);
  const auditDirectory = resolve(root, 'major-networks-rollouts');
  try {
    mkdirSync(auditDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  protectedDirectory(auditDirectory, true);
  const identity = randomUUID();
  const path = resolve(auditDirectory, `${identity}.json`);
  const temporary = resolve(auditDirectory, `.${identity}.pending`);
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(
        descriptor,
        `${JSON.stringify({
          version: 1,
          kind: 'major-networks-rollout',
          sha,
          from,
          configured: configured === 'true',
          to,
          retained: {
            dispatch: dispatch === 'true',
            dispatchConfigured: dispatchConfigured === 'true',
            selection,
            selectionConfigured: selectionConfigured === 'true',
            rollup,
            rollupConfigured: rollupConfigured === 'true',
          },
          status: 'started',
          startedAt: new Date().toISOString(),
          runtimeVerified: false,
        })}\n`,
      );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    // FLAG: Audit publication never overwrites another operation or grants recovery authority.
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  syncDirectory(auditDirectory);
  syncDirectory(root);
  return path;
}

export function finishMajorNetworksAudit(path, status, exitCode, verified) {
  protectedDirectory(dirname(resolve(path)), true);
  protectedFile(path);
  if (lstatSync(path).size > 4096) throw new Error('Major networks audit exceeds its byte limit.');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (
    record.kind !== 'major-networks-rollout' ||
    record.status !== 'started' ||
    !['completed', 'failed'].includes(status) ||
    !/^(?:0|[1-9][0-9]{0,2})$/u.test(exitCode) ||
    Number(exitCode) > 255 ||
    !['true', 'false'].includes(verified) ||
    (status === 'completed' && (exitCode !== '0' || verified !== 'true'))
  )
    throw new Error('Invalid Major networks audit completion.');
  writeFileAtomic(
    path,
    `${JSON.stringify({ ...record, status, exitCode: Number(exitCode), runtimeVerified: verified === 'true', finishedAt: new Date().toISOString() })}\n`,
  );
}

function main(args) {
  const [command, ...values] = args;
  if (command === 'read-env' && values.length === 1)
    process.stdout.write(`${readMajorNetworksEnv(readFileSync(values[0])).mode}\n`);
  else if (command === 'read-env-configured' && values.length === 1)
    process.stdout.write(`${readMajorNetworksEnv(readFileSync(values[0])).configured}\n`);
  else if (command === 'patch-env' && values.length === 2) {
    protectedFile(values[0]);
    writeFileAtomic(values[0], patchMajorNetworksEnv(readFileSync(values[0]), values[1]));
  } else if (command === 'verify-source' && values.length === 1)
    verifyMajorNetworksSource(values[0]);
  else if (command === 'verify-compose' && values.length === 2)
    verifyMajorNetworksCompose(readMajorNetworksStdinJson(), values[0], values[1]);
  else if (command === 'verify-runtime-env' && values.length === 2)
    verifyMajorNetworksEnvironment(readMajorNetworksStdinJson(64 * 1024), values[0], values[1]);
  else if (command === 'start-audit' && values.length === 11)
    process.stdout.write(`${startMajorNetworksAudit(...values)}\n`);
  else if (command === 'finish-audit' && values.length === 4) finishMajorNetworksAudit(...values);
  else throw new Error('Invalid Major networks rollout command.');
}

export function readMajorNetworksStdinJson(maxBytes = 16 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(16 * 1024);
    const size = readSync(0, chunk, 0, chunk.length, null);
    if (!size) break;
    total += size;
    if (total > maxBytes) throw new Error('Major networks stdin exceeds its byte limit.');
    chunks.push(chunk.subarray(0, size));
  }
  // FLAG: Buffer the bounded pipe before UTF-8 decoding; encoded fd reads are unsafe on Node 24.
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    process.stderr.write('Major networks rollout state verification failed.\n');
    process.exitCode = 1;
  }
}
