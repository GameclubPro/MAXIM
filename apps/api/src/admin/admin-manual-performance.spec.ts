import { AdminService } from './admin.service';
import {
  createChatContextCacheMock,
  createConfigMock,
  createDeferred,
  createPrismaMock,
} from './admin-service-test-support';

describe('AdminService manual moderation performance paths', () => {
  it('releases a mute without resolving a MAX route or remote target profile', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([
      { user_id: 'user-2', sender_name: 'Local participant' },
    ]);
    const maxClient = {
      getChatAdminIds: jest.fn(),
      getCurrentChatMemberAccess: jest.fn(),
      getChatMemberProfiles: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-2',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'UNMUTE' },
      'miniapp',
      { actorAlreadyVerified: true },
    );

    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ruleCode: 'MANUAL_UNMUTE',
          metadata: expect.objectContaining({ targetDisplayName: 'Local participant' }),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: true, action: 'UNMUTE', userId: 'user-2' }),
    );
  });

  it('does not revive a bot removed while a positive manual-action probe is delayed', async () => {
    const prisma = createPrismaMock();
    const lookupStarted = createDeferred<void>();
    const delayedAccess = createDeferred<{
      userId: string;
      isAdmin: boolean;
      isOwner: boolean;
      permissions: string[];
    }>();
    let removedAt: Date | null = null;
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockImplementation(async () => {
        lookupStarted.resolve();
        return delayedAccess.promise;
      }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockImplementation(async () => ({
        purpose: 'read',
        chatId: 'chat-1',
        primaryBotId: removedAt ? null : 'bot-1',
        botId: removedAt ? null : 'bot-1',
        candidateBotIds: removedAt ? [] : ['bot-1'],
        reason: removedAt ? null : 'primary_confirmed',
      })),
      recordBotAccessProbe: jest
        .fn()
        .mockImplementation(
          async ({ checkedAt }: { checkedAt: Date }) => !removedAt || checkedAt > removedAt,
        ),
      bindChatToBot: jest.fn(),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotRegistry as never,
    );

    const resolution = (service as any).resolveManualActionBotAssignment('chat-1');
    await lookupStarted.promise;
    removedAt = new Date(Date.now() + 1_000);
    delayedAccess.resolve({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    });

    await expect(resolution).resolves.toBeUndefined();
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        source: 'admin_manual_action_persisted',
        checkedAt: expect.any(Date),
        allowMembershipRecovery: true,
      }),
    );
    const checkedAt = maxBotLinkService.recordBotAccessProbe.mock.calls[0][0].checkedAt as Date;
    expect(checkedAt.getTime()).toBeLessThan(removedAt.getTime());
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
  });
});
