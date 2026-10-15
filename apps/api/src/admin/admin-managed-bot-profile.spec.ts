import { AdminService } from './admin.service';
import {
  createAssignedBotFixture,
  createManagedEntityHeaderFixture,
  createPrismaMock,
  createConfigMock,
  createChatContextCacheMock,
} from './admin-service-test-support';

describe('Managed bot profiles with historical assignments', () => {
  it.each(['saved', 'cached', 'missing'] as const)(
    'preserves an unconfigured bot assignment with a %s avatar without a MAX lookup',
    async (avatarSource) => {
      const prisma = createPrismaMock();
      const botId = 'historical-bot';
      const avatarUrl = 'https://cdn.example/historical-bot.jpg';
      prisma.chat.findMany.mockResolvedValue([
        {
          id: 'chat-1',
          botId,
          primaryBotId: botId,
          botMemberships: [
            {
              botId,
              role: 'PRIMARY',
              status: 'ACTIVE',
              capabilities: [],
              permissionsSnapshot: null,
            },
          ],
        },
      ]);
      const maxClient = { getOwnProfile: jest.fn() };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntityBotProfile: jest
          .fn()
          .mockResolvedValue(avatarSource === 'cached' ? { avatarUrl } : null),
      });
      const service = new AdminService(
        prisma as never,
        maxClient as never,
        chatContextCache as never,
        createConfigMock({ botId: 'configured-bot' }) as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          getAllBots: jest.fn().mockReturnValue([{ id: 'configured-bot', state: 'active' }]),
          getBotById: jest.fn((id) => (id === 'configured-bot' ? { id } : null)),
        } as never,
      );
      const result = await (service as any).attachManagedEntityHeaderBotAssignments(
        createManagedEntityHeaderFixture({
          id: 'chat-1',
          title: 'Test group',
          entityType: 'chat',
          primaryBotId: botId,
          assignedBots: [
            createAssignedBotFixture({
              botId,
              role: 'primary',
              avatarUrl: avatarSource === 'saved' ? avatarUrl : null,
            }),
          ],
        }),
      );

      expect((service as any).isManagedEntityRuntimeBotId(botId)).toBe(true);
      expect(result.primaryBotId).toBe(botId);
      expect(result.assignedBots).toEqual([
        expect.objectContaining({
          botId,
          role: 'primary',
          membershipStatus: 'active',
          avatarUrl: avatarSource === 'missing' ? null : avatarUrl,
        }),
      ]);
      expect(maxClient.getOwnProfile).not.toHaveBeenCalled();
      expect(chatContextCache.setManagedEntityBotProfile).not.toHaveBeenCalled();
      expect(prisma.chat.update).not.toHaveBeenCalled();
    },
  );
});
