import { z } from 'zod';

export const safetyDeskDeleteCohortStatusSchema = z.enum([
  'OBSERVED',
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
]);
export const safetyDeskDeleteCohortOutcomeSchema = z.enum([
  'confirmed',
  'acknowledged',
  'already_absent',
  'unknown',
  'stopped',
  'observed',
  'pending',
]);
const count = z.number().int().min(0).max(512);
export const safetyDeskDeleteCohortRowSchema = z.object({
  status: safetyDeskDeleteCohortStatusSchema,
  countLowerBound: count,
  truncated: z.boolean(),
  outcomeCounts: z.object({
    confirmed: count,
    acknowledged: count,
    already_absent: count,
    unknown: count,
    stopped: count,
    observed: count,
    pending: count,
  }),
  deadlineCounts: z.object({ notElapsed: count, elapsed: count, invalid: count }),
  waitCounts: z.object({
    notDue: count,
    retryDue: count,
    leaseActive: count,
    leaseStale: count,
    capability: count,
    receiptSettlement: count,
    effectUnknown: count,
  }),
  waitCountsOverlap: z.literal(true),
  finalizedLatency: z.object({
    sampleCount: count,
    invalidClockCount: count,
    p95Ms: z.number().finite().nonnegative().nullable(),
    p99Ms: z.number().finite().nonnegative().nullable(),
  }),
});

export const safetyDeskDeleteCohortResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    basis: z.literal('delete_intent_created_at'),
    includesObservedOnly: z.literal(true),
    windowSeconds: z.literal(900),
    graceSeconds: z.literal(30),
    windowStartedAt: z.string().datetime(),
    windowEndedAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    sampleLimitPerStatus: z.literal(512),
    sampleComplete: z.boolean(),
    totalCountLowerBound: z.number().int().min(0).max(5120),
    rows: z.array(safetyDeskDeleteCohortRowSchema).length(10),
  })
  .superRefine((value, context) => {
    // FLAG: Observation-only, stopped and uncertain intents remain in the recorded denominator.
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    if (new Set(value.rows.map((row) => row.status)).size !== 10)
      issue(['rows'], 'Every stored deletion status is required');
    if (
      value.totalCountLowerBound !== value.rows.reduce((sum, row) => sum + row.countLowerBound, 0)
    )
      issue(['totalCountLowerBound'], 'Cohort total differs from its rows');
    if (value.sampleComplete !== value.rows.every((row) => !row.truncated))
      issue(['sampleComplete'], 'Capped samples are incomplete');
    if (
      Date.parse(value.windowEndedAt) - Date.parse(value.windowStartedAt) !== 900_000 ||
      Date.parse(value.observedAt) - Date.parse(value.windowEndedAt) !== 30_000
    )
      issue(['windowStartedAt'], 'Invalid closed cohort clocks');
    for (const [index, row] of value.rows.entries()) {
      if (row.truncated && row.countLowerBound !== 512)
        issue(['rows', index, 'truncated'], 'Truncation requires a saturated sample');
      for (const field of ['outcomeCounts', 'deadlineCounts'] as const) {
        if (Object.values(row[field]).reduce((sum, item) => sum + item, 0) !== row.countLowerBound)
          issue(['rows', index, field], 'Classification differs from its denominator');
      }
      if (Object.values(row.waitCounts).some((item) => item > row.countLowerBound))
        issue(['rows', index, 'waitCounts'], 'Saved wait count exceeds its denominator');
      const latency = row.finalizedLatency;
      if (
        latency.sampleCount > row.outcomeCounts.confirmed + row.outcomeCounts.already_absent ||
        latency.sampleCount + latency.invalidClockCount > row.countLowerBound ||
        (!['SUCCEEDED', 'ALREADY_ABSENT'].includes(row.status) &&
          (latency.sampleCount !== 0 || latency.invalidClockCount !== 0))
      )
        issue(['rows', index, 'finalizedLatency'], 'Latency requires finalized receipt evidence');
      if (
        (latency.sampleCount === 0) !== (latency.p95Ms === null) ||
        (latency.sampleCount === 0) !== (latency.p99Ms === null) ||
        (latency.p95Ms !== null && latency.p99Ms !== null && latency.p95Ms > latency.p99Ms)
      )
        issue(['rows', index, 'finalizedLatency'], 'Invalid finalized latency percentiles');
    }
  });

export type SafetyDeskDeleteCohortResponse = z.infer<typeof safetyDeskDeleteCohortResponseSchema>;
export type SafetyDeskDeleteCohortRow = z.infer<typeof safetyDeskDeleteCohortRowSchema>;
