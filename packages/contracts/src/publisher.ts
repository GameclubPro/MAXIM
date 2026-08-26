import { z } from 'zod';
import { channelOverviewSchema, managedEntityTypeSchema } from './managed-entities.js';
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
]);
export type PublisherReadinessBlockerCode = z.infer<typeof publisherReadinessBlockerCodeSchema>;

export const managedEntityPublicationPolicySchema = z.object({
  publikEnabled: z.boolean(),
  suggestionsViaPublik: z.boolean(),
  revision: z.number().int().min(0),
  updatedAt: z.string().datetime().nullable(),
});
export type ManagedEntityPublicationPolicy = z.infer<typeof managedEntityPublicationPolicySchema>;

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

export const publisherEntitySchema = z.object({
  id: z.string().trim().min(1),
  title: z.string(),
  entityType: managedEntityTypeSchema,
  avatarUrl: z.string().trim().url().nullable().default(null),
  channelOverview: channelOverviewSchema.nullable().default(null),
  policy: managedEntityPublicationPolicySchema,
  readiness: publisherEntityReadinessSchema,
});
export type PublisherEntity = z.infer<typeof publisherEntitySchema>;

export const publisherEntitiesResponseSchema = z.object({
  items: z.array(publisherEntitySchema),
});
export type PublisherEntitiesResponse = z.infer<typeof publisherEntitiesResponseSchema>;

export const updateManagedEntityPublicationPolicyRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    publikEnabled: z.boolean().optional(),
    suggestionsViaPublik: z.boolean().optional(),
  })
  .refine(
    (value) => value.publikEnabled !== undefined || value.suggestionsViaPublik !== undefined,
    'Specify at least one publication policy field',
  );
export type UpdateManagedEntityPublicationPolicyRequest = z.infer<
  typeof updateManagedEntityPublicationPolicyRequestSchema
>;
