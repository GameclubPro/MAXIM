import { PublisherPublicationDispatchRunnerService } from './publisher-publication-dispatch-runner.service';

describe('PublisherPublicationDispatchRunnerService', () => {
  const originalRole = process.env.APP_ROLE;

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
      );

      runner.onModuleInit();
      await jest.advanceTimersByTimeAsync(15_000);

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(immediate).not.toHaveBeenCalled();
      expect(deadline).not.toHaveBeenCalled();

      globallyPaused = false;
      await jest.advanceTimersByTimeAsync(15_000);

      expect(dispatchHealth.isGloballyPaused).toHaveBeenCalledTimes(3);
      expect(identityAttestation.assertAttested).toHaveBeenCalledTimes(1);
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
    );

    await expect((runner as any).run('scheduled')).resolves.toBeUndefined();

    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(immediate).not.toHaveBeenCalled();
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
