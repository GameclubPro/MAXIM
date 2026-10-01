import { BadRequestException } from '@nestjs/common';

import { applySettingsSectionToAllChats } from './admin-settings-apply';
import { SETTINGS_SECTION_KEYS } from './admin.service.support';
import { chatSettingsSchema, stopWordsPolicySchema } from '@maxim/contracts/settings';

describe('admin settings section apply', () => {
  it('rejects an intervening administrator edit before copying a report policy', async () => {
    const applySettings = jest.fn();
    await expect(
      applySettingsSectionToAllChats({
        sourceChatId: 'source',
        source: 'miniapp',
        body: {
          section: 'reports',
          expectedSourceSettingsRevision: '2026-10-01T10:00:00.000Z',
          confirmedTargetChatIds: ['target'],
          target: { mode: 'selectedChats', chatIds: ['target'] },
        },
        getSourceSettings: async () =>
          chatSettingsSchema.parse({
            settingsRevision: '2026-10-01T10:01:00.000Z',
            reportsDeleteMode: 'HISTORY_24H',
            reportsMuteEnabled: true,
          }),
        applySettings,
        syncDomainAllowlistToChats: jest.fn(),
      }),
    ).rejects.toMatchObject({ status: 409, response: { partialApplied: false, appliedCount: 0 } });
    expect(applySettings).not.toHaveBeenCalled();
  });

  it('passes one confirmed immutable report snapshot and the exact target set to the writer', async () => {
    const revision = '2026-10-01T10:00:00.000Z';
    const settings = chatSettingsSchema.parse({ settingsRevision: revision, reportsEnabled: true });
    const applySettings = jest.fn().mockResolvedValue({
      sourceChatId: 'source',
      updatedChats: 1,
      appliedChatIds: ['source'],
    });
    await applySettingsSectionToAllChats({
      sourceChatId: 'source',
      source: 'miniapp',
      body: {
        section: 'reports',
        expectedSourceSettingsRevision: revision,
        confirmedTargetChatIds: ['source'],
      },
      getSourceSettings: async () => settings,
      applySettings,
      syncDomainAllowlistToChats: jest.fn(),
    });
    expect(applySettings).toHaveBeenCalledWith(
      settings,
      { mode: 'current', favoriteTypes: [], chatIds: [] },
      SETTINGS_SECTION_KEYS.reports,
      [],
      ['source'],
      revision,
    );
  });

  it('rejects a changed source revision before copying a stop-list', async () => {
    const applySettings = jest.fn();
    await expect(
      applySettingsSectionToAllChats({
        sourceChatId: 'source',
        source: 'miniapp',
        body: { section: 'stopWords', expectedSourceRevision: 1 },
        getSourceSettings: async () =>
          chatSettingsSchema.parse({
            stopWordsPolicy: stopWordsPolicySchema.parse({}),
            stopWordsRevision: 2,
          }),
        applySettings,
        syncDomainAllowlistToChats: jest.fn(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(applySettings).not.toHaveBeenCalled();
  });
  it('does not expose the retired thematic section in the server mapping', () => {
    expect(SETTINGS_SECTION_KEYS).not.toHaveProperty('thematicFilters');
  });

  it('applies every photo duplicate setting with the duplicates section', () => {
    expect(SETTINGS_SECTION_KEYS.duplicates).toEqual(
      expect.arrayContaining([
        'duplicatePhotoEnabled',
        'duplicatePhotoMatchPreset',
        'duplicatePhotoScope',
        'duplicateCompareMode',
        'duplicateWindowMode',
        'duplicateStartTimeMinutes',
        'duplicateEndTimeMinutes',
        'duplicateTimezone',
      ]),
    );
  });

  it('applies profanity sensitivity with the profanity section', () => {
    expect(SETTINGS_SECTION_KEYS.profanityFilter).toContain('profanitySensitivity');
  });

  it('applies the complete independent policy without copying a source revision', () => {
    expect(SETTINGS_SECTION_KEYS.stopWords).toEqual(['stopWordsPolicy']);
  });

  it('keeps the storefront section scoped to its toggles and texts', () => {
    expect(SETTINGS_SECTION_KEYS.storefront).toEqual([
      'karavanStorefrontEnabled',
      'karavanStorefrontAdminsOnly',
      'karavanStorefrontMessageText',
      'karavanStorefrontOpenButtonText',
      'karavanStorefrontCatalogButtonText',
      'karavanStorefrontCreateButtonText',
    ]);
  });

  it('rejects a crafted request for the retired thematic section before applying settings', async () => {
    const getSourceSettings = jest.fn();
    const applySettings = jest.fn();
    const syncDomainAllowlistToChats = jest.fn();

    await expect(
      applySettingsSectionToAllChats({
        sourceChatId: 'chat-1',
        body: {
          section: 'thematicFilters',
          target: { mode: 'all', favoriteTypes: [], chatIds: [] },
        },
        source: 'miniapp',
        getSourceSettings,
        applySettings,
        syncDomainAllowlistToChats,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(getSourceSettings).not.toHaveBeenCalled();
    expect(applySettings).not.toHaveBeenCalled();
    expect(syncDomainAllowlistToChats).not.toHaveBeenCalled();
  });
});
