import { describe, expect, it } from 'vitest';
import { systemDashboardWebhookSloSchema } from '../src/system.js';

const generatedAt = '2026-08-15T12:00:00.000Z';

function createWebhookSloSnapshot() {
  return {
    status: 'healthy' as const,
    windowSec: 900,
    targetProcessingMs: 400,
    totalEvents: 2,
    processedEvents: 2,
    failedEvents: 0,
    sampleLimit: 2,
    sampledProcessedEvents: 2,
    processedSampleTruncated: true,
    processedSampledFrom: '2026-08-15T11:59:58.000Z',
    p95ProcessingMs: 200,
    p99ProcessingMs: 200,
    underTargetRatio: 1,
    oldestUnprocessedLagSec: 0,
    oldestUnprocessedEventId: null,
    lastProcessedAt: '2026-08-15T11:59:59.000Z',
    enqueue: {
      targetMs: 1_000,
      sampledEvents: 1,
      sampleTruncated: false,
      sampledFrom: '2026-08-15T11:59:58.500Z',
      p95LatencyMs: 100,
      p99LatencyMs: 100,
      underTargetRatio: 1,
      oldestPendingLagSec: 0,
      oldestPendingEventId: null,
      lastQueuedAt: '2026-08-15T11:59:58.500Z',
    },
    generatedAt,
  };
}

function createLegacyWebhookSloSnapshot() {
  return {
    status: 'healthy' as const,
    windowSec: 900,
    targetProcessingMs: 400,
    totalEvents: 1,
    processedEvents: 1,
    failedEvents: 0,
    sampledProcessedEvents: 1,
    p95ProcessingMs: 200,
    p99ProcessingMs: 200,
    underTargetRatio: 1,
    oldestUnprocessedLagSec: 0,
    oldestUnprocessedEventId: null,
    lastProcessedAt: '2026-08-15T11:59:59.000Z',
    enqueue: {
      targetMs: 1_000,
      sampledEvents: 1,
      p95LatencyMs: 100,
      p99LatencyMs: 100,
      underTargetRatio: 1,
      oldestPendingLagSec: 0,
      oldestPendingEventId: null,
      lastQueuedAt: '2026-08-15T11:59:58.500Z',
    },
    generatedAt,
  };
}

function expectRejectedAt(value: unknown, path: Array<string | number>) {
  const result = systemDashboardWebhookSloSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  }
}

describe('system dashboard webhook SLO contract', () => {
  it('preserves explicit sample truncation metadata', () => {
    expect(systemDashboardWebhookSloSchema.parse(createWebhookSloSnapshot())).toMatchObject({
      sampleLimit: 2,
      sampledProcessedEvents: 2,
      processedSampleTruncated: true,
      processedSampledFrom: '2026-08-15T11:59:58.000Z',
      enqueue: {
        sampledEvents: 1,
        sampleTruncated: false,
        sampledFrom: '2026-08-15T11:59:58.500Z',
      },
    });
  });

  it('accepts legacy snapshots without truncation claims', () => {
    const parsed = systemDashboardWebhookSloSchema.parse(createLegacyWebhookSloSnapshot());

    expect(parsed).not.toHaveProperty('sampleLimit');
    expect(parsed).not.toHaveProperty('processedSampleTruncated');
    expect(parsed).not.toHaveProperty('processedSampledFrom');
    expect(parsed.enqueue).not.toHaveProperty('sampleTruncated');
    expect(parsed.enqueue).not.toHaveProperty('sampledFrom');
  });

  it('rejects inconsistent processed sample metadata', () => {
    expectRejectedAt(
      {
        ...createWebhookSloSnapshot(),
        sampleLimit: 3,
      },
      ['processedSampleTruncated'],
    );
    expectRejectedAt(
      {
        ...createWebhookSloSnapshot(),
        sampleLimit: 1,
        processedSampleTruncated: false,
      },
      ['sampledProcessedEvents'],
    );
    expectRejectedAt(
      {
        ...createWebhookSloSnapshot(),
        sampledProcessedEvents: 0,
      },
      ['processedSampledFrom'],
    );
  });

  it('rejects inconsistent enqueue sample metadata', () => {
    expectRejectedAt(
      {
        ...createWebhookSloSnapshot(),
        enqueue: {
          ...createWebhookSloSnapshot().enqueue,
          sampleTruncated: true,
        },
      },
      ['enqueue', 'sampleTruncated'],
    );
    expectRejectedAt(
      {
        ...createWebhookSloSnapshot(),
        enqueue: {
          ...createWebhookSloSnapshot().enqueue,
          sampledEvents: 0,
        },
      },
      ['enqueue', 'sampledFrom'],
    );
  });
});
