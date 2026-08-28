import { extractSqlText } from './admin-service-test-support';
import {
  buildPublisherChatCommentCountQuery,
  buildPublisherChatCommentsQuery,
  countPublisherChatComments,
  toggleDialogCommentReactionForProfile,
  updateDialogCommentForProfile,
} from './publisher-chat-comment-store';

const baseRow = {
  id: 'comment-1',
  actorUserId: 'author-1',
  payload: {
    type: 'comments',
    threadId: 'thread-1',
    text: 'До правки',
    reactions: [{ emoji: 'like', userIds: ['user-2'] }],
  },
  createdAt: new Date('2026-08-28T10:00:00.000Z'),
};

function createMutationPrisma(row = baseRow) {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([row]),
    auditLog: {
      update: jest.fn(async ({ data }: any) => ({ ...row, payload: data.payload })),
    },
  };
  prisma.$transaction = jest.fn(async (operation: (tx: typeof prisma) => unknown) =>
    operation(prisma),
  );
  return prisma;
}

describe('Publisher chat comment queries', () => {
  it('keeps the list predicate literal and aligned with its partial expression index', () => {
    const query = buildPublisherChatCommentsQuery('chat-1', 'thread-1');
    const sql = extractSqlText(query);

    expect(sql).toContain("audit.action = 'PUBLISHER_CHAT_DIALOG_COMMENT'");
    expect(sql).toContain("audit.payload->>'threadId' =");
    expect(sql).toContain('ORDER BY audit.created_at DESC');
    expect(sql).toContain('LIMIT');
    expect(query.values).toEqual(['chat-1', 'thread-1', 80]);
  });

  it('keeps the count on the same literal action and thread expression', async () => {
    const query = buildPublisherChatCommentCountQuery('chat-1', 'thread-1');
    const sql = extractSqlText(query);

    expect(sql).toContain('SELECT COUNT(*)::bigint AS count');
    expect(sql).toContain("audit.action = 'PUBLISHER_CHAT_DIALOG_COMMENT'");
    expect(sql).toContain("audit.payload->>'threadId' =");
    expect(query.values).toEqual(['chat-1', 'thread-1']);

    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ count: 17n }]) };
    await expect(countPublisherChatComments(prisma as never, 'chat-1', 'thread-1')).resolves.toBe(
      17,
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('edits a Publisher comment under a row lock without losing reactions', async () => {
    const prisma = createMutationPrisma();
    const resolvePublisherThreadId = jest.fn().mockReturnValue('thread-1');
    const resolveLegacyTarget = jest.fn();

    const updated = await updateDialogCommentForProfile({
      prisma,
      chatId: 'chat-1',
      messageId: 'comment-1',
      dialogProfile: 'publisher',
      userId: 'author-1',
      text: '  После правки  ',
      resolvePublisherThreadId,
      resolveLegacyTarget,
      hasAttachments: () => false,
    });

    expect(extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0])).toContain('FOR UPDATE OF audit');
    expect(updated?.payload).toEqual(
      expect.objectContaining({
        text: 'После правки',
        editedAt: expect.any(String),
        reactions: [{ emoji: 'like', userIds: ['user-2'] }],
      }),
    );
    expect(resolvePublisherThreadId).toHaveBeenCalledTimes(1);
    expect(resolveLegacyTarget).not.toHaveBeenCalled();
  });

  it('checks Publisher edit ownership while holding the row lock', async () => {
    const prisma = createMutationPrisma({ ...baseRow, actorUserId: 'another-author' });

    await expect(
      updateDialogCommentForProfile({
        prisma,
        chatId: 'chat-1',
        messageId: 'comment-1',
        dialogProfile: 'publisher',
        userId: 'author-1',
        text: 'Правка',
        resolvePublisherThreadId: () => 'thread-1',
        resolveLegacyTarget: jest.fn(),
        hasAttachments: () => false,
      }),
    ).rejects.toThrow('Редактировать можно только свои комментарии.');
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('keeps the Major edit on its existing target path without taking a Publisher lock', async () => {
    const prisma = createMutationPrisma();
    const resolvePublisherThreadId = jest.fn();
    const resolveLegacyTarget = jest.fn().mockResolvedValue({
      row: baseRow,
      payload: baseRow.payload,
    });

    const updated = await updateDialogCommentForProfile({
      prisma,
      chatId: 'chat-1',
      messageId: 'comment-1',
      dialogProfile: 'moderation',
      userId: 'author-1',
      text: 'Major edit',
      resolvePublisherThreadId,
      resolveLegacyTarget,
      hasAttachments: () => false,
    });

    expect(updated?.payload).toEqual(
      expect.objectContaining({
        text: 'Major edit',
        reactions: [{ emoji: 'like', userIds: ['user-2'] }],
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(resolvePublisherThreadId).not.toHaveBeenCalled();
    expect(resolveLegacyTarget).toHaveBeenCalledTimes(1);
  });

  it('routes reaction mutation by profile and preserves unrelated payload fields', async () => {
    const publisherPrisma = createMutationPrisma();
    const majorPrisma = createMutationPrisma();
    const toggleReactions = jest.fn().mockReturnValue([{ emoji: 'heart', userIds: ['reactor-1'] }]);
    const majorTarget = jest.fn().mockResolvedValue({ row: baseRow, payload: baseRow.payload });

    const publisher = await toggleDialogCommentReactionForProfile({
      prisma: publisherPrisma,
      chatId: 'chat-1',
      messageId: 'comment-1',
      dialogProfile: 'publisher',
      userId: 'reactor-1',
      emoji: 'heart',
      resolvePublisherThreadId: () => 'thread-1',
      resolveLegacyTarget: jest.fn(),
      toggleReactions,
    });
    const major = await toggleDialogCommentReactionForProfile({
      prisma: majorPrisma,
      chatId: 'chat-1',
      messageId: 'comment-1',
      dialogProfile: 'moderation',
      userId: 'reactor-1',
      emoji: 'heart',
      resolvePublisherThreadId: jest.fn(),
      resolveLegacyTarget: majorTarget,
      toggleReactions,
    });

    expect(publisher?.payload).toEqual(
      expect.objectContaining({
        text: 'До правки',
        reactions: [{ emoji: 'heart', userIds: ['reactor-1'] }],
      }),
    );
    expect(major?.payload).toEqual(publisher?.payload);
    expect(publisherPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(majorPrisma.$transaction).not.toHaveBeenCalled();
    expect(majorTarget).toHaveBeenCalledTimes(1);
  });
});
