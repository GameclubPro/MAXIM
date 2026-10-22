import { z } from 'zod';
import { managedEntityTypeSchema } from './managed-entity-type.js';
import {
  networkNavigationAllowlistImpactSchema,
  networkNavigationAllowlistIntentSchema,
  networkSettingsOperationStatusSchema,
  networkSettingsReadRequestSchema,
  networkSettingsRecipientSchema,
  networkSettingsSectionSchema,
} from './network-settings-read.js';

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
    changes: z.array(networkSettingsChangeSchema).max(128),
    navigationAllowlist: networkNavigationAllowlistIntentSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.changes.length && !value.navigationAllowlist)
      ctx.addIssue({ code: 'custom', path: ['changes'], message: 'Выберите изменения.' });
    if (value.navigationAllowlist) {
      if (value.entityType !== 'chat' || value.section !== 'links')
        ctx.addIssue({
          code: 'custom',
          path: ['navigationAllowlist'],
          message: 'Список доступен только в настройках ссылок чатов.',
        });
      if (value.recipients.some((r) => !r.navigationAllowlistWitness))
        ctx.addIssue({
          code: 'custom',
          path: ['recipients'],
          message: 'Нужна проверка списка каждого получателя.',
        });
    }
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
    changes: z.array(networkSettingsChangeSchema),
    navigationAllowlist: networkNavigationAllowlistIntentSchema.optional(),
    navigationAllowlistImpacts: z.array(networkNavigationAllowlistImpactSchema).optional(),
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
    status: networkSettingsOperationStatusSchema,
    expiresAt: z.string().datetime(),
    navigationAllowlistImpacts: z.array(networkNavigationAllowlistImpactSchema).optional(),
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
