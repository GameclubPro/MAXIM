import { z } from 'zod';

export const duplicateObservationOutcomeSchema = z.enum([
  'OFF',
  'SCHEDULE_CLOSED',
  'EVENT_TIME_REJECTED',
  'UNTRACKED',
  'CONTENT_UNVERIFIED',
  'UNSUPPORTED_CONTENT',
  'MEDIA_QUEUED',
  'MEDIA_CANDIDATE',
  'SOURCE_UNAVAILABLE',
  'POLICY_CHANGED',
  'SETTINGS_CHANGED',
  'STALE',
  'DEADLINE_EXPIRED',
  'DEFERRED',
  'COMPARISON_FAILED',
  'UNAVAILABLE',
  'COMPARED_NO_MATCH',
  'MATCHED_INELIGIBLE',
  'MATCHED_OBSERVE',
  'MATCHED_ACTION_FAILED',
  'ENFORCEMENT_REQUESTED',
]);

export const duplicateObservationDiagnosticsSchema = z
  .object({
    state: z.enum(['AVAILABLE', 'NO_DATA', 'UNAVAILABLE']),
    since: z.iso.datetime(),
    until: z.iso.datetime(),
    basis: z.literal('ATTEMPTS'),
    completeness: z.literal('BEST_EFFORT'),
    supportedAttempts: z.number().int().nonnegative().nullable(),
    verifiedAttempts: z.number().int().nonnegative().nullable(),
    coverage: z.number().min(0).max(1).nullable(),
    outcomes: z
      .array(
        z.object({
          outcome: duplicateObservationOutcomeSchema,
          count: z.number().int().nonnegative(),
        }),
      )
      .max(22),
  })
  .refine((value) => {
    if (value.state !== 'AVAILABLE')
      return (
        value.supportedAttempts === null &&
        value.verifiedAttempts === null &&
        value.coverage === null &&
        value.outcomes.length === 0
      );
    if (
      value.supportedAttempts === null ||
      value.verifiedAttempts === null ||
      value.verifiedAttempts > value.supportedAttempts
    )
      return false;
    return (
      value.coverage ===
      (value.supportedAttempts > 0 ? value.verifiedAttempts / value.supportedAttempts : null)
    );
  }, 'Observation coverage must reflect available attempt counts');

export const duplicateDeletionCapabilitySchema = z.object({
  state: z.enum(['CONFIRMED', 'MISSING', 'UNKNOWN']),
  checkedAt: z.iso.datetime().nullable(),
});

export const duplicateDeletionAttemptSchema = z.object({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  outcome: z.enum([
    'DELETED',
    'ALREADY_ABSENT',
    'PENDING',
    'RETRYING',
    'WAITING_ACCESS',
    'UNCONFIRMED',
    'EXPIRED',
    'CANCELLED',
    'OBSERVED',
  ]),
  reason: z
    .enum(['IMMUNITY', 'AUTHOR_LEFT', 'CONTENT_CHANGED', 'POLICY_CHANGED', 'UNKNOWN'])
    .nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
  original: z
    .object({
      messageId: z.string().min(1).max(512),
      publishedAt: z.iso.datetime(),
      repeatAllowedAt: z.iso.datetime(),
    })
    .optional(),
});

export const duplicateDiagnosticsResponseSchema = z.object({
  generatedAt: z.iso.datetime(),
  enabled: z.boolean(),
  mode: z.enum(['FULL', 'DELETE_ONLY', 'OFF', 'OBSERVE', 'LEGACY_TEXT', 'UNKNOWN']),
  capability: duplicateDeletionCapabilitySchema,
  // Older API responses have no observation telemetry; absence never means full coverage.
  observation: duplicateObservationDiagnosticsSchema.optional(),
  history: z.object({
    available: z.boolean(),
    since: z.iso.datetime(),
    sampledIntents: z.number().int().min(0).max(210),
    limited: z.boolean(),
    attempts: z.array(duplicateDeletionAttemptSchema).max(5),
  }),
});

export type DuplicateDeletionCapability = z.infer<typeof duplicateDeletionCapabilitySchema>;
export type DuplicateDeletionAttempt = z.infer<typeof duplicateDeletionAttemptSchema>;
export type DuplicateDiagnosticsResponse = z.infer<typeof duplicateDiagnosticsResponseSchema>;
export type DuplicateObservationOutcome = z.infer<typeof duplicateObservationOutcomeSchema>;
export type DuplicateObservationDiagnostics = z.infer<typeof duplicateObservationDiagnosticsSchema>;
