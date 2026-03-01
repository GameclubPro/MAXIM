import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';

function createAuthUser(): AuthUser {
  return {
    userId: 'admin-1',
    username: 'admin',
    displayName: 'Admin',
    chatId: 'chat-1',
    chatTitle: 'Chat 1',
  };
}

function createMocks() {
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Chat 1',
        createdAt: new Date(),
      }),
      update: jest.fn(),
    },
    chatAdminAllowlist: {
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    chatCommercialAllowlist: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    chatCommercialStoplist: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
  };

  const maxClient = {
    getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    listBotChats: jest.fn(),
    getChatTitle: jest.fn(),
  };

  return { prisma, maxClient };
}

describe('AdminService commercial lists', () => {
  it('adds normalized phrase to commercial allowlist', async () => {
    const { prisma, maxClient } = createMocks();
    const service = new AdminService(prisma as never, maxClient as never);

    await service.addCommercialAllowlist('chat-1', createAuthUser(), {
      phrase: '  Партнерская   интеграция  ',
    });

    expect(prisma.chatCommercialAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_phrase: {
          chatId: 'chat-1',
          phrase: 'партнерская интеграция',
        },
      },
      create: {
        chatId: 'chat-1',
        phrase: 'партнерская интеграция',
      },
      update: {},
    });
  });

  it('removes normalized phrase from commercial stoplist', async () => {
    const { prisma, maxClient } = createMocks();
    const service = new AdminService(prisma as never, maxClient as never);

    await service.removeCommercialStoplist('chat-1', createAuthUser(), '  Срочно   продам ');

    expect(prisma.chatCommercialStoplist.delete).toHaveBeenCalledWith({
      where: {
        chatId_phrase: {
          chatId: 'chat-1',
          phrase: 'срочно продам',
        },
      },
    });
  });

  it('returns allowlist phrases sorted from storage', async () => {
    const { prisma, maxClient } = createMocks();
    prisma.chatCommercialAllowlist.findMany.mockResolvedValueOnce([
      { phrase: 'alpha' },
      { phrase: 'beta' },
    ]);
    const service = new AdminService(prisma as never, maxClient as never);

    const result = await service.getCommercialAllowlist('chat-1', createAuthUser());

    expect(result).toEqual(['alpha', 'beta']);
  });
});
