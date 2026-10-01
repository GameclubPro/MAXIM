import { z } from 'zod';
import { reportDeleteModeSchema } from './report-settings.js';

export * from './report-settings.js';

export const reportStatusSchema = z.enum([
  'COLLECTING',
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'DISMISSED',
  'EXPIRED',
  'CANCELLED',
]);
export const reportSummarySchema = z.object({
  id: z.string(),
  messageId: z.string(),
  authorId: z.string(),
  status: reportStatusSchema,
  votes: z.number().int(),
  threshold: z.number().int(),
  deleteMode: reportDeleteModeSchema,
  muteHours: z.number().int().nullable(),
  muteApplied: z.boolean(),
  candidates: z.number().int(),
  deleted: z.number().int(),
  absent: z.number().int().nonnegative().default(0),
  pending: z.number().int(),
  failed: z.number().int(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastError: z.string().nullable(),
  contentVersion: z.number().int().positive().optional(),
  updatedAt: z.string().datetime().optional(),
  snapshotVersion: z.string().max(100).optional(),
  detailsArchived: z.boolean().default(false),
});
export const reportJournalStatusSchema = z.enum(['ALL', 'ACTIVE', 'FAILED', 'COMPLETED']);
export const reportJournalFiltersSchema = z
  .object({
    status: reportJournalStatusSchema.default('ALL'),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    authorId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Конец периода раньше начала.' });
    }
  });
export type ReportJournalFilters = z.infer<typeof reportJournalFiltersSchema>;
export const reportAvailabilitySchema = z.object({
  reportsAvailable: z.boolean(),
  observedAt: z.string().datetime(),
});
export type ReportAvailability = z.infer<typeof reportAvailabilitySchema>;
export const reportsPageSchema = z.object({
  items: z.array(reportSummarySchema),
  nextCursor: z.string().nullable(),
  observedAt: z.string().datetime().optional(),
});
export const reportDetailSchema = reportSummarySchema.extend({
  observedAt: z.string().datetime().optional(),
  authorName: z.string().nullable().optional(),
  authorProfileUrl: z.string().url().nullable().optional(),
  authorProfileHandoffUrl: z.string().url().nullable().optional(),
  reporters: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string().nullable().optional(),
      profileUrl: z.string().url().nullable().optional(),
      profileHandoffUrl: z.string().url().nullable().optional(),
      createdAt: z.string().datetime(),
    }),
  ),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;
export type ReportsPage = z.infer<typeof reportsPageSchema>;
export type ReportDetail = z.infer<typeof reportDetailSchema>;
