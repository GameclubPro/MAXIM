import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSettingsSchema, type ChatSettings } from '@maxim/contracts';
import {
  SECTION_SETTING_KEYS,
  NIGHT_SECTION_SETTING_KEYS,
  applyNightModeBotMessageEnabledChange,
  applyNightModeEnabledChange,
  mergeNightSectionSettings,
  mergeSectionSettings,
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
  assert.ok(NIGHT_SECTION_SETTING_KEYS.includes('nightModeBotButtons'));

  const current = createSettings({
    linkPolicy: 'BLOCKLIST_ONLY',
    nightModeBotMessageEnabled: true,
    nightModeRulesButtonEnabled: false,
  });
  const saved = createSettings({
    linkPolicy: 'ALLOWLIST_ONLY',
    nightModeBotMessageEnabled: true,
    nightModeBotButtons: [
      { text: 'Кнопка 1', url: 'https://max.ru/channel/night-1' },
      { text: 'Кнопка 2', url: 'https://max.ru/channel/night-2' },
    ],
    nightModeRulesButtonEnabled: true,
  });

  const merged = mergeNightSectionSettings(current, saved);
  assert.deepEqual(merged.nightModeBotButtons, saved.nightModeBotButtons);
  assert.equal(merged.nightModeRulesButtonEnabled, true);
  assert.equal(merged.nightModeBotMessageEnabled, true);
  assert.equal(merged.linkPolicy, 'BLOCKLIST_ONLY');
});

test('SECTION_SETTING_KEYS includes button arrays for every multi-button section', () => {
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.greeting.includes('greetingBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.commercialFilter.includes('textFiltersBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.thematicFilters.includes('thematicFiltersBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('messageLimitsBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.night.includes('nightModeBotButtons'));
});

test('SECTION_SETTING_KEYS includes admin contact toggles for sanction sections', () => {
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkAdminContactButtonEnabled'));
  assert.ok(SECTION_SETTING_KEYS.profanityFilter.includes('profanityAdminContactButtonEnabled'));
  assert.ok(SECTION_SETTING_KEYS.commercialFilter.includes('textFiltersAdminContactButtonEnabled'));
  assert.ok(
    SECTION_SETTING_KEYS.thematicFilters.includes('thematicFiltersAdminContactButtonEnabled'),
  );
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateAdminContactButtonEnabled'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('messageLimitsAdminContactButtonEnabled'));
  assert.ok(
    SECTION_SETTING_KEYS.requiredSubscription.includes(
      'requiredSubscriptionAdminContactButtonEnabled',
    ),
  );
  assert.ok(
    SECTION_SETTING_KEYS.invitationAccess.includes('invitationAccessAdminContactButtonEnabled'),
  );
});

test('mergeSectionSettings preserves multi-button arrays when saving a section', () => {
  const current = createSettings({
    deleteSpammersEnabled: true,
    linkBotButtons: [{ text: 'Старая', url: 'https://max.ru/channel/old' }],
  });
  const saved = createSettings({
    deleteSpammersEnabled: false,
    linkBotButtons: [
      { text: 'Первая', url: 'https://max.ru/channel/first' },
      { text: 'Вторая', url: 'https://max.ru/channel/second' },
    ],
    linkBotButtonEnabled: true,
    linkBotButtonUrl: 'https://max.ru/channel/first',
    linkBotButtonText: 'Первая',
  });

  const merged = mergeSectionSettings(current, saved, 'links');
  assert.deepEqual(merged.linkBotButtons, saved.linkBotButtons);
  assert.equal(merged.linkBotButtonEnabled, true);
  assert.equal(merged.deleteSpammersEnabled, true);
});
