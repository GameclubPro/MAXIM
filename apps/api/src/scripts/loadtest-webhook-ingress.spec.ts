import { WebhookParser } from '../webhook/webhook.parser';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  WEBHOOK_LOAD_EXECUTE_CONFIRMATION,
  WEBHOOK_LOAD_PRODUCTION_CONFIRMATION,
  WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
  RequestGate,
  buildSyntheticWebhookPayload,
  buildWebhookLoadPlan,
  evaluatePhaseThroughput,
  evaluateQueueDrainHealth,
  evaluateWebhookLoadAcceptance,
  extractQueueDrainMetrics,
  extractVerificationCounts,
  loadWebhookIngressLoadConfig,
  percentile,
  readMetricsPayload,
  renderSafeConfig,
  runPhase,
  summarizeRequestStats,
  verifyViaDatabase,
  verifyViaMetrics,
  waitForQueueDrain,
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
    expect(config.profile).toBe('custom');
    expect(config.baselineRps).toBeNull();
    expect(config.minThroughputRatio).toBe(0.95);
    expect(config.mirrorCounts).toEqual([1, 2, 3, 6]);
    expect(config.drainVerification).toEqual({
      enabled: false,
      metrics: null,
      queueLagTargetSec: 10,
      healthySamples: 3,
      timeoutSec: 120,
      intervalMs: 5_000,
    });
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

  it('parses a bounded minimum throughput ratio', () => {
    expect(
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_MIN_THROUGHPUT_RATIO: '0.97',
      }).minThroughputRatio,
    ).toBe(0.97);
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_MIN_THROUGHPUT_RATIO: '1.01',
      }),
    ).toThrow('must be at most 1');
  });

  it('derives steady and burst profiles from an operator-provided baseline', () => {
    const steady = loadWebhookIngressLoadConfig({
      ...baseEnv(),
      WEBHOOK_LOAD_PROFILE: 'steady-2x',
      WEBHOOK_LOAD_BASELINE_RPS: '37.5',
    });
    const burst = loadWebhookIngressLoadConfig({
      ...baseEnv(),
      WEBHOOK_LOAD_PROFILE: 'burst-4x',
      WEBHOOK_LOAD_BASELINE_RPS: '37.5',
    });

    expect(steady).toMatchObject({
      profile: 'steady-2x',
      baselineRps: 37.5,
      rps: 75,
      durationSec: 600,
      execute: false,
    });
    expect(burst).toMatchObject({
      profile: 'burst-4x',
      baselineRps: 37.5,
      rps: 150,
      durationSec: 60,
      execute: false,
    });
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(),
        WEBHOOK_LOAD_PROFILE: 'steady-2x',
      }),
    ).toThrow('WEBHOOK_LOAD_BASELINE_RPS is required');
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(),
        WEBHOOK_LOAD_PROFILE: 'burst-4x',
        WEBHOOK_LOAD_BASELINE_RPS: '10',
        WEBHOOK_LOAD_RPS: '12',
      }),
    ).toThrow('cannot override');
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

    expect(() =>
      loadWebhookIngressLoadConfig({
        ...productionEnv,
        WEBHOOK_LOAD_PROFILE: 'burst-4x',
        WEBHOOK_LOAD_BASELINE_RPS: '30',
        WEBHOOK_LOAD_ALLOW_PUBLIC: WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
        WEBHOOK_LOAD_ALLOW_PRODUCTION: WEBHOOK_LOAD_PRODUCTION_CONFIRMATION,
      }),
    ).toThrow('Baseline-derived load profiles cannot target known production hosts');
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...productionEnv,
        WEBHOOK_LOAD_RPS: '101',
        WEBHOOK_LOAD_ALLOW_PUBLIC: WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
        WEBHOOK_LOAD_ALLOW_PRODUCTION: WEBHOOK_LOAD_PRODUCTION_CONFIRMATION,
      }),
    ).toThrow('capped at 100 rps');
  });

  it('treats an absolute production DNS name as the same protected host', () => {
    const absoluteProductionEnv = {
      ...baseEnv(1),
      WEBHOOK_LOAD_TARGET_URL: 'https://major-maksimov.ru./api/webhook/max',
      WEBHOOK_LOAD_ALLOW_PUBLIC: WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
    };

    expect(() => loadWebhookIngressLoadConfig(absoluteProductionEnv)).toThrow(
      'WEBHOOK_LOAD_ALLOW_PRODUCTION',
    );
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...absoluteProductionEnv,
        WEBHOOK_LOAD_ALLOW_PRODUCTION: WEBHOOK_LOAD_PRODUCTION_CONFIRMATION,
        WEBHOOK_LOAD_PROFILE: 'burst-4x',
        WEBHOOK_LOAD_BASELINE_RPS: '30',
      }),
    ).toThrow('Baseline-derived load profiles cannot target known production hosts');
  });

  it('keeps IPv6 and IPv4-mapped production literals behind the target guards', () => {
    const externalIpv6Env = {
      ...baseEnv(1),
      WEBHOOK_LOAD_TARGET_URL: 'https://[2001:db8::1]/api/webhook/max',
    };
    expect(() => loadWebhookIngressLoadConfig(externalIpv6Env)).toThrow(
      'WEBHOOK_LOAD_ALLOW_PUBLIC',
    );
    expect(
      loadWebhookIngressLoadConfig({
        ...externalIpv6Env,
        WEBHOOK_LOAD_ALLOW_PUBLIC: WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
      }),
    ).toMatchObject({ publicTarget: true, knownProductionTarget: false });

    const mappedProductionEnv = {
      ...baseEnv(1),
      WEBHOOK_LOAD_TARGET_URL: 'https://[::ffff:84.201.186.244]/api/webhook/max',
    };
    expect(() => loadWebhookIngressLoadConfig(mappedProductionEnv)).toThrow(
      'WEBHOOK_LOAD_ALLOW_PUBLIC',
    );
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...mappedProductionEnv,
        WEBHOOK_LOAD_ALLOW_PUBLIC: WEBHOOK_LOAD_PUBLIC_CONFIRMATION,
      }),
    ).toThrow('WEBHOOK_LOAD_ALLOW_PRODUCTION');
  });

  it('requires HTTPS for credential-bearing external targets and metrics endpoints', () => {
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_TARGET_URL: 'http://staging.example.test/api/webhook/max',
      }),
    ).toThrow('WEBHOOK_LOAD_TARGET_URL must use https');
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_METRICS_URL: 'http://staging.example.test/api/v1/system/dashboard',
      }),
    ).toThrow('WEBHOOK_LOAD_VERIFY_METRICS_URL must use https');
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_DRAIN: 'true',
        WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL:
          'http://staging.example.test/api/v1/system/metrics/queues/operational',
      }),
    ).toThrow('WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL must use https');
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

  it('requires a metrics source for bounded drain verification and parses its controls', () => {
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_DRAIN: 'true',
      }),
    ).toThrow('WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL');
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_DRAIN: 'yes',
      }),
    ).toThrow('must be true or false');
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_DRAIN: 'true',
        WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL: 'http://127.0.0.1:3001/api/v1/system/dashboard',
      }),
    ).toThrow('must target /v1/system/metrics/queues/operational');
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_DRAIN: 'true',
        WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL:
          'http://127.0.0.1:3001/api/v1/system/metrics/queues/operational',
        WEBHOOK_LOAD_VERIFY_DRAIN_INTERVAL_MS: '999',
      }),
    ).toThrow('must be at least 1000');
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_DRAIN_LAG_TARGET_SEC: '5',
      }),
    ).toThrow('requires WEBHOOK_LOAD_VERIFY_DRAIN=true');

    const config = loadWebhookIngressLoadConfig({
      ...baseEnv(1),
      WEBHOOK_LOAD_VERIFY_DATABASE_URL: 'postgresql://read_user:secret@db.internal/maxim',
      WEBHOOK_LOAD_VERIFY_DRAIN: 'true',
      WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL:
        'http://127.0.0.1:3001/api/v1/system/metrics/queues/operational',
      WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_AUTHORIZATION: 'InitData private-auth',
      WEBHOOK_LOAD_VERIFY_DRAIN_LAG_TARGET_SEC: '7.5',
      WEBHOOK_LOAD_VERIFY_DRAIN_HEALTHY_SAMPLES: '4',
      WEBHOOK_LOAD_VERIFY_DRAIN_TIMEOUT_SEC: '90',
      WEBHOOK_LOAD_VERIFY_DRAIN_INTERVAL_MS: '6000',
    });

    expect(config.verification.mode).toBe('database');
    expect(config.drainVerification).toEqual({
      enabled: true,
      metrics: {
        mode: 'metrics',
        metricsUrl: 'http://127.0.0.1:3001/api/v1/system/metrics/queues/operational',
        authorization: 'InitData private-auth',
      },
      queueLagTargetSec: 7.5,
      healthySamples: 4,
      timeoutSec: 90,
      intervalMs: 6_000,
    });
  });

  it('rate-limits legacy full metrics verification while keeping database polling fast', () => {
    expect(
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_METRICS_URL: 'http://127.0.0.1:3001/api/v1/system/dashboard',
      }).verificationIntervalMs,
    ).toBe(15_000);
    expect(() =>
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_METRICS_URL: 'http://127.0.0.1:3001/api/v1/system/dashboard',
        WEBHOOK_LOAD_VERIFY_INTERVAL_MS: '1000',
      }),
    ).toThrow('must be at least 15000 for metrics mode');
    expect(
      loadWebhookIngressLoadConfig({
        ...baseEnv(1),
        WEBHOOK_LOAD_VERIFY_DATABASE_URL: 'postgresql://read_user:secret@db.internal/maxim',
      }).verificationIntervalMs,
    ).toBe(1_000);
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

    const metricsAuthorization = 'InitData do-not-print-this-token';
    const metricsRendered = JSON.stringify(
      renderSafeConfig(
        loadWebhookIngressLoadConfig({
          ...baseEnv(1),
          WEBHOOK_LOAD_VERIFY_DATABASE_URL: 'postgresql://read_user:db-secret@db.internal/maxim',
          WEBHOOK_LOAD_VERIFY_DRAIN: 'true',
          WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL:
            'http://127.0.0.1:3001/api/v1/system/metrics/queues/operational',
          WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_AUTHORIZATION: metricsAuthorization,
        }),
      ),
    );
    expect(metricsRendered).not.toContain(metricsAuthorization);
    expect(metricsRendered).not.toContain('metrics/queues/operational');
    expect(metricsRendered).toContain('"drainVerification":{"enabled":true');
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

describe('webhook ingress load-test throughput gate', () => {
  it('measures throughput against configured duration or a longer elapsed window', () => {
    expect(
      evaluatePhaseThroughput({
        attemptedRequests: 95,
        configuredRps: 100,
        configuredDurationMs: 1_000,
        elapsedMs: 900,
        minimumThroughputRatio: 0.95,
        deadlineExceeded: false,
      }),
    ).toEqual({ achievedRps: 95, throughputRatio: 0.95, throughputPassed: true });
    expect(
      evaluatePhaseThroughput({
        attemptedRequests: 100,
        configuredRps: 100,
        configuredDurationMs: 1_000,
        elapsedMs: 2_000,
        minimumThroughputRatio: 0.95,
        deadlineExceeded: false,
      }),
    ).toEqual({ achievedRps: 50, throughputRatio: 0.5, throughputPassed: false });
    expect(
      evaluateWebhookLoadAcceptance({
        ack: { errors: 0, p99Ms: 100 },
        ackP99TargetMs: 2_000,
        phases: [{ throughputPassed: false }],
        verification: null,
        drainVerification: null,
      }),
    ).toMatchObject({ passed: false, ackPassed: true, throughputPassed: false });
  });

  it('cancels a throttled gate and in-flight request at the hard phase deadline', async () => {
    const config = loadWebhookIngressLoadConfig({
      ...baseEnv(1),
      WEBHOOK_LOAD_DURATION_SEC: '0.1',
      WEBHOOK_LOAD_RPS: '100',
      WEBHOOK_LOAD_MIRROR_COUNTS: '1',
      WEBHOOK_LOAD_MAX_IN_FLIGHT: '1',
      WEBHOOK_LOAD_REQUEST_TIMEOUT_MS: '1000',
      WEBHOOK_LOAD_ACK_P99_TARGET_MS: '50',
    });
    const [plan] = buildWebhookLoadPlan(config);
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const rejectForAbort = () => {
          const error = new Error('phase aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) {
          rejectForAbort();
        } else {
          signal?.addEventListener('abort', rejectForAbort, { once: true });
        }
      });
    });

    try {
      const phase = await runPhase({
        config,
        plan: plan!,
        phaseIndex: 0,
        firstSequence: 0,
        timestampBaseMs: Date.now(),
        gate: new RequestGate(1),
        attemptedDedupKeys: new Set(),
        attemptedSemanticKeys: new Set(),
      });

      expect(phase.result).toMatchObject({
        plannedRequests: 10,
        attemptedRequests: 1,
        attemptedSemanticEvents: 1,
        deadlineExceeded: true,
        throughputPassed: false,
        minimumThroughputRatio: 0.95,
      });
      expect(phase.result.elapsedMs).toBeLessThan(1_000);
      expect(phase.result.throughputRatio).toBeLessThan(0.2);
      expect(phase.result.ack.transportErrors).toEqual({ PHASE_DEADLINE: 1 });
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: 'error' }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('webhook ingress load-test metrics', () => {
  it('refuses metrics redirects before an authorization header can cross origins', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          canonicalExecution: { receipts: 0, executionClaims: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    try {
      await expect(
        readMetricsPayload({
          mode: 'metrics',
          metricsUrl: 'https://staging.example.test/api/v1/system/dashboard',
          authorization: 'InitData private-auth',
        }),
      ).resolves.toEqual({
        canonicalExecution: { receipts: 0, executionClaims: 0 },
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://staging.example.test/api/v1/system/dashboard',
        expect.objectContaining({
          method: 'GET',
          redirect: 'error',
          headers: { authorization: 'InitData private-auth' },
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

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

  it('bounds legacy metrics verification by its configured timeout', async () => {
    const config = loadWebhookIngressLoadConfig({
      ...baseEnv(1),
      WEBHOOK_LOAD_VERIFY_METRICS_URL: 'http://127.0.0.1:3001/api/v1/system/dashboard',
      WEBHOOK_LOAD_VERIFY_TIMEOUT_SEC: '0.05',
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          canonicalExecution: { receipts: 10, executionClaims: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const startedAt = performance.now();

    try {
      await expect(
        verifyViaMetrics({
          config,
          baseline: { receipts: 10, executionClaims: 10 },
          expectedReceipts: 1,
          expectedExecutionClaims: 1,
        }),
      ).resolves.toMatchObject({ verified: false, receipts: 0, executionClaims: 0 });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not accept legacy metrics counters returned after the deadline', async () => {
    const config = loadWebhookIngressLoadConfig({
      ...baseEnv(1),
      WEBHOOK_LOAD_VERIFY_METRICS_URL: 'http://127.0.0.1:3001/api/v1/system/dashboard',
      WEBHOOK_LOAD_VERIFY_TIMEOUT_SEC: '0.02',
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(
        JSON.stringify({
          canonicalExecution: { receipts: 11, executionClaims: 11 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    try {
      await expect(
        verifyViaMetrics({
          config,
          baseline: { receipts: 10, executionClaims: 10 },
          expectedReceipts: 1,
          expectedExecutionClaims: 1,
        }),
      ).resolves.toMatchObject({ verified: false, receipts: 1, executionClaims: 1 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects exact database counts returned after the deadline and bounds the query', async () => {
    const config = loadWebhookIngressLoadConfig({
      ...baseEnv(1),
      WEBHOOK_LOAD_VERIFY_DATABASE_URL: 'postgresql://read_user:secret@db.internal/maxim',
      WEBHOOK_LOAD_VERIFY_TIMEOUT_SEC: '1',
    });
    let nowMs = 0;
    const query = jest.fn(
      async (request: { text: string; values?: unknown[]; query_timeout?: number }) => {
        if (request.text.startsWith('WITH run_receipts')) {
          nowMs = 1_500;
          return { rows: [{ receipts: 1, execution_claims: 1 }] };
        }
        return { rows: [] };
      },
    );
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      query,
      end: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      verifyViaDatabase(
        {
          config,
          attemptedDedupKeys: ['bot-1:update-1'],
          expectedExecutionClaims: 1,
        },
        { client: client as never, now: () => nowMs },
      ),
    ).resolves.toMatchObject({
      verified: false,
      receipts: 1,
      executionClaims: 1,
    });

    const timeoutGuard = query.mock.calls
      .map(([request]) => request)
      .find(({ text }) => text.includes("set_config('statement_timeout'"));
    const exactQuery = query.mock.calls
      .map(([request]) => request)
      .find(({ text }) => text.startsWith('WITH run_receipts'));
    expect(timeoutGuard).toMatchObject({ values: ['1000ms'], query_timeout: 1_000 });
    expect(exactQuery).toMatchObject({ query_timeout: 1_000 });
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('caps exact database polling sleep at the remaining verification budget', async () => {
    const config = loadWebhookIngressLoadConfig({
      ...baseEnv(1),
      WEBHOOK_LOAD_VERIFY_DATABASE_URL: 'postgresql://read_user:secret@db.internal/maxim',
      WEBHOOK_LOAD_VERIFY_TIMEOUT_SEC: '0.05',
    });
    let nowMs = 0;
    const wait = jest.fn(async (durationMs: number) => {
      nowMs += durationMs;
    });
    const query = jest.fn(
      async (request: { text: string; values?: unknown[]; query_timeout?: number }) =>
        request.text.startsWith('WITH run_receipts')
          ? { rows: [{ receipts: 0, execution_claims: 0 }] }
          : { rows: [] },
    );
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      query,
      end: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      verifyViaDatabase(
        {
          config,
          attemptedDedupKeys: ['bot-1:update-1'],
          expectedExecutionClaims: 1,
        },
        { client: client as never, now: () => nowMs, wait },
      ),
    ).resolves.toMatchObject({ verified: false, receipts: 0, executionClaims: 0 });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(50);
    expect(
      query.mock.calls.filter(([request]) => request.text.startsWith('WITH run_receipts')),
    ).toHaveLength(1);
    expect(client.end).toHaveBeenCalledTimes(1);
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

  it('extracts lag and pending webhook/action pressure from operational metrics shapes', () => {
    expect(
      extractQueueDrainMetrics({
        queues: {
          effectiveLagSec: 12,
          webhookDefaultShards: {
            'moderation-default-0': {
              waiting: 2,
              prioritized: 1,
              active: 1,
              delayed: 3,
            },
            'moderation-default-1': {
              waiting: 1,
              prioritized: 0,
              active: 0,
              delayed: 0,
            },
          },
          actions: { waiting: 1, prioritized: 2, active: 1, delayed: 0 },
        },
      }),
    ).toEqual({ queueLagSec: 12, webhookDefaultPending: 8, actionPending: 4 });
    expect(
      extractQueueDrainMetrics({
        data: {
          effectiveLagSec: 4,
          webhookDefaultShards: {
            'moderation-default-0': {
              waiting: 0,
              prioritized: 0,
              active: 0,
              delayed: 0,
            },
          },
          actions: { waiting: 0, prioritized: 0, active: 0, delayed: 1 },
        },
      }),
    ).toEqual({ queueLagSec: 4, webhookDefaultPending: 0, actionPending: 1 });
    expect(() =>
      extractQueueDrainMetrics({
        queues: {
          effectiveLagSec: 1,
          webhookDefaultShards: {},
          actions: { waiting: 0, prioritized: 0, active: 0, delayed: 0 },
        },
      }),
    ).toThrow('queue lag and pending counters');
  });

  it('requires lag and both queue pressures to return to target or baseline', () => {
    const baseline = { queueLagSec: 2, webhookDefaultPending: 2, actionPending: 1 };

    expect(
      evaluateQueueDrainHealth({
        baseline,
        queueLagTargetSec: 10,
        sample: { queueLagSec: 10, webhookDefaultPending: 2, actionPending: 1 },
      }),
    ).toEqual({
      healthy: true,
      queueLagHealthy: true,
      webhookDefaultPressureHealthy: true,
      actionPressureHealthy: true,
    });
    expect(
      evaluateQueueDrainHealth({
        baseline,
        queueLagTargetSec: 10,
        sample: { queueLagSec: 11, webhookDefaultPending: 3, actionPending: 2 },
      }),
    ).toEqual({
      healthy: false,
      queueLagHealthy: false,
      webhookDefaultPressureHealthy: false,
      actionPressureHealthy: false,
    });
  });

  it('passes only after the configured number of consecutive healthy drain samples', async () => {
    let nowMs = 0;
    const samples = [
      { queueLagSec: 20, webhookDefaultPending: 5, actionPending: 3 },
      { queueLagSec: 5, webhookDefaultPending: 2, actionPending: 1 },
      { queueLagSec: 4, webhookDefaultPending: 3, actionPending: 1 },
      { queueLagSec: 3, webhookDefaultPending: 2, actionPending: 1 },
      { queueLagSec: 2, webhookDefaultPending: 1, actionPending: 1 },
      { queueLagSec: 1, webhookDefaultPending: 0, actionPending: 0 },
    ];

    const result = await waitForQueueDrain({
      baseline: { queueLagSec: 0, webhookDefaultPending: 2, actionPending: 1 },
      queueLagTargetSec: 10,
      requiredHealthySamples: 3,
      timeoutMs: 40_000,
      intervalMs: 5_000,
      now: () => nowMs,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
      readSnapshot: async () => samples.shift()!,
    });

    expect(result).toMatchObject({
      verified: true,
      timedOut: false,
      samples: 6,
      consecutiveHealthySamples: 3,
      consecutiveHealthyForSec: 10,
      lastSample: { queueLagSec: 1, webhookDefaultPending: 0, actionPending: 0 },
    });
  });

  it('fails drain verification on bounded timeout even when ACK acceptance passed', async () => {
    let nowMs = 0;
    const result = await waitForQueueDrain({
      baseline: { queueLagSec: 0, webhookDefaultPending: 0, actionPending: 0 },
      queueLagTargetSec: 10,
      requiredHealthySamples: 3,
      timeoutMs: 12_500,
      intervalMs: 5_000,
      now: () => nowMs,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
      readSnapshot: async () => ({
        queueLagSec: 12,
        webhookDefaultPending: 1,
        actionPending: 1,
      }),
    });
    const acceptance = evaluateWebhookLoadAcceptance({
      ack: { errors: 0, p99Ms: 100 },
      ackP99TargetMs: 2_000,
      phases: [{ throughputPassed: true }],
      verification: { verified: true },
      drainVerification: result,
    });

    expect(result).toMatchObject({
      verified: false,
      timedOut: true,
      samples: 3,
      consecutiveHealthySamples: 0,
    });
    expect(acceptance).toEqual({
      passed: false,
      ackPassed: true,
      throughputPassed: true,
      receiptAndClaimVerificationPassed: true,
      endToEndDrainPassed: false,
    });
  });
});
