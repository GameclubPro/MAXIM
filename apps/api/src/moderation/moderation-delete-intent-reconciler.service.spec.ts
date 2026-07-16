import { ModerationDeleteIntentReconcilerService } from './moderation-delete-intent-reconciler.service';

describe('ModerationDeleteIntentReconcilerService', () => {
  it('continues the due-intent sweep when replacement recovery fails', async () => {
    const deleteIntents = {
      quarantineStaleReplacementSendFences: jest.fn().mockResolvedValue(0),
      recoverReplacementCleanupSources: jest
        .fn()
        .mockRejectedValue(new Error('replacement query failed')),
      sweepDueIntents: jest.fn().mockResolvedValue(2),
      purgeRetainedIntents: jest.fn().mockRejectedValue(new Error('retention query failed')),
    };
    const reconciler = new ModerationDeleteIntentReconcilerService(
      deleteIntents as never,
      {
        get: jest.fn(),
      } as never,
    );

    await (
      reconciler as unknown as {
        tick(): Promise<void>;
      }
    ).tick();

    expect(deleteIntents.quarantineStaleReplacementSendFences).toHaveBeenCalledTimes(1);
    expect(deleteIntents.recoverReplacementCleanupSources).toHaveBeenCalledTimes(1);
    expect(deleteIntents.sweepDueIntents).toHaveBeenCalledTimes(1);
    expect(deleteIntents.purgeRetainedIntents).toHaveBeenCalledTimes(1);
  });
});
