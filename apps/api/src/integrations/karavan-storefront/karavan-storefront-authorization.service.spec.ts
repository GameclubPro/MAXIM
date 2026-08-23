import { KaravanStorefrontAuthorizationService } from './karavan-storefront-authorization.service';

describe('KaravanStorefrontAuthorizationService', () => {
  it('allows every sender when admin-only mode is disabled', async () => {
    const allowlist = { isActive: jest.fn() };
    const moderationAccess = { resolveSenderChatAdminCheck: jest.fn() };
    const service = new KaravanStorefrontAuthorizationService(
      allowlist as never,
      moderationAccess as never,
    );

    await expect(
      service.canPublish({ chatId: 'chat-1', actorUserId: 'user-1', adminsOnly: false }),
    ).resolves.toBe(true);
    expect(allowlist.isActive).not.toHaveBeenCalled();
    expect(moderationAccess.resolveSenderChatAdminCheck).not.toHaveBeenCalled();
  });

  it('uses an active allowlist entry before probing MAX admin access', async () => {
    const allowlist = { isActive: jest.fn().mockResolvedValue(true) };
    const moderationAccess = { resolveSenderChatAdminCheck: jest.fn() };
    const service = new KaravanStorefrontAuthorizationService(
      allowlist as never,
      moderationAccess as never,
    );

    await expect(
      service.canPublish({ chatId: 'chat-1', actorUserId: 'user-1', adminsOnly: true }),
    ).resolves.toBe(true);
    expect(moderationAccess.resolveSenderChatAdminCheck).not.toHaveBeenCalled();
  });

  it('fails closed when admin access is unknown or the shared checker is unavailable', async () => {
    const allowlist = { isActive: jest.fn().mockResolvedValue(false) };
    const unknownAccess = {
      resolveSenderChatAdminCheck: jest.fn().mockResolvedValue({
        isAdmin: false,
        source: 'local_fallback',
      }),
    };
    const service = new KaravanStorefrontAuthorizationService(
      allowlist as never,
      unknownAccess as never,
    );

    await expect(
      service.canPublish({ chatId: 'chat-1', actorUserId: 'user-1', adminsOnly: true }),
    ).resolves.toBe(false);

    const unavailable = new KaravanStorefrontAuthorizationService(allowlist as never);
    await expect(
      unavailable.canPublish({ chatId: 'chat-1', actorUserId: 'user-1', adminsOnly: true }),
    ).resolves.toBe(false);
  });

  it('does not treat a positive local-fallback result as a confirmed admin', async () => {
    const allowlist = { isActive: jest.fn().mockResolvedValue(false) };
    const moderationAccess = {
      resolveSenderChatAdminCheck: jest.fn().mockResolvedValue({
        isAdmin: true,
        source: 'local_fallback',
      }),
    };
    const service = new KaravanStorefrontAuthorizationService(
      allowlist as never,
      moderationAccess as never,
    );

    await expect(
      service.canPublish({ chatId: 'chat-1', actorUserId: 'user-1', adminsOnly: true }),
    ).resolves.toBe(false);
  });

  it('accepts a confirmed targeted remote admin result', async () => {
    const allowlist = { isActive: jest.fn().mockResolvedValue(false) };
    const moderationAccess = {
      resolveSenderChatAdminCheck: jest.fn().mockResolvedValue({
        isAdmin: true,
        source: 'remote',
      }),
    };
    const service = new KaravanStorefrontAuthorizationService(
      allowlist as never,
      moderationAccess as never,
    );

    await expect(
      service.canPublish({ chatId: 'chat-1', actorUserId: 'user-1', adminsOnly: true }),
    ).resolves.toBe(true);
    expect(moderationAccess.resolveSenderChatAdminCheck).toHaveBeenCalledWith(
      'chat-1',
      undefined,
      'user-1',
      expect.objectContaining({
        allowRemoteLookup: true,
        remoteLookupSoftTimeoutMs: 350,
      }),
    );
  });
});
