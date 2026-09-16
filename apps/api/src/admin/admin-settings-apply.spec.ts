import { BadRequestException } from '@nestjs/common';

import { applySettingsSectionToAllChats } from './admin-settings-apply';
import { SETTINGS_SECTION_KEYS } from './admin.service.support';
import { chatSettingsSchema, stopWordsPolicySchema } from '@maxim/contracts/settings';

describe('admin settings section apply', () => {
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
