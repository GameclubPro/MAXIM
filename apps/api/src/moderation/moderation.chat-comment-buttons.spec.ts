import { chatSettingsSchema, type MaxUpdate } from '@maxim/contracts';
import { ModerationService } from './moderation.service';

function createChatMessageUpdate(options?: {
  senderId?: string;
  senderName?: string;
  messageId?: string;
  text?: string;
  inlineKeyboard?: boolean;
}): MaxUpdate {
  const senderId = options?.senderId ?? 'user-1';
  const senderName = options?.senderName ?? 'Участник';
  const messageId = options?.messageId ?? 'mid-chat-1';
  const text = options?.text ?? 'Новое сообщение в чате';

  return {
    updateId: `upd-${messageId}`,
    type: 'message_created',
    message: {
      messageId,
      chatId: 'chat-1',
      senderId,
      senderName,
      text,
      createdAt: new Date('2026-03-20T07:10:00.000Z').toISOString(),
    },
    raw: {
      message: {
        recipient: {
          chat_id: 'chat-1',
          chat_type: 'chat',
        },
        sender: {
          user_id: senderId,
          is_bot: false,
        },
        body: {
          attachments: options?.inlineKeyboard ? [{ type: 'inline_keyboard' }] : [],
        },
      },
    },
  };
}

function createConfigMock() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return 'test-max-bot-token';
      }
      if (key === 'MAX_BOT_ID') {
        return '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      if (key === 'APP_BASE_URL') {
        return 'https://major-maksimov.ru';
      }
      return undefined;
    }),
  };
}

type MockChatAutoCommentAttachMarkerRow = {
  id?: string;
  chatId: string;
  messageId: string;
  status: 'IN_PROGRESS' | 'SUCCEEDED' | 'SKIPPED';
  lockToken: string | null;
  lockedAt: Date | null;
  botId: string | null;
  source: string;
  deliveryMode: string | null;
  replacementMessageId: string | null;
  replacementSendStartedAt: Date | null;
  replyMessageId: string | null;
  publishedUrl: string | null;
  originalDeleted: boolean;
  lastError: string | null;
  lastStatusCode: number | null;
};

function createChatAutoCommentAttachMarkerMock() {
  const rows = new Map<string, MockChatAutoCommentAttachMarkerRow>();
  const keyOf = (chatId: string, messageId: string) => `${chatId}:${messageId}`;
  const readKey = (args: unknown) => {
    const data = args as {
      where?: { chatId_messageId?: { chatId?: string; messageId?: string } };
    };
    const chatId = data.where?.chatId_messageId?.chatId ?? '';
    const messageId = data.where?.chatId_messageId?.messageId ?? '';
    return keyOf(chatId, messageId);
  };

  return {
    rows,
    delegate: {
      findUnique: jest.fn(async (args: unknown) => {
        const row = rows.get(readKey(args));
        return row
          ? {
              id: row.id,
              status: row.status,
              lockedAt: row.lockedAt,
              botId: row.botId,
              deliveryMode: row.deliveryMode,
              replacementMessageId: row.replacementMessageId,
              replyMessageId: row.replyMessageId,
              replacementSendStartedAt: row.replacementSendStartedAt,
              lastError: row.lastError,
            }
          : null;
      }),
      create: jest.fn(async (args: unknown) => {
        const data = (
          args as {
            data: Pick<
              MockChatAutoCommentAttachMarkerRow,
              | 'id'
              | 'chatId'
              | 'messageId'
              | 'status'
              | 'lockToken'
              | 'lockedAt'
              | 'botId'
              | 'source'
            >;
          }
        ).data;
        const key = keyOf(data.chatId, data.messageId);
        if (rows.has(key)) {
          throw { code: 'P2002', message: 'Unique constraint failed' };
        }
        const row: MockChatAutoCommentAttachMarkerRow = {
          ...data,
          deliveryMode: null,
          replacementMessageId: null,
          replacementSendStartedAt: null,
          replyMessageId: null,
          publishedUrl: null,
          originalDeleted: false,
          lastError: null,
          lastStatusCode: null,
        };
        rows.set(key, row);
        return { id: key, ...row };
      }),
      createMany: jest.fn(async (args: unknown) => {
        const data = (
          args as {
            data: Array<
              Pick<
                MockChatAutoCommentAttachMarkerRow,
                | 'id'
                | 'chatId'
                | 'messageId'
                | 'status'
                | 'lockToken'
                | 'lockedAt'
                | 'botId'
                | 'source'
              >
            >;
          }
        ).data;
        let count = 0;
        for (const entry of data) {
          const key = keyOf(entry.chatId, entry.messageId);
          if (rows.has(key)) {
            continue;
          }
          rows.set(key, {
            ...entry,
            deliveryMode: null,
            replacementMessageId: null,
            replacementSendStartedAt: null,
            replyMessageId: null,
            publishedUrl: null,
            originalDeleted: false,
            lastError: null,
            lastStatusCode: null,
          });
          count += 1;
        }
        return { count };
      }),
      updateMany: jest.fn(async (args: unknown) => {
        const data = args as {
          where?: {
            chatId?: string;
            messageId?: string;
            id?: string;
            status?:
              | 'IN_PROGRESS'
              | 'SUCCEEDED'
              | 'SKIPPED'
              | { in: Array<'IN_PROGRESS' | 'SUCCEEDED' | 'SKIPPED'> };
            lockToken?: string;
            replacementMessageId?: string | null;
            replyMessageId?: string | null;
            replacementSendStartedAt?: null;
            OR?: Array<{ lockedAt?: null | { lt?: Date } }>;
          };
          data?: Partial<MockChatAutoCommentAttachMarkerRow>;
        };
        const chatId = data.where?.chatId ?? '';
        const messageId = data.where?.messageId ?? '';
        const row = rows.get(keyOf(chatId, messageId));
        if (!row) {
          return { count: 0 };
        }
        if (data.where?.id && row.id !== data.where.id) {
          return { count: 0 };
        }
        if (data.where?.status) {
          const statusMatches =
            typeof data.where.status === 'string'
              ? row.status === data.where.status
              : data.where.status.in.includes(row.status);
          if (!statusMatches) {
            return { count: 0 };
          }
        }
        if (data.where?.lockToken && row.lockToken !== data.where.lockToken) {
          return { count: 0 };
        }
        if (
          data.where?.replacementMessageId !== undefined &&
          row.replacementMessageId !== data.where.replacementMessageId
        ) {
          return { count: 0 };
        }
        if (
          data.where?.replyMessageId !== undefined &&
          row.replyMessageId !== data.where.replyMessageId
        ) {
          return { count: 0 };
        }
        if (
          data.where?.replacementSendStartedAt === null &&
          row.replacementSendStartedAt !== null
        ) {
          return { count: 0 };
        }
        if (data.where?.OR) {
          const matchesLockFilter = data.where.OR.some((condition) => {
            if (condition.lockedAt === null) {
              return row.lockedAt === null;
            }
            const lt = condition.lockedAt?.lt;
            return Boolean(lt && row.lockedAt && row.lockedAt < lt);
          });
          if (!matchesLockFilter) {
            return { count: 0 };
          }
        }
        rows.set(keyOf(chatId, messageId), {
          ...row,
          ...data.data,
        });
        return { count: 1 };
      }),
    },
  };
}

function createService(
  settingsOverrides: Record<string, unknown>,
  adminUserIds: string[] = ['admin-1'],
  options?: {
    chatAutoCommentAttachMarker?: ReturnType<
      typeof createChatAutoCommentAttachMarkerMock
    >['delegate'];
  },
) {
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Общий чат',
        settings: chatSettingsSchema.parse(settingsOverrides),
        rules: null,
        domains: [],
        admins: adminUserIds.map((userId) => ({ userId })),
      }),
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
    },
    violation: {
      create: jest.fn(),
    },
    moderationEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    ...(options?.chatAutoCommentAttachMarker
      ? { chatAutoCommentAttachMarker: options.chatAutoCommentAttachMarker }
      : {}),
  };
  const ruleEngine = {
    detect: jest.fn().mockResolvedValue({
      violations: [],
      duplicateDecision: null,
      duplicateHit: null,
    }),
  };
  const sanctionService = {
    resolveAction: jest.fn(),
  };
  const maxClient = {
    getChatAdminIds: jest.fn().mockResolvedValue(adminUserIds),
    editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    sendMessageCopyWithInlineKeyboard: jest.fn().mockResolvedValue({
      messageId: 'mid-bot-copy-1',
      url: 'https://max.ru/chats/chat-1/message/bot-copy-1',
    }),
    sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
      messageId: 'mid-bot-reply-1',
      url: 'https://max.ru/chats/chat-1/message/bot-reply-1',
    }),
    deleteMessage: jest.fn(),
    sendMessage: jest.fn(),
    kickMember: jest.fn(),
    banMember: jest.fn(),
    notifyModerators: jest.fn(),
  };

  const service = new ModerationService(
    prisma as never,
    ruleEngine as never,
    sanctionService as never,
    maxClient as never,
    undefined,
    undefined,
    createConfigMock() as never,
  );
  const resolveUnifiedBotRoute = jest
    .spyOn(service as any, 'resolveUnifiedBotRoute')
    .mockResolvedValue({
      purpose: 'send_message',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      quarantinedCandidateBotIds: [],
    });

  return {
    prisma,
    ruleEngine,
    maxClient,
    resolveUnifiedBotRoute,
    service,
  };
}

describe('ModerationService chat comment buttons', () => {
  it('auto-attaches the comments button to a fresh admin message', async () => {
    const { prisma, ruleEngine, maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        senderName: 'Админ',
        messageId: 'mid-admin-1',
        text: 'Пост админа',
      }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      '\u200B',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 0', type: 'link' })]],
        messageLink: {
          type: 'reply',
          mid: 'mid-admin-1',
        },
        beforeSend: expect.any(Function),
        debugContext: {
          screen: 'chat-auto-comments',
          action: 'reply-to-admin-message',
        },
      }),
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'comment_notification',
        botId: 'bot-1',
      }),
    );
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          actorUserId: 'admin-1',
          action: 'AUTO_ATTACH_CHAT_COMMENTS',
          payload: expect.objectContaining({
            messageId: 'mid-admin-1',
            deliveryMode: 'reply_message',
            replyMessageId: 'mid-bot-reply-1',
            originalDeleted: false,
            botId: 'bot-1',
          }),
        }),
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('does not claim or send when the strict send route has no bot', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const { prisma, maxClient, resolveUnifiedBotRoute, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    resolveUnifiedBotRoute.mockResolvedValue({
      purpose: 'send_message',
      botId: null,
      candidateBotIds: [],
      quarantinedCandidateBotIds: ['bot-quarantined'],
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        messageId: 'mid-no-send-route',
      }),
    );

    expect(resolveUnifiedBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'chat-1',
      fallbackToPrimary: true,
    });
    expect(markerMock.delegate.findUnique).toHaveBeenCalledTimes(1);
    expect(markerMock.delegate.createMany).not.toHaveBeenCalled();
    expect(markerMock.delegate.updateMany).not.toHaveBeenCalled();
    expect(markerMock.rows.size).toBe(0);
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('fences a direct reply and persists its audit before marker completion', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const { prisma, maxClient, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    let fenceObservedBeforeSend = false;
    maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
      await args[2]?.beforeSend?.();
      fenceObservedBeforeSend = Boolean(
        markerMock.rows.get('chat-1:mid-admin-marker-order')?.replacementSendStartedAt,
      );
      return {
        messageId: 'mid-bot-reply-fenced',
        url: 'https://max.ru/chats/chat-1/message/bot-reply-fenced',
      };
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        senderName: 'Админ',
        messageId: 'mid-admin-marker-order',
        text: 'Пост админа с комментариями',
      }),
    );

    expect(fenceObservedBeforeSend).toBe(true);
    const markerUpdates = markerMock.delegate.updateMany.mock.calls.map(
      ([args]) => (args as { data?: Partial<MockChatAutoCommentAttachMarkerRow> }).data ?? {},
    );
    const replyResultIndex = markerUpdates.findIndex(
      (data) => data.replyMessageId === 'mid-bot-reply-fenced',
    );
    const completionIndex = markerUpdates.findIndex((data) => data.status === 'SUCCEEDED');
    expect(replyResultIndex).toBeGreaterThanOrEqual(0);
    expect(completionIndex).toBeGreaterThan(replyResultIndex);
    expect(markerMock.rows.get('chat-1:mid-admin-marker-order')).toMatchObject({
      status: 'SUCCEEDED',
      botId: 'bot-1',
      deliveryMode: 'reply_message',
      replacementMessageId: null,
      replyMessageId: 'mid-bot-reply-fenced',
      replacementSendStartedAt: null,
      originalDeleted: false,
      lastError: null,
    });
    const markerId = markerMock.rows.get('chat-1:mid-admin-marker-order')?.id;
    expect(markerId).toMatch(/^ccr1_[a-f0-9]{32}$/u);
    const completionCallOrder = markerMock.delegate.updateMany.mock.invocationCallOrder.find(
      (_, index) => markerUpdates[index]?.status === 'SUCCEEDED',
    );
    expect(prisma.auditLog.create.mock.invocationCallOrder[0]).toBeLessThan(
      completionCallOrder ?? Number.POSITIVE_INFINITY,
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.stringMatching(/^aca1_[a-f0-9]{32}$/u),
          payload: expect.objectContaining({
            threadId: markerId,
            deliveryMode: 'reply_message',
            replyMessageId: 'mid-bot-reply-fenced',
            originalDeleted: false,
          }),
        }),
      }),
    );
  });

  it('recovers a failed reply audit without sending the bot reply twice', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const { prisma, maxClient, resolveUnifiedBotRoute, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    prisma.auditLog.create
      .mockRejectedValueOnce(new Error('audit database unavailable'))
      .mockResolvedValueOnce(undefined);
    const update = createChatMessageUpdate({
      senderId: 'admin-1',
      messageId: 'mid-admin-audit-recovery',
    });

    await expect(service.handleUpdate(update)).rejects.toThrow('audit database unavailable');
    resolveUnifiedBotRoute.mockRejectedValue(
      new Error('audit recovery must not require an executable send route'),
    );
    await service.handleUpdate(update);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(resolveUnifiedBotRoute).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    const marker = markerMock.rows.get('chat-1:mid-admin-audit-recovery');
    expect(marker).toMatchObject({
      status: 'SUCCEEDED',
      deliveryMode: 'reply_message',
      replyMessageId: 'mid-bot-reply-1',
      originalDeleted: false,
    });
    const auditCreates = prisma.auditLog.create.mock.calls.map(
      ([args]) => args as { data: { id: string; payload: { threadId: string } } },
    );
    expect(auditCreates[0]?.data.id).toBe(auditCreates[1]?.data.id);
    expect(auditCreates[1]?.data.payload.threadId).toBe(marker?.id);
  });

  it('recovers a delivered reply after comments and admin eligibility are disabled', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const { prisma, ruleEngine, maxClient, resolveUnifiedBotRoute, service } = createService(
      {
        commentsEnabled: false,
        commentsAdminsEnabled: false,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      [],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    prisma.auditLog.create
      .mockRejectedValueOnce(new Error('audit write interrupted'))
      .mockResolvedValueOnce(undefined);
    const messageId = 'mid-admin-policy-changed-before-retry';

    await expect(
      (service as any).tryAutoAttachChatMessageComments({
        chatId: 'chat-1',
        messageId,
        senderId: 'former-admin',
      }),
    ).rejects.toThrow('audit write interrupted');
    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'former-admin',
        messageId,
      }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(resolveUnifiedBotRoute).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(markerMock.rows.get(`chat-1:${messageId}`)).toMatchObject({
      status: 'SUCCEEDED',
      deliveryMode: 'reply_message',
      replyMessageId: 'mid-bot-reply-1',
    });
  });

  it('repairs a succeeded reply marker whose deterministic audit is missing', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const markerId = `ccr1_${'a'.repeat(32)}`;
    markerMock.rows.set('chat-1:mid-admin-succeeded-without-audit', {
      id: markerId,
      chatId: 'chat-1',
      messageId: 'mid-admin-succeeded-without-audit',
      status: 'SUCCEEDED',
      lockToken: null,
      lockedAt: null,
      botId: 'bot-original',
      source: 'webhook',
      deliveryMode: 'reply_message',
      replacementMessageId: null,
      replacementSendStartedAt: null,
      replyMessageId: 'mid-bot-existing-reply',
      publishedUrl: null,
      originalDeleted: false,
      lastError: null,
      lastStatusCode: null,
    });
    const { prisma, maxClient, resolveUnifiedBotRoute, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        messageId: 'mid-admin-succeeded-without-audit',
      }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(resolveUnifiedBotRoute).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: `aca1_${'a'.repeat(32)}`,
        actorUserId: 'admin-1',
        payload: expect.objectContaining({
          threadId: markerId,
          replyMessageId: 'mid-bot-existing-reply',
          botId: 'bot-original',
        }),
      }),
    });
  });

  it('persists the reply audit when the intermediate reply marker update fails', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const updateMarker = markerMock.delegate.updateMany.getMockImplementation();
    markerMock.delegate.updateMany.mockImplementation(async (args: unknown) => {
      const data = (args as { data?: Partial<MockChatAutoCommentAttachMarkerRow> }).data;
      if (data?.replyMessageId && !data.status) {
        return { count: 0 };
      }
      return updateMarker?.(args) ?? { count: 0 };
    });
    const { prisma, maxClient, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        messageId: 'mid-admin-reply-marker-failure',
      }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(markerMock.rows.get('chat-1:mid-admin-reply-marker-failure')).toMatchObject({
      status: 'SUCCEEDED',
      deliveryMode: 'reply_message',
      replyMessageId: 'mid-bot-reply-1',
      originalDeleted: false,
      lastError: expect.stringContaining('reply marker persistence failed'),
    });
  });

  it('repairs a missing reply marker from its audit without resending', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const updateMarker = markerMock.delegate.updateMany.getMockImplementation();
    let auditedRecoveryAttempts = 0;
    markerMock.delegate.updateMany.mockImplementation(async (args: unknown) => {
      const input = args as {
        where?: { status?: string | { in: string[] } };
        data?: Partial<MockChatAutoCommentAttachMarkerRow>;
      };
      if (input.data?.replyMessageId && !input.data.status) {
        return { count: 0 };
      }
      if (
        input.data?.replyMessageId &&
        typeof input.where?.status === 'string' &&
        input.data.lastError
      ) {
        return { count: 0 };
      }
      if (input.data?.replyMessageId && typeof input.where?.status === 'object') {
        auditedRecoveryAttempts += 1;
        if (auditedRecoveryAttempts === 1) {
          throw new Error('marker recovery database unavailable');
        }
      }
      return updateMarker?.(args) ?? { count: 0 };
    });
    const { prisma, maxClient, resolveUnifiedBotRoute, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    let persistedAudit:
      | { id: string; chatId: string; action: string; payload: Record<string, unknown> }
      | undefined;
    prisma.auditLog.create.mockImplementation(async (args: unknown) => {
      persistedAudit = (
        args as {
          data: { id: string; chatId: string; action: string; payload: Record<string, unknown> };
        }
      ).data;
    });
    prisma.auditLog.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { id?: string } }).where;
      return persistedAudit && where?.id === persistedAudit.id
        ? { id: persistedAudit.id, payload: persistedAudit.payload }
        : null;
    });
    const update = createChatMessageUpdate({
      senderId: 'admin-1',
      messageId: 'mid-admin-reverse-audit-recovery',
    });

    await expect(service.handleUpdate(update)).rejects.toThrow(
      'marker recovery database unavailable',
    );
    await service.handleUpdate(update);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(resolveUnifiedBotRoute).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(markerMock.rows.get('chat-1:mid-admin-reverse-audit-recovery')).toMatchObject({
      status: 'SUCCEEDED',
      deliveryMode: 'reply_message',
      replyMessageId: 'mid-bot-reply-1',
      replacementSendStartedAt: null,
      originalDeleted: false,
    });
  });

  it('rekeys a stale unsent legacy marker before publishing a recoverable reply', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    markerMock.rows.set('chat-1:mid-admin-legacy-unsent', {
      id: 'legacy-cuid-marker',
      chatId: 'chat-1',
      messageId: 'mid-admin-legacy-unsent',
      status: 'IN_PROGRESS',
      lockToken: 'legacy-lock',
      lockedAt: new Date('2020-01-01T00:00:00.000Z'),
      botId: 'bot-legacy',
      source: 'webhook',
      deliveryMode: null,
      replacementMessageId: null,
      replacementSendStartedAt: null,
      replyMessageId: null,
      publishedUrl: null,
      originalDeleted: false,
      lastError: null,
      lastStatusCode: null,
    });
    const { prisma, maxClient, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        messageId: 'mid-admin-legacy-unsent',
      }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    const marker = markerMock.rows.get('chat-1:mid-admin-legacy-unsent');
    expect(marker).toMatchObject({
      id: expect.stringMatching(/^ccr1_[a-f0-9]{32}$/u),
      status: 'SUCCEEDED',
      deliveryMode: 'reply_message',
      replyMessageId: 'mid-bot-reply-1',
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.stringMatching(/^aca1_[a-f0-9]{32}$/u),
        payload: expect.objectContaining({ threadId: marker?.id }),
      }),
    });
  });

  it('does not publish a duplicate reply while the same admin message is already being processed', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const { prisma, maxClient, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    let releaseSend!: (value: { messageId: string; url: string }) => void;
    const sendReleased = new Promise<{ messageId: string; url: string }>((resolve) => {
      releaseSend = resolve;
    });
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
      await args[2]?.beforeSend?.();
      markSendStarted();
      return sendReleased;
    });
    const update = createChatMessageUpdate({
      senderId: 'admin-1',
      senderName: 'Админ',
      messageId: 'mid-admin-race',
      text: 'Пост админа без дубля',
    });

    const first = service.handleUpdate(update);
    await sendStarted;
    const second = service.handleUpdate(update);
    await second;

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();

    releaseSend({
      messageId: 'mid-bot-reply-race',
      url: 'https://max.ru/chats/chat-1/message/bot-reply-race',
    });
    await first;

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(markerMock.rows.get('chat-1:mid-admin-race')).toMatchObject({
      status: 'SUCCEEDED',
      deliveryMode: 'reply_message',
      replacementMessageId: null,
      replyMessageId: 'mid-bot-reply-race',
      originalDeleted: false,
    });
  });

  it('quarantines an attempted chat reply timeout and never resends it', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const { maxClient, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
      await args[2]?.beforeSend?.();
      throw Object.assign(new Error('reply send timed out'), { code: 'ETIMEDOUT' });
    });
    const update = createChatMessageUpdate({
      senderId: 'admin-1',
      messageId: 'mid-admin-ambiguous-send',
      text: 'Пост с неопределённой отправкой',
    });

    await service.handleUpdate(update);
    await service.handleUpdate(update);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(markerMock.rows.get('chat-1:mid-admin-ambiguous-send')).toMatchObject({
      status: 'SKIPPED',
      deliveryMode: 'reply_message',
      replacementMessageId: null,
      replyMessageId: null,
      replacementSendStartedAt: expect.any(Date),
      lastError: expect.stringContaining('[max.send_ambiguous]'),
    });
  });

  it('marks a terminal reply rejection as skipped and never retries it', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const { prisma, maxClient, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
      await args[2]?.beforeSend?.();
      throw Object.assign(new Error('Reply target is invalid'), {
        response: { status: 400 },
      });
    });
    const update = createChatMessageUpdate({
      senderId: 'admin-1',
      messageId: 'mid-terminal-reply',
      text: 'Пост с недоступным reply target',
    });

    await service.handleUpdate(update);
    await service.handleUpdate(update);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(markerMock.rows.get('chat-1:mid-terminal-reply')).toMatchObject({
      status: 'SKIPPED',
      deliveryMode: 'reply_message',
      replyMessageId: null,
      replacementSendStartedAt: null,
      lastError: 'Reply target is invalid',
      lastStatusCode: 400,
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('claims chat auto-comment markers with skipDuplicates to avoid unique constraint noise', async () => {
    const delegate = {
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const { service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: delegate as never },
    );

    await expect(
      (service as any).replacementAttachMarkerStore.claimChatAutoComment({
        chatId: 'chat-1',
        messageId: 'mid-admin-race',
        source: 'webhook',
        botId: 'bot-1',
      }),
    ).resolves.toEqual({
      status: 'claimed',
      lockToken: expect.any(String),
      markerId: expect.stringMatching(/^ccr1_[a-f0-9]{32}$/u),
    });
    await expect(
      (service as any).replacementAttachMarkerStore.claimChatAutoComment({
        chatId: 'chat-1',
        messageId: 'mid-admin-race',
        source: 'webhook',
        botId: 'bot-1',
      }),
    ).resolves.toEqual({ status: 'in_progress' });

    expect(delegate.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId: 'chat-1',
          messageId: 'mid-admin-race',
          status: 'IN_PROGRESS',
          source: 'webhook',
          botId: 'bot-1',
        }),
      ],
      skipDuplicates: true,
    });
    const attemptedMarkerIds = delegate.createMany.mock.calls.map(
      ([args]) => (args as { data: Array<{ id: string }> }).data[0]?.id,
    );
    const conflictClaim = delegate.updateMany.mock.calls.at(-1)?.[0] as
      | { where?: { id?: string } }
      | undefined;
    expect(attemptedMarkerIds[1]).not.toBe(attemptedMarkerIds[0]);
    expect(conflictClaim?.where?.id).toBe(attemptedMarkerIds[1]);
    expect(delegate.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'the send-start fence',
      replacementMessageId: null,
      replacementSendStartedAt: new Date('2026-03-20T06:00:00.000Z'),
      replyMessageId: null,
    },
    {
      label: 'a persisted replacement id',
      replacementMessageId: 'mid-copy-from-crashed-worker',
      replacementSendStartedAt: null,
      replyMessageId: null,
    },
    {
      label: 'a persisted reply id',
      replacementMessageId: null,
      replacementSendStartedAt: null,
      replyMessageId: 'mid-reply-from-crashed-worker',
    },
  ])('does not reclaim a stale chat auto-comment marker with $label', async (markerState) => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    markerMock.rows.set('chat-1:mid-admin-stale-fence', {
      chatId: 'chat-1',
      messageId: 'mid-admin-stale-fence',
      status: 'IN_PROGRESS',
      lockToken: 'crashed-worker-lock',
      lockedAt: new Date('2026-03-20T06:00:00.000Z'),
      botId: 'bot-1',
      source: 'webhook',
      deliveryMode: 'replace_with_bot_message',
      replacementMessageId: markerState.replacementMessageId,
      replacementSendStartedAt: markerState.replacementSendStartedAt,
      replyMessageId: markerState.replyMessageId,
      publishedUrl: null,
      originalDeleted: false,
      lastError: null,
      lastStatusCode: null,
    });
    const { maxClient, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      ['admin-1'],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        messageId: 'mid-admin-stale-fence',
        text: 'Already attempted replacement',
      }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(markerMock.rows.get('chat-1:mid-admin-stale-fence')).toMatchObject({
      lockToken: 'crashed-worker-lock',
      replacementMessageId: markerState.replacementMessageId,
      replacementSendStartedAt: markerState.replacementSendStartedAt,
      replyMessageId: markerState.replyMessageId,
    });
  });

  it('does not attach the comments button to a regular message when only the legacy all toggle is enabled', async () => {
    const { maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: false,
      commentsAllEnabled: true,
      commentsChatBroadcastsEnabled: false,
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'user-2',
        senderName: 'Обычный участник',
        messageId: 'mid-user-2',
        text: 'Сообщение участника',
      }),
    );

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not attach the comments button to a regular message when only admin posts are enabled', async () => {
    const { maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'user-3',
        senderName: 'Участник',
        messageId: 'mid-user-3',
      }),
    );

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('replies without overwriting an existing inline keyboard on the original message', async () => {
    const { maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        senderName: 'Админ',
        messageId: 'mid-admin-inline',
        inlineKeyboard: true,
      }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      '\u200B',
      expect.objectContaining({
        messageLink: {
          type: 'reply',
          mid: 'mid-admin-inline',
        },
      }),
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });
});
