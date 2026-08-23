import { z } from 'zod';
import { booleanQueryFlagSchema } from './dashboard-common.js';

/** The durations offered by the private bot when granting storefront access. */
export const karavanStorefrontDurationSchema = z.enum(['1d', '7d', '30d', '90d', 'forever']);
export type KaravanStorefrontDuration = z.infer<typeof karavanStorefrontDurationSchema>;

export const KARAVAN_STOREFRONT_ALLOWLIST_PAGE_LIMIT_DEFAULT = 50;
export const KARAVAN_STOREFRONT_ALLOWLIST_PAGE_LIMIT_MAX = 100;

const karavanStorefrontUserIdSchema = z.string().trim().min(1).max(200);
const karavanStorefrontChatIdSchema = z.string().trim().min(1).max(200);
const karavanStorefrontMessageIdSchema = z.string().trim().min(1).max(200);

/** A current per-chat grant. Historical changes belong in the audit log. */
export const karavanStorefrontAllowlistEntrySchema = z.object({
  id: z.string().trim().min(1).max(200),
  // The list endpoint is chat-scoped and may redact this redundant field.
  chatId: karavanStorefrontChatIdSchema.optional(),
  userId: karavanStorefrontUserIdSchema,
  displayName: z.string().trim().min(1).max(256).nullable(),
  expiresAt: z.string().datetime().nullable(),
  // Audit provenance is optional in public responses; it remains persisted server-side.
  createdByUserId: karavanStorefrontUserIdSchema.optional(),
  sourceMessageId: karavanStorefrontMessageIdSchema.nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type KaravanStorefrontAllowlistEntry = z.infer<typeof karavanStorefrontAllowlistEntrySchema>;

export const karavanStorefrontAllowlistQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(KARAVAN_STOREFRONT_ALLOWLIST_PAGE_LIMIT_MAX)
    .default(KARAVAN_STOREFRONT_ALLOWLIST_PAGE_LIMIT_DEFAULT),
  cursor: z.string().trim().min(1).max(512).optional(),
  includeExpired: booleanQueryFlagSchema.default(false),
});
export type KaravanStorefrontAllowlistQuery = z.infer<typeof karavanStorefrontAllowlistQuerySchema>;

const karavanStorefrontAllowlistPageSchema = z.object({
  items: z.array(karavanStorefrontAllowlistEntrySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().trim().min(1).max(512).nullable(),
});
const karavanStorefrontAllowlistLegacyPageSchema = z
  .object({
    entries: z.array(karavanStorefrontAllowlistEntrySchema),
    nextCursor: z.string().trim().min(1).max(512).nullable(),
  })
  .transform(({ entries, nextCursor }) => ({
    items: entries,
    hasMore: nextCursor !== null,
    nextCursor,
  }));

/**
 * The legacy `entries` shape is accepted while an older API image is drained;
 * parsing always returns the canonical `items` page to consumers.
 */
export const karavanStorefrontAllowlistResponseSchema = z.union([
  karavanStorefrontAllowlistPageSchema,
  karavanStorefrontAllowlistLegacyPageSchema,
]);
export type KaravanStorefrontAllowlistResponse = z.infer<
  typeof karavanStorefrontAllowlistResponseSchema
>;

/** The mini app sends no trusted identity in this request; the API derives it from auth. */
export const karavanStorefrontHandoffRequestSchema = z.object({});
export type KaravanStorefrontHandoffRequest = z.infer<typeof karavanStorefrontHandoffRequestSchema>;

export const karavanStorefrontHandoffResponseSchema = z.object({
  botUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'max.ru';
      } catch {
        return false;
      }
    }, 'Ожидается защищённая ссылка MAX.'),
});
export type KaravanStorefrontHandoffResponse = z.infer<
  typeof karavanStorefrontHandoffResponseSchema
>;

export const karavanStorefrontGrantDurationRequestSchema = z.object({
  duration: karavanStorefrontDurationSchema,
});
export type KaravanStorefrontGrantDurationRequest = z.infer<
  typeof karavanStorefrontGrantDurationRequestSchema
>;

/**
 * Accept both the current compact response and the older preview/edge response
 * while clients roll forward independently. New API code should return `revoked`.
 */
export const karavanStorefrontAllowlistRevokeResponseSchema = z
  .object({
    revoked: z.literal(true).optional(),
    ok: z.literal(true).optional(),
    message: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.revoked !== true && value.ok !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ожидается подтверждение отзыва доступа.',
        path: ['revoked'],
      });
    } else if (value.revoked !== true && !value.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ожидается сообщение о результате отзыва доступа.',
        path: ['message'],
      });
    }
  });
export type KaravanStorefrontAllowlistRevokeResponse = z.infer<
  typeof karavanStorefrontAllowlistRevokeResponseSchema
>;
