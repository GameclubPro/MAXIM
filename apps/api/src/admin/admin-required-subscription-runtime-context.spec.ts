import { AdminRequiredSubscriptionRuntime } from './admin-required-subscription-runtime';
import {
  createAdminRequiredSubscriptionRuntimeContext,
  type AdminRequiredSubscriptionRuntimeContext,
} from './admin-required-subscription-runtime-context';

describe('required subscription capabilities', () => {
  it('preserves live dependency identity and method receivers without a legacy target', async () => {
    const target = {
      prefix: 'runtime',
      prisma: {} as never,
      maxClient: {} as never,
      chatContextCache: {} as never,
      logger: {} as never,
      maxBotLinkService: {} as never,
      maxBotRegistry: {} as never,
      normalizeRuntimeManagedEntityBotId: jest.fn(),
      resolveBotAssignment(chatId: string) {
        return Promise.resolve(`${this.prefix}:${chatId}`);
      },
      resolveCandidateBotIdsForChat: jest.fn().mockResolvedValue(['major-1']),
      refreshManagedEntityBotAccessSnapshots: jest.fn().mockResolvedValue(undefined),
    } satisfies AdminRequiredSubscriptionRuntimeContext & { prefix: string };
    const context = createAdminRequiredSubscriptionRuntimeContext(target);
    new AdminRequiredSubscriptionRuntime(context);
    expect(context.prisma).toBe(target.prisma);
    expect(context.maxClient).toBe(target.maxClient);
    const next = {} as never;
    target.maxClient = next;
    expect(context.maxClient).toBe(next);
    await expect(context.resolveBotAssignment('chat-1')).resolves.toBe('runtime:chat-1');
    await expect(
      context.resolveCandidateBotIdsForChat('chat-1', { includeDiscoveryFallback: true }),
    ).resolves.toEqual(['major-1']);
    expect(target.resolveCandidateBotIdsForChat).toHaveBeenCalledWith('chat-1', {
      includeDiscoveryFallback: true,
    });
    await context.refreshManagedEntityBotAccessSnapshots('chat-1', 'chat', 'settings');
    expect(target.refreshManagedEntityBotAccessSnapshots).toHaveBeenCalledWith(
      'chat-1',
      'chat',
      'settings',
    );
  });
});
