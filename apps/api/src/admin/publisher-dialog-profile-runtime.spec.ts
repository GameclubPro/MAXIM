import { chatSettingsSchema } from '@maxim/contracts';
import { AdminService } from './admin.service';
import {
  CHANNEL_DIALOG_ACTION_COMMENT,
  PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
} from './admin.service.support';
import {
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
  extractSqlText,
} from './admin-service-test-support';
import { PublisherDialogProfileRuntime } from './publisher-dialog-profile-runtime';

const CHAT_ID = 'chat-shared';
const CHANNEL_ID = 'channel-shared';
const THREAD_ID = 'same-thread-id';
const TOKEN = 'publisher-token-123456';
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const user = {
  userId: 'user-1',
  username: 'user1',
  displayName: 'Пользователь',
  chatTitle: null,
};

function commentRow(id: string, text: string) {
  return {
    id,
    actorUserId: user.userId,
    payload: {
      type: 'comments',
      threadId: THREAD_ID,
      text,
      authorDisplayName: user.displayName,
    },
    createdAt: new Date('2026-08-27T10:00:00.000Z'),
  };
}

function createHarness() {
  const prisma = createPrismaMock() as any;
  prisma.publisherEntitySettings = {
    findUnique: jest.fn().mockResolvedValue({
      chatCommentsEnabled: true,
      chatCommentsAdminsEnabled: true,
      chatCommentsPostsEnabled: true,
      channelCommentsEnabled: false,
    }),
  };
  prisma.managedEntityAccessEdge = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  prisma.chatSettings.findUnique.mockResolvedValue(
    chatSettingsSchema.parse({
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: true,
      commentsChatBroadcastsEnabled: true,
    }),
  );
  const majorRow = commentRow('major-comment', 'Комментарий Майора');
  const publisherRow = commentRow('publisher-comment', 'Комментарий Публика');
  prisma.auditLog.findMany.mockImplementation(async ({ where }: any) => {
    if (where?.action === CHANNEL_DIALOG_ACTION_COMMENT) return [majorRow];
    return [];
  });
  prisma.$queryRaw.mockImplementation(async (query: any) => {
    const sql = extractSqlText(query);
    if (!sql.includes(PUBLISHER_CHAT_DIALOG_ACTION_COMMENT)) {
      return [];
    }
    if (sql.includes('FOR UPDATE OF audit') && !query.values?.includes(publisherRow.id)) {
      return [];
    }
    return [publisherRow];
  });
  prisma.auditLog.create.mockImplementation(async ({ data }: any) => ({
    id: 'publisher-created',
    actorUserId: data.actorUserId,
    payload: data.payload,
    createdAt: new Date('2026-08-27T10:05:00.000Z'),
  }));

  const service = new AdminService(
    prisma,
    {} as never,
    createChatContextCacheMock() as never,
    createConfigMock() as never,
  );
  const majorDialogLinks = (service as any).dialogLinkHelper;
  const assertEntityReady = jest.fn(async (chatId: string) => ({
    entityType: chatId === CHANNEL_ID ? 'channel' : 'chat',
  }));
  const publisherRuntime = new PublisherDialogProfileRuntime({
    prisma,
    majorDialogLinks,
    publisherDialogLinks: {
      getBotId: () => 'publisher-bot',
      resolveChatDialogThreadId: () => THREAD_ID,
      resolveChannelDialogThreadId: () => THREAD_ID,
    } as never,
    publisherReadiness: {
      assertEntityReady,
    } as never,
  });
  (service as any).publisherDialogProfileRuntime = publisherRuntime;

  const majorToken = majorDialogLinks.buildEntityDialogToken(
    'chat',
    CHAT_ID,
    'comments',
    THREAD_ID,
  );
  return { assertEntityReady, majorRow, prisma, publisherRow, service, majorToken };
}

function createSuggestionHarness() {
  const prisma = createPrismaMock() as any;
  let stored: any = null;
  prisma.auditLog.count.mockResolvedValue(0);
  prisma.auditLog.findUnique.mockImplementation(async ({ where }: any) =>
    stored?.id === where.id ? stored : null,
  );
  prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
    stored = {
      id: data.id,
      chatId: data.chatId,
      actorUserId: data.actorUserId,
      action: data.action,
      payload: data.payload,
      createdAt: new Date('2026-08-27T10:05:00.000Z'),
    };
    return stored;
  });
  prisma.auditLog.update.mockImplementation(async ({ where, data }: any) => {
    if (!stored || stored.id !== where.id) {
      throw new Error('missing stored audit row');
    }
    stored = {
      ...stored,
      ...(data.action ? { action: data.action } : {}),
      ...(data.payload ? { payload: data.payload } : {}),
    };
    return stored;
  });
  const service = new AdminService(
    prisma,
    {} as never,
    createChatContextCacheMock() as never,
    createConfigMock() as never,
  );
  const runtime = new PublisherDialogProfileRuntime({
    prisma,
    majorDialogLinks: (service as any).dialogLinkHelper,
    publisherDialogLinks: {
      resolveChannelDialogThreadId: () => THREAD_ID,
    } as never,
    publisherReadiness: {
      assertEntityReady: jest.fn().mockResolvedValue({ entityType: 'channel' }),
    } as never,
  });
  return {
    prisma,
    runtime,
    mapAuditLog: (...args: any[]) => (service as any).mapChannelDialogAuditLog(...args),
  };
}

describe('Publisher chat dialog profile ownership', () => {
  it('keeps Major and Publisher comments separate even when their thread ids match', async () => {
    const { prisma, service, majorToken } = createHarness();

    const [major, publisher] = await Promise.all([
      service.getChatDialog(CHAT_ID, user, 'comments', majorToken, 'moderation'),
      service.getChatDialog(CHAT_ID, user, 'comments', TOKEN, 'publisher'),
    ]);

    expect(major.messages.map((message) => message.id)).toEqual(['major-comment']);
    expect(publisher.messages.map((message) => message.id)).toEqual(['publisher-comment']);
    const publisherQuery = prisma.$queryRaw.mock.calls
      .map((call: unknown[]) => call[0])
      .find((query: unknown) =>
        extractSqlText(query).includes(PUBLISHER_CHAT_DIALOG_ACTION_COMMENT),
      );
    expect(extractSqlText(publisherQuery)).toContain("audit.payload->>'threadId' =");
  });

  it('stores Publisher comments under their own action and profile marker', async () => {
    const { prisma, service } = createHarness();

    await service.createChatDialogMessage(
      CHAT_ID,
      user,
      'comments',
      { token: TOKEN, text: 'Новый комментарий Публика' },
      'publisher',
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
          payload: expect.objectContaining({ publisherProfile: true }),
        }),
      }),
    );
    const countQueries = prisma.$queryRaw.mock.calls
      .map((call: unknown[]) => extractSqlText(call[0]))
      .filter((sql: string) => sql.includes('COUNT(*)::bigint'));
    expect(countQueries).toHaveLength(1);
    expect(countQueries[0]).toContain("audit.action = 'PUBLISHER_CHAT_DIALOG_COMMENT'");
  });

  it.each([
    [
      'edit',
      (service: AdminService) =>
        service.updateChatDialogMessage(
          CHAT_ID,
          user,
          'comments',
          'major-comment',
          { token: TOKEN, text: 'Чужая правка' },
          'publisher',
        ),
    ],
    [
      'delete',
      (service: AdminService) =>
        service.deleteChatDialogMessage(
          CHAT_ID,
          user,
          'comments',
          'major-comment',
          { token: TOKEN },
          'publisher',
        ),
    ],
    [
      'react',
      (service: AdminService) =>
        service.toggleEntityDialogReactionForDialog({
          chatId: CHAT_ID,
          entityType: 'chat',
          userId: user.userId,
          dialogType: 'comments',
          messageId: 'major-comment',
          token: TOKEN,
          emoji: 'like',
          dialogProfile: 'publisher',
        }),
    ],
  ] as const)('rejects cross-profile %s against a Major row', async (name, operation) => {
    const { majorRow, prisma, service } = createHarness();
    prisma.auditLog.findFirst.mockImplementation(async ({ where }: any) =>
      where?.action === CHANNEL_DIALOG_ACTION_COMMENT ? majorRow : null,
    );

    await expect(operation(service)).rejects.toThrow('Комментарий не найден.');
    if (name === 'delete') {
      expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT }),
        }),
      );
    } else {
      const lockSql = prisma.$queryRaw.mock.calls
        .map((call: unknown[]) => extractSqlText(call[0]))
        .find((sql: string) => sql.includes('FOR UPDATE OF audit'));
      expect(lockSql).toContain("audit.action = 'PUBLISHER_CHAT_DIALOG_COMMENT'");
    }
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.delete).not.toHaveBeenCalled();
  });

  it('rejects a Publisher reply to a Major comment in the same thread', async () => {
    const { majorRow, prisma, service } = createHarness();
    prisma.auditLog.findFirst.mockImplementation(async ({ where }: any) =>
      where?.action === CHANNEL_DIALOG_ACTION_COMMENT ? majorRow : null,
    );

    await expect(
      service.createChatDialogMessage(
        CHAT_ID,
        user,
        'comments',
        { token: TOKEN, text: 'Ответ', replyToMessageId: majorRow.id },
        'publisher',
      ),
    ).rejects.toThrow('Сообщение для ответа не найдено.');
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT }),
      }),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('Publisher channel comment profile ownership', () => {
  it('keeps an exact signed Publisher channel thread readable after module disablement', async () => {
    const { assertEntityReady, prisma, publisherRow, service } = createHarness();

    const result = await service.getChannelDialog(CHANNEL_ID, user, 'comments', TOKEN, 'publisher');

    expect(result.messages.map((message) => message.id)).toEqual([publisherRow.id]);
    expect(assertEntityReady).toHaveBeenCalledWith(CHANNEL_ID, 'publication');
    expect(prisma.publisherEntitySettings.findUnique).not.toHaveBeenCalled();
    const query = prisma.$queryRaw.mock.calls
      .map((call: unknown[]) => call[0])
      .find((value: unknown) =>
        extractSqlText(value).includes(PUBLISHER_CHAT_DIALOG_ACTION_COMMENT),
      );
    expect(extractSqlText(query)).toContain("audit.action = 'PUBLISHER_CHAT_DIALOG_COMMENT'");
    expect(extractSqlText(query)).toContain("audit.payload->>'threadId' =");
    expect(prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityType: 'CHANNEL' }),
      }),
    );
  });

  it('creates comments in an existing thread after disablement and classifies channel admins', async () => {
    const { assertEntityReady, prisma, service } = createHarness();
    prisma.managedEntityAccessEdge.findMany.mockResolvedValue([{ userId: user.userId }]);

    const result = await service.createChannelDialogMessage(
      CHANNEL_ID,
      user,
      'comments',
      { token: TOKEN, text: 'Комментарий Публика в канале' },
      'publisher',
    );

    expect(result.message.isAdmin).toBe(true);
    expect(assertEntityReady).toHaveBeenCalledWith(CHANNEL_ID, 'publication');
    expect(prisma.publisherEntitySettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: CHANNEL_ID,
          entityType: 'CHANNEL',
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: CHANNEL_ID,
          action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
          payload: expect.objectContaining({
            threadId: THREAD_ID,
            publisherProfile: true,
          }),
        }),
      }),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: CHANNEL_DIALOG_ACTION_COMMENT }),
      }),
    );
  });
});

describe('Publisher channel suggestions with photos', () => {
  it.each([
    ['text-only', { token: TOKEN, text: 'Только текст' }, 0],
    [
      'image-only',
      {
        token: TOKEN,
        text: '',
        images: [{ base64: TINY_PNG_BASE64, mimeType: 'image/png', fileName: 'photo.png' }],
      },
      1,
    ],
    [
      'text-and-image',
      {
        token: TOKEN,
        text: 'Текст с фото',
        images: [{ base64: TINY_PNG_BASE64, mimeType: 'image/png', fileName: 'photo.png' }],
      },
      1,
    ],
  ] as const)('accepts %s suggestions', async (_label, body, expectedImageCount) => {
    const { mapAuditLog, prisma, runtime } = createSuggestionHarness();

    const result = await runtime.createChannelSuggestion({
      chatId: 'channel-1',
      user,
      dialogType: 'suggest',
      body,
      mapAuditLog,
    });

    expect(result.message).toEqual(
      expect.objectContaining({
        text: body.text,
        hasImage: expectedImageCount > 0,
        imageCount: expectedImageCount,
      }),
    );
    const finalizeData = prisma.auditLog.update.mock.calls.find(
      ([call]: any[]) => call.data.action === 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION',
    )?.[0]?.data;
    expect(finalizeData.payload).toEqual(
      expect.objectContaining({
        text: body.text,
        hasImage: expectedImageCount > 0,
        imageCount: expectedImageCount,
        imageStorageVersion: 1,
      }),
    );
    expect(finalizeData.payload).not.toHaveProperty('images');
    if (expectedImageCount === 0) {
      expect(finalizeData).not.toHaveProperty('channelSuggestionImageAssets');
    } else {
      const storedImage = finalizeData.channelSuggestionImageAssets.create[0];
      expect(storedImage).toEqual(
        expect.objectContaining({
          position: 0,
          mimeType: 'image/png',
          fileName: 'photo.png',
          sizeBytes: expect.any(Number),
        }),
      );
      expect(Buffer.from(storedImage.bytes).toString('base64')).toBe(TINY_PNG_BASE64);
    }
  });

  it('returns the exact stored suggestion on request replay and rejects content collisions', async () => {
    const { mapAuditLog, prisma, runtime } = createSuggestionHarness();
    const baseRequest = {
      token: TOKEN,
      requestId: 'publisher_suggestion_request_1',
      text: 'Идемпотентная предложка',
    };

    const first = await runtime.createChannelSuggestion({
      chatId: 'channel-1',
      user,
      dialogType: 'suggest',
      body: baseRequest,
      mapAuditLog,
    });
    const replay = await runtime.createChannelSuggestion({
      chatId: 'channel-1',
      user,
      dialogType: 'suggest',
      body: baseRequest,
      mapAuditLog,
    });

    expect(replay.message.id).toBe(first.message.id);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.count).toHaveBeenCalledTimes(1);
    expect(
      prisma.$executeRaw.mock.calls.map((call: unknown[]) => extractSqlText(call[0])).join('\n'),
    ).toContain('pg_advisory_xact_lock');

    await expect(
      runtime.createChannelSuggestion({
        chatId: 'channel-1',
        user,
        dialogType: 'suggest',
        body: { ...baseRequest, text: 'Другое содержимое' },
        mapAuditLog,
      }),
    ).rejects.toThrow('идентификатор уже использован');
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects the daily quota before decoding or validating image bytes', async () => {
    const { mapAuditLog, prisma, runtime } = createSuggestionHarness();
    prisma.auditLog.count.mockResolvedValue(10);

    await expect(
      runtime.createChannelSuggestion({
        chatId: 'channel-1',
        user,
        dialogType: 'suggest',
        body: {
          token: TOKEN,
          requestId: 'publisher_suggestion_quota_1',
          text: '',
          images: [{ base64: 'not-base64', mimeType: 'image/png', fileName: 'bad.png' }],
        },
        mapAuditLog,
      }),
    ).rejects.toThrow('Лимит предложек на сегодня исчерпан.');

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('rejects a colliding request id before processing changed invalid media', async () => {
    const { mapAuditLog, prisma, runtime } = createSuggestionHarness();
    const requestId = 'publisher_suggestion_collision_1';
    await runtime.createChannelSuggestion({
      chatId: 'channel-1',
      user,
      dialogType: 'suggest',
      body: { token: TOKEN, requestId, text: 'Исходная предложка' },
      mapAuditLog,
    });
    const updatesAfterFirstSubmit = prisma.auditLog.update.mock.calls.length;

    await expect(
      runtime.createChannelSuggestion({
        chatId: 'channel-1',
        user,
        dialogType: 'suggest',
        body: {
          token: TOKEN,
          requestId,
          text: 'Другое содержимое',
          images: [{ base64: 'not-base64', mimeType: 'image/png', fileName: 'bad.png' }],
        },
        mapAuditLog,
      }),
    ).rejects.toThrow('идентификатор уже использован');

    expect(prisma.auditLog.update).toHaveBeenCalledTimes(updatesAfterFirstSubmit);
    expect(prisma.auditLog.count).toHaveBeenCalledTimes(1);
  });

  it('admits only one active media-processing lease per channel user', async () => {
    const { mapAuditLog, prisma, runtime } = createSuggestionHarness();
    prisma.$queryRaw.mockResolvedValue([{ id: 'another-active-admission' }]);

    await expect(
      runtime.createChannelSuggestion({
        chatId: 'channel-1',
        user,
        dialogType: 'suggest',
        body: {
          token: TOKEN,
          requestId: 'publisher_suggestion_parallel_1',
          text: '',
          images: [{ base64: 'not-base64', mimeType: 'image/png', fileName: 'bad.png' }],
        },
        mapAuditLog,
      }),
    ).rejects.toThrow('Другая предложка уже обрабатывается');

    expect(prisma.auditLog.count).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    const activeGuardSql = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(activeGuardSql).toContain("submissionStatus' = 'processing'");
    expect(activeGuardSql).toContain('submissionLeaseExpiresAt');
    expect(activeGuardSql).toContain('LIMIT 1');
  });

  it('replays a rejected admission without reprocessing the same damaged photo', async () => {
    const { mapAuditLog, prisma, runtime } = createSuggestionHarness();
    const body = {
      token: TOKEN,
      requestId: 'publisher_suggestion_rejected_1',
      text: '',
      images: [{ base64: 'not-base64', mimeType: 'image/png', fileName: 'bad.png' }],
    };

    await expect(
      runtime.createChannelSuggestion({
        chatId: 'channel-1',
        user,
        dialogType: 'suggest',
        body,
        mapAuditLog,
      }),
    ).rejects.toThrow('Фото повреждено. Добавьте файл заново.');
    await expect(
      runtime.createChannelSuggestion({
        chatId: 'channel-1',
        user,
        dialogType: 'suggest',
        body,
        mapAuditLog,
      }),
    ).rejects.toThrow('Фото повреждено. Добавьте файл заново.');

    expect(prisma.auditLog.count).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.update).toHaveBeenCalledTimes(1);
  });

  it('rejects files and damaged image data without creating a partial suggestion', async () => {
    const fileFixture = createSuggestionHarness();
    await expect(
      fileFixture.runtime.createChannelSuggestion({
        chatId: 'channel-1',
        user,
        dialogType: 'suggest',
        body: {
          token: TOKEN,
          text: 'Файл',
          attachments: [
            {
              type: 'file',
              base64: Buffer.from('file').toString('base64'),
              mimeType: 'application/pdf',
              fileName: 'file.pdf',
            },
          ],
        },
        mapAuditLog: fileFixture.mapAuditLog,
      }),
    ).rejects.toThrow('В предложке поддерживаются только фотографии.');
    expect(fileFixture.prisma.auditLog.create).not.toHaveBeenCalled();

    const damagedFixture = createSuggestionHarness();
    await expect(
      damagedFixture.runtime.createChannelSuggestion({
        chatId: 'channel-1',
        user,
        dialogType: 'suggest',
        body: {
          token: TOKEN,
          text: '',
          images: [{ base64: 'not-base64', mimeType: 'image/png', fileName: 'bad.png' }],
        },
        mapAuditLog: damagedFixture.mapAuditLog,
      }),
    ).rejects.toThrow('Фото повреждено. Добавьте файл заново.');
    expect(damagedFixture.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(damagedFixture.prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            submissionStatus: 'rejected',
            submissionClaimToken: null,
          }),
        }),
      }),
    );
  });
});
