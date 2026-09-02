import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import {
  MaxActionNoExecutableRouteError,
  MaxActionRouteQuarantinedError,
} from '../max/max-action-dispatch-error';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import { NightModeTransitionProcessor } from './night-mode-transition.processor';
import {
  buildNightModeTransitionJobId,
  NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
  NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX,
  type NightModeTransitionJob,
} from './night-mode-transition.queue';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';

describe('NightModeTransitionProcessor', () => {
  const closeRecovery = {
    kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
    version: 1 as const,
    sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
    messageId: 'close-message-1',
    botId: 'bot-1',
    timezone: 'Europe/Moscow',
    startMinutes: 23 * 60,
    endMinutes: 8 * 60,
  };
  const buildJob = (
    overrides: {
      data?: Partial<NightModeTransitionJob>;
      attemptsMade?: number;
      attempts?: number;
      id?: string;
    } = {},
  ) =>
    ({
      id: overrides.id ?? 'night-job-1',
      data: {
        chatId: 'chat-1',
        transition: 'close',
        scheduledFor: '2026-05-30T20:00:00.000Z',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        ...overrides.data,
      },
      attemptsMade: overrides.attemptsMade ?? 0,
      opts: { attempts: overrides.attempts ?? 3 },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    }) as unknown as Job<NightModeTransitionJob>;

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not enqueue the next transition after access-loss processing result', async () => {
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockResolvedValue({ shouldEnqueueNext: false }),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await processor.process(job);

    expect(moderationExecutionService.processNightModeTransitionJob).toHaveBeenCalledWith(job.data);
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('enqueues the next transition after a normal processing result', async () => {
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockResolvedValue({ shouldEnqueueNext: true }),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
      enqueueNextTransitionsForChat: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await processor.process(job);

    expect(scheduler.enqueueNextTransitionsForChat).toHaveBeenCalledWith('chat-1');
  });

  it('retires an already-existing normal Bull job after its exact occurrence is acknowledged', async () => {
    const job = buildJob({
      data: {
        transitionRuntimeVersion: 3,
        scheduleFingerprint: `sha256:${'a'.repeat(64)}`,
      },
    });
    const moderationExecutionService = { processNightModeTransitionJob: jest.fn() };
    const scheduler = {
      inspectTransitionExecution: jest.fn(),
      isTransitionManuallyFenced: jest.fn().mockResolvedValue(true),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(scheduler.isTransitionManuallyFenced).toHaveBeenCalledWith(job.data, 'night-job-1');
    expect(scheduler.inspectTransitionExecution).not.toHaveBeenCalled();
    expect(moderationExecutionService.processNightModeTransitionJob).not.toHaveBeenCalled();
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('classifies post-execution scheduling failures for ledger-gated recovery', async () => {
    const job = buildJob();
    const schedulerError = new Error('db unavailable');
    const processor = new NightModeTransitionProcessor(
      {
        processNightModeTransitionJob: jest.fn().mockResolvedValue({ shouldEnqueueNext: true }),
      } as never,
      {
        inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
        enqueueNextTransitionsForChat: jest.fn().mockRejectedValue(schedulerError),
      } as never,
    );

    await expect(processor.process(job)).rejects.toThrow(
      `${NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX}: db unavailable`,
    );
  });

  it('delays a no-route transition without scheduling past the missed occurrence', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T04:59:00.000Z'));
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValue(new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1')),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
      enqueueNextTransitionsForChat: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      new Date('2026-05-31T04:59:30.000Z').getTime(),
      'lock-token',
    );
    expect(scheduler.inspectTransitionExecution).toHaveBeenCalledTimes(2);
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('delays a quarantined route until its retry time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const retryAt = new Date('2026-05-31T05:02:30.000Z');
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValue(
          new MaxActionRouteQuarantinedError('SEND_MESSAGE', 'chat-1', retryAt, ['bot-1']),
        ),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(retryAt.getTime(), 'lock-token');
    expect(scheduler.inspectTransitionExecution).toHaveBeenCalledTimes(2);
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('applies a minimum delay when the quarantine retry time is stale', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T05:00:00.000Z'));
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValue(
          new MaxActionRouteQuarantinedError(
            'SEND_MESSAGE',
            'chat-1',
            new Date('2026-05-31T04:59:00.000Z'),
            ['bot-1'],
          ),
        ),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      new Date('2026-05-31T05:00:15.000Z').getTime(),
      'lock-token',
    );
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('schedules future transitions when the delayed occurrence later succeeds', async () => {
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValueOnce(new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1'))
        .mockResolvedValueOnce({ shouldEnqueueNext: true }),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
      enqueueNextTransitionsForChat: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);
    await expect(processor.process(job, 'lock-token')).resolves.toBeUndefined();

    expect(scheduler.enqueueNextTransitionsForChat).toHaveBeenCalledTimes(1);
    expect(scheduler.enqueueNextTransitionsForChat).toHaveBeenCalledWith('chat-1');
  });

  it('falls back to a retryable no-route failure when the lock token is unavailable', async () => {
    const job = buildJob();
    const noRouteError = new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1');
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockRejectedValue(noRouteError),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    const processing = processor.process(job);

    await expect(processing).rejects.toEqual(new Error(noRouteError.message));
    await expect(processing).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('falls back to a retryable no-route failure when delaying the job fails', async () => {
    const job = buildJob();
    (job.moveToDelayed as jest.Mock).mockRejectedValue(new Error('redis unavailable'));
    const noRouteError = new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1');
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockRejectedValue(noRouteError),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    const processing = processor.process(job, 'lock-token');

    await expect(processing).rejects.toEqual(new Error(noRouteError.message));
    await expect(processing).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock-token');
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('keeps non-route processing failures on the BullMQ failure path', async () => {
    const job = buildJob();
    const processingError = new Error('state persistence failed');
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockRejectedValue(processingError),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('execute'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job)).rejects.toBe(processingError);
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'null snapshot', permissionsSnapshot: null },
    {
      name: 'valid admin snapshot without write permissions',
      permissionsSnapshot: {
        checkedAt: '2026-05-30T19:00:00.000Z',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      },
    },
  ])(
    'continues an expired confirmed route with $name so live preflight can refresh it',
    async ({ permissionsSnapshot }) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:00:10.000Z'));
      const job = buildJob({
        id: buildNightModeTransitionJobId(
          'chat-1',
          'close',
          '2026-05-30T20:00:00.000Z',
          'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        ),
      });
      const moderationExecutionService = {
        processNightModeTransitionJob: jest.fn().mockResolvedValue({ shouldEnqueueNext: false }),
      };
      const scheduler = new NightModeTransitionSchedulerService({
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: ChatEntityType.CHAT,
            settings: {
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
            },
            botMemberships: [
              {
                botId: 'bot-1',
                status: ChatBotMembershipStatus.ACTIVE,
                botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
                botAccessExpiresAt: new Date('2026-05-30T19:00:00.000Z'),
                permissionsSnapshot,
              },
            ],
          }),
        },
      } as never);
      const processor = new NightModeTransitionProcessor(
        moderationExecutionService as never,
        scheduler,
      );

      await expect(processor.process(job, 'lock-token')).resolves.toBeUndefined();

      expect(moderationExecutionService.processNightModeTransitionJob).toHaveBeenCalledWith(
        job.data,
      );
    },
  );

  it.each([
    {
      name: 'removed membership',
      membership: {
        botId: 'bot-1',
        status: ChatBotMembershipStatus.REMOVED,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
      },
    },
    {
      name: 'explicitly denied membership',
      membership: {
        botId: 'bot-1',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.DENIED,
      },
    },
    {
      name: 'explicit non-admin permissions snapshot',
      membership: {
        botId: 'bot-1',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        permissionsSnapshot: {
          checkedAt: '2026-05-30T19:00:00.000Z',
          isAdmin: false,
          isOwner: false,
          permissions: ['write'],
        },
      },
    },
  ])('defers without execution for a $name', async ({ membership }) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:00:10.000Z'));
    const job = buildJob({
      id: buildNightModeTransitionJobId(
        'chat-1',
        'close',
        '2026-05-30T20:00:00.000Z',
        'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      ),
    });
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn(),
    };
    const scheduler = new NightModeTransitionSchedulerService({
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: {
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
          },
          botMemberships: [membership],
        }),
      },
    } as never);
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(moderationExecutionService.processNightModeTransitionJob).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledWith(
      new Date('2026-05-30T20:00:40.000Z').getTime(),
      'lock-token',
    );
  });

  it('throttles the live access refresh while an exact transition remains deferred', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:00:10.000Z'));
    const job = buildJob();
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('defer'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const rosterSync = {
      scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
    };
    const processor = new NightModeTransitionProcessor(
      { processNightModeTransitionJob: jest.fn() } as never,
      scheduler as never,
      rosterSync as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);
    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);
    jest.advanceTimersByTime(5 * 60_000);
    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledTimes(2);
    expect(rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
      source: 'moderation_destructive_path',
    });
  });

  it('retires a stale transition without entering runtime', async () => {
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn(),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('retire'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).resolves.toBeUndefined();

    expect(moderationExecutionService.processNightModeTransitionJob).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
  });

  it('keeps an unsafe v4 envelope on the failed reconciliation path', async () => {
    const job = buildJob({
      data: {
        transitionRuntimeVersion: 4,
        scheduleFingerprint: `sha256:${'a'.repeat(64)}`,
      },
    });
    const moderationExecutionService = { processNightModeTransitionJob: jest.fn() };
    const scheduler = {
      inspectTransitionExecution: jest.fn().mockResolvedValue('unsafe'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(UnrecoverableError);

    expect(scheduler.inspectTransitionExecution).toHaveBeenCalledWith(job.data, 'night-job-1');
    expect(moderationExecutionService.processNightModeTransitionJob).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'no-route failure',
      error: new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1'),
    },
    {
      name: 'route quarantine',
      error: new MaxActionRouteQuarantinedError(
        'SEND_MESSAGE',
        'chat-1',
        new Date('2026-05-30T20:05:00.000Z'),
        ['bot-1'],
      ),
    },
  ])('retires after a $name only when repeat inspection finds a stale job', async ({ error }) => {
    const job = buildJob();
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn().mockRejectedValue(error),
    };
    const scheduler = {
      inspectTransitionExecution: jest
        .fn()
        .mockResolvedValueOnce('execute')
        .mockResolvedValueOnce('retire'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).resolves.toBeUndefined();

    expect(moderationExecutionService.processNightModeTransitionJob).toHaveBeenCalledTimes(1);
    expect(scheduler.inspectTransitionExecution).toHaveBeenCalledTimes(2);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('keeps recovery-only work SQL-only and reconciles before Bull completion cleanup', async () => {
    const order: string[] = [];
    const job = buildJob({
      attemptsMade: 4,
      data: { recoveryOnly: closeRecovery, transition: 'open' },
    });
    const moderationExecutionService = {
      processNightModeTransitionJob: jest.fn(async () => {
        order.push('recover-event');
        return { shouldEnqueueNext: true };
      }),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn(),
      inspectRecoveryOnlyTransition: jest.fn().mockResolvedValue('already_complete'),
      requestJobReconcile: jest.fn(async () => {
        order.push('durable-request');
      }),
      enqueueNextTransitionsForChat: jest.fn(),
      completeScheduledJob: jest.fn(async () => {
        order.push('registry-cleanup');
      }),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).resolves.toBeUndefined();

    expect(order).toEqual(['recover-event']);
    expect(scheduler.inspectTransitionExecution).not.toHaveBeenCalled();
    expect(scheduler.enqueueNextTransitionsForChat).not.toHaveBeenCalled();
    expect(scheduler.completeScheduledJob).not.toHaveBeenCalled();

    await expect(processor.onCompleted(job)).resolves.toBeUndefined();
    expect(order).toEqual(['recover-event', 'durable-request', 'registry-cleanup']);
    expect(scheduler.completeScheduledJob).toHaveBeenCalledWith(job.data, 'night-job-1');
  });

  it('rechecks recovery-only proof instead of the normal schedule after a route error', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:00:10.000Z'));
    const job = buildJob({ data: { recoveryOnly: closeRecovery } });
    const moderationExecutionService = {
      processNightModeTransitionJob: jest
        .fn()
        .mockRejectedValue(new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1')),
    };
    const scheduler = {
      inspectTransitionExecution: jest.fn(),
      inspectRecoveryOnlyTransition: jest.fn().mockResolvedValue('needed'),
      enqueueNextTransitionsForChat: jest.fn(),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(scheduler.inspectRecoveryOnlyTransition).toHaveBeenCalledTimes(2);
    expect(scheduler.inspectTransitionExecution).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledWith(
      new Date('2026-05-30T20:00:40.000Z').getTime(),
      'lock-token',
    );
  });

  it('never enters runtime when recovery-only proof is no longer exact', async () => {
    const job = buildJob({ data: { recoveryOnly: closeRecovery, transition: 'open' } });
    const moderationExecutionService = { processNightModeTransitionJob: jest.fn() };
    const scheduler = {
      inspectTransitionExecution: jest.fn(),
      inspectRecoveryOnlyTransition: jest.fn().mockResolvedValue('unsafe'),
    };
    const processor = new NightModeTransitionProcessor(
      moderationExecutionService as never,
      scheduler as never,
    );

    await expect(processor.process(job, 'lock-token')).rejects.toBeInstanceOf(UnrecoverableError);
    expect(scheduler.inspectTransitionExecution).not.toHaveBeenCalled();
    expect(moderationExecutionService.processNightModeTransitionJob).not.toHaveBeenCalled();
  });

  it('keeps a completed recovery registry row when post-event reconcile persistence fails', async () => {
    const job = buildJob({ data: { recoveryOnly: closeRecovery } });
    const completeScheduledJob = jest.fn();
    const processor = new NightModeTransitionProcessor(
      {} as never,
      {
        requestJobReconcile: jest.fn().mockRejectedValue(new Error('db unavailable')),
        completeScheduledJob,
      } as never,
    );

    await expect(processor.onCompleted(job)).resolves.toBeUndefined();

    expect(completeScheduledJob).not.toHaveBeenCalled();
  });

  it('durably requests every real failed event without classifying an ambiguous send', async () => {
    const job = buildJob({ attemptsMade: 1, attempts: 3 });
    const ambiguousError = new Error('Ambiguous MAX SEND_MESSAGE transport outcome');
    const requestJobReconcile = jest
      .fn()
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValue(undefined);
    const processor = new NightModeTransitionProcessor(
      {} as never,
      {
        requestJobReconcile,
      } as never,
    );

    await expect(processor.onFailed(job, ambiguousError)).resolves.toBeUndefined();

    expect(requestJobReconcile).toHaveBeenCalledTimes(3);
    expect(requestJobReconcile).toHaveBeenNthCalledWith(1, job.data);
  });

  it('leaves completed registry cleanup to SQL recovery when the listener fails', async () => {
    const job = buildJob();
    const completeScheduledJob = jest.fn().mockRejectedValue(new Error('db unavailable'));
    const processor = new NightModeTransitionProcessor(
      {} as never,
      {
        completeScheduledJob,
      } as never,
    );

    await expect(processor.onCompleted(job)).resolves.toBeUndefined();
    expect(completeScheduledJob).toHaveBeenCalledWith(job.data, 'night-job-1');
  });
});
