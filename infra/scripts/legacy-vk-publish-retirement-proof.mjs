import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectLegacyColdGenerations } from './legacy-cold-runtime.mjs';

const root = resolve(import.meta.dirname, '../..');
const retirementFloor = 'a5ef2537ebb96bde30ce30a5c33586d41248d8ca';
const execute = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

// FLAG: Runtime authority comes from the exact reviewed source and all captured
// running generations, not an old release manifest or queue counters alone.
export function captureLegacyVkRetirementProof(run = execute) {
  const sourceSha = run('git', ['rev-parse', 'HEAD']);
  if (
    !/^[0-9a-f]{40}$/u.test(sourceSha) ||
    run('git', ['status', '--porcelain', '--untracked-files=no'])
  )
    throw new Error('clean_exact_retirement_source_required');
  run('git', ['merge-base', '--is-ancestor', retirementFloor, sourceSha]);
  for (const path of [
    'apps/api/src/admin/vk-parsing.queue.ts',
    'apps/api/src/admin/admin.module.ts',
    'apps/api/src/admin/vk-publish.service.ts',
  ]) {
    const source = run('git', ['show', `${sourceSha}:${path}`]);
    if (!source || /\b(?:VK_PARSING_PUBLISH_QUEUE|VkParsingPublishProcessor)\b/u.test(source))
      throw new Error('legacy_producer_source_present');
  }
  if (
    run('git', [
      'ls-tree',
      '-r',
      '--name-only',
      sourceSha,
      'apps/api/src/admin/vk-parsing-publish.processor.ts',
    ])
  )
    throw new Error('legacy_worker_source_present');
  const images = JSON.parse(run('docker', ['image', 'inspect', `maxim-api:${sourceSha}`]));
  if (
    !Array.isArray(images) ||
    images.length !== 1 ||
    !/^sha256:[0-9a-f]{64}$/u.test(images[0]?.Id ?? '') ||
    images[0]?.Config?.Labels?.['org.opencontainers.image.revision'] !== sourceSha
  )
    throw new Error('immutable_retirement_image_required');
  const imageId = images[0].Id;
  const ids = run('docker', ['ps', '-aq', '--no-trunc']).split('\n');
  if (
    !ids.length ||
    ids.length > 256 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[0-9a-f]{64}$/u.test(id))
  )
    throw new Error('retirement_inventory_budget');
  const containers = JSON.parse(run('docker', ['inspect', ...ids]));
  if (
    !Array.isArray(containers) ||
    containers.length !== ids.length ||
    containers.some((row) => !ids.includes(row.Id)) ||
    new Set(containers.map((row) => row.Id)).size !== ids.length
  )
    throw new Error('retirement_inventory_incomplete');
  const snapshot = inspectLegacyColdGenerations(containers, {
    targetSha: sourceSha,
    targetImageId: imageId,
    selectionDigest: 'retired-vk-publish-only',
    controllerNonce: 'readonly-retirement-proof',
  });
  const generations = [...snapshot.services, ...snapshot.auxiliaries].map((generation) => {
    const container = containers.find((row) => row.Id === generation.containerId);
    if (
      !Number.isSafeInteger(container.RestartCount) ||
      container.RestartCount < 0 ||
      typeof container.State.StartedAt !== 'string' ||
      !Number.isFinite(Date.parse(container.State.StartedAt)) ||
      (generation.serviceName.endsWith('-native-sandbox') &&
        container.State.Health?.Status !== 'healthy')
    )
      throw new Error('retirement_generation_unproved');
    return {
      ...generation,
      startedAt: container.State.StartedAt,
      restartCount: container.RestartCount,
    };
  });
  return {
    sourceSha,
    imageId,
    fleetDigest: createHash('sha256').update(JSON.stringify(generations)).digest('hex'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(captureLegacyVkRetirementProof())}\n`);
  } catch {
    process.stderr.write('Exact retired VK source and runtime generation proof failed.\n');
    process.exitCode = 1;
  }
}
