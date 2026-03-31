import { ModerationService } from './moderation.service';

describe('ModerationService chat admin access lookups', () => {
  it('passes a bounded timeout to remote admin access reads', async () => {
    const maxClient = {
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'CHAT_ADMIN_LOOKUP_TIMEOUT_MS') {
          return 1500;
        }
        return undefined;
      }),
    };

    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      configService as never,
    );

    await (service as unknown as {
      loadRemoteChatAdminAccessBatch: (
        chatId: string,
        userIds: readonly string[],
      ) => Promise<Map<string, 'granted' | 'user_denied'>>;
    }).loadRemoteChatAdminAccessBatch('-100123', ['user-1']);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100123',
      ['user-1'],
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        timeoutMs: 1500,
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
  });
});
