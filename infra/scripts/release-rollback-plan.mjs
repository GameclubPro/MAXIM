#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import {
  ACTIVE_RELEASE_COMPONENTS,
  readReleaseManifest,
  validateManifest,
} from './release-manifest.mjs';

export const PRODUCTION_API_SERVICES = Object.freeze([
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
]);

export const ROLLBACK_COMPONENT_SERVICES = Object.freeze({
  'api-shared': PRODUCTION_API_SERVICES,
  'miniapp-major-static': Object.freeze(['miniapp-major-static']),
  'admin-static': Object.freeze(['admin-static']),
});

const fullShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const dockerImageIdPattern = /^sha256:[0-9a-f]{64}$/u;
const safeImageRefPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/u;
const digestImageRefPattern = /@sha256:[0-9a-f]{64}$/u;

export function buildRollbackPlan({
  manifest,
  requestedComponents = [],
  now = new Date(),
  pid = process.pid,
}) {
  validateManifest(manifest);
  if (!fullShaPattern.test(manifest.targetSha)) {
    throw new Error('Immutable rollback requires a release with a known full targetSha.');
  }

  const selectedIds = normalizeRequestedComponents(requestedComponents);
  const components = selectedIds.map((id) => {
    const component = manifest.components?.[id];
    if (!component) {
      throw new Error(`Release ${manifest.releaseId} has no ${id} component.`);
    }
    if (!fullShaPattern.test(component.sourceSha)) {
      throw new Error(`${id} cannot be rolled back with unknown sourceSha.`);
    }
    if (!safeImageRefPattern.test(component.imageRef)) {
      throw new Error(`${id} has an unsafe Docker image ref.`);
    }
    if (
      !digestImageRefPattern.test(component.imageRef) &&
      !component.imageRef.endsWith(`:${component.sourceSha}`) &&
      !component.imageRef.endsWith(`:runtime-rollback-${component.sourceSha}`)
    ) {
      throw new Error(`${id} image ref is mutable or does not match sourceSha.`);
    }
    if (!dockerImageIdPattern.test(component.imageId)) {
      throw new Error(`${id} cannot be rolled back with unknown Docker image id.`);
    }
    return Object.freeze({
      id,
      sourceSha: component.sourceSha,
      imageRef: component.imageRef,
      imageId: component.imageId,
      services: ROLLBACK_COMPONENT_SERVICES[id],
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    sourceReleaseId: manifest.releaseId,
    rollbackReleaseId: buildRollbackReleaseId(manifest.targetSha, now, pid),
    targetSha: manifest.targetSha,
    components: Object.freeze(components),
    services: Object.freeze(components.flatMap((component) => component.services)),
  });
}

export function normalizeRequestedComponents(requestedComponents) {
  const requested =
    requestedComponents.length > 0 ? requestedComponents : ACTIVE_RELEASE_COMPONENTS;
  const seen = new Set();
  for (const id of requested) {
    if (!ACTIVE_RELEASE_COMPONENTS.includes(id)) {
      throw new Error(`Unknown rollback component: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate rollback component: ${id}`);
    }
    seen.add(id);
  }
  return ACTIVE_RELEASE_COMPONENTS.filter((id) => seen.has(id));
}

export function buildRollbackReleaseId(targetSha, now = new Date(), pid = process.pid) {
  if (!fullShaPattern.test(targetSha)) {
    throw new Error('Rollback release id requires a full target SHA.');
  }
  const timestamp = now.toISOString().replace(/[-:.]/gu, '');
  const normalizedPid = Number.isSafeInteger(Number(pid)) && Number(pid) >= 0 ? Number(pid) : 0;
  return `rollback-${timestamp}-${targetSha.slice(0, 12)}-${normalizedPid}`;
}

export function renderRollbackPlanTsv(plan) {
  const lines = [
    ['source-release-id', plan.sourceReleaseId],
    ['rollback-release-id', plan.rollbackReleaseId],
    ['target-sha', plan.targetSha],
  ];
  for (const component of plan.components) {
    lines.push([
      'component',
      component.id,
      component.sourceSha,
      component.imageRef,
      component.imageId,
    ]);
  }
  for (const component of plan.components) {
    for (const service of component.services) {
      lines.push(['service', service, component.id]);
    }
  }
  return `${lines.map((fields) => fields.join('\t')).join('\n')}\n`;
}

function runCli(argv) {
  const [releaseId, ...requestedComponents] = argv;
  if (!releaseId) {
    throw new Error(
      'Usage: release-rollback-plan.mjs <release-id> [api-shared] [miniapp-major-static] [admin-static]',
    );
  }
  const stateDir = process.env.MAXIM_RELEASE_STATE_DIR || '/var/lib/maxim-deploy';
  const manifest = readReleaseManifest(stateDir, releaseId);
  const plan = buildRollbackPlan({ manifest, requestedComponents });
  process.stdout.write(renderRollbackPlanTsv(plan));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
