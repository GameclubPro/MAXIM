import { BadRequestException } from '@nestjs/common';
import { AdminBroadcastController } from './admin-broadcast.controller';
import { AdminDialogController } from './admin-dialog.controller';
import { AdminManualModerationController } from './admin-manual-moderation.controller';
import { AdminManagedEntitiesController } from './admin-managed-entities.controller';
import { AdminSettingsController } from './admin-settings.controller';

describe('admin domain controllers', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  it('removes allowlist rule via query parameter', async () => {
    const manualModerationService = {
      removeDomain: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);

    await controller.removeDomainByQuery('chat-1', 'https://max.ru/news?x=1', user as never);

    expect(manualModerationService.removeDomain).toHaveBeenCalledWith(
      'chat-1',
      user,
      'https://max.ru/news?x=1',
    );
  });

  it('prefers query parameter over path parameter for allowlist removal', async () => {
    const manualModerationService = {
      removeDomain: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);

    await controller.removeDomain(
      'chat-1',
      'stale-path-value',
      'domain:docs.max.ru',
      user as never,
    );

    expect(manualModerationService.removeDomain).toHaveBeenCalledWith(
      'chat-1',
      user,
      'domain:docs.max.ru',
    );
  });

  it('schedules allowlist removal via query parameter', async () => {
    const manualModerationService = {
      scheduleDomainRemoval: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);
    const body = { removeAfterAt: '2026-03-25T10:30:00.000Z' };

    await controller.scheduleDomainRemovalByQuery(
      'chat-1',
      'https://max.ru/news?x=1',
      user as never,
      body,
    );

    expect(manualModerationService.scheduleDomainRemoval).toHaveBeenCalledWith(
      'chat-1',
      user,
      'https://max.ru/news?x=1',
      body,
    );
  });

  it('rejects allowlist removal without query or path value', async () => {
    const controller = new AdminManualModerationController({} as never);

    expect(() => controller.removeDomainByQuery('chat-1', undefined, user as never)).toThrow(
      BadRequestException,
    );
  });

  it('routes broadcast endpoints through the managed broadcast domain service', async () => {
    const managedBroadcastService = {
      sendBroadcast: jest.fn().mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
    };
    const controller = new AdminBroadcastController(managedBroadcastService as never);
    const body = { text: 'Команда, новости на связи' };

    await controller.sendBroadcast('chat-1', user as never, body);

    expect(managedBroadcastService.sendBroadcast).toHaveBeenCalledWith('chat-1', user, body);
  });

  it('routes managed entity reads through the managed entities domain service', async () => {
    const managedEntitiesService = {
      listChats: jest.fn().mockResolvedValue([]),
    };
    const controller = new AdminManagedEntitiesController(managedEntitiesService as never);

    await controller.getChats(
      user as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(managedEntitiesService.listChats).toHaveBeenCalled();
  });

  it('routes settings reads through the settings domain service', async () => {
    const adminSettingsService = {
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const controller = new AdminSettingsController(adminSettingsService as never);

    await controller.getSettings('chat-1', user as never);

    expect(adminSettingsService.getSettings).toHaveBeenCalledWith('chat-1', user);
  });

  it('routes moderation allowlist writes through the manual moderation domain service', async () => {
    const manualModerationService = {
      removeDomain: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);

    await controller.removeDomainByQuery('chat-1', 'domain:docs.max.ru', user as never);

    expect(manualModerationService.removeDomain).toHaveBeenCalledWith(
      'chat-1',
      user,
      'domain:docs.max.ru',
    );
  });

  it('routes dialog messages through the channel dialog domain service', async () => {
    const channelDialogService = {
      createChatDialogMessage: jest.fn().mockResolvedValue({ id: 'message-1' }),
    };
    const controller = new AdminDialogController(channelDialogService as never);
    const body = { text: 'Есть вопрос' };

    await controller.createChatDialogMessage('chat-1', 'comments', user as never, body);

    expect(channelDialogService.createChatDialogMessage).toHaveBeenCalledWith(
      'chat-1',
      user,
      'comments',
      body,
    );
  });
});
