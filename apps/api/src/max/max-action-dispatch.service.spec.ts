import { UnrecoverableError } from 'bullmq';
import {
  isMaxActionNoExecutableRouteError,
  MaxActionDispatchService,
  MaxActionNoExecutableRouteError,
} from './max-action-dispatch.service';
import { MaxApiCircuitOpenError, type MaxActionJob } from './max-client.service';
import type { RecordManagedEntityAccessLostFromErrorResult } from './managed-entity-access-loss.service';

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

describe('MaxActionDispatchService', () => {
  it('executes queued MAX action jobs through the client boundary', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(maxClient as never);
    const job = {
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'message-1',
      attempt: 2,
      idempotencyKey: 'job-1',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await service.execute(job);

    expect(maxClient.executeActionJob).toHaveBeenCalledWith(job);
  });

  it('records queued MAX action start and success in the ledger', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'BAN_MEMBER',
      chatId: 'chat-1',
      botId: 'bot-1',
      userId: 'user-1',
      attempt: 2,
      idempotencyKey: 'job-ban-1',
      createdAt: '2026-07-06T20:00:00.000Z',
    } as MaxActionJob;

    await service.execute(job);

    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordSucceeded).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordSkipped).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('does not reach MAX when ledger execution guard rejects a terminal race', async () => {
    const maxClient = {
      executeActionJob: jest.fn(),
    };
    const terminalRace = new UnrecoverableError('ledger is terminal');
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockRejectedValue(terminalRace),
      recordStarted: jest.fn(),
      recordSucceeded: jest.fn(),
      recordSkipped: jest.fn(),
      recordFailed: jest.fn(),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'KICK_MEMBER',
      chatId: 'chat-1',
      botId: 'bot-1',
      userId: 'user-1',
      attempt: 2,
      idempotencyKey: 'job-kick-terminal-race',
      createdAt: '2026-07-06T20:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBe(terminalRace);

    expect(actionLedgerService.assertCanExecute).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
  });

  it('does not retry an already executed action when success ledger recording fails', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockRejectedValue(new Error('ledger write failed')),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'job-send-ledger-fail',
        createdAt: '2026-07-06T20:00:00.000Z',
      } as MaxActionJob),
    ).resolves.toBeUndefined();

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('recovers a completed SEND_MESSAGE before route resolution or bot execution', async () => {
    const maxClient = {
      executeActionJob: jest.fn(),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
        remoteMessageId: 'mid-recovered-1',
        dispatchBotId: 'survivor-bot',
      }),
      getCompletedSendDispatch: jest.fn(),
      recordStarted: jest.fn(),
      recordSucceeded: jest.fn(),
      recordSkipped: jest.fn(),
      recordFailed: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockRejectedValue(new Error('route unavailable')),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'removed-bot',
        candidateBotIds: [],
        routing: { purpose: 'send_message' },
        text: 'hello',
        attempt: 2,
        idempotencyKey: 'job-send-recovered-before-route',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toEqual({
      messageId: 'mid-recovered-1',
      url: null,
      botId: 'survivor-bot',
    });

    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.getCompletedSendDispatch).not.toHaveBeenCalled();
  });

  it('records queued send access loss and stops BullMQ retries', async () => {
    const error = createMaxApiError(403, 'chat denied', 'chat.denied');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: null,
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'job-send-denied',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      operation: 'send',
      source: 'max_action:send_message',
      error,
    });
  });

  it('fails over a routed send to a surviving bot after a definitive 403 rejection', async () => {
    const denied = createMaxApiError(403, 'chat denied', 'chat.denied');
    const maxClient = {
      executeActionJob: jest.fn().mockImplementation(async (job: MaxActionJob) => {
        if (job.botId === 'bot-1') {
          throw denied;
        }
      }),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: {
          chatId: 'chat-1',
          botId: 'bot-1',
          nextOwnerBotId: 'bot-2',
          updatedAccessEdges: 1,
          cleanup: {
            nightModeJobsCleared: false,
            canceledBroadcasts: null,
            canceledBroadcastDeliveries: null,
            canceledBroadcastOccurrences: null,
            clearedVkPublishPosts: null,
            pausedVkSources: null,
            removedRosterSyncJobs: null,
          },
        },
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: {
          purpose: 'send_message',
          primaryBotId: 'bot-1',
          reason: 'primary_confirmed',
        },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-1',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(2);
    expect(maxClient.executeActionJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ botId: 'bot-1', attemptedBotIds: ['bot-1'] }),
    );
    expect(maxClient.executeActionJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botId: 'bot-2', attemptedBotIds: ['bot-1', 'bot-2'] }),
    );
  });

  it('re-prepares bot-scoped publication media for a survivor after a pre-send 403', async () => {
    const denied = createMaxApiError(403, 'chat denied', 'chat.denied');
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({
        messageId: 'mid-survivor-1',
        url: null,
      }),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );
    const prepareAttempt = jest.fn().mockImplementation(async ({ botId }: { botId: string }) => {
      if (botId === 'bot-1') {
        throw denied;
      }
      return { options: { imagePayload: { token: `${botId}-upload` } } };
    });

    await expect(
      service.execute(
        {
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          routing: { purpose: 'send_message' },
          text: 'publication',
          attempt: 1,
          idempotencyKey: 'logical-publication-1',
          createdAt: '2026-07-11T10:00:00.000Z',
        },
        { prepareAttempt },
      ),
    ).resolves.toEqual({
      messageId: 'mid-survivor-1',
      url: null,
      botId: 'bot-2',
    });

    expect(prepareAttempt).toHaveBeenNthCalledWith(1, expect.objectContaining({ botId: 'bot-1' }));
    expect(prepareAttempt).toHaveBeenNthCalledWith(2, expect.objectContaining({ botId: 'bot-2' }));
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-2',
        idempotencyKey: 'logical-publication-1',
        options: { imagePayload: { token: 'bot-2-upload' } },
      }),
    );
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('persists prepared publication context before starting the MAX SEND request', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'mid-1', url: null }),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordPrepared: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );
    const ledgerContext = {
      managedBroadcast: {
        commentDialogReference: {
          entityType: 'channel',
          threadId: 'thread-1',
          includeCommentsButton: true,
        },
      },
    } as const;

    await service.execute(
      {
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: { purpose: 'send_message' },
        text: 'publication',
        attempt: 1,
        idempotencyKey: 'logical-publication-context-1',
        createdAt: '2026-07-11T10:00:00.000Z',
      } as MaxActionJob,
      {
        prepareAttempt: jest.fn().mockResolvedValue({ ledgerContext }),
      },
    );

    expect(actionLedgerService.recordPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        ledgerContext,
      }),
    );
    expect(actionLedgerService.recordPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.executeActionJob.mock.invocationCallOrder[0],
    );
  });

  it('does not mark access loss or try a survivor after a pre-send 429', async () => {
    const rateLimited = createMaxApiError(429, 'too many requests');
    const maxClient = { executeActionJob: jest.fn() };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );
    const prepareAttempt = jest.fn().mockRejectedValue(rateLimited);

    await expect(
      service.execute(
        {
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          routing: { purpose: 'send_message' },
          text: 'publication',
          attempt: 1,
          idempotencyKey: 'logical-publication-429',
          createdAt: '2026-07-11T10:00:00.000Z',
        },
        { prepareAttempt },
      ),
    ).rejects.toBe(rateLimited);

    expect(prepareAttempt).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('refreshes a routed send snapshot after 30 minutes and skips a bot that lost capability', async () => {
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest
        .fn()
        .mockResolvedValueOnce({
          purpose: 'send_message',
          chatId: 'chat-1',
          primaryBotId: 'bot-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          reason: 'primary_confirmed',
        })
        .mockResolvedValue({
          purpose: 'send_message',
          chatId: 'chat-1',
          primaryBotId: 'bot-2',
          botId: 'bot-2',
          candidateBotIds: ['bot-2'],
          reason: 'primary_confirmed',
        }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await service.execute({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1', 'bot-2'],
      routing: { purpose: 'send_message', primaryBotId: 'bot-1' },
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'logical-send-stale-access',
      createdAt: '2026-07-11T10:00:00.000Z',
    });

    expect(maxBotLinkService.isBotAccessSnapshotStale).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-1',
      botId: 'bot-1',
      maxAgeMs: 30 * 60_000,
    });
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        source: 'routed_action_preflight',
      }),
    );
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('uses a five minute access freshness threshold for routed member moderation', async () => {
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const route = {
      purpose: 'moderation_action',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      reason: 'primary_confirmed',
      action: 'moderate_member',
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue(route),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await service.execute({
      actionType: 'BAN_MEMBER',
      chatId: 'chat-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      routing: {
        purpose: 'moderation_action',
        primaryBotId: 'bot-1',
        action: 'moderate_member',
      },
      userId: 'user-1',
      attempt: 1,
      idempotencyKey: 'logical-ban-stale-access',
      createdAt: '2026-07-11T10:00:00.000Z',
    });

    expect(maxBotLinkService.isBotAccessSnapshotStale).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      maxAgeMs: 5 * 60_000,
    });
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
  });

  it('skips a routed bot with an open shared circuit only when enforcement is on', async () => {
    const circuitOpen = new MaxApiCircuitOpenError('bot-1', 750);
    const maxClient = {
      executeActionJob: jest.fn().mockImplementation(async (job: MaxActionJob) => {
        if (job.botId === 'bot-1') {
          throw circuitOpen;
        }
      }),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'send_message' },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-circuit',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(2);
    expect(maxClient.executeActionJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botId: 'bot-2' }),
    );
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('keeps routed circuit failover disabled in the default shadow mode', async () => {
    const circuitOpen = new MaxApiCircuitOpenError('bot-1', 750);
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(circuitOpen),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'send_message' },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-circuit-shadow',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).rejects.toBe(circuitOpen);

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('keeps cross-bot delete failover disabled even when routed mutations are on', async () => {
    const circuitOpen = new MaxApiCircuitOpenError('bot-1', 750);
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(circuitOpen),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_ROUTED_MUTATIONS_MODE') {
            return 'on';
          }
          if (key === 'MAX_CROSS_BOT_EDIT_DELETE_ENABLED') {
            return false;
          }
          return undefined;
        }),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'moderation_action', action: 'delete_message' },
        messageId: 'mid-1',
        attempt: 1,
        idempotencyKey: 'logical-delete-circuit',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).rejects.toBe(circuitOpen);

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('allows cross-bot delete failover only behind its explicit flag', async () => {
    const circuitOpen = new MaxApiCircuitOpenError('bot-1', 750);
    const maxClient = {
      executeActionJob: jest.fn().mockImplementation(async (job: MaxActionJob) => {
        if (job.botId === 'bot-1') {
          throw circuitOpen;
        }
      }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_ROUTED_MUTATIONS_MODE') {
            return 'on';
          }
          if (key === 'MAX_CROSS_BOT_EDIT_DELETE_ENABLED') {
            return true;
          }
          return undefined;
        }),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'moderation_action', action: 'delete_message' },
        messageId: 'mid-1',
        attempt: 1,
        idempotencyKey: 'logical-delete-circuit-enabled',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(2);
    expect(maxClient.executeActionJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('selects routed mutation canaries deterministically by logical action and chat', () => {
    const service = new MaxActionDispatchService(
      { executeActionJob: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_ROUTED_MUTATIONS_MODE') {
            return 'canary';
          }
          if (key === 'MAX_ROUTED_MUTATIONS_CANARY_PERCENT') {
            return 50;
          }
          if (key === 'MAX_ROUTED_MUTATIONS_CANARY_ENTITY_IDS') {
            return '*';
          }
          return undefined;
        }),
      } as never,
    );
    const buildJob = (idempotencyKey: string) =>
      ({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'moderation_action' },
        messageId: 'mid-1',
        attempt: 1,
        idempotencyKey,
        createdAt: '2026-07-11T10:00:00.000Z',
      }) as MaxActionJob;
    const decisions = Array.from({ length: 100 }, (_, index) =>
      (service as any).shouldEnforceRoutedFailover(buildJob(`canary-${index}`)),
    );

    expect(decisions).toContain(true);
    expect(decisions).toContain(false);
    expect((service as any).shouldEnforceRoutedFailover(buildJob('canary-42'))).toBe(
      (service as any).shouldEnforceRoutedFailover(buildJob('canary-42')),
    );
  });

  it('recalculates a queued route when the stored routing version is stale', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-2',
        botId: 'bot-2',
        candidateBotIds: ['bot-2'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await service.execute({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      routing: {
        purpose: 'send_message',
        primaryBotId: 'bot-1',
        routingVersion: 7,
      },
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'stale-route-send',
      createdAt: '2026-07-11T10:00:00.000Z',
    });

    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-2',
        attemptedBotIds: ['bot-2'],
      }),
    );
  });

  it('uses the fresh owner for a stale routing version while failover remains shadowed', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'mid-fresh-owner', url: null }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-2',
        botId: 'bot-2',
        candidateBotIds: ['bot-2', 'bot-3'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'shadow' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: {
          purpose: 'send_message',
          primaryBotId: 'bot-1',
          routingVersion: 7,
        },
        text: 'fresh owner only',
        attempt: 1,
        idempotencyKey: 'stale-route-shadow-send',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toEqual({
      messageId: 'mid-fresh-owner',
      url: null,
      botId: 'bot-2',
    });

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2', attemptedBotIds: ['bot-2'] }),
    );
  });

  it('fails closed on a fresh empty managed route even while routed mutations are shadowed', async () => {
    const maxClient = {
      executeActionJob: jest.fn(),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn(),
      recordSucceeded: jest.fn(),
      recordSkipped: jest.fn(),
      recordFailed: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: null,
        botId: null,
        candidateBotIds: [],
        reason: null,
        routingVersion: 8,
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'shadow' : undefined)),
      } as never,
    );

    const thrown = await service
      .execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: {
          purpose: 'send_message',
          primaryBotId: 'bot-1',
          routingVersion: 7,
        },
        text: 'must not send',
        attempt: 1,
        idempotencyKey: 'stale-route-no-eligible-send',
        createdAt: '2026-07-11T10:00:00.000Z',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(MaxActionNoExecutableRouteError);
    expect(isMaxActionNoExecutableRouteError(thrown)).toBe(true);
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('returns the typed pre-dispatch outcome when every routed candidate is non-executable', async () => {
    const maxClient = {
      executeActionJob: jest.fn(),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn(),
      recordFailed: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'retired-bot',
        botId: 'retired-bot',
        candidateBotIds: ['retired-bot'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
      getExecutableBotById: jest.fn().mockReturnValue(null),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'retired-bot',
        candidateBotIds: ['retired-bot'],
        routing: { purpose: 'send_message' },
        text: 'must not send',
        attempt: 1,
        idempotencyKey: 'no-executable-send',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
  });

  it('does not try a standby after an ambiguous routed send failure', async () => {
    const ambiguous = new UnrecoverableError(
      'Ambiguous MAX SEND_MESSAGE transport failure for chat chat-1: server failure',
    );
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(ambiguous),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'send_message' },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-ambiguous',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).rejects.toBe(ambiguous);

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('records terminal queued access loss in the ledger before stopping BullMQ retries', async () => {
    const error = createMaxApiError(403, 'chat denied', 'chat.denied');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: null,
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'job-send-denied-ledger',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    const thrown = await service.execute(job).then(
      () => null,
      (executeError: unknown) => executeError,
    );

    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect(thrown).toHaveProperty(
      'message',
      'MAX SEND_MESSAGE cannot be retried for chat chat-1: bot_denied',
    );
    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, thrown);
    expect(actionLedgerService.recordFailed.mock.invocationCallOrder[0]).toBeGreaterThan(
      actionLedgerService.recordStarted.mock.invocationCallOrder[0],
    );
    expect(actionLedgerService.recordSkipped).not.toHaveBeenCalled();
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect((thrown as { response?: unknown }).response).toBe(
      (error as { response?: unknown }).response,
    );
  });

  it('treats queued delete message.not.found as idempotent success', async () => {
    const error = createMaxApiError(404, 'message not found', 'message.not.found');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'message_not_found',
          statusCode: 404,
          code: 'message.not.found',
          message: 'message not found',
        },
        reason: null,
        recorded: null,
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
    );

    await expect(
      service.execute({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'message-1',
        attempt: 1,
        idempotencyKey: 'job-delete-missing',
        createdAt: '2026-05-16T20:00:00.000Z',
      } as MaxActionJob),
    ).resolves.toBeUndefined();

    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: undefined,
      operation: 'delete',
      source: 'max_action:delete_message',
      error,
    });
  });

  it('records idempotent access-loss skips in the ledger', async () => {
    const error = createMaxApiError(404, 'message not found', 'message.not.found');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'message_not_found',
          statusCode: 404,
          code: 'message.not.found',
          message: 'message not found',
        },
        reason: null,
        recorded: null,
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'message-1',
      attempt: 1,
      idempotencyKey: 'job-delete-missing-ledger',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await service.execute(job);

    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordSkipped).toHaveBeenCalledWith(job, 'message not found');
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('keeps non-terminal queued action failures retryable', async () => {
    const error = createMaxApiError(500, 'server failure');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'job-send-500',
        createdAt: '2026-05-16T20:00:00.000Z',
      } as MaxActionJob),
    ).rejects.toBe(error);
  });

  it('records retryable queued action failures in the ledger', async () => {
    const error = createMaxApiError(500, 'server failure');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'job-send-500-ledger',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBe(error);

    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, error, {
      exhausted: false,
    });
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordSkipped).not.toHaveBeenCalled();
  });

  it('marks final retryable queued action failures as exhausted in the ledger', async () => {
    const error = createMaxApiError(500, 'server failure');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      text: 'hello',
      attempt: 5,
      idempotencyKey: 'job-send-500-final-ledger',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job, { finalAttempt: true })).rejects.toBe(error);

    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, error, {
      exhausted: true,
    });
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordSkipped).not.toHaveBeenCalled();
  });
});
