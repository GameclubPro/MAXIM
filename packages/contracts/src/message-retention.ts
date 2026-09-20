import { z } from 'zod';

export const messageRetentionHoursSchema = z.union([z.literal(24), z.literal(48)]);
export const updateMessageRetentionSchema = z.strictObject({
  enabled: z.boolean(),
  hours: messageRetentionHoursSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export const messageRetentionStateSchema = z.object({
  enabled: z.boolean(),
  hours: messageRetentionHoursSchema,
  revision: z.number().int().nonnegative(),
  enabledAt: z.string().datetime().nullable(),
  captureAfter: z.string().datetime().nullable(),
  pausedAt: z.string().datetime().nullable(),
  status: z.enum([
    'off',
    'unavailable',
    'shadow',
    'running',
    'delayed',
    'paused',
    'capacity_paused',
    'no_access',
    'error',
  ]),
  pendingCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  oldestDueAt: z.string().datetime().nullable(),
});
export type UpdateMessageRetention = z.infer<typeof updateMessageRetentionSchema>;
export type MessageRetentionState = z.infer<typeof messageRetentionStateSchema>;
