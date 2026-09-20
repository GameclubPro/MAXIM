import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DUPLICATE_PHOTO_SCOPE_OPTIONS } from '../src/pages/settings/settings-duplicate-photo-options';
import {
  formatDuplicateActionSummary,
  resolveDuplicatePhotoPresentationPolicy,
  resolveDuplicatePhotoPolicyForDraft,
} from '../src/pages/settings/settings-duplicate-photo-status';
import { buildChatSettingsScreen } from '../src/lib/api/preview-transport-settings';
import { createPreviewState } from '../src/lib/api/preview-transport-state';

const source = (name: string) =>
  readFileSync(new URL(`../src/pages/${name}`, import.meta.url), 'utf8');
const section = source('settings/settings-duplicates-section.tsx');
const photo = source('settings/settings-duplicate-photo-controls.tsx');
const state = source('settings-page-state.ts');
const full = {
  moderationMode: 'FULL' as const,
  actionCeiling: 'BAN' as const,
  allowedMatchKinds: ['canonical_sha256' as const],
};

test('image comparison offers only the administrator-selected author scope', () => {
  assert.deepEqual(
    DUPLICATE_PHOTO_SCOPE_OPTIONS.map((option) => option.value),
    ['SAME_AUTHOR', 'CHAT'],
  );
  assert.match(section, /setFieldValue\('duplicatePhotoScope', value\)/u);
  assert.doesNotMatch(photo, /onEnabledChange|matchPreset|MINOR_EDITS|pdq|onMatchPresetChange/u);
  assert.doesNotMatch(state, /'duplicatePhotoEnabled'|'duplicatePhotoMatchPreset'/u);
  assert.doesNotMatch(section, /draft\.duplicatePhotoEnabled|draft\.duplicatePhotoMatchPreset/u);
});

test('the main comparison mode owns images without an independent hidden toggle', () => {
  assert.match(section, /draft\.antiDuplicateEnabled && draft\.duplicateCompareMode !== 'TEXT'/u);
  assert.match(section, /value=\{draft\.duplicateCompareMode\}/u);
  const message = source('settings/settings-duplicate-message-controls.tsx');
  assert.match(message, /value="MESSAGE"/u);
  assert.match(message, /value="TEXT"/u);
});

test('exact images share full reactions and never promote a perceptual-only response', () => {
  assert.deepEqual(resolveDuplicatePhotoPresentationPolicy(full), full);
  assert.equal(
    resolveDuplicatePhotoPresentationPolicy({ ...full, allowedMatchKinds: ['pdq'] }).moderationMode,
    'OFF',
  );
  assert.equal(
    resolveDuplicatePhotoPresentationPolicy({ ...full, moderationMode: 'OBSERVE' }).moderationMode,
    'OFF',
  );
  assert.deepEqual(
    resolveDuplicatePhotoPolicyForDraft({ base: full, advanced: full }, 'OFF'),
    full,
  );
});

test('the action summary retains warnings, mute and ban for shared image moderation', () => {
  const summary = formatDuplicateActionSummary(
    {
      duplicateCompareMode: 'MESSAGE',
      duplicateBotMessageEnabled: true,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      duplicateMuteDurationHours: 12,
    },
    1,
    full,
  );
  assert.match(summary, /№3/u);
  assert.match(summary, /12/u);
  assert.doesNotMatch(summary, /дополнительн.*санкц|Без предупреждений и блокировок/u);
});

test('the preview uses the same exact full policy for both author scopes', () => {
  const preview = buildChatSettingsScreen(createPreviewState({}), '-123');
  assert.deepEqual(preview.duplicatePhotoPolicyMatrix, { base: full, advanced: full });
});

test('disabling the master switch does not rewrite the configured reaction ladder', () => {
  const start = section.indexOf('>Включить антидубль</span>');
  const end = section.indexOf('>Что проверять</h3>');
  const master = section.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(master, /setFieldValue\('antiDuplicateEnabled', event\.target\.checked\)/u);
  assert.doesNotMatch(master, /applyDuplicateFlowConfig/u);
  assert.match(section, /<LazySettingsDuplicateActionPreview/u);
});
