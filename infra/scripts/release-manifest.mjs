#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ACTIVE_RELEASE_COMPONENTS = Object.freeze([
  'api-shared',
  'miniapp-major-static',
  'admin-static',
]);
const activeComponentSet = new Set(ACTIVE_RELEASE_COMPONENTS);
const releaseIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const fullShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|unknown)$/u;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readCurrentManifest(stateDir) {
  const path = resolve(stateDir, 'current.json');
  return existsSync(path) ? readJson(path) : null;
}

export function readReleaseManifest(stateDir, releaseId) {
  assertReleaseId(releaseId);
  const path = resolve(stateDir, 'releases', `${releaseId}.json`);
  if (!existsSync(path)) {
    throw new Error(`Release manifest not found: ${releaseId}`);
  }
  return readJson(path);
}

export function buildReleaseManifest({
  releaseId,
  targetSha,
  current = null,
  components,
  migrations = null,
  smokes = [],
  emergencyReason = null,
  createdAt = new Date().toISOString(),
}) {
  assertReleaseId(releaseId);
  if (!fullShaPattern.test(targetSha)) {
    throw new Error('targetSha must be a full lowercase Git object id or unknown.');
  }
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('At least one release component is required.');
  }

  const mergedComponents = { ...(current?.components ?? {}) };
  for (const component of components) {
    validateComponent(component);
    mergedComponents[component.id] = Object.freeze({
      sourceSha: component.sourceSha,
      imageRef: component.imageRef,
      imageId: component.imageId,
      recordedAt: createdAt,
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    releaseId,
    createdAt,
    targetSha,
    emergencyReason: emergencyReason?.trim() || null,
    components: Object.freeze(mergedComponents),
    migrations: Object.freeze([
      ...new Set((migrations ?? current?.migrations ?? []).filter(Boolean)),
    ].sort()),
    smokes: Object.freeze([...new Set(smokes.filter(Boolean))].sort()),
  });
}

export function commitReleaseManifest({ stateDir, manifest, retain = 5 }) {
  validateManifest(manifest);
  mkdirSync(resolve(stateDir, 'releases'), { recursive: true, mode: 0o750 });
  const releasePath = resolve(stateDir, 'releases', `${manifest.releaseId}.json`);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

  if (existsSync(releasePath)) {
    if (readFileSync(releasePath, 'utf8') !== serialized) {
      throw new Error(`Release id already exists with different content: ${manifest.releaseId}`);
    }
  } else {
    writeAtomic(releasePath, serialized);
  }

  writeAtomic(resolve(stateDir, 'current.json'), serialized);
  pruneOldManifests(stateDir, retain, manifest.releaseId);
  return releasePath;
}

export function pruneOldManifests(stateDir, retain = 5, currentReleaseId = null) {
  if (!Number.isSafeInteger(retain) || retain < 5) {
    throw new Error('Release manifest retention must be at least 5.');
  }
  const releasesDir = resolve(stateDir, 'releases');
  if (!existsSync(releasesDir)) {
    return [];
  }
  const entries = readdirSync(releasesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, manifest: readJson(resolve(releasesDir, name)) }))
    .sort((left, right) => {
      const timeOrder = String(right.manifest.createdAt).localeCompare(
        String(left.manifest.createdAt),
      );
      return timeOrder || right.name.localeCompare(left.name);
    });
  const keep = new Set(entries.slice(0, retain).map(({ name }) => name));
  if (currentReleaseId) {
    keep.add(`${currentReleaseId}.json`);
  }
  const removed = [];
  for (const { name } of entries) {
    if (keep.has(name)) {
      continue;
    }
    rmSync(resolve(releasesDir, name));
    removed.push(name);
  }
  return removed;
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) {
    throw new Error('Release manifest schemaVersion must be 1.');
  }
  assertReleaseId(manifest.releaseId);
  if (!fullShaPattern.test(manifest.targetSha)) {
    throw new Error('Release manifest has an invalid targetSha.');
  }
  for (const [id, component] of Object.entries(manifest.components ?? {})) {
    validateComponent({ id, ...component });
  }
}

function validateComponent(component) {
  if (!activeComponentSet.has(component.id)) {
    throw new Error(`Unknown release component: ${component.id}`);
  }
  if (!fullShaPattern.test(component.sourceSha)) {
    throw new Error(`${component.id} sourceSha must be a full Git object id or unknown.`);
  }
  if (typeof component.imageRef !== 'string' || !component.imageRef.trim()) {
    throw new Error(`${component.id} imageRef must be non-empty.`);
  }
  if (
    typeof component.imageId !== 'string' ||
    (!/^sha256:[0-9a-f]{64}$/u.test(component.imageId) && component.imageId !== 'unknown')
  ) {
    throw new Error(`${component.id} imageId must be a Docker sha256 id or unknown.`);
  }
}

function assertReleaseId(releaseId) {
  if (!releaseIdPattern.test(releaseId)) {
    throw new Error(`Invalid release id: ${releaseId}`);
  }
}

function writeAtomic(path, contents) {
  const tempPath = resolve(
    resolve(path, '..'),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tempPath, contents, { mode: 0o640 });
  chmodSync(tempPath, 0o640);
  renameSync(tempPath, path);
}

function parseCli(argv) {
  const command = argv[0];
  const options = { components: [], smokes: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--component') {
      options.components.push(parseComponent(argv[++index]));
    } else if (argument === '--smoke') {
      options.smokes.push(requireValue(argv, ++index, argument));
    } else if (argument.startsWith('--')) {
      const key = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      options[key] = requireValue(argv, ++index, argument);
    } else {
      options.arguments ??= [];
      options.arguments.push(argument);
    }
  }
  return { command, options };
}

function parseComponent(value) {
  const parts = String(value ?? '').split('|');
  if (parts.length !== 4) {
    throw new Error('--component must be id|sourceSha|imageRef|imageId.');
  }
  return { id: parts[0], sourceSha: parts[1], imageRef: parts[2], imageId: parts[3] };
}

function requireValue(argv, index, argument) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${argument} requires a value.`);
  }
  return value;
}

function readLines(path) {
  if (!path) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function runCli(argv) {
  const { command, options } = parseCli(argv);
  const stateDir = resolve(options.stateDir || process.env.MAXIM_RELEASE_STATE_DIR || '/var/lib/maxim-deploy');

  if (command === 'commit' || command === 'inventory') {
    const current = readCurrentManifest(stateDir);
    const manifest = buildReleaseManifest({
      releaseId: options.releaseId,
      targetSha: options.targetSha || (command === 'inventory' ? 'unknown' : null),
      current,
      components: options.components,
      migrations: options.migrationsFile ? readLines(options.migrationsFile) : null,
      smokes: options.smokes,
      emergencyReason: options.emergencyReason,
      createdAt: options.createdAt,
    });
    commitReleaseManifest({
      stateDir,
      manifest,
      retain: Number(options.retain || process.env.MAXIM_RELEASE_RETAIN || 5),
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (command === 'show') {
    const releaseId = options.arguments?.[0] || 'current';
    const manifest =
      releaseId === 'current'
        ? readCurrentManifest(stateDir)
        : readReleaseManifest(stateDir, releaseId);
    if (!manifest) {
      process.exitCode = 3;
      return;
    }
    validateManifest(manifest);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (command === 'field') {
    const [releaseId = 'current', componentId, field] = options.arguments ?? [];
    const manifest =
      releaseId === 'current'
        ? readCurrentManifest(stateDir)
        : readReleaseManifest(stateDir, releaseId);
    const value = manifest?.components?.[componentId]?.[field];
    if (typeof value !== 'string') {
      process.exitCode = 3;
      return;
    }
    process.stdout.write(`${value}\n`);
    return;
  }

  throw new Error('Usage: release-manifest.mjs commit|inventory|show|field [options]');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
