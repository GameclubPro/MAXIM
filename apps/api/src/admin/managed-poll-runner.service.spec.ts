import { ManagedPollRunnerService } from './managed-poll-runner.service';

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
    };
    const runner = new ManagedPollRunnerService(managedPollService as never);
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
});
