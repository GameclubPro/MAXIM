import { createHash } from 'node:crypto';
import {
  exchangeMeasurementKey,
  exchangeMeasurementSchema,
  type ExchangeMeasurement,
} from '@maxim/contracts';

export function exchangeRetentionFrom(now = new Date()): string {
  const from = new Date(now);
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - 89);
  return from.toISOString();
}
export function retainedExchangeMeasurements(rows: ExchangeMeasurement[]): ExchangeMeasurement[] {
  const from = exchangeRetentionFrom();
  return rows.filter((row) => row.data.bucket >= from);
}

export function exchangeMetricError(
  metric: ExchangeMeasurement['data']['metric'],
  failure: string | null | undefined,
  historyAnomaly: boolean,
): boolean {
  if (metric === 'MEMBERSHIP') return false;
  if (metric === 'AUDIENCE')
    return failure === 'AUDIENCE_UNAVAILABLE' || failure === 'COLLECTION_UNAVAILABLE';
  return (
    historyAnomaly ||
    failure === 'POST_STATISTICS_UNAVAILABLE' ||
    failure === 'COLLECTION_UNAVAILABLE'
  );
}

export function canonicalExchangeMeasurements(rows: ExchangeMeasurement[]): ExchangeMeasurement[] {
  return rows
    .map((row) => exchangeMeasurementSchema.parse(row))
    .sort((a, b) =>
      exchangeMeasurementKey(a) < exchangeMeasurementKey(b)
        ? -1
        : exchangeMeasurementKey(a) > exchangeMeasurementKey(b)
          ? 1
          : 0,
    );
}
export function exchangeMeasurementsHash(rows: ExchangeMeasurement[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalExchangeMeasurements(rows)))
    .digest('hex');
}
export function exchangeMeasurementComplete(row: ExchangeMeasurement): boolean {
  const data = row.data;
  if (data.metric === 'AUDIENCE') return data.value !== null && data.observedAt !== null;
  if (data.metric === 'REACH') return !data.incomplete && data.samples === data.posts;
  return data.complete;
}

// FLAG: Overlapping aggregates select one source. They never add or average overlapping populations.
export function selectExchangeMeasurements(
  native: ExchangeMeasurement[],
  imported: ExchangeMeasurement[],
): ExchangeMeasurement[] {
  const selected = new Map(native.map((row) => [exchangeMeasurementKey(row), row]));
  for (const row of imported) {
    const key = exchangeMeasurementKey(row),
      own = selected.get(key);
    if (!own) {
      selected.set(key, row);
      continue;
    }
    if (row.data.metric === 'AUDIENCE' && own.data.metric === 'AUDIENCE') {
      if (
        exchangeMeasurementComplete(row) &&
        (!exchangeMeasurementComplete(own) || row.data.observedAt! > own.data.observedAt!)
      )
        selected.set(key, row);
    } else if (!exchangeMeasurementComplete(own) && exchangeMeasurementComplete(row))
      selected.set(key, row);
  }
  return canonicalExchangeMeasurements([...selected.values()]);
}
