import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyCommercialOcrApiContainerInventory } from './commercial-ocr-runtime-inventory.mjs';

export const LEGACY_COLD_API_SERVICES = Object.freeze([
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
  'api-publisher',
  'api-message-retention',
]);
const sha = /^[0-9a-f]{40}$/u;
const image = /^sha256:[0-9a-f]{64}$/u;
const refusalCodes = new Set([
  'cold_activation_disabled',
  'invalid_request',
  'store_access_unavailable',
  'queue_fence_unproved',
  'owner_proof_incomplete',
  'queue_inventory_unproved',
  'queue_catalog_budget_exceeded',
  'child_inventory_incomplete',
  'non_max_work_pending',
  'max_child_unattributed',
  'child_scope_conflict',
  'send_source_unattributed',
  'cross_chat_send_pending',
  'child_identity_conflict',
  'reviewed_preview_changed',
  'cold_install_unproved',
]);
export function readLegacyColdRefusalCode(output) {
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output) > 128 * 1024) return null;
    const result = JSON.parse(output);
    return result?.version === 1 &&
      result.applied === false &&
      result.refused === true &&
      refusalCodes.has(result.code)
      ? result.code
      : null;
  } catch {
    return null;
  }
}
class LegacyColdRefusedError extends Error {
  constructor(code) {
    super('Guarded legacy proof was refused');
    this.code = code;
  }
}
const role = (name) =>
  name.startsWith('api-moderation') || name === 'api-media-analysis' ? 'moderation' : name.slice(4);
function envValue(container, key, fallback) {
  const matches = container.Config?.Env?.filter(
    (entry) => typeof entry === 'string' && entry.startsWith(`${key}=`),
  );
  if (matches?.length === 0 && fallback !== undefined) return fallback;
  if (matches?.length !== 1) throw new Error('Incomplete legacy cold runtime configuration');
  return matches[0].slice(key.length + 1);
}
export function validateLegacyColdInventory(
  containers,
  imageId,
  sourceSha,
  stopped = false,
  original = null,
) {
  if (!image.test(imageId ?? '') || !sha.test(sourceSha ?? ''))
    throw new Error('Invalid legacy cold image identity');
  if (stopped === 'restart' && !original)
    throw new Error('Restart requires original exact compatible generations');
  const inventory = classifyCommercialOcrApiContainerInventory(
    containers,
    LEGACY_COLD_API_SERVICES,
    imageId,
    'infra',
    'ocr-native-sandbox,photo-native-sandbox',
  );
  if (
    inventory.ownedUnreviewedIds.length ||
    inventory.ambiguousIds.length ||
    inventory.reviewedAuxiliaryCount !== 2
  )
    throw new Error('Unreviewed API producer blocks legacy cold recovery');
  return LEGACY_COLD_API_SERVICES.map((serviceName) => {
    const rows = containers.filter(
      (entry) =>
        entry.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
        entry.Config?.Labels?.['com.docker.compose.service'] === serviceName,
    );
    const row = rows[0];
    const prior = original?.find((entry) => entry.serviceName === serviceName);
    if (
      rows.length !== 1 ||
      !/^[0-9a-f]{64}$/u.test(row?.Id ?? '') ||
      row.Image !== imageId ||
      envValue(row, 'APP_SERVICE_NAME') !== serviceName ||
      envValue(row, 'APP_ROLE') !== role(serviceName) ||
      row.Config?.Labels?.['org.opencontainers.image.revision'] !== sourceSha ||
      row.Config?.Image !== `maxim-api:${sourceSha}` ||
      (stopped === 'restart'
        ? !(
            (row.State?.Running === true && row.State?.Status === 'running') ||
            (row.State?.Running === false && row.State?.Status === 'exited')
          )
        : row.State?.Running !== !stopped ||
          row.State?.Status !== (stopped ? 'exited' : 'running')) ||
      row.State?.Paused !== false ||
      row.State?.Restarting !== false ||
      row.State?.Dead !== false ||
      (prior && prior.containerId !== row.Id)
    )
      throw new Error('Legacy cold role generation changed');
    return { serviceName, containerId: row.Id, imageId, sourceSha, stopped: true };
  });
}
export function parseLegacyColdSelection(value) {
  const ownerIds = value?.split(',');
  if (
    !ownerIds?.length ||
    ownerIds.length > 200 ||
    new Set(ownerIds).size !== ownerIds.length ||
    ownerIds.some((id) => !/^[a-zA-Z0-9_-]{1,128}$/u.test(id))
  )
    throw new Error('Invalid finite legacy selection');
  return ownerIds.sort();
}
const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();

export function removeLegacyColdClient(clientId, runDocker = docker) {
  if (!/^[0-9a-f]{64}$/u.test(clientId ?? ''))
    throw new Error('Invalid owned legacy client cleanup');
  try {
    runDocker(['rm', '-f', clientId]);
  } catch {
    // FLAG: An attached-client timeout may leave the writer alive. Auto-removal
    // is accepted only after proving absence; no producer restarts beside it.
    if (runDocker(['ps', '-aq', '--no-trunc', '--filter', `id=${clientId}`]))
      throw new Error('Legacy cold client removal is unproved');
  }
}

// FLAG: Production activation remains quarantined until cold effect quiescence,
// unknown-result recovery and bounded receipt/lag settlement have independent proof.
// Refuse before any Docker or store client; no input or env override can enable it.
export function runLegacyColdRecovery() {
  throw new LegacyColdRefusedError('cold_activation_disabled');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [
    mode,
    sourceSha,
    imageId,
    journalPath,
    ownerToken,
    selection,
    reviewedPreviewSha256,
    separator,
    ...composeArgs
  ] = process.argv.slice(2);
  try {
    if (separator !== '--') throw new Error('Missing structured compose context');
    const result = runLegacyColdRecovery({
      mode,
      sourceSha,
      imageId,
      journalPath,
      ownerToken,
      selection,
      reviewedPreviewSha256: reviewedPreviewSha256 === 'none' ? undefined : reviewedPreviewSha256,
      composeArgs,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof LegacyColdRefusedError ? ` (${error.code})` : '';
    process.stderr.write(
      `Guarded legacy cold operation refused${code}; no ordering completion is claimed.\n`,
    );
    process.exitCode = 1;
  }
}
