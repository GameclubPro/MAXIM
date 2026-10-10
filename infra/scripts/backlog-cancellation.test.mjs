import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBacklogCancellationRequest } from './backlog-cancellation-host.mjs';
import {
  assertNoActiveBacklogCancellation,
  readBacklogCancellation,
  writeBacklogCancellation,
  readBacklogCancellationForRequest,
} from './backlog-cancellation-journal.mjs';

const request = {
  id: 'f153ec6c-78ad-4e9a-a295-a02389c5cc3a',
  cutoff: '2026-10-10T00:00:00.000Z',
  sourceSha: 'a'.repeat(40),
  imageId: `sha256:${'b'.repeat(64)}`,
};
test('partial cancellation fences other operations and preserves the same resume identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-test-'));
  try {
    assertNoActiveBacklogCancellation(directory);
    for (const phase of ['PREPARED', 'STOPPED', 'APPLIED']) {
      writeBacklogCancellation(directory, { version: 1, request, phase });
      assert.equal(readBacklogCancellation(directory).phase, phase);
      assert.throws(() => assertNoActiveBacklogCancellation(directory), /Active backlog/);
      assert.throws(
        () => assertNoActiveBacklogCancellation(directory, 'foreign'),
        /Active backlog/,
      );
      assertNoActiveBacklogCancellation(directory, request.id);
    }
    writeBacklogCancellation(directory, { version: 1, request, phase: 'COMPLETE' });
    assertNoActiveBacklogCancellation(directory);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test('the host requires an exact cutoff, source and image', () => {
  assert.deepEqual(parseBacklogCancellationRequest(JSON.stringify(request)), request);
  for (const invalid of [
    { ...request, cutoff: 'tomorrow' },
    { ...request, sourceSha: 'main' },
    { ...request, imageId: 'maxim-api:latest' },
    { ...request, force: true },
  ])
    assert.throws(
      () => parseBacklogCancellationRequest(JSON.stringify(invalid)),
      /Invalid cancellation/,
    );
});

test('a new request archives completed evidence while every interrupted identity stays immutable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-next-'));
  const next = { ...request, id: 'a153ec6c-78ad-4e9a-a295-a02389c5cc3a' };
  try {
    for (const phase of ['PREPARED', 'STOPPED', 'APPLIED']) {
      writeBacklogCancellation(directory, { version: 1, request, phase });
      assert.throws(() => readBacklogCancellationForRequest(directory, next), /immutable/);
      assert.deepEqual(readBacklogCancellationForRequest(directory, request).request, request);
    }
    writeBacklogCancellation(directory, { version: 1, request, phase: 'COMPLETE' });
    const raw = readFileSync(join(directory, 'backlog-cancellation.json'));
    assert.throws(
      () =>
        readBacklogCancellationForRequest(directory, {
          ...request,
          cutoff: '2026-10-09T00:00:00.000Z',
        }),
      /immutable/,
    );
    assert.equal(readBacklogCancellationForRequest(directory, next), null);
    assert.equal(readBacklogCancellationForRequest(directory, next), null);
    assert.deepEqual(readFileSync(join(directory, 'backlog-cancellation.json')), raw);
    const archives = readdirSync(directory).filter((name) =>
      name.startsWith('backlog-cancellation.complete-'),
    );
    assert.equal(archives.length, 1);
    assert.deepEqual(readFileSync(join(directory, archives[0])), raw);
    writeBacklogCancellation(directory, { version: 1, request: next, phase: 'PREPARED' });
    assert.throws(() => readBacklogCancellationForRequest(directory, request), /immutable/);
    assert.deepEqual(readFileSync(join(directory, archives[0])), raw);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
