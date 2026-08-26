import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const hookSource = readFileSync(
  new URL('../src/components/vk-parsing/use-vk-parsing-card.ts', import.meta.url),
  'utf8',
);
const previewSource = readFileSync(
  new URL('../src/lib/api/preview-transport-vk.ts', import.meta.url),
  'utf8',
);

test('manual VK publish reports queue acceptance instead of premature delivery', () => {
  assert.match(hookSource, /Пост поставлен в очередь/u);
  assert.doesNotMatch(hookSource, /title: 'Пост опубликован'/u);
  assert.match(previewSource, /status: 'NEW'/u);
  assert.match(previewSource, /queued: 1/u);
});
