import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type {
  StatsErrorCode,
  StatsMetricKey,
  StatsEntity,
} from '@maxim/contracts/statistics-central';
import { Prisma } from '../prisma/prisma-client';

export const NATIVE_STATS_EPOCH = '00000000-0000-4000-8000-000000000001';
export const timeKey = (value: string) =>
  `${value.slice(0, 19)}.${(value.split('.')[1]?.slice(0, -1) ?? '').padEnd(6, '0')}`;
export const compareTimes = (a: string, b: string) => timeKey(a).localeCompare(timeKey(b));
export const DAY_MS = 86_400_000;
export const unknownHealth = () => ({
  state: 'UNKNOWN' as const,
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextExpectedAt: null,
  errorCode: null,
});
export const centralEnabled = (c: ConfigService) =>
  ['true', '1'].includes(String(c.get('STATISTICS_CENTRAL_ENABLED'))) &&
  c.get('STATISTICS_CENTRAL_MODE') === 'CENTRAL';
export const keyOf = (s: StatsMetricKey) =>
  `${s.metric}:${s.horizon}:${s.method.id}:${s.method.version}`;
export const asKey = (s: StatsMetricKey): StatsMetricKey =>
  ({ metric: s.metric, horizon: s.horizon, method: s.method }) as StatsMetricKey;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function stableUuid(value: unknown) {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export class StatsFailure extends HttpException {
  constructor(code: StatsErrorCode, status = 409, requestId = 'statistics') {
    super(
      {
        contractVersion: 1,
        error: {
          code,
          requestId,
          retryable: ['READ_RESTART', 'RATE_LIMITED', 'UNAVAILABLE'].includes(code),
          retryAfterSeconds: code === 'RATE_LIMITED' ? 5 : null,
        },
      },
      status,
    );
  }
}
export function assertBytes(value: unknown, max: number) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > max)
    throw new StatsFailure('BODY_TOO_LARGE', 413);
}
export async function ensureEntity(tx: Prisma.TransactionClient, entity: StatsEntity) {
  const rows = await tx.$queryRaw<
    Array<{ id: string; data_revision: bigint }>
  >`INSERT INTO stats_entities(kind,max_id) VALUES(${entity.kind},${entity.maxId})
    ON CONFLICT(kind,max_id) DO UPDATE SET max_id=EXCLUDED.max_id RETURNING id,data_revision`;
  return rows[0]!;
}
export async function touch(
  tx: Prisma.TransactionClient,
  entityId: string,
  cause: 'DATA' | 'AUTHORITY' | 'DELETE',
  authorityId: string | null = null,
) {
  const rows = await tx.$queryRaw<
    Array<{ data_revision: bigint }>
  >`UPDATE stats_entities SET data_revision=data_revision+1 WHERE id=${entityId}::uuid RETURNING data_revision`;
  const revision = rows[0]!.data_revision;
  await tx.$executeRaw`INSERT INTO stats_changes(entity_id,entity_revision,cause,authority_id) VALUES(${entityId}::uuid,${revision},${cause},${authorityId}::uuid)`;
  return revision;
}
export const allKeys: StatsMetricKey[] = [
  { metric: 'AUDIENCE', horizon: 0, method: { id: 'AUDIENCE_SNAPSHOT', version: 1 } },
  { metric: 'AUDIENCE', horizon: 0, method: { id: 'MAXFRAME_EXTERNAL_CALENDAR', version: 1 } },
  { metric: 'MEMBERSHIP', horizon: 0, method: { id: 'OBSERVED_MEMBER_EVENTS', version: 1 } },
  { metric: 'REACH', horizon: 0, method: { id: 'POST_PUBLICATION_DAY', version: 1 } },
  { metric: 'REACH', horizon: 0, method: { id: 'RECENT_POST_SAMPLE_20', version: 1 } },
  { metric: 'REACH', horizon: 24, method: { id: 'TIMED_POST_PUBLICATION_DAY', version: 1 } },
  { metric: 'REACH', horizon: 48, method: { id: 'TIMED_POST_PUBLICATION_DAY', version: 1 } },
  { metric: 'PUBLICATION_HOUR', horizon: 0, method: { id: 'PUBLICATION_DAY_HOURS', version: 1 } },
];
