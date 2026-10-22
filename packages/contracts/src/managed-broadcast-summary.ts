import { z } from 'zod';
import {
  MAX_BROADCAST_LINK_BUTTONS,
  broadcastTargetModeSchema,
  broadcastScheduleModeSchema,
} from './broadcast-common.js';
import { managedEntityTypeSchema } from './managed-entity-type.js';
import { broadcastLinkButtonSchema } from './broadcast-buttons.js';
import {
  broadcastScheduleTimezoneSchema,
  broadcastDateTimeSchema,
  inferBroadcastScheduleMode,
} from './broadcast-schedule-fields.js';

export const managedBroadcastTargetPreviewSchema = z.object({
  id: z.string(),
  title: z.string(),
  entityType: managedEntityTypeSchema.default('chat'),
  link: z.string().trim().max(2048).nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional().default(null),
});

export type ManagedBroadcastTargetPreview = z.infer<typeof managedBroadcastTargetPreviewSchema>;

export const managedBroadcastStatusSchema = z.enum([
  'ACTIVE',
  'PARTIAL',
  'FAILED',
  'COMPLETED',
  'CANCELED',
]);

export type ManagedBroadcastStatus = z.infer<typeof managedBroadcastStatusSchema>;

export const managedBroadcastFailureBreakdownSchema = z.object({
  transient: z.number().int().min(0),
  permanentTarget: z.number().int().min(0),
  quarantined: z.number().int().min(0),
  unknown: z.number().int().min(0),
});

export type ManagedBroadcastFailureBreakdown = z.infer<
  typeof managedBroadcastFailureBreakdownSchema
>;

export const managedBroadcastSummarySchema = z
  .object({
    id: z.string(),
    autopostRuleId: z.string().nullable().default(null),
    status: managedBroadcastStatusSchema,
    textPreview: z.string(),
    textLength: z.number().int().min(0),
    targetMode: broadcastTargetModeSchema.default('current'),
    applyToAllChats: z.boolean(),
    targetChatIds: z.array(z.string()).default([]),
    targetChats: z.number().int().min(1),
    targetPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
    targetOverflowCount: z.number().int().min(0).default(0),
    hasImage: z.boolean(),
    imageCount: z.number().int().min(0).default(0),
    hasVideo: z.boolean().default(false),
    buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
    buttonEnabled: z.boolean(),
    scheduleMode: broadcastScheduleModeSchema.default('legacy'),
    scheduleTimezone: broadcastScheduleTimezoneSchema,
    scheduledSlots: z.array(broadcastDateTimeSchema).default([]),
    nextSendAt: broadcastDateTimeSchema.nullable(),
    cycleEnabled: z.boolean(),
    cycleEveryHours: z.number().int().min(1),
    cycleCount: z.number().int().min(1),
    sentCount: z.number().int().min(0),
    currentOccurrence: z.number().int().min(1),
    deliveredChats: z.number().int().min(0),
    failedChats: z.number().int().min(0),
    pendingChats: z.number().int().min(0),
    blockedChats: z.number().int().min(0),
    failureBreakdown: managedBroadcastFailureBreakdownSchema,
    canRetry: z.boolean(),
    remainingCount: z.number().int().min(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastError: z.string().nullable(),
  })
  .transform((value) => ({
    ...value,
    scheduleMode: inferBroadcastScheduleMode(value),
  }));

export type ManagedBroadcastSummary = z.infer<typeof managedBroadcastSummarySchema>;
