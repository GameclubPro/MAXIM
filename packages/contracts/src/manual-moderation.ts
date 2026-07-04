import { z } from 'zod';

export const manualModerationActionSchema = z.enum(['MUTE', 'BAN', 'UNMUTE', 'UNBAN']);
export type ManualModerationAction = z.infer<typeof manualModerationActionSchema>;

export const manualModerationScopeSchema = z.enum(['current_chat', 'all_chats']);
export type ManualModerationScope = z.infer<typeof manualModerationScopeSchema>;

export const manualModerationActionRequestSchema = z
  .object({
    action: manualModerationActionSchema,
    scope: manualModerationScopeSchema.optional(),
    muteDurationHours: z.number().int().min(1).max(336).optional(),
    mutePermanent: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const mutePermanent = value.mutePermanent === true;

    if (value.action === 'MUTE' && !mutePermanent && value.muteDurationHours === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['muteDurationHours'],
        message: 'Укажите длительность мута в часах.',
      });
    }

    if (value.action === 'MUTE' && mutePermanent && value.muteDurationHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['muteDurationHours'],
        message: 'Для бессрочного мута длительность не нужна.',
      });
    }

    if (value.action !== 'MUTE' && value.muteDurationHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['muteDurationHours'],
        message: 'Длительность мута доступна только для действия MUTE.',
      });
    }

    if (value.action !== 'MUTE' && value.mutePermanent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mutePermanent'],
        message: 'Бессрочный мут доступен только для действия MUTE.',
      });
    }

    if (value.action !== 'MUTE' && value.action !== 'BAN' && value.scope !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'Область действия доступна только для MUTE и BAN.',
      });
    }
  });
export type ManualModerationActionRequest = z.infer<typeof manualModerationActionRequestSchema>;

export const manualModerationActionResultSchema = z.object({
  ok: z.literal(true),
  action: manualModerationActionSchema,
  userId: z.string(),
  muteDurationHours: z.number().int().min(1).max(336).nullable(),
  muteExpiresAt: z.string().datetime().nullable(),
  message: z.string().min(1),
});
export type ManualModerationActionResult = z.infer<typeof manualModerationActionResultSchema>;
