import { chatSettingsSchema } from '@maxim/contracts';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { AdminRequiredSubscriptionRuntime } from './admin-required-subscription-runtime';
import { saveChatSettings } from './admin-chat-settings';
import { createPrismaMock, createChatContextCacheMock } from './admin-service-test-support';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { ManagedEntityActivationRequiredError } from '../max/managed-entity-activation.util';

function fixture() {
  const prisma = createPrismaMock();
  const cache = createChatContextCacheMock();
  const max = {
    getChannelSnapshotByLink: jest.fn(),
    getChatSnapshot: jest.fn(),
    getCurrentChatMemberAccess: jest.fn(),
  };
  const link = {
    recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    isChatBotActivationRequired: jest.fn().mockResolvedValue(false),
  };
  const runtime = new AdminRequiredSubscriptionRuntime({
    prisma,
    chatContextCache: cache,
    maxClient: max,
    maxBotLinkService: link,
    logger: { warn: jest.fn() },
    maxBotRegistry: {
      getDiscoveryBots: () => [{ id: 'a' }, { id: 'b' }],
      getBotById: (id: string) => (id ? { id } : null),
    },
    normalizeRuntimeManagedEntityBotId: (id: string) => id,
    resolveCandidateBotIdsForChat: async () => ['a', 'b'],
    resolveBotAssignment: async () => 'a',
  } as never);
  return { prisma, cache, max, link, runtime };
}

describe('required subscription configuration survives dependency failures', () => {
  it.each([429, 503, 'ETIMEDOUT', 'database unavailable'])(
    'rejects additions atomically on %s',
    async (failure) => {
      const { runtime } = fixture();
      const settings = chatSettingsSchema.parse({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['kept', 'new'],
      });
      const original = structuredClone(settings);
      const error = new ServiceUnavailableException(String(failure));
      jest.spyOn(runtime, 'resolveRequiredSubscriptionChannelById').mockRejectedValue(error);
      await expect(runtime.assertRequiredSubscriptionSettings(settings)).rejects.toBe(error);
      expect(settings).toEqual(original);
    },
  );

  it('saves an unrelated setting without probing saved targets or clearing an omitted selection', async () => {
    const { prisma, cache } = fixture();
    const current = {
      ...chatSettingsSchema.parse({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['kept'],
      }),
      updatedAt: new Date(),
    };
    prisma.chatSettings.findUnique.mockResolvedValue(current);
    const validate = jest.fn().mockRejectedValue(new Error('MAX unavailable'));
    const result = await saveChatSettings({
      prisma: prisma as never,
      chatContextCache: cache as never,
      chatId: 'chat-1',
      actorUserId: 'admin',
      source: 'miniapp',
      body: { linkBotMessageText: 'Changed', settingsRevision: current.updatedAt.toISOString() },
      resolveBotAssignmentData: () => ({}),
      assertRequiredSubscriptionSettings: validate,
      assertBotCapabilities: async () => {},
      refreshExecutionReadiness: async () => {},
    });
    expect(result.requiredSubscriptionChannelIds).toEqual(['kept']);
    expect(result.requiredSubscriptionEnabled).toBe(true);
    expect(validate).not.toHaveBeenCalled();
  });

  it('validates only added targets and leaves the entire saved policy untouched when an addition fails', async () => {
    const { prisma, cache } = fixture();
    const current = {
      ...chatSettingsSchema.parse({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['kept'],
      }),
      updatedAt: new Date(),
    };
    prisma.chatSettings.findUnique.mockResolvedValue(current);
    const validate = jest.fn().mockRejectedValue(new ServiceUnavailableException());
    await expect(
      saveChatSettings({
        prisma: prisma as never,
        chatContextCache: cache as never,
        chatId: 'chat-1',
        actorUserId: 'admin',
        source: 'miniapp',
        body: { ...current, requiredSubscriptionChannelIds: ['kept', 'new'] },
        resolveBotAssignmentData: () => ({}),
        assertRequiredSubscriptionSettings: validate,
        assertBotCapabilities: async () => {},
        refreshExecutionReadiness: async () => {},
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ requiredSubscriptionChannelIds: ['new'] }),
    );
    expect(prisma.chatSettings.updateMany).not.toHaveBeenCalled();
  });

  it('loads saved source metadata without MAX and retains unknown IDs', async () => {
    const { runtime, max, prisma } = fixture();
    prisma.managedBotChatCatalog.findMany.mockResolvedValue([
      { chatId: 'kept', title: 'Saved', entityType: 'CHANNEL', link: 'https://max.ru/saved' },
    ]);
    const result = await runtime.resolveRequiredSubscriptionChannelHeaders(['kept', 'unknown']);
    expect(result.map((row) => row.id)).toEqual(['kept', 'unknown']);
    expect(result[0].title).toBe('Saved');
    expect(max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(max.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('coalesces a public link lookup and preserves the successful peer affinity', async () => {
    const { runtime, max } = fixture();
    max.getChannelSnapshotByLink.mockImplementation(
      async (_slug: string, options: { botId: string }) => {
        if (options.botId === 'a')
          throw { response: { status: 403, data: { code: 'chat.denied' } } };
        return { chatId: 'target', title: 'Channel', entityType: 'channel' };
      },
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        runtime.resolveRequiredSubscriptionChannelByLink('https://max.ru/target'),
      ),
    );
    expect(max.getChannelSnapshotByLink).toHaveBeenCalledTimes(2);
    expect(results.every((row) => row.botId === 'b')).toBe(true);
  });

  it('does not report not-found after a mixed denial and outage', async () => {
    const { runtime, max } = fixture();
    max.getChannelSnapshotByLink
      .mockRejectedValueOnce({ response: { status: 403 } })
      .mockRejectedValueOnce({ response: { status: 503 } });
    await expect(
      runtime.resolveRequiredSubscriptionChannelByLink('https://max.ru/target'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('explains an explicit activation requirement without probing or granting access', async () => {
    const { runtime, max, link } = fixture();
    max.getCurrentChatMemberAccess.mockRejectedValue(new ManagedEntityActivationRequiredError());
    await expect(
      runtime.assertBotCanInspectRequiredSubscriptionChannel('target'),
    ).rejects.toMatchObject({ response: { code: 'REQUIRED_SUBSCRIPTION_ACTIVATION_REQUIRED' } });
    expect(link.recordBotAccessProbe).not.toHaveBeenCalled();
  });

  it('distinguishes a positive MAX role from missing activation through the real persistence policy', async () => {
    const { runtime, max, link } = fixture();
    max.getCurrentChatMemberAccess.mockResolvedValue({ isAdmin: true, isOwner: false });
    const realLink = Object.create(MaxBotLinkService.prototype);
    realLink.resolveOperationalBotId = (id: string) => id;
    realLink.runChatMembershipWriteWithDeadlockRetry = (work: () => Promise<unknown>) => work();
    realLink.prisma = {
      $transaction: (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: async () => [{ id: 'target', entityType: 'CHANNEL' }],
          chatBotMembership: { findUnique: async () => null },
        }),
    };
    link.recordBotAccessProbe.mockImplementation((params) => realLink.recordBotAccessProbe(params));
    link.isChatBotActivationRequired.mockResolvedValue(true);
    await expect(
      runtime.assertBotCanInspectRequiredSubscriptionChannel('target'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
