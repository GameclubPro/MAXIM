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
  it('retains the server-side Safety Desk access code', () => {
    expect(
      validateEnv(createValidEnv({ ADMIN_ACCESS_CODE: 'server-admin-code' })).ADMIN_ACCESS_CODE,
    ).toBe('server-admin-code');
    expect(validateEnv(createValidEnv({ ADMIN_ACCESS_CODE: 'abc123' })).ADMIN_ACCESS_CODE).toBe(
      'abc123',
    );
    expect(() => validateEnv(createValidEnv({ ADMIN_ACCESS_CODE: 'short' }))).toThrow(
      /ADMIN_ACCESS_CODE/u,
    );
    expect(() =>
      validateEnv(createValidEnv({ ADMIN_ACCESS_CODE: 'replace-with-random-admin-code' })),
    ).toThrow(/ADMIN_ACCESS_CODE/u);
    expect(() =>
      validateEnv(
        createValidEnv({
          NODE_ENV: 'production',
          MAX_WEBHOOK_SECRET_PATH: 'prod-secret-path-1',
          MAX_WEBHOOK_HEADER_SECRET: 'prod-header-secret-1',
        }),
      ),
    ).toThrow(/ADMIN_ACCESS_CODE is required in production/u);
  });

  it('defaults durable webhook ingress persistence target to two seconds', () => {
    expect(validateEnv(createValidEnv()).SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS).toBe(2_000);
    expect(
      validateEnv(createValidEnv({ SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS: '1500' }))
        .SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS,
    ).toBe(1_500);
    expect(() =>
      validateEnv(createValidEnv({ SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS: '0' })),
    ).toThrow(/SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS/u);
  });

  it('defaults canonical webhook execution to shadow with a one-percent canary', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.WEBHOOK_CANONICAL_EXECUTION_MODE).toBe('shadow');
    expect(defaults.WEBHOOK_CANONICAL_EXECUTION_CANARY_PERCENT).toBe(1);
    expect(defaults.WEBHOOK_CANONICAL_EXECUTION_CANARY_ENTITY_IDS).toBe('');

    const canary = validateEnv(
      createValidEnv({
        WEBHOOK_CANONICAL_EXECUTION_MODE: 'canary',
        WEBHOOK_CANONICAL_EXECUTION_CANARY_PERCENT: '7.5',
        WEBHOOK_CANONICAL_EXECUTION_CANARY_ENTITY_IDS: 'chat-1',
      }),
    );
    expect(canary.WEBHOOK_CANONICAL_EXECUTION_MODE).toBe('canary');
    expect(canary.WEBHOOK_CANONICAL_EXECUTION_CANARY_PERCENT).toBe(7.5);
    expect(canary.WEBHOOK_CANONICAL_EXECUTION_CANARY_ENTITY_IDS).toBe('chat-1');
    expect(() =>
      validateEnv(createValidEnv({ WEBHOOK_CANONICAL_EXECUTION_CANARY_PERCENT: '101' })),
    ).toThrow(/WEBHOOK_CANONICAL_EXECUTION_CANARY_PERCENT/u);
  });

  it('defaults extended webhook lifecycle handling to non-mutating shadow mode', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE).toBe('shadow');
    expect(defaults.MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_PERCENT).toBe(1);
    expect(defaults.MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_ENTITY_IDS).toBe('');

    const canary = validateEnv(
      createValidEnv({
        MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE: 'canary',
        MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_PERCENT: '5',
      }),
    );
    expect(canary.MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE).toBe('canary');
    expect(canary.MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_PERCENT).toBe(5);
  });

  it('defaults MAX API calls to the current platform host', () => {
    const env = validateEnv(createValidEnv());

    expect(env.MAX_API_BASE_URL).toBe('https://platform-api2.max.ru');
  });

  it('caps managed refresh pressure at two requests per second by default', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.MAX_API_MANAGED_REFRESH_RPS).toBe(2);
    expect(defaults.MAX_API_MANAGED_REFRESH_STACK_RPS).toBe(2);

    const configured = validateEnv(
      createValidEnv({
        MAX_API_MANAGED_REFRESH_RPS: '1',
        MAX_API_MANAGED_REFRESH_STACK_RPS: '0',
      }),
    );
    expect(configured.MAX_API_MANAGED_REFRESH_RPS).toBe(1);
    expect(configured.MAX_API_MANAGED_REFRESH_STACK_RPS).toBe(0);
  });

  it('enables resumable MAX video uploads by default with an explicit rollback flag', () => {
    expect(validateEnv(createValidEnv()).MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED).toBe(true);
    expect(
      validateEnv(createValidEnv({ MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: 'true' }))
        .MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED,
    ).toBe(true);
    expect(
      validateEnv(createValidEnv({ MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: 'false' }))
        .MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED,
    ).toBe(false);
  });

  it('retains local display-name snapshots beyond the moderation history window', () => {
    expect(validateEnv(createValidEnv()).USER_DISPLAY_NAME_RETENTION_DAYS).toBe(180);
    expect(
      validateEnv(createValidEnv({ USER_DISPLAY_NAME_RETENTION_DAYS: '365' }))
        .USER_DISPLAY_NAME_RETENTION_DAYS,
    ).toBe(365);
    expect(() => validateEnv(createValidEnv({ USER_DISPLAY_NAME_RETENTION_DAYS: '89' }))).toThrow(
      /USER_DISPLAY_NAME_RETENTION_DAYS/u,
    );
  });

  it('validates shared MAX API circuit timing', () => {
    expect(validateEnv(createValidEnv()).MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC).toBe(60);
    expect(
      validateEnv(
        createValidEnv({
          MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC: '45',
        }),
      ).MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC,
    ).toBe(45);
    expect(() => validateEnv(createValidEnv({ MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC: '0' }))).toThrow(
      /MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC/u,
    );
  });

  it('defaults routed mutation failover to shadow with a one-percent canary', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.MAX_ROUTED_MUTATIONS_MODE).toBe('shadow');
    expect(defaults.MAX_ROUTED_MUTATIONS_CANARY_PERCENT).toBe(1);
    expect(defaults.MAX_ROUTED_MUTATIONS_CANARY_ENTITY_IDS).toBe('');
    expect(defaults.MAX_CROSS_BOT_EDIT_DELETE_ENABLED).toBe(false);

    const canary = validateEnv(
      createValidEnv({
        MAX_ROUTED_MUTATIONS_MODE: 'canary',
        MAX_ROUTED_MUTATIONS_CANARY_PERCENT: '12.5',
        MAX_ROUTED_MUTATIONS_CANARY_ENTITY_IDS: 'chat-1,channel-2',
        MAX_CROSS_BOT_EDIT_DELETE_ENABLED: 'true',
      }),
    );
    expect(canary.MAX_ROUTED_MUTATIONS_MODE).toBe('canary');
    expect(canary.MAX_ROUTED_MUTATIONS_CANARY_PERCENT).toBe(12.5);
    expect(canary.MAX_ROUTED_MUTATIONS_CANARY_ENTITY_IDS).toBe('chat-1,channel-2');
    expect(canary.MAX_CROSS_BOT_EDIT_DELETE_ENABLED).toBe(true);
    expect(() =>
      validateEnv(createValidEnv({ MAX_ROUTED_MUTATIONS_CANARY_PERCENT: '101' })),
    ).toThrow(/MAX_ROUTED_MUTATIONS_CANARY_PERCENT/u);
  });

  it('keeps general delete intents off while enabling the narrow replacement cleanup switch', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.MODERATION_DELETE_INTENT_MODE).toBe('off');
    expect(defaults.MODERATION_DELETE_INTENT_CANARY_CHAT_IDS).toBe('');
    expect(defaults.MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS).toBe('');
    expect(defaults.MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED).toBe(false);
    expect(defaults.MODERATION_DELETE_INTENT_RETRY_HORIZON_MS).toBe(86_400_000);
    expect(defaults.MODERATION_DELETE_INTENT_RECOVERY_BATCH_SIZE).toBe(10);
    expect(defaults.MODERATION_DELETE_INTENT_RETENTION_DAYS).toBe(90);
    expect(defaults.MODERATION_DELETE_INTENT_PURGE_MAX_BATCHES).toBe(10);
    expect(defaults.MODERATION_DELETE_INTENT_LEASE_MS).toBeGreaterThan(
      defaults.MODERATION_DELETE_INTENT_TIMEOUT_MS,
    );

    const canary = validateEnv(
      createValidEnv({
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'chat-1',
        MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: 'false',
      }),
    );
    expect(canary.MODERATION_DELETE_INTENT_MODE).toBe('canary');
    expect(canary.MODERATION_DELETE_INTENT_CANARY_CHAT_IDS).toBe('chat-1');
    expect(canary.MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS).toBe('chat-1');
    expect(canary.MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED).toBe(false);

    expect(() =>
      validateEnv(
        createValidEnv({
          MODERATION_DELETE_INTENT_LEASE_MS: '1000',
          MODERATION_DELETE_INTENT_TIMEOUT_MS: '1000',
        }),
      ),
    ).toThrow(/MODERATION_DELETE_INTENT_LEASE_MS/u);
    expect(() =>
      validateEnv(
        createValidEnv({
          MODERATION_DELETE_INTENT_RETRY_BASE_MS: '10000',
          MODERATION_DELETE_INTENT_RETRY_MAX_MS: '5000',
        }),
      ),
    ).toThrow(/MODERATION_DELETE_INTENT_RETRY_MAX_MS/u);
  });

  it('defaults the action ledger watchdog to shadow rollout', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.MAX_ACTION_LEDGER_WATCHDOG_MODE).toBe('shadow');
    expect(defaults.MAX_ACTION_LEDGER_WATCHDOG_CANARY_PERCENT).toBe(1);
    expect(defaults.MAX_ACTION_LEDGER_WATCHDOG_CANARY_ENTITY_IDS).toBe('');

    const canary = validateEnv(
      createValidEnv({
        MAX_ACTION_LEDGER_WATCHDOG_MODE: 'canary',
        MAX_ACTION_LEDGER_WATCHDOG_CANARY_PERCENT: '25',
        MAX_ACTION_LEDGER_WATCHDOG_CANARY_ENTITY_IDS: 'ledger-1,chat-2',
      }),
    );
    expect(canary.MAX_ACTION_LEDGER_WATCHDOG_MODE).toBe('canary');
    expect(canary.MAX_ACTION_LEDGER_WATCHDOG_CANARY_PERCENT).toBe(25);
    expect(canary.MAX_ACTION_LEDGER_WATCHDOG_CANARY_ENTITY_IDS).toBe('ledger-1,chat-2');
    expect(() =>
      validateEnv(createValidEnv({ MAX_ACTION_LEDGER_WATCHDOG_CANARY_PERCENT: '-1' })),
    ).toThrow(/MAX_ACTION_LEDGER_WATCHDOG_CANARY_PERCENT/u);
  });

  it('parses default bot lifecycle and ownership weight configuration', () => {
    const env = validateEnv(
      createValidEnv({
        MAX_BOT_STATE: 'draining',
        MAX_BOT_OWNERSHIP_WEIGHT: '2.5',
        MAX_BOTS_JSON: JSON.stringify([
          {
            id: 'active-entry-bot',
            token: 'active-entry-token-123',
            webhookSecretPath: 'active-entry-path',
            webhookHeaderSecret: 'active-entry-header',
            state: 'active',
          },
        ]),
      }),
    );

    expect(env.MAX_BOT_STATE).toBe('draining');
    expect(env.MAX_BOT_OWNERSHIP_WEIGHT).toBe(2.5);
  });

  it('rejects duplicate cross-bot credentials and configurations without an active entry bot', () => {
    expect(() =>
      validateEnv(
        createValidEnv({
          MAX_BOTS_JSON: JSON.stringify([
            {
              id: 'duplicate-token-bot',
              token: 'test-token-123',
              webhookSecretPath: 'additional-path',
              webhookHeaderSecret: 'additional-header',
              state: 'active',
            },
          ]),
        }),
      ),
    ).toThrow(/token must be unique across bots/u);

    expect(() =>
      validateEnv(
        createValidEnv({
          MAX_BOT_STATE: 'draining',
          MAX_BOTS_JSON: JSON.stringify([
            {
              id: 'dormant-bot',
              token: 'dormant-token-123',
              webhookSecretPath: 'dormant-path',
              webhookHeaderSecret: 'dormant-header',
              state: 'dormant',
            },
          ]),
        }),
      ),
    ).toThrow(/at least one active actionable entry bot/u);
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
      ADMIN_ACCESS_CODE: 'server-admin-code',
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

  it('rejects the deprecated MAX API host in production', () => {
    const productionSecrets = {
      NODE_ENV: 'production',
      ADMIN_ACCESS_CODE: 'server-admin-code',
      MAX_WEBHOOK_SECRET_PATH: 'prod-secret-path-1',
      MAX_WEBHOOK_HEADER_SECRET: 'prod-header-secret-1',
    };

    expect(() =>
      validateEnv(
        createValidEnv({
          ...productionSecrets,
          MAX_API_BASE_URL: 'https://platform-api.max.ru',
        }),
      ),
    ).toThrow(/MAX_API_BASE_URL must use https:\/\/platform-api2\.max\.ru in production/u);

    const env = validateEnv(
      createValidEnv({
        ...productionSecrets,
        MAX_API_BASE_URL: 'https://platform-api2.max.ru',
      }),
    );

    expect(env.MAX_API_BASE_URL).toBe('https://platform-api2.max.ru');
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

  it('validates MAX action lane worker concurrency', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.MAX_ACTION_CRITICAL_CONCURRENCY).toBe(3);
    expect(defaults.MAX_ACTION_INTERACTIVE_CONCURRENCY).toBe(2);
    expect(defaults.MAX_ACTION_BACKGROUND_CONCURRENCY).toBe(1);

    const configured = validateEnv(
      createValidEnv({
        MAX_ACTION_CRITICAL_CONCURRENCY: '6',
        MAX_ACTION_INTERACTIVE_CONCURRENCY: '4',
        MAX_ACTION_BACKGROUND_CONCURRENCY: '2',
      }),
    );
    expect(configured.MAX_ACTION_CRITICAL_CONCURRENCY).toBe(6);
    expect(configured.MAX_ACTION_INTERACTIVE_CONCURRENCY).toBe(4);
    expect(configured.MAX_ACTION_BACKGROUND_CONCURRENCY).toBe(2);
    expect(() => validateEnv(createValidEnv({ MAX_ACTION_BACKGROUND_CONCURRENCY: '0' }))).toThrow(
      /MAX_ACTION_BACKGROUND_CONCURRENCY/u,
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
    ).toThrow(
      /KARAVAN_STOREFRONT_RELAY_ENABLED requires KARAVAN_API_BASE_URL, KARAVAN_INTEGRATION_TOKEN/u,
    );

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
