import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSettingsSchema, type ChatSettings } from '@maxim/contracts';
import {
  NIGHT_SECTION_SETTING_KEYS,
  applyNightModeBotMessageEnabledChange,
  applyNightModeEnabledChange,
  mergeNightSectionSettings,
} from '../src/pages/settings-page-state';

function createSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...chatSettingsSchema.parse({}),
    ...overrides,
  };
}

test('applyNightModeEnabledChange enables bot notice and clears dependent toggles on disable', () => {
  const enabled = applyNightModeEnabledChange(createSettings(), true);
  assert.equal(enabled.nightModeEnabled, true);
  assert.equal(enabled.nightModeBotMessageEnabled, true);

  const disabled = applyNightModeEnabledChange(
    createSettings({
      nightModeEnabled: true,
      nightModeBotMessageEnabled: true,
      nightModeCommentsEnabled: true,
      nightModeBotButtonEnabled: true,
      nightModeRulesButtonEnabled: true,
    }),
    false,
  );
  assert.equal(disabled.nightModeEnabled, false);
  assert.equal(disabled.nightModeBotMessageEnabled, false);
  assert.equal(disabled.nightModeCommentsEnabled, false);
  assert.equal(disabled.nightModeBotButtonEnabled, false);
  assert.equal(disabled.nightModeRulesButtonEnabled, false);
});

test('applyNightModeBotMessageEnabledChange clears dependent toggles when bot notice is disabled', () => {
  const next = applyNightModeBotMessageEnabledChange(
    createSettings({
      nightModeBotMessageEnabled: true,
      nightModeCommentsEnabled: true,
      nightModeBotButtonEnabled: true,
      nightModeRulesButtonEnabled: true,
    }),
    false,
  );

  assert.equal(next.nightModeBotMessageEnabled, false);
  assert.equal(next.nightModeCommentsEnabled, false);
  assert.equal(next.nightModeBotButtonEnabled, false);
  assert.equal(next.nightModeRulesButtonEnabled, false);
});

test('mergeNightSectionSettings syncs nightModeRulesButtonEnabled as part of section save', () => {
  assert.ok(NIGHT_SECTION_SETTING_KEYS.includes('nightModeRulesButtonEnabled'));

  const current = createSettings({
    linkPolicy: 'BLOCKLIST_ONLY',
    nightModeBotMessageEnabled: true,
    nightModeRulesButtonEnabled: false,
  });
  const saved = createSettings({
    linkPolicy: 'ALLOWLIST_ONLY',
    nightModeBotMessageEnabled: true,
    nightModeRulesButtonEnabled: true,
  });

  const merged = mergeNightSectionSettings(current, saved);
  assert.equal(merged.nightModeRulesButtonEnabled, true);
  assert.equal(merged.nightModeBotMessageEnabled, true);
  assert.equal(merged.linkPolicy, 'BLOCKLIST_ONLY');
});
