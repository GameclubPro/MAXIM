#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_DOTENV_BYTES = 1024 * 1024;
const DISPATCH_KEY = 'MAX_PUBLISHER_DISPATCH_ENABLED';
const SELECTION_KEY = 'PUBLISHER_TEMPORAL_SELECTION_ROLLOUT';
const SELECTION_MODES = new Set(['off', 'test', '5', '25', '100']);

export const PUBLISHER_PRODUCTION_ROLE_BY_SERVICE = Object.freeze({
  'api-ingress': 'ingress',
  'api-admin': 'admin',
  'api-enqueue': 'enqueue',
  'api-moderation': 'moderation',
  'api-moderation-critical': 'moderation',
  'api-moderation-join': 'moderation',
  'api-moderation-realtime-b': 'moderation',
  'api-moderation-realtime-c': 'moderation',
  'api-moderation-realtime-d': 'moderation',
  'api-moderation-background': 'moderation',
  'api-media-analysis': 'moderation',
  'api-action': 'action',
  'api-publisher': 'publisher',
  'api-message-retention': 'message-retention',
});

function decodeDotenv(contents, preserveBom = false) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
  if (bytes.byteLength > MAX_DOTENV_BYTES) {
    throw new Error(`Production dotenv must be at most ${MAX_DOTENV_BYTES} bytes.`);
  }
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBom }).decode(bytes);
  if (decoded.includes('\0')) {
    throw new Error('Production dotenv must not contain NUL bytes.');
  }
  return decoded;
}

function splitLinesPreservingEndings(contents) {
  if (!contents) return [];
  const lines = [];
  let start = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== '\n') continue;
    lines.push(contents.slice(start, index + 1));
    start = index + 1;
  }
  if (start < contents.length) lines.push(contents.slice(start));
  return lines;
}

function parseDispatchAssignment(line) {
  const body = line.endsWith('\n') ? line.slice(0, -1) : line;
  const withoutCr = body.endsWith('\r') ? body.slice(0, -1) : body;
  const match = /^[ \t]*(?:export[ \t]+)?MAX_PUBLISHER_DISPATCH_ENABLED[ \t]*=(.*)$/u.exec(
    withoutCr,
  );
  if (!match) return null;
  const value = match[1].trim();
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${DISPATCH_KEY} must be exactly true or false.`);
  }
  return value === 'true';
}

function inspectPublisherDispatchDotenv(contents) {
  const decoded = decodeDotenv(contents);
  const assignments = splitLinesPreservingEndings(decoded)
    .map(parseDispatchAssignment)
    .filter((value) => value !== null);
  if (assignments.length > 1) {
    throw new Error(`Duplicate dotenv key: ${DISPATCH_KEY}.`);
  }
  return {
    configured: assignments.length === 1,
    enabled: assignments[0] ?? false,
    decoded,
  };
}

export function readPublisherDispatchEnv(contents) {
  const state = inspectPublisherDispatchDotenv(contents);
  return Object.freeze({ configured: state.configured, enabled: state.enabled });
}

export function patchPublisherDispatchEnv(contents, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new Error('Publisher dispatch dotenv patch requires a boolean value.');
  }
  const state = inspectPublisherDispatchDotenv(contents);
  const replacement = `${DISPATCH_KEY}=${enabled ? 'true' : 'false'}`;
  if (!state.configured) {
    if (!state.decoded) return `${replacement}\n`;
    const separator = state.decoded.includes('\r\n') ? '\r\n' : '\n';
    return state.decoded.endsWith('\n')
      ? `${state.decoded}${replacement}${separator}`
      : `${state.decoded}${separator}${replacement}`;
  }

  let replaced = false;
  return splitLinesPreservingEndings(state.decoded)
    .map((line) => {
      if (parseDispatchAssignment(line) === null) return line;
      if (replaced) throw new Error(`Duplicate dotenv key: ${DISPATCH_KEY}.`);
      replaced = true;
      const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
      return `${replacement}${ending}`;
    })
    .join('');
}

function requireSelectionMode(mode, allowDefault = false) {
  if (!SELECTION_MODES.has(mode) && !(allowDefault && mode === 'default-off')) {
    throw new Error('Publisher temporal selection mode must be off, test, 5, 25 or 100.');
  }
  return mode;
}

function parseSelectionAssignment(line) {
  const body = line.replace(/\r?\n$/u, '');
  if (!/^\s*(?:export\s+)?['"]?PUBLISHER_TEMPORAL_SELECTION_ROLLOUT(?=$|[^A-Za-z0-9_])/u.test(body))
    return null;
  const match =
    /^\s*(?:export[ \t]+)?PUBLISHER_TEMPORAL_SELECTION_ROLLOUT[ \t]*=[ \t]*(off|test|5|25|100)[ \t]*$/u.exec(
      body,
    );
  if (!match) throw new Error(`${SELECTION_KEY} must have one exact unquoted mode.`);
  return match[1];
}

function inspectPublisherTemporalSelectionDotenv(contents) {
  const decoded = decodeDotenv(contents, true);
  const assignments = [];
  let quotedValue = null;
  const lines = splitLinesPreservingEndings(decoded);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let offset = 0;
    if (!quotedValue) {
      const mode = parseSelectionAssignment(line);
      if (mode !== null) assignments.push({ mode, index });
      const quotedAssignment =
        /^\s*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*(['"`])/u.exec(line);
      if (!quotedAssignment) continue;
      quotedValue = quotedAssignment[1];
      offset = quotedAssignment[0].length;
    }
    // FLAG: Key-shaped text inside another multiline value is data, never an assignment.
    for (; offset < line.length; offset += 1) {
      if (line[offset] === '\\') offset += 1;
      else if (line[offset] === quotedValue) {
        quotedValue = null;
        break;
      }
    }
  }
  if (quotedValue) throw new Error('Production dotenv contains an unterminated quoted value.');
  if (assignments.length > 1) throw new Error(`Duplicate dotenv key: ${SELECTION_KEY}.`);
  return {
    configured: assignments.length === 1,
    mode: assignments[0]?.mode ?? 'off',
    assignmentIndex: assignments[0]?.index,
    decoded,
  };
}

export function readPublisherTemporalSelectionEnv(contents) {
  const { configured, mode } = inspectPublisherTemporalSelectionDotenv(contents);
  return Object.freeze({ configured, mode });
}

export function patchPublisherTemporalSelectionEnv(contents, mode) {
  requireSelectionMode(mode);
  const state = inspectPublisherTemporalSelectionDotenv(contents);
  const replacement = `${SELECTION_KEY}=${mode}`;
  if (!state.configured) {
    if (!state.decoded) return `${replacement}\n`;
    const separator = state.decoded.includes('\r\n') ? '\r\n' : '\n';
    return state.decoded.endsWith('\n')
      ? `${state.decoded}${replacement}${separator}`
      : `${state.decoded}${separator}${replacement}`;
  }
  return splitLinesPreservingEndings(state.decoded)
    .map((line, index) => {
      if (index !== state.assignmentIndex) return line;
      const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
      const bom = line.startsWith('\uFEFF') ? '\uFEFF' : '';
      return `${bom}${replacement}${ending}`;
    })
    .join('');
}

export function writeFileAtomic(path, contents) {
  const target = resolve(path);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Production dotenv must be a regular non-symlink file.');
  }
  const temporary = resolve(
    dirname(target),
    `.${basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: stat.mode & 0o777 });
    chmodSync(temporary, stat.mode & 0o777);
    const descriptor = openSync(temporary, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
    const directoryDescriptor = openSync(dirname(target), 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function verifyPublisherRuntimeEnvironment(environment, enabled, serviceName) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('Publisher runtime environment must be an object.');
  }
  if (typeof enabled !== 'boolean' && enabled !== 'any' && enabled !== 'default-false') {
    throw new Error('Expected publisher dispatch state is invalid.');
  }
  const expectedRole = PUBLISHER_PRODUCTION_ROLE_BY_SERVICE[serviceName];
  if (!expectedRole) {
    throw new Error('Expected service is outside the reviewed publisher topology.');
  }
  return (
    environment.APP_SERVICE_NAME === serviceName &&
    environment.APP_ROLE === expectedRole &&
    (enabled === 'any'
      ? environment.MAX_PUBLISHER_DISPATCH_ENABLED === undefined ||
        environment.MAX_PUBLISHER_DISPATCH_ENABLED === 'true' ||
        environment.MAX_PUBLISHER_DISPATCH_ENABLED === 'false'
      : enabled === 'default-false'
        ? environment.MAX_PUBLISHER_DISPATCH_ENABLED === undefined ||
          environment.MAX_PUBLISHER_DISPATCH_ENABLED === 'false'
        : environment.MAX_PUBLISHER_DISPATCH_ENABLED === String(enabled))
  );
}

export function verifyPublisherComposeConfig(config, enabled, expectedImageRef) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Publisher Compose config must be an object.');
  }
  if (typeof expectedImageRef !== 'string' || !/^maxim-api:[a-f0-9]{40}$/u.test(expectedImageRef)) {
    throw new Error('Expected publisher rollout image ref is invalid.');
  }
  const services = config.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return false;
  const expectedServices = Object.keys(PUBLISHER_PRODUCTION_ROLE_BY_SERVICE);
  const actualApiServices = Object.keys(services)
    .filter((service) => /^api(?:-|$)/u.test(service))
    .sort();
  if (
    actualApiServices.length !== expectedServices.length ||
    actualApiServices.some((service, index) => service !== [...expectedServices].sort()[index])
  ) {
    return false;
  }
  return expectedServices.every((service) => {
    const definition = services[service];
    return (
      definition?.image === expectedImageRef &&
      verifyPublisherRuntimeEnvironment(definition.environment, enabled, service)
    );
  });
}

export function verifyPublisherTemporalRuntimeEnvironment(environment, expectedMode, serviceName) {
  requireSelectionMode(expectedMode, true);
  // FLAG: Selection controls preference only. Reuse the exact role identity guard without
  // changing or requiring a particular dispatch state; callers check dispatch independently.
  if (!verifyPublisherRuntimeEnvironment(environment, 'any', serviceName)) return false;
  return expectedMode === 'default-off'
    ? environment[SELECTION_KEY] === undefined || environment[SELECTION_KEY] === 'off'
    : environment[SELECTION_KEY] === expectedMode;
}

export function verifyPublisherTemporalComposeConfig(config, expectedMode, expectedImageRef) {
  requireSelectionMode(expectedMode, true);
  if (!verifyPublisherComposeConfig(config, 'any', expectedImageRef)) return false;
  return Object.keys(PUBLISHER_PRODUCTION_ROLE_BY_SERVICE).every((service) =>
    verifyPublisherTemporalRuntimeEnvironment(
      config.services[service].environment,
      expectedMode,
      service,
    ),
  );
}

const SELECTION_SOURCE_PATHS = Object.freeze({
  schema: 'apps/api/src/config/env.schema.ts',
  compose: 'infra/docker-compose.yml',
  runtime: 'apps/api/src/admin/admin.service.legacy.ts',
  enrollment: 'apps/api/src/admin/publisher-publication-temporal-enrollment.ts',
  selection: 'apps/api/src/admin/admin-managed-broadcast-due-selection.ts',
  query: 'apps/api/src/admin/publisher-publication-temporal-selection.ts',
});

function compactSelectionSource(source) {
  if (typeof source !== 'string')
    throw new Error('Publisher temporal selection source is missing.');
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
    .replace(/\s+/gu, '');
}

export function assertPublisherTemporalSelectionSource(sources) {
  const checks = {
    schema: [
      "PUBLISHER_TEMPORAL_SELECTION_ROLLOUT:z.enum(['off','test','5','25','100']).default('off')",
    ],
    runtime: [
      "import{parsePublisherTemporalSelectionRollout}from'./publisher-publication-temporal-enrollment'",
      "get publisherTemporalSelectionRollout(){return parsePublisherTemporalSelectionRollout(owner.configService.get('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT'),);}",
    ],
    enrollment: [
      "const TEST_CHAT_ID='-78271094414679'",
      "const TEST_CHANNEL_ID='-78271171091799'",
      'export function parsePublisherTemporalSelectionRollout(',
      "return value==='test'||value==='5'||value==='25'||value==='100'?value:'off'",
      'export function buildPublisherTemporalEnrollment(',
      "if(mode==='off')return Prisma.sql`FALSE`",
      "mode==='test'",
      'target."target_chat_id"=${TEST_CHAT_ID}',
      'target."target_chat_id"=${TEST_CHANNEL_ID}',
      'buildTestSiblingAudienceProof()',
      'publisher-temporal-v1:',
    ],
    selection: [
      "from'./publisher-publication-temporal-selection'",
      "from'./publisher-publication-temporal-enrollment'",
      'const rollout=this.context.publisherTemporalSelectionRollout',
      'selectPublicationManagedBroadcastDueBatch(this.context.prisma,scheduleModes,limit,dispatchProfile,rollout,)',
      "temporalRollout!=='off'",
      'buildPublisherTemporalExecutionDueQuery({',
      'enrollment:buildPublisherTemporalEnrollment(temporalRollout)',
    ],
    query: ['export function buildPublisherTemporalExecutionDueQuery(', 'temporal_delivery_page'],
  };
  for (const [name, fragments] of Object.entries(checks)) {
    const source = compactSelectionSource(sources?.[name]);
    for (const fragment of fragments) {
      if (!source.includes(compactSelectionSource(fragment))) {
        throw new Error(
          `Publisher temporal selection source guard failed: ${SELECTION_SOURCE_PATHS[name]}.`,
        );
      }
    }
  }
  const compose = sources?.compose;
  if (typeof compose !== 'string')
    throw new Error('Publisher temporal selection Compose source is missing.');
  const publisher = /^ {2}api-publisher:\r?\n(?:(?!^ {2}[A-Za-z0-9_-]+:)[\s\S])*/mu.exec(
    compose,
  )?.[0];
  if (
    !publisher ||
    !/^ {6}PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: \$\{PUBLISHER_TEMPORAL_SELECTION_ROLLOUT:-off\}[ \t]*\r?$/mu.test(
      publisher,
    )
  ) {
    throw new Error(
      'Publisher temporal selection source guard failed: api-publisher Compose environment.',
    );
  }
  return true;
}

function parseBooleanArgument(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Publisher dispatch state must be true or false.');
}

function parseExpectedStateArgument(value) {
  return value === 'any' || value === 'default-false' ? value : parseBooleanArgument(value);
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'read-env' && args.length === 1) {
    const state = readPublisherDispatchEnv(readFileSync(args[0]));
    process.stdout.write(`${state.enabled}\n`);
    return;
  }
  if (command === 'read-env-configured' && args.length === 1) {
    const state = readPublisherDispatchEnv(readFileSync(args[0]));
    process.stdout.write(`${state.configured}\n`);
    return;
  }
  if (command === 'patch-env' && args.length === 2) {
    const enabled = parseBooleanArgument(args[1]);
    const path = resolve(args[0]);
    const patched = patchPublisherDispatchEnv(readFileSync(path), enabled);
    writeFileAtomic(path, patched);
    return;
  }
  if (command === 'verify-runtime-env' && (args.length === 2 || args.length === 3)) {
    const enabled = parseExpectedStateArgument(args[0]);
    const environment = JSON.parse(readFileSync(0).toString('utf8'));
    const selectionMatches =
      args.length === 2 || verifyPublisherTemporalRuntimeEnvironment(environment, args[2], args[1]);
    if (!verifyPublisherRuntimeEnvironment(environment, enabled, args[1]) || !selectionMatches)
      process.exitCode = 1;
    return;
  }
  if (command === 'verify-compose' && (args.length === 2 || args.length === 3)) {
    const enabled = parseExpectedStateArgument(args[0]);
    const config = JSON.parse(readFileSync(0).toString('utf8'));
    const selectionMatches =
      args.length === 2 || verifyPublisherTemporalComposeConfig(config, args[2], args[1]);
    if (!verifyPublisherComposeConfig(config, enabled, args[1]) || !selectionMatches)
      process.exitCode = 1;
    return;
  }
  if (
    (command === 'read-selection-env' || command === 'read-selection-env-configured') &&
    args.length === 1
  ) {
    const state = readPublisherTemporalSelectionEnv(readFileSync(args[0]));
    process.stdout.write(`${command === 'read-selection-env' ? state.mode : state.configured}\n`);
    return;
  }
  if (command === 'patch-selection-env' && args.length === 2) {
    const path = resolve(args[0]);
    const patched = patchPublisherTemporalSelectionEnv(readFileSync(path), args[1]);
    writeFileAtomic(path, patched);
    return;
  }
  if (command === 'verify-selection-runtime-env' && args.length === 2) {
    const environment = JSON.parse(readFileSync(0).toString('utf8'));
    if (!verifyPublisherTemporalRuntimeEnvironment(environment, args[0], args[1]))
      process.exitCode = 1;
    return;
  }
  if (command === 'verify-selection-compose' && args.length === 2) {
    const config = JSON.parse(readFileSync(0).toString('utf8'));
    if (!verifyPublisherTemporalComposeConfig(config, args[0], args[1])) process.exitCode = 1;
    return;
  }
  if (command === 'verify-selection-source' && args.length === 1) {
    assertPublisherTemporalSelectionSource(
      Object.fromEntries(
        Object.entries(SELECTION_SOURCE_PATHS).map(([name, path]) => [
          name,
          readFileSync(resolve(args[0], path), 'utf8'),
        ]),
      ),
    );
    return;
  }
  throw new Error(
    'Usage: publisher-dispatch-rollout-state.mjs <read-env path|read-env-configured path|patch-env path true|false|verify-runtime-env state service [selection-mode]|verify-compose state image [selection-mode]|read-selection-env path|read-selection-env-configured path|patch-selection-env path mode|verify-selection-runtime-env mode service|verify-selection-compose mode image|verify-selection-source root>',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
