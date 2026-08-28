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
const THREAD_ID = 'same-thread-id';
const TOKEN = 'publisher-token-123456';
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
  const publisherRuntime = new PublisherDialogProfileRuntime({
    prisma,
    majorDialogLinks,
    publisherDialogLinks: {
      getBotId: () => 'publisher-bot',
      resolveChatDialogThreadId: () => THREAD_ID,
    } as never,
    publisherReadiness: {
      assertEntityReady: jest.fn().mockResolvedValue({ entityType: 'chat' }),
    } as never,
  });
  (service as any).publisherDialogProfileRuntime = publisherRuntime;

  const majorToken = majorDialogLinks.buildEntityDialogToken(
    'chat',
    CHAT_ID,
    'comments',
    THREAD_ID,
  );
  return { majorRow, prisma, publisherRow, service, majorToken };
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
