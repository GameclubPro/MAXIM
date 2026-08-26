import { Injectable, Logger } from '@nestjs/common';

const ACCESS_REJECTION_LOG_WINDOW_MS = 60_000;
const MAX_ACCESS_REJECTION_BUCKETS = 16;

export type MiniappAccessRejectionMetric = {
  scope: 'auth' | 'profile' | 'settings_screen';
  code: string;
  retryable: boolean;
  recovery: string;
};

type AccessRejectionBucket = {
  count: number;
  lastLoggedAtMs: number;
};

@Injectable()
export class MiniappAccessObservabilityService {
  private readonly logger = new Logger(MiniappAccessObservabilityService.name);
  private readonly buckets = new Map<string, AccessRejectionBucket>();

  recordRejection(metric: MiniappAccessRejectionMetric, nowMs = Date.now()): void {
    const key = `${metric.scope}\u0000${metric.code}`;
    const bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_ACCESS_REJECTION_BUCKETS) {
        return;
      }
      this.buckets.set(key, { count: 0, lastLoggedAtMs: nowMs });
      this.logAggregate(metric, 1, 0);
      return;
    }

    bucket.count += 1;
    const windowMs = Math.max(0, nowMs - bucket.lastLoggedAtMs);
    if (windowMs < ACCESS_REJECTION_LOG_WINDOW_MS) {
      return;
    }

    this.logAggregate(metric, bucket.count, windowMs);
    bucket.count = 0;
    bucket.lastLoggedAtMs = nowMs;
  }

  private logAggregate(
    metric: MiniappAccessRejectionMetric,
    rejectionCount: number,
    windowMs: number,
  ): void {
    this.logger.warn(
      {
        ...metric,
        rejectionCount,
        windowMs,
      },
      'Mini app access rejection aggregate',
    );
  }
}
