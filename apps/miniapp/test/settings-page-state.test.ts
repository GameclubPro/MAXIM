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
  assert.ok(SECTION_SETTING_KEYS.limits.includes('photoMessagesEnabled'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('messageLimitsBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.stopWords.includes('messageLimitsBlockedWords'));
  assert.ok(!SECTION_SETTING_KEYS.limits.includes('messageLimitsBlockedWords'));
  assert.ok(SECTION_SETTING_KEYS.night.includes('nightModeBotButtons'));
});

test('SECTION_SETTING_KEYS includes advanced tuning for links and duplicates plus phone allow toggle', () => {
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkEscalationWindowHours'));
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkWarnMaxCount'));
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkMuteMaxCount'));
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkBanMaxCount'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateDetectionPreset'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateIgnoreLinksEnabled'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateIgnorePhonesEnabled'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateNearMatchEnabled'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('phoneNumbersEnabled'));
  assert.ok(!SECTION_SETTING_KEYS.limits.includes('phoneNumbersEscalationWindowHours'));
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

test('mergeSectionSettings preserves advanced duplicate and link tuning plus phone allow toggle', () => {
  const current = createSettings({
    duplicateDetectionPreset: 'STANDARD',
    duplicateIgnoreLinksEnabled: false,
    duplicateIgnorePhonesEnabled: false,
    duplicateNearMatchEnabled: false,
    linkEscalationWindowHours: 24,
    linkWarnMaxCount: 2,
    linkMuteMaxCount: 3,
    linkBanMaxCount: 4,
    phoneNumbersEnabled: true,
    phoneNumbersEscalationWindowHours: 12,
  });
  const saved = createSettings({
    duplicateDetectionPreset: 'CUSTOM',
    duplicateIgnoreLinksEnabled: true,
    duplicateIgnorePhonesEnabled: true,
    duplicateNearMatchEnabled: true,
    linkEscalationWindowHours: 48,
    linkWarnMaxCount: 1,
    linkMuteMaxCount: 2,
    linkBanMaxCount: 3,
    phoneNumbersEnabled: false,
    phoneNumbersEscalationWindowHours: 72,
  });

  const duplicateMerged = mergeSectionSettings(current, saved, 'duplicates');
  assert.equal(duplicateMerged.duplicateDetectionPreset, 'CUSTOM');
  assert.equal(duplicateMerged.duplicateIgnoreLinksEnabled, true);
  assert.equal(duplicateMerged.duplicateIgnorePhonesEnabled, true);
  assert.equal(duplicateMerged.duplicateNearMatchEnabled, true);
  assert.equal(duplicateMerged.linkEscalationWindowHours, 24);

  const linkMerged = mergeSectionSettings(current, saved, 'links');
  assert.equal(linkMerged.linkEscalationWindowHours, 48);
  assert.equal(linkMerged.linkWarnMaxCount, 1);
  assert.equal(linkMerged.linkMuteMaxCount, 2);
  assert.equal(linkMerged.linkBanMaxCount, 3);
  assert.equal(linkMerged.phoneNumbersEscalationWindowHours, 12);

  const limitsMerged = mergeSectionSettings(current, saved, 'limits');
  assert.equal(limitsMerged.phoneNumbersEnabled, false);
  assert.equal(limitsMerged.phoneNumbersEscalationWindowHours, 12);
});

test('mergeSectionSettings syncs stop words without copying limit sanctions', () => {
  const current = createSettings({
    antiSpamEnabled: true,
    messageLimitsBlockedWords: ['старое'],
    messageLimitsBotMessageEnabled: false,
  });
  const saved = createSettings({
    antiSpamEnabled: false,
    messageLimitsBlockedWords: ['казино', 'ставки'],
    messageLimitsBotMessageEnabled: true,
  });

  const merged = mergeSectionSettings(current, saved, 'stopWords');
  assert.deepEqual(merged.messageLimitsBlockedWords, ['казино', 'ставки']);
  assert.equal(merged.messageLimitsBotMessageEnabled, false);
  assert.equal(merged.antiSpamEnabled, true);
});
