import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runOrderedAnchorInventory } from './webhook-ordered-anchor-inventory-cli.mjs';
const request = {
  version: 2,
  inventoryId: '023bd9c1-069c-4adc-840c-d46e9069c413',
  sourceSha: 'a'.repeat(40),
  imageId: `sha256:${'b'.repeat(64)}`,
  cutoff: '2026-10-09T16:10:00.000Z',
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-anchor-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const runtime = { generation: 1 };
function row(index) {
  return {
    id: `event_${index}`,
    orderChatId: '-123',
    createdAt: `2026-10-08T12:00:00.${String(index).padStart(6, '0')}Z`,
    status: index % 2 ? 'RECEIVED' : 'FAILED',
    normalizedBounded: true,
    ordered: true,
    chatId: '-123',
    messageId: `message_${index}`,
    semanticKey: `semantic_${index}`,
    botId: 'major',
    legacyReleased: false,
    sourceReleased: false,
    retry: 'none',
    quarantine: 'none',
    errorFamily: 'timeout_quarantine',
    claim: {
      semanticFound: true,
      directCount: 1,
      conflict: false,
      id: `claim_${index}`,
      ownerId: `event_${index}`,
      status: 'READY',
      enforced: true,
      prepared: true,
      started: true,
      completed: false,
      lease: 'absent',
      checkpoint: 'none',
    },
  };
}
function page(parameters, rows, hasMore) {
  const last = rows.at(-1);
  return {
    version: 2,
    kind: 'ordered_anchor_inventory_page',
    readOnly: true,
    observedAt: '2026-10-09T16:20:00.000000Z',
    ...parameters,
    rawCount: hasMore ? 201 : rows.length,
    hasMore,
    nextCursor: last ? { chatId: last.orderChatId, createdAt: last.createdAt, id: last.id } : null,
    rows,
    coverage: 'ONLINE_PREVIEW',
    mutationAuthorized: false,
  };
}
const options = (directory) => ({
  request,
  directory,
  attest: () => runtime,
  readPage: (parameters) => ({ page: page(parameters, [], false), plan: {} }),
});
test('one actual EOF completes the exact ordered scope only', (t) => {
  const result = runOrderedAnchorInventory(options(fixture(t)));
  assert.equal(result.report.complete, true);
  assert.equal(result.report.scope, 'ordered_nonnull_chat');
  assert.equal(result.report.closedWorldComplete, false);
  assert.equal(result.mutationAuthorized, false);
});
test('401 mixed-status anchors traverse exactly once across process resumes', (t) => {
  const directory = fixture(t),
    starts = [];
  const input = {
    ...options(directory),
    pageLimit: 1,
    readPage(parameters) {
      const start = parameters.after ? Number(parameters.after.id.slice(6)) + 1 : 0;
      starts.push(start);
      return {
        page: page(
          parameters,
          Array.from({ length: Math.min(200, 401 - start) }, (_, i) => row(start + i)),
          start + 200 < 401,
        ),
        plan: {},
      };
    },
  };
  let result = runOrderedAnchorInventory(input);
  result = runOrderedAnchorInventory({ ...input, expectedCheckpoint: result.checkpointSha256 });
  result = runOrderedAnchorInventory({ ...input, expectedCheckpoint: result.checkpointSha256 });
  assert.deepEqual(starts, [0, 200, 400]);
  assert.equal(result.report.rowObservations, 401);
  assert.equal(result.report.nominatedOwners, 401);
  assert.equal(result.report.complete, true);
  assert.equal(JSON.stringify(result).includes('event_'), false);
});
test('failed query does not advance and status makes no runtime/database call', (t) => {
  const directory = fixture(t);
  const first = runOrderedAnchorInventory({
    ...options(directory),
    pageLimit: 1,
    readPage: (p) => ({
      page: page(
        p,
        Array.from({ length: 200 }, (_, i) => row(i)),
        true,
      ),
      plan: {},
    }),
  });
  assert.throws(
    () =>
      runOrderedAnchorInventory({
        ...options(directory),
        expectedCheckpoint: first.checkpointSha256,
        readPage() {
          throw Error('timeout');
        },
      }),
    /timeout/u,
  );
  const current = runOrderedAnchorInventory({
    ...options(directory),
    statusOnly: true,
    attest() {
      throw Error('no probe');
    },
    readPage() {
      throw Error('no query');
    },
  });
  assert.equal(current.checkpointSha256, first.checkpointSha256);
  assert.equal(current.report.rowObservations, 200);
  assert.equal(current.report.complete, false);
});
test('runtime drift between query and commit preserves an empty journal', (t) => {
  const directory = fixture(t);
  let calls = 0;
  assert.throws(
    () =>
      runOrderedAnchorInventory({ ...options(directory), attest: () => ({ generation: ++calls }) }),
    /runtime_changed/u,
  );
  assert.equal(readdirSync(directory).includes('checkpoint.json'), false);
});
test('stale checkpoint and altered immutable page are refused before new SQL', (t) => {
  const directory = fixture(t);
  runOrderedAnchorInventory(options(directory));
  assert.throws(
    () => runOrderedAnchorInventory({ ...options(directory), expectedCheckpoint: 'c'.repeat(64) }),
    /checkpoint_changed/u,
  );
  const file = readdirSync(directory).find((v) => v.startsWith('page-'));
  const path = join(directory, file);
  const original = readFileSync(path);
  writeFileSync(path, Buffer.concat([original, Buffer.from(' ')]));
  assert.throws(
    () => runOrderedAnchorInventory({ ...options(directory), statusOnly: true }),
    /artifact_changed/u,
  );
});
test('unreferenced page after interruption cannot produce progress', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'page-999999-orphan.json'), '{}', { mode: 0o600 });
  const result = runOrderedAnchorInventory({ ...options(directory), statusOnly: true });
  assert.equal(result.report.pages, 0);
  assert.equal(result.report.complete, false);
});
