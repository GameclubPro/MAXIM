import { z } from 'zod';
import { utcTimestampSchema, utf16Max } from './marketplace-validator-compat.js';
import {
  marketplaceBindingInputSchema,
  marketplaceBindingMetadataSchema,
} from './marketplace-integration.js';
import {
  EXCHANGE_HISTORY_DAYS,
  EXCHANGE_MAX_ROWS,
  EXCHANGE_METHOD,
  exchangeEntityKey,
  exchangeEntityKeySchema,
  exchangeMeasurementSchema,
  exchangeOriginSchema,
  validateExchangePage,
} from './statistics-exchange.js';

export const EXCHANGE_V3_VERSION = 3 as const;
export const EXCHANGE_V3_MEMBERSHIP_PAGE_SIZE = 100;
export const EXCHANGE_V3_ACCESS_PAGE_SIZE = 100;
export const EXCHANGE_V3_STATISTICS_PAGE_SIZE = 200;
export const EXCHANGE_V3_COMPACT_PAGE_BYTES = 64 * 1024;
export const EXCHANGE_V3_STATISTICS_PAGE_BYTES = 128 * 1024;
export const EXCHANGE_V3_METADATA_BYTES = 128 * 1024;
export const EXCHANGE_V3_URL_BYTES = 4096;
const timestamp = utcTimestampSchema;
const revision = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const actor = marketplaceBindingInputSchema.shape.actorUserId;
const nullableTimestamp = timestamp.nullable();

export function exchangeV3Utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
export function exchangeV3EnvelopeBytes(value: unknown): number {
  return exchangeV3Utf8Bytes(JSON.stringify(value));
}
function withinBytes(bytes: number) {
  return (value: unknown) => exchangeV3EnvelopeBytes(value) <= bytes;
}

export const exchangeV3CapabilitiesSchema = z
  .object({
    version: z.literal(EXCHANGE_V3_VERSION),
    supportedVersions: z
      .array(z.union([z.literal(2), z.literal(3)]))
      .min(1)
      .max(2),
    features: z
      .object({
        membershipSnapshotReferences: z.literal(true),
        compactAccess: z.literal(true),
        nativeStatisticsHead: z.literal(true),
        horizonScopes: z.literal(true),
      })
      .strict(),
    limits: z
      .object({
        membershipPageRecords: z.literal(EXCHANGE_V3_MEMBERSHIP_PAGE_SIZE),
        accessPageRecords: z.literal(EXCHANGE_V3_ACCESS_PAGE_SIZE),
        statisticsPageRecords: z.literal(EXCHANGE_V3_STATISTICS_PAGE_SIZE),
        compactPageBytes: z.literal(EXCHANGE_V3_COMPACT_PAGE_BYTES),
        statisticsPageBytes: z.literal(EXCHANGE_V3_STATISTICS_PAGE_BYTES),
        metadataBytes: z.literal(EXCHANGE_V3_METADATA_BYTES),
        urlBytes: z.literal(EXCHANGE_V3_URL_BYTES),
      })
      .strict(),
  })
  .strict()
  .refine((v) => new Set(v.supportedVersions).size === v.supportedVersions.length)
  .refine(withinBytes(8192), 'Exchange capabilities exceed byte limit');

export const EXCHANGE_V3_CAPABILITIES: z.infer<typeof exchangeV3CapabilitiesSchema> = {
  version: 3,
  supportedVersions: [2, 3],
  features: {
    membershipSnapshotReferences: true,
    compactAccess: true,
    nativeStatisticsHead: true,
    horizonScopes: true,
  },
  limits: {
    membershipPageRecords: EXCHANGE_V3_MEMBERSHIP_PAGE_SIZE,
    accessPageRecords: EXCHANGE_V3_ACCESS_PAGE_SIZE,
    statisticsPageRecords: EXCHANGE_V3_STATISTICS_PAGE_SIZE,
    compactPageBytes: EXCHANGE_V3_COMPACT_PAGE_BYTES,
    statisticsPageBytes: EXCHANGE_V3_STATISTICS_PAGE_BYTES,
    metadataBytes: EXCHANGE_V3_METADATA_BYTES,
    urlBytes: EXCHANGE_V3_URL_BYTES,
  },
};

export const exchangeV3SnapshotRequestSchema = z
  .object({ requestId: uuid, actorUserId: actor })
  .strict();
export const exchangeV3MembershipManifestSchema = z
  .object({
    version: z.literal(3),
    snapshotId: uuid,
    actorUserId: actor,
    membershipRevision: revision,
    entityCount: revision,
    pageCount: revision,
    sha256: digest,
    createdAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .refine((v) => Date.parse(v.expiresAt) > Date.parse(v.createdAt))
  .refine((v) =>
    v.entityCount === 0 ? v.pageCount === 0 : v.pageCount > 0 && v.pageCount <= v.entityCount,
  );
export const exchangeV3MembershipStatusSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        version: z.literal(3),
        state: z.literal('PENDING'),
        snapshotId: uuid,
        manifest: z.null(),
      })
      .strict(),
    z
      .object({
        version: z.literal(3),
        state: z.literal('READY'),
        snapshotId: uuid,
        manifest: exchangeV3MembershipManifestSchema,
      })
      .strict(),
  ])
  .refine((v) => v.state !== 'READY' || v.snapshotId === v.manifest.snapshotId);
export const exchangeV3MembershipPageSchema = z
  .object({
    version: z.literal(3),
    snapshotId: uuid,
    membershipRevision: revision,
    pageIndex: revision,
    entities: z.array(exchangeEntityKeySchema).min(1).max(EXCHANGE_V3_MEMBERSHIP_PAGE_SIZE),
    nextPageIndex: revision.nullable(),
  })
  .strict()
  .refine((v) => v.nextPageIndex === null || v.nextPageIndex === v.pageIndex + 1)
  .refine(
    (v) =>
      v.entities.every((e, i) => i === 0 || exchangeV3CompareEntities(v.entities[i - 1]!, e) < 0),
    'Invalid membership order or duplicate platform',
  )
  .refine(withinBytes(EXCHANGE_V3_COMPACT_PAGE_BYTES), 'Exchange membership exceeds byte limit');
const snapshotReference = z
  .object({ snapshotId: uuid, membershipRevision: revision, sha256: digest })
  .strict();
export const exchangeV3GrantInputSchema = z
  .object({
    version: z.literal(3),
    requestId: uuid,
    grantId: uuid,
    actorUserId: actor,
    expectedRevision: revision,
    revision: revision.refine((v) => v > 0),
    state: z.enum(['ACTIVE', 'REVOKED']),
    membershipSnapshot: snapshotReference.nullable(),
  })
  .strict()
  .refine((v) => v.revision > v.expectedRevision)
  .refine((v) => (v.state === 'ACTIVE') === (v.membershipSnapshot !== null));
export const exchangeV3GrantHeaderSchema = z
  .object({
    version: z.literal(3),
    grantId: uuid,
    actorUserId: actor,
    revision,
    state: z.enum(['ACTIVE', 'REVOKED']),
    membership: snapshotReference.extend({ entityCount: revision }).strict().nullable(),
    accessRevision: revision,
  })
  .strict();

const horizon = z.union([z.literal(0), z.literal(24), z.literal(48)]);
const otherMetric = z.enum(['AUDIENCE', 'MEMBERSHIP', 'PUBLICATION_HOUR']);
export const exchangeV3ScopeSchema = z.discriminatedUnion('metric', [
  z.object({ metric: z.literal('AUDIENCE') }).strict(),
  z.object({ metric: z.literal('MEMBERSHIP') }).strict(),
  z.object({ metric: z.literal('PUBLICATION_HOUR') }).strict(),
  z.object({ metric: z.literal('REACH'), horizon }).strict(),
]);
const summary = {
  coverageFrom: nullableTimestamp,
  coverageUntil: nullableTimestamp,
  complete: z.boolean(),
  population: z.enum(['EMPTY', 'NONEMPTY', 'UNKNOWN']),
  proofObservedAt: nullableTimestamp,
};
export const exchangeV3ScopeSummarySchema = z
  .union([
    z.object({ metric: otherMetric, ...summary }).strict(),
    z.object({ metric: z.literal('REACH'), horizon, ...summary }).strict(),
  ])
  .refine((v) => (v.coverageFrom === null) === (v.coverageUntil === null))
  .refine(
    (v) => v.coverageFrom === null || Date.parse(v.coverageFrom) < Date.parse(v.coverageUntil!),
  )
  .refine(
    (v) =>
      !v.complete ||
      (v.coverageFrom !== null && v.proofObservedAt !== null && v.population !== 'UNKNOWN'),
  )
  .refine((v) => v.population !== 'EMPTY' || v.complete)
  .refine((v) => v.metric !== 'AUDIENCE' || v.population !== 'EMPTY');
export const exchangeV3ErrorCodeSchema = z.enum([
  'ACCESS_DENIED',
  'ACCESS_UNAVAILABLE',
  'REVISION_CONFLICT',
  'SNAPSHOT_EXPIRED',
  'THROTTLED',
  'TIMEOUT',
  'TRANSPORT',
  'REMOTE_UNAVAILABLE',
  'INVALID_PAYLOAD',
  'CHECKSUM_MISMATCH',
  'UNKNOWN',
  'VERSION_UNSUPPORTED',
  'ROSTER_REQUIRES_V3',
]);
const health = {
  checkedAt: nullableTimestamp,
  lastObservationAt: nullableTimestamp,
  nextExpectedAt: nullableTimestamp,
  errorCode: exchangeV3ErrorCodeSchema.nullable(),
};
export const exchangeV3HealthSchema = z
  .union([
    z.object({ metric: otherMetric, ...health }).strict(),
    z.object({ metric: z.literal('REACH'), horizon, ...health }).strict(),
  ])
  .refine(
    (v) =>
      v.checkedAt === null ||
      v.nextExpectedAt === null ||
      Date.parse(v.nextExpectedAt) >= Date.parse(v.checkedAt),
  );
export function exchangeV3ScopeKey(scope: z.infer<typeof exchangeV3ScopeSchema>): string {
  return scope.metric === 'REACH' ? `REACH:${scope.horizon}` : scope.metric;
}
function uniqueScopes(scopes: z.infer<typeof exchangeV3ScopeSchema>[]): boolean {
  return new Set(scopes.map(exchangeV3ScopeKey)).size === scopes.length;
}
export const exchangeV3AccessEntitySchema = exchangeEntityKeySchema
  .extend({
    bindingId: uuid.nullable(),
    bindingRevision: revision,
    status: z.enum(['ACTIVE', 'UNAVAILABLE', 'REVOKED']),
    checkedAt: nullableTimestamp,
    validUntil: nullableTimestamp,
    permittedScopes: z.array(exchangeV3ScopeSchema).max(6).refine(uniqueScopes),
    isPublic: z.boolean(),
    errorCode: exchangeV3ErrorCodeSchema.nullable(),
    metadataVersion: digest.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      v.status !== 'ACTIVE' ||
      (v.bindingId !== null &&
        v.checkedAt !== null &&
        v.validUntil !== null &&
        Date.parse(v.validUntil) > Date.parse(v.checkedAt)),
  )
  .refine(
    (v) =>
      v.kind !== 'CHAT' ||
      v.permittedScopes.every((s) => s.metric === 'AUDIENCE' || s.metric === 'MEMBERSHIP'),
  );
export const exchangeV3AccessQuerySchema = z
  .object({
    cursor: utf16Max(z.string(), 2048)
      .refine((v) => exchangeV3Utf8Bytes(v) <= 8192)
      .optional(),
    entityId: marketplaceBindingInputSchema.shape.entityId.optional(),
    kind: marketplaceBindingInputSchema.shape.kind.optional(),
  })
  .strict()
  .refine((v) => (v.entityId === undefined) === (v.kind === undefined))
  .refine((v) => v.entityId === undefined || v.cursor === undefined);
export const exchangeV3AccessPageSchema = z
  .object({
    version: z.literal(3),
    grantId: uuid,
    grantRevision: revision,
    accessRevision: revision,
    entities: z.array(exchangeV3AccessEntitySchema).max(EXCHANGE_V3_ACCESS_PAGE_SIZE),
    nextCursor: utf16Max(z.string(), 2048)
      .refine((v) => exchangeV3Utf8Bytes(v) <= 8192)
      .nullable(),
  })
  .strict()
  .refine((v) => v.nextCursor === null || v.entities.length > 0)
  .refine((v) => new Set(v.entities.map(exchangeEntityKey)).size === v.entities.length)
  .refine(withinBytes(EXCHANGE_V3_COMPACT_PAGE_BYTES), 'Exchange access exceeds byte limit');
const url = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//u.test(v) && exchangeV3Utf8Bytes(v) <= EXCHANGE_V3_URL_BYTES);
export const exchangeV3MetadataSchema = marketplaceBindingMetadataSchema
  .extend({ imageUrl: url.nullable(), publicUrl: url.nullable() })
  .strict();
export const exchangeV3MetadataResponseSchema = z
  .object({
    version: z.literal(3),
    metadataVersion: digest,
    changed: z.boolean(),
    metadata: exchangeV3MetadataSchema.nullable(),
  })
  .strict()
  .refine((v) => v.changed === (v.metadata !== null))
  .refine(withinBytes(EXCHANGE_V3_METADATA_BYTES), 'Exchange metadata exceeds byte limit');

export const exchangeV3ContentSchema = z
  .object({
    generationId: uuid,
    contentHash: digest,
    producerRevision: revision,
    origin: exchangeOriginSchema,
    method: z.literal(EXCHANGE_METHOD),
    from: timestamp,
    to: timestamp,
    asOf: timestamp,
    rowCount: revision.max(EXCHANGE_MAX_ROWS),
    pageCount: revision.max(EXCHANGE_MAX_ROWS),
    sha256: digest,
    scopes: z.array(exchangeV3ScopeSummarySchema).max(6).refine(uniqueScopes),
    horizonToleranceSeconds: z.literal(900),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.from) < Date.parse(v.to) &&
      Date.parse(v.to) <= Date.parse(v.asOf) &&
      Date.parse(v.to) - Date.parse(v.from) <= EXCHANGE_HISTORY_DAYS * 86400000,
  )
  .refine((v) =>
    v.rowCount === 0 ? v.pageCount === 0 : v.pageCount > 0 && v.pageCount <= v.rowCount,
  )
  .refine((v) =>
    v.scopes.every(
      (s) =>
        (s.proofObservedAt === null || Date.parse(s.proofObservedAt) <= Date.parse(v.asOf)) &&
        (s.coverageFrom === null ||
          (Date.parse(s.coverageFrom) >= Date.parse(v.from) &&
            Date.parse(s.coverageUntil!) <= Date.parse(v.to))),
    ),
  );
export const exchangeV3HeadSchema = z
  .object({
    version: z.literal(3),
    grantId: uuid,
    grantRevision: revision,
    bindingId: uuid,
    bindingRevision: revision,
    entityId: marketplaceBindingInputSchema.shape.entityId,
    kind: marketplaceBindingInputSchema.shape.kind,
    content: exchangeV3ContentSchema.nullable(),
    unchanged: z.boolean(),
    health: z.array(exchangeV3HealthSchema).max(6).refine(uniqueScopes),
    access: z
      .object({ checkedAt: timestamp, validUntil: timestamp, accessRevision: revision })
      .strict(),
  })
  .strict()
  .refine((v) => v.content !== null || !v.unchanged)
  .refine((v) => Date.parse(v.access.validUntil) > Date.parse(v.access.checkedAt))
  .refine(
    (v) =>
      v.kind !== 'CHAT' ||
      [...(v.content?.scopes ?? []), ...v.health].every(
        (s) => s.metric === 'AUDIENCE' || s.metric === 'MEMBERSHIP',
      ),
  )
  .refine(withinBytes(EXCHANGE_V3_STATISTICS_PAGE_BYTES), 'Exchange head exceeds byte limit');
export const exchangeV3StatisticsPageSchema = z
  .object({
    version: z.literal(3),
    generationId: uuid,
    contentHash: digest,
    pageIndex: revision,
    rows: z.array(exchangeMeasurementSchema).min(1).max(EXCHANGE_V3_STATISTICS_PAGE_SIZE),
    nextPageIndex: revision.nullable(),
  })
  .strict()
  .refine((v) => v.nextPageIndex === null || v.nextPageIndex === v.pageIndex + 1)
  .refine(withinBytes(EXCHANGE_V3_STATISTICS_PAGE_BYTES), 'Exchange statistics exceed byte limit');

export function exchangeV3CompareEntities(
  a: z.infer<typeof exchangeEntityKeySchema>,
  b: z.infer<typeof exchangeEntityKeySchema>,
): number {
  const ak = exchangeEntityKey(a),
    bk = exchangeEntityKey(b);
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}
export function exchangeV3MembershipCanonical(
  entities: z.infer<typeof exchangeEntityKeySchema>[],
): string {
  return JSON.stringify(
    entities.map((v) => ({ entityId: v.entityId, kind: v.kind, profile: v.profile })),
  );
}
export function validateExchangeV3StatisticsPage(
  raw: unknown,
  head: ExchangeV3Head,
  now = Date.now(),
): ExchangeV3StatisticsPage {
  const page = exchangeV3StatisticsPageSchema.parse(raw),
    c = head.content;
  if (
    !c ||
    page.generationId !== c.generationId ||
    page.contentHash !== c.contentHash ||
    page.pageIndex >= c.pageCount ||
    (page.nextPageIndex === null) !== (page.pageIndex === c.pageCount - 1)
  )
    throw new Error('Invalid exchange v3 page identity');
  const metrics = [
    ...new Map(
      c.scopes.map((s) => [
        s.metric,
        {
          metric: s.metric,
          complete: s.complete,
          checkedAt: null,
          nextExpectedAt: null,
          error: false,
        },
      ]),
    ).values(),
  ];
  validateExchangePage(
    {
      manifest: {
        version: 2,
        grantId: head.grantId,
        grantRevision: head.grantRevision,
        generationId: c.generationId,
        bindingId: head.bindingId,
        entityId: head.entityId,
        kind: head.kind,
        origin: c.origin,
        producerRevision: c.producerRevision,
        method: c.method,
        from: c.from,
        to: c.to,
        asOf: c.asOf,
        rowCount: c.rowCount,
        sha256: c.sha256,
        complete: false,
        horizonToleranceSeconds: 900,
        metrics,
      },
      rows: page.rows,
      nextCursor: page.nextPageIndex === null ? null : String(page.nextPageIndex),
    },
    now,
  );
  if (
    page.rows.some(
      (r) => !c.scopes.some((s) => exchangeV3ScopeKey(s) === exchangeV3ScopeKey(r.data)),
    )
  )
    throw new Error('Invalid exchange v3 metric scope');
  return page;
}

export type ExchangeV3Capabilities = z.infer<typeof exchangeV3CapabilitiesSchema>;
export type ExchangeV3SnapshotRequest = z.infer<typeof exchangeV3SnapshotRequestSchema>;
export type ExchangeV3MembershipManifest = z.infer<typeof exchangeV3MembershipManifestSchema>;
export type ExchangeV3MembershipStatus = z.infer<typeof exchangeV3MembershipStatusSchema>;
export type ExchangeV3MembershipPage = z.infer<typeof exchangeV3MembershipPageSchema>;
export type ExchangeV3GrantInput = z.infer<typeof exchangeV3GrantInputSchema>;
export type ExchangeV3GrantHeader = z.infer<typeof exchangeV3GrantHeaderSchema>;
export type ExchangeV3Scope = z.infer<typeof exchangeV3ScopeSchema>;
export type ExchangeV3ScopeSummary = z.infer<typeof exchangeV3ScopeSummarySchema>;
export type ExchangeV3Health = z.infer<typeof exchangeV3HealthSchema>;
export type ExchangeV3AccessEntity = z.infer<typeof exchangeV3AccessEntitySchema>;
export type ExchangeV3AccessPage = z.infer<typeof exchangeV3AccessPageSchema>;
export type ExchangeV3Metadata = z.infer<typeof exchangeV3MetadataSchema>;
export type ExchangeV3MetadataResponse = z.infer<typeof exchangeV3MetadataResponseSchema>;
export type ExchangeV3Content = z.infer<typeof exchangeV3ContentSchema>;
export type ExchangeV3Head = z.infer<typeof exchangeV3HeadSchema>;
export type ExchangeV3StatisticsPage = z.infer<typeof exchangeV3StatisticsPageSchema>;

export type ExchangeV3AccessQuery = z.infer<typeof exchangeV3AccessQuerySchema>;

export function exchangeV3ContentCanonical(
  content: Omit<ExchangeV3Content, 'generationId' | 'contentHash'> | ExchangeV3Content,
): string {
  return JSON.stringify({
    producerRevision: content.producerRevision,
    origin: content.origin,
    method: content.method,
    from: content.from,
    to: content.to,
    asOf: content.asOf,
    rowCount: content.rowCount,
    pageCount: content.pageCount,
    sha256: content.sha256,
    scopes: content.scopes.map((s) => ({
      metric: s.metric,
      ...(s.metric === 'REACH' ? { horizon: s.horizon } : {}),
      coverageFrom: s.coverageFrom,
      coverageUntil: s.coverageUntil,
      complete: s.complete,
      population: s.population,
      proofObservedAt: s.proofObservedAt,
    })),
    horizonToleranceSeconds: content.horizonToleranceSeconds,
  });
}
export function validateExchangeV3Head(
  raw: unknown,
  now = Date.now(),
  knownContentHash?: string,
): ExchangeV3Head {
  const head = exchangeV3HeadSchema.parse(raw),
    max = now + 30000;
  if (
    Date.parse(head.access.checkedAt) > max ||
    (head.content !== null && Date.parse(head.content.asOf) > max) ||
    head.health.some(
      (h) =>
        (h.checkedAt !== null && Date.parse(h.checkedAt) > max) ||
        (h.lastObservationAt !== null && Date.parse(h.lastObservationAt) > max),
    )
  )
    throw new Error('Invalid exchange v3 observation time');
  if (
    head.unchanged &&
    (knownContentHash === undefined || head.content?.contentHash !== knownContentHash)
  )
    throw new Error('Invalid exchange v3 conditional identity');
  return head;
}
