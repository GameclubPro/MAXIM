import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type WebhookSloSnapshot = {
  status: 'healthy' | 'warning' | 'critical';
  windowSec: number;
  targetProcessingMs: number;
  totalEvents: number;
  processedEvents: number;
  failedEvents: number;
  sampledProcessedEvents: number;
  p95ProcessingMs: number | null;
  underTargetRatio: number | null;
  oldestUnprocessedLagSec: number;
  oldestUnprocessedEventId: string | null;
  lastProcessedAt: string | null;
  generatedAt: string;
};

const DEFAULT_WEBHOOK_SLO_WINDOW_SEC = 15 * 60;
const DEFAULT_WEBHOOK_SLO_TARGET_MS = 1_000;
const DEFAULT_WEBHOOK_SLO_SAMPLE_LIMIT = 5_000;
const WARNING_UNDER_TARGET_RATIO = 0.95;
const CRITICAL_UNDER_TARGET_RATIO = 0.85;
const WARNING_UNPROCESSED_LAG_SEC = 5;
const CRITICAL_UNPROCESSED_LAG_SEC = 15;

@Injectable()
export class WebhookSloService {
  private readonly windowSec: number;
  private readonly targetProcessingMs: number;
  private readonly sampleLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.windowSec = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_SLO_WINDOW_SEC'),
      DEFAULT_WEBHOOK_SLO_WINDOW_SEC,
    );
    this.targetProcessingMs = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_SLO_TARGET_MS'),
      DEFAULT_WEBHOOK_SLO_TARGET_MS,
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
      oldestUnprocessed,
      lastProcessed,
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
    const underTargetRatio =
      durations.length > 0
        ? Number(
            (
              durations.filter((durationMs) => durationMs <= this.targetProcessingMs).length /
              durations.length
            ).toFixed(3),
          )
        : null;
    const oldestUnprocessedLagSec = oldestUnprocessed
      ? Number(Math.max(0, (nowMs - oldestUnprocessed.createdAt.getTime()) / 1_000).toFixed(3))
      : 0;
    const status = this.resolveStatus({
      failedEvents,
      underTargetRatio,
      oldestUnprocessedLagSec,
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
      underTargetRatio,
      oldestUnprocessedLagSec,
      oldestUnprocessedEventId: oldestUnprocessed?.id ?? null,
      lastProcessedAt: lastProcessed?.processedAt?.toISOString() ?? null,
      generatedAt: new Date(nowMs).toISOString(),
    };
  }

  private resolveStatus(params: {
    failedEvents: number;
    underTargetRatio: number | null;
    oldestUnprocessedLagSec: number;
  }): WebhookSloSnapshot['status'] {
    if (
      params.oldestUnprocessedLagSec >= CRITICAL_UNPROCESSED_LAG_SEC ||
      (params.underTargetRatio !== null && params.underTargetRatio < CRITICAL_UNDER_TARGET_RATIO)
    ) {
      return 'critical';
    }

    if (
      params.failedEvents > 0 ||
      params.oldestUnprocessedLagSec >= WARNING_UNPROCESSED_LAG_SEC ||
      (params.underTargetRatio !== null && params.underTargetRatio < WARNING_UNDER_TARGET_RATIO)
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
}
