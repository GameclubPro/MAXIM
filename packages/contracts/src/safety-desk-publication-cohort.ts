import { z } from 'zod';

export const safetyDeskPublicationCohortStatusSchema = z.enum([
  'SCHEDULED',
  'IN_PROGRESS',
  'SENT',
  'PARTIAL',
  'FAILED',
  'AMBIGUOUS',
  'CANCELED',
]);
const count = z.number().int().min(0).max(512);
export const safetyDeskPublicationCohortRowSchema = z.object({
  status: safetyDeskPublicationCohortStatusSchema,
  countLowerBound: count,
  truncated: z.boolean(),
  pendingNotDue: count,
  pendingDue: count,
  pendingExpired: count,
  pendingTimingUnknown: count,
  blockedPending: count,
  retryAuthorizedCount: count,
  oldestDueAgeSec: z.number().finite().nonnegative().nullable(),
  modeCounts: z.object({
    NOW: count,
    ONCE: count,
    SLOTS: count,
    RECURRENCE: count,
    UNKNOWN: count,
  }),
  mediaCounts: z.object({ TEXT: count, IMAGE: count, VIDEO: count, UNKNOWN: count }),
});

export const safetyDeskPublicationCohortResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    basis: z.literal('occurrence_created_at'),
    dispatchProfile: z.literal('PUBLIK_V1'),
    windowSeconds: z.literal(900),
    graceSeconds: z.literal(30),
    windowStartedAt: z.string().datetime(),
    windowEndedAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    sampleLimitPerStatus: z.literal(512),
    sampleComplete: z.boolean(),
    totalCountLowerBound: z.number().int().min(0).max(3584),
    completionTimingEvidence: z.literal('not_recorded'),
    effectsEvidence: z.literal('occurrence_status_only'),
    rows: z.array(safetyDeskPublicationCohortRowSchema).length(7),
  })
  .superRefine((value, context) => {
    // FLAG: Every accepted occurrence status belongs to the denominator, including unknown outcomes.
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    if (new Set(value.rows.map((row) => row.status)).size !== 7)
      issue(['rows'], 'Every occurrence status is required');
    if (
      value.totalCountLowerBound !== value.rows.reduce((sum, row) => sum + row.countLowerBound, 0)
    )
      issue(['totalCountLowerBound'], 'Cohort total differs from its rows');
    if (value.sampleComplete !== value.rows.every((row) => !row.truncated))
      issue(['sampleComplete'], 'Capped samples are incomplete');
    const start = Date.parse(value.windowStartedAt),
      end = Date.parse(value.windowEndedAt),
      observed = Date.parse(value.observedAt);
    if (end - start !== 900_000 || observed - end !== 30_000)
      issue(['windowStartedAt'], 'Invalid closed cohort clocks');
    for (const [index, row] of value.rows.entries()) {
      const pending =
        row.pendingNotDue + row.pendingDue + row.pendingExpired + row.pendingTimingUnknown;
      const expectedPending =
        row.status === 'SCHEDULED' || row.status === 'IN_PROGRESS' ? row.countLowerBound : 0;
      if (
        pending !== expectedPending ||
        row.blockedPending > pending ||
        row.retryAuthorizedCount > row.countLowerBound ||
        (row.truncated && row.countLowerBound !== 512)
      )
        issue(['rows', index], 'Invalid sampled counts');
      if ((row.pendingDue === 0) !== (row.oldestDueAgeSec === null))
        issue(['rows', index, 'oldestDueAgeSec'], 'Invalid due clock coverage');
      for (const field of ['modeCounts', 'mediaCounts'] as const) {
        if (Object.values(row[field]).reduce((sum, item) => sum + item, 0) !== row.countLowerBound)
          issue(['rows', index, field], 'Classification differs from its denominator');
      }
    }
  });

export type SafetyDeskPublicationCohortResponse = z.infer<
  typeof safetyDeskPublicationCohortResponseSchema
>;
export type SafetyDeskPublicationCohortRow = z.infer<typeof safetyDeskPublicationCohortRowSchema>;
