import { createHash } from 'node:crypto';
import {
  marketplaceStatisticRowSchema,
  type MarketplaceStatisticRow,
} from '@maxim/contracts/marketplace-integration';

export const MARKETPLACE_HISTORY_DAYS = 90;
export const MARKETPLACE_HORIZON_TOLERANCE_MS = 15 * 60_000;
export type MarketplacePostSample = {
  messageId: string;
  publishedAt: Date;
  views: number | null;
  observedAt: Date | null;
  views24: number | null;
  captured24: Date | null;
  views48: number | null;
  captured48: Date | null;
};
export function parseMarketplacePost(
  row: Record<string, unknown>,
): { messageId: string; publishedAt: Date; views: number | null } | null {
  const body = object(row.body);
  const stat = object(row.stat);
  const rawId = body?.mid ?? row.message_id ?? row.messageId ?? row.id;
  if (typeof rawId !== 'string' || !rawId || rawId.length > 300) return null;
  const rawTime = row.timestamp ?? row.created_at ?? row.createdAt ?? body?.timestamp;
  const numeric =
    typeof rawTime === 'number'
      ? rawTime
      : typeof rawTime === 'string' && /^\d+$/u.test(rawTime)
        ? Number(rawTime)
        : NaN;
  const milliseconds = Number.isFinite(numeric)
    ? numeric < 1e12
      ? numeric * 1000
      : numeric
    : typeof rawTime === 'string'
      ? Date.parse(rawTime)
      : NaN;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    !Number.isFinite(new Date(milliseconds).getTime())
  )
    return null;
  const views =
    typeof stat?.views === 'number' &&
    Number.isInteger(stat.views) &&
    stat.views >= 0 &&
    stat.views <= 2147483647
      ? stat.views
      : null;
  return { messageId: rawId, publishedAt: new Date(milliseconds), views };
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function utcDay(value: Date): string {
  const result = new Date(value);
  result.setUTCHours(0, 0, 0, 0);
  return result.toISOString();
}
export function utcHour(value: Date): string {
  const result = new Date(value);
  result.setUTCMinutes(0, 0, 0);
  return result.toISOString();
}
export function validHorizon(
  post: MarketplacePostSample,
  horizon: 24 | 48,
): { views: number; observedAt: Date; delay: number } | null {
  const views = horizon === 24 ? post.views24 : post.views48;
  const observedAt = horizon === 24 ? post.captured24 : post.captured48;
  if (views === null || !observedAt) return null;
  const delay = observedAt.getTime() - post.publishedAt.getTime() - horizon * 3600_000;
  return delay >= 0 && delay <= MARKETPLACE_HORIZON_TOLERANCE_MS
    ? { views, observedAt, delay: Math.ceil(delay / 1000) }
    : null;
}
export function buildMarketplacePostBuckets(
  posts: MarketplacePostSample[],
  asOf: Date,
  complete: boolean,
): MarketplaceStatisticRow[] {
  const days = new Map<string, MarketplacePostSample[]>();
  const hours = new Map<string, number>();
  for (const post of posts) {
    const day = utcDay(post.publishedAt);
    days.set(day, [...(days.get(day) ?? []), post]);
    const hour = utcHour(post.publishedAt);
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
  }
  const rows: MarketplaceStatisticRow[] = [];
  for (const [bucket, values] of days) {
    for (const horizon of [0, 24, 48] as const) {
      const eligible = values.filter(
        (post) => post.publishedAt.getTime() + horizon * 3600_000 <= asOf.getTime(),
      );
      const samples = eligible.flatMap((post) => {
        if (horizon === 0)
          return post.views !== null && post.observedAt
            ? [{ views: post.views, observedAt: post.observedAt, delay: 0 }]
            : [];
        const sample = validHorizon(post, horizon);
        return sample ? [sample] : [];
      });
      rows.push({
        metric: 'REACH',
        bucket,
        horizon,
        posts: eligible.length,
        samples: samples.length,
        views: samples.reduce((sum, row) => sum + row.views, 0),
        observedAt: samples.length
          ? new Date(Math.max(...samples.map((row) => row.observedAt.getTime()))).toISOString()
          : null,
        incomplete: !complete || samples.length < eligible.length,
        maxDelaySeconds: samples.length ? Math.max(...samples.map((row) => row.delay)) : null,
      });
    }
  }
  for (const [bucket, count] of hours)
    rows.push({
      metric: 'PUBLICATION_HOUR',
      bucket,
      posts: count,
      complete,
      observedAt: asOf.toISOString(),
    });
  return rows;
}
export function canonicalMarketplaceRows(
  rows: MarketplaceStatisticRow[],
): MarketplaceStatisticRow[] {
  return rows
    .map((row) => marketplaceStatisticRowSchema.parse(row))
    .sort(
      (a, b) =>
        a.metric.localeCompare(b.metric) ||
        a.bucket.localeCompare(b.bucket) ||
        ('horizon' in a ? a.horizon : 0) - ('horizon' in b ? b.horizon : 0),
    );
}
export function marketplaceRowsHash(rows: MarketplaceStatisticRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
