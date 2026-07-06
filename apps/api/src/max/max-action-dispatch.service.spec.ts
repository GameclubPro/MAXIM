import { UnrecoverableError } from 'bullmq';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import type { MaxActionJob } from './max-client.service';
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
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, error);
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordSkipped).not.toHaveBeenCalled();
  });
});
