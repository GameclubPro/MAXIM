import { z } from 'zod';
import { utcTimestampSchema, utf16Max } from './marketplace-validator-compat.js';

export const marketplaceEntityIdSchema = z.string().regex(/^-[1-9]\d{0,19}$/u);
export const marketplaceKindSchema = z.enum(['CHAT', 'CHANNEL']);
export const marketplaceProfileSchema = z.enum(['moderation', 'publisher']);
const timestamp = utcTimestampSchema;
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
  title: utf16Max(z.string(), 300),
  description: utf16Max(z.string(), 4000),
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
    title: utf16Max(z.string().trim().min(1), 300),
    description: utf16Max(z.string().trim(), 1500),
    topic: utf16Max(z.string().trim().min(1), 100),
    region: utf16Max(z.string().trim().min(1), 80),
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
        title: utf16Max(z.string(), 300),
        description: utf16Max(z.string(), 1500),
        topic: utf16Max(z.string(), 100),
        region: utf16Max(z.string(), 80),
        publicUrl: z.string().url().nullable(),
        profileOnly: z.boolean(),
      })
      .nullable(),
    choices: z.object({
      topics: z.array(utf16Max(z.string(), 100)).max(200),
      regions: z.array(utf16Max(z.string(), 100)).max(500),
    }),
    capabilities: z
      .object({
        canEdit: z.boolean(),
        canPublish: z.boolean(),
        canPause: z.boolean(),
        publicState: z.enum(['DRAFT', 'HIDDEN', 'PUBLIC', 'ACCESS_REQUIRED', 'REVIEW']),
        placementState: z.enum(['BOT_REQUIRED', 'SETUP_REQUIRED', 'READY', 'UNAVAILABLE']),
        manageUrl: z.string().url().nullable(),
        connectUrl: z.string().url(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const marketplaceProfileStatisticsSchema = z
  .object({
    state: z.enum(['PENDING', 'AVAILABLE', 'EMPTY', 'DISABLED']),
    observedDays: count.max(90),
    lastObservedAt: timestamp.nullable(),
    from: timestamp.nullable(),
    to: timestamp.nullable(),
  })
  .strict();
export const marketplaceProfileStateSchema = marketplaceProfileRelayResponseSchema.extend({
  binding: marketplaceBindingSchema,
  appendEnabled: z.boolean(),
  appendRevision: count,
  available: z.literal(true),
  buttonDiagnostic: z.literal('KEYBOARD_FULL').nullable(),
  statistics: marketplaceProfileStatisticsSchema.optional(),
});
export type MarketplaceBindingInput = z.infer<typeof marketplaceBindingInputSchema>;
export type MarketplaceBinding = z.infer<typeof marketplaceBindingSchema>;
export type MarketplaceStatisticRow = z.infer<typeof marketplaceStatisticRowSchema>;
export type MarketplaceStatisticsManifest = z.infer<typeof marketplaceStatisticsManifestSchema>;
export type MarketplaceProfileRelayResponse = z.infer<typeof marketplaceProfileRelayResponseSchema>;
export type MarketplaceProfileState = z.infer<typeof marketplaceProfileStateSchema>;

/** A navigation/capability result; it never grants a session or listing ownership. */
export const marketplaceEntryResponseSchema = z
  .object({
    entityId: marketplaceEntityIdSchema,
    kind: marketplaceKindSchema,
    profile: marketplaceProfileSchema,
    publicState: z.enum(['ABSENT', 'DRAFT', 'PUBLIC', 'HIDDEN', 'ACCESS_REQUIRED', 'REVIEW']),
    listing: z
      .object({
        id: z.string().uuid(),
        ownershipKey: z.string().regex(/^[a-f0-9]{64}$/u),
        title: utf16Max(z.string(), 300),
        publicUrl: z.string().url().nullable(),
        profileOnly: z.boolean(),
      })
      .strict()
      .nullable(),
    isOwner: z.boolean(),
    canCreate: z.boolean(),
    manageUrl: z.string().url().nullable(),
    connectUrl: z.string().url(),
    checkedAt: timestamp,
    validUntil: timestamp.nullable(),
  })
  .strict();
export const marketplaceButtonContextSchema = z.enum([
  'GREETINGS',
  'MODERATION_NOTICES',
  'CHANNEL_POSTS',
  'PUBLICATIONS',
]);
export const marketplaceButtonCaptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .refine(
    (value) => !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value),
    'Текст должен быть в одну строку',
  );
export const MARKETPLACE_BUTTON_DEFAULT_CAPTION = 'Заказать рекламу';
export const marketplaceButtonModuleSchema = z.enum([
  'GREETING',
  'LINKS',
  'PROFANITY',
  'COMMERCIAL',
  'DUPLICATES',
  'MESSAGE_LIMITS',
  'STOP_WORDS',
  'PHONE_NUMBERS',
  'REQUIRED_SUBSCRIPTION',
  'INVITATION_ACCESS',
  'OTHER_MODERATION',
  'NIGHT_MODE',
  'RULES',
  'CHANNEL_POST',
  'PUBLICATION',
  'VK_IMPORT',
  'APPROVED_SUGGESTION',
]);
export type MarketplaceButtonModule = z.infer<typeof marketplaceButtonModuleSchema>;
export const marketplaceButtonModules: Record<
  MarketplaceButtonContext,
  readonly MarketplaceButtonModule[]
> = {
  GREETINGS: ['GREETING'],
  MODERATION_NOTICES: [
    'LINKS',
    'PROFANITY',
    'COMMERCIAL',
    'DUPLICATES',
    'MESSAGE_LIMITS',
    'STOP_WORDS',
    'PHONE_NUMBERS',
    'REQUIRED_SUBSCRIPTION',
    'INVITATION_ACCESS',
    'OTHER_MODERATION',
    'NIGHT_MODE',
    'RULES',
  ],
  CHANNEL_POSTS: ['CHANNEL_POST'],
  PUBLICATIONS: ['PUBLICATION', 'VK_IMPORT', 'APPROVED_SUGGESTION'],
};
export const marketplaceButtonPolicyMutationSchema = z.union([
  z
    .object({
      requestId: z.string().uuid(),
      expectedRevision: count,
      context: marketplaceButtonContextSchema,
      enabled: z.boolean(),
      module: marketplaceButtonModuleSchema.optional(),
    })
    .strict()
    .refine(
      (value) => !value.module || marketplaceButtonModules[value.context].includes(value.module),
      'Модуль не относится к этой группе',
    ),
  z
    .object({
      requestId: z.string().uuid(),
      expectedCaptionRevision: count,
      caption: marketplaceButtonCaptionSchema,
    })
    .strict(),
]);
export type MarketplaceButtonPolicyMutation = z.infer<typeof marketplaceButtonPolicyMutationSchema>;
export const marketplaceButtonPolicyStateSchema = z
  .object({
    entityId: marketplaceEntityIdSchema,
    kind: marketplaceKindSchema,
    profile: marketplaceProfileSchema,
    revision: count,
    caption: marketplaceButtonCaptionSchema.default(MARKETPLACE_BUTTON_DEFAULT_CAPTION),
    captionRevision: count.default(0),
    contexts: z
      .array(
        z
          .object({
            context: marketplaceButtonContextSchema,
            enabled: z.boolean(),
            effective: z.boolean(),
            status: z.enum([
              'OFF',
              'READY',
              'CHECKING',
              'PROFILE_UNAVAILABLE',
              'ACCESS_REQUIRED',
              'CONFIRM_REQUIRED',
            ]),
            enabledAt: timestamp.nullable(),
            partial: z.boolean().default(false),
            modules: z
              .array(
                z
                  .object({
                    module: marketplaceButtonModuleSchema,
                    enabled: z.boolean(),
                    effective: z.boolean(),
                    needsConfirmation: z.boolean(),
                  })
                  .strict(),
              )
              .max(12)
              .default([]),
          })
          .strict(),
      )
      .max(4),
    buttonDiagnostic: z.literal('KEYBOARD_FULL').nullable(),
  })
  .strict();
export type MarketplaceEntryResponse = z.infer<typeof marketplaceEntryResponseSchema>;
export type MarketplaceButtonContext = z.infer<typeof marketplaceButtonContextSchema>;
export type MarketplaceButtonPolicyState = z.infer<typeof marketplaceButtonPolicyStateSchema>;
export const marketplaceLaunchInputSchema = z
  .object({
    target: z.enum(['catalog', 'listing', 'manage', 'connect']),
    kind: marketplaceKindSchema.optional(),
    entityId: marketplaceEntityIdSchema.optional(),
    listingId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.kind === undefined) !== (value.entityId === undefined) ||
      (value.target !== 'catalog' && (!value.kind || !value.entityId)) ||
      (value.target === 'listing' || value.target === 'manage') !== (value.listingId !== undefined)
    )
      context.addIssue({ code: 'custom', message: 'Invalid marketplace destination' });
  });
export const marketplaceLaunchResponseSchema = z.object({ url: z.string().url() }).strict();
