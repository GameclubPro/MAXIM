import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrderedAnchorInventory } from './webhook-ordered-anchor-inventory-cli.mjs';
import { canonicalLegacyColdDigest as canonical } from './legacy-cold-store-adapter.mjs';
import {
  sourceAbandonmentSessionDigest as digest,
  SOURCE_ABANDONMENT_SESSION_LIMITS,
} from './source-abandonment-session-journal.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import { sourceAbandonmentSessionRuntimeBindings } from './source-abandonment-session-protocol.mjs';
import { readSourceAbandonmentSessionQueueRegistry } from './source-abandonment-session-host.mjs';
import {
  readSourceAbandonmentSessionEnumeration,
  planSourceAbandonmentSessionChildren,
  createSourceAbandonmentSessionFrozenInventory,
} from './source-abandonment-session-inventory.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const proofDigest = (proof) => sha256(`${JSON.stringify(proof)}\n`);
const clone = structuredClone;
const hash = 'c'.repeat(64);
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const request = {
  version: 2,
  inventoryId: uuid(1),
  sourceSha: 'a'.repeat(40),
  imageId: `sha256:${'b'.repeat(64)}`,
  cutoff: '2026-10-09T16:10:00.000Z',
};
const runtime = {
  id: 'd'.repeat(64),
  imageId: request.imageId,
  running: true,
  startedAt: '2026-10-08T16:10:00.000Z',
  restarts: 0,
  sourceSha: request.sourceSha,
};
const queueNames = readSourceAbandonmentSessionQueueRegistry(request.sourceSha, () =>
  readFileSync(
    new URL('../../apps/api/src/scripts/legacy-recovery-live-registry.ts', import.meta.url),
    'utf8',
  ).trim(),
).queueNames;
const timestamp = (n) => `2026-10-09T15:00:00.${String(n).padStart(6, '0')}Z`;

function row(n = 1, overrides = {}) {
  return {
    orderChatId: '-private_actual_chat',
    id: `private_receipt_${String(n).padStart(6, '0')}`,
    createdAt: timestamp(n),
    status: 'FAILED',
    normalizedBounded: true,
    ordered: true,
    chatId: '-private_actual_chat',
    messageId: `private_message_${n}`,
    semanticKey: `private_semantic_${n}`,
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
      id: `private_claim_${n}`,
      ownerId: `private_owner_${n}`,
      status: 'READY',
      enforced: true,
      prepared: true,
      started: true,
      completed: false,
      lease: 'expired',
      checkpoint: 'waiting_marker',
    },
    ...overrides,
  };
}
function unresolvedRow(n) {
  const value = row(n);
  value.claim.started = false;
  return value;
}
function page(parameters, rows, hasMore = false, overrides = {}) {
  const last = rows.at(-1);
  return {
    version: 2,
    kind: 'ordered_anchor_inventory_page',
    readOnly: true,
    observedAt: '2026-10-09T16:20:00.000000Z',
    ...parameters,
    rawCount: rows.length + (hasMore ? 1 : 0),
    hasMore,
    nextCursor: last ? { chatId: last.orderChatId, createdAt: last.createdAt, id: last.id } : null,
    rows,
    coverage: 'ONLINE_PREVIEW',
    mutationAuthorized: false,
    ...overrides,
  };
}
function writeWalk(t, rows, { pageLimit = 50, observedAt } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-session-inventory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = runOrderedAnchorInventory({
    directory,
    request,
    pageLimit,
    attest: () => runtime,
    readPage(parameters) {
      const start = parameters.after
        ? rows.findIndex((value) => value.id === parameters.after.id) + 1
        : 0;
      const nextRows = rows.slice(start, start + 200);
      return {
        page: page(
          parameters,
          nextRows,
          start + 200 < rows.length,
          observedAt ? { observedAt } : {},
        ),
        plan: { bounded: true },
      };
    },
  });
  const options = {
    directory,
    expectedCheckpointSha256: result.checkpointSha256,
    expectedRequest: request,
  };
  return {
    directory,
    result,
    options,
    read: () => readSourceAbandonmentSessionEnumeration(options),
  };
}

function admission(selection, enumeration) {
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
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    decision: 'READY_FOR_COLD_REVIEW',
    sourceCoverageComplete: true,
    issues: [],
    selectionSha256: canonical(selection),
    registrySha256: hash,
    publisherCatalogSha256: canonical({ publisherBotId: 'publisher' }),
    selectedOwners: selection.ownerWebhookEventIds.map((ownerId) => {
      const value = enumeration.authorities.find((entry) => entry.ownerId === ownerId);
      return {
        ownerWebhookEventId: value.ownerId,
        claimId: value.claimId,
        semanticKey: value.semanticKey,
        chatId: value.chatId,
        messageId: value.messageId,
        userId: 'private_user',
        sourceAt: '2026-10-09T15:00:00.000Z',
        rawPayloadSha256: hash,
        normalizedPayloadSha256: hash,
        ownerSnapshotSha256: hash,
        claimSnapshotSha256: hash,
      };
    }),
    cost: { pages: 2, rows: selection.ownerWebhookEventIds.length, probes: 2, bytes: 200 },
    redisCatalogs: [clone(catalog), clone(catalog)],
  };
}
function planner(enumeration, transform = (value) => value) {
  const calls = [],
    proofs = [];
  let certificate = 10,
    active = 0,
    peak = 0;
  return {
    calls,
    proofs,
    peak: () => peak,
    options: {
      enumeration,
      majorBotIds: ['major'],
      queueNames,
      publisherBotId: 'publisher',
      now: () => 1000,
      deadlineAtMs: 60000,
      certificateId: () => uuid(certificate++),
      async collectAdmission(input) {
        calls.push(clone(input));
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return transform(admission(input.selection, enumeration), input);
      },
      recordProof(value) {
        proofs.push(clone(value));
        return proofDigest(value);
      },
    },
  };
}

test('enumeration reconstructs full immutable v2 chain and deduplicates actual claim owners', (t) => {
  const original = row(1),
    mirror = row(2, {
      claim: clone(original.claim),
      messageId: original.messageId,
      semanticKey: original.semanticKey,
    });
  const walk = writeWalk(t, [original, mirror]);
  const result = walk.read();
  assert.equal(result.version, 1);
  assert.equal(result.kind, 'source_abandonment_session_enumeration');
  assert.deepEqual(result.request, request);
  assert.deepEqual(result.runtime, runtime);
  assert.equal(result.checkpointSha256, walk.result.checkpointSha256);
  assert.equal(result.report.complete, true);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.authorities, [
    {
      ownerId: original.claim.ownerId,
      claimId: original.claim.id,
      semanticKey: original.semanticKey,
      chatId: original.chatId,
      messageId: original.messageId,
    },
  ]);
  assert.equal(result.unresolvedCount, 0);
  assert.match(result.enumerationDigest, /^[a-f0-9]{64}$/u);
});

test('enumeration refuses incomplete traversal even when it retained 200 valid observations', (t) => {
  const walk = writeWalk(
    t,
    Array.from({ length: 201 }, (_, i) => row(i + 1)),
    { pageLimit: 1 },
  );
  assert.equal(walk.result.report.complete, false);
  assert.throws(walk.read);
});

test('enumeration refuses stale checkpoint, changed request and altered page before returning authority', (t) => {
  const walk = writeWalk(t, [row(1)]);
  assert.throws(() =>
    readSourceAbandonmentSessionEnumeration({
      ...walk.options,
      expectedCheckpointSha256: 'e'.repeat(64),
    }),
  );
  assert.throws(() =>
    readSourceAbandonmentSessionEnumeration({
      ...walk.options,
      expectedRequest: { ...request, cutoff: '2026-10-09T16:11:00.000Z' },
    }),
  );
  const filename = readdirSync(walk.directory).find((name) => name.startsWith('page-'));
  const path = join(walk.directory, filename);
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(' ')]));
  assert.throws(walk.read);
});

test('enumeration refuses public evidence files and ignores orphan pages', (t) => {
  const walk = writeWalk(t, [row(1)]);
  writeFileSync(join(walk.directory, 'page-999999-orphan.json'), '{}\n', { mode: 0o600 });
  assert.equal(walk.read().rows.length, 1);
  chmodSync(join(walk.directory, 'checkpoint.json'), 0o644);
  assert.throws(walk.read);
});

test('enumeration digest ignores observation clock but changes with the complete source universe', (t) => {
  const first = writeWalk(t, [row(1)]).read();
  const later = writeWalk(t, [row(1)], { observedAt: '2026-10-09T16:30:00.000000Z' }).read();
  const larger = writeWalk(t, [row(1), unresolvedRow(2)]).read();
  assert.equal(first.enumerationDigest, later.enumerationDigest);
  assert.notEqual(first.enumerationDigest, larger.enumerationDigest);
  assert.equal(larger.unresolvedCount, 1);
});

test('one canonical owner with conflicting authority identities cannot be silently deduplicated', (t) => {
  const second = row(2);
  second.claim.ownerId = row(1).claim.ownerId;
  assert.throws(writeWalk(t, [row(1), second]).read);
});

test('planner creates exact finite children in sequential stock admission calls', async (t) => {
  const enumeration = writeWalk(
    t,
    Array.from({ length: 9 }, (_, i) => row(i + 1)),
  ).read();
  const h = planner(enumeration);
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.children.length, 2);
  assert.equal(result.admissionCalls, 2);
  assert.equal(h.peak(), 1);
  assert.deepEqual(
    result.children.map((child) => child.authorities.length),
    [8, 1],
  );
  assert.deepEqual(
    result.children
      .flatMap((child) => child.authorities)
      .sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
    [...enumeration.authorities].sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
  );
  for (const child of result.children) {
    assert.equal(child.selection.protocol, 'source-abandonment-v1');
    assert.equal(child.selection.abandonBefore, request.cutoff);
    assert.deepEqual(child.selection.majorBotIds, ['major']);
    assert.equal(child.selectionDigest, digest(child.selection));
    assert.ok(h.proofs.some((proof) => proofDigest(proof) === child.admissionDigest));
  }
  assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  assert.equal(result.registryDigest, hash);
  assert.equal(result.botCatalogDigest, canonical({ publisherBotId: 'publisher' }));
  assert.equal(result.enumerationDigest, enumeration.enumerationDigest);
  assert.ok(result.admissionDurationMs >= 0);
});

test('DENY group splits to individuals without losing the supported subset', async (t) => {
  const enumeration = writeWalk(t, [row(1), row(2), row(3), unresolvedRow(4)]).read();
  const rejectedOwner = row(2).claim.ownerId;
  const h = planner(enumeration, (value, input) =>
    input.selection.ownerWebhookEventIds.includes(rejectedOwner)
      ? {
          ...value,
          decision: 'DENY',
          sourceCoverageComplete: false,
          issues: [
            { code: 'source_content_unproved', descriptor: 'sql:selected-source' },
            { code: 'source_candidate_unproved', descriptor: 'sql:selected-source' },
            { code: 'selected_owner_proof_incomplete', descriptor: 'sql:selected-source' },
          ],
        }
      : value,
  );
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.deepEqual(
    result.children.flatMap((child) => child.authorities.map((entry) => entry.ownerId)).sort(),
    [row(1).claim.ownerId, row(3).claim.ownerId].sort(),
  );
  assert.deepEqual(result.excludedCounts, { rejected: 1, unresolved: 1 });
  assert.ok(
    h.calls.some(
      (input) =>
        input.selection.ownerWebhookEventIds.length === 1 &&
        input.selection.ownerWebhookEventIds[0] === rejectedOwner,
    ),
  );
  assert.equal(h.peak(), 1);
});

for (const [name, change] of [
  [
    'source identity',
    (value) => {
      value.sourceSha = 'e'.repeat(40);
    },
  ],
  [
    'immutable image',
    (value) => {
      value.imageId = `sha256:${'e'.repeat(64)}`;
    },
  ],
  [
    'canonical selection',
    (value) => {
      value.selectionSha256 = 'e'.repeat(64);
    },
  ],
  [
    'publisher catalog',
    (value) => {
      value.publisherCatalogSha256 = 'e'.repeat(64);
    },
  ],
  [
    'authority',
    (value) => {
      value.selectedOwners[0].claimId = 'other';
    },
  ],
  [
    'source cutoff',
    (value) => {
      value.selectedOwners[0].sourceAt = request.cutoff;
    },
  ],
  [
    'incomplete catalog',
    (value) => {
      value.redisCatalogs[0].complete = false;
    },
  ],
  [
    'cost ceiling',
    (value) => {
      value.cost.rows = 10001;
    },
  ],
])
  test(`READY admission with changed ${name} never enters the manifest`, async (t) => {
    const h = planner(writeWalk(t, [row(1)]).read(), (value) => {
      change(value);
      return value;
    });
    await assert.rejects(planSourceAbandonmentSessionChildren(h.options));
  });

test('planner refuses more than the complete parent owner ceiling before admission or truncation', async (t) => {
  const nominated =
    SOURCE_ABANDONMENT_SESSION_LIMITS.children * SOURCE_ABANDONMENT_SESSION_LIMITS.ownersPerChild +
    1;
  const h = planner(
    writeWalk(
      t,
      Array.from({ length: nominated }, (_, i) => row(i + 1)),
    ).read(),
  );
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'too_many_candidates');
  assert.equal(result.nominatedOwners, nominated);
  assert.equal(h.calls.length, 0);
});
test('complete 161-owner scope uses 21 unchanged finite certificates without truncation', async (t) => {
  const enumeration = writeWalk(
    t,
    Array.from({ length: 161 }, (_, index) => row(index + 1)),
  ).read();
  const h = planner(enumeration);
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, true);
  assert.equal(result.children.length, 21);
  assert.equal(result.admissionCalls, 21);
  assert.equal(result.children.flatMap((child) => child.authorities).length, 161);
  assert(result.children.every((child) => child.authorities.length <= 8));
  const denied = await planSourceAbandonmentSessionChildren({
    ...planner(enumeration).options,
    maximumChildren: 20,
  });
  assert.equal(denied.reason, 'child_limit');
  assert.deepEqual(denied.children, []);
});

test('planner refuses a child ceiling that cannot represent all supported owners', async (t) => {
  const h = planner(
    writeWalk(
      t,
      Array.from({ length: 9 }, (_, i) => row(i + 1)),
    ).read(),
  );
  const result = await planSourceAbandonmentSessionChildren({ ...h.options, maximumChildren: 1 });
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'child_limit');
  assert.deepEqual(result.children, []);
  assert.equal(result.nominatedOwners, 9);
});

test('global admission failure never triggers per-owner splitting and retains measured proof cost', async (t) => {
  const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => ({
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: [{ code: 'inventory_store_or_budget_refused', descriptor: 'inventory' }],
  }));
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'global_admission_refused');
  assert.equal(result.admissionCalls, 1);
  assert.equal(result.admissionProofs.length, 1);
  assert.equal(result.admissionCost.rows, 2);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(result.children, []);
});
test('admission call budget refuses the complete plan without truncation', async (t) => {
  const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => ({
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: [{ code: 'source_content_unproved', descriptor: 'sql:selected-source' }],
  }));
  const result = await planSourceAbandonmentSessionChildren({
    ...h.options,
    maximumAdmissionCalls: 1,
  });
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'admission_budget');
  assert.equal(result.admissionCalls, 1);
  assert.deepEqual(result.children, []);
});
test('forged admission persistence and changing registry never grant a child', async (t) => {
  const h = planner(
    writeWalk(
      t,
      Array.from({ length: 9 }, (_, i) => row(i + 1)),
    ).read(),
  );
  await assert.rejects(
    planSourceAbandonmentSessionChildren({ ...h.options, recordProof: () => hash }),
    /proof_write/,
  );
  let count = 0;
  const g = planner(h.options.enumeration, (value) => ({
    ...value,
    registrySha256: count++ === 0 ? hash : 'f'.repeat(64),
  }));
  await assert.rejects(planSourceAbandonmentSessionChildren(g.options), /registry_changed/);
});

async function frozenFixture(t, onlineRows = [row(1), unresolvedRow(2)]) {
  const enumeration = writeWalk(t, onlineRows).read(),
    p = planner(enumeration),
    plan = await planSourceAbandonmentSessionChildren(p.options);
  const manifest = {
    version: 1,
    kind: 'source_abandonment_session_manifest',
    sessionId: uuid(31),
    clusterIdentity: uuid(32),
    epoch: 1,
    controllerNonce: uuid(33),
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    cutoff: request.cutoff,
    baselineDigest: hash,
    topologyDigest: hash,
    registryDigest: plan.registryDigest,
    botCatalogDigest: plan.botCatalogDigest,
    enumerationDigest: enumeration.enumerationDigest,
    enumerationComplete: true,
    excludedCounts: plan.excludedCounts,
    budgets: Object.fromEntries(
      [
        'durationMs',
        'proofBytes',
        'inventoryPages',
        'inventoryRows',
        'inventoryProbes',
        'inventoryBytes',
        'materializationPages',
      ].map((key) => [key, SOURCE_ABANDONMENT_SESSION_LIMITS[key]]),
    ),
    children: plan.children,
  };
  const generation = (serviceName, index) => ({
    serviceName,
    containerId: String(index + 1).padStart(64, '0'),
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    stopped: false,
    exactGeneration: true,
    restartPolicy: 'unless-stopped',
    ...(serviceName.endsWith('sandbox') ? { nativeBoundaryDigest: hash } : {}),
  });
  const baseline = {
    version: 1,
    complete: true,
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    selectionDigest: enumeration.enumerationDigest,
    controllerNonce: manifest.controllerNonce,
    singletonCount: 14,
    nativeCount: 2,
    compatible: true,
    unreviewedProducers: 0,
    services: LEGACY_COLD_API_SERVICES.map(generation),
    auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map((name, index) =>
      generation(name, index + 14),
    ),
  };
  manifest.baselineDigest = digest(baseline);
  const bindings = sourceAbandonmentSessionRuntimeBindings(manifest);
  const stopped = {
    ...clone(baseline),
    services: baseline.services.map((value) => ({ ...value, stopped: true })),
    auxiliaries: baseline.auxiliaries.map((value) => ({ ...value, stopped: true })),
  };
  const state = {
    rows: clone(onlineRows),
    now: 1000,
    attestCount: 0,
    pageCount: 0,
    deadline: null,
    mutateAttestation: () => {},
  };
  const proofs = [];
  const options = {
    enumeration,
    baseline,
    limits: {
      inventoryPages: 512,
      inventoryRows: 10000,
      inventoryProbes: 50000,
      inventoryBytes: 8 * 1024 * 1024,
    },
    now: () => state.now,
    attestStopped: () => {
      state.attestCount++;
      state.mutateAttestation(stopped);
      return clone(stopped);
    },
    readPage: (parameters, { deadlineAtMs }) => {
      state.pageCount++;
      state.deadline = deadlineAtMs;
      const value = page(parameters, state.rows, false, {
        version: 3,
        kind: 'frozen_ordered_anchor_inventory_page',
        coverage: 'STOPPED_METADATA',
      });
      return frozenResult(value);
    },
    recordProof: (value) => {
      proofs.push(clone(value));
      return proofDigest(value);
    },
  };
  return {
    enumeration,
    plan,
    manifest,
    baseline,
    bindings,
    state,
    stopped,
    options,
    proofs,
    run: () =>
      createSourceAbandonmentSessionFrozenInventory(options)(manifest, bindings, {
        deadlineAtMs: 60000,
      }),
  };
}
function frozenResult(value, prefixAttempts = []) {
  const plan = { index: 'ordered' };
  const attempts = [
    ...prefixAttempts,
    {
      pageSize: value.pageSize,
      rawCount: value.rawCount,
      returnedRows: value.rows.length,
      refusal: null,
      outputBytes: Buffer.byteLength(JSON.stringify({ page: value, plan })),
      plan,
    },
  ];
  return {
    page: value,
    plan,
    attempts,
    cost: {
      inventoryPages: attempts.length,
      inventoryRows: attempts.reduce((sum, row) => sum + Math.min(row.rawCount, row.pageSize), 0),
      inventoryProbes: attempts.reduce((sum, row) => sum + 2 + 4 * row.rawCount, 0),
      inventoryBytes: attempts.reduce((sum, row) => sum + row.outputBytes, 0),
    },
  };
}
test('frozen complete index walk binds the same sixteen stopped generations and preserves unsupported scope', async (t) => {
  const h = await frozenFixture(t),
    result = await h.run();
  assert.equal(result.coverage, 'FROZEN');
  assert.equal(result.enumerationComplete, true);
  assert.equal(result.manifestMatches, true);
  assert.equal(result.plannedEnumerationDigest, h.enumeration.enumerationDigest);
  assert.equal(result.frozenEnumerationDigest, h.enumeration.enumerationDigest);
  assert.equal(result.remainingUnselectedRows, 1);
  assert.equal(result.resolvedUnselectedRows, 0);
  assert.equal(result.allBacklogCleared, false);
  assert.equal(result.fleetRecoveryProven, false);
  assert.equal(h.state.deadline, 60000);
  assert.ok(h.state.attestCount >= 3);
  assert.equal(h.proofs.length, 2);
  assert.equal(proofDigest(h.proofs.at(-1)), result.rawInventoryProof);
});
test('preselected200 covers the complete ordered universe with one charged attempt per page', async (t) => {
  const rows = [row(1), ...Array.from({ length: 1000 }, (_, index) => unresolvedRow(index + 2))];
  const h = await frozenFixture(t, rows);
  h.options.readPage = (parameters) => {
    const start = parameters.after
      ? rows.findIndex((row) => row.id === parameters.after.id) + 1
      : 0;
    assert.equal(parameters.pageSize, 200);
    const size = parameters.pageSize;
    const selected = rows.slice(start, start + size);
    const value = page({ ...parameters, pageSize: size }, selected, start + size < rows.length, {
      version: 3,
      kind: 'frozen_ordered_anchor_inventory_page',
      coverage: 'STOPPED_METADATA',
    });
    return frozenResult(value);
  };
  const result = await h.run();
  assert.equal(result.frozenEnumerationDigest, h.enumeration.enumerationDigest);
  assert.equal(result.cost.inventoryPages, 6);
  assert.equal(result.cost.inventoryRows, 1001);
  assert.equal(result.cost.inventoryProbes, 2 * 6 + 4 * (1001 + 5));
  const first = h.proofs.find((row) => row.kind === 'source_abandonment_frozen_page');
  assert.equal(first.attempts.length, 1);
  assert.equal(first.attempts[0].pageSize, 200);
  assert.equal(first.attempts[0].refusal, null);
});
test('frozen session rejects a legacy-sized or repeated attempt before saving a page', async (t) => {
  for (const mutate of [
    (value) => {
      value.attempts[0].pageSize = 1000;
    },
    (value) => {
      value.attempts.push(structuredClone(value.attempts[0]));
    },
    (value) => {
      value.attempts[0].refusal = 'output_budget';
    },
  ]) {
    const h = await frozenFixture(t);
    const read = h.options.readPage;
    h.options.readPage = (...args) => {
      const value = read(...args);
      mutate(value);
      return value;
    };
    await assert.rejects(h.run(), /attempts_unproved/);
    assert.equal(h.proofs.length, 0);
  }
});
test('frozen inventory rejects omitted or understated physical-attempt costs', async (t) => {
  for (const field of ['attempts', 'inventoryRows', 'inventoryProbes', 'inventoryBytes']) {
    const h = await frozenFixture(t);
    const original = h.options.readPage;
    h.options.readPage = (...args) => {
      const value = original(...args);
      if (field === 'attempts') delete value.attempts;
      else value.cost[field]--;
      return value;
    };
    await assert.rejects(h.run(), /attempts_unproved|cost_unproved/);
    assert.equal(h.proofs.length, 0);
  }
});
test('unselected rows may leave the complete ordered index without fabricating their effect outcome', async (t) => {
  const h = await frozenFixture(t);
  h.state.rows = [row(1)];
  const result = await h.run();
  assert.equal(result.resolvedUnselectedRows, 1);
  assert.equal(result.remainingUnselectedRows, 0);
  assert.equal(result.allBacklogCleared, false);
  assert.notEqual(result.frozenEnumerationDigest, result.plannedEnumerationDigest);
});
for (const [name, mutate] of [
  [
    'selected authority disappeared',
    (h) => {
      h.state.rows = [unresolvedRow(2)];
    },
  ],
  [
    'unknown old-cutoff addition',
    (h) => {
      h.state.rows.push(row(3));
    },
  ],
  [
    'claim changed',
    (h) => {
      h.state.rows[0].claim.id = 'other';
    },
  ],
  [
    'message changed',
    (h) => {
      h.state.rows[0].messageId = 'other';
    },
  ],
  [
    'order chat changed',
    (h) => {
      h.state.rows[0].orderChatId = 'other';
    },
  ],
  [
    'runtime generation changed',
    (h) => {
      h.state.mutateAttestation = (value) => {
        value.services[0].containerId = 'f'.repeat(64);
      };
    },
  ],
  [
    'native isolation changed',
    (h) => {
      h.state.mutateAttestation = (value) => {
        value.auxiliaries[0].nativeBoundaryDigest = 'f'.repeat(64);
      };
    },
  ],
  [
    'API still running',
    (h) => {
      h.state.mutateAttestation = (value) => {
        value.services[0].stopped = false;
      };
    },
  ],
  [
    'page budget exceeded',
    (h) => {
      h.options.limits.inventoryRows = 1;
    },
  ],
  [
    'deadline expired',
    (h) => {
      h.state.now = 60000;
    },
  ],
])
  test(`frozen review refuses ${name}`, async (t) => {
    const h = await frozenFixture(t);
    mutate(h);
    await assert.rejects(h.run());
  });
test('post-page deadline and generation changes cannot produce a frozen completeness proof', async (t) => {
  const h = await frozenFixture(t),
    read = h.options.readPage;
  h.options.readPage = (...args) => {
    const result = read(...args);
    h.state.now = 60000;
    return result;
  };
  await assert.rejects(h.run(), /page_unproved/);
  assert.equal(h.proofs.length, 0);
  const g = await frozenFixture(t);
  g.state.mutateAttestation = (value) => {
    if (g.state.attestCount === 2) value.services[1].containerId = 'f'.repeat(64);
  };
  await assert.rejects(g.run(), /generation_changed/);
  assert.equal(g.proofs.length, 0);
});
test('frozen proof may not use a different baseline or enumeration binding', async (t) => {
  const h = await frozenFixture(t);
  h.baseline.services[0].containerId = 'f'.repeat(64);
  await assert.rejects(h.run(), /binding_refused/);
  const g = await frozenFixture(t);
  g.manifest.enumerationDigest = 'f'.repeat(64);
  await assert.rejects(g.run());
});
test('frozen lower-only work limits cannot be widened by the caller', async (t) => {
  const h = await frozenFixture(t);
  h.options.limits.inventoryRows = 2000001;
  assert.throws(() => createSourceAbandonmentSessionFrozenInventory(h.options), /budget_refused/);
});
