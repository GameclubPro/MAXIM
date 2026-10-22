import { z } from 'zod';
import { managedEntityHeaderSchema } from './managed-entities.js';
import { networkSettingsMetadataScopeSchema } from './network-settings-read.js';

export const networkSettingsRequiredSubscriptionResolveRequestSchema =
  networkSettingsMetadataScopeSchema.extend({ value: z.string().trim().min(1).max(2048) }).strict();
export const networkSettingsRequiredSubscriptionResolveResponseSchema = z
  .object({
    requestId: z.string().uuid(),
    compositionVersion: z.string(),
    channel: managedEntityHeaderSchema,
  })
  .strict();
export const networkSettingsAdminContactsReadRequestSchema = networkSettingsMetadataScopeSchema
  .extend({ cursor: z.string().uuid().optional() })
  .strict();
export const networkSettingsAdminContactsResolveRequestSchema = networkSettingsMetadataScopeSchema
  .extend({
    cursor: z.string().uuid(),
    sourceEntityId: z.string().min(1),
    userId: z.string().min(1),
  })
  .strict();
export const networkSettingsAdminContactSchema = z
  .object({
    userId: z.string(),
    displayName: z.string().nullable(),
    url: z.string().min(1),
    sources: z.array(z.string()),
  })
  .strict();
export const networkSettingsAdminContactsResponseSchema = z
  .object({
    requestId: z.string().uuid(),
    compositionVersion: z.string(),
    sessionId: z.string().uuid(),
    items: z.array(networkSettingsAdminContactSchema),
    scannedSources: z.number().int().nonnegative(),
    totalSources: z.number().int().nonnegative(),
    incompleteSources: z.array(z.string()),
    unavailableSources: z.array(z.string()),
    complete: z.boolean(),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export const networkSettingsAdminContactResolveResponseSchema = z
  .object({
    requestId: z.string().uuid(),
    compositionVersion: z.string(),
    contact: networkSettingsAdminContactSchema,
  })
  .strict();
