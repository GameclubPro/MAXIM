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
});

function decodeDotenv(contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
  if (bytes.byteLength > MAX_DOTENV_BYTES) {
    throw new Error(`Production dotenv must be at most ${MAX_DOTENV_BYTES} bytes.`);
  }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
  if (command === 'verify-runtime-env' && args.length === 2) {
    const enabled = parseExpectedStateArgument(args[0]);
    const environment = JSON.parse(readFileSync(0, 'utf8'));
    if (!verifyPublisherRuntimeEnvironment(environment, enabled, args[1])) process.exitCode = 1;
    return;
  }
  if (command === 'verify-compose' && args.length === 2) {
    const enabled = parseExpectedStateArgument(args[0]);
    const config = JSON.parse(readFileSync(0, 'utf8'));
    if (!verifyPublisherComposeConfig(config, enabled, args[1])) process.exitCode = 1;
    return;
  }
  throw new Error(
    'Usage: publisher-dispatch-rollout-state.mjs <read-env path|read-env-configured path|patch-env path true|false|verify-runtime-env state service|verify-compose state image>',
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
