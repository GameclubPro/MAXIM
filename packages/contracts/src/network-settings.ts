import { z } from 'zod';
import { applySettingsSectionSchema } from './settings.js';
import { managedEntityFavoriteTypeSchema, managedEntityTypeSchema } from './managed-entities.js';

export const networkSettingsTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('category'), favoriteType: managedEntityFavoriteTypeSchema }).strict(),
  z
    .object({
      mode: z.literal('selected'),
      entityIds: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(500)
        .transform((ids) => [...new Set(ids)]),
    })
    .strict(),
]);
export type NetworkSettingsTarget = z.infer<typeof networkSettingsTargetSchema>;

export const networkChannelSettingsSectionSchema = z.enum([
  'quickButtons',
  'comments',
  'postSignature',
]);
export const networkSettingsSectionSchema = z.union([
  applySettingsSectionSchema,
  networkChannelSettingsSectionSchema,
]);
export type NetworkSettingsSection = z.infer<typeof networkSettingsSectionSchema>;

const revisionSchema = z.union([z.string().datetime(), z.number().int().nonnegative()]);
export const networkSettingsRecipientSchema = z
  .object({
    entityId: z.string().min(1),
    title: z.string(),
    revision: revisionSchema,
    stopWordsRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NetworkSettingsRecipient = z.infer<typeof networkSettingsRecipientSchema>;

export const networkSettingsReadRequestSchema = z
  .object({
    entityType: managedEntityTypeSchema,
    target: networkSettingsTargetSchema,
    section: networkSettingsSectionSchema,
    cursor: z.string().max(4096).optional(),
  })
  .strict();
export type NetworkSettingsReadRequest = z.infer<typeof networkSettingsReadRequestSchema>;

export const networkSettingsFieldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('common'), value: z.unknown() }).strict(),
  z.object({ kind: z.literal('mixed') }).strict(),
]);
export type NetworkSettingsField = z.infer<typeof networkSettingsFieldSchema>;

export const networkSettingsReadResponseSchema = z
  .object({
    entityType: managedEntityTypeSchema,
    target: networkSettingsTargetSchema,
    section: networkSettingsSectionSchema,
    compositionVersion: z.string(),
    recipients: z.array(networkSettingsRecipientSchema),
    fields: z.record(z.string(), networkSettingsFieldSchema),
    recipientCount: z.number().int().nonnegative(),
    complete: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type NetworkSettingsReadResponse = z.infer<typeof networkSettingsReadResponseSchema>;

// FLAG: Absence preserves a field; replace is explicit for arrays, and clear removes only a
// named optional media slot. Servers validate every path against the selected domain section.
export const networkSettingsChangeSchema = z.discriminatedUnion('op', [
  z
    .object({
      path: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){0,3}$/),
      op: z.literal('set'),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      path: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){0,3}$/),
      op: z.literal('replace'),
      value: z.array(z.unknown()),
    })
    .strict(),
  z
    .object({
      path: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){0,3}$/),
      op: z.literal('clear'),
    })
    .strict(),
]);
export type NetworkSettingsChange = z.infer<typeof networkSettingsChangeSchema>;

export const networkSettingsPreviewRequestSchema = networkSettingsReadRequestSchema
  .omit({ cursor: true })
  .extend({
    operationId: z.string().uuid(),
    compositionVersion: z.string(),
    recipients: z.array(networkSettingsRecipientSchema).min(1),
    changes: z.array(networkSettingsChangeSchema).min(1).max(128),
  })
  .superRefine((value, ctx) => {
    const ids = value.recipients.map((recipient) => recipient.entityId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['recipients'], message: 'Получатели повторяются.' });
    }
    const paths = value.changes.map((change) => change.path);
    if (
      paths.some((path, index) =>
        paths.some(
          (other, otherIndex) =>
            index !== otherIndex && (other === path || other.startsWith(`${path}.`)),
        ),
      )
    ) {
      ctx.addIssue({ code: 'custom', path: ['changes'], message: 'Изменения полей пересекаются.' });
    }
  });
export type NetworkSettingsPreviewRequest = z.infer<typeof networkSettingsPreviewRequestSchema>;

export const networkSettingsPreviewResponseSchema = z
  .object({
    operationId: z.string().uuid(),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime(),
    status: z.enum([
      'PREVIEWING',
      'PREPARED',
      'AUTHORIZING',
      'RUNNING',
      'COMPLETE',
      'PARTIAL',
      'FAILED',
    ]),
    entityType: managedEntityTypeSchema,
    section: networkSettingsSectionSchema,
    recipients: z.array(networkSettingsRecipientSchema).min(1),
    changes: z.array(networkSettingsChangeSchema).min(1),
  })
  .strict();
export type NetworkSettingsPreviewResponse = z.infer<typeof networkSettingsPreviewResponseSchema>;

export const networkSettingsApplyRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type NetworkSettingsApplyRequest = z.infer<typeof networkSettingsApplyRequestSchema>;

export const networkSettingsOperationResponseSchema = z
  .object({
    operationId: z.string().uuid(),
    entityType: managedEntityTypeSchema,
    section: networkSettingsSectionSchema,
    status: z.enum([
      'PREVIEWING',
      'PREPARED',
      'AUTHORIZING',
      'RUNNING',
      'COMPLETE',
      'PARTIAL',
      'FAILED',
    ]),
    expiresAt: z.string().datetime(),
    outcomes: z.array(
      z
        .object({
          entityId: z.string(),
          status: z.enum(['PENDING', 'VALIDATED', 'AUTHORIZED', 'COMMITTED', 'COMPLETE', 'FAILED']),
          failureCode: z.string().optional(),
          failureMessage: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type NetworkSettingsOperationResponse = z.infer<
  typeof networkSettingsOperationResponseSchema
>;
