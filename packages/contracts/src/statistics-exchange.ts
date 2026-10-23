import { z } from 'zod';
import {
  marketplaceBindingInputSchema,
  marketplaceBindingMetadataSchema,
  marketplaceBindingSchema,
  marketplaceStatisticRowSchema,
} from './marketplace-integration.js';

export const EXCHANGE_VERSION = 2 as const;
export const EXCHANGE_HISTORY_DAYS = 90;
export const EXCHANGE_PAGE_SIZE = 200;
export const EXCHANGE_MAX_ROWS = 3000;
export const EXCHANGE_METHOD = 'utc-buckets-v1' as const;
export const exchangeMetricSchema = z.enum(['AUDIENCE', 'MEMBERSHIP', 'REACH', 'PUBLICATION_HOUR']);
export const exchangeOriginSchema = z.enum(['MAXIM', 'EXCHANGE']);
const timestamp = z.string().datetime();
const revision = z.number().int().nonnegative().safe();
export const exchangeEntityKeySchema = marketplaceBindingInputSchema
  .omit({ actorUserId: true })
  .strict();
export const exchangeEntitySchema = exchangeEntityKeySchema
  .extend({
    metadata: marketplaceBindingMetadataSchema,
    capabilities: z.array(exchangeMetricSchema).max(4),
    checkedAt: timestamp,
  })
  .strict();
export const exchangeEntitiesPageSchema = z
  .object({
    entities: z.array(exchangeEntitySchema).max(100),
    nextCursor: z.string().max(2048).nullable(),
  })
  .strict();
export const exchangeGrantInputSchema = z
  .object({
    grantId: z.string().uuid(),
    actorUserId: marketplaceBindingInputSchema.shape.actorUserId,
    revision: revision.refine((v) => v > 0),
    state: z.enum(['ACTIVE', 'REVOKED']),
    entities: z.array(exchangeEntityKeySchema).max(100),
  })
  .strict()
  .refine(
    (v) => new Set(v.entities.map(exchangeEntityKey)).size === v.entities.length,
    'Duplicate exchange entity',
  );
export const exchangeGrantEntitySchema = exchangeEntityKeySchema
  .extend({
    status: z.enum(['ACTIVE', 'UNAVAILABLE', 'REVOKED']),
    binding: marketplaceBindingSchema.nullable(),
    error: z.string().max(300).nullable(),
  })
  .strict();
export const exchangeGrantSchema = z
  .object({
    grantId: z.string().uuid(),
    actorUserId: marketplaceBindingInputSchema.shape.actorUserId,
    revision,
    state: z.enum(['ACTIVE', 'REVOKED']),
    entities: z.array(exchangeGrantEntitySchema).max(100),
  })
  .strict();
export const exchangeOwnerStateSchema = z
  .object({
    available: z.boolean(),
    grantId: z.string().uuid().nullable(),
    revision,
    selected: z.array(exchangeEntityKeySchema).max(100),
    entities: z.array(exchangeGrantEntitySchema).max(100),
    syncError: z.boolean(),
    checkedAt: timestamp.nullable(),
  })
  .strict();
export const exchangeOwnerMutationSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: revision,
    entities: z.array(exchangeEntityKeySchema).max(100),
  })
  .strict()
  .refine(
    (v) => new Set(v.entities.map(exchangeEntityKey)).size === v.entities.length,
    'Duplicate exchange entity',
  );
export const exchangeMeasurementSchema = z
  .object({
    origin: exchangeOriginSchema,
    method: z.literal(EXCHANGE_METHOD),
    revision,
    data: marketplaceStatisticRowSchema,
  })
  .strict();
export const exchangeMetricHealthSchema = z
  .object({
    metric: exchangeMetricSchema,
    complete: z.boolean(),
    checkedAt: timestamp.nullable(),
    nextExpectedAt: timestamp.nullable(),
    error: z.boolean(),
  })
  .strict();
export const exchangeManifestSchema = z
  .object({
    version: z.literal(EXCHANGE_VERSION),
    grantId: z.string().uuid(),
    grantRevision: revision,
    generationId: z.string().uuid(),
    bindingId: z.string().uuid(),
    entityId: marketplaceBindingInputSchema.shape.entityId,
    kind: marketplaceBindingInputSchema.shape.kind,
    origin: exchangeOriginSchema,
    producerRevision: revision,
    method: z.literal(EXCHANGE_METHOD),
    from: timestamp,
    to: timestamp,
    asOf: timestamp,
    rowCount: z.number().int().nonnegative().max(EXCHANGE_MAX_ROWS),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    complete: z.boolean(),
    horizonToleranceSeconds: z.literal(900),
    metrics: z.array(exchangeMetricHealthSchema).max(4),
  })
  .strict();
export const exchangeStatisticsPageSchema = z
  .object({
    manifest: exchangeManifestSchema,
    rows: z.array(exchangeMeasurementSchema).max(EXCHANGE_PAGE_SIZE),
    nextCursor: z.string().max(2048).nullable(),
  })
  .strict();

export function exchangeEntityKey(v: { entityId: string; kind: string }) {
  return `${v.kind}:${v.entityId}`;
}
export function exchangeMeasurementKey(v: z.infer<typeof exchangeMeasurementSchema>) {
  const d = v.data;
  return `${d.metric}:${d.bucket}:${d.metric === 'REACH' ? d.horizon : ''}`;
}

// FLAG: Semantic identity does not change the producer's bucket spelling or wire ordering key.
export function exchangeMeasurementIdentity(v: z.infer<typeof exchangeMeasurementSchema>) {
  const d = v.data;
  return `${d.metric}:${Date.parse(d.bucket)}:${d.metric === 'REACH' ? d.horizon : ''}`;
}

export function validateExchangePage(raw: unknown, now = Date.now()) {
  const page = exchangeStatisticsPageSchema.parse(raw);
  const m = page.manifest;
  const from = Date.parse(m.from),
    to = Date.parse(m.to),
    asOf = Date.parse(m.asOf);
  if (
    from >= to ||
    to - from > EXCHANGE_HISTORY_DAYS * 86400000 ||
    to > asOf ||
    asOf > now + 30000 ||
    (page.nextCursor !== null && page.rows.length === 0) ||
    page.rows.length > m.rowCount ||
    new Set(m.metrics.map((h) => h.metric)).size !== m.metrics.length ||
    m.metrics.some(
      (h) =>
        (h.checkedAt !== null && Date.parse(h.checkedAt) > asOf) ||
        (h.checkedAt !== null &&
          h.nextExpectedAt !== null &&
          Date.parse(h.nextExpectedAt) < Date.parse(h.checkedAt)),
    )
  )
    throw new Error('Invalid exchange generation window');
  const keys = new Set<string>();
  for (const row of page.rows) {
    const d = row.data,
      at = Date.parse(d.bucket);
    const key = exchangeMeasurementIdentity(row);
    if (
      row.origin !== m.origin ||
      row.method !== m.method ||
      row.revision !== m.producerRevision ||
      keys.has(key) ||
      at < from ||
      at >= to ||
      at % (d.metric === 'PUBLICATION_HOUR' ? 3600000 : 86400000) !== 0 ||
      (d.observedAt !== null && Date.parse(d.observedAt) > asOf) ||
      !m.metrics.some((h) => h.metric === d.metric) ||
      (m.kind === 'CHAT' && (d.metric === 'REACH' || d.metric === 'PUBLICATION_HOUR'))
    )
      throw new Error('Invalid exchange measurement identity or interval');
    keys.add(key);
    if (
      d.metric === 'AUDIENCE' &&
      d.value !== null &&
      (!d.observedAt || d.observedAt.slice(0, 10) !== d.bucket.slice(0, 10) || d.value > 2147483647)
    )
      throw new Error('Invalid exchange audience observation');
    if (
      d.metric === 'REACH' &&
      (d.samples > d.posts ||
        (!d.samples && d.views !== 0) ||
        (d.samples > 0 && !d.observedAt) ||
        (d.horizon > 0 && d.samples > 0 && (d.maxDelaySeconds === null || d.maxDelaySeconds > 900)))
    )
      throw new Error('Invalid exchange timed views');
  }
  return page;
}

export type ExchangeEntityKey = z.infer<typeof exchangeEntityKeySchema>;
export type ExchangeEntity = z.infer<typeof exchangeEntitySchema>;
export type ExchangeGrantInput = z.infer<typeof exchangeGrantInputSchema>;
export type ExchangeGrant = z.infer<typeof exchangeGrantSchema>;
export type ExchangeOwnerState = z.infer<typeof exchangeOwnerStateSchema>;
export type ExchangeMeasurement = z.infer<typeof exchangeMeasurementSchema>;
export type ExchangeManifest = z.infer<typeof exchangeManifestSchema>;
export type ExchangeStatisticsPage = z.infer<typeof exchangeStatisticsPageSchema>;
