import {
  PublisherBackgroundWorkCoordinatorClosedError,
  PublisherBackgroundWorkCoordinatorService,
} from './publisher-background-work-coordinator.service';

describe('PublisherBackgroundWorkCoordinatorService', () => {
  it('runs background work one at a time in FIFO order', async () => {
    const coordinator = new PublisherBackgroundWorkCoordinatorService();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.runExclusive('binding_bootstrap', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 1;
    });
    const second = coordinator.runExclusive('chat_comment_recovery', async () => {
      events.push('second');
      return 2;
    });
    const third = coordinator.runExclusive('suggestion_recovery', async () => {
      events.push('third');
      return 3;
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();

    await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
    expect(events).toEqual(['first:start', 'first:end', 'second', 'third']);
  });

  it('releases the next waiter after an operation throws', async () => {
    const coordinator = new PublisherBackgroundWorkCoordinatorService();
    const failure = new Error('scan failed');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = coordinator.runExclusive('binding_bootstrap', async () => {
      await firstGate;
      throw failure;
    });
    const secondOperation = jest.fn().mockResolvedValue('recovered');
    const second = coordinator.runExclusive('suggestion_recovery', secondOperation);

    await Promise.resolve();
    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst();

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe('recovered');
    expect(secondOperation).toHaveBeenCalledTimes(1);
  });

  it('coalesces duplicate lane requests into one bounded run', async () => {
    const coordinator = new PublisherBackgroundWorkCoordinatorService();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = jest.fn(async () => {
      await gate;
      return 'done';
    });
    const duplicate = jest.fn().mockResolvedValue('duplicate');

    const first = coordinator.runExclusive('chat_comment_recovery', operation);
    const second = coordinator.runExclusive('chat_comment_recovery', duplicate);

    expect(second).toBe(first);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done']);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(duplicate).not.toHaveBeenCalled();
  });

  it('rejects queued and future lanes during shutdown without starting them', async () => {
    const coordinator = new PublisherBackgroundWorkCoordinatorService();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = coordinator.runExclusive('binding_bootstrap', async () => {
      await gate;
    });
    const queuedOperation = jest.fn();
    const queued = coordinator.runExclusive('suggestion_recovery', queuedOperation);
    const queuedResult = expect(queued).rejects.toBeInstanceOf(
      PublisherBackgroundWorkCoordinatorClosedError,
    );

    coordinator.onModuleDestroy();
    await queuedResult;
    expect(queuedOperation).not.toHaveBeenCalled();

    release();
    await active;
    await expect(
      coordinator.runExclusive('publication_deadline', async () => undefined),
    ).rejects.toBeInstanceOf(PublisherBackgroundWorkCoordinatorClosedError);
  });
});
