import { DelayedError } from 'bullmq';
import {
  ADMIN_MANAGED_ENTITIES_REFRESH_JOB_TTL_MS,
  resolveAdminManagedEntitiesRefreshJitterMs,
  type AdminManagedEntitiesRefreshJob,
} from './admin-managed-entities-refresh.queue';
import { AdminManagedEntitiesRefreshProcessor } from './admin-managed-entities-refresh.processor';

describe('AdminManagedEntitiesRefreshProcessor', () => {
  const originalAppRole = process.env.APP_ROLE;
  const now = new Date('2026-07-26T18:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
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

  function createJob(
    overrides: Partial<AdminManagedEntitiesRefreshJob> = {},
    timestamp = now.getTime(),
  ) {
    return {
      id: 'managed-entities-refresh__chat__admin-1',
      data: {
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
        createdAt: now.toISOString(),
        ...overrides,
      },
      timestamp,
      token: 'lock-token',
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('drops an expired envelope before managed discovery can call MAX', async () => {
    const discovery = {
      processManagedEntitiesRefreshJob: jest.fn(),
    };
    const processor = new AdminManagedEntitiesRefreshProcessor(discovery as never);
    const job = createJob({
      createdAt: new Date(now.getTime() - ADMIN_MANAGED_ENTITIES_REFRESH_JOB_TTL_MS).toISOString(),
    });

    await expect(processor.process(job as never)).resolves.toBeUndefined();

    expect(discovery.processManagedEntitiesRefreshJob).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('uses the BullMQ queued timestamp for envelopes created before createdAt was added', async () => {
    const discovery = {
      processManagedEntitiesRefreshJob: jest.fn(),
    };
    const processor = new AdminManagedEntitiesRefreshProcessor(discovery as never);
    const job = createJob(
      { createdAt: undefined },
      now.getTime() - ADMIN_MANAGED_ENTITIES_REFRESH_JOB_TTL_MS - 1,
    );

    await expect(processor.process(job as never)).resolves.toBeUndefined();

    expect(discovery.processManagedEntitiesRefreshJob).not.toHaveBeenCalled();
  });

  it('adds stable bounded jitter when a refresh pass is deferred', async () => {
    const discovery = {
      processManagedEntitiesRefreshJob: jest.fn().mockResolvedValue({ continueAfterMs: 20_000 }),
    };
    const processor = new AdminManagedEntitiesRefreshProcessor(discovery as never);
    const job = createJob();
    const jitterMs = resolveAdminManagedEntitiesRefreshJitterMs(String(job.id), 'defer');

    await expect(processor.process(job as never)).rejects.toBeInstanceOf(DelayedError);

    expect(discovery.processManagedEntitiesRefreshJob).toHaveBeenCalledWith(job.data);
    expect(job.moveToDelayed).toHaveBeenCalledWith(now.getTime() + 20_000 + jitterMs, 'lock-token');
  });
});
