import { BadRequestException } from '@nestjs/common';

import { applySettingsSectionToAllChats } from './admin-settings-apply';
import { SETTINGS_SECTION_KEYS } from './admin.service.support';

describe('admin settings section apply', () => {
  it('does not expose the retired thematic section in the server mapping', () => {
    expect(SETTINGS_SECTION_KEYS).not.toHaveProperty('thematicFilters');
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
