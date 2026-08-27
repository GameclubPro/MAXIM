import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const shellSource = readFileSync(new URL('../src/components/shell.tsx', import.meta.url), 'utf8');

test('Publik entity modules route is registered only for the publisher profile', () => {
  assert.match(
    appSource,
    /!moderationProfile\s*\?\s*\([\s\S]*?path="\/publisher\/:entityType\/:entityId"[\s\S]*?LazyPublisherEntityModulesPage/u,
  );
});

test('Publik module workspace owns its header without a duplicate shell topbar', () => {
  assert.match(
    shellSource,
    /isPublisherEntityModulesRoute[\s\S]*?profile === 'publisher'[\s\S]*?\/publisher/u,
  );
  assert.match(shellSource, /!isPublisherEntityModulesRoute/u);
});
