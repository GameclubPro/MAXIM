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
  'MATCHED_QUALIFICATION_REJECTED',
  'MATCHED_CLAIM_BLOCKED',
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
      .max(duplicateObservationOutcomeSchema.options.length),
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

export const duplicateDiagnosticsQuerySchema = z.object({
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export const duplicateMessageLinkResponseSchema = z
  .object({
    state: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    url: z
      .string()
      .max(2_048)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          url.hostname === 'max.ru' &&
          !url.username &&
          !url.password &&
          !url.port
        );
      })
      .nullable(),
  })
  .refine((value) => (value.state === 'AVAILABLE') === (value.url !== null));

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
  registeredAt: z.iso.datetime().optional(),
  target: z
    .object({
      messageId: z.string().min(1).max(512),
      publishedAt: z.iso.datetime().nullable(),
    })
    .optional(),
  comparison: z
    .object({
      mode: z.enum(['TEXT', 'MESSAGE', 'IMAGE']),
      kind: z.enum(['exact', 'content', 'near', 'link', 'phone', 'image', 'image_set', 'unknown']),
      windowSeconds: z.number().int().positive().max(604_800),
      firstDeletedMessageNumber: z.number().int().min(2).max(21),
    })
    .optional(),
  sanction: z
    .object({
      action: z.enum(['WARN', 'MUTE', 'BAN']),
      state: z.enum(['REQUESTED', 'CONFIRMED']),
    })
    .optional(),
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
    attempts: z.array(duplicateDeletionAttemptSchema).max(20),
    coverage: z.literal('PROJECTED_ONLY').optional(),
    nextCursor: z.string().max(1_024).nullable().optional(),
  }),
});

export type DuplicateDeletionCapability = z.infer<typeof duplicateDeletionCapabilitySchema>;
export type DuplicateDeletionAttempt = z.infer<typeof duplicateDeletionAttemptSchema>;
export type DuplicateDiagnosticsResponse = z.infer<typeof duplicateDiagnosticsResponseSchema>;
export type DuplicateObservationOutcome = z.infer<typeof duplicateObservationOutcomeSchema>;
export type DuplicateObservationDiagnostics = z.infer<typeof duplicateObservationDiagnosticsSchema>;
export type DuplicateDiagnosticsQuery = z.infer<typeof duplicateDiagnosticsQuerySchema>;
export type DuplicateMessageLinkResponse = z.infer<typeof duplicateMessageLinkResponseSchema>;
