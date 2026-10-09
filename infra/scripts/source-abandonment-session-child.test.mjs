import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyColdDigest } from './legacy-cold-journal.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import { parseSourceAbandonmentHostRequest } from './source-abandonment-host.mjs';
import {
  createSourceAbandonmentChildStoreView,
  runSourceAbandonmentSessionChild,
  validateSourceAbandonmentSessionChild,
} from './source-abandonment-session-child.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => legacyColdDigest(`${JSON.stringify(value)}\n`);
function fixture() {
  const sourceSha = 'b'.repeat(40);
  const selection = parseSourceAbandonmentHostRequest(
    JSON.stringify({
      version: 1,
      operation: 'preflight',
      targetSha: sourceSha,
      selection: {
        protocol: 'source-abandonment-v1',
        abandonBefore: '2026-10-07T03:00:00.000Z',
        ownerWebhookEventIds: ['owner_one'],
        majorBotIds: ['major_one'],
      },
    }),
  ).selection;
  const bindings = {
    clusterIdentity: '11111111-1111-4111-8111-111111111111',
    epoch: 1,
    controllerNonce: '22222222-2222-4222-8222-222222222222',
    certificateId: '33333333-3333-4333-8333-333333333333',
    baselineDigest: 'a'.repeat(64),
    sourceSha,
    targetSha: sourceSha,
    targetImageId: `sha256:${'c'.repeat(64)}`,
    topologyDigest: 'd'.repeat(64),
    selectionDigest: legacyColdDigest(selection),
  };
  const base = {
    version: 1,
    complete: true,
    sourceSha,
    imageId: bindings.targetImageId,
    controllerNonce: bindings.controllerNonce,
    selectionDigest: bindings.selectionDigest,
  };
  const pending = {
    ...base,
    previewDigest: 'e'.repeat(64),
    inventoryDigest: 'f'.repeat(64),
    inventoryArtifactSha256: 'a'.repeat(64),
    unknownSources: 0,
    saturated: false,
    inventory: {
      binding: {
        maintenanceId: bindings.controllerNonce,
        queueFenceNonce: legacyColdDigest(bindings.controllerNonce),
        transitionJournalSha256: '1'.repeat(64),
        sourceSha,
        imageId: bindings.targetImageId,
      },
      selectedOwners: [{ ownerWebhookEventId: 'owner_one', chatId: 'private_chat' }],
    },
  };
  const reviewed = {
    version: 1,
    previewDigest: pending.previewDigest,
    inventoryDigest: pending.inventoryDigest,
    selectionDigest: bindings.selectionDigest,
  };
  const proofValues = new Map();
  function record(value) {
    const result = digest(value);
    proofValues.set(result, clone(value));
    return result;
  }
  const state = {
    certificate: 'ABSENT',
    events: [],
    faults: {},
    parentBlocked: false,
    installCount: 0,
    child: {
      version: 1,
      kind: 'source_abandonment_session_child',
      sessionId: '44444444-4444-4444-8444-444444444444',
      manifestDigest: '2'.repeat(64),
      childIndex: 0,
      revision: 1,
      phase: 'REVIEWED',
      bindings,
      selection,
      proofs: { pendingInventory: record(pending), reviewedPreview: record(reviewed) },
      blockedReason: null,
    },
  };
  const cas = (expected) => assert.equal(expected, legacyColdDigest(state.child));
  const store = {
    read: () => ({ child: clone(state.child) }),
    readProof: (name) => clone(proofValues.get(state.child.proofs[name])),
    recordProof: record,
    markAttempted(expected, proofs) {
      state.events.push('markAttempted');
      cas(expected);
      if (state.faults.beforeAttempt) throw new Error('crash_before_attempt');
      state.child = {
        ...state.child,
        revision: state.child.revision + 1,
        phase: 'ATTEMPTED',
        proofs: { ...state.child.proofs, ...proofs },
        blockedReason: null,
      };
      if (state.faults.afterAttempt) throw new Error('crash_after_attempt_fsync');
      return clone(state.child);
    },
    markMaterialized(expected, proofs) {
      state.events.push('markMaterialized');
      cas(expected);
      if (state.faults.beforeMaterialized) throw new Error('crash_before_materialized');
      state.child = {
        ...state.child,
        revision: state.child.revision + 1,
        phase: 'MATERIALIZED',
        proofs: { ...state.child.proofs, ...proofs },
        blockedReason: null,
      };
      if (state.faults.afterMaterialized) throw new Error('crash_after_materialized_fsync');
      return clone(state.child);
    },
    block(expected, reason, proofs) {
      state.events.push('block');
      cas(expected);
      state.parentBlocked = true;
      if (state.child.phase !== 'MATERIALIZED')
        state.child = {
          ...state.child,
          revision: state.child.revision + 1,
          blockedReason: reason,
          proofs: { ...state.child.proofs, ...proofs },
        };
    },
  };
  const stopped = {
    ...base,
    unreviewedProducers: 0,
    services: LEGACY_COLD_API_SERVICES.map((serviceName) => ({
      serviceName,
      stopped: true,
      exactGeneration: true,
      restartPolicy: 'unless-stopped',
    })),
    auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map((serviceName) => ({
      serviceName,
      stopped: true,
      exactGeneration: true,
      restartPolicy: 'unless-stopped',
    })),
  };
  const fence = {
    ...base,
    queueCount: 24,
    pausedCount: 24,
    activeCount: 0,
    ownerNonce: bindings.controllerNonce,
  };
  const implementations = {
    removeStoreClient() {},
    readStoppedRuntime: () => clone(stopped),
    readQueueFence: () => clone(fence),
    snapshotPending: () => ({
      ...clone(pending),
      recheckProof: record({ version: 1, fresh: true }),
    }),
    installDispositions() {
      state.installCount++;
      state.certificate = 'SEALED';
    },
    readSeal: () => ({
      ...base,
      previewDigest: pending.previewDigest,
      inventoryDigest: pending.inventoryDigest,
      permanentHoldsComplete: ['SEALED', 'MATERIALIZED'].includes(state.certificate),
      ownerProofsComplete: ['SEALED', 'MATERIALIZED'].includes(state.certificate),
      reviewedChatCursorsComplete: state.certificate === 'MATERIALIZED',
    }),
    materializeReceipts() {
      state.certificate = 'MATERIALIZED';
    },
  };
  const overrides = {};
  const adapters = Object.fromEntries(
    Object.entries(implementations).map(([name, operation]) => [
      name,
      async (...args) => {
        state.events.push(name);
        return (overrides[name] ?? operation)(...args);
      },
    ]),
  );
  for (const name of [
    'stopRuntime',
    'startBoundRuntime',
    'pauseQueues',
    'resumeQueues',
    'strictSmokes',
  ]) {
    adapters[name] = () => {
      throw new Error(`forbidden lifecycle call ${name}`);
    };
  }
  const run = (reconcile = false, extra = {}) =>
    runSourceAbandonmentSessionChild({
      store,
      adapters,
      expectedChildDigest: legacyColdDigest(state.child),
      reviewedPreviewDigest: pending.previewDigest,
      reviewedInventoryDigest: pending.inventoryDigest,
      reconcile,
      ...extra,
    });
  return {
    state,
    store,
    adapters,
    overrides,
    implementations,
    stopped,
    fence,
    pending,
    proofValues,
    run,
  };
}

test('store-only child durably marks attempt before creation and stays stopped after positive materialization', async () => {
  const h = fixture();
  const result = await h.run();
  assert.equal(result.childMaterialized, true);
  assert.equal(result.runtimeStarted, false);
  assert.equal(result.queuesResumed, false);
  assert.equal(result.parentComplete, false);
  assert.equal(result.fleetRecoveryProven, false);
  assert.equal(h.state.child.phase, 'MATERIALIZED');
  assert.equal(h.state.installCount, 1);
  const events = h.state.events;
  assert.ok(events.indexOf('markAttempted') < events.indexOf('installDispositions'));
  assert.ok(
    events.indexOf('removeStoreClient', events.indexOf('installDispositions')) <
      events.indexOf('readSeal'),
  );
  assert.ok(events.indexOf('readSeal') < events.indexOf('materializeReceipts'));
  assert.ok(events.lastIndexOf('removeStoreClient') < events.indexOf('markMaterialized'));
  validateSourceAbandonmentSessionChild(h.state.child);
  const final = h.store.readProof('materializedSeal');
  assert.equal(final.certificateId, h.state.child.bindings.certificateId);
  assert.equal(final.proof.reviewedChatCursorsComplete, true);
  assert.doesNotMatch(JSON.stringify(result), /private_chat|owner_one|major_one/);
});
test('stock adapter facade exposes the honest child journal and its own proof namespace', () => {
  const h = fixture();
  const view = createSourceAbandonmentChildStoreView(h.store);
  assert.deepEqual(view.read().journal, h.state.child);
  assert.deepEqual(view.readProof('pendingInventory'), h.pending);
  assert.equal(view.read().journal.kind, 'source_abandonment_session_child');
  assert.equal(Object.hasOwn(view, 'advance'), false);
  assert.equal(Object.hasOwn(view, 'resumeQueues'), false);
});
test('PENDING supports first inventory without pretending review or admitting a writer', async () => {
  const h = fixture();
  h.state.child.phase = 'PENDING';
  h.state.child.proofs = {};
  assert.equal(createSourceAbandonmentChildStoreView(h.store).read().journal.phase, 'PENDING');
  await assert.rejects(h.run(), /session_child_review_required/);
  assert.deepEqual(h.state.events, []);
});
test('existing cap remains eight and legacy or changed cutoff selections cannot enter the child', () => {
  const h = fixture();
  const selection = h.state.child.selection;
  selection.ownerWebhookEventIds = Array.from({ length: 8 }, (_, index) => `owner_${index}`);
  h.state.child.bindings.selectionDigest = legacyColdDigest(selection);
  validateSourceAbandonmentSessionChild(h.state.child);
  selection.ownerWebhookEventIds.push('owner_8');
  h.state.child.bindings.selectionDigest = legacyColdDigest(selection);
  assert.throws(
    () => validateSourceAbandonmentSessionChild(h.state.child),
    /source_selection_budget/,
  );
  selection.ownerWebhookEventIds = ['owner'];
  selection.protocol = 'legacy';
  h.state.child.bindings.selectionDigest = legacyColdDigest(selection);
  assert.throws(
    () => validateSourceAbandonmentSessionChild(h.state.child),
    /source_cutoff_required/,
  );
});
for (const change of [
  (child) => {
    child.kind = 'legacy_cold_journal';
  },
  (child) => {
    child.phase = 'COMPLETE';
  },
  (child) => {
    child.bindings.certificateId = 'new_certificate';
  },
  (child) => {
    child.bindings.sourceSha = 'c'.repeat(40);
  },
  (child) => {
    child.proofs.secret = 'a'.repeat(64);
  },
])
  test(`child rejects invalid immutable shape ${String(change)}`, () => {
    const h = fixture();
    change(h.state.child);
    assert.throws(() => validateSourceAbandonmentSessionChild(h.state.child));
  });
test('stale child CAS digest and changed explicit review cause no calls or writes', async () => {
  const h = fixture();
  await assert.rejects(
    h.run(false, { expectedChildDigest: '0'.repeat(64) }),
    /session_child_review_required/,
  );
  await assert.rejects(
    h.run(false, { reviewedInventoryDigest: '0'.repeat(64) }),
    /session_child_pending_unproved/,
  );
  assert.deepEqual(h.state.events, []);
});
test('retained private evidence corruption cannot create an attempt', async () => {
  const h = fixture();
  const proof = h.proofValues.get(h.state.child.proofs.pendingInventory);
  proof.inventory.binding.imageId = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(h.run(), /session_child_retained_proof_changed/);
  assert.deepEqual(h.state.events, []);
});
for (const [name, mutate] of [
  [
    'stopped generation',
    (h) => {
      h.stopped.services[0].stopped = false;
    },
  ],
  [
    'queue fence',
    (h) => {
      h.fence.activeCount = 1;
    },
  ],
  [
    'inventory digest',
    (h) => {
      h.overrides.snapshotPending = () => ({ ...h.pending, previewDigest: '0'.repeat(64) });
    },
  ],
  [
    'inventory body',
    (h) => {
      h.overrides.snapshotPending = () => ({ ...h.pending, extra: true });
    },
  ],
])
  test(`${name} drift blocks child before any attempt or installation`, async () => {
    const h = fixture();
    mutate(h);
    await assert.rejects(h.run(), /session_child_refused/);
    assert.equal(h.state.installCount, 0);
    assert.equal(h.state.events.includes('markAttempted'), false);
    assert.equal(h.state.parentBlocked, true);
  });
for (const fault of ['beforeAttempt', 'afterAttempt'])
  test(`crash ${fault} never reaches install`, async () => {
    const h = fixture();
    h.state.faults[fault] = true;
    await assert.rejects(h.run(), /session_child_refused/);
    assert.equal(h.state.installCount, 0);
    assert.equal(h.state.child.phase, fault === 'beforeAttempt' ? 'REVIEWED' : 'ATTEMPTED');
    assert.equal(h.state.parentBlocked, true);
    if (fault === 'afterAttempt') {
      h.state.faults = {};
      await assert.rejects(h.run(true), /session_child_refused/);
      assert.equal(h.state.installCount, 0);
    }
  });
test('lost install response reconciles only a positively sealed original certificate', async () => {
  const h = fixture();
  h.overrides.installDispositions = () => {
    h.state.installCount++;
    h.state.certificate = 'SEALED';
    throw Object.assign(new Error('response_lost'), { outcomeUnknown: true });
  };
  assert.equal((await h.run()).childMaterialized, true);
  assert.equal(h.state.installCount, 1);
});
for (const certificate of ['ABSENT', 'UNSEALED'])
  test(`unknown ${certificate} outcome stays attempted and never replays creation/install`, async () => {
    const h = fixture();
    h.overrides.installDispositions = () => {
      h.state.installCount++;
      h.state.certificate = certificate;
      throw Object.assign(new Error('response_lost'), { outcomeUnknown: true });
    };
    await assert.rejects(h.run(), /session_child_refused/);
    const attemptedDigest = h.state.child.proofs.attemptEvidence;
    assert.equal(h.state.child.phase, 'ATTEMPTED');
    h.state.events = [];
    await assert.rejects(h.run(true), /session_child_refused/);
    assert.equal(h.state.installCount, 1);
    assert.equal(h.state.child.proofs.attemptEvidence, attemptedDigest);
    assert.equal(h.state.events.includes('snapshotPending'), false);
    assert.equal(h.state.events.includes('installDispositions'), false);
    assert.equal(h.state.events.includes('materializeReceipts'), false);
  });
test('failed materialization resumes from original sealed certificate without install or new inventory', async () => {
  const h = fixture();
  h.overrides.materializeReceipts = () => {
    throw new Error('materialization_budget');
  };
  await assert.rejects(h.run(), /session_child_refused/);
  assert.equal(h.state.certificate, 'SEALED');
  h.state.events = [];
  delete h.overrides.materializeReceipts;
  const result = await h.run(true);
  assert.equal(result.childMaterialized, true);
  assert.equal(h.state.installCount, 1);
  assert.equal(h.state.events.includes('snapshotPending'), false);
  assert.equal(h.state.events.includes('installDispositions'), false);
  assert.equal(h.state.events.includes('materializeReceipts'), true);
});
test('unknown materialization response does not repeat pages once independent readback proves complete', async () => {
  const h = fixture();
  h.overrides.materializeReceipts = () => {
    h.state.certificate = 'MATERIALIZED';
    throw new Error('lost_page_response');
  };
  await assert.rejects(h.run(), /session_child_refused/);
  h.state.events = [];
  assert.equal((await h.run(true)).childMaterialized, true);
  assert.equal(h.state.events.includes('materializeReceipts'), false);
  assert.equal(h.state.installCount, 1);
});
for (const fault of ['beforeMaterialized', 'afterMaterialized'])
  test(`crash ${fault} reconciles completed certificate by readback only`, async () => {
    const h = fixture();
    h.state.faults[fault] = true;
    await assert.rejects(h.run(), /session_child_refused/);
    assert.equal(
      h.state.child.phase,
      fault === 'beforeMaterialized' ? 'ATTEMPTED' : 'MATERIALIZED',
    );
    h.state.faults = {};
    h.state.events = [];
    assert.equal((await h.run(true)).childMaterialized, true);
    assert.equal(h.state.events.includes('installDispositions'), false);
    assert.equal(h.state.events.includes('materializeReceipts'), false);
    assert.equal(h.state.installCount, 1);
  });
test('already materialized reconciliation makes no phase write and never claims parent completion', async () => {
  const h = fixture();
  await h.run();
  const before = clone(h.state.child);
  h.state.events = [];
  const result = await h.run(true);
  assert.deepEqual(h.state.child, before);
  assert.equal(result.parentComplete, false);
  for (const name of [
    'snapshotPending',
    'installDispositions',
    'materializeReceipts',
    'markAttempted',
    'markMaterialized',
  ])
    assert.equal(h.state.events.includes(name), false);
});
test('materialized cursor regression blocks parent while preserving child original positive evidence', async () => {
  const h = fixture();
  await h.run();
  const before = clone(h.state.child);
  h.state.certificate = 'SEALED';
  h.state.events = [];
  await assert.rejects(h.run(true), /session_child_refused/);
  assert.deepEqual(h.state.child, before);
  assert.equal(h.state.parentBlocked, true);
  assert.equal(h.state.events.includes('materializeReceipts'), false);
});
test('bad acknowledgement after ATTEMPTED CAS cannot reach writer', async () => {
  const h = fixture();
  const original = h.store.markAttempted;
  h.store.markAttempted = (...args) => ({ ...original(...args), revision: 999 });
  await assert.rejects(h.run(), /session_child_refused/);
  assert.equal(h.state.child.phase, 'ATTEMPTED');
  assert.equal(h.state.installCount, 0);
});
test('changed immutable child during a callback cannot be re-used or blocked under old identity', async () => {
  const h = fixture();
  const original = h.store.markAttempted;
  h.store.markAttempted = (...args) => {
    original(...args);
    h.state.child.bindings.certificateId = '55555555-5555-4555-8555-555555555555';
    return clone(h.state.child);
  };
  await assert.rejects(
    h.run(),
    (error) =>
      error.message === 'session_child_refused' &&
      error.containment.journalBlocked === false &&
      error.parentContainmentRequired === true,
  );
  assert.equal(h.state.installCount, 0);
});
for (const stage of [
  'removeStoreClient',
  'readSeal',
  'materializeReceipts',
  'readStoppedRuntime',
  'readQueueFence',
])
  test(`failure at ${stage} never invokes lifecycle callbacks`, async () => {
    const h = fixture();
    h.overrides[stage] = () => {
      throw new Error('private_failure');
    };
    await assert.rejects(
      h.run(),
      (error) =>
        error.message === 'session_child_refused' &&
        error.runtimeStarted === false &&
        error.queuesResumed === false &&
        error.parentContainmentRequired,
    );
    assert.equal(h.state.parentBlocked, true);
  });

test('selection binding retains exact bytes without depending on object property order', () => {
  const h = fixture();
  const old = h.state.child.selection;
  h.state.child.selection = {
    protocol: old.protocol,
    abandonBefore: old.abandonBefore,
    ownerWebhookEventIds: old.ownerWebhookEventIds,
    majorBotIds: old.majorBotIds,
  };
  h.state.child.bindings.selectionDigest = legacyColdDigest(h.state.child.selection);
  validateSourceAbandonmentSessionChild(h.state.child);
});
