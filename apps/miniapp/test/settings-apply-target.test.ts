import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applySectionTargetPreviewResponseSchema,
  applySectionToAllResponseSchema,
} from '@maxim/contracts/settings';
import {
  createDefaultApplySettingsTarget,
  formatApplyTargetCountLabel,
  isApplySettingsTargetPreviewCurrent,
} from '../src/pages/settings/settings-apply-target';

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

test('apply target confirmation rejects a preview for a different target mode', () => {
  const currentTarget = createDefaultApplySettingsTarget();
  const currentPreview = applySectionTargetPreviewResponseSchema.parse({
    sourceChatId: 'chat-1',
    targetMode: 'current',
    updatedChats: 1,
    appliedChatIds: ['chat-1'],
  });

  assert.equal(isApplySettingsTargetPreviewCurrent(currentTarget, null), false);
  assert.equal(isApplySettingsTargetPreviewCurrent(currentTarget, currentPreview), true);
  assert.equal(
    isApplySettingsTargetPreviewCurrent({ ...currentTarget, mode: 'all' }, currentPreview),
    false,
  );
  assert.match(applyTargetSheetSource, /const canConfirm =\s*previewMatchesTarget &&/u);
});

test('apply target confirmation compares the complete favorite selection without order dependence', () => {
  const target = {
    ...createDefaultApplySettingsTarget(),
    mode: 'favoriteTypes' as const,
    favoriteTypes: ['watch', 'important'] as const,
  };
  const preview = applySectionTargetPreviewResponseSchema.parse({
    sourceChatId: 'chat-1',
    targetMode: 'favoriteTypes',
    favoriteTypes: ['important', 'watch'],
    updatedChats: 3,
    appliedChatIds: ['chat-1', 'chat-2', 'chat-3'],
  });

  assert.equal(
    isApplySettingsTargetPreviewCurrent(
      { ...target, favoriteTypes: [...target.favoriteTypes] },
      preview,
    ),
    true,
  );
  assert.equal(
    isApplySettingsTargetPreviewCurrent({ ...target, favoriteTypes: ['important'] }, preview),
    false,
  );
  assert.equal(
    isApplySettingsTargetPreviewCurrent(
      { ...target, favoriteTypes: ['important', 'partner'] },
      preview,
    ),
    false,
  );
  assert.equal(
    isApplySettingsTargetPreviewCurrent({ ...target, favoriteTypes: [] }, preview),
    false,
  );
});

test('selected chat previews cannot confirm another chat selection', () => {
  const target = {
    ...createDefaultApplySettingsTarget(),
    mode: 'selectedChats' as const,
    chatIds: ['chat-2', 'chat-1'],
  };
  const preview = applySectionTargetPreviewResponseSchema.parse({
    sourceChatId: 'chat-1',
    targetMode: 'selectedChats',
    updatedChats: 2,
    appliedChatIds: ['chat-1', 'chat-2'],
  });

  assert.equal(isApplySettingsTargetPreviewCurrent(target, preview), true);
  assert.equal(
    isApplySettingsTargetPreviewCurrent({ ...target, chatIds: ['chat-3', 'chat-1'] }, preview),
    false,
  );
});

test('target picker names the affected chats and freezes selection during application', () => {
  assert.match(applyTargetSheetSource, /sampleChats\.slice\(0, 4\)/u);
  assert.match(applyTargetSheetSource, /aria-label="Выбранные чаты"/u);
  assert.match(applyTargetSheetSource, /<li key=\{chat\.id\}>\{chat\.title\}<\/li>/u);
  assert.match(applyTargetSheetSource, /aria-pressed=\{[\s\S]*?disabled=\{isApplying\}/u);
  assert.match(
    applyTargetSheetSource,
    /disabled=\{isApplying \|\| favoriteLabelsStatus !== 'ready'\}/u,
  );
  assert.match(applyTargetSheetSource, /Сохраним этот чат и заменим настройки раздела/u);
  assert.match(
    applyTargetSheetSource,
    /onClick=\{\(\) => \{\s*if \(canConfirm\) \{\s*onConfirm\(\)/u,
  );
});

test('an in-flight apply consumes native Back and Escape before parent dialogs can close', () => {
  assert.match(
    applyTargetSheetSource,
    /useNativeBackHandler\(\s*\(\) => \{\s*if \(isApplying\) \{\s*return true;/u,
  );
  assert.match(
    applyTargetSheetSource,
    /if \(!panel \|\| !isTopmostModalDialog\(panel\)\) \{\s*return;\s*\}\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);\s*if \(!isApplying\) \{\s*onClose\(\);/u,
  );
  assert.doesNotMatch(applyTargetSheetSource, /event\.key !== 'Escape' \|\| isApplying/u);
});

test('target counts use the correct Russian form including teens', () => {
  for (const [count, expected] of [
    [0, '0 чатов'],
    [1, '1 чат'],
    [2, '2 чата'],
    [5, '5 чатов'],
    [11, '11 чатов'],
    [21, '21 чат'],
    [22, '22 чата'],
    [111, '111 чатов'],
  ] as const) {
    assert.equal(formatApplyTargetCountLabel(count), expected);
  }
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
    /disabled=\{isApplying \|\| favoriteLabelsStatus !== 'ready'\}[\s\S]*?Названия категорий временно недоступны/u,
  );
});
