import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chatSettingsSchema } from '@maxim/contracts';
import { createPreviewState } from '../src/lib/api/preview-transport-state';
import {
  PROFANITY_SENSITIVITY_LABELS,
  PROFANITY_SENSITIVITY_HINTS,
  PROFANITY_SENSITIVITY_OPTIONS,
} from '../src/pages/settings-page.constants';

const settingsPageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);

test('profanity sensitivity exposes the three product modes in display order', () => {
  assert.deepEqual(PROFANITY_SENSITIVITY_OPTIONS, [
    { value: 'CORE_ONLY', label: 'Только мат' },
    { value: 'BALANCED', label: 'Баланс' },
    { value: 'STRICT', label: 'Строго' },
  ]);
  assert.equal(PROFANITY_SENSITIVITY_LABELS.CORE_ONLY, 'Только мат');
  assert.equal(PROFANITY_SENSITIVITY_LABELS.BALANCED, 'Баланс');
  assert.equal(PROFANITY_SENSITIVITY_LABELS.STRICT, 'Строго');
  assert.match(PROFANITY_SENSITIVITY_HINTS.CORE_ONLY, /явным матом/u);
  assert.match(PROFANITY_SENSITIVITY_HINTS.BALANCED, /бытовые ругательства пропускает/u);
  assert.match(PROFANITY_SENSITIVITY_HINTS.STRICT, /адресные бытовые оскорбления/u);
});

test('profanity sensitivity defaults and preview transport stay balanced', () => {
  assert.equal(chatSettingsSchema.parse({}).profanitySensitivity, 'BALANCED');
  assert.equal(createPreviewState({ search: '' }).chatSettings.profanitySensitivity, 'BALANCED');
});

test('profanity sensitivity selection is wired into section dirty, save, and discard state', () => {
  assert.match(
    settingsPageSource,
    /onChange=\{\(value\) => setFieldValue\('profanitySensitivity', value\)\}/u,
  );
  assert.match(settingsPageSource, /footer=\{renderSectionSaveFooter\('profanityFilter'\)\}/u);
  assert.match(
    settingsPageSource,
    /onDiscardChanges=\{\(\) => discardSectionChanges\('profanityFilter'\)\}/u,
  );
});
