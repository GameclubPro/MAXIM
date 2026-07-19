import { z } from 'zod';
import { logsDashboardRangeSchema } from './dashboard-common.js';

export const chatParticipantRoleSchema = z.enum(['owner', 'admin', 'member']);
export type ChatParticipantRole = z.infer<typeof chatParticipantRoleSchema>;

export const chatParticipantRoleFilterSchema = z.enum(['all', 'admins', 'members', 'bots']);
export type ChatParticipantRoleFilter = z.infer<typeof chatParticipantRoleFilterSchema>;

export const chatParticipantImmunityModeSchema = z.enum(['limited', 'always']);
export type ChatParticipantImmunityMode = z.infer<typeof chatParticipantImmunityModeSchema>;

export const chatParticipantImmunitySchema = z
  .object({
    mode: chatParticipantImmunityModeSchema.default('limited'),
    expiresAt: z.string().datetime().nullable().default(null),
    dailyViolationLimit: z.number().int().min(1).max(10).nullable().default(null),
    usedViolatingMessagesToday: z.number().int().min(0),
    remainingViolatingMessagesToday: z.number().int().min(0).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'always') {
      if (value.expiresAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expiresAt'],
          message: 'Для режима «Всегда» срок не нужен.',
        });
      }

      if (value.dailyViolationLimit !== null || value.remainingViolatingMessagesToday !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dailyViolationLimit'],
          message: 'Для режима «Всегда» лимит не нужен.',
        });
      }

      return;
    }

    if (value.expiresAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Укажите срок иммунитета.',
      });
    }

    if (value.dailyViolationLimit === null || value.remainingViolatingMessagesToday === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dailyViolationLimit'],
        message: 'Укажите лимит.',
      });
    }
  });
export type ChatParticipantImmunity = z.infer<typeof chatParticipantImmunitySchema>;

export const chatParticipantItemSchema = z.object({
  userId: z.string(),
  userDisplayName: z.string().min(1),
  username: z.string().trim().min(1).nullable().default(null),
  avatarUrl: z.string().trim().url().nullable().default(null),
  profileUrl: z.string().trim().url().nullable().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().default(null),
  violationCount: z.number().int().min(0).default(0),
  immunity: chatParticipantImmunitySchema.nullable().default(null),
  role: chatParticipantRoleSchema,
  isBot: z.boolean().default(false),
});
export type ChatParticipantItem = z.infer<typeof chatParticipantItemSchema>;

export const chatParticipantsPageSchema = z.object({
  items: z.array(chatParticipantItemSchema),
  totalCount: z.number().int().min(0).nullable().default(null),
  hasMore: z.boolean(),
  nextCursor: z.string().trim().min(1).nullable(),
});
export type ChatParticipantsPage = z.infer<typeof chatParticipantsPageSchema>;

export const chatParticipantsQuerySchema = z.object({
  range: logsDashboardRangeSchema.default('7d'),
  roleFilter: chatParticipantRoleFilterSchema.default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().trim().min(1).optional(),
  search: z.string().trim().max(100).optional(),
});
export type ChatParticipantsQuery = z.infer<typeof chatParticipantsQuerySchema>;

export const chatUnavailableParticipantReasonSchema = z.enum([
  'deleted',
  'blocked',
  'deactivated',
  'suspended',
]);
export type ChatUnavailableParticipantReason = z.infer<
  typeof chatUnavailableParticipantReasonSchema
>;

export const chatUnavailableParticipantsCleanupRequestSchema = z.object({
  dryRun: z.boolean().optional().default(false),
});
export type ChatUnavailableParticipantsCleanupRequest = z.infer<
  typeof chatUnavailableParticipantsCleanupRequestSchema
>;

export const chatUnavailableParticipantsCleanupItemSchema = z.object({
  userId: z.string(),
  userDisplayName: z.string().min(1),
  reason: chatUnavailableParticipantReasonSchema,
  status: z.enum(['candidate', 'removed', 'skipped', 'failed']),
  message: z.string().min(1).nullable().default(null),
});
export type ChatUnavailableParticipantsCleanupItem = z.infer<
  typeof chatUnavailableParticipantsCleanupItemSchema
>;

export const chatUnavailableParticipantsCleanupResultSchema = z.object({
  ok: z.literal(true),
  dryRun: z.boolean(),
  scannedCount: z.number().int().min(0),
  matchedCount: z.number().int().min(0),
  removedCount: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  scanLimitReached: z.boolean().default(false),
  items: z.array(chatUnavailableParticipantsCleanupItemSchema),
  message: z.string().min(1),
});
export type ChatUnavailableParticipantsCleanupResult = z.infer<
  typeof chatUnavailableParticipantsCleanupResultSchema
>;

export const chatParticipantImmunityUpdateRequestSchema = z
  .object({
    enabled: z.boolean(),
    mode: chatParticipantImmunityModeSchema.optional(),
    durationHours: z
      .number()
      .int()
      .min(24, 'Срок должен быть от 1 до 30 дней.')
      .max(720, 'Срок должен быть от 1 до 30 дней.')
      .optional(),
    dailyViolationLimit: z.number().int().min(1).max(10).optional(),
  })
  .superRefine((value, ctx) => {
    const mode = value.mode ?? 'limited';

    if (value.enabled && mode === 'limited' && value.durationHours === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationHours'],
        message: 'Укажите срок иммунитета.',
      });
    }

    if (value.enabled && mode === 'limited' && value.dailyViolationLimit === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dailyViolationLimit'],
        message: 'Укажите лимит.',
      });
    }

    if (value.enabled && mode === 'always' && value.durationHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationHours'],
        message: 'Для режима «Всегда» срок не нужен.',
      });
    }

    if (value.enabled && mode === 'always' && value.dailyViolationLimit !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dailyViolationLimit'],
        message: 'Для режима «Всегда» лимит не нужен.',
      });
    }

    if (!value.enabled && value.durationHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationHours'],
        message: 'Срок доступен только для активного иммунитета.',
      });
    }

    if (!value.enabled && value.dailyViolationLimit !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dailyViolationLimit'],
        message: 'Лимит доступен только для активного иммунитета.',
      });
    }

    if (!value.enabled && value.mode !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mode'],
        message: 'Режим доступен только для активного иммунитета.',
      });
    }
  });
export type ChatParticipantImmunityUpdateRequest = z.infer<
  typeof chatParticipantImmunityUpdateRequestSchema
>;

export const chatParticipantImmunityUpdateResultSchema = z.object({
  immunity: chatParticipantImmunitySchema.nullable().default(null),
  message: z.string().min(1),
});
export type ChatParticipantImmunityUpdateResult = z.infer<
  typeof chatParticipantImmunityUpdateResultSchema
>;
