import { z } from 'zod';
import { broadcastTextFormatSchema } from './broadcast-common.js';
import { managedEntityTypeSchema } from './managed-entities.js';
export type { ManagedEntityType } from './managed-entities.js';

export const miniappProfileSchema = z.enum(['moderation', 'publisher']);
export type MiniappProfile = z.infer<typeof miniappProfileSchema>;

export const miniappCapabilitySchema = z.enum([
  'moderation_workspace',
  'publisher_workspace',
  'publisher_entities',
  'publisher_policy_write',
  'chat_comments',
]);
export type MiniappCapability = z.infer<typeof miniappCapabilitySchema>;

export const miniappHomeRouteSchema = z.enum(['/', '/publications']);
export type MiniappHomeRoute = z.infer<typeof miniappHomeRouteSchema>;

export const publisherReadinessStateSchema = z.enum([
  'disabled',
  'setup_required',
  'ready',
  'temporarily_unavailable',
]);
export type PublisherReadinessState = z.infer<typeof publisherReadinessStateSchema>;

export const publisherReadinessBlockerCodeSchema = z.enum([
  'policy_disabled',
  'bot_not_connected',
  'bot_access_unconfirmed',
  'bot_access_expired',
  'bot_not_admin',
  'write_permission_missing',
  'route_quarantined',
  'publisher_runtime_unavailable',
  'module_disabled',
]);
export type PublisherReadinessBlockerCode = z.infer<typeof publisherReadinessBlockerCodeSchema>;

export const managedEntityPublicationPolicySchema = z
  .object({
    publikEnabled: z.boolean(),
    revision: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type ManagedEntityPublicationPolicy = z.infer<typeof managedEntityPublicationPolicySchema>;

export const publisherChatCommentSettingsSchema = z
  .object({
    commentsEnabled: z.boolean(),
    commentsAdminsEnabled: z.boolean(),
    commentsChatBroadcastsEnabled: z.boolean(),
  })
  .strict();
export type PublisherChatCommentSettings = z.infer<typeof publisherChatCommentSettingsSchema>;

export const publisherEntityModuleSettingsSchema = z
  .object({
    revision: z.number().int().min(0),
    chatComments: publisherChatCommentSettingsSchema.nullable(),
    channelSuggestionsEnabled: z.boolean().nullable(),
  })
  .strict();
export type PublisherEntityModuleSettings = z.infer<typeof publisherEntityModuleSettingsSchema>;

export const publisherEntityReadinessSchema = z.object({
  state: publisherReadinessStateSchema,
  canPublish: z.boolean(),
  canUseChatComments: z.boolean(),
  canPublishSuggestions: z.boolean(),
  blockerCode: publisherReadinessBlockerCodeSchema.nullable(),
  checkedAt: z.string().datetime().nullable(),
  retryAt: z.string().datetime().nullable(),
});
export type PublisherEntityReadiness = z.infer<typeof publisherEntityReadinessSchema>;

export const publisherEntitySchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string(),
    entityType: managedEntityTypeSchema,
    avatarUrl: z.string().trim().url().nullable().default(null),
    entityUrl: z.string().trim().url().nullable().default(null),
    policy: managedEntityPublicationPolicySchema,
    moduleSettings: publisherEntityModuleSettingsSchema.default({
      revision: 0,
      chatComments: null,
      channelSuggestionsEnabled: null,
    }),
    readiness: publisherEntityReadinessSchema,
  })
  .strict();
export type PublisherEntity = z.infer<typeof publisherEntitySchema>;

export const MAX_PUBLISHER_ENTITIES_CURSOR_LENGTH = 1_024;
export const MAX_PUBLISHER_ENTITY_RESOLVE_TARGETS = 500;
export const MAX_PUBLISHER_BULK_REFRESH_TARGETS = 50;
export const PUBLISHER_ENTITIES_CURSOR_INVALID_CODE = 'PUBLISHER_ENTITIES_CURSOR_INVALID';

export const publisherEntityReadinessFilterSchema = z.enum(['ready', 'attention']);
export type PublisherEntityReadinessFilter = z.infer<typeof publisherEntityReadinessFilterSchema>;

export const publisherEntitiesCursorPayloadSchema = z
  .object({
    v: z.literal(1),
    snapshotId: z
      .string()
      .trim()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/u),
    offset: z.number().int().min(1).max(1_000_000),
    query: z.string().max(120),
    entityType: managedEntityTypeSchema.nullable(),
    readiness: publisherEntityReadinessFilterSchema.nullable(),
  })
  .strict();
export type PublisherEntitiesCursorPayload = z.infer<typeof publisherEntitiesCursorPayloadSchema>;

export function encodePublisherEntitiesCursor(payload: PublisherEntitiesCursorPayload): string {
  const parsed = publisherEntitiesCursorPayloadSchema.parse(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function decodePublisherEntitiesCursor(
  value: string,
): PublisherEntitiesCursorPayload | null {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PUBLISHER_ENTITIES_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(normalized)
  ) {
    return null;
  }

  try {
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = globalThis.atob(
      `${normalized.replace(/-/gu, '+').replace(/_/gu, '/')}${padding}`,
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const parsed = publisherEntitiesCursorPayloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const publisherEntitiesCursorQuerySchema = z.object({
  pagination: z.literal('cursor'),
  cursor: z.string().trim().min(1).max(MAX_PUBLISHER_ENTITIES_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  query: z.string().trim().max(120).default(''),
  entityType: managedEntityTypeSchema.optional(),
  readiness: publisherEntityReadinessFilterSchema.optional(),
});
export type PublisherEntitiesCursorQuery = z.infer<typeof publisherEntitiesCursorQuerySchema>;

export const publisherEntitiesSummarySchema = z
  .object({
    total: z.number().int().min(0),
    chat: z.number().int().min(0),
    channel: z.number().int().min(0),
    ready: z.number().int().min(0),
    attention: z.number().int().min(0),
  })
  .strict();
export type PublisherEntitiesSummary = z.infer<typeof publisherEntitiesSummarySchema>;

export const publisherEntitiesResponseSchema = z
  .object({
    items: z.array(publisherEntitySchema),
    nextCursor: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PUBLISHER_ENTITIES_CURSOR_LENGTH)
      .nullable()
      .optional(),
    filteredTotal: z.number().int().min(0).optional(),
    summary: publisherEntitiesSummarySchema.optional(),
  })
  .strict();
export type PublisherEntitiesResponse = z.infer<typeof publisherEntitiesResponseSchema>;

export const publisherEntitiesCursorResponseSchema = publisherEntitiesResponseSchema.extend({
  nextCursor: z.string().trim().min(1).max(MAX_PUBLISHER_ENTITIES_CURSOR_LENGTH).nullable(),
  filteredTotal: z.number().int().min(0),
  summary: publisherEntitiesSummarySchema,
});
export type PublisherEntitiesCursorResponse = z.infer<typeof publisherEntitiesCursorResponseSchema>;

export const publisherEntityRefreshResponseSchema = z
  .object({
    accepted: z.literal(true),
  })
  .strict();
export type PublisherEntityRefreshResponse = z.infer<typeof publisherEntityRefreshResponseSchema>;

export const publisherEntitiesRefreshResponseSchema = z
  .object({
    accepted: z.literal(true),
    queuedCount: z.number().int().min(0).max(MAX_PUBLISHER_BULK_REFRESH_TARGETS),
  })
  .strict();
export type PublisherEntitiesRefreshResponse = z.infer<
  typeof publisherEntitiesRefreshResponseSchema
>;

export const resolvePublisherEntitiesRequestSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(256),
            entityType: managedEntityTypeSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PUBLISHER_ENTITY_RESOLVE_TARGETS),
  })
  .strict();
export type ResolvePublisherEntitiesRequest = z.infer<typeof resolvePublisherEntitiesRequestSchema>;

export const resolvePublisherEntitiesResponseSchema = z
  .object({ items: z.array(publisherEntitySchema).max(MAX_PUBLISHER_ENTITY_RESOLVE_TARGETS) })
  .strict();
export type ResolvePublisherEntitiesResponse = z.infer<
  typeof resolvePublisherEntitiesResponseSchema
>;

export const updateManagedEntityPublicationPolicyRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    publikEnabled: z.boolean(),
  })
  .strict();
export type UpdateManagedEntityPublicationPolicyRequest = z.infer<
  typeof updateManagedEntityPublicationPolicyRequestSchema
>;

export const publisherSuggestionReviewStatusSchema = z.enum([
  'pending',
  'publishing',
  'published',
  'cancelled',
]);
export type PublisherSuggestionReviewStatus = z.infer<typeof publisherSuggestionReviewStatusSchema>;

export const publisherSuggestionSchema = z
  .object({
    id: z.string().trim().min(1),
    text: z.string(),
    textFormat: broadcastTextFormatSchema,
    authorDisplayName: z.string().nullable(),
    createdAt: z.string().datetime(),
    reviewStatus: publisherSuggestionReviewStatusSchema,
    publicationId: z.string().trim().min(1).nullable(),
    reviewError: z.string().trim().min(1).max(300).nullable().optional(),
  })
  .strict();
export type PublisherSuggestion = z.infer<typeof publisherSuggestionSchema>;

export const MAX_PUBLISHER_SUGGESTIONS_CURSOR_LENGTH = 1_024;

export const publisherSuggestionsViewSchema = z.enum(['pending', 'history']);
export type PublisherSuggestionsView = z.infer<typeof publisherSuggestionsViewSchema>;

export const publisherSuggestionsQuerySchema = z
  .object({
    view: publisherSuggestionsViewSchema.default('pending'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().trim().min(1).max(MAX_PUBLISHER_SUGGESTIONS_CURSOR_LENGTH).optional(),
  })
  .strict();
export type PublisherSuggestionsQuery = z.infer<typeof publisherSuggestionsQuerySchema>;

export const publisherSuggestionsResponseSchema = z
  .object({
    items: z.array(publisherSuggestionSchema).max(100),
    total: z.number().int().min(0),
    nextCursor: z.string().trim().min(1).max(MAX_PUBLISHER_SUGGESTIONS_CURSOR_LENGTH).nullable(),
  })
  .strict();
export type PublisherSuggestionsResponse = z.infer<typeof publisherSuggestionsResponseSchema>;

export const reviewPublisherSuggestionRequestSchema = z
  .object({
    action: z.enum(['publish', 'cancel']),
    responseVersion: z.literal(2).optional(),
  })
  .strict();
export type ReviewPublisherSuggestionRequest = z.infer<
  typeof reviewPublisherSuggestionRequestSchema
>;

export const reviewPublisherSuggestionResponseSchema = z
  .object({ suggestion: publisherSuggestionSchema })
  .strict();
export type ReviewPublisherSuggestionResponse = z.infer<
  typeof reviewPublisherSuggestionResponseSchema
>;

export const updatePublisherEntityModuleSettingsRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    channelSuggestionsEnabled: z.boolean().optional(),
    chatComments: publisherChatCommentSettingsSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.channelSuggestionsEnabled !== undefined || value.chatComments !== undefined,
    'Specify at least one Publisher module setting',
  );
export type UpdatePublisherEntityModuleSettingsRequest = z.infer<
  typeof updatePublisherEntityModuleSettingsRequestSchema
>;

export const publisherPostImportCreateRequestSchema = z
  .object({
    requestId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,128}$/u),
  })
  .strict();
export type PublisherPostImportCreateRequest = z.infer<
  typeof publisherPostImportCreateRequestSchema
>;

export const publisherPostImportStatusSchema = z.enum([
  'waiting',
  'processing',
  'ready',
  'failed',
  'canceled',
  'expired',
]);
export type PublisherPostImportStatus = z.infer<typeof publisherPostImportStatusSchema>;

export const publisherPostImportFailureCodeSchema = z.enum([
  'invalid_forward',
  'message_unavailable',
  'unsupported_content',
  'text_too_long',
  'too_many_images',
  'image_too_large',
  'media_too_large',
  'media_download_failed',
  'processing_timeout',
  'internal_error',
]);
export type PublisherPostImportFailureCode = z.infer<typeof publisherPostImportFailureCodeSchema>;

export const publisherPostImportOmissionSchema = z.enum([
  'buttons_not_imported',
  'formatting_not_preserved',
]);
export type PublisherPostImportOmission = z.infer<typeof publisherPostImportOmissionSchema>;

export const publisherPostImportSessionSchema = z
  .object({
    id: z.string().trim().min(1),
    status: publisherPostImportStatusSchema,
    expiresAt: z.string().datetime(),
    publicationId: z.string().trim().min(1).nullable(),
    botUrl: z.string().url().nullable(),
    failureCode: publisherPostImportFailureCodeSchema.nullable(),
    omissions: z.array(publisherPostImportOmissionSchema),
  })
  .strict();
export type PublisherPostImportSession = z.infer<typeof publisherPostImportSessionSchema>;

export const publisherPostImportCurrentResponseSchema = z
  .object({
    session: publisherPostImportSessionSchema.nullable(),
  })
  .strict();
export type PublisherPostImportCurrentResponse = z.infer<
  typeof publisherPostImportCurrentResponseSchema
>;
