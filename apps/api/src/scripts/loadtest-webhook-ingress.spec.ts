import { WebhookParser } from '../webhook/webhook.parser';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  WEBHOOK_LOAD_EXECUTE_CONFIRMATION,
  WEBHOOK_LOAD_PRODUCTION_CONFIRMATION,
  WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
  buildSyntheticWebhookPayload,
  buildWebhookLoadPlan,
  extractVerificationCounts,
  loadWebhookIngressLoadConfig,
  percentile,
  renderSafeConfig,
  summarizeRequestStats,
} from './loadtest-webhook-ingress';

function baseEnv(botCount = 6): Record<string, string> {
  const env: Record<string, string> = {
    WEBHOOK_LOAD_TARGET_URL: 'http://127.0.0.1:3001/api/webhook/max',
    WEBHOOK_LOAD_CHAT_ID: '-900000000001',
    WEBHOOK_LOAD_SENDER_ID: '900000000002',
    WEBHOOK_LOAD_RUN_ID: 'local-run-0001',
  };
  for (let index = 1; index <= botCount; index += 1) {
    env[`WEBHOOK_LOAD_BOT_${index}_ID`] = `load_bot_${index}`;
    env[`WEBHOOK_LOAD_BOT_${index}_SECRET_PATH`] = `secret-path-${index}`;
    env[`WEBHOOK_LOAD_BOT_${index}_HEADER_SECRET`] = `header-secret-${index}`;
  }
  return env;
}

describe('webhook ingress load-test config', () => {
  it('builds the planned 1/2/3/6 matrix at 100 aggregate receipt rps', () => {
    const config = loadWebhookIngressLoadConfig(baseEnv());
    const plan = buildWebhookLoadPlan(config);

    expect(config.execute).toBe(false);
    expect(config.durationSec).toBe(600);
    expect(config.rps).toBe(100);
    expect(config.mirrorCounts).toEqual([1, 2, 3, 6]);
    expect(plan.map((phase) => phase.mirrorCount)).toEqual([1, 2, 3, 6]);
    expect(plan.reduce((sum, phase) => sum + phase.requests, 0)).toBeLessThanOrEqual(60_000);
    expect(plan.every((phase) => phase.semanticEvents > 0)).toBe(true);
  });

  it('requires an explicit execution phrase', () => {
    expect(
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_EXECUTE: 'yes',
      }).execute,
    ).toBe(false);
    expect(
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_EXECUTE: WEBHOOK_LOAD_EXECUTE_CONFIRMATION,
      }).execute,
    ).toBe(true);
  });

  it('requires separate public and production opt-ins for known production hosts', () => {
    const productionEnv = {
      ...baseEnv(1),
      WEBHOOK_LOAD_TARGET_URL: 'https://major-maksimov.ru/api/webhook/max',
    };

    expect(() => loadWebhookIngressLoadConfig(productionEnv)).toThrow('WEBHOOK_LOAD_ALLOW_PUBLIC');
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...productionEnv,
        WEBHOOK_LOAD_ALLOW_PUBLIC: WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
      }),
    ).toThrow('WEBHOOK_LOAD_ALLOW_PRODUCTION');

    const config = loadWebhookIngressLoadConfig({
      ...productionEnv,
      WEBHOOK_LOAD_ALLOW_PUBLIC: WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
      WEBHOOK_LOAD_ALLOW_PRODUCTION: WEBHOOK_LOAD_PRODUCTION_CONFIRMATION,
    });
    expect(config.publicTarget).toBe(true);
    expect(config.knownProductionTarget).toBe(true);
  });

  it('requires the public opt-in for an unknown external host', () => {
    const externalEnv = {
      ...baseEnv(1),
      WEBHOOK_LOAD_TARGET_URL: 'https://staging.example.test/api/webhook/max',
    };
    expect(() => loadWebhookIngressLoadConfig(externalEnv)).toThrow('WEBHOOK_LOAD_ALLOW_PUBLIC');
    const config = loadWebhookIngressLoadConfig({
      ...externalEnv,
      WEBHOOK_LOAD_ALLOW_PUBLIC: WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
    });
    expect(config.publicTarget).toBe(true);
    expect(config.knownProductionTarget).toBe(false);
  });

  it('rejects partial, duplicate, and insufficient bot configurations', () => {
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_BOT_2_ID: 'partial_bot',
      }),
    ).toThrow('requires ID, SECRET_PATH, and HEADER_SECRET');

    const duplicateSecrets = baseEnv(2);
    duplicateSecrets.WEBHOOK_LOAD_BOT_2_HEADER_SECRET =
      duplicateSecrets.WEBHOOK_LOAD_BOT_1_HEADER_SECRET!;
    expect(() => loadWebhookIngressLoadConfig(duplicateSecrets)).toThrow(
      'webhook header secrets must be unique',
    );

    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(3),
        WEBHOOK_LOAD_MIRROR_COUNTS: '6',
      }),
    ).toThrow('requires more configured bots');
  });

  it('never renders webhook or verification secrets', () => {
    const env: Record<string, string> = {
      ...baseEnv(1),
      WEBHOOK_LOAD_VERIFY_DATABASE_URL: 'postgresql://read_user:db-secret@db.internal/maxim',
    };
    const rendered = JSON.stringify(renderSafeConfig(loadWebhookIngressLoadConfig(env)));

    expect(rendered).not.toContain(env.WEBHOOK_LOAD_BOT_1_SECRET_PATH);
    expect(rendered).not.toContain(env.WEBHOOK_LOAD_BOT_1_HEADER_SECRET);
    expect(rendered).not.toContain('db-secret');
    expect(rendered).not.toContain(env.WEBHOOK_LOAD_CHAT_ID);
    expect(rendered).toContain('"verification":"database"');
  });
});

describe('webhook ingress load-test event generation', () => {
  it('creates one deterministic semantic event for every mirrored bot receipt', () => {
    const input = {
      runId: 'matrix-run-0001',
      chatId: '-900000000001',
      senderId: '900000000002',
      sequence: 17,
      mirrorCount: 6,
      phaseIndex: 3,
      timestampMs: Date.parse('2026-07-11T00:00:00.017Z'),
    };
    const payload = buildSyntheticWebhookPayload(input);
    const parser = new WebhookParser();
    const normalized = [1, 2, 3, 4, 5, 6].map((index) =>
      parser.parse(payload, { botId: `load_bot_${index}` }),
    );
    const semanticKeys = normalized.map((update) => buildWebhookSemanticEventKey(update));

    expect(new Set(normalized.map((update) => update.updateId))).toEqual(
      new Set(['ingress-load:matrix-run-0001:00000017']),
    );
    expect(new Set(normalized.map((update) => update.message?.createdAt))).toEqual(
      new Set(['2026-07-11T00:00:00.017Z']),
    );
    expect(new Set(semanticKeys).size).toBe(1);
    expect(semanticKeys[0]).toBe(
      'message:message_created:-900000000001:ingress-load:matrix-run-0001:00000017',
    );
  });
});

describe('webhook ingress load-test metrics', () => {
  it('uses nearest-rank percentiles and reports status/transport errors', () => {
    expect(percentile([1, 2, 3, 4, 100], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
    expect(percentile([], 0.99)).toBe(0);

    expect(
      summarizeRequestStats({
        total: 4,
        ok: 2,
        latenciesMs: [10, 20, 30, 40],
        statusCounts: new Map([
          [200, 2],
          [503, 1],
        ]),
        transportErrors: new Map([['TIMEOUT', 1]]),
      }),
    ).toEqual({
      total: 4,
      ok: 2,
      errors: 2,
      errorRate: 0.5,
      averageMs: 25,
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
      statusCounts: { '200': 2, '503': 1 },
      transportErrors: { TIMEOUT: 1 },
    });
  });

  it('extracts canonical counts from dashboard and direct metrics shapes', () => {
    expect(
      extractVerificationCounts({
        webhookSlo: { canonicalExecution: { receipts: 12, executionClaims: 7 } },
      }),
    ).toEqual({ receipts: 12, executionClaims: 7 });
    expect(
      extractVerificationCounts({
        data: { canonicalExecution: { receipts: 60_000, executionClaims: 25_000 } },
      }),
    ).toEqual({ receipts: 60_000, executionClaims: 25_000 });
    expect(() => extractVerificationCounts({ receipts: 1 })).toThrow(
      'canonical receipt and claim counts',
    );
  });
});
