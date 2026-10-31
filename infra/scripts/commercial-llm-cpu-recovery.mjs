import { createHash } from 'node:crypto';

const kind = 'commercial-llm-cpu-quarantine-recovery-v1';
const sha = /^[0-9a-f]{40}$/u;
const digest = /^[0-9a-f]{64}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const phases = [
  'prepared',
  'stopping_dispatcher',
  'dispatcher_stopped',
  'stopping_model',
  'model_stopped',
  'releasing_lease',
  'lease_released',
  'starting_model',
  'model_ready',
  'starting_dispatcher',
  'dispatcher_ready',
  'complete',
];

function refuse(reason) {
  throw new Error(`commercial_llm_cpu_recovery_${reason}`);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value, expected) {
  return (
    record(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function timestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,9}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

export function assertCpuRecoveryGeneration(value) {
  if (
    !keys(value, ['id', 'imageId', 'startedAt', 'restartCount']) ||
    !digest.test(value.id ?? '') ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.imageId ?? '') ||
    !timestamp(value.startedAt) ||
    !Number.isSafeInteger(value.restartCount) ||
    value.restartCount < 0
  )
    refuse('generation_invalid');
  return value;
}

function normalizeGeneration(value) {
  const generation = {
    id: value?.id,
    imageId: value?.imageId,
    startedAt: value?.startedAt,
    restartCount: value?.restartCount,
  };
  assertCpuRecoveryGeneration(generation);
  return generation;
}

function sameGeneration(actual, expected) {
  return ['id', 'imageId', 'startedAt', 'restartCount'].every(
    (key) => actual[key] === expected[key],
  );
}

function assertObserved(value, expected, running) {
  if (
    !keys(value, ['id', 'imageId', 'startedAt', 'restartCount', 'running']) ||
    typeof value.running !== 'boolean' ||
    !sameGeneration(normalizeGeneration(value), expected) ||
    value.running !== running
  )
    refuse('generation_drift');
}

function assertStarted(value, previous) {
  const next = normalizeGeneration(value);
  if (
    !keys(value, ['id', 'imageId', 'startedAt', 'restartCount', 'running']) ||
    value.running !== true ||
    next.id !== previous.id ||
    next.imageId !== previous.imageId ||
    next.restartCount !== previous.restartCount ||
    Date.parse(next.startedAt) <= Date.parse(previous.startedAt)
  )
    refuse('restart_drift');
  return next;
}

export function assertCpuRecoveryPlan(value) {
  if (
    !keys(value, [
      'schemaVersion',
      'kind',
      'sourceSha',
      'operationId',
      'model',
      'dispatcher',
      'leaseFingerprint',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== kind ||
    !sha.test(value.sourceSha ?? '') ||
    !uuid.test(value.operationId ?? '') ||
    !digest.test(value.leaseFingerprint ?? '')
  )
    refuse('plan_invalid');
  assertCpuRecoveryGeneration(value.model);
  assertCpuRecoveryGeneration(value.dispatcher);
  if (value.model.id === value.dispatcher.id) refuse('plan_invalid');
  return value;
}

export function cpuRecoveryPlanSha256(value) {
  assertCpuRecoveryPlan(value);
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        kind,
        sourceSha: value.sourceSha,
        operationId: value.operationId,
        model: normalizeGeneration(value.model),
        dispatcher: normalizeGeneration(value.dispatcher),
        leaseFingerprint: value.leaseFingerprint,
      }),
    )
    .digest('hex');
}

export function assertCpuRecoveryJournal(value) {
  if (
    !keys(value, [
      'schemaVersion',
      'kind',
      'plan',
      'planSha256',
      'phase',
      'modelRestart',
      'dispatcherRestart',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== kind ||
    !phases.includes(value.phase)
  )
    refuse('journal_invalid');
  assertCpuRecoveryPlan(value.plan);
  if (value.planSha256 !== cpuRecoveryPlanSha256(value.plan)) refuse('journal_digest_invalid');
  const at = phases.indexOf(value.phase);
  for (const [field, original, requiredAt] of [
    ['modelRestart', value.plan.model, phases.indexOf('model_ready')],
    ['dispatcherRestart', value.plan.dispatcher, phases.indexOf('dispatcher_ready')],
  ]) {
    if (at < requiredAt) {
      if (value[field] !== null) refuse('journal_invalid');
    } else {
      assertCpuRecoveryGeneration(value[field]);
      assertStarted({ ...value[field], running: true }, original);
    }
  }
  return value;
}

function assertHeld(lease, fingerprint) {
  if (lease?.state !== 'held' || lease.fingerprint !== fingerprint || lease.ttlMs !== -1)
    refuse('lease_changed');
}

function assertReleased(lease, fingerprint) {
  if (lease?.state !== 'released_receipt' || lease.fingerprint !== fingerprint)
    refuse('release_unproved');
}

function terminal(journal, replayed) {
  return {
    result: replayed ? 'already_recovered' : 'recovered',
    operationId: journal.plan.operationId,
    sourceSha: journal.plan.sourceSha,
    planSha256: journal.planSha256,
    model: journal.modelRestart,
    dispatcher: journal.dispatcherRestart,
  };
}

/**
 * I/O attests the manifest, receipt, containment and exact service singleton on every snapshot.
 * Mutations run under the protected host lock. Journals are fsynced before resolving a write;
 * releaseLease atomically compares the exact token and records the operation's release receipt.
 */
export async function recoverCommercialLlmCpuQuarantine({
  sourceSha,
  operationId,
  expectedPlanSha256,
  apply = false,
  io,
}) {
  if (!sha.test(sourceSha ?? '') || !uuid.test(operationId ?? '') || typeof apply !== 'boolean')
    refuse('identity_invalid');
  let journal = await io.readJournal(operationId);
  if (journal !== undefined) {
    assertCpuRecoveryJournal(journal);
    if (journal.plan.sourceSha !== sourceSha || journal.plan.operationId !== operationId)
      refuse('journal_identity_mismatch');
  }
  let plan = journal?.plan;
  if (!plan) {
    const snapshot = await io.snapshot();
    const lease = await io.leaseStatus(operationId);
    if (lease?.state !== 'held' || lease.ttlMs !== -1 || !digest.test(lease.fingerprint ?? ''))
      refuse('persistent_lease_required');
    plan = {
      schemaVersion: 1,
      kind,
      sourceSha,
      operationId,
      model: normalizeGeneration(snapshot.model),
      dispatcher: normalizeGeneration(snapshot.dispatcher),
      leaseFingerprint: lease.fingerprint,
    };
    assertCpuRecoveryPlan(plan);
    assertObserved(snapshot.model, plan.model, true);
    assertObserved(snapshot.dispatcher, plan.dispatcher, true);
  }
  const planSha256 = cpuRecoveryPlanSha256(plan);
  if (!apply)
    return { result: 'preview', plan, planSha256, phase: journal?.phase ?? 'not_started' };
  if (expectedPlanSha256 !== planSha256) refuse('reviewed_plan_required');
  // FLAG: Terminal replay cannot stop services or clear a lease acquired by later natural work.
  if (journal?.phase === 'complete') return terminal(journal, true);
  const save = async (phase, changes = {}) => {
    const next = { ...journal, ...changes, phase };
    assertCpuRecoveryJournal(next);
    await io.writeJournal(structuredClone(next));
    journal = next;
  };
  if (!journal) {
    journal = {
      schemaVersion: 1,
      kind,
      plan,
      planSha256,
      phase: 'prepared',
      modelRestart: null,
      dispatcherRestart: null,
    };
    await io.writeJournal(structuredClone(journal));
  }
  const snapshot = async () => {
    const value = await io.snapshot();
    if (!keys(value, ['model', 'dispatcher'])) refuse('snapshot_invalid');
    return value;
  };
  const bothStopped = (value) => {
    assertObserved(value.model, plan.model, false);
    assertObserved(value.dispatcher, plan.dispatcher, false);
  };
  while (journal.phase !== 'complete') {
    const value = await snapshot();
    switch (journal.phase) {
      case 'prepared':
        assertObserved(value.model, plan.model, true);
        assertObserved(value.dispatcher, plan.dispatcher, true);
        assertHeld(await io.leaseStatus(operationId), plan.leaseFingerprint);
        await save('stopping_dispatcher');
        break;
      case 'stopping_dispatcher': {
        assertObserved(value.model, plan.model, true);
        assertObserved(value.dispatcher, plan.dispatcher, value.dispatcher.running);
        assertHeld(await io.leaseStatus(operationId), plan.leaseFingerprint);
        if (value.dispatcher.running) await io.stopDispatcher(plan.dispatcher);
        const stopped = await snapshot();
        assertObserved(stopped.model, plan.model, true);
        assertObserved(stopped.dispatcher, plan.dispatcher, false);
        await save('dispatcher_stopped');
        break;
      }
      case 'dispatcher_stopped':
        assertObserved(value.model, plan.model, true);
        assertObserved(value.dispatcher, plan.dispatcher, false);
        assertHeld(await io.leaseStatus(operationId), plan.leaseFingerprint);
        await save('stopping_model');
        break;
      case 'stopping_model':
        assertObserved(value.dispatcher, plan.dispatcher, false);
        assertObserved(value.model, plan.model, value.model.running);
        assertHeld(await io.leaseStatus(operationId), plan.leaseFingerprint);
        if (value.model.running) await io.stopModel(plan.model);
        bothStopped(await snapshot());
        await save('model_stopped');
        break;
      case 'model_stopped':
        bothStopped(value);
        assertHeld(await io.leaseStatus(operationId), plan.leaseFingerprint);
        await save('releasing_lease');
        break;
      case 'releasing_lease': {
        // FLAG: Idle is insufficient. Both exact captured process generations must be stopped
        // before the only lease CAS; its atomic receipt resolves a crash after the Redis commit.
        bothStopped(value);
        const lease = await io.leaseStatus(operationId);
        if (lease?.state === 'held') {
          assertHeld(lease, plan.leaseFingerprint);
          bothStopped(await snapshot());
          await io.releaseLease(operationId, plan.leaseFingerprint);
        }
        assertReleased(await io.leaseStatus(operationId), plan.leaseFingerprint);
        bothStopped(await snapshot());
        await save('lease_released');
        break;
      }
      case 'lease_released':
        bothStopped(value);
        assertReleased(await io.leaseStatus(operationId), plan.leaseFingerprint);
        await save('starting_model');
        break;
      case 'starting_model': {
        assertObserved(value.dispatcher, plan.dispatcher, false);
        assertReleased(await io.leaseStatus(operationId), plan.leaseFingerprint);
        if (value.model.running === false) {
          assertObserved(value.model, plan.model, false);
          await io.startModel(plan.model);
        }
        const started = await snapshot();
        assertObserved(started.dispatcher, plan.dispatcher, false);
        const modelRestart = assertStarted(started.model, plan.model);
        await io.waitModelReady(modelRestart);
        const ready = await snapshot();
        assertObserved(ready.dispatcher, plan.dispatcher, false);
        assertObserved(ready.model, modelRestart, true);
        await save('model_ready', { modelRestart });
        break;
      }
      case 'model_ready':
        assertObserved(value.model, journal.modelRestart, true);
        assertObserved(value.dispatcher, plan.dispatcher, false);
        assertReleased(await io.leaseStatus(operationId), plan.leaseFingerprint);
        await save('starting_dispatcher');
        break;
      case 'starting_dispatcher': {
        assertObserved(value.model, journal.modelRestart, true);
        if (value.dispatcher.running === false) {
          assertObserved(value.dispatcher, plan.dispatcher, false);
          await io.startDispatcher(plan.dispatcher);
        }
        const started = await snapshot();
        assertObserved(started.model, journal.modelRestart, true);
        const dispatcherRestart = assertStarted(started.dispatcher, plan.dispatcher);
        await io.waitDispatcherReady(dispatcherRestart);
        const ready = await snapshot();
        assertObserved(ready.model, journal.modelRestart, true);
        assertObserved(ready.dispatcher, dispatcherRestart, true);
        await save('dispatcher_ready', { dispatcherRestart });
        break;
      }
      case 'dispatcher_ready':
        assertObserved(value.model, journal.modelRestart, true);
        assertObserved(value.dispatcher, journal.dispatcherRestart, true);
        await save('complete');
        break;
      default:
        refuse('journal_invalid');
    }
  }
  return terminal(journal, false);
}
