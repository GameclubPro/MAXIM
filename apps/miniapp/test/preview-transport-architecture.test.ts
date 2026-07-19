import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const apiDirectory = new URL('../src/lib/api/', import.meta.url);
const facadeFile = new URL('preview-transport.ts', apiDirectory);
const removedFixtureFile = new URL('preview-transport-fixtures.ts', apiDirectory);

const domainLimits = new Map([
  ['preview-transport-autoposts.ts', 1_500],
  ['preview-transport-dialog.ts', 1_500],
  ['preview-transport-events-fixtures.ts', 1_500],
  ['preview-transport-events.ts', 1_500],
  ['preview-transport-giveaways.ts', 1_500],
  ['preview-transport-publications.ts', 1_500],
  ['preview-transport-runtime.ts', 1_500],
  ['preview-transport-settings.ts', 1_500],
  ['preview-transport-shared.ts', 1_500],
  ['preview-transport-state.ts', 1_500],
  ['preview-transport-system.ts', 1_500],
  ['preview-transport-vk.ts', 1_500],
]);

function lineCount(source: string): number {
  return source.split(/\r?\n/u).length;
}

test('preview transport keeps domain ownership and line-count boundaries', () => {
  const facade = readFileSync(facadeFile, 'utf8');
  assert.ok(lineCount(facade) <= 300, 'preview transport facade must stay at or below 300 lines');
  assert.equal(
    existsSync(removedFixtureFile),
    false,
    'shared preview fixture hotspot must not return',
  );

  for (const [fileName, limit] of domainLimits) {
    const file = new URL(fileName, apiDirectory);
    assert.equal(existsSync(file), true, `${fileName} must exist`);
    const count = lineCount(readFileSync(file, 'utf8'));
    assert.ok(count <= limit, `${fileName} has ${count} lines; limit is ${limit}`);
  }

  const ownership = new Map([
    ['preview-transport-system.ts', 'handleSystemPreviewRequest'],
    ['preview-transport-settings.ts', 'handleSettingsPreviewRequest'],
    ['preview-transport-events.ts', 'handleEventsPreviewRequest'],
    ['preview-transport-dialog.ts', 'handleDialogPreviewRequest'],
    ['preview-transport-vk.ts', 'handleVkPreviewRequest'],
    ['preview-transport-giveaways.ts', 'handleGiveawaysPreviewRequest'],
    ['preview-transport-publications.ts', 'handlePublicationsPreviewRequest'],
    ['preview-transport-autoposts.ts', 'handleAutopostsPreviewRequest'],
  ]);
  for (const [fileName, handlerName] of ownership) {
    const source = readFileSync(new URL(fileName, apiDirectory), 'utf8');
    assert.match(source, new RegExp(`export const ${handlerName}\\b`, 'u'));
    assert.doesNotMatch(facade, new RegExp(`export const ${handlerName}\\b`, 'u'));
  }
});
