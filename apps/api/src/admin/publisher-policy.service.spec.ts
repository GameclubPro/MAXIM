import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { PublisherPolicyService } from './publisher-policy.service';

function createReadiness() {
  return {
    isRuntimeAvailable: jest.fn().mockResolvedValue(true),
    resolvePolicy: jest.fn(
      (
        row: {
          publikEnabled: boolean;
          suggestionsViaPublik: boolean;
          revision: number;
          updatedAt: Date;
        } | null,
      ) => ({
        publikEnabled: row?.publikEnabled ?? true,
        suggestionsViaPublik: row?.suggestionsViaPublik ?? false,
        revision: row?.revision ?? 0,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      }),
    ),
    resolveReadiness: jest.fn().mockReturnValue({
      state: 'setup_required',
      canPublish: false,
      canUseChatComments: false,
      canPublishSuggestions: false,
      blockerCode: 'bot_not_connected',
      checkedAt: null,
      retryAt: null,
    }),
  };
}

function createBotRegistry() {
  return {
    getPublisherBotDescriptor: () => ({ id: 'publik-bot' }),
    getActionableBots: () => [{ id: 'main-bot' }, { id: 'inactive-main-bot' }],
  };
}

const user = {
  userId: 'user-1',
  username: null,
  displayName: null,
};

function createPolicyMutationFixture(
  options: {
    storedEntityType?: ChatEntityType;
    publicationPolicy?: object | null;
  } = {},
) {
  const updatedAt = new Date('2026-08-26T10:00:00.000Z');
  const storedPolicy = {
    chatId: 'channel-1',
    publikEnabled: true,
    suggestionsViaPublik: true,
    revision: 1,
    updatedByUserId: user.userId,
    createdAt: updatedAt,
    updatedAt,
  };
  const tx = {
    managedEntityPublicationPolicy: {
      create: jest.fn().mockResolvedValue(storedPolicy),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(storedPolicy),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };
  const transaction = jest.fn(async (callback: (transactionClient: typeof tx) => unknown) =>
    callback(tx),
  );
  const prisma = {
    chat: {
      findUnique: jest.fn().mockResolvedValue({
        entityType: options.storedEntityType ?? ChatEntityType.CHANNEL,
        publicationPolicy: options.publicationPolicy ?? null,
      }),
    },
    $transaction: transaction,
  };
  const readiness = createReadiness();
  const managedEntities = {
    assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PublisherPolicyService(
    prisma as never,
    createBotRegistry() as never,
    readiness as never,
    managedEntities as never,
  );

  return { managedEntities, prisma, readiness, service, storedPolicy, transaction, tx };
}

describe('PublisherPolicyService', () => {
  it('lists deduplicated entities from active main-bot access edges only', async () => {
    const chat = {
      id: 'chat-1',
      title: 'Команда',
      entityType: ChatEntityType.CHAT,
      channelSettings: null,
      publicationPolicy: null,
      publisherBinding: null,
      botMemberships: [{ botId: 'main-bot' }],
    };
    const prisma = {
      managedEntityAccessEdge: {
        findMany: jest.fn().mockResolvedValue([
          { chatId: 'chat-1', botId: 'main-bot', chat },
          { chatId: 'chat-1', botId: 'main-bot', chat },
          {
            chatId: 'chat-2',
            botId: 'inactive-main-bot',
            chat: { ...chat, id: 'chat-2', botMemberships: [] },
          },
        ]),
      },
    };
    const readiness = createReadiness();
    const service = new PublisherPolicyService(
      prisma as never,
      createBotRegistry() as never,
      readiness as never,
      {} as never,
    );

    const response = await service.listEntities({
      userId: 'user-1',
      username: null,
      displayName: null,
    });

    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.id).toBe('chat-1');
    expect(prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          state: ManagedEntityAccessState.GRANTED,
          userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
          botId: { not: 'publik-bot' },
        }),
      }),
    );
    expect(readiness.resolveReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat-1' }),
      { runtimeAvailable: true },
    );
  });

  it('does not return an entity from another user-scoped access list', async () => {
    const foreignChat = {
      id: 'chat-foreign',
      title: 'Чужой чат',
      entityType: ChatEntityType.CHAT,
      channelSettings: null,
      publicationPolicy: null,
      publisherBinding: null,
      botMemberships: [{ botId: 'main-bot' }],
    };
    const findMany = jest
      .fn()
      .mockImplementation(({ where }: { where: { userId: string } }) =>
        Promise.resolve(
          where.userId === 'user-2'
            ? [{ chatId: foreignChat.id, botId: 'main-bot', chat: foreignChat }]
            : [],
        ),
      );
    const service = new PublisherPolicyService(
      { managedEntityAccessEdge: { findMany } } as never,
      createBotRegistry() as never,
      createReadiness() as never,
      {} as never,
    );

    await expect(
      service.getEntity('chat', foreignChat.id, {
        userId: 'user-1',
        username: null,
        displayName: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getEntity('chat', foreignChat.id, {
        userId: 'user-2',
        username: null,
        displayName: null,
      }),
    ).resolves.toMatchObject({ id: foreignChat.id });
    expect(findMany.mock.calls.map(([request]) => request.where.userId)).toEqual([
      'user-1',
      'user-2',
    ]);
  });

  it('does not start a Prisma mutation when live caller admin access is denied', async () => {
    const denied = new ForbiddenException('Caller is not a chat administrator');
    const assertManagedEntityAdminAccess = jest.fn().mockRejectedValue(denied);
    const findUnique = jest.fn();
    const transaction = jest.fn();
    const service = new PublisherPolicyService(
      {
        chat: { findUnique },
        $transaction: transaction,
      } as never,
      createBotRegistry() as never,
      createReadiness() as never,
      { assertManagedEntityAdminAccess } as never,
    );
    await expect(
      service.updatePolicy('chat', 'chat-foreign', user, {
        expectedRevision: 0,
        publikEnabled: false,
      }),
    ).rejects.toBe(denied);
    expect(assertManagedEntityAdminAccess).toHaveBeenCalledWith('chat-foreign', user, 'chat');
    expect(findUnique).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('creates a new channel policy enabled by default and audits only requested changes', async () => {
    const fixture = createPolicyMutationFixture();

    await expect(
      fixture.service.updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 0,
        suggestionsViaPublik: true,
      }),
    ).resolves.toEqual({
      publikEnabled: true,
      suggestionsViaPublik: true,
      revision: 1,
      updatedAt: '2026-08-26T10:00:00.000Z',
    });

    expect(fixture.managedEntities.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'channel-1',
      user,
      'channel',
    );
    expect(fixture.tx.managedEntityPublicationPolicy.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        publikEnabled: true,
        suggestionsViaPublik: true,
        updatedByUserId: user.userId,
      },
    });
    expect(fixture.tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        actorUserId: user.userId,
        action: 'UPDATE_PUBLICATION_POLICY',
        payload: {
          changed: { suggestionsViaPublik: true },
          revision: 1,
        },
      },
    });
    expect(fixture.readiness.resolvePolicy).toHaveBeenCalledWith(fixture.storedPolicy);
  });

  it('rejects enabling suggestions for a chat before access checks or database reads', async () => {
    const fixture = createPolicyMutationFixture({ storedEntityType: ChatEntityType.CHAT });

    await expect(
      fixture.service.updatePolicy('chat', 'chat-1', user, {
        expectedRevision: 0,
        suggestionsViaPublik: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.managedEntities.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(fixture.prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('rejects a route entity type that does not match the stored entity', async () => {
    const fixture = createPolicyMutationFixture({ storedEntityType: ChatEntityType.CHANNEL });

    await expect(
      fixture.service.updatePolicy('chat', 'channel-1', user, {
        expectedRevision: 0,
        publikEnabled: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.managedEntities.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'channel-1',
      user,
      'chat',
    );
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('returns a revision conflict without writing an audit row', async () => {
    const fixture = createPolicyMutationFixture({ publicationPolicy: { revision: 3 } });
    fixture.tx.managedEntityPublicationPolicy.updateMany.mockResolvedValue({ count: 0 });

    const operation = fixture.service.updatePolicy('channel', 'channel-1', user, {
      expectedRevision: 2,
      publikEnabled: false,
    });

    await expect(operation).rejects.toBeInstanceOf(ConflictException);
    await expect(operation).rejects.toMatchObject({
      response: {
        code: 'PUBLISHER_POLICY_REVISION_CONFLICT',
      },
    });
    expect(fixture.tx.managedEntityPublicationPolicy.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(fixture.tx.auditLog.create).not.toHaveBeenCalled();
    expect(fixture.readiness.resolvePolicy).not.toHaveBeenCalled();
  });

  it('keeps the audit append in the policy transaction and does not report an unaudited update', async () => {
    const fixture = createPolicyMutationFixture({ publicationPolicy: { revision: 1 } });
    const auditFailure = new Error('audit insert failed');
    fixture.tx.auditLog.create.mockRejectedValue(auditFailure);

    await expect(
      fixture.service.updatePolicy('channel', 'channel-1', user, {
        expectedRevision: 1,
        publikEnabled: false,
      }),
    ).rejects.toBe(auditFailure);

    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.tx.managedEntityPublicationPolicy.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'channel-1', revision: 1 },
      data: {
        publikEnabled: false,
        revision: { increment: 1 },
        updatedByUserId: user.userId,
      },
    });
    expect(fixture.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(fixture.readiness.resolvePolicy).not.toHaveBeenCalled();
  });
});
