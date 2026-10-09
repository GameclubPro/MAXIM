import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertInheritedDeployLock,
  assertNoActiveLegacyColdMaintenance,
  readLegacyColdState,
} from './legacy-cold-journal.mjs';
import { createLegacyColdRuntime } from './legacy-cold-runtime.mjs';
import { createLegacyColdClient } from './legacy-cold-client.mjs';
import { readLegacyColdStoreConnection } from './legacy-cold-host.mjs';
import {
  SOURCE_ABANDONMENT_SESSION_DIRECTORY,
  SOURCE_ABANDONMENT_SESSION_LIMITS,
  createSourceAbandonmentSessionStore,
  readSourceAbandonmentSessionState,
  sourceAbandonmentSessionDigest as digest,
  summarizeSourceAbandonmentSession,
  validateSourceAbandonmentSessionManifest,
} from './source-abandonment-session-journal.mjs';
import {
  createSourceAbandonmentSessionHostContext,
  readSourceAbandonmentSessionQueueRegistry,
  sourceAbandonmentSessionHostTopology,
} from './source-abandonment-session-host.mjs';
import {
  SOURCE_ABANDONMENT_COLLECTOR_RESERVATION,
  SOURCE_ABANDONMENT_MATERIALIZATION_RESERVATION,
  applySourceAbandonmentSession,
  finishSourceAbandonmentSession,
  prepareSourceAbandonmentSession,
  reconcileSourceAbandonmentSession,
  sourceAbandonmentSessionRuntimeBindings,
} from './source-abandonment-session-protocol.mjs';
import {
  SOURCE_ABANDONMENT_FROZEN_INVENTORY_LIMITS,
  createSourceAbandonmentSessionFrozenInventory,
  planSourceAbandonmentSessionChildren,
  readSourceAbandonmentSessionEnumeration,
} from './source-abandonment-session-inventory.mjs';
import { parseOrderedAnchorRequest } from './webhook-ordered-anchor-inventory.mjs';
import { createFrozenOrderedAnchorPageReader } from './webhook-frozen-ordered-anchor-inventory-reader.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const hashPattern = /^[a-f0-9]{64}$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const maxInputBytes = 64 * 1024;
const maxPlanBytes = 1024 * 1024;
const diskFloor = 20n * 1024n ** 3n;
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const bytesDigest = (value) => createHash('sha256').update(value).digest('hex');
const requireFact = (condition, code = 'session_controller_refused') => {
  if (!condition) throw new Error(code);
};
const exact = (value, names) => {
  requireFact(value && typeof value === 'object' && !Array.isArray(value));
  requireFact([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  requireFact(keys.length === names.length && keys.every((key) => names.includes(key)));
  requireFact(
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
    }),
  );
};
const privatePath = (path) =>
  requireFact(
    typeof path === 'string' && isAbsolute(path) && !/[\r\n\0,]/u.test(path),
    'session_controller_path_refused',
  );
function privateDirectory(path) {
  privatePath(path);
  const stat = lstatSync(path);
  requireFact(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o777) === 0o700,
    'session_controller_directory_refused',
  );
}
function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function ensurePrivateDirectory(directory) {
  privateDirectory(dirname(directory));
  try {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(dirname(directory));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  privateDirectory(directory);
}
function readPrivate(path, cap = maxPlanBytes) {
  privatePath(path);
  privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireFact(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= cap,
      'session_controller_file_refused',
    );
    const bytes = readFileSync(fd);
    requireFact(bytes.length === stat.size, 'session_controller_file_changed');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function immutable(path, bytes) {
  privateDirectory(dirname(path));
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireFact(
      readPrivate(path, bytes.length).equals(bytes),
      'session_controller_artifact_changed',
    );
    return;
  }
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}
function proofWriter(operationDirectory) {
  const directory = join(operationDirectory, 'admission-proofs');
  ensurePrivateDirectory(directory);
  return (value) => {
    const bytes = encode(value);
    requireFact(
      bytes.length <= SOURCE_ABANDONMENT_SESSION_LIMITS.proofFileBytes,
      'session_controller_proof_budget',
    );
    const reference = bytesDigest(bytes);
    immutable(join(directory, `${reference}.json`), bytes);
    return reference;
  };
}
const execute = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();
function diskGuard() {
  const stat = statfsSync('/var/lib/docker', { bigint: true });
  requireFact(stat.bavail * stat.bsize >= diskFloor, 'session_controller_disk_reserve_required');
}
function controllerIdentity(controllerSha, run) {
  requireFact(
    shaPattern.test(controllerSha ?? '') &&
      run('git', ['rev-parse', 'HEAD']) === controllerSha &&
      run('git', ['status', '--porcelain', '--untracked-files=all']) === '',
    'session_controller_source_changed',
  );
}
function noOtherMaintenance() {
  const previous = readLegacyColdState();
  requireFact(
    !previous.journal ||
      ['COMPLETE', 'ABORTED'].includes(previous.journal.phase) ||
      previous.emptyInstallAbort?.phase === 'EMPTY_INSTALL_ABORTED',
    'session_controller_legacy_maintenance_active',
  );
  requireFact(
    !existsSync('/var/lib/maxim-deploy/queue-predrain-pending.json'),
    'session_controller_predrain_pending',
  );
  return previous;
}

// FLAG: Only a reviewed immutable plan and explicit journal CAS can enter a
// maintenance transition. No caller may choose the global session journal path.
export function parseSourceAbandonmentSessionRequest(input, now = Date.now()) {
  requireFact(
    typeof input === 'string' && Buffer.byteLength(input) <= maxInputBytes,
    'session_controller_input_budget',
  );
  const value = JSON.parse(input);
  if (value?.operation === 'status') {
    exact(value, ['version', 'operation']);
  } else if (value?.operation === 'preview') {
    exact(value, [
      'version',
      'operation',
      'controllerSha',
      'inventoryDirectory',
      'expectedCheckpointSha256',
      'expectedRequest',
      'operationDirectory',
      'queueBundlePath',
      'queueBundleSha256',
      'feasibilityPath',
      'feasibilitySha256',
      'deadlineAtMs',
    ]);
    requireFact(
      shaPattern.test(value.controllerSha) &&
        hashPattern.test(value.expectedCheckpointSha256) &&
        hashPattern.test(value.queueBundleSha256) &&
        hashPattern.test(value.feasibilitySha256),
      'session_controller_identity_required',
    );
    for (const key of [
      'inventoryDirectory',
      'operationDirectory',
      'queueBundlePath',
      'feasibilityPath',
    ])
      privatePath(value[key]);
    parseOrderedAnchorRequest(value.expectedRequest);
    requireFact(
      Number.isSafeInteger(value.deadlineAtMs) &&
        value.deadlineAtMs > now &&
        value.deadlineAtMs <= now + SOURCE_ABANDONMENT_SESSION_LIMITS.durationMs,
      'session_controller_deadline_refused',
    );
  } else {
    requireFact(
      ['run', 'continue', 'reconcile', 'finish', 'abort', 'partial'].includes(value?.operation),
      'session_controller_operation_refused',
    );
    exact(value, [
      'version',
      'operation',
      'planPath',
      'planSha256',
      ...(value.operation === 'run' ? [] : ['expectedJournalDigest']),
    ]);
    privatePath(value.planPath);
    requireFact(
      hashPattern.test(value.planSha256) &&
        (value.operation === 'run' || hashPattern.test(value.expectedJournalDigest)),
      'session_controller_expected_digest_required',
    );
  }
  requireFact(value.version === 1, 'session_controller_version_refused');
  return value;
}

function readFeasibility(path, expectedHash, enumeration) {
  const bytes = readPrivate(path);
  requireFact(bytesDigest(bytes) === expectedHash, 'session_controller_feasibility_changed');
  const value = JSON.parse(bytes);
  exact(value, [
    'version',
    'kind',
    'sourceSha',
    'imageId',
    'enumerationDigest',
    'estimatedColdMs',
    'startupReserveMs',
    'frozenInventoryReservation',
    'maximumChildren',
    'evidenceSha256',
    'measuredPhases',
  ]);
  requireFact(
    value.version === 1 &&
      value.kind === 'source_abandonment_session_feasibility' &&
      value.sourceSha === enumeration.request.sourceSha &&
      value.imageId === enumeration.request.imageId &&
      value.enumerationDigest === enumeration.enumerationDigest &&
      Number.isSafeInteger(value.estimatedColdMs) &&
      Number.isSafeInteger(value.startupReserveMs) &&
      value.startupReserveMs > 0 &&
      value.estimatedColdMs >= value.startupReserveMs &&
      value.estimatedColdMs <= SOURCE_ABANDONMENT_SESSION_LIMITS.durationMs,
    'session_controller_feasibility_refused',
  );
  requireFact(
    Number.isSafeInteger(value.maximumChildren) &&
      value.maximumChildren >= 1 &&
      value.maximumChildren <= SOURCE_ABANDONMENT_SESSION_LIMITS.children,
    'session_controller_child_scope_unproved',
  );
  const reservation = value.frozenInventoryReservation;
  exact(reservation, Object.keys(SOURCE_ABANDONMENT_COLLECTOR_RESERVATION));
  for (const [key, count] of Object.entries(reservation))
    requireFact(
      Number.isSafeInteger(count) &&
        count >= 0 &&
        count <= (SOURCE_ABANDONMENT_FROZEN_INVENTORY_LIMITS[key] ?? 0),
      'session_controller_frozen_budget_refused',
    );
  requireFact(
    reservation.materializationPages === 0 &&
      reservation.inventoryPages >= enumeration.report.pages &&
      reservation.inventoryRows >= enumeration.report.rowObservations &&
      reservation.inventoryProbes >=
        2 * enumeration.report.pages +
          4 * (enumeration.report.rowObservations + enumeration.report.pages - 1) &&
      Number.isSafeInteger(enumeration.journalBytes) &&
      enumeration.journalBytes >= enumeration.report.metadataBytes &&
      reservation.inventoryBytes >= enumeration.journalBytes,
    'session_controller_frozen_budget_refused',
  );
  const measured = value.measuredPhases;
  exact(measured, [
    'preDrainAndStopMs',
    'frozenInventoryMs',
    'childCollectionsMs',
    'installMaterializeMs',
    'finalReadbacksMs',
    'runtimeRestoreAndSmokesMs',
  ]);
  requireFact(
    Object.values(measured).every((duration) => Number.isSafeInteger(duration) && duration >= 0) &&
      measured.runtimeRestoreAndSmokesMs > 0 &&
      Object.values(measured).reduce((sum, duration) => sum + duration, 0) <=
        value.estimatedColdMs &&
      measured.finalReadbacksMs + measured.runtimeRestoreAndSmokesMs <= value.startupReserveMs &&
      Array.isArray(value.evidenceSha256) &&
      value.evidenceSha256.length > 0 &&
      value.evidenceSha256.length <= 64 &&
      value.evidenceSha256.every((reference) => hashPattern.test(reference)),
    'session_controller_measurements_unproved',
  );
  return value;
}

// FLAG: Keep the stock SQL wrapper's cleanup window intact. Refuse another
// command unless its entire existing wall-clock timeout fits before the deadline.
export function createSourceAbandonmentSessionDeadlineRunner({
  deadlineAtMs,
  now = Date.now,
  run = spawnSync,
}) {
  return (command, args, options) => {
    const deadline = typeof deadlineAtMs === 'function' ? deadlineAtMs() : deadlineAtMs;
    requireFact(
      Number.isSafeInteger(deadline) &&
        Number.isSafeInteger(options?.timeout) &&
        options.timeout > 0 &&
        now() + options.timeout <= deadline,
      'session_controller_frozen_deadline',
    );
    return run(command, args, options);
  };
}

function makeBudgets(feasibility, childCount) {
  const budgets = {
    durationMs: SOURCE_ABANDONMENT_SESSION_LIMITS.durationMs,
    proofBytes: SOURCE_ABANDONMENT_SESSION_LIMITS.proofBytes,
  };
  for (const [key, frozen] of Object.entries(feasibility.frozenInventoryReservation)) {
    budgets[key] = Math.max(
      1,
      frozen +
        childCount *
          (2 * SOURCE_ABANDONMENT_COLLECTOR_RESERVATION[key] +
            SOURCE_ABANDONMENT_MATERIALIZATION_RESERVATION[key]),
    );
    requireFact(
      budgets[key] <= SOURCE_ABANDONMENT_SESSION_LIMITS[key],
      'session_controller_aggregate_budget_refused',
    );
  }
  return budgets;
}

function sessionEvidenceFileCount() {
  const directory = join(SOURCE_ABANDONMENT_SESSION_DIRECTORY, 'evidence');
  if (!existsSync(directory)) return 0;
  privateDirectory(directory);
  const names = readdirSync(directory);
  requireFact(
    names.length <= SOURCE_ABANDONMENT_SESSION_LIMITS.proofFiles &&
      names.every((name) => /^[a-f0-9]{64}\.json$/u.test(name)),
    'session_controller_evidence_unproved',
  );
  return names.length;
}

function proofFileBudget(feasibility, planning, existingFiles = 0, proofsImported = false) {
  requireFact(
    Array.isArray(planning.admissionProofs),
    'session_controller_admission_proofs_required',
  );
  // FLAG: A normal child writes fourteen distinct review/attempt/fresh-seal proofs.
  // Reserve thirty-two for its bounded failure/reconciliation path, plus thirty-two
  // parent admission, freeze, restart and containment proofs. Never consume all
  // journal slots during the initial frozen page walk.
  requireFact(
    Number.isSafeInteger(existingFiles) && existingFiles >= 0,
    'session_controller_evidence_unproved',
  );
  const expected =
    existingFiles +
    (proofsImported ? 0 : planning.admissionProofs.length) +
    feasibility.frozenInventoryReservation.inventoryPages +
    32 * planning.children.length +
    32;
  requireFact(
    expected <= SOURCE_ABANDONMENT_SESSION_LIMITS.proofFiles,
    'session_controller_proof_file_budget',
  );
}

async function preview(request, dependencies) {
  const run = dependencies.run ?? execute;
  const now = dependencies.now ?? Date.now;
  (dependencies.assertNoActive ?? assertNoActiveLegacyColdMaintenance)();
  const previous = (dependencies.noOtherMaintenance ?? noOtherMaintenance)();
  controllerIdentity(request.controllerSha, run);
  (dependencies.diskGuard ?? diskGuard)();
  privateDirectory(request.operationDirectory);
  requireFact(
    !existsSync(join(request.operationDirectory, 'plan.json')),
    'session_controller_plan_exists',
  );
  const enumeration = (dependencies.readEnumeration ?? readSourceAbandonmentSessionEnumeration)({
    directory: request.inventoryDirectory,
    expectedCheckpointSha256: request.expectedCheckpointSha256,
    expectedRequest: request.expectedRequest,
  });
  const feasibility = readFeasibility(
    request.feasibilityPath,
    request.feasibilitySha256,
    enumeration,
  );
  const queueBundle = readPrivate(request.queueBundlePath, 16 * 1024 * 1024);
  requireFact(
    bytesDigest(queueBundle) === request.queueBundleSha256,
    'session_controller_queue_bundle_changed',
  );
  const registry = (dependencies.readRegistry ?? readSourceAbandonmentSessionQueueRegistry)(
    enumeration.request.sourceSha,
    run,
  );
  const identity = {
    clusterIdentity: previous.marker?.clusterIdentity ?? randomUUID(),
    epoch: (previous.marker?.epoch ?? 0) + 1,
    controllerNonce: randomUUID(),
    certificateId: randomUUID(),
    baselineDigest: '0'.repeat(64),
    topologyDigest: '0'.repeat(64),
    sourceSha: enumeration.request.sourceSha,
    targetSha: enumeration.request.sourceSha,
    targetImageId: enumeration.request.imageId,
    selectionDigest: enumeration.enumerationDigest,
  };
  const runtime = (dependencies.createRuntime ?? createLegacyColdRuntime)({ bindings: identity });
  const baseline = await runtime.inspectRuntime();
  const connection = (dependencies.readConnection ?? readLegacyColdStoreConnection)(baseline);
  requireFact(
    typeof connection.environment === 'string' &&
      Buffer.byteLength(connection.environment) <= 16 * 1024 &&
      /^DATABASE_URL=\S+\nREDIS_URL=\S+\n$/u.test(connection.environment) &&
      !/[\r\0]/u.test(connection.environment),
    'session_controller_environment_refused',
  );
  const topology = sourceAbandonmentSessionHostTopology({
    baseline,
    ...connection,
    queueBundleSha256: request.queueBundleSha256,
    queueRegistrySha256: registry.queueRegistrySha256,
  });
  const environmentFile = join(request.operationDirectory, 'admission.env');
  immutable(environmentFile, Buffer.from(connection.environment));
  let rawClient;
  let planning;
  try {
    rawClient = (dependencies.createClient ?? createLegacyColdClient)({
      protocol: 'source-abandonment-v1',
      sourceSha: identity.sourceSha,
      imageId: identity.targetImageId,
      networkId: connection.networkId,
      controllerNonce: identity.controllerNonce,
      environmentFile,
      inventoryPath: join(request.operationDirectory, 'admission-inventory.json'),
      run: (args, options = {}) => {
        const timeout = options.timeout ?? 15_000;
        if (['create', 'start'].includes(args[0]))
          requireFact(
            now() + timeout + 30_000 <= request.deadlineAtMs,
            'session_controller_admission_deadline',
          );
        return run('docker', args, { ...options, timeout });
      },
    });
    rawClient.remove();
    planning = await (dependencies.planChildren ?? planSourceAbandonmentSessionChildren)({
      enumeration,
      majorBotIds: connection.majorBotIds,
      queueNames: registry.queueNames,
      publisherBotId: connection.publisherBotId,
      maximumChildren: feasibility.maximumChildren,
      deadlineAtMs: request.deadlineAtMs,
      now,
      collectAdmission: (input) => {
        requireFact(
          now() + 100_000 <= request.deadlineAtMs,
          'session_controller_admission_deadline',
        );
        return rawClient.invoke('admission', input);
      },
      recordProof: proofWriter(request.operationDirectory),
    });
  } finally {
    try {
      rawClient?.remove();
    } finally {
      requireFact(
        readPrivate(environmentFile, 16 * 1024).equals(Buffer.from(connection.environment)),
        'session_controller_environment_changed',
      );
      unlinkSync(environmentFile);
      syncDirectory(request.operationDirectory);
    }
  }
  requireFact(
    digest(await runtime.inspectRuntime()) === digest(baseline),
    'session_controller_baseline_changed',
  );
  const planningPath = join(request.operationDirectory, 'admission-plan.json');
  immutable(planningPath, encode(planning));
  if (!planning.feasible)
    return {
      version: 1,
      operation: 'preview',
      feasible: false,
      reason: planning.reason,
      nominatedOwners: planning.nominatedOwners,
      admissionCalls: planning.admissionCalls,
      admissionDurationMs: planning.admissionDurationMs,
      excludedCounts: planning.excludedCounts,
      applied: false,
      runtimeStopped: false,
    };
  requireFact(
    planning.children.length > 0 &&
      planning.children.length <= feasibility.maximumChildren &&
      planning.enumerationDigest === enumeration.enumerationDigest,
    'session_controller_no_supported_children',
  );
  proofFileBudget(
    feasibility,
    planning,
    (dependencies.evidenceFileCount ?? sessionEvidenceFileCount)(),
  );
  const manifest = {
    version: 1,
    kind: 'source_abandonment_session_manifest',
    sessionId: identity.certificateId,
    clusterIdentity: identity.clusterIdentity,
    epoch: identity.epoch,
    controllerNonce: identity.controllerNonce,
    sourceSha: identity.sourceSha,
    imageId: identity.targetImageId,
    cutoff: enumeration.request.cutoff,
    baselineDigest: digest(baseline),
    topologyDigest: digest(topology),
    registryDigest: planning.registryDigest,
    botCatalogDigest: planning.botCatalogDigest,
    enumerationDigest: enumeration.enumerationDigest,
    enumerationComplete: true,
    excludedCounts: planning.excludedCounts,
    budgets: makeBudgets(feasibility, planning.children.length),
    children: planning.children,
  };
  validateSourceAbandonmentSessionManifest(manifest);
  const plan = {
    version: 1,
    kind: 'source_abandonment_session_plan',
    createdAt: new Date(now()).toISOString(),
    controllerSha: request.controllerSha,
    operationDirectory: request.operationDirectory,
    inventoryDirectory: request.inventoryDirectory,
    expectedCheckpointSha256: request.expectedCheckpointSha256,
    expectedRequest: enumeration.request,
    queueBundlePath: request.queueBundlePath,
    queueBundleSha256: request.queueBundleSha256,
    feasibilityPath: request.feasibilityPath,
    feasibilitySha256: request.feasibilitySha256,
    feasibility,
    manifest,
    baseline,
    planning,
    queueRegistrySha256: registry.queueRegistrySha256,
  };
  const bytes = encode(plan),
    planPath = join(request.operationDirectory, 'plan.json');
  requireFact(bytes.length <= maxPlanBytes, 'session_controller_plan_budget');
  immutable(planPath, bytes);
  return {
    version: 1,
    operation: 'preview',
    feasible: true,
    planPath,
    planSha256: bytesDigest(bytes),
    children: manifest.children.length,
    selectedOwners: manifest.children.reduce((sum, child) => sum + child.authorities.length, 0),
    excludedCounts: manifest.excludedCounts,
    admissionCalls: planning.admissionCalls,
    admissionDurationMs: planning.admissionDurationMs,
    estimatedColdMs: feasibility.estimatedColdMs,
    applied: false,
    runtimeStopped: false,
  };
}

function readPlan(request) {
  const bytes = readPrivate(request.planPath);
  requireFact(bytesDigest(bytes) === request.planSha256, 'session_controller_plan_changed');
  const plan = JSON.parse(bytes);
  exact(plan, [
    'version',
    'kind',
    'createdAt',
    'controllerSha',
    'operationDirectory',
    'inventoryDirectory',
    'expectedCheckpointSha256',
    'expectedRequest',
    'queueBundlePath',
    'queueBundleSha256',
    'feasibilityPath',
    'feasibilitySha256',
    'feasibility',
    'manifest',
    'baseline',
    'planning',
    'queueRegistrySha256',
  ]);
  requireFact(
    plan.version === 1 &&
      plan.kind === 'source_abandonment_session_plan' &&
      request.planPath === join(plan.operationDirectory, 'plan.json'),
    'session_controller_plan_refused',
  );
  validateSourceAbandonmentSessionManifest(plan.manifest);
  requireFact(
    digest(plan.baseline) === plan.manifest.baselineDigest &&
      plan.expectedRequest.sourceSha === plan.manifest.sourceSha &&
      plan.expectedRequest.imageId === plan.manifest.imageId &&
      plan.expectedRequest.cutoff === plan.manifest.cutoff &&
      plan.planning.feasible === true &&
      digest(plan.planning.children) === digest(plan.manifest.children) &&
      plan.planning.enumerationDigest === plan.manifest.enumerationDigest,
    'session_controller_plan_binding_changed',
  );
  return plan;
}

// FLAG: Error containment belongs to the typed protocol. The controller never
// adds an outer stop/retry, especially after a proven final runtime but lost
// terminal-journal acknowledgement.
export async function runSourceAbandonmentSessionController(input, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const request = parseSourceAbandonmentSessionRequest(JSON.stringify(input), now());
  if (request.operation === 'status') {
    const state = (dependencies.readState ?? readSourceAbandonmentSessionState)();
    return {
      version: 1,
      operation: 'status',
      ...(state.journal
        ? summarizeSourceAbandonmentSession(state.journal)
        : { phase: 'NEVER_ADMITTED' }),
      journalDigest: state.digest ?? null,
    };
  }
  (dependencies.assertLock ?? assertInheritedDeployLock)();
  if (request.operation === 'preview') return preview(request, dependencies);
  const plan = readPlan(request);
  controllerIdentity(plan.controllerSha, dependencies.run ?? execute);
  (dependencies.diskGuard ?? diskGuard)();
  (dependencies.noOtherMaintenance ?? noOtherMaintenance)();
  if (request.operation === 'run')
    (dependencies.assertNoActive ?? assertNoActiveLegacyColdMaintenance)();
  const enumeration = (dependencies.readEnumeration ?? readSourceAbandonmentSessionEnumeration)({
    directory: plan.inventoryDirectory,
    expectedCheckpointSha256: plan.expectedCheckpointSha256,
    expectedRequest: plan.expectedRequest,
  });
  requireFact(
    enumeration.enumerationDigest === plan.manifest.enumerationDigest,
    'session_controller_enumeration_changed',
  );
  const feasibility = readFeasibility(plan.feasibilityPath, plan.feasibilitySha256, enumeration);
  requireFact(
    digest(feasibility) === digest(plan.feasibility) &&
      digest(makeBudgets(feasibility, plan.manifest.children.length)) ===
        digest(plan.manifest.budgets),
    'session_controller_budget_changed',
  );
  proofFileBudget(feasibility, plan.planning);
  const store = (dependencies.createStore ?? createSourceAbandonmentSessionStore)({
    now: () => new Date(now()).toISOString(),
  });
  let state = store.read();
  if (request.operation === 'run')
    requireFact(
      state.marker === null && state.journal === null,
      'session_controller_already_admitted',
    );
  else
    requireFact(
      state.journal &&
        state.digest === request.expectedJournalDigest &&
        state.journal.manifestDigest === digest(plan.manifest),
      'session_controller_journal_changed',
    );
  if (request.operation === 'run') {
    for (const reference of plan.planning.admissionProofs) {
      requireFact(hashPattern.test(reference), 'session_controller_admission_proof_refused');
      const bytes = readPrivate(
        join(plan.operationDirectory, 'admission-proofs', `${reference}.json`),
        SOURCE_ABANDONMENT_SESSION_LIMITS.proofFileBytes,
      );
      requireFact(
        bytesDigest(bytes) === reference && store.recordProof(JSON.parse(bytes)) === reference,
        'session_controller_admission_proof_changed',
      );
    }
    proofFileBudget(
      feasibility,
      plan.planning,
      (dependencies.evidenceFileCount ?? sessionEvidenceFileCount)(),
      true,
    );
  }
  const bindings = sourceAbandonmentSessionRuntimeBindings(plan.manifest);
  const runtime = (dependencies.createRuntime ?? createLegacyColdRuntime)({
    bindings,
    baseline: plan.baseline,
  });
  const frozenLimits = Object.fromEntries(
    Object.entries(feasibility.frozenInventoryReservation).filter(
      ([key]) => key !== 'materializationPages',
    ),
  );
  const pageReader = (dependencies.createPageReader ?? createFrozenOrderedAnchorPageReader)({
    request: plan.expectedRequest,
    repositoryRoot: root,
    temporaryDirectory: dirname(fileURLToPath(import.meta.url)),
    run: createSourceAbandonmentSessionDeadlineRunner({
      now,
      deadlineAtMs: () => {
        const journal = store.read().journal;
        return (
          Date.parse(journal.coldStartedAt) +
          plan.manifest.budgets.durationMs -
          feasibility.startupReserveMs
        );
      },
    }),
  });
  const frozen = (dependencies.createFrozen ?? createSourceAbandonmentSessionFrozenInventory)({
    enumeration,
    baseline: plan.baseline,
    readPage: pageReader,
    attestStopped: () => runtime.readStoppedRuntime(),
    recordProof: (value) => store.recordProof(value),
    limits: frozenLimits,
    now,
  });
  const admission = {
    version: 1,
    complete: true,
    sessionId: plan.manifest.sessionId,
    manifestDigest: digest(plan.manifest),
    feasible: true,
    estimatedColdMs: feasibility.estimatedColdMs,
    startupReserveMs: feasibility.startupReserveMs,
    runtimeRestoreAndSmokesMs: feasibility.measuredPhases.runtimeRestoreAndSmokesMs,
    frozenInventoryReservation: feasibility.frozenInventoryReservation,
  };
  const host = await (dependencies.createHost ?? createSourceAbandonmentSessionHostContext)({
    manifest: plan.manifest,
    baseline: plan.baseline,
    controllerSha: plan.controllerSha,
    operationDir: plan.operationDirectory,
    store,
    queueBundlePath: plan.queueBundlePath,
    queueBundleSha256: plan.queueBundleSha256,
    now,
    admissionPreview: () => admission,
    snapshotFrozenInventory: (manifest, bound) => {
      const journal = store.read().journal;
      return frozen(manifest, bound, {
        deadlineAtMs:
          Date.parse(journal.coldStartedAt) +
          manifest.budgets.durationMs -
          feasibility.startupReserveMs,
      });
    },
  });
  const transition = async () => {
    const args = { store, adapters: host.adapters, now };
    const protocol = dependencies.protocol ?? {};
    if (request.operation === 'run') {
      await (protocol.prepare ?? prepareSourceAbandonmentSession)({
        ...args,
        manifest: plan.manifest,
      });
      return await (protocol.apply ?? applySourceAbandonmentSession)({
        ...args,
        expectedJournalDigest: store.read().digest,
      });
    }
    const bound = { ...args, expectedJournalDigest: request.expectedJournalDigest };
    if (request.operation === 'continue')
      return await (protocol.apply ?? applySourceAbandonmentSession)(bound);
    if (request.operation === 'reconcile')
      return await (protocol.reconcile ?? reconcileSourceAbandonmentSession)(bound);
    return await (protocol.finish ?? finishSourceAbandonmentSession)({
      ...bound,
      mode: { finish: 'complete', abort: 'abort', partial: 'partial' }[request.operation],
    });
  };
  let outcome,
    failure,
    failed = false;
  try {
    outcome = await transition();
  } catch (error) {
    failure = error;
    failed = true;
  }
  try {
    await host.close();
  } catch (error) {
    if (!failed) {
      failure = error;
      failed = true;
    } else if (failure && typeof failure === 'object' && Object.isExtensible(failure))
      failure.cleanupUnproved = true;
  }
  if (failed) throw failure;
  return outcome;
}

async function main() {
  let input = '';
  const timer = setTimeout(() => process.stdin.destroy(new Error('stdin_deadline')), 5_000);
  try {
    requireFact(process.argv.length === 2, 'session_controller_stdin_only');
    for await (const part of process.stdin) {
      input += part;
      requireFact(Buffer.byteLength(input) <= maxInputBytes, 'session_controller_input_budget');
    }
    clearTimeout(timer);
    const result = await runSourceAbandonmentSessionController(
      parseSourceAbandonmentSessionRequest(input),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.feasible === false) process.exitCode = 1;
  } catch (error) {
    const uncertain = error?.finalJournalUncertain === true && error?.runtimeAlreadyProven === true;
    process.stderr.write(
      `${JSON.stringify({ version: 1, operation: 'refused', reason: uncertain ? 'final_journal_unconfirmed' : 'session_controller_refused', runtimeAlreadyProven: uncertain, finalJournalUncertain: uncertain })}\n`,
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
