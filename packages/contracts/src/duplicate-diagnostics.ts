import { z } from 'zod';

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
});

export const duplicateDiagnosticsResponseSchema = z.object({
  generatedAt: z.iso.datetime(),
  enabled: z.boolean(),
  mode: z.enum(['FULL', 'DELETE_ONLY', 'LEGACY_TEXT', 'UNKNOWN']),
  capability: duplicateDeletionCapabilitySchema,
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
