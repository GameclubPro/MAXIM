import { z } from 'zod';

export const REPORT_DEFAULT_TRIGGERS = ['/report', 'жалоба'] as const;
export const reportDeleteModeSchema = z.enum(['MESSAGE', 'HISTORY_24H']);
export const reportSettingsShape = {
  reportsEnabled: z.boolean().default(false),
  reportsThreshold: z.number().int().min(2).max(6).default(3),
  reportsAliases: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .min(1)
        .max(32)
        .regex(/^\/?[\p{L}\p{N}_-]+$/u),
    )
    .max(5)
    .default([]),
  reportsDeleteMode: reportDeleteModeSchema.default('MESSAGE'),
  reportsMuteEnabled: z.boolean().default(false),
  reportsMuteDurationHours: z.number().int().min(1).max(24).default(1),
};
export const reportSettingsSchema = z.object(reportSettingsShape);
export type ReportSettings = z.infer<typeof reportSettingsSchema>;

export function addReportCommandIssues(
  settings: ReportSettings & Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const commands = Object.entries(settings)
    .filter(([key]) => /^admin.*Command(Name|Aliases)$/.test(key))
    .flatMap(([, value]) => (typeof value === 'string' ? value.split(/[\n,;]+/u) : []))
    .map((value) => value.trim().toLowerCase().replace(/^[/!]/u, ''));
  const reserved = new Set([...commands, 'start', 'старт', 'супер бан', 'super ban']);
  const triggers = [...REPORT_DEFAULT_TRIGGERS, ...settings.reportsAliases];
  if (new Set(triggers).size !== triggers.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['reportsAliases'],
      message: 'Команды жалоб не должны повторяться.',
    });
  }
  if (triggers.some((trigger) => reserved.has(trigger.replace(/^[/!]/u, '')))) {
    ctx.addIssue({
      code: 'custom',
      path: ['reportsAliases'],
      message: 'Команда жалобы совпадает с командой администратора.',
    });
  }
}

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
});
export const reportsPageSchema = z.object({
  items: z.array(reportSummarySchema),
  nextCursor: z.string().nullable(),
});
export const reportDetailSchema = reportSummarySchema.extend({
  authorName: z.string().nullable().optional(),
  reporters: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string().nullable().optional(),
      createdAt: z.string().datetime(),
    }),
  ),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;
export type ReportsPage = z.infer<typeof reportsPageSchema>;
export type ReportDetail = z.infer<typeof reportDetailSchema>;
