import { z } from 'zod';
export const sanctionActionSchema = z.enum(['NONE', 'WARN', 'DELETE_MESSAGE', 'KICK', 'BAN']);
export const profanityLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const linkPolicySchema = z.enum(['ALLOWLIST_ONLY', 'BLOCKLIST_ONLY', 'ALERT_ONLY']);
const duplicateWindowSecSchema = z.number().int().min(3600).max(604800);
const duplicateMaxCountSchema = z.number().int().min(2).max(20);
export const chatSettingsSchema = z
  .object({
    profanityLevel: profanityLevelSchema.default('MEDIUM'),
    capsThreshold: z.number().min(0).max(100).default(70),
    floodWindowSec: z.number().int().min(1).max(120).default(10),
    floodMaxMessages: z.number().int().min(1).max(50).default(5),
    duplicateWindowSec: z.number().int().min(5).max(3600).default(60),
    duplicateMaxCount: z.number().int().min(2).max(20).default(3),
    duplicateWarnEnabled: z.boolean().default(true),
    duplicateKickEnabled: z.boolean().default(true),
    duplicateBanEnabled: z.boolean().default(true),
    duplicateWarnWindowSec: duplicateWindowSecSchema.default(43200),
    duplicateWarnMaxCount: duplicateMaxCountSchema.default(2),
    duplicateKickWindowSec: duplicateWindowSecSchema.default(86400),
    duplicateKickMaxCount: duplicateMaxCountSchema.default(3),
    duplicateBanWindowSec: duplicateWindowSecSchema.default(172800),
    duplicateBanMaxCount: duplicateMaxCountSchema.default(4),
    linkPolicy: linkPolicySchema.default('ALLOWLIST_ONLY'),
    warnThreshold: z.number().int().min(1).max(10).default(3),
    repeatBanWindowDays: z.number().int().min(1).max(30).default(7),
    logRetentionDays: z.number().int().min(7).max(365).default(90),
  })
  .superRefine((value, ctx) => {
    const stages = [
      {
        enabled: value.duplicateWarnEnabled,
        window: value.duplicateWarnWindowSec,
        threshold: value.duplicateWarnMaxCount,
        windowPath: ['duplicateWarnWindowSec'],
        thresholdPath: ['duplicateWarnMaxCount'],
      },
      {
        enabled: value.duplicateKickEnabled,
        window: value.duplicateKickWindowSec,
        threshold: value.duplicateKickMaxCount,
        windowPath: ['duplicateKickWindowSec'],
        thresholdPath: ['duplicateKickMaxCount'],
      },
      {
        enabled: value.duplicateBanEnabled,
        window: value.duplicateBanWindowSec,
        threshold: value.duplicateBanMaxCount,
        windowPath: ['duplicateBanWindowSec'],
        thresholdPath: ['duplicateBanMaxCount'],
      },
    ].filter((stage) => stage.enabled);
    for (let index = 1; index < stages.length; index += 1) {
      const previous = stages[index - 1];
      const current = stages[index];
      if (current.window < previous.window) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: current.windowPath,
          message: 'Окно должно быть не меньше предыдущей ступени.',
        });
      }
      if (current.threshold < previous.threshold) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: current.thresholdPath,
          message: 'Лимит должен быть не меньше предыдущей ступени.',
        });
      }
    }
  });
export const moderationEventSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  userId: z.string(),
  eventType: z.enum(['MESSAGE', 'MEMBER_ACTION', 'SYSTEM']),
  ruleCode: z.string(),
  action: sanctionActionSchema,
  maskedExcerpt: z.string().nullable(),
  score: z.number(),
  createdAt: z.string().datetime(),
  operator: z.enum(['BOT', 'ADMIN']),
});
export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
});
export const meSchema = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
});
export const dateRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const updateSettingsRequestSchema = chatSettingsSchema;
export const addAdminRequestSchema = z.object({
  userId: z.string(),
});
export const addDomainRequestSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(3)
    .regex(/^[a-zA-Z0-9.-]+$/),
});
export const maxMessagePayloadSchema = z.object({
  messageId: z.string(),
  chatId: z.string(),
  senderId: z.string(),
  text: z.string().default(''),
  createdAt: z.string().datetime(),
});
export const maxUpdateSchema = z.object({
  updateId: z.string(),
  type: z.string(),
  message: maxMessagePayloadSchema.optional(),
  raw: z.record(z.any()).optional(),
});
