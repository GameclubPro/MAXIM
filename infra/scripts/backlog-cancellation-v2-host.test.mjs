import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  cancellationRuntimeDigestV2,
  cancellationV2Bytes,
  createBacklogCancellationHelpersV2,
  parseApplyV2,
  parseNominationV2,
  runApplyHostV2,
  runPreviewHostV2,
} from './backlog-cancellation-v2-host.mjs';
import { readBacklogCancellation } from './backlog-cancellation-journal.mjs';
import { createLegacyColdRuntime } from './legacy-cold-runtime.mjs';
import { legacyColdFleet } from './test-fixtures/legacy-cold-fleet.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import {
  archiveReleaseTransition,
  beginReleaseTransition,
  buildReleaseManifest,
} from './release-manifest.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/backlog-cancellation-v2-contract.json', import.meta.url)),
);
const sha = (value) => createHash('sha256').update(cancellationV2Bytes(value)).digest('hex');
const nomination = fixture.validNomination;

function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-v2-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const events = [];
  const manifest = buildReleaseManifest({
    releaseId: 'fixture-retained-components',
    targetSha: 'e'.repeat(40),
    components: [
      {
        id: 'api-shared',
        sourceSha: nomination.sourceSha,
        imageRef: `maxim-api:${nomination.sourceSha}`,
        imageId: nomination.imageId,
      },
      ...['miniapp-major-static', 'admin-static'].map((id) => ({
        id,
        sourceSha: 'd'.repeat(40),
        imageRef: `${id}:${'d'.repeat(40)}`,
        imageId: `sha256:${'c'.repeat(64)}`,
      })),
    ],
  });
  writeFileSync(join(directory, 'current.json'), JSON.stringify(manifest), { mode: 0o640 });
  const state = {
    stopped: false,
    exists: false,
    previewDecision: 'READY',
    preflight: true,
    absent: true,
    applyMode: 'success',
    failStart: false,
    failHealth: false,
    survivor: false,
  };
  const all = [...LEGACY_COLD_API_SERVICES, 'ocr-native-sandbox', 'photo-native-sandbox'];
  const baseline = {
    version: 1,
    complete: true,
    sourceSha: nomination.sourceSha,
    imageId: nomination.imageId,
    selectionDigest: nomination.id,
    controllerNonce: nomination.id,
    compatible: true,
    singletonCount: 14,
    nativeCount: 2,
    unreviewedProducers: 0,
    services: [],
    auxiliaries: [],
  };
  all.forEach((serviceName, index) => {
    const row = {
      serviceName,
      containerId: (index + 1).toString(16).padStart(64, '0'),
      imageId: nomination.imageId,
      sourceSha: nomination.sourceSha,
      stopped: false,
      exactGeneration: true,
      restartPolicy: 'unless-stopped',
      ...(serviceName.endsWith('native-sandbox') ? { nativeBoundaryDigest: 'a'.repeat(64) } : {}),
    };
    baseline[index < 14 ? 'services' : 'auxiliaries'].push(row);
  });
  const reply = (value, code = 0) => ({ code, stdout: cancellationV2Bytes(value) });
  const op = join(directory, `backlog-cancellation-${nomination.id}`);
  const previewFor = (bindings) => ({
    version: 2,
    kind: 'BACKLOG_CANCELLATION_PREVIEW',
    id: nomination.id,
    cutoff: nomination.cutoff,
    sourceSha: nomination.sourceSha,
    imageId: nomination.imageId,
    nominationSha256: sha(nomination),
    bindings,
    familyPolicy: 'EXACT_OBSERVED_PENDING_FAMILY_V1',
    childPolicy: 'EXACT_SOURCE_CHILD_V1',
    snapshotAt: '2026-10-19T00:00:00.000Z',
    completedAt: '2026-10-19T00:00:01.000Z',
    decision: state.previewDecision,
    complete: state.previewDecision === 'READY',
    nonAtomicOnline: true,
    stoppedRevalidationRequired: true,
    roots: [
      {
        receiptId: nomination.rootIds[0],
        claimId: 'claim-exact',
        semanticKey: 'semantic-exact',
        chatId: '-69049244448234',
        messageId: 'original-message',
        identitySha256: 'b'.repeat(64),
        claimSha256: 'c'.repeat(64),
        rawPayloadSha256: 'd'.repeat(64),
        normalizedPayloadSha256: 'e'.repeat(64),
      },
    ],
    receipts: [{ receiptId: nomination.rootIds[0], identitySha256: 'b'.repeat(64) }],
    children: [],
    retained: { terminalReceipts: 2, protectedJobs: 3, unattributedJobs: 1, lockedJobs: 0 },
    cost: {
      sqlRows: 3,
      sqlBytes: 1024,
      sqlCalls: 5,
      queueJobs: 8,
      queueBytes: 2048,
      queuePages: 2,
    },
    issues: state.previewDecision === 'READY' ? [] : [{ code: 'SCOPE_DRIFT' }],
  });
  const options = {
    directory,
    expectedSha: nomination.sourceSha,
    assertLock: () => events.push('lock'),
    assertMaintenance: (_directory, own) => events.push(`guard:${own ?? 'none'}`),
    report: (value) =>
      events.push(`report:${value.phase}:${value.outcome ?? value.decision ?? ''}`),
    createRuntime: ({ bindings }) => {
      assert.equal(bindings.targetSha, nomination.sourceSha);
      assert.equal(bindings.targetImageId, nomination.imageId);
      return {
        inspectRuntime() {
          events.push('inspect');
          assert.equal(state.stopped, false, 'stopped resume must use its frozen baseline');
          return structuredClone(baseline);
        },
        stopRuntime() {
          events.push('stop');
          state.stopped = true;
        },
        readStoppedRuntime() {
          events.push('stopped-readback');
          assert.equal(state.stopped, true);
          return structuredClone(baseline);
        },
        async startBoundRuntime() {
          events.push('start-same-16');
          if (state.failStart) throw new Error('simulated startup failure');
          state.stopped = false;
        },
        readRuntimeIdentity() {
          events.push('running-readback');
          assert.equal(state.stopped, false);
          return structuredClone(baseline);
        },
      };
    },
    readConnection: () => ({
      networkId: 'f'.repeat(64),
      environment: 'DATABASE_URL=private\nREDIS_URL=private\n',
    }),
    proveRestored: async () => {
      events.push('restored-health');
      if (state.failHealth) throw new Error('simulated dependency failure');
      return { version: 2, dependenciesReady: true };
    },
    createHelpers: ({ bindings }) => ({
      assertGone(mode) {
        events.push(`gone:${mode}`);
        if (state.survivor && mode === 'apply') throw new Error('simulated helper survives');
      },
      cleanup(mode) {
        events.push(`cleanup:${mode}`);
        if (state.survivor && mode === 'apply') throw new Error('simulated helper survives');
      },
      async run(mode, request) {
        events.push(`helper:${mode}`);
        if (mode === 'identity') return { code: 0, stdout: '3'.repeat(64) };
        if (mode === 'preview')
          return reply(previewFor(bindings), state.previewDecision === 'READY' ? 0 : 2);
        if (mode === 'preflight')
          return reply(
            {
              version: 2,
              kind: 'BACKLOG_CANCELLATION_PREFLIGHT',
              id: request.id,
              previewSha256: request.previewSha256,
              valid: state.preflight,
            },
            state.preflight ? 0 : 2,
          );
        if (mode === 'prove-absent')
          return reply(
            {
              version: 2,
              kind: 'BACKLOG_CANCELLATION_NO_WRITE_PROOF',
              id: request.id,
              previewSha256: request.previewSha256,
              operationAbsent: state.absent && !state.exists,
            },
            state.absent && !state.exists ? 0 : 3,
          );
        assert.equal(mode, 'apply');
        assert.equal(state.stopped, true);
        if (state.applyMode === 'lost-after-write') {
          state.exists = true;
          throw new Error('disconnected');
        }
        const applied = state.applyMode === 'success';
        state.exists = applied || state.applyMode === 'partial';
        return reply(
          {
            version: 2,
            kind: 'BACKLOG_CANCELLATION_APPLY_RESULT',
            id: request.id,
            previewSha256: request.previewSha256,
            outcome: applied
              ? 'APPLIED'
              : state.exists
                ? 'INCOMPLETE_WRITTEN'
                : 'REFUSED_UNWRITTEN',
            operationExists: state.exists,
            sealed: applied,
            counts: {
              receipts: applied ? 1 : 0,
              projected: applied ? 1 : 0,
              children: 0,
              removed: 0,
              retainedLocked: 0,
              missingJobs: 0,
            },
            issues: applied ? [] : [{ code: 'SCOPE_DRIFT' }],
          },
          applied ? 0 : state.exists ? 3 : 2,
        );
      },
    }),
  };
  return {
    directory,
    manifest,
    op,
    events,
    state,
    baseline,
    options,
    async preview() {
      const result = await runPreviewHostV2(nomination, options);
      return { ...fixture.validApply, previewSha256: result.previewSha256 };
    },
  };
}

test('mixed controller and API sources preserve installed runtime and immutable preview authority', async (t) => {
  const h = harness(t);
  h.options.expectedSha = 'f'.repeat(40);
  h.options.expectedRuntimeSha = nomination.sourceSha;
  const request = await h.preview();
  assert.equal(h.events.includes('stop'), false);
  const controller = JSON.parse(readFileSync(join(h.op, 'controller.json'), 'utf8'));
  assert.equal(controller.controllerSha, h.options.expectedSha);
  assert.equal(controller.sourceSha, nomination.sourceSha);
  assert.equal(controller.nominationSha256, sha(nomination));
  assert.equal((await runApplyHostV2(request, h.options)).outcome, 'APPLIED');
  assert.equal(h.events.filter((event) => event === 'stop').length, 1);
});

test('mixed sources require independently admitted runtime identity before evidence or helpers', async (t) => {
  const h = harness(t);
  h.options.expectedSha = 'f'.repeat(40);
  await assert.rejects(h.preview(), /controller source mismatch/);
  assert.deepEqual(h.events, ['lock']);
  assert.equal(readdirSync(h.directory).includes(`backlog-cancellation-${nomination.id}`), false);
});

for (const disposition of ['recovered', 'superseded']) {
  test(`completed ${disposition} release history permits exact recovery and remains intact`, async (t) => {
    const h = harness(t);
    const current = join(h.directory, 'current.json');
    writeFileSync(
      current,
      JSON.stringify({
        ...h.manifest,
        releaseId: 'fixture-before-transition',
        createdAt: '2026-10-26T00:00:00.000Z',
      }),
    );
    const recoveryPath = beginReleaseTransition({
      stateDir: h.directory,
      kind: 'deploy',
      now: new Date('2026-10-27T00:00:00.000Z'),
      pid: 123,
    });
    writeFileSync(
      current,
      JSON.stringify({ ...h.manifest, createdAt: '2026-10-27T00:00:01.000Z' }),
      { mode: 0o640 },
    );
    const archive = archiveReleaseTransition({
      stateDir: h.directory,
      recoveryPath,
      disposition,
      now: new Date('2026-10-27T00:00:02.000Z'),
      pid: 123,
    });
    const retainedBytes = readFileSync(archive);
    const request = await h.preview();
    assert.equal(h.events.includes('stop'), false);
    assert.equal((await runApplyHostV2(request, h.options)).outcome, 'APPLIED');
    assert.deepEqual(readFileSync(archive), retainedBytes);
  });
}

test('a bounded complete current manifest is required before preview helpers', async (t) => {
  const changes = {
    missing: (h, path) => unlinkSync(path),
    incomplete: (h, path, value) => {
      delete value.components['admin-static'];
      return value;
    },
    unknown: (h, path, value) => {
      value.components['api-shared'].sourceSha = 'unknown';
      return value;
    },
    source: (h, path, value) => {
      value.components['api-shared'].sourceSha = 'f'.repeat(40);
      return value;
    },
    ref: (h, path, value) => {
      value.components['api-shared'].imageRef = 'maxim-api:latest';
      return value;
    },
    image: (h, path, value) => {
      value.components['api-shared'].imageId = `sha256:${'f'.repeat(64)}`;
      return value;
    },
    transition: (h) => {
      writeFileSync(join(h.directory, 'current.invalid-deploy-20261028T210000Z-1.json'), '{}');
    },
    'malformed-transition': (h) => {
      writeFileSync(join(h.directory, 'current.invalid-unrecognized'), '{}');
    },
    'malformed-archive-base': (h) => {
      writeFileSync(
        join(h.directory, 'current.invalid-unrecognized.json.recovered-20261028T210000Z-1'),
        '{}',
      );
    },
    'malformed-archive-suffix': (h) => {
      writeFileSync(
        join(h.directory, 'current.invalid-deploy-20261028T210000Z-1.json.recovered'),
        '{}',
      );
    },
    mode: (h, path) => chmodSync(path, 0o666),
    hardlink: (h, path) => linkSync(path, join(h.directory, 'other.json')),
    symlink: (h, path) => {
      unlinkSync(path);
      symlinkSync('/dev/null', path);
    },
    fifo: (h, path) => {
      unlinkSync(path);
      execFileSync('mkfifo', ['-m', '640', path], { timeout: 1000 });
    },
    oversized: (h, path) => writeFileSync(path, ' '.repeat(65537)),
  };
  for (const [name, change] of Object.entries(changes))
    await t.test(name, async (t) => {
      const h = harness(t),
        path = join(h.directory, 'current.json');
      const value = change(h, path, structuredClone(h.manifest));
      if (value && typeof value === 'object') writeFileSync(path, JSON.stringify(value));
      await assert.rejects(h.preview());
      assert.equal(
        h.events.some((event) => event.startsWith('helper:') || event === 'stop'),
        false,
      );
      assert.equal(readBacklogCancellation(h.directory), null);
    });
});

test('apply rechecks the installed component before preflight or journal creation', async (t) => {
  const h = harness(t),
    request = await h.preview();
  const before = [...h.events];
  const manifest = structuredClone(h.manifest);
  manifest.components['api-shared'].imageId = `sha256:${'f'.repeat(64)}`;
  writeFileSync(join(h.directory, 'current.json'), JSON.stringify(manifest));
  await assert.rejects(runApplyHostV2(request, h.options), /manifest mismatch/);
  assert.deepEqual(h.events.slice(before.length), ['lock', `guard:${nomination.id}`]);
  assert.equal(readdirSync(h.op).includes('apply.json'), false);
  assert.equal(readBacklogCancellation(h.directory), null);
});

test('a new active release transition after READY refuses apply before preflight or stop', async (t) => {
  const h = harness(t),
    request = await h.preview();
  const before = [...h.events];
  writeFileSync(
    join(h.directory, 'current.invalid-deploy-20261028T210000Z-1.json'),
    JSON.stringify(h.manifest),
  );
  await assert.rejects(runApplyHostV2(request, h.options), /release transition unfinished/);
  assert.deepEqual(h.events.slice(before.length), ['lock', `guard:${nomination.id}`]);
  assert.equal(readdirSync(h.op).includes('apply.json'), false);
  assert.equal(readBacklogCancellation(h.directory), null);
});

test('READY evidence refuses missing, changed or unsafe controller bindings before any apply work', async (t) => {
  const changes = {
    controller: (h) => {
      h.options.expectedSha = 'e'.repeat(40);
    },
    missing: (h) => unlinkSync(join(h.op, 'controller.json')),
    changed: (h) => writeFileSync(join(h.op, 'controller.json'), '{}\n'),
    mode: (h) => chmodSync(join(h.op, 'controller.json'), 0o640),
    hardlink: (h) => linkSync(join(h.op, 'controller.json'), join(h.op, 'controller-copy.json')),
    'missing-ready': (h) => unlinkSync(join(h.op, 'controller-ready.json')),
    'changed-ready': (h) => writeFileSync(join(h.op, 'controller-ready.json'), '{}\n'),
  };
  for (const [name, change] of Object.entries(changes))
    await t.test(name, async (t) => {
      const h = harness(t);
      h.options.expectedSha = 'f'.repeat(40);
      h.options.expectedRuntimeSha = nomination.sourceSha;
      const request = await h.preview(),
        before = h.events.length;
      change(h);
      await assert.rejects(runApplyHostV2(request, h.options));
      assert.equal(
        h.events.slice(before).some((event) => event.startsWith('helper:') || event === 'stop'),
        false,
      );
      assert.equal(readdirSync(h.op).includes('apply.json'), false);
      assert.equal(readBacklogCancellation(h.directory), null);
    });
});

test('legacy same-source READY and stopped evidence remain resumable without new bindings', async (t) => {
  const h = harness(t),
    request = await h.preview();
  for (const file of ['controller.json', 'controller-ready.json']) unlinkSync(join(h.op, file));
  await runPreviewHostV2(nomination, h.options);
  assert.equal(readdirSync(h.op).includes('controller.json'), false);
  h.state.applyMode = 'partial';
  await assert.rejects(runApplyHostV2(request, h.options), /after write/);
  assert.equal(readBacklogCancellation(h.directory).controllerSha256, undefined);
  h.state.applyMode = 'success';
  assert.equal((await runApplyHostV2(request, h.options)).outcome, 'APPLIED');
  assert.equal(h.events.filter((event) => event === 'start-same-16').length, 1);
});

test('old mixed-source preview cannot acquire new controller provenance', async (t) => {
  const h = harness(t),
    request = await h.preview();
  for (const file of ['controller.json', 'controller-ready.json']) unlinkSync(join(h.op, file));
  h.options.expectedSha = 'f'.repeat(40);
  h.options.expectedRuntimeSha = nomination.sourceSha;
  const before = h.events.length;
  await assert.rejects(h.preview(), /controller missing/);
  await assert.rejects(runApplyHostV2(request, h.options), /controller missing/);
  assert.equal(
    h.events.slice(before).some((event) => event.startsWith('helper:') || event === 'stop'),
    false,
  );
  assert.equal(readdirSync(h.op).includes('controller.json'), false);
});

test('missing nomination cannot turn retained READY artifacts into a new controller binding', async (t) => {
  const h = harness(t);
  await h.preview();
  for (const file of ['nomination.json', 'controller.json', 'controller-ready.json'])
    unlinkSync(join(h.op, file));
  const retained = readdirSync(h.op).sort();
  const preview = readFileSync(join(h.op, 'preview.json'), 'utf8');
  const before = h.events.length;
  h.options.expectedSha = 'f'.repeat(40);
  h.options.expectedRuntimeSha = nomination.sourceSha;
  await assert.rejects(h.preview(), /incomplete retained evidence/);
  assert.deepEqual(readdirSync(h.op).sort(), retained);
  assert.equal(readFileSync(join(h.op, 'preview.json'), 'utf8'), preview);
  assert.equal(
    h.events.slice(before).some((event) => event.startsWith('helper:')),
    false,
  );
});

test('mixed-source stopped resume retains controller, client and all captured generations', async (t) => {
  const h = harness(t);
  h.options.expectedSha = 'f'.repeat(40);
  h.options.expectedRuntimeSha = nomination.sourceSha;
  const request = await h.preview();
  h.state.applyMode = 'lost-after-write';
  await assert.rejects(runApplyHostV2(request, h.options));
  const journal = readFileSync(join(h.directory, 'backlog-cancellation.json'), 'utf8');
  const before = h.events.length;
  h.options.expectedSha = 'e'.repeat(40);
  await assert.rejects(runApplyHostV2(request, h.options), /controller mismatch/);
  assert.equal(readFileSync(join(h.directory, 'backlog-cancellation.json'), 'utf8'), journal);
  assert.equal(
    h.events.slice(before).some((event) => event.startsWith('helper:') || event === 'stop'),
    false,
  );
  assert.equal(h.state.stopped, true);
  h.options.expectedSha = 'f'.repeat(40);
  h.state.applyMode = 'success';
  const inspections = h.events.filter((event) => event === 'inspect').length;
  assert.equal((await runApplyHostV2(request, h.options)).outcome, 'APPLIED');
  assert.equal(h.events.filter((event) => event === 'inspect').length, inspections);
  assert.equal(h.events.filter((event) => event === 'start-same-16').length, 1);
});

test('a new same-source operation cannot lose its controller binding while stopped', async (t) => {
  const h = harness(t),
    request = await h.preview();
  h.state.applyMode = 'partial';
  await assert.rejects(runApplyHostV2(request, h.options), /after write/);
  for (const file of ['controller.json', 'controller-ready.json']) unlinkSync(join(h.op, file));
  const before = h.events.length;
  await assert.rejects(runApplyHostV2(request, h.options), /journal evidence mismatch/);
  assert.equal(
    h.events.slice(before).some((event) => event.startsWith('helper:') || event === 'stop'),
    false,
  );
  assert.equal(h.state.stopped, true);
});

test('v2 input parsers agree with the frozen fixture and reject coercion, noncanonical and broad requests', () => {
  assert.equal(fixture.nominationMaxBytes, 16 * 1024);
  assert.equal(fixture.applyMaxBytes, 4 * 1024);
  assert.deepEqual(parseNominationV2(cancellationV2Bytes(nomination)), nomination);
  assert.deepEqual(parseApplyV2(cancellationV2Bytes(fixture.validApply)), fixture.validApply);
  for (const invalid of [
    null,
    [],
    { ...nomination, version: 1 },
    { ...nomination, id: [nomination.id] },
    { ...nomination, rootIds: [] },
    { ...nomination, rootIds: ['same', 'same'] },
    { ...nomination, rootIds: ['z', 'a'] },
    { ...nomination, rootIds: ['\nroot'] },
    {
      ...nomination,
      rootIds: Array.from({ length: 129 }, (_, i) => `root-${String(i).padStart(3, '0')}`),
    },
    { ...nomination, force: true },
    { ...nomination, childPrefix: 'all' },
    { ...nomination, cutoff: '2999-01-01T00:00:00.000Z' },
  ])
    assert.throws(() => parseNominationV2(cancellationV2Bytes(invalid)));
  assert.throws(() => parseNominationV2(JSON.stringify(nomination)), /canonical/);
  assert.throws(
    () =>
      parseNominationV2(
        cancellationV2Bytes(nomination).replace('"version":2', '"version":1,"version":2'),
      ),
    /canonical/,
  );
  assert.throws(() => parseNominationV2(`${' '.repeat(16385)}\n`), /bounded/);
  assert.throws(() =>
    parseApplyV2(cancellationV2Bytes({ ...fixture.validApply, rootIds: ['root'] })),
  );
  assert.throws(() =>
    parseApplyV2(cancellationV2Bytes({ ...fixture.validApply, previewSha256: ['3'.repeat(64)] })),
  );
});

test('preview is private immutable evidence and never creates a journal or stops/starts the fleet', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  assert.equal(request.previewSha256, sha(JSON.parse(readFileSync(join(h.op, 'preview.json')))));
  assert.equal(lstatSync(h.op).mode & 0o777, 0o700);
  for (const file of ['nomination.json', 'preview.json', 'bindings.json'])
    assert.equal(lstatSync(join(h.op, file)).mode & 0o777, 0o600);
  assert.equal(readBacklogCancellation(h.directory), null);
  assert.equal(h.events.includes('stop'), false);
  assert.equal(
    h.events.some((value) => value.startsWith('helper:apply')),
    false,
  );
  assert.equal(h.events.includes('start-same-16'), false);
  const immutableRaw = readFileSync(join(h.op, 'preview.json'), 'utf8');
  await runPreviewHostV2(nomination, h.options);
  assert.equal(h.events.filter((value) => value === 'helper:preview').length, 1);
  assert.equal(readFileSync(join(h.op, 'preview.json'), 'utf8'), immutableRaw);
});

test('DENY preview has no READY artifact, hash, journal or fleet mutation', async (t) => {
  const h = harness(t);
  h.state.previewDecision = 'DENY';
  const result = await runPreviewHostV2(nomination, h.options);
  assert.equal(result.exitCode, 2);
  assert.equal(result.previewSha256, undefined);
  assert.equal(readdirSync(h.op).includes('preview.json'), false);
  assert.equal(readdirSync(h.op).includes('preview-failure.json'), true);
  assert.equal(readBacklogCancellation(h.directory), null);
  await assert.rejects(runPreviewHostV2(nomination, h.options), /consumed/);
  assert.equal(h.events.includes('stop'), false);
});

test('connection failures are redacted and an accidental MAX credential never enters the helper', async (t) => {
  const h = harness(t);
  h.options.readConnection = () => {
    throw new Error('MAX_BOT_TOKEN=private-value');
  };
  await assert.rejects(runPreviewHostV2(nomination, h.options), (error) => {
    assert.equal(error.message, 'V2 store connection unproved');
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
  h.options.readConnection = () => ({
    networkId: 'f'.repeat(64),
    environment: 'DATABASE_URL=private\nREDIS_URL=private\nMAX_BOT_TOKEN=private-value\n',
  });
  await assert.rejects(runPreviewHostV2(nomination, h.options), /only exact store credentials/);
  assert.equal(
    h.events.some((event) => event.startsWith('helper:')),
    false,
  );
  assert.equal(h.events.includes('stop'), false);
});

test('the generation-captured independent control pair passes the cold helper boundary', async (t) => {
  const h = harness(t);
  h.options.readConnection = () => ({
    networkId: 'f'.repeat(64),
    environment: `DATABASE_URL=private\nREDIS_URL=private\nERASER_CONTROL_URL=http://eraser:3000\nERASER_CONTROL_TOKEN=${'a'.repeat(64)}\n`,
  });
  const result = await runPreviewHostV2(nomination, h.options);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.stringify(result).includes('a'.repeat(64)), false);
});

test('exact preview/generation/root preflight gates all run before the first stop', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  await assert.rejects(
    runApplyHostV2({ ...request, previewSha256: '9'.repeat(64) }, h.options),
    /preview mismatch/,
  );
  assert.equal(h.events.includes('stop'), false);
  h.baseline.services[0].containerId = 'f'.repeat(64);
  await assert.rejects(runApplyHostV2(request, h.options), /generations changed/);
  assert.equal(readBacklogCancellation(h.directory), null);
  h.baseline.services[0].containerId = '1'.padStart(64, '0');
  h.state.preflight = false;
  await assert.rejects(runApplyHostV2(request, h.options), /preflight refused/);
  assert.equal(h.events.includes('stop'), false);
  assert.equal(readBacklogCancellation(h.directory), null);
});

test('apply orders exact stop, positive readback, write, helper absence, same-generation restart and health', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  const result = await runApplyHostV2(request, h.options);
  assert.equal(result.exitCode, 0);
  const journal = readBacklogCancellation(h.directory);
  assert.equal(journal.phase, 'COMPLETE');
  assert.equal(journal.outcome, 'APPLIED');
  assert.equal(journal.abortPending, undefined);
  assert.equal(journal.previewSha256, request.previewSha256);
  assert.deepEqual(journal.baseline, h.baseline);
  for (const [first, later] of [
    ['helper:preflight', 'stop'],
    ['stop', 'stopped-readback'],
    ['stopped-readback', 'helper:apply'],
    ['helper:apply', 'start-same-16'],
    ['start-same-16', 'running-readback'],
    ['running-readback', 'restored-health'],
    ['restored-health', 'report:COMPLETE:APPLIED'],
  ])
    assert.ok(h.events.indexOf(first) < h.events.indexOf(later), `${first} precedes ${later}`);
  const writes = h.events.filter((value) => value === 'helper:apply').length;
  const resumed = await runApplyHostV2(request, h.options);
  assert.equal(resumed.resumed, true);
  assert.equal(h.events.filter((value) => value === 'helper:apply').length, writes);
});

test('prewrite refusal needs independent positive SQL absence and same-16 health before non-success COMPLETE', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  h.state.applyMode = 'refused';
  const result = await runApplyHostV2(request, h.options);
  assert.equal(result.exitCode, 2);
  assert.equal(result.outcome, 'ABORTED_UNWRITTEN');
  assert.equal(h.state.stopped, false);
  assert.ok(h.events.indexOf('gone:apply') < h.events.indexOf('helper:prove-absent'));
  assert.ok(h.events.indexOf('helper:prove-absent') < h.events.indexOf('start-same-16'));
  assert.equal(readBacklogCancellation(h.directory).outcome, 'ABORTED_UNWRITTEN');
  assert.equal(readBacklogCancellation(h.directory).abortPending, undefined);
  assert.equal(JSON.parse(readFileSync(join(h.op, 'no-write-proof.json'))).operationAbsent, true);
  const resumed = await runApplyHostV2(request, h.options);
  assert.equal(resumed.exitCode, 2);
  assert.equal(resumed.outcome, 'ABORTED_UNWRITTEN');
  assert.equal(h.events.filter((value) => value === 'helper:apply').length, 1);
});

test('unknown absence, an existing operation or a surviving helper never authorizes restart', async (t) => {
  for (const failure of ['absent', 'partial', 'survivor', 'lost-after-write']) {
    await t.test(failure, async (t) => {
      const h = harness(t);
      const request = await h.preview();
      if (failure === 'survivor') {
        h.state.survivor = true;
      } else {
        h.state.applyMode = failure === 'absent' ? 'refused' : failure;
        if (failure === 'absent') h.state.absent = false;
      }
      await assert.rejects(runApplyHostV2(request, h.options));
      assert.equal(h.events.includes('start-same-16'), false);
      assert.notEqual(readBacklogCancellation(h.directory)?.phase, 'COMPLETE');
    });
  }
});

test('partial writes resume only the same frozen request, without new preflight or preview', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  h.state.applyMode = 'partial';
  await assert.rejects(runApplyHostV2(request, h.options), /after write/);
  assert.equal(readBacklogCancellation(h.directory).phase, 'STOPPED');
  const before = readFileSync(join(h.op, 'preview.json'), 'utf8');
  await assert.rejects(
    runApplyHostV2({ ...request, cutoff: '2026-10-09T00:00:00.000Z' }, h.options),
    /identity mismatch/,
  );
  h.state.applyMode = 'success';
  assert.equal((await runApplyHostV2(request, h.options)).outcome, 'APPLIED');
  assert.equal(h.events.filter((value) => value === 'helper:preview').length, 1);
  assert.equal(h.events.filter((value) => value === 'helper:preflight').length, 1);
  assert.equal(readFileSync(join(h.op, 'preview.json'), 'utf8'), before);
});

test('failed unwritten restoration stays fenced and exact resume restores without an apply retry', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  h.state.applyMode = 'refused';
  h.state.failStart = true;
  await assert.rejects(runApplyHostV2(request, h.options), /startup failure/);
  assert.equal(readBacklogCancellation(h.directory).phase, 'STOPPED');
  assert.equal(readBacklogCancellation(h.directory).abortPending, true);
  h.state.failStart = false;
  const result = await runApplyHostV2(request, h.options);
  assert.equal(result.outcome, 'ABORTED_UNWRITTEN');
  assert.equal(result.exitCode, 2);
  assert.equal(h.events.filter((value) => value === 'helper:apply').length, 1);
  assert.equal(h.events.filter((value) => value === 'helper:prove-absent').length, 2);
});

test('restored API dependency failure never produces COMPLETE', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  h.state.failHealth = true;
  await assert.rejects(runApplyHostV2(request, h.options), /dependency failure/);
  assert.equal(readBacklogCancellation(h.directory).phase, 'APPLIED');
  assert.notEqual(readBacklogCancellation(h.directory).phase, 'COMPLETE');
});

test('v2 reports a real runtime failure after API start while retaining APPLIED and the exact resume', async (t) => {
  const h = harness(t);
  const diagnostics = [];
  const rows = legacyColdFleet();
  for (const row of rows) {
    row.Image = nomination.imageId;
    row.Config.Image = `maxim-api:${nomination.sourceSha}`;
    row.Config.Labels['org.opencontainers.image.revision'] = nomination.sourceSha;
  }
  const original = Object.assign(new Error('private-inspect-after-start'), {
    status: 1,
    stderr: 'private-docker-error',
  });
  let failRunningRead = true;
  let apiStarted = false;
  h.options.report = (value) => diagnostics.push(value);
  h.options.createRuntime = (options) =>
    createLegacyColdRuntime({
      ...options,
      run: (_executable, args) => {
        if (args[0] === 'ps') return rows.map((row) => row.Id).join('\n');
        if (args[0] === 'inspect') {
          if (apiStarted && failRunningRead) {
            failRunningRead = false;
            throw original;
          }
          return JSON.stringify(rows);
        }
        assert.ok(['start', 'stop'].includes(args[0]));
        const selected = args[0] === 'stop' ? args.slice(3) : args.slice(1);
        for (const id of selected) {
          const row = rows.find((candidate) => candidate.Id === id);
          assert.ok(row);
          Object.assign(row.State, {
            Running: args[0] === 'start',
            Status: args[0] === 'start' ? 'running' : 'exited',
          });
          if (row.State.Health) row.State.Health.Status = 'healthy';
        }
        if (args[0] === 'stop') {
          h.state.stopped = true;
          apiStarted = false;
        } else if (selected.length === 14) {
          h.state.stopped = false;
          apiStarted = true;
        }
        return '';
      },
    });
  const request = await h.preview();
  const previewBefore = readFileSync(join(h.op, 'preview.json'), 'utf8');
  await assert.rejects(runApplyHostV2(request, h.options), (error) => error === original);
  const journal = readBacklogCancellation(h.directory);
  assert.equal(journal.phase, 'APPLIED');
  assert.ok(rows.every((row) => row.State.Running === true));
  const failure = diagnostics.find((value) => value.event === 'failed');
  assert.equal(failure?.diagnostic, 'legacy_cold_progress');
  assert.equal(failure.stage, 'readRuntimeIdentity');
  assert.equal(failure.command, 'inspect');
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.code, 'unclassified_failure');
  assert.doesNotMatch(JSON.stringify(failure), /private-|stderr|Config|HostConfig/u);
  for (const value of [nomination.sourceSha, nomination.imageId, ...rows.map((row) => row.Id)])
    assert.equal(JSON.stringify(failure).includes(value), false);
  const resumed = await runApplyHostV2(request, h.options);
  assert.equal(resumed.outcome, 'APPLIED');
  assert.equal(readBacklogCancellation(h.directory).phase, 'COMPLETE');
  assert.deepEqual(readBacklogCancellation(h.directory).request, request);
  assert.deepEqual(readBacklogCancellation(h.directory).baseline, journal.baseline);
  assert.equal(readFileSync(join(h.op, 'preview.json'), 'utf8'), previewBefore);
});

test('unsafe evidence modes, links and oversized files refuse before any stop', async (t) => {
  for (const unsafe of ['mode', 'symlink', 'hardlink', 'size', 'utf8', 'bom']) {
    await t.test(unsafe, async (t) => {
      const h = harness(t);
      const request = await h.preview();
      const path = join(h.op, 'preview.json');
      if (unsafe === 'mode') chmodSync(path, 0o644);
      if (unsafe === 'symlink') {
        const target = join(h.op, 'foreign.json');
        writeFileSync(target, readFileSync(path), { mode: 0o600 });
        unlinkSync(path);
        symlinkSync(target, path);
      }
      if (unsafe === 'hardlink') linkSync(path, join(h.op, 'linked.json'));
      if (unsafe === 'size') writeFileSync(path, 'x'.repeat(8 * 1024 * 1024 + 1));
      if (unsafe === 'utf8') writeFileSync(path, Buffer.from([0xc3, 0x28]));
      if (unsafe === 'bom')
        writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(path)]));
      await assert.rejects(runApplyHostV2(request, h.options));
      assert.equal(h.events.includes('stop'), false);
    });
  }
});

test('full generation digest binds every API/native identity and boundary, ignoring only stopped bookkeeping', (t) => {
  const h = harness(t);
  const before = cancellationRuntimeDigestV2(h.baseline);
  const next = structuredClone(h.baseline);
  next.services.forEach((row) => {
    row.stopped = true;
  });
  assert.equal(cancellationRuntimeDigestV2(next), before);
  next.auxiliaries[1].nativeBoundaryDigest = 'f'.repeat(64);
  assert.notEqual(cancellationRuntimeDigestV2(next), before);
  next.auxiliaries.pop();
  assert.throws(() => cancellationRuntimeDigestV2(next), /Incomplete/);
});

test('actual helper launcher mounts immutable data only, forwards only store credentials and bounds every child', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  const invocations = [];
  const connection = {
    networkId: 'f'.repeat(64),
    environment: 'DATABASE_URL=postgresql://private\nREDIS_URL=redis://private\n',
  };
  const helpers = createBacklogCancellationHelpersV2({
    request,
    operationDirectory: h.op,
    connection,
    bindings: JSON.parse(readFileSync(join(h.op, 'bindings.json'))),
    executeDocker: () => '',
    spawnDocker(executable, args, options) {
      assert.equal(executable, 'docker');
      assert.equal(options.timeout + 5000 + 5000, 960_000);
      assert.equal(args[args.indexOf('--user') + 1], `${process.getuid()}:${process.getgid()}`);
      assert.equal(lstatSync(join(h.op, 'nomination.json')).uid, process.getuid());
      assert.equal(lstatSync(join(h.op, 'preview.json')).uid, process.getuid());
      assert.equal(lstatSync(join(h.op, 'bindings.json')).uid, process.getuid());
      assert.ok(args.includes('--read-only'));
      assert.ok(args.includes('no-new-privileges'));
      assert.ok(args.includes('--cap-drop'));
      const helperMode = args[args.indexOf('--label') + 3].split('=').at(-1);
      assert.equal(
        JSON.parse(readFileSync(join(h.op, `helper-cli-${helperMode}-unproved.json`)))
          .cliExitProven,
        false,
      );
      const identityProbe = args.includes('-e') && args.at(-2) === '-e';
      const envIndex = args.indexOf('--env-file');
      if (identityProbe) {
        assert.equal(envIndex, -1);
        assert.equal(args[args.indexOf('--network') + 1], 'none');
        assert.equal(args.includes('--mount'), false);
      } else {
        assert.ok(envIndex > 0);
        assert.equal(readFileSync(args[envIndex + 1], 'utf8'), connection.environment);
        assert.equal(lstatSync(args[envIndex + 1]).mode & 0o777, 0o600);
        const mounts = args.filter((_, index) => args[index - 1] === '--mount');
        assert.ok(mounts.length >= 2);
        for (const mount of mounts) {
          assert.match(
            mount,
            /dst=\/app\/backlog-cancellation-v2\/(nomination|preview|bindings)\.json,readonly$/,
          );
          assert.doesNotMatch(mount, /\.(mjs|cjs|js|ts),/);
        }
        assert.equal(
          args.some((value) => /MAX.*TOKEN|MAX_BOTS_JSON|MAX_API_/u.test(value)),
          false,
        );
        const cliMode = args.at(-2);
        const cold = ['--apply', '--prove-absent'].includes(cliMode);
        assert.ok(
          args.includes(
            `${cold ? 'MAXIM_BACKLOG_COLD_OPERATION' : 'MAXIM_BACKLOG_PREVIEW_OPERATION'}=${request.id}`,
          ),
        );
        assert.equal(
          args.some((value) =>
            value.startsWith(
              `${cold ? 'MAXIM_BACKLOG_PREVIEW_OPERATION' : 'MAXIM_BACKLOG_COLD_OPERATION'}=`,
            ),
          ),
          false,
        );
      }
      invocations.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.emit('exit', 0, null);
        child.stdout.end(identityProbe ? '3'.repeat(64) : '{}\n');
        child.stderr.end('DATABASE_URL=never-forward-this\n');
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  for (const mode of ['identity', 'preview', 'preflight', 'apply', 'prove-absent'])
    assert.equal((await helpers.run(mode, mode === 'preview' ? nomination : request)).code, 0);
  assert.equal(invocations.length, 5);
  assert.equal(
    readdirSync(h.op).some((file) => file.endsWith('.env')),
    false,
  );
  assert.equal(
    readdirSync(h.op).some((file) => file.endsWith('-unproved.json')),
    false,
  );
});

test('actual helper launcher rejects a foreign helper before any removal or child start', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  let removed = false,
    spawned = false;
  const helpers = createBacklogCancellationHelpersV2({
    request,
    operationDirectory: h.op,
    connection: {
      networkId: 'f'.repeat(64),
      environment: 'DATABASE_URL=private\nREDIS_URL=private\n',
    },
    bindings: {},
    executeDocker(args) {
      if (args[0] === 'ps') return 'a'.repeat(64);
      if (args[0] === 'inspect')
        return JSON.stringify([
          {
            Id: 'a'.repeat(64),
            Image: request.imageId,
            Config: { Labels: { 'com.maxim.backlog-cancellation': 'foreign-operation' } },
          },
        ]);
      removed = true;
      return '';
    },
    spawnDocker() {
      spawned = true;
      throw new Error('must not spawn');
    },
  });
  await assert.rejects(helpers.run('apply', request), /Foreign/);
  assert.equal(removed, false);
  assert.equal(spawned, false);
});

test('a private FIFO is refused without blocking the controller before fstat', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  const path = join(h.op, 'preview.json');
  unlinkSync(path);
  execFileSync('mkfifo', ['-m', '600', path], { timeout: 1000 });
  const source = `
    const { runApplyHostV2 } = await import(process.argv[1]);
    try {
      await runApplyHostV2(JSON.parse(process.argv[3]), {
        directory: process.argv[2], expectedSha: JSON.parse(process.argv[3]).sourceSha,
        assertLock() {}, assertMaintenance() {},
      });
      process.exitCode = 1;
    } catch (error) {
      if (error.message !== 'Unsafe bounded v2 evidence file') throw error;
      process.stdout.write('REFUSED');
    }
  `;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      source,
      new URL('./backlog-cancellation-v2-host.mjs', import.meta.url).href,
      h.directory,
      JSON.stringify(request),
    ],
    { timeout: 3000, encoding: 'utf8' },
  );
  assert.equal(output, 'REFUSED');
  assert.equal(h.events.includes('stop'), false);
});

test('final helper JSON is collected through pipe close, after process exit', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  const final = '{"last":"receipt"}\n';
  const helpers = createBacklogCancellationHelpersV2({
    request,
    operationDirectory: h.op,
    connection: {
      networkId: 'f'.repeat(64),
      environment: 'DATABASE_URL=private\nREDIS_URL=private\n',
    },
    bindings: {},
    executeDocker: () => '',
    spawnDocker() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.write('{"last":');
        child.emit('exit', 0, null);
        queueMicrotask(() => {
          child.stdout.end('"receipt"}\n');
          child.stderr.end();
          child.emit('close', 0, null);
        });
      });
      return child;
    },
  });
  assert.equal((await helpers.run('preflight', request)).stdout, final);
});

test('a helper CLI ignoring TERM is killed within a finite second deadline', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  const signals = [];
  const helpers = createBacklogCancellationHelpersV2({
    request,
    operationDirectory: h.op,
    connection: {
      networkId: 'f'.repeat(64),
      environment: 'DATABASE_URL=private\nREDIS_URL=private\n',
    },
    bindings: {},
    executeDocker: () => '',
    helperTimeoutMs: 30,
    killGraceMs: 10,
    closeGraceMs: 10,
    spawnDocker() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL')
          queueMicrotask(() => {
            child.stdout.end();
            child.stderr.end();
            child.emit('close', null, 'SIGKILL');
          });
        return true;
      };
      return child;
    },
  });
  await assert.rejects(helpers.run('apply', request), /execution failed/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  helpers.assertGone('apply');
  assert.equal(
    readdirSync(h.op).some((file) => file.endsWith('.env')),
    false,
  );
});

test('missing CLI close after KILL returns finitely but never grants helper absence', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  const signals = [];
  let detached = false;
  let stuckChild;
  const helpers = createBacklogCancellationHelpersV2({
    request,
    operationDirectory: h.op,
    connection: {
      networkId: 'f'.repeat(64),
      environment: 'DATABASE_URL=private\nREDIS_URL=private\n',
    },
    bindings: {},
    executeDocker: () => '',
    helperTimeoutMs: 30,
    killGraceMs: 10,
    closeGraceMs: 10,
    spawnDocker() {
      const child = new EventEmitter();
      stuckChild = child;
      child.pid = 12345;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        return true;
      };
      child.unref = () => {
        detached = true;
      };
      return child;
    },
  });
  await assert.rejects(helpers.run('apply', request), /CLI exit unproved/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(detached, true);
  assert.throws(() => helpers.assertGone('apply'), /CLI exit unproved/);
  const proofName = readdirSync(h.op).find((file) => file.startsWith('helper-timeout-'));
  assert.equal(JSON.parse(readFileSync(join(h.op, proofName))).cliExitProven, false);
  let resumed = false;
  const next = createBacklogCancellationHelpersV2({
    request,
    operationDirectory: h.op,
    connection: {},
    bindings: {},
    executeDocker: () => '',
    spawnDocker() {
      resumed = true;
      throw new Error('must not resume an unproved CLI');
    },
  });
  assert.throws(() => next.assertGone('apply'), /CLI exit unproved/);
  await assert.rejects(next.run('apply', request), /CLI exit unproved/);
  assert.equal(resumed, false);
  stuckChild.emit('close', null, 'SIGKILL');
  assert.throws(() => helpers.assertGone('apply'), /CLI exit unproved/);
  assert.throws(() => next.assertGone('apply'), /CLI exit unproved/);
  const restarted = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        const { createBacklogCancellationHelpersV2 } = await import(process.argv[1]);
        const helpers = createBacklogCancellationHelpersV2({
          request: JSON.parse(process.argv[3]), operationDirectory: process.argv[2],
          connection: {}, bindings: {}, executeDocker: () => '',
        });
        try { helpers.assertGone('apply'); throw new Error('unsafe restart'); }
        catch (error) {
          if (error.message !== 'V2 helper CLI exit unproved') throw error;
          process.stdout.write('BLOCKED');
        }
      `,
      new URL('./backlog-cancellation-v2-host.mjs', import.meta.url).href,
      h.op,
      JSON.stringify(request),
    ],
    { timeout: 3000, encoding: 'utf8' },
  );
  assert.equal(restarted, 'BLOCKED');
  assert.equal(
    readdirSync(h.op).some((file) => file.endsWith('.env')),
    false,
  );
});

test('new controller processes refuse a live recorded CLI and resume the same request after its exact identity exits', async (t) => {
  const h = harness(t);
  const request = await h.preview();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  assert.ok(child.pid > 0);
  const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
  const marker = {
    version: 2,
    id: request.id,
    mode: 'apply',
    pid: child.pid,
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
    cliExitProven: false,
  };
  const path = join(h.op, 'helper-cli-apply-unproved.json');
  writeFileSync(path, cancellationV2Bytes(marker), { mode: 0o600 });
  const source = `
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    const { createBacklogCancellationHelpersV2 } = await import(process.argv[1]);
    const request = JSON.parse(process.argv[3]);
    const helpers = createBacklogCancellationHelpersV2({
      request, operationDirectory: process.argv[2],
      connection: { networkId: 'f'.repeat(64), environment: 'DATABASE_URL=private\\nREDIS_URL=private\\n' },
      bindings: {}, executeDocker: () => '',
      spawnDocker() {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
        queueMicrotask(() => { child.stdout.end('{}\\n'); child.stderr.end(); child.emit('close', 0, null); });
        return child;
      },
    });
    try { await helpers.run('apply', request); process.stdout.write('RESUMED'); }
    catch (error) {
      if (error.message !== 'V2 helper CLI exit unproved') throw error;
      process.stdout.write('UNPROVED');
    }
  `;
  const probe = () =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        source,
        new URL('./backlog-cancellation-v2-host.mjs', import.meta.url).href,
        h.op,
        JSON.stringify(request),
      ],
      { timeout: 3000, encoding: 'utf8' },
    );
  assert.equal(probe(), 'UNPROVED');
  assert.equal(readFileSync(path, 'utf8'), cancellationV2Bytes(marker));
  const exited = once(child, 'close');
  child.kill('SIGTERM');
  await exited;
  assert.equal(probe(), 'RESUMED');
  assert.equal(readdirSync(h.op).includes('helper-cli-apply-unproved.json'), false);
  const proofName = readdirSync(h.op).find((file) => file.startsWith('helper-cli-apply-absence-'));
  const proof = JSON.parse(readFileSync(join(h.op, proofName)));
  assert.equal(proof.pid, child.pid);
  assert.equal(proof.startTicks, marker.startTicks);
  assert.equal(proof.cliExitProven, true);
});
