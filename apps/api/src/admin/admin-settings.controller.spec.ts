import { BadRequestException } from '@nestjs/common';
import { AdminSettingsController } from './admin-settings.controller';

const user = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

describe('AdminSettingsController capability recheck query', () => {
  it('passes the exact recheck flag into a chat settings mutation', async () => {
    const settingsService = { updateSettings: jest.fn().mockResolvedValue({}) };
    const controller = new AdminSettingsController(settingsService as never);

    await controller.updateSettings('chat-1', user, { nightModeEnabled: true }, '1');

    expect(settingsService.updateSettings).toHaveBeenCalledWith(
      'chat-1',
      user,
      { nightModeEnabled: true },
      'miniapp',
      { forceLiveBotCapabilityCheck: true },
    );
  });

  it('rejects every nonempty recheck value except exact 1', () => {
    const settingsService = { updateSettings: jest.fn() };
    const controller = new AdminSettingsController(settingsService as never);

    expect(() => controller.updateSettings('chat-1', user, {}, 'true')).toThrow(
      BadRequestException,
    );
    expect(settingsService.updateSettings).not.toHaveBeenCalled();
  });
});
