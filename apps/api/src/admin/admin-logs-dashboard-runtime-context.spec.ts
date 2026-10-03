import { AdminLogsDashboardRuntime } from './admin-logs-dashboard-runtime';
import { createAdminLogsDashboardRuntimeContext } from './admin-logs-dashboard-runtime-context';

describe('AdminLogsDashboardRuntimeContext', () => {
  it('preserves live dependency identity and method receivers without legacy properties', async () => {
    const target = {
      prefix: 'runtime',
      calls: [] as string[],
      prisma: {} as never,
      logger: {} as never,
      chatContextCache: {} as never,
      assertChatAdmin: jest.fn(),
      assertReadOnlyChatAdmin: jest.fn(),
      buildProfileMentionHandoffUrl: jest.fn(),
      resolveUserProfiles: jest.fn(),
      ensureEntityType(chatId: string, userId: string, entityType: string) {
        this.calls.push(`${this.prefix}:${chatId}:${userId}:${entityType}`);
        return Promise.resolve(undefined);
      },
    };
    const context = createAdminLogsDashboardRuntimeContext(target);
    new AdminLogsDashboardRuntime(context);
    expect(context.prisma).toBe(target.prisma);
    const replacement = {} as never;
    target.prisma = replacement;
    expect(context.prisma).toBe(replacement);
    await context.ensureEntityType('chat-1', 'user-1', 'chat');
    expect(target.calls).toEqual(['runtime:chat-1:user-1:chat']);
  });
});
