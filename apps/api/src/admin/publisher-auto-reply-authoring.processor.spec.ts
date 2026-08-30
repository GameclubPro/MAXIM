import { PublisherAutoReplyAuthoringProcessor } from './publisher-auto-reply-authoring.processor';

describe('PublisherAutoReplyAuthoringProcessor', () => {
  const previousRole = process.env.APP_ROLE;
  const previousServiceName = process.env.APP_SERVICE_NAME;

  afterEach(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousServiceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousServiceName;
  });

  it('does not retry a terminal bot-capability activation outcome as internal_error', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const processing = {
      activate: jest.fn().mockResolvedValue('failed'),
      processContent: jest.fn(),
      failInternalAfterFinalAttempt: jest.fn(),
    };
    const delivery = { deliver: jest.fn() };
    const queue = { enqueueNotification: jest.fn().mockResolvedValue(undefined) };
    const identityAttestation = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const dispatchHealth = { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) };
    const runtimeBoundary = { assertDispatchEnabled: jest.fn() };
    const processor = new PublisherAutoReplyAuthoringProcessor(
      processing as never,
      delivery as never,
      queue as never,
      identityAttestation as never,
      dispatchHealth as never,
      runtimeBoundary as never,
    );

    await expect(
      processor.process({
        data: {
          version: 1,
          kind: 'activate',
          sessionId: 'session-1',
          callbackId: 'callback-1',
          requestedAt: '2026-08-30T10:00:00.000Z',
        },
        attemptsMade: 0,
        opts: { attempts: 4 },
      } as never),
    ).resolves.toBeUndefined();

    expect(processing.failInternalAfterFinalAttempt).not.toHaveBeenCalled();
    expect(queue.enqueueNotification).toHaveBeenCalledWith({
      sessionId: 'session-1',
      notification: 'failed',
      callbackId: 'callback-1',
      dedupeKey: 'failed-2026-08-30T10:00:00.000Z',
    });
  });
});
