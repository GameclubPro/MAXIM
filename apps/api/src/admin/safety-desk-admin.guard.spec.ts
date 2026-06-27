import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';

function createContext(host: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { host } }),
    }),
  } as unknown as ExecutionContext;
}

describe('SafetyDeskAdminGuard', () => {
  it('allows the closed admin host', () => {
    const guard = new SafetyDeskAdminGuard({
      get: jest.fn((key: string) =>
        key === 'SAFETY_DESK_ALLOWED_HOSTS' ? 'admin.major-maksimov.ru' : 'production',
      ),
    } as never);

    expect(guard.canActivate(createContext('admin.major-maksimov.ru'))).toBe(true);
  });

  it('rejects the public app host', () => {
    const guard = new SafetyDeskAdminGuard({
      get: jest.fn((key: string) =>
        key === 'SAFETY_DESK_ALLOWED_HOSTS' ? 'admin.major-maksimov.ru' : 'production',
      ),
    } as never);

    expect(() => guard.canActivate(createContext('major-maksimov.ru'))).toThrow(
      ForbiddenException,
    );
  });
});
