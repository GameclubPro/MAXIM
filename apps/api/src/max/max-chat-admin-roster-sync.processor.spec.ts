import { DelayedError } from 'bullmq';
import { MaxChatAdminRosterSyncProcessor } from './max-chat-admin-roster-sync.processor';
import { MaxChatAdminRosterSyncSourceBackoffError } from './max-chat-admin-roster-sync.service';

describe('MaxChatAdminRosterSyncProcessor', () => {
  const originalAppRole = process.env.APP_ROLE;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-07T12:30:00.000Z'));
    process.env.APP_ROLE = 'action';
  });

  afterEach(() => {
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
    jest.useRealTimers();
  });

  it('moves source-backoff jobs to delayed without consuming an attempt', async () => {
    const service = {
      processJob: jest
        .fn()
        .mockRejectedValue(new MaxChatAdminRosterSyncSourceBackoffError('-1001', 12_000)),
    };
    const processor = new MaxChatAdminRosterSyncProcessor(service as never);
    const job = {
      data: {
        chatId: '-1001',
        botIds: ['bot-1'],
        entityType: 'chat',
      },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    };

    await expect(processor.process(job as never, 'lock-token')).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(service.processJob).toHaveBeenCalledWith(job.data);
    expect(job.moveToDelayed).toHaveBeenCalledWith(
      new Date('2026-07-07T12:30:12.000Z').getTime(),
      'lock-token',
    );
  });

  it('lets unexpected roster sync errors fail normally', async () => {
    const error = new Error('boom');
    const service = {
      processJob: jest.fn().mockRejectedValue(error),
    };
    const processor = new MaxChatAdminRosterSyncProcessor(service as never);
    const job = {
      data: {
        chatId: '-1002',
        botIds: ['bot-1'],
        entityType: 'chat',
      },
      moveToDelayed: jest.fn(),
    };

    await expect(processor.process(job as never, 'lock-token')).rejects.toBe(error);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
