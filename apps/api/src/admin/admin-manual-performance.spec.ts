import { AdminService } from './admin.service';
import {
  createChatContextCacheMock,
  createConfigMock,
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
});
