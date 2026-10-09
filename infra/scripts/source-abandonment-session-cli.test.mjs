import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSourceAbandonmentSessionRequest,
  createSourceAbandonmentSessionDeadlineRunner,
  runSourceAbandonmentSessionController,
} from './source-abandonment-session-cli.mjs';
import {
  sourceAbandonmentSessionDigest as digest,
  SOURCE_ABANDONMENT_SESSION_LIMITS,
} from './source-abandonment-session-journal.mjs';
import { canonicalLegacyColdDigest as canonical } from './legacy-cold-store-adapter.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import { runOrderedAnchorInventory } from './webhook-ordered-anchor-inventory-cli.mjs';
import { readSourceAbandonmentSessionEnumeration } from './source-abandonment-session-inventory.mjs';
import { readSourceAbandonmentSessionQueueRegistry } from './source-abandonment-session-host.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (value) => `${JSON.stringify(value)}\n`;
const proofDigest = (value) => sha256(encode(value));
const hash = 'a'.repeat(64),
  sourceSha = 'b'.repeat(40),
  controllerSha = 'c'.repeat(40),
  imageId = `sha256:${'d'.repeat(64)}`;
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const now = Date.parse('2026-10-09T16:20:00.000Z');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-session-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const events = [],
    captured = {};
  const expectedRequest = {
    version: 2,
    inventoryId: uuid(1),
    sourceSha,
    imageId,
    cutoff: '2026-10-09T16:10:00.000Z',
  };
  const enumeration = {
    version: 1,
    kind: 'source_abandonment_session_enumeration',
    request: expectedRequest,
    runtime: { id: 'e'.repeat(64), sourceSha, imageId },
    checkpointSha256: hash,
    journalBytes: 1100,
    report: { complete: true, pages: 1, rowObservations: 1, metadataBytes: 1000 },
    rows: [],
    authorities: [
      {
        ownerId: 'private_owner',
        claimId: 'private_claim',
        semanticKey: 'private_semantic',
        chatId: '-private_chat',
        messageId: 'private_message',
      },
    ],
    unresolvedCount: 0,
    enumerationDigest: 'f'.repeat(64),
  };
  const feasibility = {
    version: 1,
    kind: 'source_abandonment_session_feasibility',
    sourceSha,
    imageId,
    enumerationDigest: enumeration.enumerationDigest,
    estimatedColdMs: 420000,
    startupReserveMs: 180000,
    maximumChildren: 1,
    frozenInventoryReservation: {
      inventoryPages: 2,
      inventoryRows: 200,
      inventoryProbes: 1000,
      inventoryBytes: 128 * 1024,
      materializationPages: 0,
    },
    evidenceSha256: [hash],
    measuredPhases: {
      preDrainAndStopMs: 30000,
      frozenInventoryMs: 10000,
      childCollectionsMs: 60000,
      installMaterializeMs: 60000,
      finalReadbacksMs: 30000,
      runtimeRestoreAndSmokesMs: 60000,
    },
  };
  const feasibilityPath = join(directory, 'feasibility.json');
  writeFileSync(feasibilityPath, encode(feasibility), { mode: 0o600 });
  const queueBundlePath = join(directory, 'queues.cjs');
  writeFileSync(queueBundlePath, 'module.exports = {};\n', { mode: 0o600 });
  const previewRequest = {
    version: 1,
    operation: 'preview',
    controllerSha,
    inventoryDirectory: directory,
    expectedCheckpointSha256: hash,
    expectedRequest,
    operationDirectory: directory,
    queueBundlePath,
    queueBundleSha256: sha256(readFileSync(queueBundlePath)),
    feasibilityPath,
    feasibilitySha256: sha256(readFileSync(feasibilityPath)),
    deadlineAtMs: now + 600000,
  };
  let state = { marker: null, journal: null, digest: null };
  const store = {
    read: () => state,
    recordProof(value) {
      events.push('record-proof');
      return proofDigest(value);
    },
    readEvidence() {
      throw Error('unexpected evidence read');
    },
  };
  const connection = {
    networkId: 'e'.repeat(64),
    publisherBotId: 'publisher',
    majorBotIds: ['major'],
    environment:
      'DATABASE_URL=postgresql://private:password@postgres/maxim\nREDIS_URL=redis://:private-token@redis:6379/2\n',
  };
  const dependencies = {
    now: () => now,
    assertLock() {
      events.push('lock');
    },
    assertNoActive() {
      events.push('no-active');
    },
    noOtherMaintenance() {
      events.push('other-maintenance');
      return { marker: null, journal: null };
    },
    diskGuard() {
      events.push('disk');
    },
    evidenceFileCount: () => 0,
    run(command, args) {
      assert.equal(command, 'git');
      if (args[0] === 'rev-parse') return controllerSha;
      if (args[0] === 'status') return '';
      throw Error('unexpected git');
    },
    readEnumeration(options) {
      events.push('enumeration');
      assert.equal(options.expectedCheckpointSha256, hash);
      return structuredClone(enumeration);
    },
    readRegistry() {
      return { queueNames: ['moderation-actions'], queueRegistrySha256: hash };
    },
    createRuntime({ bindings, baseline }) {
      const generation = (serviceName, index) => ({
        serviceName,
        containerId: String(index + 1).padStart(64, '0'),
        sourceSha,
        imageId,
        stopped: false,
        exactGeneration: true,
        restartPolicy: 'unless-stopped',
      });
      const capturedBaseline = baseline ?? {
        version: 1,
        complete: true,
        sourceSha,
        imageId,
        selectionDigest: bindings.selectionDigest,
        controllerNonce: bindings.controllerNonce,
        compatible: true,
        singletonCount: 14,
        nativeCount: 2,
        unreviewedProducers: 0,
        services: LEGACY_COLD_API_SERVICES.map(generation),
        auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map((name, index) =>
          generation(name, index + 14),
        ),
      };
      return {
        inspectRuntime() {
          events.push('inspect-runtime');
          return structuredClone(capturedBaseline);
        },
        readStoppedRuntime() {
          events.push('stopped-runtime');
          return capturedBaseline;
        },
      };
    },
    readConnection() {
      return connection;
    },
    createClient(options) {
      captured.client = options;
      assert.equal(readFileSync(options.environmentFile, 'utf8'), connection.environment);
      return {
        remove() {
          events.push('client-remove');
        },
        invoke(kind, input) {
          events.push('admission');
          assert.equal(kind, 'admission');
          return { version: 1, privateOwner: 'private_owner', selection: input.selection };
        },
      };
    },
    async planChildren(options) {
      captured.planner = options;
      const selection = {
        ownerWebhookEventIds: ['private_owner'],
        majorBotIds: ['major'],
        protocol: 'source-abandonment-v1',
        abandonBefore: expectedRequest.cutoff,
      };
      const proof = await options.collectAdmission(
        {
          version: 1,
          operation: 'admission_preview',
          sourceSha,
          imageId,
          selection,
          publisherBotId: 'publisher',
        },
        { deadlineAtMs: options.deadlineAtMs },
      );
      const admissionDigest = options.recordProof(proof);
      return {
        version: 1,
        feasible: true,
        reason: null,
        children: [
          {
            certificateId: uuid(10),
            selection,
            selectionDigest: digest(selection),
            admissionDigest,
            authorities: structuredClone(enumeration.authorities),
          },
        ],
        excludedCounts: { rejected: 0, unresolved: 0 },
        registryDigest: hash,
        botCatalogDigest: canonical({ publisherBotId: 'publisher' }),
        enumerationDigest: enumeration.enumerationDigest,
        nominatedOwners: 1,
        admissionCalls: 1,
        admissionDurationMs: 1000,
        admissionCost: { pages: 1, rows: 1, probes: 1, bytes: 100 },
        admissionProofs: [admissionDigest],
      };
    },
    createStore() {
      events.push('store');
      return store;
    },
    createPageReader(options) {
      captured.reader = options;
      return () => {
        throw Error('unexpected SQL');
      };
    },
    createFrozen(options) {
      captured.frozen = options;
      return async (_manifest, _bindings, extra) => {
        captured.frozenDeadline = extra.deadlineAtMs;
        return { frozen: true };
      };
    },
    async createHost(options) {
      events.push('host');
      captured.host = options;
      return {
        adapters: { noMutations: true },
        close: async () => {
          events.push('close');
        },
      };
    },
    protocol: {
      async prepare(options) {
        events.push('prepare');
        state = {
          marker: {},
          journal: {
            manifest: options.manifest,
            manifestDigest: digest(options.manifest),
            coldStartedAt: new Date(now).toISOString(),
          },
          digest: '1'.repeat(64),
        };
        return { prepared: true };
      },
      async apply(options) {
        events.push('apply');
        assert.equal(options.expectedJournalDigest, state.digest);
        return { version: 1, complete: true, runtimeStarted: true };
      },
      async reconcile(options) {
        events.push('reconcile');
        return { version: 1, reconciled: true, expected: options.expectedJournalDigest };
      },
      async finish(options) {
        events.push(`finish:${options.mode}`);
        return { version: 1, mode: options.mode };
      },
    },
  };
  return {
    directory,
    events,
    captured,
    enumeration,
    feasibility,
    feasibilityPath,
    previewRequest,
    dependencies,
    connection,
    state: () => state,
    setState(value) {
      state = value;
    },
    async preview() {
      return runSourceAbandonmentSessionController(previewRequest, dependencies);
    },
    rewriteFeasibility() {
      writeFileSync(feasibilityPath, encode(feasibility));
      previewRequest.feasibilitySha256 = sha256(readFileSync(feasibilityPath));
    },
  };
}

test('stdin grammar is finite and continuation always requires explicit journal CAS', () => {
  assert.deepEqual(
    parseSourceAbandonmentSessionRequest('{"version":1,"operation":"status"}', now),
    { version: 1, operation: 'status' },
  );
  for (const input of [
    { version: 1, operation: 'delete' },
    { version: 1, operation: 'status', directory: '/tmp/other' },
    { version: 1, operation: 'continue', planPath: '/tmp/plan.json', planSha256: hash },
    { version: 1, operation: 'run', planPath: 'relative.json', planSha256: hash },
    { version: 2, operation: 'status' },
  ])
    assert.throws(() => parseSourceAbandonmentSessionRequest(JSON.stringify(input), now));
});

test('status reads only the durable journal and does not need a lock, Docker or SQL', async () => {
  const result = await runSourceAbandonmentSessionController(
    { version: 1, operation: 'status' },
    {
      readState: () => ({ marker: null, journal: null, digest: null }),
      assertLock: () => {
        throw Error('no lock');
      },
    },
  );
  assert.equal(result.phase, 'NEVER_ADMITTED');
  assert.equal(result.journalDigest, null);
});

test('preview durably binds private proofs, runtime, source and finite budgets without a stop', async (t) => {
  const h = fixture(t),
    result = await h.preview();
  assert.equal(result.feasible, true);
  assert.equal(result.selectedOwners, 1);
  assert.equal(result.runtimeStopped, false);
  const planBytes = readFileSync(result.planPath),
    plan = JSON.parse(planBytes);
  assert.equal(result.planSha256, sha256(planBytes));
  assert.equal(plan.controllerSha, controllerSha);
  assert.equal(plan.manifest.sourceSha, sourceSha);
  assert.equal(plan.manifest.imageId, imageId);
  assert.equal(plan.manifest.baselineDigest, digest(plan.baseline));
  assert.equal(h.captured.planner.maximumChildren, 1);
  assert.equal(existsSync(join(h.directory, 'admission.env')), false);
  assert.equal(h.events.includes('host'), false);
  assert.equal(h.events.includes('prepare'), false);
  assert.doesNotMatch(JSON.stringify(result), /private_owner|password|private-token/);
  assert.doesNotMatch(planBytes.toString(), /password|private-token/);
});

test('run imports reviewed proofs, prepares once and applies once under the same host context', async (t) => {
  const h = fixture(t),
    preview = await h.preview();
  h.events.length = 0;
  const result = await runSourceAbandonmentSessionController(
    { version: 1, operation: 'run', planPath: preview.planPath, planSha256: preview.planSha256 },
    h.dependencies,
  );
  assert.equal(result.complete, true);
  assert.equal(h.events.filter((name) => name === 'prepare').length, 1);
  assert.equal(h.events.filter((name) => name === 'apply').length, 1);
  assert.equal(h.events.filter((name) => name === 'host').length, 1);
  assert.equal(h.events.at(-1), 'close');
  assert.ok(h.events.indexOf('record-proof') < h.events.indexOf('host'));
  assert.equal(h.captured.frozen.baseline, h.captured.host.baseline);
  const proof = await h.captured.host.admissionPreview();
  assert.equal(proof.startupReserveMs, h.feasibility.startupReserveMs);
  await h.captured.host.snapshotFrozenInventory(h.captured.host.manifest, {});
  assert.equal(
    h.captured.frozenDeadline,
    now + h.captured.host.manifest.budgets.durationMs - h.feasibility.startupReserveMs,
  );
});

for (const [name, alter] of [
  [
    'stale plan digest',
    (h, input) => {
      input.planSha256 = 'f'.repeat(64);
    },
  ],
  [
    'dirty controller',
    (h) => {
      h.dependencies.run = (_command, args) =>
        args[0] === 'rev-parse' ? controllerSha : ' M changed';
    },
  ],
  [
    'disk reserve',
    (h) => {
      h.dependencies.diskGuard = () => {
        throw Error('disk below 20GiB');
      };
    },
  ],
  [
    'different enumeration',
    (h) => {
      h.enumeration.enumerationDigest = '0'.repeat(64);
    },
  ],
  [
    'changed feasibility bytes',
    (h) => {
      writeFileSync(h.feasibilityPath, '{}\n');
    },
  ],
])
  test(`run refuses ${name} before opening the queue controller`, async (t) => {
    const h = fixture(t),
      preview = await h.preview();
    h.events.length = 0;
    const input = {
      version: 1,
      operation: 'run',
      planPath: preview.planPath,
      planSha256: preview.planSha256,
    };
    alter(h, input);
    await assert.rejects(runSourceAbandonmentSessionController(input, h.dependencies));
    assert.equal(h.events.includes('host'), false);
    assert.equal(h.events.includes('prepare'), false);
  });

test('private plan files cannot be replaced by symlinks or made public', async (t) => {
  const h = fixture(t),
    preview = await h.preview();
  chmodSync(preview.planPath, 0o644);
  const input = {
    version: 1,
    operation: 'run',
    planPath: preview.planPath,
    planSha256: preview.planSha256,
  };
  await assert.rejects(runSourceAbandonmentSessionController(input, h.dependencies));
  const actual = readFileSync(preview.planPath),
    other = join(h.directory, 'other.json');
  writeFileSync(other, actual, { mode: 0o600 });
  rmSync(preview.planPath);
  symlinkSync(other, preview.planPath);
  await assert.rejects(runSourceAbandonmentSessionController(input, h.dependencies));
});

for (const [operation, event] of [
  ['continue', 'apply'],
  ['reconcile', 'reconcile'],
  ['finish', 'finish:complete'],
  ['abort', 'finish:abort'],
  ['partial', 'finish:partial'],
])
  test(`${operation} dispatches only its typed transition with the exact reviewed journal`, async (t) => {
    const h = fixture(t),
      preview = await h.preview(),
      plan = JSON.parse(readFileSync(preview.planPath));
    h.setState({
      marker: {},
      journal: { manifestDigest: digest(plan.manifest), manifest: plan.manifest },
      digest: hash,
    });
    h.events.length = 0;
    await runSourceAbandonmentSessionController(
      {
        version: 1,
        operation,
        planPath: preview.planPath,
        planSha256: preview.planSha256,
        expectedJournalDigest: hash,
      },
      h.dependencies,
    );
    assert.equal(h.events.filter((name) => name === event).length, 1);
    assert.equal(h.events.includes('prepare'), false);
    assert.equal(h.events.includes('record-proof'), false);
    assert.equal(h.events.at(-1), 'close');
  });

test('stale journal refuses continuation before any host or runtime mutation', async (t) => {
  const h = fixture(t),
    preview = await h.preview(),
    plan = JSON.parse(readFileSync(preview.planPath));
  h.setState({ marker: {}, journal: { manifestDigest: digest(plan.manifest) }, digest: hash });
  h.events.length = 0;
  await assert.rejects(
    runSourceAbandonmentSessionController(
      {
        version: 1,
        operation: 'continue',
        planPath: preview.planPath,
        planSha256: preview.planSha256,
        expectedJournalDigest: '0'.repeat(64),
      },
      h.dependencies,
    ),
  );
  assert.equal(h.events.includes('host'), false);
});

test('final journal uncertainty survives cleanup failure without any stop or replay', async (t) => {
  const h = fixture(t),
    preview = await h.preview();
  const failure = Object.assign(Error('final_journal_unconfirmed'), {
    finalJournalUncertain: true,
    runtimeAlreadyProven: true,
  });
  h.dependencies.protocol.apply = async () => {
    h.events.push('apply');
    throw failure;
  };
  h.dependencies.createHost = async () => ({
    adapters: {},
    close: async () => {
      h.events.push('close');
      throw Error('cleanup');
    },
  });
  await assert.rejects(
    runSourceAbandonmentSessionController(
      { version: 1, operation: 'run', planPath: preview.planPath, planSha256: preview.planSha256 },
      h.dependencies,
    ),
    (error) =>
      error === failure &&
      error.finalJournalUncertain &&
      error.runtimeAlreadyProven &&
      error.cleanupUnproved,
  );
  assert.equal(h.events.filter((name) => name === 'apply').length, 1);
  assert.equal(h.events.includes('finish:abort'), false);
});

test('failed preparation never falls through to apply', async (t) => {
  const h = fixture(t),
    preview = await h.preview();
  h.dependencies.protocol.prepare = async () => {
    h.events.push('prepare');
    throw Error('frozen refused');
  };
  await assert.rejects(
    runSourceAbandonmentSessionController(
      { version: 1, operation: 'run', planPath: preview.planPath, planSha256: preview.planSha256 },
      h.dependencies,
    ),
  );
  assert.equal(h.events.includes('apply'), false);
  assert.equal(h.events.at(-1), 'close');
});

test('admission refusal leaves its private measurements and never creates a runnable plan', async (t) => {
  const h = fixture(t);
  h.dependencies.planChildren = async () => ({
    version: 1,
    feasible: false,
    reason: 'too_many_candidates',
    nominatedOwners: 65,
    admissionCalls: 0,
    admissionDurationMs: 0,
    excludedCounts: { rejected: 0, unresolved: 0 },
  });
  const result = await h.preview();
  assert.equal(result.feasible, false);
  assert.equal(result.nominatedOwners, 65);
  assert.equal(existsSync(join(h.directory, 'plan.json')), false);
  assert.equal(existsSync(join(h.directory, 'admission-plan.json')), true);
  assert.equal(existsSync(join(h.directory, 'admission.env')), false);
});

test('credentials are removed even if isolated client construction fails', async (t) => {
  const h = fixture(t);
  h.dependencies.createClient = () => {
    throw Error('client configuration');
  };
  await assert.rejects(h.preview());
  assert.equal(existsSync(join(h.directory, 'admission.env')), false);
});

test('full frozen scope has its own larger limits while child collector reservations stay unchanged', async (t) => {
  const h = fixture(t);
  h.enumeration.report.pages = 151;
  h.enumeration.report.rowObservations = 30000;
  h.enumeration.report.metadataBytes = 32 * 1024 * 1024;
  h.enumeration.journalBytes = 33 * 1024 * 1024;
  Object.assign(h.feasibility.frozenInventoryReservation, {
    inventoryPages: 160,
    inventoryRows: 32000,
    inventoryProbes: 130000,
    inventoryBytes: 40 * 1024 * 1024,
  });
  h.rewriteFeasibility();
  const result = await h.preview();
  const plan = JSON.parse(readFileSync(result.planPath));
  assert.equal(plan.manifest.budgets.inventoryRows, 32000 + 2 * 10000);
  assert.equal(plan.manifest.budgets.inventoryPages, 160 + 2 * 512);
});

test('frozen pages reserve room for child and terminal proofs before any pause', async (t) => {
  const h = fixture(t);
  h.feasibility.frozenInventoryReservation.inventoryPages =
    SOURCE_ABANDONMENT_SESSION_LIMITS.proofFiles - 40;
  h.rewriteFeasibility();
  await assert.rejects(h.preview(), /proof_file_budget/);
  assert.equal(existsSync(join(h.directory, 'plan.json')), false);
  assert.equal(h.events.includes('host'), false);
});

test('already retained orphan proofs count against available maintenance evidence slots', async (t) => {
  const h = fixture(t),
    preview = await h.preview();
  h.dependencies.evidenceFileCount = () => SOURCE_ABANDONMENT_SESSION_LIMITS.proofFiles - 12;
  h.events.length = 0;
  await assert.rejects(
    runSourceAbandonmentSessionController(
      { version: 1, operation: 'run', planPath: preview.planPath, planSha256: preview.planSha256 },
      h.dependencies,
    ),
    /proof_file_budget/,
  );
  assert.equal(h.events.includes('host'), false);
});

for (const [name, change] of [
  [
    'source evidence',
    (h) => {
      h.feasibility.sourceSha = 'e'.repeat(40);
    },
  ],
  [
    'unbounded children',
    (h) => {
      h.feasibility.maximumChildren = SOURCE_ABANDONMENT_SESSION_LIMITS.children + 1;
    },
  ],
  [
    'missing measurement references',
    (h) => {
      h.feasibility.evidenceSha256 = [];
    },
  ],
  [
    'insufficient restoration reserve',
    (h) => {
      h.feasibility.startupReserveMs = 1;
    },
  ],
  [
    'insufficient scan rows',
    (h) => {
      h.feasibility.frozenInventoryReservation.inventoryRows = 0;
    },
  ],
  [
    'missing plan bytes in frozen allowance',
    (h) => {
      h.feasibility.frozenInventoryReservation.inventoryBytes = 1000;
    },
  ],
  [
    'unbounded duration',
    (h) => {
      h.feasibility.estimatedColdMs = SOURCE_ABANDONMENT_SESSION_LIMITS.durationMs + 1;
    },
  ],
])
  test(`feasibility rejects ${name} before admission work`, async (t) => {
    const h = fixture(t);
    change(h);
    h.rewriteFeasibility();
    await assert.rejects(h.preview());
    assert.equal(h.events.includes('admission'), false);
  });

test('each SQL command needs its unchanged full cleanup timeout inside the work deadline', () => {
  let timestamp = 1000;
  const calls = [];
  const runner = createSourceAbandonmentSessionDeadlineRunner({
    deadlineAtMs: () => 15000,
    now: () => timestamp,
    run: (...args) => {
      calls.push(args);
      return 'result';
    },
  });
  const options = { timeout: 14000, maxBuffer: 1024 };
  assert.equal(runner('bash', ['audit', 'queue'], options), 'result');
  assert.equal(calls[0][2], options);
  timestamp++;
  assert.throws(() => runner('bash', ['audit', 'queue'], options), /frozen_deadline/);
  assert.equal(calls.length, 1);
});

test('preview works with the real immutable enumeration reader and stock-admission planner', async (t) => {
  const h = fixture(t);
  const directory = mkdtempSync(join(h.directory, 'enumeration-'));
  const selected = h.enumeration.authorities[0];
  const receipt = {
    id: 'private_receipt',
    orderChatId: selected.chatId,
    createdAt: '2026-10-09T15:00:00.000001Z',
    status: 'FAILED',
    normalizedBounded: true,
    ordered: true,
    chatId: selected.chatId,
    messageId: selected.messageId,
    semanticKey: selected.semanticKey,
    botId: 'major',
    legacyReleased: false,
    sourceReleased: false,
    retry: 'due',
    quarantine: 'expired',
    errorFamily: 'legacy_unverified',
    claim: {
      semanticFound: true,
      directCount: 1,
      conflict: false,
      id: selected.claimId,
      ownerId: selected.ownerId,
      status: 'READY',
      enforced: true,
      prepared: true,
      started: true,
      completed: false,
      lease: 'expired',
      checkpoint: 'waiting_marker',
    },
  };
  const result = runOrderedAnchorInventory({
    request: h.previewRequest.expectedRequest,
    directory,
    attest: () => ({
      ...h.enumeration.runtime,
      running: true,
      startedAt: '2026-10-09T14:00:00.000Z',
      restarts: 0,
    }),
    readPage: (parameters) => ({
      page: {
        version: 2,
        kind: 'ordered_anchor_inventory_page',
        readOnly: true,
        observedAt: '2026-10-09T16:20:00.000000Z',
        ...parameters,
        rawCount: 1,
        hasMore: false,
        nextCursor: { chatId: receipt.orderChatId, createdAt: receipt.createdAt, id: receipt.id },
        rows: [receipt],
        coverage: 'ONLINE_PREVIEW',
        mutationAuthorized: false,
      },
      plan: { bounded: true },
    }),
  });
  h.previewRequest.inventoryDirectory = directory;
  h.previewRequest.expectedCheckpointSha256 = result.checkpointSha256;
  const enumeration = readSourceAbandonmentSessionEnumeration({
    directory,
    expectedCheckpointSha256: result.checkpointSha256,
    expectedRequest: h.previewRequest.expectedRequest,
  });
  h.feasibility.enumerationDigest = enumeration.enumerationDigest;
  h.rewriteFeasibility();
  delete h.dependencies.readEnumeration;
  delete h.dependencies.planChildren;
  h.dependencies.readRegistry = (source) =>
    readSourceAbandonmentSessionQueueRegistry(source, () =>
      readFileSync(
        new URL('../../apps/api/src/scripts/legacy-recovery-live-registry.ts', import.meta.url),
        'utf8',
      ).trim(),
    );
  h.dependencies.createClient = () => ({
    remove() {},
    invoke(_kind, input) {
      const catalog = {
        version: 2,
        complete: true,
        namespaceKeyCounts: { 'moderation-actions': 1 },
        cost: {
          pages: 1,
          scanCountHints: 4096,
          matchedKeys: 1,
          keyBytes: 64,
          bytes: 100,
          measurementBytes: 100,
          databaseKeysMax: 10,
          serverDurationUs: 100,
          maxCallDurationUs: 100,
          durationMs: 1,
        },
        issue: null,
      };
      return {
        version: 1,
        operation: 'admission_preview',
        applied: false,
        activationAuthorized: false,
        stoppingAuthorized: false,
        sourceSha,
        imageId,
        decision: 'READY_FOR_COLD_REVIEW',
        sourceCoverageComplete: true,
        issues: [],
        selectionSha256: canonical(input.selection),
        registrySha256: hash,
        publisherCatalogSha256: canonical({ publisherBotId: 'publisher' }),
        selectedOwners: [
          {
            ownerWebhookEventId: selected.ownerId,
            claimId: selected.claimId,
            semanticKey: selected.semanticKey,
            chatId: selected.chatId,
            messageId: selected.messageId,
            userId: 'private_user',
            sourceAt: '2026-10-09T15:00:00.000Z',
            rawPayloadSha256: hash,
            normalizedPayloadSha256: hash,
            ownerSnapshotSha256: hash,
            claimSnapshotSha256: hash,
          },
        ],
        cost: { pages: 1, rows: 1, probes: 1, bytes: 100 },
        redisCatalogs: [catalog, structuredClone(catalog)],
      };
    },
  });
  const preview = await h.preview();
  assert.equal(preview.feasible, true);
  assert.equal(preview.children, 1);
  assert.equal(preview.selectedOwners, 1);
  assert.equal(preview.admissionCalls, 1);
});
