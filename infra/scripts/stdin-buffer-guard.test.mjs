import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

test('operational stdin readers decode only after buffering the complete pipe', () => {
  const root = import.meta.dirname;
  // FLAG: Node 24 can corrupt memory on fragmented pipes with its encoded read fast path.
  // https://github.com/nodejs/node/issues/66341 — read bytes, then decode the Buffer.
  const unsafeReader = /\breadFileSync\s*\(\s*(?:0|process\.stdin\.fd)\s*,/u;
  const violations = readdirSync(root, { recursive: true })
    .filter((path) => /\.(?:sh|mjs|cjs)$/u.test(path))
    .filter((path) => unsafeReader.test(readFileSync(resolve(root, path), 'utf8')));
  assert.deepEqual(violations, [], 'Use readFileSync(0).toString("utf8") for stdin');
});
