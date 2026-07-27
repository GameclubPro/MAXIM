import { VkParsingRunnerService } from './vk-parsing-runner.service';

describe('VkParsingRunnerService', () => {
  function createFixture() {
    const vkParsingService = {
      getSyncIntervalMs: jest.fn().mockReturnValue(600_000),
      syncDueSources: jest.fn().mockResolvedValue(0),
      recoverStalePublishJobs: jest.fn().mockResolvedValue(0),
    };
    const runner = new VkParsingRunnerService(vkParsingService as never);
    const run = (reason: 'startup' | 'scheduled' = 'scheduled') =>
      (
        runner as unknown as {
          run: (runReason: 'startup' | 'scheduled') => Promise<void>;
        }
      ).run(reason);

    return { runner, run, vkParsingService };
  }

  it('recovers publish jobs even when source scheduling fails', async () => {
    const { run, vkParsingService } = createFixture();
    vkParsingService.syncDueSources.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(run()).resolves.toBeUndefined();

    expect(vkParsingService.recoverStalePublishJobs).toHaveBeenCalledTimes(1);
  });

  it('releases the runner after a failed publish recovery', async () => {
    const { run, vkParsingService } = createFixture();
    vkParsingService.recoverStalePublishJobs.mockRejectedValueOnce(new Error('database timeout'));

    await expect(run()).resolves.toBeUndefined();
    await expect(run()).resolves.toBeUndefined();

    expect(vkParsingService.syncDueSources).toHaveBeenCalledTimes(2);
    expect(vkParsingService.recoverStalePublishJobs).toHaveBeenCalledTimes(2);
  });
});
