import { PublisherPublicationDispatchRunnerService } from './publisher-publication-dispatch-runner.service';

describe('PublisherPublicationDispatchRunnerService', () => {
  const originalRole = process.env.APP_ROLE;
  const createBackgroundWork = () => ({
    runExclusive: jest.fn((_lane: string, operation: () => Promise<unknown>) => operation()),
  });

  afterEach(() => {
    process.env.APP_ROLE = originalRole;
  });

  it('drains only publication execution lanes in the publisher role', async () => {
    process.env.APP_ROLE = 'publisher';
    const verificationBudget = { remaining: 3 };
    const immediate = jest.fn().mockResolvedValue(verificationBudget);
    const deadline = jest.fn().mockResolvedValue(verificationBudget);
    const service = {
      processDueImmediatePublicationBroadcasts: immediate,
      processDueDeadlinePublicationBroadcasts: deadline,
      processDueManagedBroadcasts: jest.fn(),
    };
    const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const dispatchHealth = { isGloballyPaused: jest.fn().mockResolvedValue(false) };
    const runner = new PublisherPublicationDispatchRunnerService(
      service as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
      dispatchHealth as never,
      createBackgroundWork() as never,
    );

    await (runner as any).run('scheduled');

    expect(immediate).toHaveBeenCalledTimes(1);
    expect(deadline).toHaveBeenCalledWith(undefined, verificationBudget);
    expect(service.processDueManagedBroadcasts).not.toHaveBeenCalled();
  });

  it('does not run publication dispatch from an action process', async () => {
    process.env.APP_ROLE = 'action';
    const immediate = jest.fn();
    const runner = new PublisherPublicationDispatchRunnerService(
      { processDueImmediatePublicationBroadcasts: immediate } as never,
      { assertAttested: jest.fn() } as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      createBackgroundWork() as never,
    );

    await (runner as any).run('scheduled');

    expect(immediate).not.toHaveBeenCalled();
  });

  it('does not claim publication envelopes before identity attestation', async () => {
    process.env.APP_ROLE = 'publisher';
    const immediate = jest.fn();
    const identityAttestation = {
      assertAttested: jest.fn().mockRejectedValue(new Error('not attested')),
    };
    const runner = new PublisherPublicationDispatchRunnerService(
      { processDueImmediatePublicationBroadcasts: immediate } as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      createBackgroundWork() as never,
    );

    await (runner as any).run('scheduled');

    expect(immediate).not.toHaveBeenCalled();
  });

  it('keeps the timer idle before identity or publication scans while globally paused', async () => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'publisher';
    try {
      const immediate = jest.fn();
      const deadline = jest.fn();
      const identityAttestation = { assertAttested: jest.fn() };
      let globallyPaused = true;
      const dispatchHealth = {
        isGloballyPaused: jest.fn(async () => globallyPaused),
      };
      const runner = new PublisherPublicationDispatchRunnerService(
        {
          processDueImmediatePublicationBroadcasts: immediate,
          processDueDeadlinePublicationBroadcasts: deadline,
        } as never,
        identityAttestation as never,
        { dispatchEnabled: true } as never,
        dispatchHealth as never,
        createBackgroundWork() as never,
      );

      runner.onModuleInit();
      await jest.advanceTimersByTimeAsync(15_000);

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(immediate).not.toHaveBeenCalled();
      expect(deadline).not.toHaveBeenCalled();

      globallyPaused = false;
      await jest.advanceTimersByTimeAsync(15_000);

      expect(dispatchHealth.isGloballyPaused).toHaveBeenCalledTimes(4);
      expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(2);
      expect(immediate).toHaveBeenCalledTimes(1);
      expect(deadline).toHaveBeenCalledTimes(1);
      runner.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails a sweep closed when the pause lookup fails', async () => {
    process.env.APP_ROLE = 'publisher';
    const immediate = jest.fn();
    const identityAttestation = { assertAttested: jest.fn() };
    const runner = new PublisherPublicationDispatchRunnerService(
      { processDueImmediatePublicationBroadcasts: immediate } as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockRejectedValue(new Error('redis unavailable')) } as never,
      createBackgroundWork() as never,
    );

    await expect((runner as any).run('scheduled')).resolves.toBeUndefined();

    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(immediate).not.toHaveBeenCalled();
  });

  it('keeps urgent publication ticks moving while a deadline sweep owns the coordinator', async () => {
    process.env.APP_ROLE = 'publisher';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const immediate = jest.fn().mockResolvedValue({ remaining: 1 });
    const deadline = jest.fn().mockResolvedValue({ remaining: 1 });
    const backgroundWork = {
      runExclusive: jest.fn(async (_lane: string, operation: () => Promise<void>) => {
        await gate;
        await operation();
      }),
    };
    const runner = new PublisherPublicationDispatchRunnerService(
      {
        processDueImmediatePublicationBroadcasts: immediate,
        processDueDeadlinePublicationBroadcasts: deadline,
      } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { dispatchEnabled: true } as never,
      { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
      backgroundWork as never,
    );

    const first = (runner as any).run('scheduled') as Promise<void>;
    while (backgroundWork.runExclusive.mock.calls.length === 0) await Promise.resolve();
    const second = (runner as any).run('scheduled') as Promise<void>;
    while (immediate.mock.calls.length < 2) await Promise.resolve();

    expect(backgroundWork.runExclusive).toHaveBeenCalledTimes(1);
    expect(immediate).toHaveBeenCalledTimes(2);
    expect(deadline).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);

    expect(immediate).toHaveBeenCalledTimes(2);
    expect(deadline).toHaveBeenCalledTimes(1);
  });

  it('does not start or run publication scans while dispatch is disabled', async () => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'publisher';
    try {
      const immediate = jest.fn();
      const identityAttestation = { assertAttested: jest.fn() };
      const dispatchHealth = { isGloballyPaused: jest.fn() };
      const runner = new PublisherPublicationDispatchRunnerService(
        { processDueImmediatePublicationBroadcasts: immediate } as never,
        identityAttestation as never,
        { dispatchEnabled: false } as never,
        dispatchHealth as never,
        createBackgroundWork() as never,
      );

      runner.onModuleInit();
      await jest.advanceTimersByTimeAsync(30_000);
      await (runner as any).run('scheduled');

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(dispatchHealth.isGloballyPaused).not.toHaveBeenCalled();
      expect(immediate).not.toHaveBeenCalled();
      runner.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
