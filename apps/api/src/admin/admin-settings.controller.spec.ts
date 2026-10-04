import { BadRequestException, HttpException } from '@nestjs/common';
import { AdminSettingsController } from './admin-settings.controller';

const user = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};
const settingsRevision = '2026-10-01T09:00:00.000Z';

describe('AdminSettingsController capability recheck query', () => {
  it('routes speech style updates to the narrow mutation', async () => {
    const body = { botSpeechStyle: 'IRONIC' };
    const saved = { ...body, settingsRevision };
    const settingsService = {
      updateBotSpeechStyle: jest.fn().mockResolvedValue(saved),
      updateSettings: jest.fn(),
    };
    const controller = new AdminSettingsController(settingsService as never);

    await expect(controller.updateBotSpeechStyle('chat-1', user, body)).resolves.toEqual(saved);
    expect(settingsService.updateBotSpeechStyle).toHaveBeenCalledWith('chat-1', user, body);
    expect(settingsService.updateSettings).not.toHaveBeenCalled();
  });

  it('separates cached diagnostics from an explicit permission recheck', async () => {
    const settingsService = { getDuplicateDiagnostics: jest.fn() };
    const controller = new AdminSettingsController(settingsService as never);
    await controller.getDuplicateDiagnostics('chat', user);
    expect(settingsService.getDuplicateDiagnostics).toHaveBeenLastCalledWith('chat', user);
    await controller.recheckDuplicateDiagnostics('chat', user);
    expect(settingsService.getDuplicateDiagnostics).toHaveBeenLastCalledWith('chat', user, true);
  });
  it('passes the exact recheck flag into a chat settings mutation', async () => {
    const settingsService = { updateSettings: jest.fn().mockResolvedValue({}) };
    const controller = new AdminSettingsController(settingsService as never);

    await controller.updateSettings(
      'chat-1',
      user,
      { nightModeEnabled: true, settingsRevision },
      '1',
    );

    expect(settingsService.updateSettings).toHaveBeenCalledWith(
      'chat-1',
      user,
      { nightModeEnabled: true, settingsRevision },
      'miniapp',
      { forceLiveBotCapabilityCheck: true },
    );
  });

  it.each(['true', '', '01', ' 1', '1 ', null, 1, true, ['1'], ['1', '1'], { value: '1' }])(
    'rejects an invalid recheck query before either settings mutation: %j',
    (value) => {
      const settingsService = { updateSettings: jest.fn(), patchSettingsSection: jest.fn() };
      const controller = new AdminSettingsController(settingsService as never);

      expect(() => controller.updateSettings('chat-1', user, { settingsRevision }, value)).toThrow(
        BadRequestException,
      );
      expect(() => controller.patchSettingsSection('chat-1', user, {}, value)).toThrow(
        BadRequestException,
      );
      expect(settingsService.updateSettings).not.toHaveBeenCalled();
      expect(settingsService.patchSettingsSection).not.toHaveBeenCalled();
    },
  );

  it('keeps the absent recheck query on the cached capability path', async () => {
    const settingsService = { updateSettings: jest.fn(), patchSettingsSection: jest.fn() };
    const controller = new AdminSettingsController(settingsService as never);
    await controller.updateSettings('chat-1', user, { settingsRevision });
    expect(settingsService.updateSettings).toHaveBeenLastCalledWith(
      'chat-1',
      user,
      { settingsRevision },
      'miniapp',
      { forceLiveBotCapabilityCheck: false },
    );
    await controller.patchSettingsSection('chat-1', user, {});
    expect(settingsService.patchSettingsSection).toHaveBeenLastCalledWith(
      'chat-1',
      user,
      {},
      { forceLiveBotCapabilityCheck: false },
    );
  });

  it('rejects a revisionless public PUT before invoking the mutation', () => {
    const settingsService = { updateSettings: jest.fn() };
    const controller = new AdminSettingsController(settingsService as never);
    try {
      controller.updateSettings('chat-1', user, { nightModeEnabled: true });
      throw new Error('Expected a revision precondition');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(428);
    }
    expect(settingsService.updateSettings).not.toHaveBeenCalled();
  });

  it('forwards section PATCH and an explicit permission recheck', async () => {
    const settingsService = { patchSettingsSection: jest.fn().mockResolvedValue({}) };
    const controller = new AdminSettingsController(settingsService as never);
    const body = {
      section: 'commercialFilter',
      expectedRevision: settingsRevision,
      changes: { commercialAdsFilterEnabled: true },
    };
    await controller.patchSettingsSection('chat-1', user, body, '1');
    expect(settingsService.patchSettingsSection).toHaveBeenCalledWith('chat-1', user, body, {
      forceLiveBotCapabilityCheck: true,
    });
  });
});
