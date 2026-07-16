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
              status: row.status,
              lockedAt: row.lockedAt,
              replacementMessageId: row.replacementMessageId,
              replyMessageId: row.replyMessageId,
              replacementSendStartedAt: row.replacementSendStartedAt,
            }
          : null;
      }),
      create: jest.fn(async (args: unknown) => {
        const data = (
          args as {
            data: Pick<
              MockChatAutoCommentAttachMarkerRow,
              'chatId' | 'messageId' | 'status' | 'lockToken' | 'lockedAt' | 'botId' | 'source'
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
                'chatId' | 'messageId' | 'status' | 'lockToken' | 'lockedAt' | 'botId' | 'source'
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
            status?: 'IN_PROGRESS' | 'SUCCEEDED' | 'SKIPPED';
            lockToken?: string;
            replacementMessageId?: null;
            replyMessageId?: null;
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
        if (data.where?.status && row.status !== data.where.status) {
          return { count: 0 };
        }
        if (data.where?.lockToken && row.lockToken !== data.where.lockToken) {
          return { count: 0 };
        }
        if (data.where?.replacementMessageId === null && row.replacementMessageId !== null) {
          return { count: 0 };
        }
        if (data.where?.replyMessageId === null && row.replyMessageId !== null) {
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
        admins: [],
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

  return {
    prisma,
    ruleEngine,
    maxClient,
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

    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'mid-admin-1',
      'Пост админа',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 0', type: 'link' })]],
        debugContext: {
          screen: 'chat-auto-comments',
          action: 'replace-admin-message-with-bot-copy',
        },
      }),
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'comment_notification',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-admin-1', {
      immediate: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'comment_notification',
      timeoutMs: 2_000,
    });
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          actorUserId: 'admin-1',
          action: 'AUTO_ATTACH_CHAT_COMMENTS',
          payload: expect.objectContaining({
            deliveryMode: 'replace_with_bot_message',
            replacementMessageId: 'mid-bot-copy-1',
            publishedUrl: 'https://max.ru/chats/chat-1/message/bot-copy-1',
            originalDeleted: true,
          }),
        }),
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('keeps the bot copy if deleting the original admin message fails', async () => {
    const { prisma, maxClient, service } = createService({
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });
    maxClient.deleteMessage.mockRejectedValue({
      response: {
        status: 200,
      },
      message: 'Delete failed',
    });

    await service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        senderName: 'Админ',
        messageId: 'mid-admin-fallback',
        text: 'Пост админа для fallback',
      }),
    );

    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'mid-admin-fallback',
      'Пост админа для fallback',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 0', type: 'link' })]],
      }),
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'comment_notification',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            messageId: 'mid-admin-fallback',
            deliveryMode: 'replace_with_bot_message',
            replacementMessageId: 'mid-bot-copy-1',
            originalDeleted: false,
          }),
        }),
      }),
    );
  });

  it('persists the bot copy marker before deleting the original admin message', async () => {
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
    let releaseDelete!: () => void;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    maxClient.deleteMessage.mockImplementation(async () => {
      markDeleteStarted();
      await deleteReleased;
    });
    maxClient.sendMessageCopyWithInlineKeyboard.mockImplementation(
      async (_chatId, _messageId, _text, options) => {
        await options?.beforeSend?.();
        return {
          messageId: 'mid-bot-copy-1',
          url: 'https://max.ru/chats/chat-1/message/bot-copy-1',
        };
      },
    );

    const attach = service.handleUpdate(
      createChatMessageUpdate({
        senderId: 'admin-1',
        senderName: 'Админ',
        messageId: 'mid-admin-marker-order',
        text: 'Пост админа с комментариями',
      }),
    );
    await deleteStarted;

    expect(markerMock.rows.get('chat-1:mid-admin-marker-order')).toMatchObject({
      status: 'IN_PROGRESS',
      deliveryMode: 'replace_with_bot_message',
      replacementMessageId: 'mid-bot-copy-1',
      replacementSendStartedAt: expect.any(Date),
      publishedUrl: 'https://max.ru/chats/chat-1/message/bot-copy-1',
      originalDeleted: false,
    });

    releaseDelete();
    await attach;

    expect(markerMock.rows.get('chat-1:mid-admin-marker-order')).toMatchObject({
      status: 'SUCCEEDED',
      replacementMessageId: 'mid-bot-copy-1',
      originalDeleted: true,
    });
  });

  it('does not publish a duplicate bot copy while the same admin message is already being processed', async () => {
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
    maxClient.sendMessageCopyWithInlineKeyboard.mockImplementation(async (...args) => {
      await args[3]?.beforeSend?.();
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

    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();

    releaseSend({
      messageId: 'mid-bot-copy-race',
      url: 'https://max.ru/chats/chat-1/message/bot-copy-race',
    });
    await first;

    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(markerMock.rows.get('chat-1:mid-admin-race')).toMatchObject({
      status: 'SUCCEEDED',
      replacementMessageId: 'mid-bot-copy-race',
      originalDeleted: true,
    });
  });

  it('quarantines an attempted chat replacement timeout and never resends it', async () => {
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
    maxClient.sendMessageCopyWithInlineKeyboard.mockImplementation(async (...args) => {
      await args[3]?.beforeSend?.();
      throw Object.assign(new Error('replacement send timed out'), { code: 'ETIMEDOUT' });
    });
    const update = createChatMessageUpdate({
      senderId: 'admin-1',
      messageId: 'mid-admin-ambiguous-send',
      text: 'Пост с неопределённой отправкой',
    });

    await service.handleUpdate(update);
    await service.handleUpdate(update);

    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(markerMock.rows.get('chat-1:mid-admin-ambiguous-send')).toMatchObject({
      status: 'SKIPPED',
      deliveryMode: 'replace_with_bot_message',
      replacementMessageId: null,
      replacementSendStartedAt: expect.any(Date),
      lastError: expect.stringContaining('[max.send_ambiguous]'),
    });
  });

  it('fences a fallback reply and persists its message id before marker completion', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const { prisma, maxClient, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      [],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    maxClient.editMessageInlineKeyboard.mockRejectedValue({
      response: { status: 400 },
      message: 'Message cannot be edited',
    });
    let fenceObservedBeforeSend = false;
    maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
      await args[2]?.beforeSend?.();
      fenceObservedBeforeSend = Boolean(
        markerMock.rows.get('chat-1:mid-fallback-reply')?.replacementSendStartedAt,
      );
      return {
        messageId: 'mid-bot-reply-fenced',
        url: 'https://max.ru/chats/chat-1/message/bot-reply-fenced',
      };
    });

    await (service as any).tryAutoAttachChatMessageComments({
      chatId: 'chat-1',
      messageId: 'mid-fallback-reply',
      text: 'Fallback reply source',
      senderId: 'user-1',
      senderIsAdmin: false,
      update: createChatMessageUpdate({ messageId: 'mid-fallback-reply' }),
    });

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
    expect(markerMock.rows.get('chat-1:mid-fallback-reply')).toMatchObject({
      status: 'SUCCEEDED',
      deliveryMode: 'reply_message',
      replyMessageId: 'mid-bot-reply-fenced',
      replacementSendStartedAt: null,
      lastError: null,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            deliveryMode: 'reply_message',
            replyMessageId: 'mid-bot-reply-fenced',
          }),
        }),
      }),
    );
  });

  it('quarantines an ambiguous fallback reply and never sends it again', async () => {
    const markerMock = createChatAutoCommentAttachMarkerMock();
    const { prisma, maxClient, service } = createService(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      [],
      { chatAutoCommentAttachMarker: markerMock.delegate },
    );
    maxClient.editMessageInlineKeyboard.mockRejectedValue({
      response: { status: 400 },
      message: 'Message cannot be edited',
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async (...args) => {
      await args[2]?.beforeSend?.();
      throw Object.assign(new Error('fallback reply timed out'), { code: 'ETIMEDOUT' });
    });
    const input = {
      chatId: 'chat-1',
      messageId: 'mid-fallback-ambiguous',
      text: 'Fallback reply source',
      senderId: 'user-1',
      senderIsAdmin: false,
      update: createChatMessageUpdate({ messageId: 'mid-fallback-ambiguous' }),
    };

    await (service as any).tryAutoAttachChatMessageComments(input);
    await (service as any).tryAutoAttachChatMessageComments(input);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(markerMock.rows.get('chat-1:mid-fallback-ambiguous')).toMatchObject({
      status: 'SKIPPED',
      deliveryMode: 'reply_message',
      replyMessageId: null,
      replacementSendStartedAt: expect.any(Date),
      lastError: expect.stringContaining('[max.send_ambiguous]'),
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
    ).resolves.toEqual({ status: 'claimed', lockToken: expect.any(String) });
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
      label: 'a persisted fallback reply id',
      replacementMessageId: null,
      replacementSendStartedAt: null,
      replyMessageId: 'mid-reply-from-crashed-worker',
    },
  ])('does not reclaim a stale chat replacement marker with $label', async (markerState) => {
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

  it('does not overwrite an existing inline keyboard on the message', async () => {
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

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });
});
