import { z } from 'zod';
import {
  messageRetentionHoursSchema,
  messageRetentionSummarySchema,
} from './message-retention-summary.js';
export {
  messageRetentionHoursSchema,
  messageRetentionSummarySchema,
} from './message-retention-summary.js';
export type { MessageRetentionSummary } from './message-retention-summary.js';

export const updateMessageRetentionSchema = z.strictObject({
  enabled: z.boolean(),
  hours: messageRetentionHoursSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export const messageRetentionStateSchema = messageRetentionSummarySchema.extend({
  enabledAt: z.string().datetime().nullable(),
  captureAfter: z.string().datetime().nullable(),
  pausedAt: z.string().datetime().nullable(),
  pendingCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  oldestDueAt: z.string().datetime().nullable(),
});
export type UpdateMessageRetention = z.infer<typeof updateMessageRetentionSchema>;
export type MessageRetentionState = z.infer<typeof messageRetentionStateSchema>;
