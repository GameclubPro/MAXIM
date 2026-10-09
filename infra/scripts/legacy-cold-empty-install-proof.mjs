import { createHash } from 'node:crypto';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';

export const emptyDigest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const check = (value, code = 'empty_install_abort_unproved') => {
  if (!value) throw Error(code);
};
export const keys = (value, names) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
export function canonicalEmptyDigest(value) {
  const canonical = (x) =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.entries(x)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : x;
  return emptyDigest(canonical(value));
}
const sha = /^[a-f0-9]{64}$/;
const proofNames = [
  'emptyBefore',
  'emptyAfter',
  'stoppedBefore',
  'stoppedAfter',
  'fenceBefore',
  'fenceAfter',
];
export function validateEmptyInstallSidecar(value) {
  check(
    keys(value, [
      'version',
      'operation',
      'protocol',
      'phase',
      'revision',
      'originJournalDigest',
      'originJournal',
      'createdAt',
      'updatedAt',
      'proofs',
      'result',
    ]),
  );
  check(
    value.version === 1 &&
      value.operation === 'abort-empty-install' &&
      value.protocol === 'legacy' &&
      ['EMPTY_INSTALL_ABORTING', 'EMPTY_INSTALL_ABORTED'].includes(value.phase),
  );
  check(
    Number.isSafeInteger(value.revision) &&
      value.revision >= 1 &&
      sha.test(value.originJournalDigest) &&
      emptyDigest(value.originJournal) === value.originJournalDigest &&
      value.originJournal?.phase === 'INSTALLING',
  );
  check(
    [value.createdAt, value.updatedAt].every(
      (x) =>
        typeof x === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
        Number.isFinite(Date.parse(x)),
    ) && value.updatedAt >= value.createdAt,
  );
  check(keys(value.proofs, proofNames));
  for (const name of proofNames)
    check(value.proofs[name] && typeof value.proofs[name] === 'object');
  check(
    value.phase === 'EMPTY_INSTALL_ABORTING'
      ? value.result === null
      : keys(value.result, ['runtimeIdentity', 'nativeIdentity', 'strictSmokes', 'fleetReady']),
  );
  return value;
}

export const EMPTY_ABORT_API_SERVICES = LEGACY_COLD_API_SERVICES;
const natives = ['ocr-native-sandbox', 'photo-native-sandbox'];

const proofFields = [
  'version',
  'state',
  'protocol',
  'certificateId',
  'sourceSha',
  'imageId',
  'attestationDigest',
  'previewSha256',
  'certificateSnapshotSha256',
  'offlineBindingSha256',
  'inventorySha256',
  'inventoryArtifactSha256',
  'selectionSha256',
  'transitionJournalSha256',
  'maintenanceId',
  'queueFenceNonce',
  'readOnly',
  'certificatePreserved',
  'empty',
  'observedAt',
];
const emptyFields = [
  'recoveries',
  'children',
  'authoritiesByCertificate',
  'authoritiesByIdentity',
  'cursors',
  'dispositionsByAuthority',
];
export function bound(value, b) {
  check(
    value?.version === 1 &&
      value.complete === true &&
      value.sourceSha === b.targetSha &&
      value.imageId === b.targetImageId &&
      value.controllerNonce === b.controllerNonce &&
      value.selectionDigest === b.selectionDigest,
  );
  return value;
}
export function stopped(value, b) {
  bound(value, b);
  check(value.unreviewedProducers === 0);
  for (const [field, names] of [
    ['services', EMPTY_ABORT_API_SERVICES],
    ['auxiliaries', natives],
  ])
    check(
      Array.isArray(value[field]) &&
        value[field].length === names.length &&
        names.every(
          (name) =>
            value[field].filter(
              (row) =>
                row.serviceName === name &&
                row.stopped === true &&
                row.exactGeneration === true &&
                row.restartPolicy === 'unless-stopped',
            ).length === 1,
        ),
    );
  return value;
}
export function fence(value, b) {
  bound(value, b);
  check(
    value.queueCount === 24 &&
      value.pausedCount === 24 &&
      value.activeCount === 0 &&
      value.ownerNonce === b.controllerNonce,
  );
  return value;
}
export function buildEmptyInstallWitnessRequest({ bindings: b, selection, pending }) {
  check(
    pending?.version === 1 &&
      pending.complete === true &&
      pending.sourceSha === b.targetSha &&
      pending.imageId === b.targetImageId &&
      pending.controllerNonce === b.controllerNonce &&
      pending.selectionDigest === b.selectionDigest &&
      pending.unknownSources === 0 &&
      pending.saturated === false,
  );
  const i = pending.inventory,
    x = i?.binding;
  check(
    i?.version === 1 &&
      i.operation === 'inventory_preview' &&
      i.applied === false &&
      i.activationAuthorized === false &&
      i.decision === 'READY_TO_INSTALL' &&
      Array.isArray(i.issues) &&
      i.issues.length === 0 &&
      i.selectionSha256 === canonicalEmptyDigest(selection) &&
      i.previewSha256 === pending.previewDigest &&
      i.inventorySha256 === pending.inventoryDigest &&
      emptyDigest(JSON.stringify(i) + '\n') === pending.inventoryArtifactSha256,
  );
  check(
    x?.sourceSha === b.targetSha &&
      x.imageId === b.targetImageId &&
      x.maintenanceId === b.controllerNonce &&
      x.queueFenceNonce === emptyDigest(b.controllerNonce) &&
      sha.test(x.transitionJournalSha256) &&
      Array.isArray(x.stoppedGenerations) &&
      x.stoppedGenerations.length === 16,
  );
  const names = x.stoppedGenerations.map((row) => row.serviceName);
  check(
    [...EMPTY_ABORT_API_SERVICES, ...natives].every(
      (name) => names.filter((n) => n === name).length === 1,
    ),
  );
  const attestation = {
    version: 1,
    sourceSha: x.sourceSha,
    imageId: x.imageId,
    transitionJournalSha256: x.transitionJournalSha256,
    previewSha256: pending.previewDigest,
    queueFenceNonce: x.queueFenceNonce,
    roleSnapshots: x.stoppedGenerations
      .filter((row) => EMPTY_ABORT_API_SERVICES.includes(row.serviceName))
      .map((row) => ({ ...row })),
    maintenanceId: x.maintenanceId,
    offlineBindingSha256: canonicalEmptyDigest(x),
    inventorySha256: pending.inventoryDigest,
    inventoryArtifactSha256: pending.inventoryArtifactSha256,
    selectionSha256: canonicalEmptyDigest(selection),
  };
  return {
    version: 1,
    certificateId: b.certificateId,
    sourceSha: b.targetSha,
    imageId: b.targetImageId,
    attestationDigest: canonicalEmptyDigest(attestation),
    previewSha256: pending.previewDigest,
  };
}
export function validateWitness(value, request, pending, selection, b) {
  check(
    keys(value, proofFields) &&
      value.version === 1 &&
      value.state === 'EMPTY_UNSEALED' &&
      value.protocol === 'legacy' &&
      value.readOnly === true &&
      value.certificatePreserved === true,
    'empty_witness_shape_unproved',
  );
  for (const key of ['certificateId', 'sourceSha', 'imageId', 'attestationDigest', 'previewSha256'])
    check(value[key] === request[key], 'empty_witness_binding_unproved');
  check(
    sha.test(value.certificateSnapshotSha256) &&
      (!request.expectedCertificateSnapshotSha256 ||
        value.certificateSnapshotSha256 === request.expectedCertificateSnapshotSha256),
    'empty_certificate_changed',
  );
  check(
    value.offlineBindingSha256 === canonicalEmptyDigest(pending.inventory.binding) &&
      value.inventorySha256 === pending.inventoryDigest &&
      value.inventoryArtifactSha256 === pending.inventoryArtifactSha256 &&
      value.selectionSha256 === canonicalEmptyDigest(selection) &&
      value.transitionJournalSha256 === pending.inventory.binding.transitionJournalSha256 &&
      value.maintenanceId === b.controllerNonce &&
      value.queueFenceNonce === emptyDigest(b.controllerNonce),
    'empty_witness_inventory_unproved',
  );
  check(
    keys(value.empty, emptyFields) &&
      Object.values(value.empty).every((x) => x === true) &&
      typeof value.observedAt === 'string' &&
      Number.isFinite(Date.parse(value.observedAt)),
    'empty_witness_incomplete',
  );
  return value;
}

// FLAG: Counts cannot prove restoration. Bind every generation to the cold
// inventory and keep the native isolation digest unchanged across restart.
export function validateEmptyInstallGenerations(pending, value, b, isStopped, prior) {
  const inventory = pending.inventory.binding.stoppedGenerations;
  const rows = [...(value.services ?? []), ...(value.auxiliaries ?? [])];
  const names = [...EMPTY_ABORT_API_SERVICES, ...natives];
  check(
    rows.length === 16 &&
      inventory.length === 16 &&
      new Set(rows.map((row) => row.containerId)).size === 16 &&
      new Set(inventory.map((row) => row.containerId)).size === 16,
    'closure_generations_unproved',
  );
  for (const name of names) {
    const matches = rows.filter((row) => row.serviceName === name);
    const expected = inventory.filter((row) => row.serviceName === name);
    check(matches.length === 1 && expected.length === 1, 'closure_generations_unproved');
    const row = matches[0],
      original = expected[0];
    check(
      keys(original, ['serviceName', 'containerId', 'imageId', 'sourceSha', 'stopped']) &&
        sha.test(original.containerId) &&
        original.stopped === true &&
        original.imageId === b.targetImageId &&
        original.sourceSha === b.targetSha &&
        row.containerId === original.containerId &&
        row.sourceSha === original.sourceSha &&
        row.imageId === original.imageId &&
        row.stopped === isStopped &&
        row.exactGeneration === true &&
        row.restartPolicy === 'unless-stopped',
      'closure_generation_changed',
    );
    if (natives.includes(name)) {
      check(
        sha.test(row.nativeBoundaryDigest) &&
          (!prior ||
            prior.auxiliaries.find((item) => item.serviceName === name)?.nativeBoundaryDigest ===
              row.nativeBoundaryDigest),
        'closure_native_boundary_changed',
      );
    }
  }
  check(
    Array.isArray(value.services) &&
      value.services.length === 14 &&
      value.services.every((row) => EMPTY_ABORT_API_SERVICES.includes(row.serviceName)) &&
      Array.isArray(value.auxiliaries) &&
      value.auxiliaries.length === 2 &&
      value.auxiliaries.every((row) => natives.includes(row.serviceName)),
    'closure_generation_roles_changed',
  );
}
