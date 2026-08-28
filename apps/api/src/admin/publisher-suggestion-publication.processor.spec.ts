import { DelayedError } from 'bullmq';
import {
  PublisherDispatchHealthUnavailableError,
  PublisherDispatchPausedError,
} from '../publisher/publisher-dispatch-health.service';
import { PUBLISHER_DISPATCH_PAUSE_DEFER_MS } from '../publisher/publisher-dispatch-job-guard';
import { PublisherIdentityAttestationError } from '../publisher/publisher-identity-attestation.service';
import { PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS } from '../publisher/publisher-identity-attestation-job-guard';
import { PublisherDispatchDisabledError } from '../publisher/publisher-runtime-boundary.service';
import { PublisherSuggestionPublicationProcessor } from './publisher-suggestion-publication.processor';

describe('PublisherSuggestionPublicationProcessor', () => {
  const previousRole = process.env.APP_ROLE;
  const previousServiceName = process.env.APP_SERVICE_NAME;

  afterEach(() => {
    jest.useRealTimers();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousServiceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousServiceName;
  });

  const createDispatchHealth = () => ({
    assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
  });
  const createRuntimeBoundary = (dispatchEnabled = true) => ({
    dispatchEnabled,
    assertDispatchEnabled: jest.fn(() => {
      if (!dispatchEnabled) throw new PublisherDispatchDisabledError();
    }),
  });
  const createPublisherSuggestions = () => ({
    processPublicationJob: jest.fn().mockResolvedValue(false),
  });

  it('delays approved suggestion delivery while identity is unattested', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const processPublisherSuggestionPublicationJob = jest.fn();
    const channelDialogService = { processPublisherSuggestionPublicationJob };
    const identityAttestation = {
      assertAttested: jest
        .fn()
        .mockRejectedValue(new PublisherIdentityAttestationError('transient_failure')),
    };
    const processor = new PublisherSuggestionPublicationProcessor(
      channelDialogService as never,
      identityAttestation as never,
      createDispatchHealth() as never,
      createRuntimeBoundary() as never,
      createPublisherSuggestions() as never,
    );

    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        suggestionId: 'suggestion-1',
        claimToken: 'claim-1',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
      token: 'job-token',
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-26T12:00:00.000Z') + PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS,
      'worker-token',
    );
    expect(processPublisherSuggestionPublicationJob).not.toHaveBeenCalled();
  });

  it('keeps generic attestation errors on the ordinary retry path', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const failure = new Error('redis unavailable');
    const processPublisherSuggestionPublicationJob = jest.fn();
    const processor = new PublisherSuggestionPublicationProcessor(
      { processPublisherSuggestionPublicationJob } as never,
      { assertAttested: jest.fn().mockRejectedValue(failure) } as never,
      createDispatchHealth() as never,
      createRuntimeBoundary() as never,
      createPublisherSuggestions() as never,
    );
    const moveToDelayed = jest.fn();
    const job = {
      data: {
        suggestionId: 'suggestion-1',
        claimToken: 'claim-1',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
      token: 'job-token',
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBe(failure);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(processPublisherSuggestionPublicationJob).not.toHaveBeenCalled();
  });

  it('delays a paused suggestion without consuming its attempt or reading domain state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const processPublisherSuggestionPublicationJob = jest.fn();
    const dispatchHealth = {
      assertDispatchAllowed: jest.fn().mockRejectedValue(new PublisherDispatchPausedError(null)),
    };
    const processor = new PublisherSuggestionPublicationProcessor(
      { processPublisherSuggestionPublicationJob } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      dispatchHealth as never,
      createRuntimeBoundary() as never,
      createPublisherSuggestions() as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        suggestionId: 'suggestion-1',
        claimToken: 'claim-1',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
      attemptsMade: 4,
      token: 'job-token',
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-26T12:00:00.000Z') + PUBLISHER_DISPATCH_PAUSE_DEFER_MS,
      'worker-token',
    );
    expect(job.attemptsMade).toBe(4);
    expect(processPublisherSuggestionPublicationJob).not.toHaveBeenCalled();
  });

  it('delays unavailable dispatch health without consuming its attempt or reading domain state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const processPublisherSuggestionPublicationJob = jest.fn();
    const dispatchHealth = {
      assertDispatchAllowed: jest
        .fn()
        .mockRejectedValue(new PublisherDispatchHealthUnavailableError(new Error('redis down'))),
    };
    const processor = new PublisherSuggestionPublicationProcessor(
      { processPublisherSuggestionPublicationJob } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      dispatchHealth as never,
      createRuntimeBoundary() as never,
      createPublisherSuggestions() as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        suggestionId: 'suggestion-1',
        claimToken: 'claim-1',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
      attemptsMade: 4,
      token: 'job-token',
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-26T12:00:00.000Z') + PUBLISHER_DISPATCH_PAUSE_DEFER_MS,
      'worker-token',
    );
    expect(job.attemptsMade).toBe(4);
    expect(processPublisherSuggestionPublicationJob).not.toHaveBeenCalled();
  });

  it('keeps generic dispatch guard errors on the ordinary failure path', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const failure = new Error('programmer failure');
    const processPublisherSuggestionPublicationJob = jest.fn();
    const processor = new PublisherSuggestionPublicationProcessor(
      { processPublisherSuggestionPublicationJob } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { assertDispatchAllowed: jest.fn().mockRejectedValue(failure) } as never,
      createRuntimeBoundary() as never,
      createPublisherSuggestions() as never,
    );
    const moveToDelayed = jest.fn();
    const job = {
      data: {
        suggestionId: 'suggestion-1',
        claimToken: 'claim-1',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
      attemptsMade: 4,
      token: 'job-token',
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBe(failure);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(job.attemptsMade).toBe(4);
    expect(processPublisherSuggestionPublicationJob).not.toHaveBeenCalled();
  });

  it('delays a disabled suggestion before identity, health, or domain state without consuming its attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const processPublisherSuggestionPublicationJob = jest.fn();
    const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const dispatchHealth = createDispatchHealth();
    const processor = new PublisherSuggestionPublicationProcessor(
      { processPublisherSuggestionPublicationJob } as never,
      identityAttestation as never,
      dispatchHealth as never,
      createRuntimeBoundary(false) as never,
      createPublisherSuggestions() as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        suggestionId: 'suggestion-1',
        claimToken: 'claim-1',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
      attemptsMade: 4,
      token: 'job-token',
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-26T12:00:00.000Z') + PUBLISHER_DISPATCH_PAUSE_DEFER_MS,
      'worker-token',
    );
    expect(job.attemptsMade).toBe(4);
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(processPublisherSuggestionPublicationJob).not.toHaveBeenCalled();
  });

  it('keeps generic runtime-boundary errors on the ordinary failure path', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const failure = new Error('runtime boundary failure');
    const identityAttestation = { assertAttested: jest.fn() };
    const dispatchHealth = createDispatchHealth();
    const processPublisherSuggestionPublicationJob = jest.fn();
    const processor = new PublisherSuggestionPublicationProcessor(
      { processPublisherSuggestionPublicationJob } as never,
      identityAttestation as never,
      dispatchHealth as never,
      {
        dispatchEnabled: true,
        assertDispatchEnabled: jest.fn(() => {
          throw failure;
        }),
      } as never,
      createPublisherSuggestions() as never,
    );
    const moveToDelayed = jest.fn();
    const job = {
      data: {
        suggestionId: 'suggestion-1',
        claimToken: 'claim-1',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
      attemptsMade: 4,
      token: 'job-token',
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBe(failure);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(job.attemptsMade).toBe(4);
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(processPublisherSuggestionPublicationJob).not.toHaveBeenCalled();
  });

  it('routes Publisher inbox claims through the publication service worker', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const processPublisherSuggestionPublicationJob = jest.fn();
    const processPublicationJob = jest.fn().mockResolvedValue(true);
    const processor = new PublisherSuggestionPublicationProcessor(
      { processPublisherSuggestionPublicationJob } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      createDispatchHealth() as never,
      createRuntimeBoundary() as never,
      { processPublicationJob } as never,
    );

    await processor.process({
      data: {
        suggestionId: 'publisher-suggestion-1',
        claimToken: 'claim-1',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
    } as never);

    expect(processPublicationJob).toHaveBeenCalledWith('publisher-suggestion-1', 'claim-1');
    expect(processPublisherSuggestionPublicationJob).not.toHaveBeenCalled();
  });

  it('keeps legacy Publisher claims on the existing channel-dialog worker', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const processPublisherSuggestionPublicationJob = jest.fn().mockResolvedValue(undefined);
    const processPublicationJob = jest.fn().mockResolvedValue(false);
    const processor = new PublisherSuggestionPublicationProcessor(
      { processPublisherSuggestionPublicationJob } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      createDispatchHealth() as never,
      createRuntimeBoundary() as never,
      { processPublicationJob } as never,
    );

    await processor.process({
      data: {
        suggestionId: 'legacy-suggestion-1',
        claimToken: 'legacy-claim-1',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
    } as never);

    expect(processPublicationJob).toHaveBeenCalledWith('legacy-suggestion-1', 'legacy-claim-1');
    expect(processPublisherSuggestionPublicationJob).toHaveBeenCalledWith(
      'legacy-suggestion-1',
      'legacy-claim-1',
    );
  });
});
