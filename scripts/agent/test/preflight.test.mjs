import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runPreflight } from '../preflight.mjs';

const root = resolve(import.meta.dirname, '../../..');
test('fast preflight checks current source without building dist or changing generated files', () => {
  const generated = [
    'infra/scripts/lib/change-impact-components.generated.sh',
    'apps/api/src/moderation/commercial-ocr/commercial-ocr-detector-source.generated.ts',
  ];
  const before = generated.map((path) => readFileSync(resolve(root, path), 'utf8'));
  const messages = [];
  runPreflight(root, (message) => messages.push(message));
  assert.equal(messages.filter((line) => line.includes('passed')).length, 4);
  assert.match(messages.at(-1), /exact-SHA CI are still required/u);
  assert.deepEqual(
    generated.map((path) => readFileSync(resolve(root, path), 'utf8')),
    before,
  );
});
