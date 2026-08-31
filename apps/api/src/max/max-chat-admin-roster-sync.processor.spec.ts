import { DelayedError } from 'bullmq';
import { MaxChatAdminRosterSyncProcessor } from './max-chat-admin-roster-sync.processor';
import { MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND } from './max-chat-admin-roster-sync.queue';
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
    const processor = new MaxChatAdminRosterSyncProcessor(service as never, {} as never);
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
    const processor = new MaxChatAdminRosterSyncProcessor(service as never, {} as never);
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

  it('drops stale membership churn prewarms before they call MAX', async () => {
    const service = {
      processJob: jest.fn(),
    };
    const processor = new MaxChatAdminRosterSyncProcessor(service as never, {} as never);
    const job = {
      timestamp: new Date('2026-07-07T12:27:59.999Z').getTime(),
      data: {
        chatId: '-1002',
        botIds: ['bot-1'],
        entityType: 'chat',
        source: 'webhook_membership_churn',
      },
      moveToDelayed: jest.fn(),
    };

    await expect(processor.process(job as never, 'lock-token')).resolves.toBeUndefined();
    expect(service.processJob).not.toHaveBeenCalled();
  });

  it('dispatches discriminated deferred access-loss cleanup jobs', async () => {
    const rosterSyncService = {
      processJob: jest.fn(),
    };
    const managedEntityAccessLossService = {
      processDeferredRuntimeCleanup: jest.fn().mockResolvedValue({ applied: false }),
    };
    const processor = new MaxChatAdminRosterSyncProcessor(
      rosterSyncService as never,
      managedEntityAccessLossService as never,
    );
    const job = {
      data: {
        kind: MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND,
        chatId: 'chat-1',
        botId: 'bot-1',
        lifecycleEventAt: '2026-08-20T12:00:00.123Z',
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
        reason: 'bot_removed',
        source: 'webhook_bot_removed',
      },
      moveToDelayed: jest.fn(),
    };

    await expect(processor.process(job as never, 'lock-token')).resolves.toEqual({
      applied: false,
    });

    expect(managedEntityAccessLossService.processDeferredRuntimeCleanup).toHaveBeenCalledWith(
      job.data,
    );
    expect(rosterSyncService.processJob).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
