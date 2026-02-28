import { z } from 'zod';

export const sanctionActionSchema = z.enum(['NONE', 'WARN', 'DELETE_MESSAGE', 'KICK', 'BAN']);
export type SanctionAction = z.infer<typeof sanctionActionSchema>;

export const profanityLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const linkPolicySchema = z.enum(['ALLOWLIST_ONLY', 'BLOCKLIST_ONLY', 'ALERT_ONLY']);

export const chatSettingsSchema = z.object({
  profanityLevel: profanityLevelSchema.default('MEDIUM'),
  capsThreshold: z.number().min(0).max(100).default(70),
  floodWindowSec: z.number().int().min(1).max(120).default(10),
  floodMaxMessages: z.number().int().min(1).max(50).default(5),
  duplicateWindowSec: z.number().int().min(5).max(3600).default(60),
  duplicateMaxCount: z.number().int().min(2).max(20).default(3),
  linkPolicy: linkPolicySchema.default('ALLOWLIST_ONLY'),
  warnThreshold: z.number().int().min(1).max(10).default(3),
  repeatBanWindowDays: z.number().int().min(1).max(30).default(7),
  logRetentionDays: z.number().int().min(7).max(365).default(90),
});
export type ChatSettings = z.infer<typeof chatSettingsSchema>;

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
export type ModerationEvent = z.infer<typeof moderationEventSchema>;

export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const meSchema = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
});
export type Me = z.infer<typeof meSchema>;

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
  chatTitle: z.string().optional(),
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

export type MaxUpdate = z.infer<typeof maxUpdateSchema>;
