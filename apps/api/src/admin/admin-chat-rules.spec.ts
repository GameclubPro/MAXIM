import {
  isMaxMessageMissingError,
  publishChatRules,
  readChatRules,
  resetPublishedChatRules,
} from './admin-chat-rules';

function createRules() {
  return {
    id: 'rules-1',
    chatId: 'chat-1',
    text: 'Правила чата',
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    autoTextEnabled: false,
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
    adminContactButtonEnabled: false,
    adminContactButtonUrl: '',
    publishedMessageId: 'rules-old',
    publishedBotId: 'bot-old',
    publishedUrl: 'https://max.ru/chats/chat-1/message/rules-old',
    publishedAt: new Date('2026-07-15T10:00:00.000Z'),
    publishOperationId: null,
    publishOperationBotId: null,
    publishSendStartedAt: null,
    pendingCleanupMessageId: null,
    pendingCleanupBotId: null,
    pendingCleanupIntentId: null,
    pendingCleanupKind: null,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-15T10:00:00.000Z'),
  };
}

function createPublishFixture() {
  const order: string[] = [];
  const prisma = {
    chatRules: {
      upsert: jest.fn().mockResolvedValue(createRules()),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockImplementation(async (args: { where: Record<string, unknown> }) => {
        if (args.where.publishOperationId) {
          order.push('state');
        }
        return { count: 1 };
      }),
    },
    auditLog: {
      create: jest.fn().mockImplementation(async () => {
        order.push('audit');
        return { id: 'audit-1' };
      }),
    },
  };
  const maxClient = {
    sendMessageImmediateWithResolvedLink: jest.fn().mockImplementation(async () => {
      order.push('send');
      return {
        messageId: 'rules-new',
        url: 'https://max.ru/chats/chat-1/message/rules-new',
      };
    }),
    uploadImage: jest.fn(),
    resolveMessageLink: jest.fn(),
    deleteMessage: jest.fn(),
  };
  const deletePreviousPublishedMessage = jest.fn().mockImplementation(async () => {
    order.push('cleanup');
    return 'accepted' as const;
  });
  const publish = () =>
    publishChatRules({
      prisma: prisma as never,
      chatContextCache: { invalidate: jest.fn().mockResolvedValue(undefined) },
      maxClient: maxClient as never,
      logger: { warn: jest.fn() },
      chatId: 'chat-1',
      actorUserId: 'owner-1',
      source: 'miniapp',
      resolveBotId: () => 'bot-new',
      buildAutofilledText: async () => 'Autofilled',
      buildFormattedText: async (text) => ({ text, textFormat: 'markdown' }),
      sendPrivateConfirmation: jest.fn().mockResolvedValue(undefined),
      deletePreviousPublishedMessage,
    });
  return { deletePreviousPublishedMessage, maxClient, order, prisma, publish };
}

describe('admin chat rules MAX errors', () => {
  it('repairs malformed stored rule URLs without dropping the rules', async () => {
    const rules = {
      ...createRules(),
      buttons: [
        {
          text: 'Broken',
          url: 'https://max.ru/chat/example/https://nested.example.test',
        },
      ],
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/chat/example/https://nested.example.test',
      adminContactButtonEnabled: true,
      adminContactButtonUrl: 'https://max.ru/chat/example/https://nested.example.test',
      publishedMessageId: null,
      publishedBotId: null,
      publishedUrl: 'https://max.ru/chat/example/https://nested.example.test',
      publishedAt: null,
    };
    const prisma = {
      chatRules: {
        upsert: jest.fn().mockResolvedValue(rules),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const resolveMessageLink = jest.fn();

    const result = await readChatRules({
      prisma: prisma as never,
      chatContextCache: { invalidate },
      maxClient: { resolveMessageLink } as never,
      logger: { warn: jest.fn() },
      chatId: 'chat-1',
    });

    expect(result.text).toBe('Правила чата');
    expect(result.buttons).toEqual([]);
    expect(result.buttonEnabled).toBe(false);
    expect(result.buttonUrl).toBe('');
    expect(result.adminContactButtonEnabled).toBe(false);
    expect(result.adminContactButtonUrl).toBe('');
    expect(result.publishedUrl).toBeNull();
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        adminContactButtonEnabled: true,
        adminContactButtonUrl: rules.adminContactButtonUrl,
      },
      data: {
        adminContactButtonEnabled: false,
        adminContactButtonUrl: '',
      },
    });
    expect(resolveMessageLink).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('chat-1');
  });

  it.each([
    { response: { status: 404, data: { code: 'message.not.found' } } },
    { response: { status: 404, data: { error: { code: 'message_not_found' } } } },
    { response: { status: 404, data: { message: 'Message not found' } } },
    { response: { status: 200, data: { success: false, code: 'message.not.found' } } },
  ])('accepts only a message-specific absence response', (error) => {
    expect(isMaxMessageMissingError(error)).toBe(true);
  });

  it.each([
    { response: { status: 404, data: {} } },
    { response: { status: 404, data: { code: 'chat.not.found' } } },
    { response: { status: 404, data: { message: 'Chat not found' } } },
    { response: { status: 500, data: { message: 'Message not found' } } },
    { response: { status: 500, data: { code: 'message.not.found' } } },
  ])('does not hide a non-message-specific failure', (error) => {
    expect(isMaxMessageMissingError(error)).toBe(false);
  });

  it('persists the new rules publication and pending cleanup before deleting the old post', async () => {
    const { order, prisma, publish } = createPublishFixture();

    await publish();

    expect(order).toEqual(['send', 'state', 'cleanup', 'audit']);
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        publishOperationId: expect.any(String),
      },
      data: expect.objectContaining({
        publishedMessageId: 'rules-new',
        publishedBotId: 'bot-new',
        pendingCleanupMessageId: 'rules-old',
        pendingCleanupBotId: 'bot-old',
        pendingCleanupIntentId: null,
        pendingCleanupKind: 'republish_previous',
        publishOperationId: null,
        publishSendStartedAt: null,
      }),
    });
  });

  it('retains the chat-rules send fence after an ambiguous MAX failure', async () => {
    const { maxClient, prisma, publish } = createPublishFixture();
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(
      Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
    );

    await expect(publish()).rejects.toThrow('Не удалось опубликовать правила.');

    expect(prisma.chatRules.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishOperationId: expect.any(String),
          publishOperationBotId: 'bot-new',
          publishSendStartedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('does not delete the old rules post when final publication state persistence fails', async () => {
    const { deletePreviousPublishedMessage, prisma, publish } = createPublishFixture();
    prisma.chatRules.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(publish()).rejects.toThrow('MAX принял публикацию');

    expect(deletePreviousPublishedMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.chatRules.updateMany).toHaveBeenCalledTimes(2);
  });

  it('does not finalize or clean up after losing publish fence ownership', async () => {
    const { deletePreviousPublishedMessage, prisma, publish } = createPublishFixture();
    prisma.chatRules.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(publish()).rejects.toThrow('MAX принял публикацию');

    expect(deletePreviousPublishedMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          chatId: 'chat-1',
          publishOperationId: expect.any(String),
        },
      }),
    );
  });

  it('blocks a second publish while previous-post cleanup is still owned', async () => {
    const { maxClient, prisma, publish } = createPublishFixture();
    prisma.chatRules.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(publish()).rejects.toThrow('Предыдущая публикация правил');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not turn a post-commit audit failure into a repeated MAX send', async () => {
    const { maxClient, prisma, publish } = createPublishFixture();
    prisma.auditLog.create.mockRejectedValue(new Error('audit unavailable'));

    await expect(publish()).resolves.toMatchObject({ messageId: 'rules-new' });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
  });

  it('keeps reset publication state visible while durable deletion is only accepted', async () => {
    const rules = createRules();
    const prisma = {
      chatRules: {
        upsert: jest.fn().mockResolvedValue(rules),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-reset-1' }) },
    };
    const deletePublishedMessage = jest.fn().mockResolvedValue('accepted');

    const result = await resetPublishedChatRules({
      prisma: prisma as never,
      chatContextCache: { invalidate: jest.fn().mockResolvedValue(undefined) },
      maxClient: { deleteMessage: jest.fn() } as never,
      logger: { warn: jest.fn() },
      chatId: 'chat-1',
      actorUserId: 'owner-1',
      source: 'miniapp',
      resolveBotId: () => 'bot-new',
      deletePublishedMessage,
    });

    expect(result.publishedMessageId).toBe('rules-old');
    expect(prisma.chatRules.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pendingCleanupMessageId: 'rules-old',
          pendingCleanupKind: 'reset_current',
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ cleanupOutcome: 'accepted', deletedPost: false }),
      }),
    });
  });

  it('blocks reset while a publication send fence is active', async () => {
    const rules = {
      ...createRules(),
      publishOperationId: 'publish-in-flight',
      publishOperationBotId: 'bot-new',
      publishSendStartedAt: new Date('2026-07-16T10:00:00.000Z'),
    };
    const prisma = {
      chatRules: {
        upsert: jest.fn().mockResolvedValue(rules),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { create: jest.fn() },
    };
    const deletePublishedMessage = jest.fn();

    await expect(
      resetPublishedChatRules({
        prisma: prisma as never,
        chatContextCache: { invalidate: jest.fn() },
        maxClient: { deleteMessage: jest.fn() } as never,
        logger: { warn: jest.fn() },
        chatId: 'chat-1',
        actorUserId: 'owner-1',
        source: 'miniapp',
        resolveBotId: () => 'bot-new',
        deletePublishedMessage,
      }),
    ).rejects.toThrow('Публикация или очистка правил уже выполняется');

    expect(deletePublishedMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
