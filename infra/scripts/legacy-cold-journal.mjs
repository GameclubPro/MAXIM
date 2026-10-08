import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LEGACY_COLD_STATE_DIR = '/var/lib/maxim-deploy';
export const LEGACY_COLD_JOURNAL = 'legacy-cold-maintenance.json';
export const LEGACY_COLD_MARKER = 'legacy-cold-identity.json';
const digest = /^[0-9a-f]{64}$/u;
const source = /^[0-9a-f]{40}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const image = /^sha256:[0-9a-f]{64}$/u;
const ordinaryPhases = Object.freeze([
  'ADMITTED',
  'STOPPING',
  'STOPPED',
  'INVENTORIED',
  'INSTALLING',
  'SEALED',
  'RESUMING',
  'COMPLETE',
]);
const abortPhases = ['ABORTING', 'ABORTED'];
const phases = [...ordinaryPhases, ...abortPhases];
const preinstallProofNames = [
  'hostAdmission',
  'stoppedInventory',
  'revocation',
  'repausedQueues',
  'restoppedInventory',
];
const abortBeginProofNames = ['abortOrigin', 'abortAbsence', 'stoppedInventory', 'repausedQueues'];
const abortFinishProofNames = ['runtimeIdentity', 'nativeIdentity', 'strictSmokes'];
// FLAG: Keep this bootstrap sentinel self-contained. Abort checks the complete
// service set also enforced by the cold protocol before any generation restarts.
const abortApiServices = [
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
];
const proofNames = new Set([
  'hostAdmission',
  'stoppedInventory',
  'pendingInventory',
  'pendingRecheck',
  'reviewedPreview',
  'sealedReadback',
  'runtimeIdentity',
  'nativeIdentity',
  'strictSmokes',
  'releaseManifest',
  'revocation',
  'repausedQueues',
  'restoppedInventory',
  'supersededPreview',
  'refreezeAbsence',
  'abortOrigin',
  'abortAbsence',
]);
const requiredProofs = {
  ADMITTED: ['hostAdmission'],
  STOPPING: ['hostAdmission'],
  STOPPED: ['stoppedInventory'],
  INVENTORIED: ['pendingInventory', 'reviewedPreview'],
  INSTALLING: ['pendingInventory', 'reviewedPreview'],
  SEALED: ['sealedReadback'],
  RESUMING: ['sealedReadback'],
  COMPLETE: ['runtimeIdentity', 'nativeIdentity', 'strictSmokes'],
  ABORTING: ['hostAdmission', ...abortBeginProofNames],
  ABORTED: ['hostAdmission', ...abortBeginProofNames, ...abortFinishProofNames],
};

export function legacyColdDigest(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function canonicalEvidenceDigest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return legacyColdDigest(canonical(value));
}

function refuse(reason) {
  throw new Error(`Legacy cold maintenance refused: ${reason}`);
}

function keysExactly(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === [...keys].sort().join('|')
  );
}

function validTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateLegacyColdMarker(value) {
  if (
    !keysExactly(value, [
      'version',
      'clusterIdentity',
      'capabilityVersion',
      'createdAt',
      'epoch',
      'admissionDigest',
    ]) ||
    value.version !== 1 ||
    !uuid.test(value.clusterIdentity ?? '') ||
    value.capabilityVersion !== 1 ||
    !validTime(value.createdAt) ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0 ||
    (value.epoch === 0 ? value.admissionDigest !== null : !digest.test(value.admissionDigest ?? ''))
  )
    refuse('invalid sticky host identity');
  return value;
}

export function validateLegacyColdJournal(value) {
  const bindingKeys = [
    'clusterIdentity',
    'epoch',
    'controllerNonce',
    'certificateId',
    'baselineDigest',
    'sourceSha',
    'targetSha',
    'targetImageId',
    'topologyDigest',
    'selectionDigest',
  ];
  if (
    !keysExactly(value, [
      'version',
      'operationId',
      'revision',
      'phase',
      'createdAt',
      'updatedAt',
      'bindings',
      'proofs',
      'blockedReason',
    ]) ||
    value.version !== 1 ||
    !uuid.test(value.operationId ?? '') ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !phases.includes(value.phase) ||
    !validTime(value.createdAt) ||
    !validTime(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    !keysExactly(value.bindings, bindingKeys)
  )
    refuse('invalid durable journal');
  const b = value.bindings;
  if (
    !uuid.test(b.clusterIdentity ?? '') ||
    !Number.isSafeInteger(b.epoch) ||
    b.epoch < 1 ||
    !uuid.test(b.controllerNonce ?? '') ||
    !uuid.test(b.certificateId ?? '') ||
    !digest.test(b.baselineDigest ?? '') ||
    !source.test(b.sourceSha ?? '') ||
    !source.test(b.targetSha ?? '') ||
    !image.test(b.targetImageId ?? '') ||
    !digest.test(b.topologyDigest ?? '') ||
    !digest.test(b.selectionDigest ?? '')
  )
    refuse('invalid immutable binding');
  if (
    !value.proofs ||
    typeof value.proofs !== 'object' ||
    Array.isArray(value.proofs) ||
    Object.entries(value.proofs).some(
      ([name, hash]) => !proofNames.has(name) || !digest.test(hash ?? ''),
    ) ||
    requiredProofs[value.phase].some((name) => !value.proofs[name]) ||
    (value.blockedReason !== null && !/^[a-z][a-z0-9_]{0,79}$/u.test(value.blockedReason ?? '')) ||
    (['COMPLETE', 'ABORTED'].includes(value.phase) && value.blockedReason !== null)
  )
    refuse('missing positive phase proof');
  if (abortPhases.includes(value.phase)) {
    const allowed = [
      ...preinstallProofNames,
      ...abortBeginProofNames,
      ...(value.phase === 'ABORTED' ? abortFinishProofNames : []),
    ];
    if (Object.keys(value.proofs).some((name) => !allowed.includes(name)))
      refuse('abort phase contains installation or release evidence');
  } else if (value.proofs.abortOrigin || value.proofs.abortAbsence) {
    refuse('abort proof outside typed abort phase');
  }
  return value;
}

function validateAbortEvidence(journal, readEvidence) {
  const binding = journal.bindings;
  const bound = (value) =>
    value?.version === 1 &&
    value.complete === true &&
    value.sourceSha === binding.targetSha &&
    value.imageId === binding.targetImageId &&
    value.controllerNonce === binding.controllerNonce &&
    value.selectionDigest === binding.selectionDigest;
  const origin = readEvidence(journal.proofs.abortOrigin);
  if (
    !keysExactly(origin, ['version', 'operation', 'journal', 'journalDigest']) ||
    origin.version !== 1 ||
    origin.operation !== 'abort-before-install' ||
    origin.journalDigest !== legacyColdDigest(origin.journal) ||
    origin.journal?.phase !== 'STOPPED'
  )
    refuse('abort original journal unproved');
  const original = validateLegacyColdJournal(origin.journal);
  if (
    Object.keys(original.proofs).some((name) => !preinstallProofNames.includes(name)) ||
    canonicalEvidenceDigest(original.bindings) !== canonicalEvidenceDigest(binding) ||
    original.operationId !== journal.operationId ||
    original.createdAt !== journal.createdAt ||
    original.revision >= journal.revision ||
    Object.entries(original.proofs).some(([name, hash]) => journal.proofs[name] !== hash)
  )
    refuse('abort original journal binding unproved');
  const absence = readEvidence(journal.proofs.abortAbsence);
  if (
    !keysExactly(absence, [
      'version',
      'operation',
      'complete',
      'sourceSha',
      'imageId',
      'controllerNonce',
      'selectionDigest',
      'certificateId',
      'reads',
    ]) ||
    !bound(absence) ||
    absence.operation !== 'abort-before-install' ||
    absence.certificateId !== binding.certificateId ||
    !Array.isArray(absence.reads) ||
    absence.reads.length !== 2 ||
    absence.reads.some(
      (value) =>
        !keysExactly(value, [
          'version',
          'state',
          'certificateId',
          'sourceSha',
          'imageId',
          'readOnly',
        ]) ||
        value.version !== 1 ||
        value.state !== 'ABSENT' ||
        value.readOnly !== true ||
        value.certificateId !== binding.certificateId ||
        value.sourceSha !== binding.targetSha ||
        value.imageId !== binding.targetImageId,
    )
  )
    refuse('abort positive certificate absence unproved');
  const stopped = readEvidence(journal.proofs.stoppedInventory);
  const exactStopped = (rows, names) =>
    Array.isArray(rows) &&
    rows.length === names.length &&
    names.every(
      (name) =>
        rows.filter(
          (row) =>
            row?.serviceName === name &&
            row.stopped === true &&
            row.exactGeneration === true &&
            row.restartPolicy === 'unless-stopped',
        ).length === 1,
    );
  if (
    !bound(stopped) ||
    stopped.unreviewedProducers !== 0 ||
    !exactStopped(stopped.services, abortApiServices) ||
    !exactStopped(stopped.auxiliaries, ['ocr-native-sandbox', 'photo-native-sandbox'])
  )
    refuse('abort stopped inventory unproved');
  const fence = readEvidence(journal.proofs.repausedQueues);
  if (
    !bound(fence) ||
    fence.queueCount !== 24 ||
    fence.pausedCount !== 24 ||
    fence.activeCount !== 0 ||
    fence.ownerNonce !== binding.controllerNonce
  )
    refuse('abort queue fence unproved');
  if (journal.phase === 'ABORTED') {
    const runtime = readEvidence(journal.proofs.runtimeIdentity);
    const native = readEvidence(journal.proofs.nativeIdentity);
    const smokes = readEvidence(journal.proofs.strictSmokes);
    if (
      !bound(runtime) ||
      runtime.exactGenerationCount !== 14 ||
      runtime.unreviewedProducers !== 0 ||
      !bound(native) ||
      native.exactGenerationCount !== 2
    )
      refuse('abort restarted identity unproved');
    const fleetReady =
      smokes?.ingressReady === true &&
      smokes.adminReady === true &&
      smokes.actionableLagSeconds <= 10;
    if (
      !bound(smokes) ||
      (!fleetReady && !(smokes.dependenciesReady === true && smokes.queueBacklogOnly === true)) ||
      smokes.queuesResumed !== true ||
      !Number.isFinite(smokes.actionableLagSeconds) ||
      smokes.actionableLagSeconds < 0
    )
      refuse('abort strict smokes unproved');
  }
}

function protectedDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || ![0, process.getuid()].includes(stat.uid))
    refuse('unsafe state directory');
  return stat;
}

function readPrivateBytes(directory, name, maximum = 128 * 1024) {
  const path = join(directory, name);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const owner = protectedDirectory(directory).uid;
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > maximum ||
      (stat.mode & 0o777) !== 0o600 ||
      ![0, owner].includes(stat.uid)
    )
      refuse('unsafe private evidence');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readPrivateJson(directory, name, maximum) {
  const bytes = readPrivateBytes(directory, name, maximum);
  return bytes === null ? null : JSON.parse(bytes.toString('utf8'));
}

function readProofEvidence(directory, hash) {
  if (!digest.test(hash ?? '')) refuse('invalid proof digest');
  const bytes = readPrivateBytes(
    join(directory, 'legacy-cold-evidence'),
    `${hash}.json`,
    8 * 1024 * 1024,
  );
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== hash)
    refuse('referenced proof is absent or changed');
  return JSON.parse(bytes.toString('utf8'));
}

// FLAG: The separate monotonic marker is written before admission. Losing the
// journal or crashing between writes cannot reopen ordinary start paths. SQL
// ordering exclusions remain independently bound to immutable permanent holds.
export function readLegacyColdState(directory = LEGACY_COLD_STATE_DIR) {
  protectedDirectory(directory);
  const pendingWrites = readdirSync(directory).filter(
    (name) =>
      name.startsWith(`.${LEGACY_COLD_JOURNAL}.`) || name.startsWith(`.${LEGACY_COLD_MARKER}.`),
  );
  if (pendingWrites.length) refuse('interrupted durable write requires reconciliation');
  const rawMarker = readPrivateJson(directory, LEGACY_COLD_MARKER);
  const rawJournal = readPrivateJson(directory, LEGACY_COLD_JOURNAL);
  const marker = rawMarker === null ? null : validateLegacyColdMarker(rawMarker);
  const journal = rawJournal === null ? null : validateLegacyColdJournal(rawJournal);
  if (journal && (!marker || journal.bindings.clusterIdentity !== marker.clusterIdentity))
    refuse('host identity mismatch');
  if (
    marker?.epoch > 0 &&
    (!journal ||
      journal.bindings.epoch !== marker.epoch ||
      journal.proofs.hostAdmission !== marker.admissionDigest)
  )
    refuse('admitted journal missing or stale');
  if (journal && marker.epoch !== journal.bindings.epoch) refuse('journal epoch mismatch');
  if (journal) {
    const evidenceDirectory = join(directory, 'legacy-cold-evidence');
    protectedDirectory(evidenceDirectory);
    if (readdirSync(evidenceDirectory).some((name) => name.startsWith('.')))
      refuse('interrupted proof write requires reconciliation');
    for (const hash of new Set(Object.values(journal.proofs))) {
      const bytes = readPrivateBytes(evidenceDirectory, `${hash}.json`, 8 * 1024 * 1024);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== hash)
        refuse('referenced proof is absent or changed');
    }
    if (abortPhases.includes(journal.phase))
      validateAbortEvidence(journal, (hash) => readProofEvidence(directory, hash));
  }
  return { marker, journal };
}

export function assertNoActiveLegacyColdMaintenance(directory = LEGACY_COLD_STATE_DIR) {
  const state = readLegacyColdState(directory);
  if (state.journal && !['COMPLETE', 'ABORTED'].includes(state.journal.phase))
    refuse('active cold epoch blocks ordinary mutation');
  return state;
}

export function assertInheritedDeployLock(directory = LEGACY_COLD_STATE_DIR) {
  if (
    directory !== LEGACY_COLD_STATE_DIR ||
    process.env.MAXIM_DEPLOY_LOCK_VERSION !== 'flock-v1' ||
    !/^\d+$/u.test(process.env.MAXIM_DEPLOY_LOCK_FD ?? '')
  )
    refuse('protected deploy lock unavailable');
  const fd = Number(process.env.MAXIM_DEPLOY_LOCK_FD);
  const stat = fstatSync(fd);
  const pathStat = lstatSync(join(directory, 'deploy.lock'));
  const info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
  if (
    !pathStat.isFile() ||
    pathStat.nlink !== 1 ||
    (pathStat.mode & 0o777) !== 0o600 ||
    stat.dev !== pathStat.dev ||
    stat.ino !== pathStat.ino ||
    process.env.MAXIM_DEPLOY_LOCK_IDENTITY !== `${stat.dev}:${stat.ino}` ||
    !/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+\S+\s+0\s+EOF$/mu.test(info)
  )
    refuse('deploy lock identity or ownership unproved');
}

function atomicPrivateWrite(directory, name, value, expectAbsent = false) {
  const target = join(directory, name);
  if (expectAbsent && readPrivateJson(directory, name) !== null)
    refuse('existing evidence cannot be overwritten');
  const temp = join(directory, `.${name}.${randomUUID()}.tmp`);
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  // FLAG: Keep a pre-rename interrupted write visible. Its absence may never
  // convert an uncertain admitted operation into permission to start producers.
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    renameSync(temp, target);
    const directoryFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    closeSync(fd);
  }
}

// The injected lock assertion is for excluded disposable-filesystem tests only.
// The production CLI never accepts a directory, callback or environment bypass.
export function createLegacyColdJournalStore({
  directory = LEGACY_COLD_STATE_DIR,
  assertLock = () => assertInheritedDeployLock(directory),
  now = () => new Date().toISOString(),
} = {}) {
  function mutation() {
    protectedDirectory(directory);
    assertLock();
  }
  return {
    read() {
      return readLegacyColdState(directory);
    },
    readProof(name) {
      const { journal } = readLegacyColdState(directory);
      if (!proofNames.has(name) || !journal?.proofs[name]) refuse('referenced proof unavailable');
      return readPrivateJson(
        join(directory, 'legacy-cold-evidence'),
        `${journal.proofs[name]}.json`,
        8 * 1024 * 1024,
      );
    },
    recordProof(value) {
      mutation();
      const bytes = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) refuse('proof transfer budget exceeded');
      const hash = legacyColdDigest(bytes);
      const evidenceDirectory = join(directory, 'legacy-cold-evidence');
      try {
        mkdirSync(evidenceDirectory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      protectedDirectory(evidenceDirectory);
      const existing = readPrivateBytes(evidenceDirectory, `${hash}.json`, 8 * 1024 * 1024);
      if (existing) {
        if (existing.toString('utf8') !== bytes) refuse('immutable proof conflict');
        return hash;
      }
      atomicPrivateWrite(evidenceDirectory, `${hash}.json`, value, true);
      return hash;
    },
    seed(admission) {
      mutation();
      const state = readLegacyColdState(directory);
      if (
        !admission ||
        admission.version !== 1 ||
        admission.complete !== true ||
        admission.epoch !== 0 ||
        admission.phase !== 'NEVER_ADMITTED' ||
        !uuid.test(admission.clusterIdentity ?? '')
      )
        refuse('positive host admission required');
      if (state.journal) refuse('admitted epoch cannot be reseeded');
      if (state.marker) {
        if (state.marker.clusterIdentity !== admission.clusterIdentity)
          refuse('seed identity changed');
        return state.marker;
      }
      const marker = validateLegacyColdMarker({
        version: 1,
        clusterIdentity: admission.clusterIdentity,
        capabilityVersion: 1,
        createdAt: now(),
        epoch: 0,
        admissionDigest: null,
      });
      atomicPrivateWrite(directory, LEGACY_COLD_MARKER, marker, true);
      return marker;
    },
    admit(bindings, hostAdmissionDigest) {
      mutation();
      const state = assertNoActiveLegacyColdMaintenance(directory);
      if (
        !state.marker ||
        state.marker.clusterIdentity !== bindings.clusterIdentity ||
        bindings.epoch !== state.marker.epoch + 1
      )
        refuse('non-monotonic admission');
      const time = now();
      const journal = validateLegacyColdJournal({
        version: 1,
        operationId: randomUUID(),
        revision: 1,
        phase: 'ADMITTED',
        createdAt: time,
        updatedAt: time,
        bindings,
        proofs: { hostAdmission: hostAdmissionDigest },
        blockedReason: null,
      });
      atomicPrivateWrite(
        directory,
        LEGACY_COLD_MARKER,
        validateLegacyColdMarker({
          ...state.marker,
          epoch: bindings.epoch,
          admissionDigest: hostAdmissionDigest,
        }),
      );
      atomicPrivateWrite(directory, LEGACY_COLD_JOURNAL, journal, state.journal === null);
      return journal;
    },
    advance(expectedDigest, phase, proofs = {}) {
      mutation();
      const { journal } = readLegacyColdState(directory);
      if (
        !journal ||
        legacyColdDigest(journal) !== expectedDigest ||
        journal.blockedReason ||
        !ordinaryPhases.includes(phase) ||
        !ordinaryPhases.includes(journal.phase) ||
        ordinaryPhases.indexOf(phase) !== ordinaryPhases.indexOf(journal.phase) + 1
      )
        refuse('journal phase CAS failed');
      for (const [name, hash] of Object.entries(proofs)) {
        if (journal.proofs[name] && journal.proofs[name] !== hash)
          refuse('immutable proof changed');
      }
      const next = validateLegacyColdJournal({
        ...journal,
        revision: journal.revision + 1,
        phase,
        updatedAt: now(),
        proofs: { ...journal.proofs, ...proofs },
      });
      atomicPrivateWrite(directory, LEGACY_COLD_JOURNAL, next);
      return next;
    },
    reconcileSealed(expectedDigest, proofs) {
      mutation();
      const { journal } = readLegacyColdState(directory);
      if (
        !journal ||
        !['INSTALLING', 'SEALED', 'RESUMING'].includes(journal.phase) ||
        legacyColdDigest(journal) !== expectedDigest ||
        !keysExactly(proofs, ['restoppedInventory', 'repausedQueues', 'sealedReadback'])
      )
        refuse('sealed reconciliation CAS failed');
      for (const [name, hash] of Object.entries(proofs)) {
        if (journal.proofs[name] && journal.proofs[name] !== hash)
          refuse('immutable proof changed');
      }
      // FLAG: Reconciliation cannot install/replay anything. Its caller has
      // independently proven the existing complete seal while producers are off.
      const next = validateLegacyColdJournal({
        ...journal,
        revision: journal.revision + 1,
        phase: 'SEALED',
        updatedAt: now(),
        blockedReason: null,
        proofs: { ...journal.proofs, ...proofs },
      });
      atomicPrivateWrite(directory, LEGACY_COLD_JOURNAL, next);
      return next;
    },
    retryPreinstall(expectedDigest, proofs) {
      mutation();
      const { journal } = readLegacyColdState(directory);
      if (
        !journal ||
        !['ADMITTED', 'STOPPING', 'STOPPED', 'INVENTORIED'].includes(journal.phase) ||
        legacyColdDigest(journal) !== expectedDigest ||
        !keysExactly(proofs, ['stoppedInventory', 'repausedQueues'])
      )
        refuse('preinstall retry CAS failed');
      for (const [name, hash] of Object.entries(proofs)) {
        if (journal.proofs[name] && journal.proofs[name] !== hash)
          refuse('immutable proof changed');
      }
      // FLAG: INSTALLING is persisted before the first SQL writer. This retry
      // cannot cross that boundary, discard its uncertainty or resume producers.
      const next = validateLegacyColdJournal({
        ...journal,
        revision: journal.revision + 1,
        phase: 'STOPPED',
        updatedAt: now(),
        blockedReason: null,
        proofs: { ...journal.proofs, ...proofs },
      });
      atomicPrivateWrite(directory, LEGACY_COLD_JOURNAL, next);
      return next;
    },
    beginAbortPreinstall(expectedDigest, proofs) {
      mutation();
      const { journal } = readLegacyColdState(directory);
      if (
        !journal ||
        !['STOPPED', 'ABORTING'].includes(journal.phase) ||
        legacyColdDigest(journal) !== expectedDigest ||
        !keysExactly(proofs, abortBeginProofNames) ||
        Object.keys(journal.proofs).some(
          (name) =>
            ![
              ...preinstallProofNames,
              ...(journal.phase === 'ABORTING' ? abortBeginProofNames : []),
            ].includes(name),
        )
      )
        refuse('preinstall abort CAS failed');
      for (const [name, hash] of Object.entries(proofs)) {
        if (journal.proofs[name] && journal.proofs[name] !== hash)
          refuse('immutable proof changed');
      }
      const origin = readProofEvidence(directory, proofs.abortOrigin);
      if (
        journal.phase === 'STOPPED' &&
        (origin.journalDigest !== expectedDigest ||
          legacyColdDigest(origin.journal) !== expectedDigest)
      )
        refuse('abort original journal unproved');
      const next = validateLegacyColdJournal({
        ...journal,
        revision: journal.revision + 1,
        phase: 'ABORTING',
        updatedAt: now(),
        blockedReason: null,
        proofs: { ...journal.proofs, ...proofs },
      });
      validateAbortEvidence(next, (hash) => readProofEvidence(directory, hash));
      // FLAG: The complete STOPPED journal and every original evidence file remain
      // immutable. Only this no-install branch may authorize a same-generation restart.
      atomicPrivateWrite(directory, LEGACY_COLD_JOURNAL, next);
      return next;
    },
    finishAbortPreinstall(expectedDigest, proofs) {
      mutation();
      const { journal } = readLegacyColdState(directory);
      if (
        !journal ||
        journal.phase !== 'ABORTING' ||
        journal.blockedReason ||
        legacyColdDigest(journal) !== expectedDigest ||
        !keysExactly(proofs, abortFinishProofNames)
      )
        refuse('preinstall abort finish CAS failed');
      const next = validateLegacyColdJournal({
        ...journal,
        revision: journal.revision + 1,
        phase: 'ABORTED',
        updatedAt: now(),
        blockedReason: null,
        proofs: { ...journal.proofs, ...proofs },
      });
      validateAbortEvidence(next, (hash) => readProofEvidence(directory, hash));
      atomicPrivateWrite(directory, LEGACY_COLD_JOURNAL, next);
      return next;
    },
    refreezePreinstall(expectedDigest, proofs) {
      mutation();
      const { journal } = readLegacyColdState(directory);
      const names = ['supersededPreview', 'refreezeAbsence', 'pendingInventory', 'reviewedPreview'];
      if (
        !journal ||
        !['STOPPED', 'INVENTORIED'].includes(journal.phase) ||
        legacyColdDigest(journal) !== expectedDigest ||
        !journal.proofs.pendingInventory ||
        !journal.proofs.reviewedPreview ||
        [
          'supersededPreview',
          'refreezeAbsence',
          'pendingRecheck',
          'sealedReadback',
          'runtimeIdentity',
          'nativeIdentity',
          'strictSmokes',
          'releaseManifest',
          'restoppedInventory',
        ].some((name) => journal.proofs[name]) ||
        !keysExactly(proofs, names) ||
        Object.values(proofs).some((hash) => !digest.test(hash ?? ''))
      )
        refuse('preinstall refreeze CAS failed');
      const readEvidence = (hash) => {
        const bytes = readPrivateBytes(
          join(directory, 'legacy-cold-evidence'),
          `${hash}.json`,
          8 * 1024 * 1024,
        );
        if (!bytes || legacyColdDigest(bytes.toString('utf8')) !== hash)
          refuse('refreeze proof is absent or changed');
        return JSON.parse(bytes.toString('utf8'));
      };
      const previous = readEvidence(journal.proofs.pendingInventory);
      const previousReview = readEvidence(journal.proofs.reviewedPreview);
      const pending = readEvidence(proofs.pendingInventory);
      const reviewed = readEvidence(proofs.reviewedPreview);
      const history = readEvidence(proofs.supersededPreview);
      const absence = readEvidence(proofs.refreezeAbsence);
      const binding = journal.bindings;
      const validPending = (value) =>
        value?.version === 1 &&
        value.complete === true &&
        value.sourceSha === binding.targetSha &&
        value.imageId === binding.targetImageId &&
        value.controllerNonce === binding.controllerNonce &&
        value.selectionDigest === binding.selectionDigest &&
        value.unknownSources === 0 &&
        value.saturated === false &&
        [value.inventoryDigest, value.previewDigest, value.inventoryArtifactSha256].every((hash) =>
          digest.test(hash ?? ''),
        ) &&
        value.inventory?.inventorySha256 === value.inventoryDigest &&
        value.inventory.previewSha256 === value.previewDigest &&
        digest.test(value.inventory.selectionSha256 ?? '') &&
        value.inventory.binding &&
        typeof value.inventory.binding === 'object' &&
        !Array.isArray(value.inventory.binding) &&
        legacyColdDigest(`${JSON.stringify(value.inventory)}\n`) === value.inventoryArtifactSha256;
      const validReview = (value, inventory) =>
        keysExactly(value, ['version', 'previewDigest', 'inventoryDigest', 'selectionDigest']) &&
        value.version === 1 &&
        value.previewDigest === inventory.previewDigest &&
        value.inventoryDigest === inventory.inventoryDigest &&
        value.selectionDigest === binding.selectionDigest;
      if (
        !validPending(previous) ||
        !validPending(pending) ||
        !validReview(previousReview, previous) ||
        !validReview(reviewed, pending) ||
        pending.previewDigest !== previous.previewDigest ||
        pending.inventory.selectionSha256 !== previous.inventory.selectionSha256 ||
        canonicalEvidenceDigest(pending.inventory.binding) !==
          canonicalEvidenceDigest(previous.inventory.binding) ||
        pending.inventoryArtifactName !== `inventory-${pending.inventoryArtifactSha256}.json`
      )
        refuse('refreeze replacement binding unproved');
      if (
        !keysExactly(history, [
          'version',
          'operation',
          'previousJournal',
          'previousJournalDigest',
          'previousPendingInventory',
          'previousReviewedPreview',
          'previousArtifactSha256',
          'replacementPendingInventory',
          'replacementReviewedPreview',
          'absenceProof',
        ]) ||
        history.version !== 1 ||
        history.operation !== 'refreeze-preview' ||
        history.previousJournalDigest !== expectedDigest ||
        legacyColdDigest(history.previousJournal) !== expectedDigest ||
        history.previousPendingInventory !== journal.proofs.pendingInventory ||
        history.previousReviewedPreview !== journal.proofs.reviewedPreview ||
        history.previousArtifactSha256 !== previous.inventoryArtifactSha256 ||
        history.replacementPendingInventory !== proofs.pendingInventory ||
        history.replacementReviewedPreview !== proofs.reviewedPreview ||
        history.absenceProof !== proofs.refreezeAbsence
      )
        refuse('refreeze superseded review unproved');
      const validReadback = (value) =>
        value?.version === 1 &&
        value.operation === 'readback' &&
        value.state === 'ABSENT' &&
        value.certificateId === binding.certificateId &&
        value.activationAuthorized === false &&
        value.inventorySha256 === previous.inventoryDigest &&
        value.previewSha256 === previous.previewDigest &&
        value.bindingSha256 === canonicalEvidenceDigest(previous.inventory.binding);
      if (
        !keysExactly(absence, [
          'version',
          'operation',
          'certificateId',
          'sourceSha',
          'imageId',
          'controllerNonce',
          'selectionDigest',
          'inventoryDigest',
          'previewDigest',
          'before',
          'after',
        ]) ||
        absence.version !== 1 ||
        absence.operation !== 'refreeze-certificate-absence' ||
        absence.certificateId !== binding.certificateId ||
        absence.sourceSha !== binding.targetSha ||
        absence.imageId !== binding.targetImageId ||
        absence.controllerNonce !== binding.controllerNonce ||
        absence.selectionDigest !== binding.selectionDigest ||
        absence.inventoryDigest !== previous.inventoryDigest ||
        absence.previewDigest !== previous.previewDigest ||
        !validReadback(absence.before) ||
        !validReadback(absence.after)
      )
        refuse('refreeze positive certificate absence unproved');
      // FLAG: Only this typed, one-time pre-install CAS can replace a reviewed
      // preview. The full old journal and immutable proof files remain evidence;
      // both bound ABSENT reads precede a separate review of the new inventory.
      const next = validateLegacyColdJournal({
        ...journal,
        revision: journal.revision + 1,
        phase: 'INVENTORIED',
        updatedAt: now(),
        blockedReason: null,
        proofs: { ...journal.proofs, ...proofs },
      });
      atomicPrivateWrite(directory, LEGACY_COLD_JOURNAL, next);
      return next;
    },
    block(expectedDigest, reason, proofs = {}) {
      mutation();
      const { journal } = readLegacyColdState(directory);
      if (
        !journal ||
        ['COMPLETE', 'ABORTED'].includes(journal.phase) ||
        legacyColdDigest(journal) !== expectedDigest
      )
        refuse('blocked journal CAS failed');
      for (const [name, hash] of Object.entries(proofs)) {
        if (journal.proofs[name] && journal.proofs[name] !== hash)
          refuse('immutable proof changed');
      }
      const next = validateLegacyColdJournal({
        ...journal,
        revision: journal.revision + 1,
        updatedAt: now(),
        blockedReason: reason,
        proofs: { ...journal.proofs, ...proofs },
      });
      atomicPrivateWrite(directory, LEGACY_COLD_JOURNAL, next);
      return next;
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'assert-ordinary-host')
      refuse('invalid command');
    assertNoActiveLegacyColdMaintenance();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
