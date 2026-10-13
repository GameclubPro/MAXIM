import { z } from 'zod';

export const chatClosureStatusSchema = z.object({
  observedAt: z.string().datetime(),
  scheduleEnabled: z.boolean(),
  restriction: z.enum(['open', 'night', 'manual']),
  timezone: z.string(),
  opensAt: z.string().nullable(),
  deleteRoute: z.enum(['available', 'unavailable', 'unknown']),
  notice: z.enum([
    'disabled',
    'not_expected',
    'not_recorded',
    'pending',
    'delivered',
    'unknown',
    'failed',
  ]),
  recovery: z.enum(['idle', 'waiting', 'delayed', 'action_required', 'unknown']),
});
export type ChatClosureStatus = z.infer<typeof chatClosureStatusSchema>;
