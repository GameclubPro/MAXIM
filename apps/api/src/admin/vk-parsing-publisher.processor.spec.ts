import { DelayedError } from 'bullmq';
import { PublisherDispatchPausedError } from '../publisher/publisher-dispatch-health.service';
import { PUBLISHER_DISPATCH_PAUSE_DEFER_MS } from '../publisher/publisher-dispatch-job-guard';
import { PublisherIdentityAttestationError } from '../publisher/publisher-identity-attestation.service';
import { PUBLISHER_IDENTITY_ATTESTATION_DEFER_MS } from '../publisher/publisher-identity-attestation-job-guard';
import { PublisherDispatchDisabledError } from '../publisher/publisher-runtime-boundary.service';
import { VkParsingPublisherProcessor } from './vk-parsing-publisher.processor';

describe('VkParsingPublisherProcessor', () => {
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
  const createOwnership = () => ({
    getPublisherScope: () => ({ ownerProfile: 'PUBLISHER', ownerBotId: 'publisher-bot' }),
  });
  const createGuardedPublishService = () => ({
    processPublishPostJob: jest.fn(async (_params: unknown, beforeDispatch?: () => Promise<void>) =>
      beforeDispatch?.(),
    ),
  });

  it('fails closed when the publisher queue is instantiated outside api-publisher', async () => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
    const service = { processPublishPostJob: jest.fn() };
    const identityAttestation = { assertAttested: jest.fn() };
    const processor = new VkParsingPublisherProcessor(
      service as never,
      identityAttestation as never,
      createDispatchHealth() as never,
      createRuntimeBoundary() as never,
      createOwnership() as never,
    );

    await expect(
      processor.process({
        data: {
          kind: 'publish',
          postId: 'post-1',
          chatId: 'channel-1',
          requiredBotId: 'publisher-bot',
          dispatchProfile: 'PUBLIK_V1',
          reason: 'manual-retry',
          idempotencyKey: 'intent-1',
        },
        attemptsMade: 0,
        opts: { attempts: 5 },
      } as never),
    ).rejects.toThrow('only be consumed by api-publisher');
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(service.processPublishPostJob).not.toHaveBeenCalled();
  });

  it('rejects a publisher job whose exact route payload is incomplete', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const service = { processPublishPostJob: jest.fn() };
    const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const dispatchHealth = createDispatchHealth();
    const runtimeBoundary = createRuntimeBoundary();
    const processor = new VkParsingPublisherProcessor(
      service as never,
      identityAttestation as never,
      dispatchHealth as never,
      runtimeBoundary as never,
      createOwnership() as never,
    );

    await expect(
      processor.process({
        data: {
          kind: 'publish',
          postId: 'post-1',
          chatId: 'channel-1',
          requiredBotId: 'publisher-bot',
          idempotencyKey: 'intent-1',
        },
        attemptsMade: 0,
        opts: { attempts: 5 },
      } as never),
    ).rejects.toThrow('invalid route payload');
    expect(runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(service.processPublishPostJob).not.toHaveBeenCalled();
  });

  it('retires a stale publisher job for another bot before any delay guard', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const service = {
      processPublishPostJob: jest.fn(),
      processPublisherRollbackJob: jest.fn(),
    };
    const identityAttestation = { assertAttested: jest.fn() };
    const dispatchHealth = createDispatchHealth();
    const runtimeBoundary = createRuntimeBoundary(false);
    const processor = new VkParsingPublisherProcessor(
      service as never,
      identityAttestation as never,
      dispatchHealth as never,
      runtimeBoundary as never,
      createOwnership() as never,
    );
    const moveToDelayed = jest.fn();

    await expect(
      processor.process(
        {
          data: {
            kind: 'publish',
            postId: 'post-1',
            chatId: 'channel-1',
            requiredBotId: 'old-publisher-bot',
            dispatchProfile: 'PUBLIK_V1',
            reason: 'manual-retry',
            idempotencyKey: 'intent-1',
          },
          attemptsMade: 0,
          opts: { attempts: 5 },
          moveToDelayed,
        } as never,
        'worker-token',
      ),
    ).resolves.toBeUndefined();

    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(service.processPublishPostJob).not.toHaveBeenCalled();
    expect(service.processPublisherRollbackJob).not.toHaveBeenCalled();
  });

  it('rejects a malformed rollback before any delay guard', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const service = { processPublisherRollbackJob: jest.fn() };
    const identityAttestation = { assertAttested: jest.fn() };
    const dispatchHealth = createDispatchHealth();
    const runtimeBoundary = createRuntimeBoundary(false);
    const processor = new VkParsingPublisherProcessor(
      service as never,
      identityAttestation as never,
      dispatchHealth as never,
      runtimeBoundary as never,
      createOwnership() as never,
    );
    const moveToDelayed = jest.fn();

    await expect(
      processor.process(
        {
          data: {
            kind: 'rollback-delete',
            postId: 'post-1',
            chatId: 'channel-1',
            requiredBotId: 'publisher-bot',
            idempotencyKey: 'rollback-1',
          },
          attemptsMade: 0,
          opts: { attempts: 5 },
          moveToDelayed,
        } as never,
        'worker-token',
      ),
    ).rejects.toThrow('missing messageId');

    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(service.processPublisherRollbackJob).not.toHaveBeenCalled();
  });

  it('delays an exact Publisher rollback while dispatch is disabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const service = { processPublisherRollbackJob: jest.fn() };
    const identityAttestation = { assertAttested: jest.fn() };
    const dispatchHealth = createDispatchHealth();
    const runtimeBoundary = createRuntimeBoundary(false);
    const processor = new VkParsingPublisherProcessor(
      service as never,
      identityAttestation as never,
      dispatchHealth as never,
      runtimeBoundary as never,
      createOwnership() as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        kind: 'rollback-delete',
        postId: 'post-1',
        chatId: 'channel-1',
        messageId: 'message-1',
        requiredBotId: 'publisher-bot',
        idempotencyKey: 'rollback-1',
      },
      attemptsMade: 4,
      opts: { attempts: 5 },
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-08-26T12:00:00.000Z') + PUBLISHER_DISPATCH_PAUSE_DEFER_MS,
      'worker-token',
    );
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(service.processPublisherRollbackJob).not.toHaveBeenCalled();
  });

  it('delays VK intent processing while identity is unattested', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const service = createGuardedPublishService();
    const identityAttestation = {
      assertAttested: jest
        .fn()
        .mockRejectedValue(new PublisherIdentityAttestationError('transient_failure')),
    };
    const processor = new VkParsingPublisherProcessor(
      service as never,
      identityAttestation as never,
      createDispatchHealth() as never,
      createRuntimeBoundary() as never,
      createOwnership() as never,
    );

    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        kind: 'publish',
        postId: 'post-1',
        chatId: 'channel-1',
        requiredBotId: 'publisher-bot',
        dispatchProfile: 'PUBLIK_V1',
        reason: 'manual-retry',
        idempotencyKey: 'intent-1',
      },
      attemptsMade: 4,
      opts: { attempts: 5 },
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
    expect(job.attemptsMade).toBe(4);
    expect(service.processPublishPostJob).toHaveBeenCalledTimes(1);
  });

  it('keeps generic attestation errors on the ordinary retry path', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const failure = new Error('redis unavailable');
    const service = createGuardedPublishService();
    const processor = new VkParsingPublisherProcessor(
      service as never,
      { assertAttested: jest.fn().mockRejectedValue(failure) } as never,
      createDispatchHealth() as never,
      createRuntimeBoundary() as never,
      createOwnership() as never,
    );
    const moveToDelayed = jest.fn();
    const job = {
      data: {
        kind: 'publish',
        postId: 'post-1',
        chatId: 'channel-1',
        requiredBotId: 'publisher-bot',
        dispatchProfile: 'PUBLIK_V1',
        reason: 'manual-retry',
        idempotencyKey: 'intent-1',
      },
      attemptsMade: 0,
      opts: { attempts: 5 },
      token: 'job-token',
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBe(failure);
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect(service.processPublishPostJob).toHaveBeenCalledTimes(1);
  });

  it('moves a same-key policy deferral on the active Bull job', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const deferUntil = new Date('2026-09-04T13:30:00.000Z');
    const service = {
      processPublishPostJob: jest.fn().mockResolvedValue({ deferUntil }),
    };
    const processor = new VkParsingPublisherProcessor(
      service as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      createDispatchHealth() as never,
      createRuntimeBoundary() as never,
      createOwnership() as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        kind: 'publish',
        postId: 'post-1',
        chatId: 'channel-1',
        requiredBotId: 'publisher-bot',
        dispatchProfile: 'PUBLIK_V1',
        reason: 'autopublish',
        idempotencyKey: 'attempted-intent-1',
      },
      attemptsMade: 3,
      opts: { attempts: 5 },
      token: 'job-token',
      moveToDelayed,
    };

    await expect(processor.process(job as never, 'worker-token')).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(moveToDelayed).toHaveBeenCalledWith(deferUntil.getTime(), 'worker-token');
    expect(job.attemptsMade).toBe(3);
  });

  it('delays a paused VK Publik job before domain recovery without consuming its attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const service = {
      ...createGuardedPublishService(),
      processPublisherRollbackJob: jest.fn(),
    };
    const dispatchHealth = {
      assertDispatchAllowed: jest.fn().mockRejectedValue(new PublisherDispatchPausedError(null)),
    };
    const processor = new VkParsingPublisherProcessor(
      service as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      dispatchHealth as never,
      createRuntimeBoundary() as never,
      createOwnership() as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        kind: 'publish',
        postId: 'post-1',
        chatId: 'channel-1',
        requiredBotId: 'publisher-bot',
        dispatchProfile: 'PUBLIK_V1',
        reason: 'manual-retry',
        idempotencyKey: 'intent-1',
      },
      attemptsMade: 4,
      opts: { attempts: 5 },
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
    expect(service.processPublishPostJob).toHaveBeenCalledTimes(1);
    expect(service.processPublisherRollbackJob).not.toHaveBeenCalled();
  });

  it('delays a disabled VK job before identity, health, or domain recovery without consuming its attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const service = {
      ...createGuardedPublishService(),
      processPublisherRollbackJob: jest.fn(),
    };
    const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const dispatchHealth = createDispatchHealth();
    const processor = new VkParsingPublisherProcessor(
      service as never,
      identityAttestation as never,
      dispatchHealth as never,
      createRuntimeBoundary(false) as never,
      createOwnership() as never,
    );
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        kind: 'publish',
        postId: 'post-1',
        chatId: 'channel-1',
        requiredBotId: 'publisher-bot',
        dispatchProfile: 'PUBLIK_V1',
        reason: 'manual-retry',
        idempotencyKey: 'intent-1',
      },
      attemptsMade: 4,
      opts: { attempts: 5 },
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
    expect(service.processPublishPostJob).toHaveBeenCalledTimes(1);
    expect(service.processPublisherRollbackJob).not.toHaveBeenCalled();
  });

  it('lets a confirmed receipt finalize without processor runtime, identity, or health guards', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const service = { processPublishPostJob: jest.fn().mockResolvedValue(undefined) };
    const identityAttestation = {
      assertAttested: jest.fn().mockRejectedValue(new Error('identity unavailable')),
    };
    const dispatchHealth = {
      assertDispatchAllowed: jest.fn().mockRejectedValue(new PublisherDispatchPausedError(null)),
    };
    const runtimeBoundary = createRuntimeBoundary(false);
    const processor = new VkParsingPublisherProcessor(
      service as never,
      identityAttestation as never,
      dispatchHealth as never,
      runtimeBoundary as never,
      createOwnership() as never,
    );
    const moveToDelayed = jest.fn();

    await expect(
      processor.process(
        {
          data: {
            kind: 'publish',
            postId: 'post-confirmed',
            chatId: 'channel-1',
            requiredBotId: 'publisher-bot',
            dispatchProfile: 'PUBLIK_V1',
            reason: 'autopublish',
            idempotencyKey: 'confirmed-receipt-key',
          },
          attemptsMade: 4,
          opts: { attempts: 5 },
          moveToDelayed,
        } as never,
        'worker-token',
      ),
    ).resolves.toBeUndefined();

    expect(service.processPublishPostJob).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: 'post-confirmed',
        idempotencyKey: 'confirmed-receipt-key',
        attemptsMade: 4,
        maxAttempts: 5,
      }),
      expect.any(Function),
    );
    expect(runtimeBoundary.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(identityAttestation.assertAttested).not.toHaveBeenCalled();
    expect(dispatchHealth.assertDispatchAllowed).not.toHaveBeenCalled();
    expect(moveToDelayed).not.toHaveBeenCalled();
  });
});
