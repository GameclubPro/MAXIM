import { z } from 'zod';

export const chatParticipantRoleSchema = z.enum(['owner', 'admin', 'member']);
export type ChatParticipantRole = z.infer<typeof chatParticipantRoleSchema>;

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
  lastMaxActivityAt: z.string().datetime().nullable().optional(),
  activityCheckedAt: z.string().datetime().nullable().optional(),
});
export type ChatParticipantItem = z.infer<typeof chatParticipantItemSchema>;
