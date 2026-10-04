import { z } from 'zod';

export const marketplaceEntityIdSchema = z.string().regex(/^-[1-9]\d{0,19}$/u);
export const marketplaceKindSchema = z.enum(['CHAT', 'CHANNEL']);
export const marketplaceProfileSchema = z.enum(['moderation', 'publisher']);
const timestamp = z.string().datetime();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const marketplaceBindingInputSchema = z
  .object({
    actorUserId: z.string().regex(/^[1-9]\d{0,19}$/u),
    entityId: marketplaceEntityIdSchema,
    kind: marketplaceKindSchema,
    profile: marketplaceProfileSchema,
  })
  .strict();
export const marketplaceBindingMetadataSchema = z.object({
  title: z.string().max(300),
  description: z.string().max(4000),
  imageUrl: z.string().url().nullable(),
  publicUrl: z.string().url().nullable(),
  audience: z.number().int().min(0).max(2147483647).nullable(),
  isPublic: z.boolean(),
});
export const marketplaceBindingSchema = marketplaceBindingInputSchema.extend({
  id: z.string().uuid(),
  state: z.enum(['ACTIVE', 'UNKNOWN', 'REVOKED']),
  revision: count,
  checkedAt: timestamp.nullable(),
  validUntil: timestamp.nullable(),
  updatedAt: timestamp,
  generationId: z.string().uuid().nullable(),
  statisticsCheckedAt: timestamp.nullable(),
  historyComplete: z.boolean(),
  historyFrom: timestamp.nullable(),
  collectionOwner: z.enum(['SHADOW', 'MAXIM']),
  collectionMetrics: z
    .array(z.enum(['AUDIENCE', 'MEMBERSHIP', 'REACH', 'PUBLICATION_HOUR']))
    .max(4),
  statisticsConsent: z.boolean(),
  metadata: marketplaceBindingMetadataSchema,
});
export const marketplaceBindingsPageSchema = z.object({
  bindings: z.array(marketplaceBindingSchema).max(100),
  nextCursor: z.string().nullable(),
});
const bucket = { bucket: timestamp, observedAt: timestamp.nullable() };
export const marketplaceStatisticRowSchema = z.discriminatedUnion('metric', [
  z.object({ ...bucket, metric: z.literal('AUDIENCE'), value: count.nullable() }).strict(),
  z
    .object({
      ...bucket,
      metric: z.literal('MEMBERSHIP'),
      joined: count,
      left: count,
      complete: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...bucket,
      metric: z.literal('REACH'),
      horizon: z.union([z.literal(0), z.literal(24), z.literal(48)]),
      posts: count,
      samples: count,
      views: count,
      incomplete: z.boolean(),
      maxDelaySeconds: count.nullable(),
    })
    .strict(),
  z
    .object({
      ...bucket,
      metric: z.literal('PUBLICATION_HOUR'),
      posts: count,
      complete: z.boolean(),
    })
    .strict(),
]);
export const marketplaceStatisticsManifestSchema = z.object({
  generationId: z.string().uuid(),
  bindingId: z.string().uuid(),
  entityId: marketplaceEntityIdSchema,
  kind: marketplaceKindSchema,
  source: z.literal('MAXIM'),
  method: z.literal('utc-buckets-v1'),
  from: timestamp,
  to: timestamp,
  asOf: timestamp,
  rowCount: count.max(3000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  complete: z.boolean(),
  horizonToleranceSeconds: z.literal(900),
});
export const marketplaceStatisticsPageSchema = z.object({
  manifest: marketplaceStatisticsManifestSchema,
  rows: z.array(marketplaceStatisticRowSchema).max(200),
  nextCursor: z.string().nullable(),
});
export const marketplaceProfileDetailsSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(1500),
    topic: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(80),
  })
  .strict();
export const marketplaceProfileMutationSchema = z
  .object({
    action: z.enum(['save', 'publish', 'pause', 'toggle', 'revoke']),
    requestId: z.string().uuid(),
    expectedRevision: count,
    details: marketplaceProfileDetailsSchema.optional(),
    appendEnabled: z.boolean().optional(),
    statisticsConsent: z.literal(true).optional(),
  })
  .strict();
export const marketplaceProfileRelayInputSchema = marketplaceBindingInputSchema
  .extend({
    bindingId: z.string().uuid(),
  })
  .merge(
    marketplaceProfileMutationSchema.omit({ appendEnabled: true }).extend({
      action: z.enum(['save', 'publish', 'pause']),
    }),
  );
export const marketplaceProfileRelayResponseSchema = z
  .object({
    bindingId: z.string().uuid(),
    entityId: marketplaceEntityIdSchema,
    kind: marketplaceKindSchema,
    revision: count,
    listing: z
      .object({
        id: z.string().uuid(),
        status: z.enum(['DRAFT', 'PUBLISHED', 'PAUSED']),
        title: z.string().max(300),
        description: z.string().max(1500),
        topic: z.string().max(100),
        region: z.string().max(80),
        publicUrl: z.string().url().nullable(),
        profileOnly: z.boolean(),
      })
      .nullable(),
    choices: z.object({
      topics: z.array(z.string().max(100)).max(200),
      regions: z.array(z.string().max(100)).max(500),
    }),
  })
  .strict();
export const marketplaceProfileStateSchema = marketplaceProfileRelayResponseSchema.extend({
  binding: marketplaceBindingSchema,
  appendEnabled: z.boolean(),
  appendRevision: count,
  available: z.literal(true),
  buttonDiagnostic: z.literal('KEYBOARD_FULL').nullable(),
});
export type MarketplaceBindingInput = z.infer<typeof marketplaceBindingInputSchema>;
export type MarketplaceBinding = z.infer<typeof marketplaceBindingSchema>;
export type MarketplaceStatisticRow = z.infer<typeof marketplaceStatisticRowSchema>;
export type MarketplaceStatisticsManifest = z.infer<typeof marketplaceStatisticsManifestSchema>;
export type MarketplaceProfileRelayResponse = z.infer<typeof marketplaceProfileRelayResponseSchema>;
export type MarketplaceProfileState = z.infer<typeof marketplaceProfileStateSchema>;
