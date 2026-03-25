import { BadRequestException } from '@nestjs/common';
import { AdminController } from './admin.controller';

describe('AdminController allowlist routes', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  it('removes allowlist rule via query parameter', async () => {
    const adminService = {
      removeDomain: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminController(adminService as never, {} as never);

    await controller.removeDomainByQuery('chat-1', 'https://max.ru/news?x=1', user as never);

    expect(adminService.removeDomain).toHaveBeenCalledWith(
      'chat-1',
      user,
      'https://max.ru/news?x=1',
    );
  });

  it('prefers query parameter over path parameter for allowlist removal', async () => {
    const adminService = {
      removeDomain: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminController(adminService as never, {} as never);

    await controller.removeDomain(
      'chat-1',
      'stale-path-value',
      'domain:docs.max.ru',
      user as never,
    );

    expect(adminService.removeDomain).toHaveBeenCalledWith(
      'chat-1',
      user,
      'domain:docs.max.ru',
    );
  });

  it('schedules allowlist removal via query parameter', async () => {
    const adminService = {
      scheduleDomainRemoval: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminController(adminService as never, {} as never);
    const body = { removeAfterAt: '2026-03-25T10:30:00.000Z' };

    await controller.scheduleDomainRemovalByQuery(
      'chat-1',
      'https://max.ru/news?x=1',
      user as never,
      body,
    );

    expect(adminService.scheduleDomainRemoval).toHaveBeenCalledWith(
      'chat-1',
      user,
      'https://max.ru/news?x=1',
      body,
    );
  });

  it('rejects allowlist removal without query or path value', async () => {
    const controller = new AdminController({} as never, {} as never);

    expect(() => controller.removeDomainByQuery('chat-1', undefined, user as never)).toThrow(
      BadRequestException,
    );
  });
});
