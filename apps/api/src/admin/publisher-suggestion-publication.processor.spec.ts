import { DelayedError } from 'bullmq';
import {
  PublisherDispatchHealthUnavailableError,
  PublisherDispatchPausedError,
} from '../publisher/publisher-dispatch-health.service';
import { PUBLISHER_DISPATCH_PAUSE_DEFER_MS } from '../publisher/publisher-dispatch-job-guard';
import { PublisherIdentityAttestationError } from '../publisher/publisher-identity-attestation.service';
import { PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS } from '../publisher/publisher-identity-attestation-job-guard';
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
});
