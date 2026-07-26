import { ManagedAutopostRunnerService } from './managed-autopost-runner.service';

describe('ManagedAutopostRunnerService legacy freeze', () => {
  const originalAppRole = process.env.APP_ROLE;

  afterEach(() => {
    jest.useRealTimers();
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
  });

  it('pauses remaining legacy rules once without starting the former materializer', async () => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'action';
    const managedAutopostService = {
      processDueAutopostRules: jest.fn().mockResolvedValue(undefined),
      pauseRetiredLegacyRules: jest.fn().mockResolvedValue(3),
    };
    const runner = new ManagedAutopostRunnerService(managedAutopostService as never);

    await runner.onModuleInit();
    jest.advanceTimersByTime(5 * 60_000);
    runner.onModuleDestroy();

    expect(managedAutopostService.pauseRetiredLegacyRules).toHaveBeenCalledTimes(1);
    expect(managedAutopostService.processDueAutopostRules).not.toHaveBeenCalled();
  });

  it('leaves the retirement transition to the action role', async () => {
    process.env.APP_ROLE = 'admin';
    const managedAutopostService = {
      processDueAutopostRules: jest.fn().mockResolvedValue(undefined),
      pauseRetiredLegacyRules: jest.fn().mockResolvedValue(0),
    };
    const runner = new ManagedAutopostRunnerService(managedAutopostService as never);

    await runner.onModuleInit();

    expect(managedAutopostService.pauseRetiredLegacyRules).not.toHaveBeenCalled();
    expect(managedAutopostService.processDueAutopostRules).not.toHaveBeenCalled();
  });
});
