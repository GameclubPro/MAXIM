import { describe, expect, it } from 'vitest';
import {
  systemDashboardWebhookIngressSloSchema,
  systemDashboardWebhookMembershipCacheSloSchema,
} from '../src/system.js';

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

  it('preserves bounded privacy-safe membership observability', () => {
    const timing = {
      sampled: 4,
      p95DurationMs: 35,
      p99DurationMs: 50,
      overflowSamples: 0,
    };
    const parsed = systemDashboardWebhookIngressSloSchema.parse({
      ...createIngressSnapshot(),
      membershipCache: {
        precheck: { hit: 2, miss: 1, failOpen: 1, timing },
        lua: {
          applied: 1,
          superseded: 1,
          conflict: 1,
          retry: 1,
          exhausted: 0,
          failed: 1,
          timing,
        },
        budget: { completed: 3, timeout: 1, timing },
      },
      membershipTransition: {
        edgeAdvance: { calls: 4, affectedRows: 3, noOpCalls: 1, timing },
      },
    });

    expect(parsed.membershipCache?.precheck).toMatchObject({ hit: 2, miss: 1, failOpen: 1 });
    expect(parsed.membershipTransition?.edgeAdvance).toMatchObject({
      calls: 4,
      affectedRows: 3,
      noOpCalls: 1,
    });
    expect(
      systemDashboardWebhookMembershipCacheSloSchema.parse({
        status: 'warning',
        precheckFailOpen: { sampled: 20, affected: 3, ratio: 0.15 },
        luaConflict: { sampled: 20, affected: 2, ratio: 0.1 },
        luaTerminalFailure: { sampled: 20, affected: 0, ratio: 0 },
        budgetTimeout: { sampled: 20, affected: 3, ratio: 0.15 },
        thresholds: {
          warning: { minimumSamples: 20, minimumAffected: 3, ratio: 0.1 },
          critical: { minimumSamples: 50, minimumAffected: 10, ratio: 0.3 },
        },
      }),
    ).toMatchObject({ status: 'warning', budgetTimeout: { ratio: 0.15 } });
  });

  it('rejects internally inconsistent membership observability', () => {
    const invalidTiming = {
      sampled: 0,
      p95DurationMs: 35,
      p99DurationMs: 20,
      overflowSamples: 1,
    };
    const ingress = systemDashboardWebhookIngressSloSchema.safeParse({
      ...createIngressSnapshot(),
      membershipCache: {
        precheck: { hit: 1, miss: 0, failOpen: 0, timing: invalidTiming },
        lua: {
          applied: 0,
          superseded: 0,
          conflict: 0,
          retry: 0,
          exhausted: 0,
          failed: 0,
          timing: invalidTiming,
        },
        budget: { completed: 0, timeout: 0, timing: invalidTiming },
      },
      membershipTransition: {
        edgeAdvance: { calls: 0, affectedRows: 0, noOpCalls: 1, timing: invalidTiming },
      },
    });
    expect(ingress.success).toBe(false);

    const invalidSignals = systemDashboardWebhookMembershipCacheSloSchema.safeParse({
      status: 'healthy',
      precheckFailOpen: { sampled: 20, affected: 21, ratio: 0.5 },
      luaConflict: { sampled: 0, affected: 0, ratio: 0 },
      luaTerminalFailure: { sampled: 20, affected: 0, ratio: 0 },
      budgetTimeout: { sampled: 20, affected: 0, ratio: 0 },
      thresholds: {
        warning: { minimumSamples: 20, minimumAffected: 3, ratio: 0.1 },
        critical: { minimumSamples: 50, minimumAffected: 10, ratio: 0.3 },
      },
    });
    expect(invalidSignals.success).toBe(false);
    if (!invalidSignals.success) {
      expect(invalidSignals.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining([
          'precheckFailOpen.affected',
          'precheckFailOpen.ratio',
          'luaConflict.ratio',
        ]),
      );
    }

    const invalidStatus = systemDashboardWebhookMembershipCacheSloSchema.safeParse({
      status: 'healthy',
      precheckFailOpen: { sampled: 20, affected: 3, ratio: 0.15 },
      luaConflict: { sampled: 20, affected: 0, ratio: 0 },
      luaTerminalFailure: { sampled: 20, affected: 0, ratio: 0 },
      budgetTimeout: { sampled: 20, affected: 0, ratio: 0 },
      thresholds: {
        warning: { minimumSamples: 20, minimumAffected: 3, ratio: 0.1 },
        critical: { minimumSamples: 10, minimumAffected: 2, ratio: 0.05 },
      },
    });
    expect(invalidStatus.success).toBe(false);
    if (!invalidStatus.success) {
      expect(invalidStatus.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['thresholds.critical', 'status']),
      );
    }
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
