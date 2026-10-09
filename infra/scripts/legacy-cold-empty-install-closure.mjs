import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  emptyDigest as digest,
  canonicalEmptyDigest as canonical,
  check,
  keys,
  validateEmptyInstallSidecar,
  buildEmptyInstallWitnessRequest,
  validateWitness,
  stopped,
  fence,
  bound,
  validateEmptyInstallGenerations,
} from './legacy-cold-empty-install-proof.mjs';

const ARCHIVES = 'empty-install-closure-archives';
const hash = /^[a-f0-9]{64}$/;
function safeDirectory(path, privateMode = true) {
  const s = lstatSync(path);
  check(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      [0, process.getuid()].includes(s.uid) &&
      (privateMode ? (s.mode & 0o777) === 0o700 : (s.mode & 0o022) === 0),
    'closure_directory_unproved',
  );
}
function read(path, cap = 8 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    check(
      s.isFile() &&
        s.nlink === 1 &&
        [0, process.getuid()].includes(s.uid) &&
        (s.mode & 0o777) === 0o600 &&
        s.size <= cap,
      'closure_file_unproved',
    );
    const bytes = readFileSync(fd);
    check(bytes.length === s.size, 'closure_file_changed');
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function assertNoInterruptedEmptyInstallArchive(directory) {
  try {
    safeDirectory(join(directory, ARCHIVES));
    check(
      !readdirSync(join(directory, ARCHIVES)).some((n) => n.startsWith('.')),
      'closure_archive_interrupted',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// FLAG: A closure proves an empty UNSEALED installation and the exact restored
// generations. It never changes the truthful original INSTALLING journal.
export function readEmptyInstallClosure(directory, state) {
  safeDirectory(directory, false);
  assertNoInterruptedEmptyInstallArchive(directory);
  const j = state.journal,
    b = j?.bindings;
  if (!j) return null;
  const privateRoot = join(directory, 'legacy-cold-private');
  const operationDir = join(privateRoot, b.controllerNonce);
  let sidecarRaw;
  try {
    safeDirectory(privateRoot);
    safeDirectory(operationDir);
    check(
      !readdirSync(operationDir).some((n) => n.startsWith('.empty-install-abort')),
      'closure_sidecar_interrupted',
    );
    sidecarRaw = read(join(operationDir, 'empty-install-abort.json'), 2 * 1024 * 1024);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const sidecar = validateEmptyInstallSidecar(JSON.parse(sidecarRaw));
  const originJournalDigest = digest(j),
    sidecarDigest = digest(sidecar);
  check(
    j.phase === 'INSTALLING' &&
      sidecar.originJournalDigest === originJournalDigest &&
      canonical(sidecar.originJournal) === canonical(j) &&
      state.marker?.epoch === b.epoch &&
      state.marker.clusterIdentity === b.clusterIdentity &&
      state.marker.admissionDigest === j.proofs.hostAdmission,
    'closure_origin_unproved',
  );
  check(
    [
      'sealedReadback',
      'releaseManifest',
      'runtimeIdentity',
      'nativeIdentity',
      'strictSmokes',
      'abortOrigin',
      'abortAbsence',
    ].every((n) => !j.proofs[n]),
    'closure_origin_effect_proof_changed',
  );
  const contextRaw = read(join(operationDir, 'context.json'), 65536),
    context = JSON.parse(contextRaw);
  check(
    [undefined, 'legacy'].includes(context.protocol) &&
      keys(context.selection, ['ownerWebhookEventIds', 'majorBotIds']) &&
      digest(context.selection) === b.selectionDigest,
    'closure_context_unproved',
  );
  const evidenceDir = join(directory, 'legacy-cold-evidence');
  safeDirectory(evidenceDir);
  const proofs = Object.entries(j.proofs).map(([name, sha256]) => {
    check(hash.test(sha256), 'closure_proof_hash_unproved');
    const raw = read(join(evidenceDir, sha256 + '.json'));
    check(digest(raw) === sha256, 'closure_proof_changed');
    return { name, sha256, raw };
  });
  const pending = JSON.parse(proofs.find((p) => p.name === 'pendingInventory')?.raw ?? 'null');
  const request = buildEmptyInstallWitnessRequest({
    bindings: b,
    selection: context.selection,
    pending,
  });
  validateWitness(sidecar.proofs.emptyBefore, request, pending, context.selection, b);
  validateWitness(
    sidecar.proofs.emptyAfter,
    {
      ...request,
      expectedCertificateSnapshotSha256: sidecar.proofs.emptyBefore.certificateSnapshotSha256,
    },
    pending,
    context.selection,
    b,
  );
  for (const n of ['stoppedBefore', 'stoppedAfter']) stopped(sidecar.proofs[n], b);
  for (const n of ['fenceBefore', 'fenceAfter']) fence(sidecar.proofs[n], b);
  check(
    canonical(sidecar.proofs.stoppedBefore) === canonical(sidecar.proofs.stoppedAfter) &&
      canonical(sidecar.proofs.fenceBefore) === canonical(sidecar.proofs.fenceAfter),
    'closure_containment_changed',
  );
  validateEmptyInstallGenerations(pending, sidecar.proofs.stoppedBefore, b, true);
  check(
    sidecar.proofs.emptyBefore.observedAt <= sidecar.proofs.emptyAfter.observedAt &&
      sidecar.proofs.emptyAfter.observedAt <= sidecar.updatedAt,
    'closure_witness_time_unproved',
  );
  if (sidecar.phase === 'EMPTY_INSTALL_ABORTED') {
    const { runtimeIdentity, nativeIdentity, strictSmokes, fleetReady } = sidecar.result;
    bound(runtimeIdentity, b);
    bound(nativeIdentity, b);
    bound(strictSmokes, b);
    check(
      runtimeIdentity.exactGenerationCount === 14 &&
        runtimeIdentity.unreviewedProducers === 0 &&
        nativeIdentity.exactGenerationCount === 2,
      'closure_restart_unproved',
    );
    validateEmptyInstallGenerations(
      pending,
      runtimeIdentity,
      b,
      false,
      sidecar.proofs.stoppedBefore,
    );
    const ready =
      strictSmokes.ingressReady === true &&
      strictSmokes.adminReady === true &&
      strictSmokes.actionableLagSeconds <= 10;
    check(
      fleetReady === ready &&
        (ready ||
          (strictSmokes.dependenciesReady === true && strictSmokes.queueBacklogOnly === true)) &&
        strictSmokes.queuesResumed === true &&
        Number.isFinite(strictSmokes.actionableLagSeconds) &&
        strictSmokes.actionableLagSeconds >= 0,
      'closure_smokes_unproved',
    );
  }
  const journalRaw = read(join(directory, 'legacy-cold-maintenance.json'));
  const markerRaw = read(join(directory, 'legacy-cold-identity.json'));
  check(
    digest(JSON.parse(journalRaw)) === originJournalDigest &&
      canonical(JSON.parse(markerRaw)) === canonical(state.marker),
    'closure_original_changed',
  );
  return {
    metadata: { version: 1, phase: sidecar.phase, sidecarDigest, originJournalDigest },
    original: { journalRaw, markerRaw, sidecarRaw, contextRaw, proofs },
    finishedAt: sidecar.updatedAt,
  };
}

// FLAG: Preserve every original byte durably before stock admission changes the
// monotonic marker. Pending writes remain visible and refuse further mutations.
export function archiveEmptyInstallClosure({
  directory,
  state,
  bindings,
  hostAdmissionDigest,
  assertLock,
}) {
  assertLock();
  const receipt = readEmptyInstallClosure(directory, state),
    old = state.journal.bindings;
  check(receipt?.metadata.phase === 'EMPTY_INSTALL_ABORTED', 'closure_success_unproved');
  check(
    bindings.clusterIdentity === old.clusterIdentity &&
      bindings.epoch === old.epoch + 1 &&
      bindings.controllerNonce !== old.controllerNonce &&
      bindings.certificateId !== old.certificateId,
    'closure_new_bindings_unproved',
  );
  check(hash.test(hostAdmissionDigest), 'closure_host_admission_unproved');
  const admissionRaw = read(join(directory, 'legacy-cold-evidence', hostAdmissionDigest + '.json'));
  check(
    digest(admissionRaw) === hostAdmissionDigest &&
      digest(JSON.parse(admissionRaw)) === bindings.baselineDigest,
    'closure_host_admission_changed',
  );
  const archive = {
    version: 1,
    operation: 'archive-empty-install-before-next-admission',
    ...receipt.metadata,
    finishedAt: receipt.finishedAt,
    original: receipt.original,
    next: { bindings, hostAdmissionDigest, hostAdmissionRaw: admissionRaw },
  };
  const raw = JSON.stringify(archive) + '\n';
  check(Buffer.byteLength(raw) <= 48 * 1024 * 1024, 'closure_archive_budget');
  const archiveDigest = digest(raw),
    archiveDir = join(directory, ARCHIVES),
    target = join(archiveDir, archiveDigest + '.json');
  try {
    mkdirSync(archiveDir, { mode: 0o700 });
    syncDirectory(directory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  safeDirectory(archiveDir);
  assertNoInterruptedEmptyInstallArchive(directory);
  try {
    check(read(target, 48 * 1024 * 1024) === raw, 'closure_archive_conflict');
    syncDirectory(archiveDir);
    return { archiveDigest };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = join(archiveDir, '.' + archiveDigest + '.' + randomUUID() + '.tmp');
  const fd = openSync(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, raw);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  syncDirectory(archiveDir);
  check(read(target, 48 * 1024 * 1024) === raw, 'closure_archive_readback_changed');
  return { archiveDigest };
}
