import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applySectionToAllResponseSchema } from '@maxim/contracts/settings';
import { createDefaultApplySettingsTarget } from '../src/pages/settings/settings-apply-target';

const applyTargetSheetSource = readFileSync(
  new URL('../src/pages/settings/settings-apply-target-sheet.tsx', import.meta.url),
  'utf8',
);

test('settings apply target defaults to current chat', () => {
  assert.deepEqual(createDefaultApplySettingsTarget(), {
    mode: 'current',
    favoriteTypes: [],
    chatIds: [],
  });
});

test('apply section response fallback defaults to current target mode', () => {
  const parsed = applySectionToAllResponseSchema.parse({
    section: 'links',
    sourceChatId: 'chat-1',
    updatedChats: 1,
    appliedChatIds: ['chat-1'],
  });

  assert.equal(parsed.targetMode, 'current');
});

test('settings target picker validates cached labels without claiming legacy storage', () => {
  assert.match(applyTargetSheetSource, /loadManagedEntityFavoriteLabels/u);
  assert.match(applyTargetSheetSource, /getMe\(api,/u);
  assert.match(
    applyTargetSheetSource,
    /server\.initialized[\s\S]*?hydrateHomeEntityFavoriteLabelMigrationCandidate\(`u:\$\{userId\}`[\s\S]*?waitForNativeStorage: true/u,
  );
  assert.match(
    applyTargetSheetSource,
    /import\('\.\.\/\.\.\/lib\/home-entity-favorite-label-sync'\)/u,
  );
  assert.doesNotMatch(
    applyTargetSheetSource,
    /updateManagedEntityFavoriteLabels|mode: 'initialize'/u,
  );
  assert.doesNotMatch(
    applyTargetSheetSource,
    /saveHomeEntityFavoriteLabels|readHomeEntityFavoriteLabels|getHomeEntityFavoritesFallbackScope/u,
  );
  assert.match(
    applyTargetSheetSource,
    /disabled=\{favoriteLabelsStatus !== 'ready'\}[\s\S]*?Названия категорий временно недоступны/u,
  );
});
