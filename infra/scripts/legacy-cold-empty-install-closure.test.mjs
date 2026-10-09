import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyDigest as digest,
  canonicalEmptyDigest as canonical,
} from './legacy-cold-empty-install-proof.mjs';
import {
  buildEmptyInstallWitnessRequest,
  EMPTY_ABORT_API_SERVICES,
} from './legacy-cold-empty-install-proof.mjs';
import * as stock from './legacy-cold-journal.mjs';
import { prepareLegacyColdRecovery } from './legacy-cold-protocol.mjs';
const copy = (x) => JSON.parse(JSON.stringify(x));
const save = (p, v) =>
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v) + '\n', { mode: 0o600 });
const mkdir = (p) => fs.mkdirSync(p, { mode: 0o700 });

async function fixture(t, { alterSidecar } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'maxim-empty-closure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rawStore = stock.createLegacyColdJournalStore({ directory: dir, assertLock: () => {} });
  const hash = 'a'.repeat(64),
    source = 'b'.repeat(40),
    image = 'sha256:' + hash,
    nonce = '11111111-1111-4111-8111-111111111111';
  const selection = { ownerWebhookEventIds: ['owner'], majorBotIds: ['bot'] };
  const b = {
    clusterIdentity: '33333333-3333-4333-8333-333333333333',
    epoch: 1,
    controllerNonce: nonce,
    certificateId: '22222222-2222-4222-8222-222222222222',
    sourceSha: source,
    targetSha: source,
    targetImageId: image,
    baselineDigest: hash,
    topologyDigest: hash,
    selectionDigest: digest(selection),
  };
  const base = {
    version: 1,
    complete: true,
    sourceSha: source,
    imageId: image,
    controllerNonce: nonce,
    selectionDigest: b.selectionDigest,
  };
  const roles = [...EMPTY_ABORT_API_SERVICES, 'ocr-native-sandbox', 'photo-native-sandbox'].map(
    (serviceName, index) => ({
      serviceName,
      containerId: index.toString(16).padStart(64, '0'),
      sourceSha: source,
      imageId: image,
      stopped: true,
      exactGeneration: true,
      restartPolicy: 'unless-stopped',
      ...(index >= 14 ? { nativeBoundaryDigest: 'e'.repeat(64) } : {}),
    }),
  );
  const binding = {
    version: 1,
    sourceSha: source,
    imageId: image,
    transitionJournalSha256: hash,
    maintenanceId: nonce,
    queueFenceNonce: digest(nonce),
    stoppedGenerations: roles
      .map(({ serviceName, containerId, sourceSha, imageId, stopped }) => ({
        serviceName,
        containerId,
        sourceSha,
        imageId,
        stopped,
      }))
      .sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
  };
  const inventory = {
    version: 1,
    operation: 'inventory_preview',
    applied: false,
    activationAuthorized: false,
    decision: 'READY_TO_INSTALL',
    issues: [],
    binding,
    selectionSha256: canonical(selection),
    previewSha256: hash,
    inventorySha256: hash,
    selectedOwners: [{ ownerWebhookEventId: 'owner' }],
    children: [],
  };
  const pending = {
    ...base,
    previewDigest: hash,
    inventoryDigest: hash,
    inventoryArtifactSha256: digest(JSON.stringify(inventory) + '\n'),
    unknownSources: 0,
    saturated: false,
    inventory,
  };
  rawStore.seed({
    version: 1,
    clusterIdentity: b.clusterIdentity,
    epoch: 0,
    phase: 'NEVER_ADMITTED',
    complete: true,
  });
  const hostProof = rawStore.recordProof({ baseline: true }),
    pendingHash = rawStore.recordProof(pending),
    reviewHash = rawStore.recordProof({ previewDigest: hash, inventoryDigest: hash });
  let old = rawStore.admit(b, hostProof);
  for (const [phase, proofs] of [
    ['STOPPING', {}],
    ['STOPPED', { stoppedInventory: hostProof }],
    ['INVENTORIED', { pendingInventory: pendingHash, reviewedPreview: reviewHash }],
    ['INSTALLING', {}],
  ])
    old = rawStore.advance(digest(old), phase, proofs);
  const request = buildEmptyInstallWitnessRequest({ bindings: b, selection, pending });
  const witness = {
    version: 1,
    state: 'EMPTY_UNSEALED',
    protocol: 'legacy',
    certificateId: b.certificateId,
    sourceSha: source,
    imageId: image,
    attestationDigest: request.attestationDigest,
    previewSha256: hash,
    certificateSnapshotSha256: 'c'.repeat(64),
    offlineBindingSha256: canonical(binding),
    inventorySha256: hash,
    inventoryArtifactSha256: pending.inventoryArtifactSha256,
    selectionSha256: canonical(selection),
    transitionJournalSha256: hash,
    maintenanceId: nonce,
    queueFenceNonce: digest(nonce),
    readOnly: true,
    certificatePreserved: true,
    empty: {
      recoveries: true,
      children: true,
      authoritiesByCertificate: true,
      authoritiesByIdentity: true,
      cursors: true,
      dispositionsByAuthority: true,
    },
    observedAt: '2026-10-09T05:20:00.000Z',
  };
  const stopped = {
    ...base,
    unreviewedProducers: 0,
    services: roles.slice(0, 14),
    auxiliaries: roles.slice(14),
  };
  const fence = { ...base, queueCount: 24, pausedCount: 24, activeCount: 0, ownerNonce: nonce };
  const sidecar = {
    version: 1,
    operation: 'abort-empty-install',
    protocol: 'legacy',
    phase: 'EMPTY_INSTALL_ABORTED',
    revision: 4,
    originJournalDigest: digest(old),
    originJournal: old,
    createdAt: '2026-10-09T05:06:00.000Z',
    updatedAt: '2026-10-09T05:22:00.000Z',
    proofs: {
      emptyBefore: witness,
      emptyAfter: copy(witness),
      stoppedBefore: stopped,
      stoppedAfter: copy(stopped),
      fenceBefore: fence,
      fenceAfter: copy(fence),
    },
    result: {
      runtimeIdentity: {
        ...base,
        exactGenerationCount: 14,
        unreviewedProducers: 0,
        services: roles.slice(0, 14).map((r) => ({ ...r, stopped: false })),
        auxiliaries: roles.slice(14).map((r) => ({ ...r, stopped: false })),
      },
      nativeIdentity: { ...base, exactGenerationCount: 2 },
      strictSmokes: {
        ...base,
        ingressReady: false,
        adminReady: false,
        dependenciesReady: true,
        queueBacklogOnly: true,
        queuesResumed: true,
        actionableLagSeconds: 100,
      },
      fleetReady: false,
    },
  };
  alterSidecar?.(sidecar);
  const privateRoot = join(dir, 'legacy-cold-private'),
    operationDir = join(privateRoot, nonce);
  mkdir(privateRoot);
  mkdir(operationDir);
  save(join(operationDir, 'empty-install-abort.json'), sidecar);
  save(join(operationDir, 'context.json'), { version: 1, selection });
  const api = stock;
  const nextBindings = {
    ...b,
    epoch: 2,
    controllerNonce: '44444444-4444-4444-8444-444444444444',
    certificateId: '55555555-5555-4555-8555-555555555555',
    selectionDigest: hash,
    baselineDigest: digest({ nextBaseline: true }),
  };
  const nextHostProof = rawStore.recordProof({ nextBaseline: true });
  let lockCalls = 0;
  const store = api.createLegacyColdJournalStore({
    directory: dir,
    assertLock: () => {
      lockCalls++;
    },
  });
  return {
    dir,
    api,
    old,
    sidecar,
    operationDir,
    rawStore,
    nextBindings,
    nextHostProof,
    store,
    lockCalls: () => lockCalls,
    admit: () => store.admit(nextBindings, nextHostProof),
  };
}

test('exact successful abort permits ordinary guard with truthful INSTALLING journal', async (t) => {
  const f = await fixture(t),
    before = fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL));
  const state = f.api.assertNoActiveLegacyColdMaintenance(f.dir);
  assert.equal(state.journal.phase, 'INSTALLING');
  assert.equal(state.emptyInstallAbort.sidecarDigest, digest(f.sidecar));
  assert.deepEqual(fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL)), before);
  assert.deepEqual(f.store.read().emptyInstallAbort, state.emptyInstallAbort);
});
test('archive retains raw originals and every evidence file before stock next admission', async (t) => {
  const f = await fixture(t),
    oldBytes = fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL), 'utf8'),
    sideBytes = fs.readFileSync(join(f.operationDir, 'empty-install-abort.json'), 'utf8');
  const next = f.admit();
  assert.equal(next.phase, 'ADMITTED');
  assert.equal(next.bindings.epoch, 2);
  const archives = fs.readdirSync(join(f.dir, 'empty-install-closure-archives'));
  assert.equal(archives.length, 1);
  const raw = fs.readFileSync(join(f.dir, 'empty-install-closure-archives', archives[0]), 'utf8'),
    archive = JSON.parse(raw);
  assert.equal(archives[0], digest(raw) + '.json');
  assert.equal(archive.original.journalRaw, oldBytes);
  assert.equal(archive.original.sidecarRaw, sideBytes);
  assert.equal(archive.next.hostAdmissionDigest, f.nextHostProof);
  assert.equal(archive.original.proofs.length, Object.keys(f.old.proofs).length);
  for (const p of archive.original.proofs) assert.equal(digest(p.raw), p.sha256);
  assert.equal(f.store.read().emptyInstallAbort, undefined);
  assert.throws(() => f.admit());
  assert.throws(() => stock.assertNoActiveLegacyColdMaintenance(f.dir));
  assert.throws(() => f.api.assertNoActiveLegacyColdMaintenance(f.dir));
  assert.equal(
    fs.readFileSync(join(f.operationDir, 'empty-install-abort.json'), 'utf8'),
    sideBytes,
  );
});
test('normal modern completion returns to the unchanged stock guard', async (t) => {
  const f = await fixture(t);
  let j = f.admit();
  const h = f.nextHostProof;
  for (const [phase, proofs] of [
    ['STOPPING', {}],
    ['STOPPED', { stoppedInventory: h }],
    ['INVENTORIED', { pendingInventory: h, reviewedPreview: h }],
    ['INSTALLING', {}],
    ['SEALED', { sealedReadback: h }],
    ['RESUMING', {}],
    ['COMPLETE', { runtimeIdentity: h, nativeIdentity: h, strictSmokes: h }],
  ])
    j = f.store.advance(digest(j), phase, proofs);
  assert.equal(stock.assertNoActiveLegacyColdMaintenance(f.dir).journal.phase, 'COMPLETE');
});
for (const [name, alter] of [
  [
    'witness nonempty',
    (s) => {
      s.proofs.emptyAfter.empty.recoveries = false;
    },
  ],
  [
    'certificate changed',
    (s) => {
      s.proofs.emptyAfter.certificateSnapshotSha256 = 'd'.repeat(64);
    },
  ],
  [
    'stopped generation missing',
    (s) => {
      s.proofs.stoppedAfter.services.pop();
    },
  ],
  [
    'paused ownership changed',
    (s) => {
      s.proofs.fenceAfter.ownerNonce = 'foreign';
    },
  ],
  [
    'native identity incomplete',
    (s) => {
      s.result.nativeIdentity.exactGenerationCount = 1;
    },
  ],
  [
    'smokes incomplete',
    (s) => {
      s.result.strictSmokes.dependenciesReady = false;
    },
  ],
  [
    'false fleet claim',
    (s) => {
      s.result.fleetReady = true;
    },
  ],
  [
    'queues not resumed',
    (s) => {
      s.result.strictSmokes.queuesResumed = false;
    },
  ],
  [
    'future witness',
    (s) => {
      s.proofs.emptyAfter.observedAt = '2026-10-10T00:00:00.000Z';
    },
  ],
])
  test('rejects semantically invalid ' + name + ' even with matching fixture digest', async (t) => {
    const f = await fixture(t, { alterSidecar: alter });
    assert.throws(() => f.store.read());
    assert.throws(() => f.admit());
    assert.equal(
      JSON.parse(fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL))).phase,
      'INSTALLING',
    );
  });
for (const [field, value] of [
  ['epoch', 3],
  ['clusterIdentity', '66666666-6666-4666-8666-666666666666'],
  ['baselineDigest', 'd'.repeat(64)],
])
  test('rejects changed next binding ' + field, async (t) => {
    const f = await fixture(t);
    f.nextBindings[field] = value;
    assert.throws(() => f.admit());
    assert.equal(
      JSON.parse(fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL))).phase,
      'INSTALLING',
    );
  });
test('tampered proof and unsafe sidecar file never create an archive', async (t) => {
  const f = await fixture(t);
  fs.chmodSync(join(f.operationDir, 'empty-install-abort.json'), 0o644);
  assert.throws(() => f.admit());
  fs.chmodSync(join(f.operationDir, 'empty-install-abort.json'), 0o600);
  save(join(f.dir, 'legacy-cold-evidence', f.old.proofs.pendingInventory + '.json'), {
    tampered: true,
  });
  assert.throws(() => f.admit());
  assert.equal(fs.existsSync(join(f.dir, 'empty-install-closure-archives')), false);
});
test('next-admission containment cannot rewrite the original INSTALLING journal', async (t) => {
  const f = await fixture(t),
    before = fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL), 'utf8');
  assert.throws(
    () => f.store.block(digest(f.old), 'protocol_proof_failed'),
    /closed empty-install origin/,
  );
  assert.equal(fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL), 'utf8'), before);
  const next = f.admit();
  assert.equal(f.store.block(digest(next), 'protocol_proof_failed').phase, 'ADMITTED');
});
test('real stock protocol containment after archive sync failure preserves original bytes', async (t) => {
  const f = await fixture(t),
    before = fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL), 'utf8');
  const baseline = {
    version: 1,
    complete: true,
    sourceSha: f.nextBindings.targetSha,
    imageId: f.nextBindings.targetImageId,
    selectionDigest: f.nextBindings.selectionDigest,
    controllerNonce: f.nextBindings.controllerNonce,
    compatible: true,
    singletonCount: 14,
    nativeCount: 2,
    unreviewedProducers: 0,
  };
  f.nextBindings.baselineDigest = digest(baseline);
  const calls = [],
    adapters = Object.fromEntries(
      [
        'inspectRuntime',
        'stopRuntime',
        'readStoppedRuntime',
        'pauseQueues',
        'readQueueFence',
        'snapshotPending',
        'installDispositions',
        'removeStoreClient',
        'materializeReceipts',
        'readSeal',
        'startBoundRuntime',
        'readRuntimeIdentity',
        'readNativeIdentity',
        'resumeQueues',
        'strictSmokes',
      ].map((name) => [
        name,
        async () => {
          calls.push(name);
          if (name === 'inspectRuntime') return baseline;
          return {};
        },
      ]),
    );
  const originalFsync = fs.fsyncSync;
  let fired = false;
  fs.fsyncSync = (fd) => {
    if (
      !fired &&
      fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/empty-install-closure-archives')
    ) {
      fired = true;
      throw Object.assign(Error('simulated archive sync failure'), { code: 'EIO' });
    }
    return originalFsync(fd);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      prepareLegacyColdRecovery({ store: f.store, bindings: f.nextBindings, adapters }),
    );
  } finally {
    fs.fsyncSync = originalFsync;
    syncBuiltinESMExports();
  }
  assert.equal(fired, true);
  assert.ok(calls.includes('stopRuntime'));
  assert.ok(calls.includes('pauseQueues'));
  assert.equal(calls.includes('startBoundRuntime'), false);
  assert.equal(fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL), 'utf8'), before);
  assert.equal(f.rawStore.read().marker.epoch, 1);
});

// Real filesystem failures exercise durable write ordering. The injected errors
// affect only this disposable fixture; no test-only hook enters production APIs.
for (const stage of [
  'archive-file-fsync',
  'archive-rename',
  'archive-directory-fsync',
  'marker-file-fsync',
  'journal-file-fsync',
])
  test('crash safety at ' + stage, async (t) => {
    const f = await fixture(t),
      before = fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL), 'utf8');
    const originalFsync = fs.fsyncSync,
      originalRename = fs.renameSync;
    let fired = false;
    const fail = () => {
      fired = true;
      throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
    };
    fs.fsyncSync = (fd) => {
      const p = fs.readlinkSync('/proc/self/fd/' + fd);
      if (!fired) {
        if (stage === 'archive-file-fsync' && p.includes('/empty-install-closure-archives/.'))
          fail();
        if (stage === 'archive-directory-fsync' && p.endsWith('/empty-install-closure-archives'))
          fail();
        if (stage === 'marker-file-fsync' && p.includes('/.legacy-cold-identity.json.')) fail();
        if (stage === 'journal-file-fsync' && p.includes('/.legacy-cold-maintenance.json.')) fail();
      }
      return originalFsync(fd);
    };
    fs.renameSync = (a, b) => {
      if (!fired && stage === 'archive-rename' && a.includes('/empty-install-closure-archives/.'))
        fail();
      return originalRename(a, b);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => f.admit());
      assert.equal(fired, true);
    } finally {
      fs.fsyncSync = originalFsync;
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    }
    assert.equal(fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL), 'utf8'), before);
    if (stage !== 'archive-directory-fsync')
      assert.throws(() => stock.assertNoActiveLegacyColdMaintenance(f.dir));
    if (['archive-file-fsync', 'archive-rename'].includes(stage))
      assert.throws(() => f.admit(), /archive_interrupted/);
    else if (stage === 'archive-directory-fsync') {
      assert.equal(
        JSON.parse(fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL))).phase,
        'INSTALLING',
      );
      assert.equal(
        fs
          .readdirSync(join(f.dir, 'empty-install-closure-archives'))
          .filter((n) => !n.startsWith('.')).length,
        1,
      );
    } else assert.throws(() => f.rawStore.read(), /interrupted durable write|missing or stale/);
  });

test('ABORTING is readable but never authorizes ordinary mutation or admission', async (t) => {
  const f = await fixture(t, {
    alterSidecar: (s) => {
      s.phase = 'EMPTY_INSTALL_ABORTING';
      s.result = null;
    },
  });
  assert.equal(f.store.read().emptyInstallAbort.phase, 'EMPTY_INSTALL_ABORTING');
  assert.throws(() => stock.assertNoActiveLegacyColdMaintenance(f.dir), /active cold epoch/);
  assert.throws(() => f.admit(), /active cold epoch/);
  assert.throws(
    () => f.store.block(digest(f.old), 'protocol_proof_failed'),
    /closed empty-install origin/,
  );
});

for (const phase of ['EMPTY_INSTALL_ABORTING', 'EMPTY_INSTALL_ABORTED'])
  test('every origin journal mutator refuses ' + phase, async (t) => {
    const f = await fixture(t, {
      alterSidecar: (s) => {
        s.phase = phase;
        if (phase === 'EMPTY_INSTALL_ABORTING') s.result = null;
      },
    });
    const before = fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL));
    for (const method of [
      'seed',
      'advance',
      'reconcileSealed',
      'retryPreinstall',
      'beginAbortPreinstall',
      'finishAbortPreinstall',
      'refreezePreinstall',
      'block',
    ]) {
      assert.throws(
        () => f.store[method](digest(f.old), {}),
        /closed empty-install origin/,
        method,
      );
      assert.deepEqual(fs.readFileSync(join(f.dir, stock.LEGACY_COLD_JOURNAL)), before);
    }
  });

for (const [name, alter] of [
  [
    'runtime container changed',
    (s) => {
      s.result.runtimeIdentity.services[0].containerId = 'f'.repeat(64);
    },
  ],
  [
    'runtime service placed in native slot',
    (s) => {
      const v = s.result.runtimeIdentity;
      [v.services[0], v.auxiliaries[0]] = [v.auxiliaries[0], v.services[0]];
    },
  ],
  [
    'runtime generation still stopped',
    (s) => {
      s.result.runtimeIdentity.services[0].stopped = true;
    },
  ],
  [
    'runtime native boundary changed',
    (s) => {
      s.result.runtimeIdentity.auxiliaries[0].nativeBoundaryDigest = 'f'.repeat(64);
    },
  ],
  [
    'both stopped inventories changed',
    (s) => {
      for (const name of ['stoppedBefore', 'stoppedAfter'])
        s.proofs[name].services[0].containerId = 'f'.repeat(64);
    },
  ],
  [
    'witness attestation changed',
    (s) => {
      s.proofs.emptyAfter.attestationDigest = 'f'.repeat(64);
    },
  ],
  [
    'witness offline binding changed',
    (s) => {
      s.proofs.emptyAfter.offlineBindingSha256 = 'f'.repeat(64);
    },
  ],
  [
    'original journal bytes changed',
    (s) => {
      s.originJournal.blockedReason = 'protocol_proof_failed';
      s.originJournalDigest = digest(s.originJournal);
    },
  ],
])
  test('rejects ' + name, async (t) => {
    const f = await fixture(t, { alterSidecar: alter });
    assert.throws(() => stock.assertNoActiveLegacyColdMaintenance(f.dir));
    assert.throws(() => f.admit());
    assert.equal(fs.existsSync(join(f.dir, 'empty-install-closure-archives')), false);
  });

for (const unsafe of ['symlink', 'hardlink', 'pending', 'missing', 'context'])
  test('refuses ' + unsafe + ' sidecar authority', async (t) => {
    const f = await fixture(t),
      file = join(f.operationDir, 'empty-install-abort.json');
    if (unsafe === 'symlink') {
      fs.renameSync(file, file + '.saved');
      fs.symlinkSync(file + '.saved', file);
    }
    if (unsafe === 'hardlink') fs.linkSync(file, file + '.link');
    if (unsafe === 'pending')
      save(join(f.operationDir, '.empty-install-abort-pending.tmp'), 'pending');
    if (unsafe === 'missing') fs.unlinkSync(file);
    if (unsafe === 'context')
      save(join(f.operationDir, 'context.json'), {
        selection: { ownerWebhookEventIds: ['changed'], majorBotIds: ['bot'] },
      });
    assert.throws(() => stock.assertNoActiveLegacyColdMaintenance(f.dir));
    assert.throws(() => f.admit());
  });

test('next admission may change source and selection after closure without private incident pins', async (t) => {
  const f = await fixture(t);
  f.nextBindings.sourceSha = 'd'.repeat(40);
  f.nextBindings.targetSha = 'e'.repeat(40);
  f.nextBindings.targetImageId = 'sha256:' + 'f'.repeat(64);
  f.nextBindings.selectionDigest = 'c'.repeat(64);
  const next = f.admit();
  assert.deepEqual(next.bindings, f.nextBindings);
});
