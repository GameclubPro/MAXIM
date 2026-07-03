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
  it('defaults MAX API calls to the current platform host', () => {
    const env = validateEnv(createValidEnv());

    expect(env.MAX_API_BASE_URL).toBe('https://platform-api2.max.ru');
  });

  it('requires APP_BASE_URL and MAX_WEBHOOK_BASE_URL to be origin-only URLs', () => {
    expect(() =>
      validateEnv(
        createValidEnv({
          APP_BASE_URL: 'https://major-maksimov.ru/app/',
        }),
      ),
    ).toThrow(/APP_BASE_URL must be an origin URL/u);

    expect(() =>
      validateEnv(
        createValidEnv({
          MAX_WEBHOOK_BASE_URL: 'https://major-maksimov.ru/app/',
        }),
      ),
    ).toThrow(/MAX_WEBHOOK_BASE_URL must be an origin URL/u);

    const env = validateEnv(
      createValidEnv({
        APP_BASE_URL: ' https://major-maksimov.ru/ ',
        MAX_WEBHOOK_BASE_URL: 'https://major-maksimov.ru',
      }),
    );

    expect(env.APP_BASE_URL).toBe('https://major-maksimov.ru/');
    expect(env.MAX_WEBHOOK_BASE_URL).toBe('https://major-maksimov.ru');
  });

  it('requires production public origins to use https on the default port', () => {
    const productionSecrets = {
      NODE_ENV: 'production',
      MAX_WEBHOOK_SECRET_PATH: 'prod-secret-path-1',
      MAX_WEBHOOK_HEADER_SECRET: 'prod-header-secret-1',
    };

    expect(() =>
      validateEnv(
        createValidEnv({
          ...productionSecrets,
          APP_BASE_URL: 'http://major-maksimov.ru',
        }),
      ),
    ).toThrow(/APP_BASE_URL must use public https on the default 443 port/u);

    expect(() =>
      validateEnv(
        createValidEnv({
          ...productionSecrets,
          MAX_WEBHOOK_BASE_URL: 'http://major-maksimov.ru',
        }),
      ),
    ).toThrow(/MAX_WEBHOOK_BASE_URL must use public https on the default 443 port/u);

    expect(() =>
      validateEnv(
        createValidEnv({
          ...productionSecrets,
          MAX_WEBHOOK_BASE_URL: 'https://major-maksimov.ru:8443',
        }),
      ),
    ).toThrow(/MAX_WEBHOOK_BASE_URL must use public https on the default 443 port/u);

    const env = validateEnv(
      createValidEnv({
        ...productionSecrets,
        APP_BASE_URL: 'https://major-maksimov.ru',
        MAX_WEBHOOK_BASE_URL: 'https://major-maksimov.ru',
      }),
    );

    expect(env.APP_BASE_URL).toBe('https://major-maksimov.ru');
    expect(env.MAX_WEBHOOK_BASE_URL).toBe('https://major-maksimov.ru');
  });

  it('parses string false values as false', () => {
    const env = validateEnv(
      createValidEnv({
        CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN: 'false',
        MAX_ACTION_DISPATCH_ENABLED: '0',
        BOT_OWNERSHIP_FOUNDATION_ENABLED: 'no',
        MODERATION_BACKGROUND_TASKS_ENABLED: 'off',
        CHANNEL_STATS_STARTUP_SYNC_ENABLED: 'false',
        BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED: '0',
      }),
    );

    expect(env.CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN).toBe(false);
    expect(env.MAX_ACTION_DISPATCH_ENABLED).toBe(false);
    expect(env.BOT_OWNERSHIP_FOUNDATION_ENABLED).toBe(false);
    expect(env.MODERATION_BACKGROUND_TASKS_ENABLED).toBe(false);
    expect(env.CHANNEL_STATS_STARTUP_SYNC_ENABLED).toBe(false);
    expect(env.BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED).toBe(false);
  });

  it('validates optional Prisma pool caps', () => {
    const env = validateEnv(
      createValidEnv({
        PRISMA_PG_POOL_MAX: '4',
        PRISMA_PG_POOL_IDLE_TIMEOUT_MS: '10000',
        PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS: '5000',
        PRISMA_PG_POOL_MAX_LIFETIME_SEC: '300',
        MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX: '2',
      }),
    );

    expect(env.PRISMA_PG_POOL_MAX).toBe(4);
    expect(env.PRISMA_PG_POOL_IDLE_TIMEOUT_MS).toBe(10000);
    expect(env.PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS).toBe(5000);
    expect(env.PRISMA_PG_POOL_MAX_LIFETIME_SEC).toBe(300);
    expect(env.MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX).toBe(2);

    expect(() => validateEnv(createValidEnv({ PRISMA_PG_POOL_MAX: '0' }))).toThrow(
      /PRISMA_PG_POOL_MAX/u,
    );
  });

  it('parses string true values as true', () => {
    const env = validateEnv(
      createValidEnv({
        CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN: 'true',
        MAX_ACTION_DISPATCH_ENABLED: '1',
        BOT_OWNERSHIP_FOUNDATION_ENABLED: 'yes',
        MODERATION_BACKGROUND_TASKS_ENABLED: 'on',
        CHANNEL_STATS_STARTUP_SYNC_ENABLED: 'true',
        BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED: 'yes',
      }),
    );

    expect(env.CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN).toBe(true);
    expect(env.MAX_ACTION_DISPATCH_ENABLED).toBe(true);
    expect(env.BOT_OWNERSHIP_FOUNDATION_ENABLED).toBe(true);
    expect(env.MODERATION_BACKGROUND_TASKS_ENABLED).toBe(true);
    expect(env.CHANNEL_STATS_STARTUP_SYNC_ENABLED).toBe(true);
    expect(env.BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED).toBe(true);
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
    expect(env.BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED).toBe(false);
  });

  it('requires Karavan integration settings when storefront relay is enabled', () => {
    expect(() =>
      validateEnv(
        createValidEnv({
          KARAVAN_STOREFRONT_RELAY_ENABLED: 'true',
        }),
      ),
    ).toThrow(/KARAVAN_STOREFRONT_RELAY_ENABLED requires KARAVAN_API_BASE_URL, KARAVAN_INTEGRATION_TOKEN/u);

    const env = validateEnv(
      createValidEnv({
        KARAVAN_STOREFRONT_RELAY_ENABLED: 'true',
        KARAVAN_API_BASE_URL: 'https://api2.major-maksimov.ru/karavan/api',
        KARAVAN_INTEGRATION_TOKEN: 'test-karavan-token-123',
      }),
    );

    expect(env.KARAVAN_STOREFRONT_RELAY_ENABLED).toBe(true);
  });
});
