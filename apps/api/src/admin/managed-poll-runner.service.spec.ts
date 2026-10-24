import { ManagedPollRunnerService } from './managed-poll-runner.service';
import type { ManagedPollService } from './managed-poll.service';

describe('ManagedPollRunnerService', () => {
  it('runs one background repair scan at a time', async () => {
    let finishScan: ((repaired: number) => void) | undefined;
    const managedPollService = {
      processPendingPollRenderRepairs: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<number>((resolve) => {
              finishScan = resolve;
            }),
        )
        .mockResolvedValue(0),
    } satisfies Pick<ManagedPollService, 'processPendingPollRenderRepairs'>;
    const runner = new ManagedPollRunnerService(managedPollService);
    (runner as any).backgroundEnabled = true;

    const startup = (runner as any).run('startup');
    await Promise.resolve();
    await (runner as any).run('scheduled');

    expect(managedPollService.processPendingPollRenderRepairs).toHaveBeenCalledTimes(1);

    finishScan?.(2);
    await startup;
    await (runner as any).run('scheduled');

    expect(managedPollService.processPendingPollRenderRepairs).toHaveBeenCalledTimes(2);
  });

  it('waits for its in-flight repair and denies more admission during shutdown', async () => {
    let finish!: (value: number) => void;
    let shouldContinue: (() => boolean) | undefined;
    const service = {
      processPendingPollRenderRepairs: jest.fn<
        ReturnType<ManagedPollService['processPendingPollRenderRepairs']>,
        Parameters<ManagedPollService['processPendingPollRenderRepairs']>
      >((options) => {
        shouldContinue = options?.shouldContinue;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }),
    } satisfies Pick<ManagedPollService, 'processPendingPollRenderRepairs'>;
    const runner = new ManagedPollRunnerService(service);
    const runtime = runner as unknown as {
      backgroundEnabled: boolean;
      run: (reason: 'scheduled') => Promise<void>;
    };
    runtime.backgroundEnabled = true;
    const active = runtime.run('scheduled');
    expect(shouldContinue?.()).toBe(true);
    let stopped = false;
    const shutdown = runner.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(shouldContinue?.()).toBe(false);
    await runtime.run('scheduled');
    expect(service.processPendingPollRenderRepairs).toHaveBeenCalledTimes(1);
    finish(0);
    await Promise.all([active, shutdown]);
    expect(stopped).toBe(true);
  });
});
