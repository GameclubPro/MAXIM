import { createAdminDomainAllowlistRuntimeContext } from './admin-domain-allowlist-runtime-context';

describe('AdminDomainAllowlistRuntimeContext', () => {
  it('exposes prisma and chat context cache through typed accessors', () => {
    const target = {
      prisma: { domainAllowlist: {} },
      chatContextCache: { invalidate: jest.fn() },
      assertChatAdmin: jest.fn(),
    };
    const context = createAdminDomainAllowlistRuntimeContext(target);

    expect(context.prisma).toBe(target.prisma);
    expect(context.chatContextCache).toBe(target.chatContextCache);
  });

  it('delegates admin access checks without losing the legacy target context', async () => {
    const target = {
      prefix: 'legacy',
      calls: [] as string[],
      prisma: { domainAllowlist: {} },
      chatContextCache: { invalidate: jest.fn() },
      async assertChatAdmin(chatId: string, userId: string, entityType?: string): Promise<void> {
        this.calls.push(`${this.prefix}:${chatId}:${userId}:${entityType ?? 'default'}`);
      },
    };
    const context = createAdminDomainAllowlistRuntimeContext(target);

    await context.assertChatAdmin('chat-1', 'user-1', 'chat');

    expect(target.calls).toEqual(['legacy:chat-1:user-1:chat']);
  });
});
