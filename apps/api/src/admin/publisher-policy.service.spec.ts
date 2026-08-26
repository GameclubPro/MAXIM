import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { PublisherPolicyService } from './publisher-policy.service';

function createReadiness() {
  return {
    isRuntimeAvailable: jest.fn().mockResolvedValue(true),
    resolvePolicy: jest.fn().mockReturnValue({
      publikEnabled: true,
      suggestionsViaPublik: false,
      revision: 0,
      updatedAt: null,
    }),
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
    const findMany = jest.fn().mockImplementation(({ where }: { where: { userId: string } }) =>
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
    const user = { userId: 'user-1', username: null, displayName: null };

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
});
