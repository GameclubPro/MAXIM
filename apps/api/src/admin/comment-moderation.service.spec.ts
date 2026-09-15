import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CommentModerationService } from './comment-moderation.service';
import {
  commentRestrictionKey,
  presentCommentRestriction,
  withCommentWrite,
  type CommentScope,
} from './comment-restriction-store';
import { extractSqlText } from './admin-service-test-support';

const user = { userId: 'admin', username: null, displayName: 'Администратор' };
const scope: CommentScope = { chatId: 'chat-1', entityType: 'chat', profile: 'publisher' };
const command = {
  token: 'signed-comment-token',
  action: 'MUTE',
  durationSeconds: 3600,
  expectedRevision: 0,
  sourceMessageId: 'message-1',
};
const row = {
  ...commentRestrictionKey(scope, 'reader'),
  displayName: 'Автор',
  kind: 'BAN',
  expiresAt: null,
  reason: 'Спам',
  revision: 1,
  updatedAt: new Date(),
};

function setup() {
  const prisma: any = {
    managedEntityAccessEdge: {
      findFirst: jest.fn().mockResolvedValue({ userId: 'admin' }),
      findMany: jest.fn().mockResolvedValue([
        {
          userId: 'admin',
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
          deniedReason: null,
          lastMaxStatusCode: null,
        },
        {
          userId: 'reader',
          state: 'USER_DENIED',
          userRole: 'MEMBER',
          botRole: 'ADMIN',
          deniedReason: 'publisher_user_not_admin',
          lastMaxStatusCode: null,
        },
      ]),
    },
    commentRestriction: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(async ({ create }: any) => ({ ...create, updatedAt: new Date() })),
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue({ payload: { authorDisplayName: 'Автор' } }),
      create: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  prisma.$transaction = jest.fn((run: any) => run(prisma));
  const entities = {
    assertChatAdminAccess: jest.fn(),
    assertChannelAdminAccess: jest.fn(),
    resolveManagedEntityReadBotId: jest.fn().mockResolvedValue('major'),
  };
  const publisher = { getEntity: jest.fn() };
  const remote = {
    getChatMembersAccess: jest.fn().mockResolvedValue(
      new Map([
        ['admin', { isAdmin: true }],
        ['reader', { isAdmin: false, isOwner: false }],
      ]),
    ),
  };
  const registry = {
    getPublisherBotDescriptor: jest.fn(() => ({ id: 'publik' })),
    isKnownBotUserId: jest.fn(() => false),
    getAdminVisibleBots: jest.fn(() => [{ id: 'major' }]),
  };
  const refresh = { enqueue: jest.fn() };
  const service = new CommentModerationService(
    prisma,
    entities as never,
    publisher as never,
    remote as never,
    registry as never,
    refresh as never,
  );
  return { prisma, entities, publisher, remote, registry, refresh, service };
}

describe('comment moderation', () => {
  it.each(['publisher', 'moderation'] as const)(
    'keeps %s scope, author and audit in one transaction',
    async (profile) => {
      const s = setup();
      const result = await s.service.update(
        { ...scope, profile },
        user,
        'reader',
        'thread-1',
        command,
      );
      expect(result).toMatchObject({ kind: 'MUTE', revision: 1, displayName: 'Автор' });
      expect(Date.parse(result.expiresAt!) - Date.now()).toBeGreaterThan(3590_000);
      expect(s.prisma.auditLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            chatId: 'chat-1',
            actorUserId: 'reader',
            action:
              profile === 'publisher' ? 'PUBLISHER_CHAT_DIALOG_COMMENT' : 'CHANNEL_DIALOG_COMMENT',
            payload: { path: ['threadId'], equals: 'thread-1' },
          }),
        }),
      );
      if (profile === 'publisher') expect(s.remote.getChatMembersAccess).not.toHaveBeenCalled();
      else
        expect(s.remote.getChatMembersAccess).toHaveBeenCalledWith(
          'chat-1',
          ['admin', 'reader'],
          expect.objectContaining({ botId: 'major', bypassCache: true }),
        );
      expect(s.prisma.commentRestriction.upsert.mock.calls[0][0].create.profile).toBe(profile);
      expect(s.prisma.auditLog.create.mock.calls[0][0].data.payload.revision).toBe(1);
      expect(s.prisma.$transaction).toHaveBeenCalledTimes(1);
      if (profile === 'publisher') expect(s.entities.assertChatAdminAccess).not.toHaveBeenCalled();
      else expect(s.publisher.getEntity).not.toHaveBeenCalled();
    },
  );

  it('rejects non-admins without remote calls or writes', async () => {
    const s = setup();
    s.publisher.getEntity.mockRejectedValue(
      new BadRequestException('Managed entity is unavailable'),
    );
    await expect(s.service.update(scope, user, 'reader', 'thread-1', command)).rejects.toThrow();
    expect(s.remote.getChatMembersAccess).not.toHaveBeenCalled();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(await s.service.state(scope, user)).toMatchObject({ canManage: false });
  });

  it.each(['self', 'admin', 'owner', 'bot', 'revoked', 'remote-error'])(
    'protects %s',
    async (mode) => {
      const s = setup();
      if (mode === 'bot') s.registry.isKnownBotUserId.mockReturnValue(true);
      if (mode === 'admin' || mode === 'owner')
        s.remote.getChatMembersAccess.mockResolvedValue(
          new Map([
            ['admin', { isAdmin: true }],
            ['reader', { isAdmin: mode === 'admin', isOwner: mode === 'owner' }],
          ]),
        );
      if (mode === 'revoked') s.remote.getChatMembersAccess.mockResolvedValue(new Map());
      if (mode === 'remote-error')
        s.remote.getChatMembersAccess.mockRejectedValue(new Error('MAX unavailable'));
      await expect(
        s.service.update(
          { ...scope, profile: 'moderation' },
          user,
          mode === 'self' ? 'admin' : 'reader',
          'thread-1',
          command,
        ),
      ).rejects.toThrow();
      expect(s.prisma.commentRestriction.upsert).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing/cross-thread/cross-profile source instead of trusting a target id', async () => {
    const s = setup();
    s.prisma.auditLog.findFirst.mockResolvedValue(null);
    await expect(s.service.update(scope, user, 'reader', 'other-thread', command)).rejects.toThrow(
      'Комментарий автора не найден',
    );
    await expect(
      s.service.update(scope, user, 'reader', 'thread-1', {
        ...command,
        sourceMessageId: undefined,
      }),
    ).rejects.toThrow('Автор комментария не найден');
    expect(s.prisma.commentRestriction.upsert).not.toHaveBeenCalled();
  });

  it('releases an existing restriction after the original message has disappeared', async () => {
    const s = setup();
    s.prisma.commentRestriction.findUnique.mockResolvedValue(row);
    const result = await s.service.update(scope, user, 'reader', 'another-thread', {
      token: command.token,
      action: 'RELEASE',
      expectedRevision: 1,
    });
    expect(result).toMatchObject({ kind: null, expiresAt: null, revision: 2, reason: '' });
    expect(s.prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it('rejects duplicate/stale commands without extending a mute', async () => {
    const s = setup();
    s.prisma.commentRestriction.findUnique.mockResolvedValue(row);
    await expect(s.service.update(scope, user, 'reader', 'thread-1', command)).rejects.toThrow(
      'Ограничение уже изменилось',
    );
    expect(s.prisma.commentRestriction.upsert).not.toHaveBeenCalled();
    expect(s.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('uses a scope-bound keyset page, retaining the extra row for the next cursor', async () => {
    const s = setup();
    s.prisma.commentRestriction.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({ ...row, userId: `user-${i}` })),
    );
    const page = await s.service.list(scope, user, 'after-user');
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe('user-49');
    expect(s.prisma.commentRestriction.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        profile: 'publisher',
        entityType: 'CHAT',
        chatId: 'chat-1',
        userId: { gt: 'after-user' },
      },
      take: 51,
      orderBy: { userId: 'asc' },
    });
  });

  it('refreshes unknown Publisher roles through its existing queue, never a shared-role token', async () => {
    const s = setup();
    s.prisma.managedEntityAccessEdge.findMany.mockResolvedValueOnce([]);
    await s.service.update(scope, user, 'reader', 'thread-1', command);
    expect(s.refresh.enqueue).toHaveBeenCalledTimes(2);
    expect(s.refresh.enqueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      publisherBotId: 'publik',
      candidateUserId: 'reader',
      reason: 'manual_recheck',
    });
    expect(s.remote.getChatMembersAccess).not.toHaveBeenCalled();
    expect(s.prisma.managedEntityAccessEdge.findMany.mock.calls[0][0].where).toMatchObject({
      botId: 'publik',
      entityType: 'CHAT',
      source: 'publisher_targeted_user_access',
      checkedAt: { gt: expect.any(Date) },
      expiresAt: { gt: expect.any(Date) },
    });
  });

  it.each(['ADMIN', 'OWNER'])(
    'protects Publisher %s even with a denied cabinet edge',
    async (userRole) => {
      const s = setup();
      s.prisma.managedEntityAccessEdge.findMany.mockResolvedValue([
        { userId: 'admin', state: 'GRANTED', userRole: 'ADMIN' },
        { userId: 'reader', state: 'USER_DENIED', userRole },
      ]);
      await expect(s.service.update(scope, user, 'reader', 'thread-1', command)).rejects.toThrow(
        'Владельцев, администраторов',
      );
      expect(s.prisma.commentRestriction.upsert).not.toHaveBeenCalled();
    },
  );

  it('keeps Major capability polling local instead of probing MAX for every reader', async () => {
    const s = setup();
    await s.service.state({ ...scope, profile: 'moderation' }, user);
    expect(s.entities.assertChatAdminAccess).not.toHaveBeenCalled();
    expect(s.remote.getChatMembersAccess).not.toHaveBeenCalled();
  });
});

describe('comment enforcement', () => {
  it.each(['BAN', 'MUTE'])('prevents any guarded write for %s', async (kind) => {
    const s = setup();
    s.prisma.commentRestriction.findUnique.mockResolvedValue({
      ...row,
      kind,
      expiresAt: kind === 'MUTE' ? new Date(Date.now() + 60_000) : null,
    });
    const write = jest.fn();
    await expect(withCommentWrite(s.prisma, scope, 'reader', write)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(write).not.toHaveBeenCalled();
    expect(extractSqlText(s.prisma.$executeRaw.mock.calls[0][0])).toContain(
      'pg_advisory_xact_lock',
    );
    expect(s.prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      s.prisma.commentRestriction.findUnique.mock.invocationCallOrder[0],
    );
  });
  it('expires precisely at the boundary and preserves the revision', () => {
    const now = new Date();
    expect(
      presentCommentRestriction({ ...row, kind: 'MUTE', expiresAt: now }, 'reader', now),
    ).toMatchObject({ kind: null, expiresAt: null, reason: '', revision: 1 });
  });
  it('lets an expired participant write and keeps keys profile/entity/community bound', async () => {
    const s = setup();
    s.prisma.commentRestriction.findUnique.mockResolvedValue({
      ...row,
      kind: 'MUTE',
      expiresAt: new Date(0),
    });
    const write = jest.fn().mockResolvedValue('saved');
    await expect(withCommentWrite(s.prisma, scope, 'reader', write)).resolves.toBe('saved');
    expect(write).toHaveBeenCalledWith(s.prisma);
    const keys = [
      scope,
      { ...scope, profile: 'moderation' as const },
      { ...scope, entityType: 'channel' as const },
      { ...scope, chatId: 'another' },
    ].map((value) => JSON.stringify(commentRestrictionKey(value, 'reader')));
    expect(new Set(keys).size).toBe(4);
  });
});
