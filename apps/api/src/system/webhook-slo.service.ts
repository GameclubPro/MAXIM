import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  WebhookIngressMetricsService,
  type WebhookIngressMetricsSnapshot,
} from './webhook-ingress-metrics.service';

export type WebhookSloSnapshot = {
  status: 'healthy' | 'warning' | 'critical';
  windowSec: number;
  targetProcessingMs: number;
  totalEvents: number;
  processedEvents: number;
  failedEvents: number;
  sampledProcessedEvents: number;
  p95ProcessingMs: number | null;
  p99ProcessingMs: number | null;
  underTargetRatio: number | null;
  oldestUnprocessedLagSec: number;
  oldestUnprocessedEventId: string | null;
  lastProcessedAt: string | null;
  ingress: WebhookIngressMetricsSnapshot;
  enqueue: WebhookEnqueueSloSnapshot;
  canonicalExecution: WebhookCanonicalExecutionSloSnapshot;
  generatedAt: string;
};

export type WebhookCanonicalExecutionSloSnapshot = {
  receipts: number;
  executionClaims: number;
  claimsPerReceiptRatio: number | null;
};

export type WebhookEnqueueSloSnapshot = {
  targetMs: number;
  sampledEvents: number;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  underTargetRatio: number | null;
  oldestPendingLagSec: number;
  oldestPendingEventId: string | null;
  lastQueuedAt: string | null;
};

const DEFAULT_WEBHOOK_SLO_WINDOW_SEC = 15 * 60;
const DEFAULT_WEBHOOK_SLO_TARGET_MS = 400;
const DEFAULT_WEBHOOK_ENQUEUE_SLO_TARGET_MS = 1_000;
const DEFAULT_WEBHOOK_SLO_SAMPLE_LIMIT = 5_000;
const WARNING_UNDER_TARGET_RATIO = 0.95;
const CRITICAL_UNDER_TARGET_RATIO = 0.85;
const WARNING_UNPROCESSED_LAG_SEC = 5;
const CRITICAL_UNPROCESSED_LAG_SEC = 15;
const WARNING_INGRESS_UNDER_TARGET_RATIO = 0.99;
const CRITICAL_INGRESS_FAILURE_COUNT = 5;

@Injectable()
export class WebhookSloService {
  private readonly windowSec: number;
  private readonly targetProcessingMs: number;
  private readonly targetEnqueueMs: number;
  private readonly sampleLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    @Optional() private readonly webhookIngressMetricsService?: WebhookIngressMetricsService,
  ) {
    this.windowSec = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_SLO_WINDOW_SEC'),
      DEFAULT_WEBHOOK_SLO_WINDOW_SEC,
    );
    this.targetProcessingMs = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_SLO_TARGET_MS'),
      DEFAULT_WEBHOOK_SLO_TARGET_MS,
    );
    this.targetEnqueueMs = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_ENQUEUE_SLO_TARGET_MS'),
      DEFAULT_WEBHOOK_ENQUEUE_SLO_TARGET_MS,
    );
    this.sampleLimit = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT'),
      DEFAULT_WEBHOOK_SLO_SAMPLE_LIMIT,
    );
  }

  async getSnapshot(): Promise<WebhookSloSnapshot> {
    const nowMs = Date.now();
    const from = new Date(nowMs - this.windowSec * 1_000);
    const [
      totalEvents,
      processedEvents,
      failedEvents,
      processedSample,
      enqueueSample,
      oldestUnprocessed,
      oldestPendingEnqueue,
      lastProcessed,
      lastQueued,
      executionClaims,
      ingress,
    ] = await Promise.all([
      this.prisma.webhookEvent.count({
        where: {
          createdAt: { gte: from },
        },
      }),
      this.prisma.webhookEvent.count({
        where: {
          createdAt: { gte: from },
          status: WebhookStatus.PROCESSED,
        },
      }),
      this.prisma.webhookEvent.count({
        where: {
          createdAt: { gte: from },
          status: WebhookStatus.FAILED,
        },
      }),
      this.prisma.webhookEvent.findMany({
        where: {
          createdAt: { gte: from },
          status: WebhookStatus.PROCESSED,
          processedAt: { not: null },
        },
        select: {
          createdAt: true,
          processedAt: true,
        },
        orderBy: {
          processedAt: 'desc',
        },
        take: this.sampleLimit,
      }),
      this.prisma.webhookEvent.findMany({
        where: {
          createdAt: { gte: from },
          queuedAt: { not: null },
        },
        select: {
          createdAt: true,
          queuedAt: true,
        },
        orderBy: {
          queuedAt: 'desc',
        },
        take: this.sampleLimit,
      }),
      this.prisma.webhookEvent.findFirst({
        where: {
          createdAt: { gte: from },
          status: {
            in: [WebhookStatus.RECEIVED, WebhookStatus.QUEUED],
          },
        },
        select: {
          id: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      }),
      this.prisma.webhookEvent.findFirst({
        where: {
          createdAt: { gte: from },
          status: WebhookStatus.RECEIVED,
          queuedAt: null,
        },
        select: {
          id: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      }),
      this.prisma.webhookEvent.findFirst({
        where: {
          createdAt: { gte: from },
          status: WebhookStatus.PROCESSED,
          processedAt: { not: null },
        },
        select: {
          processedAt: true,
        },
        orderBy: {
          processedAt: 'desc',
        },
      }),
      this.prisma.webhookEvent.findFirst({
        where: {
          createdAt: { gte: from },
          queuedAt: { not: null },
        },
        select: {
          queuedAt: true,
        },
        orderBy: {
          queuedAt: 'desc',
        },
      }),
      this.prisma.webhookExecutionClaim.count({
        where: {
          kind: 'EXECUTION',
          createdAt: { gte: from },
        },
      }),
      this.webhookIngressMetricsService
        ? this.webhookIngressMetricsService.getSnapshot({ windowSec: this.windowSec })
        : Promise.resolve(this.emptyIngressSnapshot()),
    ]);

    const durations = processedSample
      .map((event) => {
        if (!event.processedAt) {
          return null;
        }
        return Math.max(0, event.processedAt.getTime() - event.createdAt.getTime());
      })
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((left, right) => left - right);
    const p95ProcessingMs = this.percentile(durations, 0.95);
    const p99ProcessingMs = this.percentile(durations, 0.99);
    const underTargetRatio =
      durations.length > 0
        ? Number(
            (
              durations.filter((durationMs) => durationMs <= this.targetProcessingMs).length /
              durations.length
            ).toFixed(3),
          )
        : null;
    const enqueueDurations = enqueueSample
      .map((event) => {
        if (!event.queuedAt) {
          return null;
        }
        return Math.max(0, event.queuedAt.getTime() - event.createdAt.getTime());
      })
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((left, right) => left - right);
    const enqueueUnderTargetRatio =
      enqueueDurations.length > 0
        ? Number(
            (
              enqueueDurations.filter((durationMs) => durationMs <= this.targetEnqueueMs).length /
              enqueueDurations.length
            ).toFixed(3),
          )
        : null;
    const oldestUnprocessedLagSec = oldestUnprocessed
      ? Number(Math.max(0, (nowMs - oldestUnprocessed.createdAt.getTime()) / 1_000).toFixed(3))
      : 0;
    const oldestPendingEnqueueLagSec = oldestPendingEnqueue
      ? Number(Math.max(0, (nowMs - oldestPendingEnqueue.createdAt.getTime()) / 1_000).toFixed(3))
      : 0;
    const status = this.resolveStatus({
      failedEvents,
      underTargetRatio,
      oldestUnprocessedLagSec,
      p95ProcessingMs,
      p99ProcessingMs,
      ingress,
    });

    return {
      status,
      windowSec: this.windowSec,
      targetProcessingMs: this.targetProcessingMs,
      totalEvents,
      processedEvents,
      failedEvents,
      sampledProcessedEvents: durations.length,
      p95ProcessingMs,
      p99ProcessingMs,
      underTargetRatio,
      oldestUnprocessedLagSec,
      oldestUnprocessedEventId: oldestUnprocessed?.id ?? null,
      lastProcessedAt: lastProcessed?.processedAt?.toISOString() ?? null,
      ingress,
      enqueue: {
        targetMs: this.targetEnqueueMs,
        sampledEvents: enqueueDurations.length,
        p95LatencyMs: this.percentile(enqueueDurations, 0.95),
        p99LatencyMs: this.percentile(enqueueDurations, 0.99),
        underTargetRatio: enqueueUnderTargetRatio,
        oldestPendingLagSec: oldestPendingEnqueueLagSec,
        oldestPendingEventId: oldestPendingEnqueue?.id ?? null,
        lastQueuedAt: lastQueued?.queuedAt?.toISOString() ?? null,
      },
      canonicalExecution: {
        receipts: totalEvents,
        executionClaims,
        claimsPerReceiptRatio:
          totalEvents > 0 ? Number((executionClaims / totalEvents).toFixed(3)) : null,
      },
      generatedAt: new Date(nowMs).toISOString(),
    };
  }

  private resolveStatus(params: {
    failedEvents: number;
    underTargetRatio: number | null;
    oldestUnprocessedLagSec: number;
    p95ProcessingMs: number | null;
    p99ProcessingMs: number | null;
    ingress: WebhookIngressMetricsSnapshot;
  }): WebhookSloSnapshot['status'] {
    if (
      params.oldestUnprocessedLagSec >= CRITICAL_UNPROCESSED_LAG_SEC ||
      (params.underTargetRatio !== null && params.underTargetRatio < CRITICAL_UNDER_TARGET_RATIO) ||
      (params.p99ProcessingMs !== null && params.p99ProcessingMs > 1_000) ||
      params.ingress.failedReceipts >= CRITICAL_INGRESS_FAILURE_COUNT ||
      (params.ingress.p99LatencyMs !== null &&
        params.ingress.p99LatencyMs > params.ingress.targetMs)
    ) {
      return 'critical';
    }

    if (
      params.failedEvents > 0 ||
      params.oldestUnprocessedLagSec >= WARNING_UNPROCESSED_LAG_SEC ||
      (params.underTargetRatio !== null && params.underTargetRatio < WARNING_UNDER_TARGET_RATIO) ||
      (params.p95ProcessingMs !== null && params.p95ProcessingMs > this.targetProcessingMs) ||
      !params.ingress.available ||
      params.ingress.failedReceipts > 0 ||
      (params.ingress.underTargetRatio !== null &&
        params.ingress.underTargetRatio < WARNING_INGRESS_UNDER_TARGET_RATIO) ||
      (params.ingress.p95LatencyMs !== null &&
        params.ingress.p95LatencyMs > params.ingress.targetMs)
    ) {
      return 'warning';
    }

    return 'healthy';
  }

  private percentile(values: readonly number[], percentile: number): number | null {
    if (values.length === 0) {
      return null;
    }
    const index = Math.min(
      values.length - 1,
      Math.max(0, Math.ceil(values.length * percentile) - 1),
    );
    return Math.trunc(values[index] ?? 0);
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallback;
    }
    return Math.max(1, Math.trunc(numericValue));
  }

  private emptyIngressSnapshot(): WebhookIngressMetricsSnapshot {
    return {
      available: true,
      targetMs: 2_000,
      attemptedReceipts: 0,
      persistedReceipts: 0,
      failedReceipts: 0,
      sampledReceipts: 0,
      p95LatencyMs: null,
      p99LatencyMs: null,
      underTargetRatio: null,
      bots: {},
    };
  }
}
