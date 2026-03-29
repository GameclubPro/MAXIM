import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SystemController } from './system.controller';

function createConfigMock(values: Partial<Record<string, string>> = {}): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: string) => {
      if (key in values) {
        return values[key];
      }
      return fallback;
    }),
  } as unknown as ConfigService;
}

describe('SystemController', () => {
  it('rejects access in production when user is not in the system admin allowlist', async () => {
    const controller = new SystemController(
      { getSnapshot: jest.fn() } as never,
      { getEffectiveSnapshot: jest.fn() } as never,
      { getSnapshot: jest.fn() } as never,
      createConfigMock({
        NODE_ENV: 'production',
        SYSTEM_ADMIN_USER_IDS: '100,200',
      }),
    );

    await expect(controller.getMode({ userId: '300' } as never)).rejects.toThrow(ForbiddenException);
  });

  it('allows access in production when user is in the system admin allowlist', async () => {
    const getEffectiveSnapshot = jest.fn().mockResolvedValue({ mode: 'normal' });
    const controller = new SystemController(
      { getSnapshot: jest.fn() } as never,
      { getEffectiveSnapshot } as never,
      { getSnapshot: jest.fn() } as never,
      createConfigMock({
        NODE_ENV: 'production',
        SYSTEM_ADMIN_USER_IDS: '100,200',
      }),
    );

    await expect(controller.getMode({ userId: '200' } as never)).resolves.toEqual({
      mode: 'normal',
    });
    expect(getEffectiveSnapshot).toHaveBeenCalledTimes(1);
  });
});
