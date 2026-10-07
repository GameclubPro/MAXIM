import { DelayedError } from 'bullmq';
import { Logger } from '@nestjs/common';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { DefaultWebhookLeaseManagerService } from './default-webhook-lease-manager.service';
import { BackgroundWebhookProcessor, ModerationService } from './moderation.service';
import { createUpdate } from './moderation.service.spec-support';
import {
  deferWebhookPreparationJob,
  WebhookPreparationRetryError,
} from './webhook-preparation-retry';

describe('webhook preparation queue retry', () => {
  const originalRole = process.env.APP_ROLE;
  afterEach(() => {
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
    jest.restoreAllMocks();
  });

  function fixture() {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const canonical = {
      prepareExecution: jest.fn().mockResolvedValue({
        webhookEvent: { id: 'event-a' },
        update: createUpdate(),
        activeBotId: null,
        businessLeaseToken: 'business-token',
      }),
      completeExecution: jest.fn().mockResolvedValue(undefined),
      failExecution: jest.fn().mockResolvedValue(undefined),
    };
    Object.assign(service, { injectedWebhookCanonicalExecutionService: canonical });
    const handler = jest.spyOn(service, 'handleUpdate').mockResolvedValue(undefined);
    return { service, canonical, handler };
  }

  function processor(kind: 'static' | 'dynamic', service: ModerationService) {
    process.env.APP_ROLE = 'moderation';
    if (kind === 'static') {
      const Processor = BackgroundWebhookProcessor as unknown as new (service: unknown) => {
        process: (job: unknown, token?: string) => Promise<void>;
      };
      const worker = new Processor(service);
      return worker.process.bind(worker);
    }
    const manager = Object.create(DefaultWebhookLeaseManagerService.prototype) as {
      createWebhookJobProcessor(): (job: unknown, token?: string) => Promise<void>;
    };
    Object.assign(manager, { moderationExecutionService: service });
    return manager.createWebhookJobProcessor();
  }

  it.each(['static', 'dynamic'] as const)(
    'delays %s preparation errors with their original retry without starting the handler',
    async (kind) => {
      const f = fixture();
      const cause = new WebhookPreparationDeferredError(
        'Execution route proof changed before business',
        5_000,
      );
      f.canonical.prepareExecution.mockRejectedValue(cause);
      const nowMs = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(nowMs);
      const job = {
        id: 'event-a',
        data: { webhookEventId: 'event-a' },
        token: 'fallback-token',
        moveToDelayed: jest.fn().mockResolvedValue(undefined),
      };
      await expect(processor(kind, f.service)(job, 'owned-token')).rejects.toBeInstanceOf(
        DelayedError,
      );
      const [deadline, token] = job.moveToDelayed.mock.calls[0]!;
      expect(deadline).toBeGreaterThanOrEqual(nowMs + cause.retryAfterMs);
      expect(deadline).toBeLessThanOrEqual(nowMs + cause.retryAfterMs + 250);
      expect(token).toBe('owned-token');
      expect(f.handler).not.toHaveBeenCalled();
      expect(f.canonical.failExecution).not.toHaveBeenCalled();
      expect(f.canonical.completeExecution).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['static', 'dynamic'] as const).flatMap((kind) =>
      (['handler', 'completion'] as const).map((stage) => ({ kind, stage })),
    ),
  )(
    'keeps $kind $stage deferrals on the existing durable failure path',
    async ({ kind, stage }) => {
      const f = fixture();
      const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = new WebhookPreparationDeferredError('Handler delivery remains pending', 1_000);
      if (stage === 'handler') f.handler.mockRejectedValue(error);
      else f.canonical.completeExecution.mockRejectedValue(error);
      const job = {
        id: 'event-a',
        data: { webhookEventId: 'event-a' },
        moveToDelayed: jest.fn(),
      };
      await expect(processor(kind, f.service)(job, 'owned-token')).rejects.toBe(error);
      expect(f.canonical.failExecution).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ errorMessage: error.message, terminal: false }),
      );
      expect(job.moveToDelayed).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({ stage, errorKind: 'error' }),
        'Webhook execution failed before recovery settlement',
      );
      expect(warning.mock.invocationCallOrder[0]).toBeLessThan(
        f.canonical.failExecution.mock.invocationCallOrder[0],
      );
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(
        /event-a|business-token|remains pending/u,
      );
    },
  );

  it('leaves an untyped preparation failure unchanged', async () => {
    const f = fixture();
    const error = new Error('Database unavailable');
    f.canonical.prepareExecution.mockRejectedValue(error);
    await expect(f.service.processWebhookEvent('event-a')).rejects.toBe(error);
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.canonical.failExecution).not.toHaveBeenCalled();
  });

  it.each(['missing-token', 'foreign-receipt', 'redis-failure'] as const)(
    'preserves failure when the delay cannot be authorized: %s',
    async (failure) => {
      const cause = new WebhookPreparationDeferredError('Preparation pending', 1_000);
      const error = new WebhookPreparationRetryError('event-a', cause);
      const job = {
        id: 'event-a',
        data: { webhookEventId: failure === 'foreign-receipt' ? 'event-b' : 'event-a' },
        token: failure === 'missing-token' ? undefined : 'owned-token',
        moveToDelayed: jest.fn().mockRejectedValue(new Error('Lost Redis lock')),
      };
      await expect(deferWebhookPreparationJob(job as never, undefined, error)).rejects.toBe(error);
      expect(error.cause).toBe(cause);
      expect(job.moveToDelayed).toHaveBeenCalledTimes(failure === 'redis-failure' ? 1 : 0);
    },
  );
});
