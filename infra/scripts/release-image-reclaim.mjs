#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateManifest } from './release-manifest.mjs';

const dockerImageIdPattern = /^sha256:[0-9a-f]{64}$/u;
const dockerContainerIdPattern = /^[0-9a-f]{64}$/u;
const fullObjectIdSource = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const immutableReleaseRefPattern = new RegExp(
  `^(?:maxim-api:(?:runtime-rollback-)?${fullObjectIdSource}|maxim-miniapp-major:${fullObjectIdSource}|maxim-admin:${fullObjectIdSource}|maxim-miniapp-legacy:${fullObjectIdSource})$`,
  'u',
);
const maxDockerOutputBytes = 64 * 1024 * 1024;
const inspectBatchSize = 100;

export function isImmutableMaximReleaseRef(value) {
  return typeof value === 'string' && immutableReleaseRefPattern.test(value);
}

export function parseReclaimCutoff(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Reclaim cutoff must be a non-empty Docker duration, Unix timestamp, or date.');
  }
  const normalized = value.trim();
  const durationMs = parseGoDurationMs(normalized);
  if (durationMs !== null) {
    if (durationMs <= 0) {
      throw new Error('Reclaim duration must be greater than zero.');
    }
    return now - durationMs;
  }

  if (/^[0-9]+$/u.test(normalized)) {
    const unixSeconds = Number(normalized);
    if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0) {
      throw new Error(`Invalid reclaim Unix timestamp: ${normalized}`);
    }
    return unixSeconds * 1000;
  }

  const parsedDate = Date.parse(normalized);
  if (!Number.isFinite(parsedDate)) {
    throw new Error(`Invalid reclaim cutoff: ${normalized}`);
  }
  return parsedDate;
}

export function readRetainedReleaseImages(stateDir) {
  const resolvedStateDir = resolve(stateDir);
  const currentPath = resolve(resolvedStateDir, 'current.json');
  const releasesDir = resolve(resolvedStateDir, 'releases');

  if (!existsSync(currentPath)) {
    throw new Error(`Current release manifest is missing: ${currentPath}`);
  }
  if (!existsSync(releasesDir) || !statSync(releasesDir).isDirectory()) {
    throw new Error(`Retained release manifest directory is missing: ${releasesDir}`);
  }

  const releasePaths = readdirSync(releasesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => resolve(releasesDir, name));
  if (releasePaths.length === 0) {
    throw new Error(`No retained release manifests were found in ${releasesDir}`);
  }

  const imageIds = new Set();
  const imageRefs = new Set();
  const manifestPaths = [currentPath, ...releasePaths];
  for (const manifestPath of manifestPaths) {
    const manifest = readValidatedManifest(manifestPath);
    const components = Object.values(manifest.components ?? {});
    if (components.length === 0) {
      throw new Error(`Retained release manifest has no components: ${manifestPath}`);
    }
    for (const component of components) {
      if (component.imageId !== 'unknown') {
        imageIds.add(component.imageId);
      }
      imageRefs.add(component.imageRef);
    }
  }

  return Object.freeze({
    imageIds: Object.freeze([...imageIds].sort()),
    imageRefs: Object.freeze([...imageRefs].sort()),
    manifestPaths: Object.freeze(manifestPaths),
  });
}

export function buildReleaseImageReclaimPlan({
  images,
  retainedImageIds,
  retainedImageRefs,
  containerImageIds,
  cutoffMs,
}) {
  if (!Number.isFinite(cutoffMs)) {
    throw new Error('A finite reclaim cutoff is required.');
  }
  const retainedIds = new Set(retainedImageIds);
  const retainedRefs = new Set(retainedImageRefs);
  const usedIds = new Set(containerImageIds);
  const candidates = [];

  for (const rawImage of images) {
    const image = normalizeDockerImage(rawImage);
    if (retainedIds.has(image.id) || usedIds.has(image.id) || image.createdAtMs >= cutoffMs) {
      continue;
    }
    if (image.repoTags.some((ref) => retainedRefs.has(ref))) {
      continue;
    }

    const releaseRefs = image.repoTags.filter(isImmutableMaximReleaseRef);
    if (releaseRefs.length === 0) {
      continue;
    }

    // A shared non-release alias or registry digest makes the image outside this tool's ownership.
    if (releaseRefs.length !== image.repoTags.length || image.repoDigests.length > 0) {
      continue;
    }

    candidates.push(
      Object.freeze({
        id: image.id,
        createdAt: image.createdAt,
        refs: Object.freeze([...releaseRefs].sort()),
      }),
    );
  }

  return Object.freeze(
    candidates.sort(
      (left, right) =>
        String(left.createdAt).localeCompare(String(right.createdAt)) ||
        left.id.localeCompare(right.id),
    ),
  );
}

export function readDockerReclaimInventory(dockerCommand = 'docker') {
  const imageIds = listDockerObjectIds(dockerCommand, 'image', dockerImageIdPattern);
  const containerIds = listDockerObjectIds(dockerCommand, 'container', dockerContainerIdPattern);
  const images = inspectDockerObjects(dockerCommand, 'image', imageIds).map((image) => ({
    id: image.Id,
    createdAt: image.Created,
    repoTags: image.RepoTags ?? [],
    repoDigests: image.RepoDigests ?? [],
  }));
  const containerImageIds = inspectDockerObjects(dockerCommand, 'container', containerIds).map(
    (container) => container.Image,
  );
  for (const imageId of containerImageIds) {
    assertDockerImageId(imageId, 'container image id');
  }
  return Object.freeze({
    images: Object.freeze(images),
    containerImageIds: Object.freeze([...new Set(containerImageIds)].sort()),
  });
}

export function removeReleaseImageCandidates(
  candidates,
  { dockerCommand = 'docker', execute = runDockerMutation } = {},
) {
  for (const candidate of candidates) {
    const image = normalizeDockerImage({
      id: candidate.id,
      createdAt: candidate.createdAt,
      repoTags: candidate.refs,
      repoDigests: [],
    });
    if (image.repoTags.length === 0 || !image.repoTags.every(isImmutableMaximReleaseRef)) {
      throw new Error(`Refusing unsafe release image removal candidate: ${candidate.id}`);
    }
    execute(dockerCommand, ['image', 'rm', ...image.repoTags]);
  }
}

function readValidatedManifest(path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
    validateManifest(manifest);
  } catch (error) {
    throw new Error(`Invalid retained release manifest ${path}: ${error.message}`, {
      cause: error,
    });
  }
  return manifest;
}

function normalizeDockerImage(image) {
  assertDockerImageId(image?.id, 'image id');
  if (typeof image.createdAt !== 'string' || !image.createdAt.trim()) {
    throw new Error(`Docker image ${image.id} has no creation timestamp.`);
  }
  const createdAtMs = Date.parse(image.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw new Error(`Docker image ${image.id} has an invalid creation timestamp.`);
  }
  const repoTags = normalizeStringArray(image.repoTags, `${image.id} RepoTags`);
  const repoDigests = normalizeStringArray(image.repoDigests, `${image.id} RepoDigests`);
  return { id: image.id, createdAt: image.createdAt, createdAtMs, repoTags, repoDigests };
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const normalized = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${label} contains an invalid value.`);
    }
    normalized.push(item.trim());
  }
  return [...new Set(normalized)].sort();
}

function listDockerObjectIds(dockerCommand, kind, pattern) {
  const output = runDockerRead(dockerCommand, [
    kind,
    'ls',
    '--all',
    '--no-trunc',
    '--format',
    '{{json .ID}}',
  ]);
  const ids = parseJsonLines(output, `${kind} ls`);
  for (const id of ids) {
    if (typeof id !== 'string' || !pattern.test(id)) {
      throw new Error(`Docker ${kind} ls returned an invalid id: ${JSON.stringify(id)}`);
    }
  }
  return [...new Set(ids)].sort();
}

function inspectDockerObjects(dockerCommand, kind, ids) {
  const objects = [];
  for (let index = 0; index < ids.length; index += inspectBatchSize) {
    const batch = ids.slice(index, index + inspectBatchSize);
    const output = runDockerRead(dockerCommand, [kind, 'inspect', ...batch]);
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error(`Docker ${kind} inspect returned invalid JSON: ${error.message}`, {
        cause: error,
      });
    }
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw new Error(`Docker ${kind} inspect returned an incomplete inventory.`);
    }
    objects.push(...parsed);
  }
  return objects;
}

function parseJsonLines(output, label) {
  const lines = output.split(/\r?\n/u).filter(Boolean);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Docker ${label} returned invalid JSON: ${error.message}`, { cause: error });
    }
  });
}

function runDockerRead(dockerCommand, args) {
  try {
    return execFileSync(dockerCommand, args, {
      encoding: 'utf8',
      maxBuffer: maxDockerOutputBytes,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim();
    throw new Error(`docker ${args.join(' ')} failed${detail ? `: ${detail}` : '.'}`, {
      cause: error,
    });
  }
}

function runDockerMutation(dockerCommand, args) {
  execFileSync(dockerCommand, args, { stdio: 'inherit' });
}

function assertDockerImageId(value, label) {
  if (typeof value !== 'string' || !dockerImageIdPattern.test(value)) {
    throw new Error(`Invalid Docker ${label}: ${value}`);
  }
}

function parseGoDurationMs(value) {
  const unitMs = {
    ns: 1e-6,
    us: 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  const tokenPattern = /(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)/guy;
  let total = 0;
  let offset = 0;
  let match;
  while ((match = tokenPattern.exec(value))) {
    if (match.index !== offset) {
      return null;
    }
    total += Number(match[1]) * unitMs[match[2]];
    offset = tokenPattern.lastIndex;
  }
  return offset === value.length && offset > 0 && Number.isFinite(total) ? total : null;
}

function parseCli(argv) {
  const [command, ...args] = argv;
  const options = { stateDir: process.env.MAXIM_RELEASE_STATE_DIR || '/var/lib/maxim-deploy' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--state-dir') {
      options.stateDir = requireValue(args, ++index, argument);
    } else if (argument === '--until') {
      options.until = requireValue(args, ++index, argument);
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (command !== 'reclaim' || !options.until) {
    throw new Error(
      'Usage: release-image-reclaim.mjs reclaim --until <duration|timestamp> [--state-dir <path>] [--dry-run]',
    );
  }
  return options;
}

function requireValue(args, index, argument) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${argument} requires a value.`);
  }
  return value;
}

function runCli(argv) {
  const options = parseCli(argv);
  const cutoffMs = parseReclaimCutoff(options.until);
  const retained = readRetainedReleaseImages(options.stateDir);
  const inventory = readDockerReclaimInventory();
  const candidates = buildReleaseImageReclaimPlan({
    images: inventory.images,
    retainedImageIds: retained.imageIds,
    retainedImageRefs: retained.imageRefs,
    containerImageIds: inventory.containerImageIds,
    cutoffMs,
  });

  process.stdout.write(
    `Validated ${retained.manifestPaths.length} current/retained manifests; ` +
      `${retained.imageIds.length} image ids and ${retained.imageRefs.length} refs are protected.\n`,
  );
  if (candidates.length === 0) {
    process.stdout.write('No unused immutable MAXIM release images are eligible for removal.\n');
    return;
  }
  for (const candidate of candidates) {
    process.stdout.write(
      `${options.dryRun ? 'Would remove' : 'Removing'} ${candidate.id}: ${candidate.refs.join(', ')}\n`,
    );
  }
  if (!options.dryRun) {
    removeReleaseImageCandidates(candidates);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
