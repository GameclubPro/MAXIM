import type { Job } from 'bullmq';
import { GlobalSpammerDenormProcessor } from './global-spammer-denorm.processor';
import type { GlobalSpammerDenormJob } from './global-spammer-denorm.queue';

describe('GlobalSpammerDenormProcessor', () => {
  const originalRole = process.env.APP_ROLE;
  const originalServiceName = process.env.APP_SERVICE_NAME;
  const originalFlag = process.env.SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED;

  const job = {
    data: {
      userId: 'user-1',
      chatId: 'chat-1',
      observationId: 'obs-1',
      source: 'FANOUT_REPEAT',
      reason: 'HIGH_FANOUT_5_CHATS_REPEAT',
      observedAt: '2026-06-21T12:00:00.000Z',
      createdAt: '2026-06-21T12:00:01.000Z',
    },
  } as Job<GlobalSpammerDenormJob>;

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalRole;
    }
    if (originalServiceName === undefined) {
      delete process.env.APP_SERVICE_NAME;
    } else {
      process.env.APP_SERVICE_NAME = originalServiceName;
    }
    if (originalFlag === undefined) {
      delete process.env.SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED;
    } else {
      process.env.SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED = originalFlag;
    }
  });

  it('processes jobs only for the background moderation service when enabled', async () => {
    process.env.APP_ROLE = 'moderation';
    process.env.APP_SERVICE_NAME = 'api-moderation-background';
    const service = {
      processObservationDenormJob: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED' ? 'true' : undefined,
      ),
    };
    const processor = new GlobalSpammerDenormProcessor(service as never, configService as never);

    await processor.process(job);

    expect(service.processObservationDenormJob).toHaveBeenCalledWith(job.data);
  });

  it('skips jobs outside the background service', async () => {
    process.env.APP_ROLE = 'moderation';
    process.env.APP_SERVICE_NAME = 'api-moderation-realtime-b';
    const service = {
      processObservationDenormJob: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED' ? 'true' : undefined,
      ),
    };
    const processor = new GlobalSpammerDenormProcessor(service as never, configService as never);

    await processor.process(job);

    expect(service.processObservationDenormJob).not.toHaveBeenCalled();
  });

  it('skips jobs when the denorm queue flag is disabled', async () => {
    process.env.APP_ROLE = 'moderation';
    process.env.APP_SERVICE_NAME = 'api-moderation-background';
    const service = {
      processObservationDenormJob: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED' ? 'false' : undefined,
      ),
    };
    const processor = new GlobalSpammerDenormProcessor(service as never, configService as never);

    await processor.process(job);

    expect(service.processObservationDenormJob).not.toHaveBeenCalled();
  });
});
