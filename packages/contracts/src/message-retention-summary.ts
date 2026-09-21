import { z } from 'zod';

export const messageRetentionHoursSchema = z.union([z.literal(24), z.literal(48)]);
export const messageRetentionSummarySchema = z.object({
  enabled: z.boolean(),
  hours: messageRetentionHoursSchema,
  revision: z.number().int().nonnegative(),
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
});
export type MessageRetentionSummary = z.infer<typeof messageRetentionSummarySchema>;
