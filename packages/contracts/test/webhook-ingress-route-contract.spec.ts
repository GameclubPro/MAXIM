import { describe, expect, it } from 'vitest';
import { systemDashboardWebhookIngressSloSchema } from '../src/system.js';

function createIngressSnapshot() {
  return {
    available: true,
    targetMs: 2_000,
    attemptedReceipts: 2,
    persistedReceipts: 2,
    failedReceipts: 0,
    rejectedReceipts: 0,
    sampledReceipts: 2,
    p95LatencyMs: 100,
    p99LatencyMs: 100,
    underTargetRatio: 1,
    bots: {},
  };
}

function createRouteMetrics() {
  return {
    attemptedRequests: 3,
    outcomes: {
      accepted: 1,
      authentication_rejected: 1,
      admission_rejected: 0,
      invalid_json: 0,
      invalid_payload: 1,
      payload_too_large: 0,
      timed_out: 0,
      failed: 0,
    },
    bots: {
      'bot-1': {
        attemptedRequests: 2,
        outcomes: {
          accepted: 1,
          authentication_rejected: 0,
          admission_rejected: 0,
          invalid_json: 0,
          invalid_payload: 1,
          payload_too_large: 0,
          timed_out: 0,
          failed: 0,
        },
      },
    },
  };
}

function expectRejectedAt(value: unknown, path: Array<string | number>) {
  const result = systemDashboardWebhookIngressSloSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  }
}

describe('system dashboard webhook ingress route contract', () => {
  it('defaults route metrics for snapshots from older API versions', () => {
    expect(systemDashboardWebhookIngressSloSchema.parse(createIngressSnapshot()).route).toEqual({
      attemptedRequests: 0,
      outcomes: {
        accepted: 0,
        authentication_rejected: 0,
        admission_rejected: 0,
        invalid_json: 0,
        invalid_payload: 0,
        payload_too_large: 0,
        timed_out: 0,
        failed: 0,
      },
      bots: {},
    });
  });

  it('preserves valid global and authenticated-bot route outcomes', () => {
    const route = createRouteMetrics();

    expect(
      systemDashboardWebhookIngressSloSchema.parse({
        ...createIngressSnapshot(),
        route,
      }).route,
    ).toEqual(route);
  });

  it('rejects a global outcome total that differs from attempted requests', () => {
    expectRejectedAt(
      {
        ...createIngressSnapshot(),
        route: {
          ...createRouteMetrics(),
          attemptedRequests: 4,
        },
      },
      ['route', 'attemptedRequests'],
    );
  });

  it('rejects an authenticated-bot outcome total that differs from attempted requests', () => {
    const route = createRouteMetrics();
    expectRejectedAt(
      {
        ...createIngressSnapshot(),
        route: {
          ...route,
          bots: {
            'bot-1': {
              ...route.bots['bot-1'],
              attemptedRequests: 3,
            },
          },
        },
      },
      ['route', 'bots', 'bot-1', 'attemptedRequests'],
    );
  });
});
