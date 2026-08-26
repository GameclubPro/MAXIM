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
    const runner = new PublisherPublicationDispatchRunnerService(
      service as never,
      identityAttestation as never,
      { dispatchEnabled: true } as never,
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
    );

    await (runner as any).run('scheduled');

    expect(immediate).not.toHaveBeenCalled();
  });

  it('does not start or run publication scans while dispatch is disabled', async () => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'publisher';
    try {
      const immediate = jest.fn();
      const identityAttestation = { assertAttested: jest.fn() };
      const runner = new PublisherPublicationDispatchRunnerService(
        { processDueImmediatePublicationBroadcasts: immediate } as never,
        identityAttestation as never,
        { dispatchEnabled: false } as never,
      );

      runner.onModuleInit();
      await jest.advanceTimersByTimeAsync(30_000);
      await (runner as any).run('scheduled');

      expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
      expect(immediate).not.toHaveBeenCalled();
      runner.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
