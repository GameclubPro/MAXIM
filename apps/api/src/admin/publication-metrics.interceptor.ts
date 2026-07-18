import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';

const PUBLICATION_GET_METRIC_WINDOW_MS = 60_000;
const MAX_PUBLICATION_GET_METRIC_BUCKETS = 128;

type PublicationRequestMetric = {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  outcome: 'client_error' | 'ok' | 'server_error';
};

type PublicationGetMetricBucket = {
  lastLoggedAtMs: number;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
};

@Injectable()
export class PublicationMetricsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PublicationMetricsInterceptor.name);
  private readonly getSuccessBuckets = new Map<string, PublicationGetMetricBucket>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const startedAt = Date.now();
    let errorStatus: number | null = null;

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          errorStatus = this.readErrorStatus(error) ?? 500;
        },
      }),
      finalize(() => {
        const statusCode = errorStatus ?? reply.statusCode;
        const metric: PublicationRequestMetric = {
          route: this.readRouteTemplate(request),
          method: request.method.toUpperCase(),
          statusCode,
          durationMs: Math.max(0, Date.now() - startedAt),
          outcome: statusCode >= 500 ? 'server_error' : statusCode >= 400 ? 'client_error' : 'ok',
        };
        if (metric.method === 'GET' && metric.outcome === 'ok') {
          this.recordSuccessfulGet(metric);
          return;
        }
        this.logger.log(metric, 'Publication request completed');
      }),
    );
  }

  private recordSuccessfulGet(metric: PublicationRequestMetric): void {
    const now = Date.now();
    const key = `${metric.route}\u0000${metric.statusCode}`;
    const existing = this.getSuccessBuckets.get(key);
    if (!existing) {
      this.evictOldestGetBucketIfNeeded();
      this.getSuccessBuckets.set(key, {
        lastLoggedAtMs: now,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
      });
      this.logGetAggregate(metric, 1, metric.durationMs, metric.durationMs, 0);
      return;
    }

    existing.count += 1;
    existing.totalDurationMs += metric.durationMs;
    existing.maxDurationMs = Math.max(existing.maxDurationMs, metric.durationMs);
    const windowMs = now - existing.lastLoggedAtMs;
    if (windowMs < PUBLICATION_GET_METRIC_WINDOW_MS) {
      return;
    }

    this.logGetAggregate(
      metric,
      existing.count,
      Math.round(existing.totalDurationMs / existing.count),
      existing.maxDurationMs,
      windowMs,
    );
    existing.lastLoggedAtMs = now;
    existing.count = 0;
    existing.totalDurationMs = 0;
    existing.maxDurationMs = 0;
  }

  private logGetAggregate(
    metric: PublicationRequestMetric,
    requestCount: number,
    averageDurationMs: number,
    maxDurationMs: number,
    windowMs: number,
  ): void {
    this.logger.log(
      {
        ...metric,
        durationMs: averageDurationMs,
        requestCount,
        maxDurationMs,
        windowMs,
      },
      'Publication request completed',
    );
  }

  private evictOldestGetBucketIfNeeded(): void {
    if (this.getSuccessBuckets.size < MAX_PUBLICATION_GET_METRIC_BUCKETS) {
      return;
    }
    const oldestKey = this.getSuccessBuckets.keys().next().value as string | undefined;
    if (oldestKey) {
      this.getSuccessBuckets.delete(oldestKey);
    }
  }

  private readRouteTemplate(request: FastifyRequest): string {
    const route = request.routeOptions?.url;
    return typeof route === 'string' && route ? route.split('?', 1)[0] : '/v1/publications/unknown';
  }

  private readErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') {
      return null;
    }
    const getStatus = (error as { getStatus?: unknown }).getStatus;
    if (typeof getStatus === 'function') {
      const status = getStatus.call(error);
      return typeof status === 'number' ? status : null;
    }
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
  }
}
