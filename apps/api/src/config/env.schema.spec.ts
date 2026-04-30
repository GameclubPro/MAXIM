import { validateEnv } from './env.schema';

function createValidEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_BASE_URL: 'https://example.com',
    MAX_BOT_ID: 'test-bot',
    MAX_BOT_TOKEN: 'test-token-123',
    MAX_WEBHOOK_SECRET_PATH: 'test-secret-path',
    MAX_WEBHOOK_HEADER_SECRET: 'test-header-secret',
    DATABASE_URL: 'postgresql://maxim:maxim@localhost:5432/maxim',
    REDIS_URL: 'redis://localhost:6379',
    ...overrides,
  };
}

describe('validateEnv boolean parsing', () => {
  it('parses string false values as false', () => {
    const env = validateEnv(
      createValidEnv({
        CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN: 'false',
        MAX_ACTION_DISPATCH_ENABLED: '0',
        BOT_OWNERSHIP_FOUNDATION_ENABLED: 'no',
        MODERATION_BACKGROUND_TASKS_ENABLED: 'off',
        CHANNEL_STATS_STARTUP_SYNC_ENABLED: 'false',
      }),
    );

    expect(env.CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN).toBe(false);
    expect(env.MAX_ACTION_DISPATCH_ENABLED).toBe(false);
    expect(env.BOT_OWNERSHIP_FOUNDATION_ENABLED).toBe(false);
    expect(env.MODERATION_BACKGROUND_TASKS_ENABLED).toBe(false);
    expect(env.CHANNEL_STATS_STARTUP_SYNC_ENABLED).toBe(false);
  });

  it('parses string true values as true', () => {
    const env = validateEnv(
      createValidEnv({
        CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN: 'true',
        MAX_ACTION_DISPATCH_ENABLED: '1',
        BOT_OWNERSHIP_FOUNDATION_ENABLED: 'yes',
        MODERATION_BACKGROUND_TASKS_ENABLED: 'on',
        CHANNEL_STATS_STARTUP_SYNC_ENABLED: 'true',
      }),
    );

    expect(env.CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN).toBe(true);
    expect(env.MAX_ACTION_DISPATCH_ENABLED).toBe(true);
    expect(env.BOT_OWNERSHIP_FOUNDATION_ENABLED).toBe(true);
    expect(env.MODERATION_BACKGROUND_TASKS_ENABLED).toBe(true);
    expect(env.CHANNEL_STATS_STARTUP_SYNC_ENABLED).toBe(true);
  });

  it('keeps defaults for missing and empty string values', () => {
    const env = validateEnv(
      createValidEnv({
        MODERATION_BACKGROUND_TASKS_ENABLED: '',
        CHANNEL_STATS_STARTUP_SYNC_ENABLED: '',
      }),
    );

    expect(env.MODERATION_BACKGROUND_TASKS_ENABLED).toBe(true);
    expect(env.CHANNEL_STATS_STARTUP_SYNC_ENABLED).toBe(false);
  });
});
