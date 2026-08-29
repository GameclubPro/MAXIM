import type { Job } from 'bullmq';
import { PublisherAutoReplyProcessor } from './publisher-auto-reply.processor';
import type { PublisherAutoReplyJob } from './publisher-auto-reply.queue';

const data: PublisherAutoReplyJob = {
  version: 1,
  kind: 'deliver',
  retryPolicyName: 'publisher-auto-reply',
  deliveryId: 'delivery-1',
};

describe('PublisherAutoReplyProcessor', () => {
  const originalRole = process.env.APP_ROLE;
  const originalServiceName = process.env.APP_SERVICE_NAME;

  afterEach(() => {
    process.env.APP_ROLE = originalRole;
    process.env.APP_SERVICE_NAME = originalServiceName;
  });

  it('refuses to process the dedicated queue outside api-publisher', async () => {
    process.env.APP_ROLE = 'admin';
    process.env.APP_SERVICE_NAME = 'api-admin';
    const delivery = { process: jest.fn() };
    const processor = new PublisherAutoReplyProcessor(
      delivery as never,
      { assertAttested: jest.fn() } as never,
      { assertDispatchAllowed: jest.fn() } as never,
      { assertDispatchEnabled: jest.fn() } as never,
    );

    await expect(processor.process({ data } as Job<PublisherAutoReplyJob>)).rejects.toThrow(
      'outside api-publisher',
    );
    expect(delivery.process).not.toHaveBeenCalled();
  });

  it('runs identity, runtime and dispatch guards before delivery', async () => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    const delivery = { process: jest.fn().mockResolvedValue(undefined) };
    const identity = { assertAttested: jest.fn().mockResolvedValue(undefined) };
    const health = { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) };
    const runtime = { assertDispatchEnabled: jest.fn() };
    const processor = new PublisherAutoReplyProcessor(
      delivery as never,
      identity as never,
      health as never,
      runtime as never,
    );
    const job = {
      data,
      opts: { attempts: 7 },
      attemptsMade: 2,
    } as Job<PublisherAutoReplyJob>;

    await processor.process(job);

    expect(runtime.assertDispatchEnabled).toHaveBeenCalledTimes(1);
    expect(identity.assertAttested).toHaveBeenCalledTimes(1);
    expect(health.assertDispatchAllowed).toHaveBeenCalledTimes(1);
    expect(delivery.process).toHaveBeenCalledWith(data, {
      final: false,
      attemptsMade: 3,
      maxAttempts: 7,
    });
  });
});
