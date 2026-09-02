import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  it('rejects runtime service and role combinations that would boot the wrong workers', () => {
    expect(() =>
      validateEnv(
        createValidEnv({
          APP_ROLE: 'ingress',
          APP_SERVICE_NAME: 'api-action',
        }),
      ),
    ).toThrow(/api-action service requires action role/u);

    expect(() =>
      validateEnv(
        createValidEnv({
          APP_ROLE: 'action',
          APP_SERVICE_NAME: 'api-media-analysis',
        }),
      ),
    ).toThrow(/api-media-analysis service requires moderation role/u);

    expect(
      validateEnv(
        createValidEnv({
          APP_ROLE: 'moderation',
          APP_SERVICE_NAME: 'api-media-analysis',
        }),
      ),
    ).toMatchObject({
      APP_ROLE: 'moderation',
      APP_SERVICE_NAME: 'api-media-analysis',
    });
  });

  it('hydrates only the publisher ConfigService view from isolated secret files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'maxim-publisher-env-'));
    const tokenFile = join(directory, 'token');
    const webhookFile = join(directory, 'webhook.json');
    const dialogSigningKeyFile = join(directory, 'dialog-signing.json');
    const token = 'P'.repeat(40);
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    writeFileSync(
      webhookFile,
      JSON.stringify({
        version: 1,
        botId: 'se14088825_bot',
        secretPath: 'publisher_path_12345678',
        headerSecrets: ['publisher_header_123456'],
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      dialogSigningKeyFile,
      JSON.stringify({
        version: 1,
        botId: 'se14088825_bot',
        keys: [Buffer.alloc(32, 3).toString('base64')],
      }),
      { mode: 0o600 },
    );
    const raw = createValidEnv({
      APP_ROLE: 'publisher',
      APP_SERVICE_NAME: 'api-publisher',
      MAX_BOT_ID: 'se14088825_bot',
      MAX_BOT_CONTACT_ID: '',
      MAX_ENTRY_BOT_ID: 'se14088825_bot',
      MAX_BOT_TOKEN: '',
      MAX_BOT_TOKEN_PREVIOUS: '',
      MAX_BOTS_JSON: '',
      MAX_PUBLISHER_BOT_ID: 'se14088825_bot',
      MAX_PUBLISHER_BOT_TOKEN_FILE: tokenFile,
      MAX_PUBLISHER_WEBHOOK_CREDENTIALS_FILE: webhookFile,
      MAX_PUBLISHER_DIALOG_SIGNING_KEY_FILE: dialogSigningKeyFile,
    });

    try {
      expect(validateEnv(raw)).toMatchObject({
        MAX_BOT_ID: 'se14088825_bot',
        MAX_BOT_CONTACT_ID: undefined,
        MAX_ENTRY_BOT_ID: 'se14088825_bot',
        MAX_BOT_TOKEN: token,
        MAX_BOTS_JSON: undefined,
        MAX_WEBHOOK_SECRET_PATH: 'publisher_path_12345678',
        MAX_WEBHOOK_HEADER_SECRET: 'publisher_header_123456',
      });
      expect(raw.MAX_BOT_TOKEN).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects inherited main-bot credentials before publisher bootstrap', () => {
    expect(() =>
      validateEnv(
        createValidEnv({
          APP_ROLE: 'publisher',
          APP_SERVICE_NAME: 'api-publisher',
          MAX_BOT_ID: 'se14088825_bot',
          MAX_ENTRY_BOT_ID: 'se14088825_bot',
          MAX_BOT_TOKEN: 'leaked-main-token',
          MAX_PUBLISHER_BOT_ID: 'se14088825_bot',
        }),
      ),
    ).toThrow(/must not inherit main bot credentials/u);
  });

  it('keeps completed webhook retention disabled unless explicitly enabled', () => {
    expect(validateEnv(createValidEnv()).WEBHOOK_COMPLETED_RETENTION_ENABLED).toBe(false);
    expect(
      validateEnv(createValidEnv({ WEBHOOK_COMPLETED_RETENTION_ENABLED: 'true' }))
        .WEBHOOK_COMPLETED_RETENTION_ENABLED,
    ).toBe(true);
    expect(
      validateEnv(createValidEnv({ WEBHOOK_COMPLETED_RETENTION_ENABLED: 'false' }))
        .WEBHOOK_COMPLETED_RETENTION_ENABLED,
    ).toBe(false);
  });

  it('keeps the global ownership repair runner disabled unless explicitly enabled', () => {
    expect(validateEnv(createValidEnv()).BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED).toBe(false);
    expect(
      validateEnv(createValidEnv({ BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED: 'true' }))
        .BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED,
    ).toBe(true);
    expect(
      validateEnv(createValidEnv({ BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED: 'false' }))
        .BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED,
    ).toBe(false);
  });

  it('keeps plain-text link clickability shadow-only unless explicitly enabled', () => {
    expect(validateEnv(createValidEnv()).MODERATION_LINK_TEXT_CLICKABILITY_ENABLED).toBe(false);
    expect(
      validateEnv(createValidEnv({ MODERATION_LINK_TEXT_CLICKABILITY_ENABLED: 'true' }))
        .MODERATION_LINK_TEXT_CLICKABILITY_ENABLED,
    ).toBe(true);
    expect(
      validateEnv(createValidEnv({ MODERATION_LINK_TEXT_CLICKABILITY_ENABLED: 'false' }))
        .MODERATION_LINK_TEXT_CLICKABILITY_ENABLED,
    ).toBe(false);
  });

  it('keeps structured profanity policy on with an explicit legacy kill switch', () => {
    expect(validateEnv(createValidEnv()).PROFANITY_V2_ROLLOUT_MODE).toBe('on');
    expect(
      validateEnv(createValidEnv({ PROFANITY_V2_ROLLOUT_MODE: 'legacy' }))
        .PROFANITY_V2_ROLLOUT_MODE,
    ).toBe('legacy');
    expect(() => validateEnv(createValidEnv({ PROFANITY_V2_ROLLOUT_MODE: 'shadow' }))).toThrow(
      /PROFANITY_V2_ROLLOUT_MODE/u,
    );
  });

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
    const defaults = validateEnv(createValidEnv());
    expect(defaults.SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS).toBe(2_000);
    expect(defaults.SYSTEM_WEBHOOK_SLO_WINDOW_SEC).toBe(900);
    expect(
      validateEnv(
        createValidEnv({
          SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS: '1500',
          SYSTEM_WEBHOOK_SLO_WINDOW_SEC: '86400',
        }),
      ),
    ).toMatchObject({
      SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS: 1_500,
      SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 86_400,
    });
    expect(() =>
      validateEnv(createValidEnv({ SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS: '0' })),
    ).toThrow(/SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS/u);
    expect(() => validateEnv(createValidEnv({ SYSTEM_WEBHOOK_SLO_WINDOW_SEC: '86401' }))).toThrow(
      /SYSTEM_WEBHOOK_SLO_WINDOW_SEC/u,
    );
  });

  it('keeps mini app sessions bounded and Redis checks fail-fast', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.MINIAPP_SESSION_TTL_SEC).toBe(28_800);
    expect(defaults.MINIAPP_SESSION_REDIS_TIMEOUT_MS).toBe(500);

    expect(
      validateEnv(
        createValidEnv({
          MINIAPP_SESSION_TTL_SEC: '43200',
          MINIAPP_SESSION_REDIS_TIMEOUT_MS: '750',
        }),
      ),
    ).toMatchObject({
      MINIAPP_SESSION_TTL_SEC: 43_200,
      MINIAPP_SESSION_REDIS_TIMEOUT_MS: 750,
    });
    expect(() => validateEnv(createValidEnv({ MINIAPP_SESSION_TTL_SEC: '3599' }))).toThrow(
      /MINIAPP_SESSION_TTL_SEC/u,
    );
    expect(() => validateEnv(createValidEnv({ MINIAPP_SESSION_REDIS_TIMEOUT_MS: '2001' }))).toThrow(
      /MINIAPP_SESSION_REDIS_TIMEOUT_MS/u,
    );
  });

  it('keeps webhook admission and ACK work within bounded defaults', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.WEBHOOK_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(defaults.WEBHOOK_ACK_DEADLINE_MS).toBe(18_000);
    expect(defaults.WEBHOOK_RATE_LIMIT_REDIS_TIMEOUT_MS).toBe(100);
    expect(defaults.WEBHOOK_RECEIPT_MAX_IN_FLIGHT).toBe(64);

    const configured = validateEnv(
      createValidEnv({
        WEBHOOK_BODY_LIMIT_BYTES: '2097152',
        WEBHOOK_ACK_DEADLINE_MS: '15000',
        WEBHOOK_RATE_LIMIT_REDIS_TIMEOUT_MS: '250',
        WEBHOOK_RECEIPT_MAX_IN_FLIGHT: '32',
      }),
    );
    expect(configured.WEBHOOK_BODY_LIMIT_BYTES).toBe(2_097_152);
    expect(configured.WEBHOOK_ACK_DEADLINE_MS).toBe(15_000);
    expect(configured.WEBHOOK_RATE_LIMIT_REDIS_TIMEOUT_MS).toBe(250);
    expect(configured.WEBHOOK_RECEIPT_MAX_IN_FLIGHT).toBe(32);

    expect(() => validateEnv(createValidEnv({ WEBHOOK_BODY_LIMIT_BYTES: '4194305' }))).toThrow(
      /WEBHOOK_BODY_LIMIT_BYTES/u,
    );
    expect(() => validateEnv(createValidEnv({ WEBHOOK_ACK_DEADLINE_MS: '18001' }))).toThrow(
      /WEBHOOK_ACK_DEADLINE_MS/u,
    );
    expect(() => validateEnv(createValidEnv({ WEBHOOK_RATE_LIMIT_REDIS_TIMEOUT_MS: '5' }))).toThrow(
      /WEBHOOK_RATE_LIMIT_REDIS_TIMEOUT_MS/u,
    );
    expect(() => validateEnv(createValidEnv({ WEBHOOK_RECEIPT_MAX_IN_FLIGHT: '1025' }))).toThrow(
      /WEBHOOK_RECEIPT_MAX_IN_FLIGHT/u,
    );
  });

  it('keeps Publisher auto-reply flood and backlog admission strictly bounded', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults).toMatchObject({
      PUBLISHER_AUTO_REPLY_DELAY_MS: 1_500,
      PUBLISHER_AUTO_REPLY_EXTENDED_MATCHING_MODE: 'on',
      PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT: 3,
      PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT: 10,
      PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT: 30,
      PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT: 120,
      PUBLISHER_AUTO_REPLY_QUEUE_BACKLOG_LIMIT: 200,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_REDIS_TIMEOUT_MS: 100,
    });

    expect(
      validateEnv(
        createValidEnv({
          PUBLISHER_AUTO_REPLY_DELAY_MS: '2500',
          PUBLISHER_AUTO_REPLY_EXTENDED_MATCHING_MODE: 'shadow',
          PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT: '5',
          PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT: '20',
          PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT: '50',
          PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT: '300',
          PUBLISHER_AUTO_REPLY_QUEUE_BACKLOG_LIMIT: '500',
          PUBLISHER_AUTO_REPLY_FLOOD_GATE_REDIS_TIMEOUT_MS: '250',
        }),
      ),
    ).toMatchObject({
      PUBLISHER_AUTO_REPLY_DELAY_MS: 2_500,
      PUBLISHER_AUTO_REPLY_EXTENDED_MATCHING_MODE: 'shadow',
      PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT: 5,
      PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT: 20,
      PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT: 50,
      PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT: 300,
      PUBLISHER_AUTO_REPLY_QUEUE_BACKLOG_LIMIT: 500,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_REDIS_TIMEOUT_MS: 250,
    });

    for (const [key, value] of [
      ['PUBLISHER_AUTO_REPLY_DELAY_MS', '60001'],
      ['PUBLISHER_AUTO_REPLY_EXTENDED_MATCHING_MODE', 'canary'],
      ['PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT', '0'],
      ['PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT', '1001'],
      ['PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT', '1001'],
      ['PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT', '10001'],
      ['PUBLISHER_AUTO_REPLY_QUEUE_BACKLOG_LIMIT', '9'],
      ['PUBLISHER_AUTO_REPLY_FLOOD_GATE_REDIS_TIMEOUT_MS', '2001'],
    ] as const) {
      expect(() => validateEnv(createValidEnv({ [key]: value }))).toThrow(new RegExp(key, 'u'));
    }
    expect(() =>
      validateEnv(
        createValidEnv({
          PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT: '11',
          PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT: '10',
        }),
      ),
    ).toThrow(/PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT/u);
    expect(() =>
      validateEnv(
        createValidEnv({
          PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT: '121',
          PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT: '120',
        }),
      ),
    ).toThrow(/PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT/u);
    expect(() =>
      validateEnv(
        createValidEnv({
          PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT: '31',
          PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT: '31',
          PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT: '30',
        }),
      ),
    ).toThrow(/PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT/u);
    expect(() =>
      validateEnv(
        createValidEnv({
          PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT: '121',
          PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT: '120',
        }),
      ),
    ).toThrow(/PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT/u);
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

  it('caps managed refresh pressure independently per bot token by default', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.MAX_API_MANAGED_REFRESH_RPS).toBe(2);

    const configured = validateEnv(
      createValidEnv({
        MAX_API_MANAGED_REFRESH_RPS: '1',
      }),
    );
    expect(configured.MAX_API_MANAGED_REFRESH_RPS).toBe(1);
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
    expect(defaults.MAX_API_RATE_LIMIT_WAIT_MS_MODERATION_DELETE).toBe(2_500);
    expect(defaults.MODERATION_DELETE_INTENT_MODE).toBe('off');
    expect(defaults.MODERATION_DELETE_INTENT_CANARY_CHAT_IDS).toBe('');
    expect(defaults.MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS).toBe('');
    expect(defaults.MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED).toBe(false);
    expect(defaults.MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED).toBe(true);
    expect(defaults.MODERATION_DELETE_INTENT_RETRY_HORIZON_MS).toBe(86_400_000);
    expect(defaults.MODERATION_DELETE_INTENT_RECOVERY_BATCH_SIZE).toBe(10);
    expect(defaults.MODERATION_DELETE_INTENT_RETENTION_DAYS).toBe(90);
    expect(defaults.MODERATION_DELETE_INTENT_PURGE_MAX_BATCHES).toBe(40);
    expect(defaults.MODERATION_DELETE_INTENT_LEASE_MS).toBeGreaterThan(
      defaults.MODERATION_DELETE_INTENT_TIMEOUT_MS,
    );

    const canary = validateEnv(
      createValidEnv({
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'chat-1',
        MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: 'false',
        MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: 'false',
      }),
    );
    expect(canary.MODERATION_DELETE_INTENT_MODE).toBe('canary');
    expect(canary.MODERATION_DELETE_INTENT_CANARY_CHAT_IDS).toBe('chat-1');
    expect(canary.MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS).toBe('chat-1');
    expect(canary.MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED).toBe(false);
    expect(canary.MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED).toBe(false);

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

  it('enables live navigation evidence while keeping history recovery off by default', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.MODERATION_LINK_STRUCTURED_TARGETS_ENABLED).toBe(true);
    expect(defaults.MODERATION_LINK_PROFILE_MENTIONS_ENABLED).toBe(false);
    expect(defaults.MODERATION_LINK_FORWARDED_TARGETS_ENABLED).toBe(true);
    expect(defaults.MODERATION_LINK_TEXT_CLICKABILITY_ENABLED).toBe(false);
    expect(defaults.MODERATION_LINK_HISTORY_SCAN_ENABLED).toBe(false);
    expect(defaults.MODERATION_LINK_HISTORY_DELETE_ENABLED).toBe(false);
    expect(defaults.MODERATION_LINK_HISTORY_SCAN_PAGE_SIZE).toBe(50);

    expect(
      validateEnv(createValidEnv({ MODERATION_LINK_HISTORY_SCAN_PAGE_SIZE: '99' }))
        .MODERATION_LINK_HISTORY_SCAN_PAGE_SIZE,
    ).toBe(99);
    expect(() =>
      validateEnv(createValidEnv({ MODERATION_LINK_HISTORY_SCAN_PAGE_SIZE: '100' })),
    ).toThrow(/MODERATION_LINK_HISTORY_SCAN_PAGE_SIZE/u);
  });

  it('defaults photo duplicate analysis to bounded shadow mode', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.PHOTO_DUPLICATE_ROLLOUT_MODE).toBe('shadow');
    expect(defaults.PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS).toBe('');
    expect(defaults.PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS).toBe('');
    expect(defaults.PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS).toBe('canonical_sha256');
    expect(defaults.PHOTO_DUPLICATE_MAX_ACTION).toBe('DELETE_MESSAGE');
    expect(defaults.PHOTO_DUPLICATE_ALLOWED_HOSTS).toBe('i.oneme.ru,fd.oneme.ru');
    expect(defaults.PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS).toBe(5_000);
    expect(defaults.PHOTO_DUPLICATE_MAX_BYTES).toBe(16_777_216);
    expect(defaults.PHOTO_DUPLICATE_MAX_PIXELS).toBe(40_000_000);
    expect(defaults.PHOTO_DUPLICATE_HISTORY_MAX_ITEMS).toBe(250);

    const configured = validateEnv(
      createValidEnv({
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'delete_only',
        PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
        PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS: 'chat-2',
        PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'canonical_sha256,pdq',
        PHOTO_DUPLICATE_MAX_ACTION: 'MUTE',
        PHOTO_DUPLICATE_ALLOWED_HOSTS: 'i.oneme.ru,cdn.example.test',
        PHOTO_DUPLICATE_MAX_BYTES: '8388608',
      }),
    );
    expect(configured.PHOTO_DUPLICATE_ROLLOUT_MODE).toBe('delete_only');
    expect(configured.PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS).toBe('chat-1');
    expect(configured.PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS).toBe('chat-2');
    expect(configured.PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS).toBe('canonical_sha256,pdq');
    expect(configured.PHOTO_DUPLICATE_MAX_ACTION).toBe('MUTE');
    expect(configured.PHOTO_DUPLICATE_MAX_BYTES).toBe(8_388_608);

    expect(() => validateEnv(createValidEnv({ PHOTO_DUPLICATE_ROLLOUT_MODE: 'unsafe' }))).toThrow(
      /PHOTO_DUPLICATE_ROLLOUT_MODE/u,
    );
    expect(() =>
      validateEnv(
        createValidEnv({ PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'canonical_sha256,phash' }),
      ),
    ).toThrow(/PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS/u);
    expect(() =>
      validateEnv(createValidEnv({ PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'platform_id' })),
    ).toThrow(/PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS/u);
    expect(() => validateEnv(createValidEnv({ PHOTO_DUPLICATE_MAX_ACTION: 'KICK' }))).toThrow(
      /PHOTO_DUPLICATE_MAX_ACTION/u,
    );
    expect(() =>
      validateEnv(createValidEnv({ PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: '*' })),
    ).toThrow(/wildcard/u);
    expect(() =>
      validateEnv(createValidEnv({ PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS: 'chat-1,*' })),
    ).toThrow(/wildcard/u);
  });

  it('keeps commercial OCR off by default with bounded isolated worker resources', () => {
    const defaults = validateEnv(createValidEnv());
    expect(defaults.COMMERCIAL_OCR_ROLLOUT_MODE).toBe('off');
    expect(defaults.COMMERCIAL_OCR_CANARY_CHAT_IDS).toBe('');
    expect(defaults.COMMERCIAL_OCR_VERSION).toBe('tesseract-rus-eng-v2');
    expect(defaults.COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS).toBe(10_000);
    expect(defaults.COMMERCIAL_OCR_TESSERACT_CONCURRENCY).toBe(1);
    expect(defaults.OMP_THREAD_LIMIT).toBe(1);
    expect(defaults.COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS).toBe(16);
    expect(defaults.COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS).toBe(10);
    expect(defaults.COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS).toBe(4);
    expect(defaults.COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64).toBe('');
    expect(defaults.COMMERCIAL_OCR_MAX_JOB_AGE_MS).toBe(300_000);
    expect(defaults.COMMERCIAL_OCR_RESERVATION_TTL_MS).toBe(600_000);
    expect(defaults.COMMERCIAL_OCR_MAX_OUTPUT_PIXELS).toBe(3_000_000);

    const approvalPublicKey = generateKeyPairSync('ed25519')
      .publicKey.export({
        type: 'spki',
        format: 'der',
      })
      .toString('base64');
    const configured = validateEnv(
      createValidEnv({
        COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
        COMMERCIAL_OCR_CANARY_CHAT_IDS: 'chat-1,chat-2',
        COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64: approvalPublicKey,
        COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '7500',
        OMP_THREAD_LIMIT: '2',
      }),
    );
    expect(configured.COMMERCIAL_OCR_ROLLOUT_MODE).toBe('canary');
    expect(configured.COMMERCIAL_OCR_CANARY_CHAT_IDS).toBe('chat-1,chat-2');
    expect(configured.COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS).toBe(7_500);
    expect(configured.OMP_THREAD_LIMIT).toBe(2);

    expect(
      validateEnv(
        createValidEnv({
          COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64: approvalPublicKey,
        }),
      ).COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64,
    ).toBe(approvalPublicKey);
    expect(() =>
      validateEnv(
        createValidEnv({
          COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64:
            Buffer.from('not-a-key').toString('base64'),
        }),
      ),
    ).toThrow(/Ed25519 SPKI/u);
    expect(() =>
      validateEnv(
        createValidEnv({
          COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64: Buffer.concat([
            Buffer.from(approvalPublicKey, 'base64'),
            Buffer.from([0]),
          ]).toString('base64'),
        }),
      ),
    ).toThrow(/Ed25519 SPKI/u);
    for (const mode of ['canary', 'on']) {
      expect(() =>
        validateEnv(
          createValidEnv({
            COMMERCIAL_OCR_ROLLOUT_MODE: mode,
            COMMERCIAL_OCR_CANARY_CHAT_IDS: 'chat-1',
          }),
        ),
      ).toThrow(/APPROVAL_PUBLIC_KEY_BASE64 is required/u);
    }

    expect(() =>
      validateEnv(createValidEnv({ COMMERCIAL_OCR_CANARY_CHAT_IDS: 'chat-1,*' })),
    ).toThrow(/COMMERCIAL_OCR_CANARY_CHAT_IDS/u);
    expect(() => validateEnv(createValidEnv({ OMP_THREAD_LIMIT: '0' }))).toThrow(
      /OMP_THREAD_LIMIT/u,
    );
    expect(() =>
      validateEnv(
        createValidEnv({
          COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS: '3',
          COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS: '4',
        }),
      ),
    ).toThrow(/COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS/u);
    expect(() =>
      validateEnv(
        createValidEnv({
          COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
          COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS: '5',
          COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS: '4',
          COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS: '6',
        }),
      ),
    ).toThrow(/COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS/u);
    expect(
      validateEnv(
        createValidEnv({
          COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
          COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS: '3',
          COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS: '3',
        }),
      ).COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS,
    ).toBe(4);
    expect(
      validateEnv(createValidEnv({ COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS: '0' }))
        .COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS,
    ).toBe(0);
    expect(() =>
      validateEnv(
        createValidEnv({
          COMMERCIAL_OCR_MAX_INPUT_PIXELS: '1000000',
          COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: '2000000',
        }),
      ),
    ).toThrow(/COMMERCIAL_OCR_MAX_OUTPUT_PIXELS/u);
    expect(() =>
      validateEnv(
        createValidEnv({
          COMMERCIAL_OCR_MAX_JOB_AGE_MS: '60000',
          COMMERCIAL_OCR_RESERVATION_TTL_MS: '119999',
        }),
      ),
    ).toThrow(/COMMERCIAL_OCR_RESERVATION_TTL_MS/u);
    expect(
      validateEnv(
        createValidEnv({
          COMMERCIAL_OCR_MAX_JOB_AGE_MS: '5000',
          COMMERCIAL_OCR_RESERVATION_TTL_MS: '65000',
        }),
      ).COMMERCIAL_OCR_RESERVATION_TTL_MS,
    ).toBe(65_000);
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
        PRISMA_PG_STATEMENT_TIMEOUT_MS: '15000',
        MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX: '2',
      }),
    );

    expect(env.PRISMA_PG_POOL_MAX).toBe(4);
    expect(env.PRISMA_PG_POOL_IDLE_TIMEOUT_MS).toBe(10000);
    expect(env.PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS).toBe(5000);
    expect(env.PRISMA_PG_POOL_MAX_LIFETIME_SEC).toBe(300);
    expect(env.PRISMA_PG_STATEMENT_TIMEOUT_MS).toBe(15000);
    expect(env.MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX).toBe(2);

    expect(() => validateEnv(createValidEnv({ PRISMA_PG_POOL_MAX: '0' }))).toThrow(
      /PRISMA_PG_POOL_MAX/u,
    );
    expect(() => validateEnv(createValidEnv({ PRISMA_PG_STATEMENT_TIMEOUT_MS: '0' }))).toThrow(
      /PRISMA_PG_STATEMENT_TIMEOUT_MS/u,
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
    expect(env.KARAVAN_STOREFRONT_CATALOG_URL).toBe('https://max.ru/se13381675_1_bot?startapp=');
    expect(env.KARAVAN_STOREFRONT_CREATE_URL).toBe(
      'https://max.ru/se13381675_bot?startapp=storefront',
    );
  });

  it('keeps Karavan fallback links configurable and HTTPS-only in production', () => {
    const env = validateEnv(
      createValidEnv({
        KARAVAN_STOREFRONT_CATALOG_URL: 'https://example.com/catalog?startapp=',
        KARAVAN_STOREFRONT_CREATE_URL: 'https://example.com/seller?startapp=storefront',
      }),
    );

    expect(env).toMatchObject({
      KARAVAN_STOREFRONT_CATALOG_URL: 'https://example.com/catalog?startapp=',
      KARAVAN_STOREFRONT_CREATE_URL: 'https://example.com/seller?startapp=storefront',
    });

    expect(() =>
      validateEnv(
        createValidEnv({
          NODE_ENV: 'production',
          ADMIN_ACCESS_CODE: 'server-admin-code',
          MAX_WEBHOOK_SECRET_PATH: 'prod-secret-path-1',
          MAX_WEBHOOK_HEADER_SECRET: 'prod-header-secret-1',
          KARAVAN_STOREFRONT_CATALOG_URL: 'http://example.com/catalog',
        }),
      ),
    ).toThrow(/KARAVAN_STOREFRONT_CATALOG_URL must use public https/u);
  });
});
