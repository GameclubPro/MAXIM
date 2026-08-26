import { chatSettingsSchema, type MaxUpdate } from '@maxim/contracts';
import { PublisherChatCommentAdmissionError } from '../publisher/publisher-chat-comment.queue';
import { ModerationService } from './moderation.service';

function createChatMessageUpdate(options?: {
  senderId?: string;
  messageId?: string;
  inlineKeyboard?: boolean;
}): MaxUpdate {
  const senderId = options?.senderId ?? 'admin-1';
  const messageId = options?.messageId ?? 'message-1';
  return {
    updateId: `update-${messageId}`,
    type: 'message_created',
    message: {
      messageId,
      chatId: 'chat-1',
      senderId,
      senderName: senderId === 'admin-1' ? 'Админ' : 'Участник',
      text: 'Сообщение в чате',
      createdAt: '2026-08-26T09:00:00.000Z',
    },
    raw: {
      message: {
        recipient: { chat_id: 'chat-1', chat_type: 'chat' },
        sender: { user_id: senderId, is_bot: false },
        body: {
          attachments: options?.inlineKeyboard ? [{ type: 'inline_keyboard' }] : [],
        },
      },
    },
  };
}

type MarkerRow = {
  id: string;
  chatId: string;
  messageId: string;
  status: 'IN_PROGRESS' | 'SUCCEEDED' | 'SKIPPED';
  lockToken: string | null;
  lockedAt: Date | null;
  botId: string | null;
  source: string;
  deliveryMode: string | null;
  replacementMessageId: string | null;
  replyMessageId: string | null;
  replacementSendStartedAt: Date | null;
  publishedUrl: string | null;
  originalDeleted: boolean;
  cleanupIntentId: string | null;
  lastError: string | null;
  lastStatusCode: number | null;
};

function createMarkerStore() {
  const rows = new Map<string, MarkerRow>();
  const key = (chatId: string, messageId: string) => `${chatId}:${messageId}`;
  return {
    rows,
    delegate: {
      findUnique: jest.fn(async (args: unknown) => {
        const where = (
          args as { where?: { chatId_messageId?: { chatId?: string; messageId?: string } } }
        ).where?.chatId_messageId;
        const row = rows.get(key(where?.chatId ?? '', where?.messageId ?? ''));
        return row ? { ...row } : null;
      }),
      createMany: jest.fn(async (args: unknown) => {
        const data = (
          args as {
            data: Array<
              Pick<
                MarkerRow,
                | 'id'
                | 'chatId'
                | 'messageId'
                | 'status'
                | 'lockToken'
                | 'lockedAt'
                | 'source'
                | 'botId'
              >
            >;
          }
        ).data[0]!;
        const rowKey = key(data.chatId, data.messageId);
        if (rows.has(rowKey)) return { count: 0 };
        rows.set(rowKey, {
          ...data,
          deliveryMode: null,
          replacementMessageId: null,
          replyMessageId: null,
          replacementSendStartedAt: null,
          publishedUrl: null,
          originalDeleted: false,
          cleanupIntentId: null,
          lastError: null,
          lastStatusCode: null,
        });
        return { count: 1 };
      }),
      updateMany: jest.fn(async (args: unknown) => {
        const input = args as {
          where?: {
            id?: string;
            chatId?: string;
            messageId?: string;
            lockToken?: string;
            status?: string | { in: string[] };
            deliveryMode?: string | null;
            replacementMessageId?: string | null;
            replyMessageId?: string | null;
            replacementSendStartedAt?: Date | null;
            publishedUrl?: string | null;
            originalDeleted?: boolean;
            cleanupIntentId?: string | null;
            OR?: Array<{ lockedAt?: null | { lt?: Date } }>;
          };
          data?: Partial<MarkerRow>;
        };
        const chatId = input.where?.chatId ?? '';
        const messageId = input.where?.messageId ?? '';
        const rowKey = key(chatId, messageId);
        const row = rows.get(rowKey);
        if (!row) return { count: 0 };
        const where = input.where ?? {};
        if (where.id && where.id !== row.id) return { count: 0 };
        if (where.lockToken && where.lockToken !== row.lockToken) return { count: 0 };
        if (
          typeof where.status === 'string'
            ? where.status !== row.status
            : where.status && !where.status.in.includes(row.status)
        ) {
          return { count: 0 };
        }
        for (const field of [
          'deliveryMode',
          'replacementMessageId',
          'replyMessageId',
          'replacementSendStartedAt',
          'publishedUrl',
          'originalDeleted',
          'cleanupIntentId',
        ] as const) {
          if (field in where && where[field] !== row[field]) return { count: 0 };
        }
        if (
          where.OR &&
          !where.OR.some((condition) =>
            condition.lockedAt === null
              ? row.lockedAt === null
              : Boolean(
                  condition.lockedAt?.lt && row.lockedAt && row.lockedAt < condition.lockedAt.lt,
                ),
          )
        ) {
          return { count: 0 };
        }
        rows.set(rowKey, { ...row, ...(input.data ?? {}) });
        return { count: 1 };
      }),
    },
  };
}

function createHarness(options?: {
  commentsEnabled?: boolean;
  commentsAdminsEnabled?: boolean;
  adminUserIds?: string[];
}) {
  const marker = createMarkerStore();
  const adminUserIds = options?.adminUserIds ?? ['admin-1'];
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Чат',
        settings: chatSettingsSchema.parse({
          commentsEnabled: options?.commentsEnabled ?? true,
          commentsAdminsEnabled: options?.commentsAdminsEnabled ?? true,
          commentsAllEnabled: false,
          commentsChatBroadcastsEnabled: false,
        }),
        rules: null,
        domains: [],
        admins: adminUserIds.map((userId) => ({ userId })),
      }),
    },
    chatAutoCommentAttachMarker: marker.delegate,
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
    },
    violation: { create: jest.fn() },
    moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
  };
  const maxClient = {
    getChatAdminIds: jest.fn().mockResolvedValue(adminUserIds),
    editMessageInlineKeyboard: jest.fn(),
    sendMessageImmediateWithResolvedLink: jest.fn(),
    sendMessageCopyWithInlineKeyboard: jest.fn(),
    deleteMessage: jest.fn(),
    sendMessage: jest.fn(),
    kickMember: jest.fn(),
    banMember: jest.fn(),
    notifyModerators: jest.fn(),
  };
  const service = new ModerationService(
    prisma as never,
    {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: null,
        duplicateHit: null,
      }),
    } as never,
    { resolveAction: jest.fn() } as never,
    maxClient as never,
    undefined,
    undefined,
    {
      get: jest.fn((name: string) => {
        if (name === 'MAX_BOT_TOKEN') return 'test-main-bot-token';
        if (name === 'MAX_BOT_ID') return 'main-bot';
        if (name === 'MAX_BOT_CONTACT_ID') return '777000';
        if (name === 'MAX_PUBLISHER_BOT_ID') return 'publik-bot';
        if (name === 'APP_BASE_URL') return 'https://major-maksimov.ru';
        return undefined;
      }),
    } as never,
  );
  const queue = { enqueueAttach: jest.fn().mockResolvedValue(undefined) };
  Object.assign(service as object, { publisherChatCommentQueueService: queue });
  const resolveRoute = jest
    .spyOn(
      service as unknown as {
        resolveUnifiedBotRoute: (request: unknown) => Promise<unknown>;
      },
      'resolveUnifiedBotRoute',
    )
    .mockResolvedValue({
      purpose: 'send_message',
      botId: 'main-bot',
      candidateBotIds: ['main-bot'],
      quarantinedCandidateBotIds: [],
    });
  return { marker, prisma, maxClient, queue, resolveRoute, service };
}

describe('ModerationService publisher chat-comment producer', () => {
  it('claims and enqueues an admin chat reply without calling MAX', async () => {
    const harness = createHarness();
    await harness.service.handleUpdate(createChatMessageUpdate());

    const row = harness.marker.rows.get('chat-1:message-1');
    expect(row).toMatchObject({
      id: expect.stringMatching(/^ccr1_[a-f0-9]{32}$/u),
      status: 'IN_PROGRESS',
      botId: 'main-bot',
      replacementSendStartedAt: null,
    });
    expect(harness.queue.enqueueAttach).toHaveBeenCalledWith({
      markerId: row?.id,
      lockToken: row?.lockToken,
      chatId: 'chat-1',
      messageId: 'message-1',
      senderId: 'admin-1',
      dialogBotId: 'main-bot',
      button: expect.objectContaining({ type: 'link', text: '💬 Комментарии · 0' }),
    });
    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(harness.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(harness.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not claim or enqueue when no main dialog route exists', async () => {
    const harness = createHarness();
    harness.resolveRoute.mockResolvedValue({
      purpose: 'send_message',
      botId: null,
      candidateBotIds: [],
      quarantinedCandidateBotIds: ['main-bot'],
    });
    await harness.service.handleUpdate(createChatMessageUpdate());

    expect(harness.marker.rows.size).toBe(0);
    expect(harness.queue.enqueueAttach).not.toHaveBeenCalled();
    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('releases the marker when Redis enqueue fails so webhook retry can enqueue again', async () => {
    const harness = createHarness();
    harness.queue.enqueueAttach
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValueOnce(undefined);
    const update = createChatMessageUpdate({ messageId: 'message-retry' });

    await expect(harness.service.handleUpdate(update)).rejects.toThrow('Redis unavailable');
    expect(harness.marker.rows.get('chat-1:message-retry')).toMatchObject({
      status: 'IN_PROGRESS',
      lockToken: null,
      lockedAt: null,
      replacementSendStartedAt: null,
    });
    await harness.service.handleUpdate(update);

    expect(harness.queue.enqueueAttach).toHaveBeenCalledTimes(2);
    expect(harness.marker.rows.get('chat-1:message-retry')?.lockToken).toEqual(expect.any(String));
  });

  it.each(['heartbeat_missing', 'dispatch_disabled'] as const)(
    'terminalizes the marker and completes the webhook when publisher admission is %s',
    async (reason) => {
      const harness = createHarness();
      harness.queue.enqueueAttach.mockRejectedValue(new PublisherChatCommentAdmissionError(reason));
      const update = createChatMessageUpdate({ messageId: `message-${reason}` });

      await expect(harness.service.handleUpdate(update)).resolves.toBeUndefined();

      expect(harness.queue.enqueueAttach).toHaveBeenCalledTimes(1);
      expect(harness.marker.rows.get(`chat-1:message-${reason}`)).toMatchObject({
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        replacementSendStartedAt: null,
        lastError: expect.stringContaining(reason),
      });
      await expect(harness.service.handleUpdate(update)).resolves.toBeUndefined();

      expect(harness.queue.enqueueAttach).toHaveBeenCalledTimes(1);
      expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    },
  );

  it('does not terminalize an admission skip after the marker claim changes owner', async () => {
    const harness = createHarness();
    let rejectAdmission!: (error: unknown) => void;
    harness.queue.enqueueAttach.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectAdmission = reject;
      }),
    );
    const update = createChatMessageUpdate({ messageId: 'message-admission-cas' });

    const handling = harness.service.handleUpdate(update);
    while (harness.queue.enqueueAttach.mock.calls.length === 0) await Promise.resolve();
    const claimed = harness.marker.rows.get('chat-1:message-admission-cas');
    expect(claimed?.lockToken).toEqual(expect.any(String));
    harness.marker.rows.set('chat-1:message-admission-cas', {
      ...claimed!,
      lockToken: 'new-owner-lock',
      lockedAt: new Date('2026-08-26T09:01:00.000Z'),
    });

    rejectAdmission(new PublisherChatCommentAdmissionError('heartbeat_missing'));
    await expect(handling).rejects.toThrow(
      'Failed to terminalize the publisher chat-comment admission marker',
    );

    expect(harness.marker.rows.get('chat-1:message-admission-cas')).toMatchObject({
      status: 'IN_PROGRESS',
      lockToken: 'new-owner-lock',
      lockedAt: new Date('2026-08-26T09:01:00.000Z'),
    });
  });

  it('does not enqueue a duplicate while the first claim is being handed to Redis', async () => {
    const harness = createHarness();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.queue.enqueueAttach.mockReturnValue(pending);
    const update = createChatMessageUpdate({ messageId: 'message-race' });

    const first = harness.service.handleUpdate(update);
    while (harness.queue.enqueueAttach.mock.calls.length === 0) await Promise.resolve();
    await harness.service.handleUpdate(update);

    expect(harness.queue.enqueueAttach).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('leaves publisher audit recovery to the durable job that retains dialogBotId', async () => {
    const harness = createHarness({
      commentsEnabled: false,
      commentsAdminsEnabled: false,
      adminUserIds: [],
    });
    const markerId = `ccr1_${'b'.repeat(32)}`;
    harness.marker.rows.set('chat-1:message-recovery', {
      id: markerId,
      chatId: 'chat-1',
      messageId: 'message-recovery',
      status: 'IN_PROGRESS',
      lockToken: null,
      lockedAt: null,
      botId: 'publik-bot',
      source: 'webhook',
      deliveryMode: 'reply_message',
      replacementMessageId: null,
      replyMessageId: 'publisher-reply-1',
      replacementSendStartedAt: null,
      publishedUrl: null,
      originalDeleted: false,
      cleanupIntentId: null,
      lastError: null,
      lastStatusCode: null,
    });
    await harness.service.handleUpdate(
      createChatMessageUpdate({ senderId: 'former-admin', messageId: 'message-recovery' }),
    );

    expect(harness.queue.enqueueAttach).not.toHaveBeenCalled();
    expect(harness.resolveRoute).not.toHaveBeenCalled();
    expect(harness.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(harness.marker.rows.get('chat-1:message-recovery')).toMatchObject({
      status: 'IN_PROGRESS',
      replyMessageId: 'publisher-reply-1',
    });
  });

  it('never reclaims a stale marker after a possibly attempted send', async () => {
    const harness = createHarness();
    harness.marker.rows.set('chat-1:message-fenced', {
      id: `ccr1_${'c'.repeat(32)}`,
      chatId: 'chat-1',
      messageId: 'message-fenced',
      status: 'IN_PROGRESS',
      lockToken: 'crashed-worker-lock',
      lockedAt: new Date('2020-01-01T00:00:00.000Z'),
      botId: 'publik-bot',
      source: 'webhook',
      deliveryMode: 'reply_message',
      replacementMessageId: null,
      replyMessageId: null,
      replacementSendStartedAt: new Date('2020-01-01T00:00:01.000Z'),
      publishedUrl: null,
      originalDeleted: false,
      cleanupIntentId: null,
      lastError: null,
      lastStatusCode: null,
    });
    await harness.service.handleUpdate(createChatMessageUpdate({ messageId: 'message-fenced' }));

    expect(harness.queue.enqueueAttach).not.toHaveBeenCalled();
    expect(harness.marker.rows.get('chat-1:message-fenced')).toMatchObject({
      lockToken: 'crashed-worker-lock',
      replacementSendStartedAt: new Date('2020-01-01T00:00:01.000Z'),
    });
  });

  it('does not enqueue ordinary participant messages', async () => {
    const harness = createHarness();
    await harness.service.handleUpdate(createChatMessageUpdate({ senderId: 'user-1' }));

    expect(harness.queue.enqueueAttach).not.toHaveBeenCalled();
    expect(harness.maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('keeps an original inline keyboard untouched and enqueues a separate reply', async () => {
    const harness = createHarness();
    await harness.service.handleUpdate(
      createChatMessageUpdate({ messageId: 'message-inline', inlineKeyboard: true }),
    );

    expect(harness.queue.enqueueAttach).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message-inline' }),
    );
    expect(harness.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(harness.maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
  });
});
