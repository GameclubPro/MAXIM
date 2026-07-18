import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';

function createRuntime() {
  let storedResult: unknown = null;
  const createIdempotency = jest.fn();
  const findIdempotency = jest.fn().mockImplementation(async () => ({
    id: 'test-claim-1',
    requestHash: createIdempotency.mock.calls[0]?.[0]?.data?.requestHash,
    broadcastId: null,
    result: storedResult,
  }));
  const updateIdempotency = jest.fn().mockImplementation(async ({ data }) => {
    storedResult = data.result;
    return { id: 'test-claim-1' };
  });
  const deleteIdempotency = jest.fn().mockResolvedValue({ count: 1 });
  const findPendingIdempotency = jest.fn().mockResolvedValue(null);
  const executeRaw = jest.fn().mockResolvedValue(1);
  const idempotencyClient = {
    create: createIdempotency,
    deleteMany: deleteIdempotency,
    findFirst: findPendingIdempotency,
    findUnique: findIdempotency,
    update: updateIdempotency,
  };
  const transaction = jest.fn((callback: (tx: unknown) => unknown) =>
    callback({
      $executeRaw: executeRaw,
      managedBroadcastIdempotencyRecord: idempotencyClient,
    }),
  );
  const auditCreate = jest.fn().mockResolvedValue({});
  const sendWithId = jest.fn().mockImplementation(async (_chatId, _message, options) => {
    await options?.beforeSend?.();
    return {
      messageId: 'message-1',
      chatId: 'private-chat-1',
      url: 'https://max.ru/message-1',
    };
  });
  const sendToUser = jest.fn().mockImplementation(async (_userId, _message, options) => {
    await options?.beforeSend?.();
    return {
      messageId: 'message-1',
      chatId: 'private-chat-1',
      url: 'https://max.ru/message-1',
    };
  });
  const resolvePrivateDialogChatId = jest.fn().mockResolvedValue('private-chat-1');
  const runtime = new AdminManagedBroadcastRuntime({
    prisma: {
      $transaction: transaction,
      managedBroadcastIdempotencyRecord: idempotencyClient,
      auditLog: { create: auditCreate },
    },
    maxClient: {
      sendMessageImmediateWithId: sendWithId,
      sendMessageImmediateToUser: sendToUser,
    },
    resolveDeliveryBotAssignment: jest.fn().mockResolvedValue('bot-1'),
    resolvePrivateDeliveryBotId: jest.fn().mockReturnValue('bot-1'),
    resolvePrivateDialogChatId,
  } as never);
  const preparedRequest = {
    payload: { text: 'Тест' },
    targetChatIds: ['chat-1'],
    normalizedSourceText: 'Тест',
    idempotencyKey: 'publication-test-1',
    idempotencyHash: 'payload-hash-1',
  };
  const prepareRequest = jest
    .spyOn(runtime as any, 'prepareManagedBroadcastRequest')
    .mockResolvedValue(preparedRequest);
  jest.spyOn(runtime as any, 'buildManagedBroadcastMaxApiOptions').mockReturnValue({});
  const resolveMedia = jest
    .spyOn(runtime as any, 'resolveManagedBroadcastMedia')
    .mockResolvedValue({});
  jest.spyOn(runtime as any, 'buildManagedBroadcastMessage').mockResolvedValue({
    messageText: 'Тест',
    messageOptions: {},
  });

  return {
    runtime,
    createIdempotency,
    findIdempotency,
    findPendingIdempotency,
    updateIdempotency,
    deleteIdempotency,
    executeRaw,
    transaction,
    auditCreate,
    resolveMedia,
    sendWithId,
    sendToUser,
    resolvePrivateDialogChatId,
    prepareRequest,
    preparedRequest,
  };
}

describe('AdminManagedBroadcastRuntime publication test idempotency', () => {
  const user = { userId: 'user-1', username: null, displayName: null };

  it('returns the cached result without sending a second MAX message', async () => {
    const {
      runtime,
      createIdempotency,
      findIdempotency,
      updateIdempotency,
      auditCreate,
      resolveMedia,
      sendWithId,
    } = createRuntime();
    createIdempotency
      .mockResolvedValueOnce({ id: 'test-claim-1' })
      .mockRejectedValueOnce({ code: 'P2002' });
    const first = await runtime.sendPublicationBroadcastTest('chat-1', user, {});
    const replay = await runtime.sendPublicationBroadcastTest('chat-1', user, {});

    expect(replay).toEqual(first);
    expect(sendWithId).toHaveBeenCalledTimes(1);
    expect(resolveMedia).toHaveBeenCalledTimes(1);
    expect(updateIdempotency).toHaveBeenCalledWith({
      where: { id: 'test-claim-1' },
      data: { result: first },
    });
    expect(findIdempotency).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('quarantines an uncertain send instead of reclaiming and duplicating it', async () => {
    const { runtime, createIdempotency, deleteIdempotency, sendWithId } = createRuntime();
    createIdempotency
      .mockResolvedValueOnce({ id: 'test-claim-1' })
      .mockRejectedValueOnce({ code: 'P2002' });
    sendWithId.mockImplementation(async (_chatId, _message, options) => {
      await options?.beforeSend?.();
      throw Object.assign(new Error('MAX response timeout'), { code: 'ETIMEDOUT' });
    });

    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).rejects.toMatchObject({
      status: 503,
      response: {
        code: 'BROADCAST_TEST_RESULT_PENDING',
        message: 'Результат тестовой отправки не подтверждён.',
      },
    });
    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).rejects.toMatchObject({
      response: {
        code: 'BROADCAST_TEST_RESULT_PENDING',
        message: 'Результат тестовой отправки не подтверждён.',
      },
    });

    expect(sendWithId).toHaveBeenCalledTimes(1);
    expect(deleteIdempotency).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous semantic test quarantined when the UI supplies a new request id', async () => {
    const {
      runtime,
      preparedRequest,
      prepareRequest,
      createIdempotency,
      findPendingIdempotency,
      executeRaw,
      sendWithId,
    } = createRuntime();
    prepareRequest
      .mockResolvedValueOnce({ ...preparedRequest, idempotencyKey: 'publication-test-first' })
      .mockResolvedValueOnce({ ...preparedRequest, idempotencyKey: 'publication-test-second' });
    createIdempotency.mockResolvedValueOnce({ id: 'test-claim-1' });
    findPendingIdempotency
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'test-claim-1' });
    sendWithId.mockImplementation(async (_chatId, _message, options) => {
      await options?.beforeSend?.();
      throw Object.assign(new Error('MAX response timeout'), { code: 'ETIMEDOUT' });
    });

    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).rejects.toThrow();
    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).rejects.toMatchObject({
      response: {
        code: 'BROADCAST_TEST_RESULT_PENDING',
        message: 'Результат тестовой отправки не подтверждён.',
      },
    });

    expect(createIdempotency).toHaveBeenCalledTimes(1);
    expect(sendWithId).toHaveBeenCalledTimes(1);
    expect(findPendingIdempotency).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        sourceChatId: 'chat-1',
        actorUserId: 'user-1',
        source: 'broadcast_test',
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        broadcastId: null,
      }),
      select: { id: true },
    });
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findPendingIdempotency.mock.invocationCallOrder[0],
    );
  });

  it('does not let an ambiguous claim block a different test payload', async () => {
    const {
      runtime,
      preparedRequest,
      prepareRequest,
      createIdempotency,
      findPendingIdempotency,
      sendWithId,
    } = createRuntime();
    prepareRequest
      .mockResolvedValueOnce({
        ...preparedRequest,
        idempotencyKey: 'publication-test-first',
        idempotencyHash: 'payload-hash-1',
      })
      .mockResolvedValueOnce({
        ...preparedRequest,
        idempotencyKey: 'publication-test-second',
        idempotencyHash: 'payload-hash-2',
      });
    createIdempotency
      .mockResolvedValueOnce({ id: 'test-claim-1' })
      .mockResolvedValueOnce({ id: 'test-claim-2' });
    findPendingIdempotency.mockResolvedValue(null);
    sendWithId
      .mockImplementationOnce(async (_chatId, _message, options) => {
        await options?.beforeSend?.();
        throw Object.assign(new Error('MAX response timeout'), { code: 'ETIMEDOUT' });
      })
      .mockImplementationOnce(async (_chatId, _message, options) => {
        await options?.beforeSend?.();
        return { messageId: 'message-2', chatId: 'private-chat-1', url: null };
      });

    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).rejects.toThrow();
    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).resolves.toMatchObject({
      delivered: true,
      messageId: 'message-2',
    });

    expect(createIdempotency).toHaveBeenCalledTimes(2);
    expect(sendWithId).toHaveBeenCalledTimes(2);
  });

  it('does not let a confirmed result block a deliberate new test request', async () => {
    const { runtime, preparedRequest, prepareRequest, createIdempotency, sendWithId } =
      createRuntime();
    prepareRequest
      .mockResolvedValueOnce({ ...preparedRequest, idempotencyKey: 'publication-test-first' })
      .mockResolvedValueOnce({ ...preparedRequest, idempotencyKey: 'publication-test-second' });
    createIdempotency
      .mockResolvedValueOnce({ id: 'test-claim-1' })
      .mockResolvedValueOnce({ id: 'test-claim-2' });

    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).resolves.toMatchObject({
      delivered: true,
    });
    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).resolves.toMatchObject({
      delivered: true,
    });

    expect(createIdempotency).toHaveBeenCalledTimes(2);
    expect(sendWithId).toHaveBeenCalledTimes(2);
  });

  it('quarantines a user-target timeout after MAX dispatch starts', async () => {
    const {
      runtime,
      createIdempotency,
      deleteIdempotency,
      resolvePrivateDialogChatId,
      sendWithId,
      sendToUser,
    } = createRuntime();
    createIdempotency
      .mockResolvedValueOnce({ id: 'test-claim-1' })
      .mockRejectedValueOnce({ code: 'P2002' });
    resolvePrivateDialogChatId.mockResolvedValue(null);
    sendToUser.mockImplementation(async (_userId, _message, options) => {
      await options?.beforeSend?.();
      throw Object.assign(new Error('MAX user response timeout'), { code: 'ETIMEDOUT' });
    });

    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).rejects.toThrow();
    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).rejects.toMatchObject({
      response: {
        code: 'BROADCAST_TEST_RESULT_PENDING',
        message: 'Результат тестовой отправки не подтверждён.',
      },
    });

    expect(sendWithId).not.toHaveBeenCalled();
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(deleteIdempotency).not.toHaveBeenCalled();
  });

  it.each([400, 403])(
    'releases the test claim after a confirmed MAX %s rejection',
    async (status) => {
      const { runtime, createIdempotency, deleteIdempotency, sendWithId } = createRuntime();
      createIdempotency.mockResolvedValue({ id: 'test-claim-1' });
      sendWithId
        .mockImplementationOnce(async (_chatId, _message, options) => {
          await options?.beforeSend?.();
          throw Object.assign(new Error(`MAX rejected test with ${status}`), {
            response: { status },
          });
        })
        .mockImplementationOnce(async (_chatId, _message, options) => {
          await options?.beforeSend?.();
          return {
            messageId: 'message-after-retry',
            chatId: 'private-chat-1',
            url: null,
          };
        });

      await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).rejects.toThrow();
      await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).resolves.toMatchObject(
        {
          delivered: true,
          messageId: 'message-after-retry',
        },
      );

      expect(deleteIdempotency).toHaveBeenCalledWith({
        where: {
          id: 'test-claim-1',
          broadcastId: null,
          result: { equals: expect.anything() },
        },
      });
      expect(sendWithId).toHaveBeenCalledTimes(2);
    },
  );

  it('releases the claim when a network failure happens before MAX dispatch', async () => {
    const { runtime, createIdempotency, deleteIdempotency, sendWithId } = createRuntime();
    createIdempotency.mockResolvedValue({ id: 'test-claim-1' });
    sendWithId
      .mockRejectedValueOnce(
        Object.assign(new Error('network unavailable'), { code: 'ECONNRESET' }),
      )
      .mockImplementationOnce(async (_chatId, _message, options) => {
        await options?.beforeSend?.();
        return {
          messageId: 'message-after-network-retry',
          chatId: 'private-chat-1',
          url: null,
        };
      });

    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).rejects.toThrow();
    await expect(runtime.sendPublicationBroadcastTest('chat-1', user, {})).resolves.toMatchObject({
      delivered: true,
      messageId: 'message-after-network-retry',
    });

    expect(deleteIdempotency).toHaveBeenCalledTimes(1);
    expect(sendWithId).toHaveBeenCalledTimes(2);
  });
});
