import { PublicationRunnerService } from './publication-runner.service';

describe('Publication scheduler ownership', () => {
  const originalRole = process.env.APP_ROLE;
  afterEach(() => {
    process.env.APP_ROLE = originalRole;
    jest.useRealTimers();
  });

  function fixture(role = 'publisher', enabled = true) {
    process.env.APP_ROLE = role;
    const publications = { processDuePublications: jest.fn().mockResolvedValue(undefined) };
    const health = { isGloballyPaused: jest.fn().mockResolvedValue(false) };
    const dispatch = { notifyMaterializedWork: jest.fn() };
    const runner = new PublicationRunnerService(
      publications as never,
      { dispatchEnabled: enabled } as never,
      health as never,
      dispatch as never,
    );
    return { runner, publications, health, dispatch };
  }

  it.each([
    ['action', true],
    ['admin', true],
    ['publisher', false],
  ] as const)('does not scan in %s enabled=%s', async (role, enabled) => {
    jest.useFakeTimers();
    const f = fixture(role, enabled);
    f.runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    await f.runner.onModuleDestroy();
    expect(f.publications.processDuePublications).not.toHaveBeenCalled();
    expect(f.dispatch.notifyMaterializedWork).not.toHaveBeenCalled();
  });

  it('coalesces polls and drains owned work before shutdown without a late wake', async () => {
    jest.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    f.publications.processDuePublications.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    f.runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(45_000);
    expect(f.publications.processDuePublications).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = f.runner.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(f.dispatch.notifyMaterializedWork).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(f.publications.processDuePublications).toHaveBeenCalledTimes(1);
  });

  it('wakes the existing dispatcher after successful materialization', async () => {
    const f = fixture();
    await (f.runner as any).run('scheduled');
    expect(f.dispatch.notifyMaterializedWork).toHaveBeenCalledTimes(1);
    f.health.isGloballyPaused.mockResolvedValue(true);
    await (f.runner as any).run('scheduled');
    expect(f.publications.processDuePublications).toHaveBeenCalledTimes(1);
    await f.runner.onModuleDestroy();
  });
});
