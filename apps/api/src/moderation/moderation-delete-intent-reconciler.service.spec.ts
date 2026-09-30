import { performance } from 'node:perf_hooks';
import { ModerationDeleteIntentReconcilerService } from './moderation-delete-intent-reconciler.service';

function setupReconciler() {
  const deleteIntents = {
    quarantineStaleReplacementSendFences: jest.fn().mockResolvedValue(3),
    recoverReplacementCleanupSources: jest.fn().mockResolvedValue(0),
    sweepDueIntents: jest.fn().mockResolvedValue(2),
    purgeRetainedIntents: jest.fn().mockResolvedValue(4),
  };
  let readSnapshot!: () => unknown;
  const reconciler = new ModerationDeleteIntentReconcilerService(
    deleteIntents as never,
    { get: jest.fn() } as never,
    {
      registerDeleteReconcilerSnapshot: (provider: () => unknown) => {
        readSnapshot = provider;
      },
    } as never,
  );
  const tick = () => (reconciler as unknown as { tick(): Promise<void> }).tick();
  return { deleteIntents, readSnapshot: () => readSnapshot(), tick };
}

describe('ModerationDeleteIntentReconcilerService', () => {
  afterEach(() => jest.restoreAllMocks());

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

  it('measures isolated failures while preserving sweeps and the existing cleanup cadence', async () => {
    const { deleteIntents, readSnapshot, tick } = setupReconciler();
    deleteIntents.recoverReplacementCleanupSources.mockRejectedValueOnce(
      new Error('private-fixture'),
    );
    deleteIntents.purgeRetainedIntents.mockRejectedValueOnce(new Error('private-fixture'));

    await tick();
    await tick();

    expect(deleteIntents.sweepDueIntents).toHaveBeenCalledTimes(2);
    expect(deleteIntents.purgeRetainedIntents).toHaveBeenCalledTimes(1);
    expect(readSnapshot()).toMatchObject({
      tickCalls: 2,
      skippedInFlight: 0,
      completedTicks: 2,
      phases: {
        staleSendFences: { calls: 2, succeeded: 2, errors: 0, returnedCount: 6 },
        replacementRecovery: { calls: 2, succeeded: 1, errors: 1, returnedCount: 0 },
        dueSweep: { calls: 2, succeeded: 2, errors: 0, returnedCount: 4 },
        retainedPurge: { calls: 1, succeeded: 0, errors: 1, returnedCount: 0 },
      },
    });
    expect(JSON.stringify(readSnapshot())).not.toContain('private-fixture');
    expect(JSON.stringify(readSnapshot())).not.toMatch(/scanned|pending|idle/);
  });

  it('counts overlapping ticks without starting concurrent reconciliation', async () => {
    const { deleteIntents, readSnapshot, tick } = setupReconciler();
    let complete!: (result: number) => void;
    deleteIntents.quarantineStaleReplacementSendFences.mockImplementationOnce(
      () => new Promise((resolve) => (complete = resolve)),
    );

    const first = tick();
    await tick();
    expect(deleteIntents.quarantineStaleReplacementSendFences).toHaveBeenCalledTimes(1);
    expect(deleteIntents.sweepDueIntents).not.toHaveBeenCalled();
    complete(3);
    await first;
    expect(readSnapshot()).toMatchObject({ tickCalls: 2, skippedInFlight: 1, completedTicks: 1 });
    expect(deleteIntents.sweepDueIntents).toHaveBeenCalledTimes(1);
  });

  it('measures phase duration with the monotonic clock, independently of wall clock changes', async () => {
    const { deleteIntents, readSnapshot, tick } = setupReconciler();
    const readings = [0, 99, 100, 200, 201, 701, 702, 2702];
    jest.spyOn(performance, 'now').mockImplementation(() => readings.shift()!);
    jest.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValueOnce(1_000);
    deleteIntents.recoverReplacementCleanupSources.mockRejectedValueOnce(
      new Error('phase failure'),
    );

    await tick();

    expect(readSnapshot()).toMatchObject({
      phases: {
        staleSendFences: { durationBuckets: { under100Ms: 1 } },
        replacementRecovery: { durationBuckets: { under500Ms: 1 } },
        dueSweep: { durationBuckets: { under2000Ms: 1 } },
        retainedPurge: { durationBuckets: { atLeast2000Ms: 1 } },
      },
    });
  });
});
