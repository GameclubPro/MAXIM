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
  operationId: z.string().uuid().optional(),
});
export const messageRetentionStateSchema = messageRetentionSummarySchema.extend({
  enabledAt: z.string().datetime().nullable(),
  captureAfter: z.string().datetime().nullable(),
  pausedAt: z.string().datetime().nullable(),
  pendingCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  oldestDueAt: z.string().datetime().nullable(),
  connectionStatus: z.enum(['connected', 'missing', 'no_access', 'unknown']).optional(),
  historyStatus: z.enum(['pending', 'running', 'complete', 'blocked', 'off']).optional(),
  historyScannedCount: z.number().int().nonnegative().optional(),
  lastOperationId: z.string().uuid().optional(),
});
export type UpdateMessageRetention = z.infer<typeof updateMessageRetentionSchema>;
export type MessageRetentionState = z.infer<typeof messageRetentionStateSchema>;
