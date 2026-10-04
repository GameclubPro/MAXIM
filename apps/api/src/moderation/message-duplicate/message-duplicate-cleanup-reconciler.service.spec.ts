import { Logger } from '@nestjs/common';
import { MessageDuplicateCleanupReconcilerService } from './message-duplicate-cleanup-reconciler.service';
import type { DuplicateCleanupSample } from './message-duplicate-claim-cleanup';

describe('bounded duplicate cleanup monitoring', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('reports lower-bound due samples and the transition to empty without idle logging', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let sample: DuplicateCleanupSample = {
      sampledDue: 25,
      sampleLimit: 25,
      sampleLimitReached: true,
      oldestDueAgeMs: 60_000,
      released: 24,
    };
    const service = new MessageDuplicateCleanupReconcilerService({
      reconcileExpiredMessageDuplicateActions: async (
        report: (value: DuplicateCleanupSample) => void,
      ) => {
        report(sample);
        return sample.released;
      },
    } as never);
    await service.reconcile();
    sample = {
      ...sample,
      sampledDue: 0,
      sampleLimitReached: false,
      oldestDueAgeMs: null,
      released: 0,
    };
    await service.reconcile();
    await service.reconcile();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toEqual({
      event: 'message_duplicate_cleanup_sample',
      schemaVersion: 1,
      sampledDue: 25,
      sampleLimit: 25,
      sampleLimitReached: true,
      oldestDueAgeMs: 60_000,
      released: 24,
    });
    expect(log.mock.calls[1]?.[0]).toMatchObject({ sampledDue: 0, oldestDueAgeMs: null });
  });

  it('never presents a failed due read as an empty sample and never overlaps a slow sweep', async () => {
    jest.useFakeTimers();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let fail!: (error: Error) => void;
    const reconcile = jest.fn(
      () =>
        new Promise<number>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const service = new MessageDuplicateCleanupReconcilerService({
      reconcileExpiredMessageDuplicateActions: reconcile,
    } as never);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    fail(new Error('private database details'));
    await jest.advanceTimersByTimeAsync(0);
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Duplicate unused claim reconciliation unavailable');
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
