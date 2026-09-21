import { ConfigService } from '@nestjs/config';
import { AdminMessageRetentionService } from './admin-message-retention.service';

const user = { userId: 'u1', username: null, displayName: null, launchBotId: 'major' };
function setup() {
  const policy = {
    chatId: '-1',
    enabled: false,
    hours: 48,
    revision: 0,
    activationId: 'old',
    enabledAt: null,
    captureAfter: null,
    pausedAt: null,
    pendingCount: 0,
    deletedCount: 0,
    skippedCount: 0,
    lastStatus: 'off',
  };
  const prisma = {
    chat: { findUnique: jest.fn().mockResolvedValue({ entityType: 'CHAT' }) },
    messageRetentionPolicy: {
      createMany: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue(policy),
      findUnique: jest.fn().mockResolvedValue(policy),
      update: jest.fn(),
    },
    messageRetentionCandidate: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work(prisma));
  const access = { assertChatAdminAccess: jest.fn() };
  const capabilities = { assertChatSettingsBotCapabilities: jest.fn() };
  const store = { allows: jest.fn().mockReturnValue(true), mode: 'on' };
  const service = new AdminMessageRetentionService(
    prisma as never,
    access as never,
    capabilities as never,
    store as never,
    new ConfigService({ MAX_PUBLISHER_BOT_ID: 'publisher' }),
  );
  return { service, prisma, access, capabilities, store, policy };
}

describe('chat retention settings boundary', () => {
  it('rejects malformed identifiers before access lookups or database reads', async () => {
    const { service, prisma, access } = setup();
    await expect(service.read('not-a-chat', user)).rejects.toMatchObject({ status: 400 });
    expect(access.assertChatAdminAccess).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });
  it('authorizes every read without scanning message history', async () => {
    const { service, access } = setup();
    await expect(service.read('-1', user)).resolves.toMatchObject({
      enabled: false,
      hours: 48,
      status: 'off',
      pendingCount: 0,
    });
    expect(access.assertChatAdminAccess).toHaveBeenCalledWith('-1', user);
  });
  it('rejects Publisher credentials and non-group entities', async () => {
    const { service, prisma, access } = setup();
    await expect(service.read('-1', { ...user, launchBotId: 'publisher' })).rejects.toMatchObject({
      status: 403,
    });
    expect(access.assertChatAdminAccess).not.toHaveBeenCalled();
    prisma.chat.findUnique.mockResolvedValue({ entityType: 'CHANNEL' });
    await expect(service.read('-1', user)).rejects.toMatchObject({ status: 400 });
  });
  it('does not enable an operator-disabled module', async () => {
    const { service, prisma, store } = setup();
    store.allows.mockReturnValue(false);
    await expect(
      service.update('-1', user, { enabled: true, hours: 24, expectedRevision: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('checks delete capability, creates a new baseline, and audits only the requested policy', async () => {
    const { service, prisma, capabilities } = setup();
    await service.update('-1', user, { enabled: true, hours: 24, expectedRevision: 0 });
    expect(capabilities.assertChatSettingsBotCapabilities).toHaveBeenCalled();
    expect(prisma.messageRetentionPolicy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          enabled: true,
          hours: 24,
          enabledAt: expect.any(Date),
          captureAfter: expect.any(Date),
          revision: { increment: 1 },
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: { enabled: true, hours: 24, revision: 1 } }),
      }),
    );
  });
  it('rejects stale revisions and forged history controls without a policy update', async () => {
    const { service, prisma } = setup();
    await expect(
      service.update('-1', user, { enabled: true, hours: 24, expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.update('-1', user, {
        enabled: true,
        hours: 24,
        expectedRevision: 0,
        includeHistory: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.messageRetentionPolicy.update).not.toHaveBeenCalled();
  });
  it('changing hours preserves activation, while disabling invalidates it', async () => {
    const { service, prisma, policy } = setup();
    policy.enabled = true;
    await service.update('-1', user, { enabled: true, hours: 24, expectedRevision: 0 });
    expect(prisma.messageRetentionPolicy.update.mock.calls[0][0].data.activationId).toBeUndefined();
    await service.update('-1', user, { enabled: false, hours: 24, expectedRevision: 0 });
    expect(prisma.messageRetentionPolicy.update.mock.calls[1][0].data).toMatchObject({
      enabled: false,
      captureAfter: null,
    });
    expect(prisma.messageRetentionPolicy.update.mock.calls[1][0].data.activationId).not.toBe('old');
  });
});
