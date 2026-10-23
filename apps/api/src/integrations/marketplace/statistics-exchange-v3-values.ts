import { createHash } from 'node:crypto';
import {
  exchangeManifestSchema,
  exchangeV3ScopeKey,
  type ExchangeManifest,
  type ExchangeMeasurement,
  type ExchangeV3Head,
  type ExchangeV3Health,
  type ExchangeV3Scope,
  type ExchangeV3ScopeSummary,
} from '@maxim/contracts';
import { type MarketplaceStatisticsManifest } from '@maxim/contracts/marketplace-integration';
import { type MarketplaceBindingRow } from './marketplace-state.service';

export const exchangeV3Hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const exchangeV3Scopes = (publicChannel: boolean): ExchangeV3Scope[] => [
  { metric: 'AUDIENCE' },
  { metric: 'MEMBERSHIP' },
  ...(publicChannel
    ? ([
        { metric: 'PUBLICATION_HOUR' },
        ...([0, 24, 48] as const).map((horizon) => ({ metric: 'REACH' as const, horizon })),
      ] as ExchangeV3Scope[])
    : []),
];

export function exchangeV3NativeMaterial(
  input: ExchangeMeasurement[],
  source: MarketplaceStatisticsManifest,
  binding: MarketplaceBindingRow,
  scopes: ExchangeV3Scope[],
): { rows: ExchangeMeasurement[]; summaries: ExchangeV3ScopeSummary[] } {
  const proof = binding.native_full_checked_at?.toISOString() ?? null;
  const coverageFrom = new Date(
    Math.max(Date.parse(source.from), binding.history_from?.getTime() ?? Date.parse(source.to)),
  ).toISOString();
  const coverageEnd = Math.min(
    Date.parse(source.to),
    binding.history_to?.getTime() ?? -Infinity,
    binding.native_full_checked_at?.getTime() ?? -Infinity,
  );
  const coverageUntil =
    Number.isFinite(coverageEnd) && coverageEnd > Date.parse(coverageFrom)
      ? new Date(coverageEnd).toISOString()
      : null;
  const enumeration =
    source.complete && proof !== null && proof <= source.asOf && coverageUntil !== null;
  const rows = input.flatMap((row): ExchangeMeasurement[] => {
    if (!scopes.some((s) => exchangeV3ScopeKey(s) === exchangeV3ScopeKey(row.data))) return [];
    const data = row.data;
    // FLAG: Legacy zero-fill is not native evidence without a completed enumeration.
    if (
      (data.metric === 'REACH' || data.metric === 'PUBLICATION_HOUR') &&
      data.posts === 0 &&
      !enumeration
    )
      return [];
    if (data.metric === 'REACH') {
      const matureDay =
        Date.parse(data.bucket) + 86400000 + data.horizon * 3600000 <= Date.parse(source.to);
      // A missing immature timed cohort is unknown, never a measured zero.
      if (data.horizon !== 0 && !matureDay && data.posts === 0) return [];
      return [
        {
          ...row,
          data: {
            ...data,
            incomplete: data.incomplete || !enumeration || (data.horizon !== 0 && !matureDay),
          },
        },
      ];
    }
    if (data.metric === 'PUBLICATION_HOUR')
      return [{ ...row, data: { ...data, complete: data.complete && enumeration } }];
    return [row];
  });
  const summaries = scopes.map((scope): ExchangeV3ScopeSummary => {
    const points = rows.filter((row) => exchangeV3ScopeKey(row.data) === exchangeV3ScopeKey(scope));
    const latest = points.reduce<string | null>(
      (v, r) => (r.data.observedAt && (!v || r.data.observedAt > v) ? r.data.observedAt : v),
      null,
    );
    if (scope.metric === 'AUDIENCE') {
      const days = Math.ceil((Date.parse(source.to) - Date.parse(source.from)) / 86400000);
      return {
        ...scope,
        coverageFrom: source.from,
        coverageUntil: source.to,
        complete: points.length === days && latest !== null,
        population: points.length ? 'NONEMPTY' : 'UNKNOWN',
        proofObservedAt: latest,
      };
    }
    if (scope.metric === 'MEMBERSHIP')
      return {
        ...scope,
        coverageFrom: null,
        coverageUntil: null,
        complete: false,
        population: points.some(
          (r) => r.data.metric === 'MEMBERSHIP' && r.data.joined + r.data.left > 0,
        )
          ? 'NONEMPTY'
          : 'UNKNOWN',
        proofObservedAt: latest,
      };
    const posts = rows.filter((r) => r.data.metric === 'PUBLICATION_HOUR' && r.data.posts > 0);
    const hasPosts = posts.length > 0;
    const dueComplete = points.every((r) => r.data.metric !== 'REACH' || !r.data.incomplete);
    const immature =
      scope.metric === 'REACH' &&
      scope.horizon !== 0 &&
      posts.some(
        (r) =>
          Date.parse(r.data.bucket) + 3600000 + scope.horizon * 3600000 > Date.parse(source.to),
      );
    const complete = enumeration && dueComplete && !immature;
    return {
      ...scope,
      coverageFrom: enumeration ? coverageFrom : null,
      coverageUntil: enumeration ? coverageUntil : null,
      complete,
      population: hasPosts ? 'NONEMPTY' : complete ? 'EMPTY' : 'UNKNOWN',
      proofObservedAt: enumeration ? proof : latest,
    };
  });
  return { rows, summaries };
}

export function exchangeV3NativeHealth(
  scopes: ExchangeV3Scope[],
  binding: MarketplaceBindingRow,
  observations: Record<string, string | null>,
): ExchangeV3Health[] {
  return scopes.map((scope) => {
    const latest = observations[exchangeV3ScopeKey(scope)] ?? null;
    const checked =
      scope.metric === 'AUDIENCE'
        ? (binding.native_audience_checked_at?.toISOString() ?? latest)
        : (scope.metric === 'REACH' && scope.horizon !== 0) || scope.metric === 'MEMBERSHIP'
          ? latest
          : (binding.native_history_checked_at?.toISOString() ?? latest);
    const failed =
      scope.metric === 'AUDIENCE'
        ? binding.collection_error === 'AUDIENCE_UNAVAILABLE'
        : scope.metric === 'MEMBERSHIP'
          ? false
          : !!binding.history_anomaly || binding.collection_error === 'POST_STATISTICS_UNAVAILABLE';
    return {
      ...scope,
      checkedAt: checked,
      lastObservationAt: latest,
      nextExpectedAt: checked ? new Date(Date.parse(checked) + 300000).toISOString() : null,
      errorCode: failed ? 'REMOTE_UNAVAILABLE' : null,
    };
  });
}

// Internal adapter only: v1/v2 wire schemas do not gain v3 fields.
export function exchangeV3LegacyManifest(head: ExchangeV3Head): ExchangeManifest {
  const content = head.content;
  if (!content) throw new Error('EXCHANGE_IDENTITY_MISMATCH');
  const metrics = [...new Set(content.scopes.map((s) => s.metric))].map((metric) => {
    const scopes = content.scopes.filter((s) => s.metric === metric);
    const health = head.health.filter((s) => s.metric === metric);
    // A legacy unscoped REACH timestamp must never prove all three horizons.
    const latest = metric === 'REACH' ? null : (health[0]?.checkedAt ?? null);
    return {
      metric,
      complete: scopes.length > 0 && scopes.every((s) => s.complete),
      checkedAt: latest,
      nextExpectedAt: metric === 'REACH' ? null : (health[0]?.nextExpectedAt ?? null),
      error: health.some((s) => s.errorCode !== null),
    };
  });
  return exchangeManifestSchema.parse({
    version: 2,
    grantId: head.grantId,
    grantRevision: head.grantRevision,
    generationId: content.generationId,
    bindingId: head.bindingId,
    entityId: head.entityId,
    kind: head.kind,
    origin: content.origin,
    producerRevision: content.producerRevision,
    method: content.method,
    from: content.from,
    to: content.to,
    asOf: content.asOf,
    rowCount: content.rowCount,
    sha256: content.sha256,
    complete: content.scopes.every((s) => s.complete),
    horizonToleranceSeconds: content.horizonToleranceSeconds,
    metrics,
  });
}
