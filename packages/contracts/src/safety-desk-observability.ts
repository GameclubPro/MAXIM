import { z } from 'zod';

export const safetyDeskWebhookStatusSchema = z.enum([
  'RECEIVED',
  'QUEUED',
  'PROCESSED',
  'DUPLICATE',
  'FAILED',
  'NO_REPLAY_HELD',
  'CANCELLED',
  'QUARANTINED',
]);

const latencySchema = z.object({
  sampleCount: z.number().int().min(0).max(512),
  p95Ms: z.number().nonnegative().nullable(),
  p99Ms: z.number().nonnegative().nullable(),
});

export const safetyDeskWebhookCohortRowSchema = z.object({
  status: safetyDeskWebhookStatusSchema,
  countLowerBound: z.number().int().min(0).max(512),
  truncated: z.boolean(),
  oldestPendingAgeSec: z.number().nonnegative().nullable(),
  expiredAtObservation: z.number().int().min(0).max(512),
  quarantineTimestampPresent: z.number().int().min(0).max(512),
  invalidProcessedClocks: z.number().int().min(0).max(512),
  invalidQueuedClocks: z.number().int().min(0).max(512),
  processedLatency: latencySchema,
  enqueueLatency: latencySchema,
});

export const safetyDeskWebhookCohortResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    basis: z.literal('receipt_created_at'),
    windowSeconds: z.literal(30),
    graceSeconds: z.literal(30),
    windowStartedAt: z.string().datetime(),
    windowEndedAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    sampleLimitPerStatus: z.literal(512),
    sampleComplete: z.boolean(),
    totalCountLowerBound: z.number().int().min(0).max(4096),
    effectsEvidence: z.literal('not_linked'),
    rows: z.array(safetyDeskWebhookCohortRowSchema).length(8),
  })
  .superRefine((value, context) => {
    // FLAG: Receipt completion is not remote-effect proof. Missing statuses and capped
    // samples must never become a complete denominator in the closed owner dashboard.
    if (new Set(value.rows.map((row) => row.status)).size !== 8) {
      context.addIssue({
        code: 'custom',
        path: ['rows'],
        message: 'Every receipt status is required',
      });
    }
    if (
      value.totalCountLowerBound !== value.rows.reduce((sum, row) => sum + row.countLowerBound, 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['totalCountLowerBound'],
        message: 'Cohort total differs from its rows',
      });
    }
    if (value.sampleComplete !== value.rows.every((row) => !row.truncated)) {
      context.addIssue({
        code: 'custom',
        path: ['sampleComplete'],
        message: 'Capped samples are incomplete',
      });
    }
    for (const [index, row] of value.rows.entries()) {
      const counts = [
        row.expiredAtObservation,
        row.quarantineTimestampPresent,
        row.invalidProcessedClocks,
        row.invalidQueuedClocks,
        row.processedLatency.sampleCount,
        row.enqueueLatency.sampleCount,
      ];
      if (
        counts.some((count) => count > row.countLowerBound) ||
        (row.truncated && row.countLowerBound !== 512)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['rows', index],
          message: 'Invalid sampled counts',
        });
      }
      for (const field of ['processedLatency', 'enqueueLatency'] as const) {
        const latency = row[field];
        if (
          (latency.sampleCount === 0) !== (latency.p95Ms === null && latency.p99Ms === null) ||
          (latency.sampleCount > 0 && (latency.p95Ms === null || latency.p99Ms === null)) ||
          (latency.p95Ms !== null && latency.p99Ms !== null && latency.p95Ms > latency.p99Ms)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['rows', index, field],
            message: 'Invalid latency coverage',
          });
        }
      }
    }
  });

export type SafetyDeskWebhookCohortResponse = z.infer<typeof safetyDeskWebhookCohortResponseSchema>;
export type SafetyDeskWebhookCohortRow = z.infer<typeof safetyDeskWebhookCohortRowSchema>;
