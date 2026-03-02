import { z } from 'zod';
export const sanctionActionSchema = z.enum(['NONE', 'WARN', 'DELETE_MESSAGE', 'KICK', 'BAN']);
export const linkPolicySchema = z.enum(['ALLOWLIST_ONLY', 'BLOCKLIST_ONLY', 'ALERT_ONLY']);
export const commercialAdsSensitivitySchema = z.enum(['BALANCED', 'STRICT']);
const duplicateWindowSecSchema = z.number().int().min(3600).max(604800);
const duplicateMaxCountSchema = z.number().int().min(2).max(20);
const botButtonUrlSchema = z.string().trim().max(2048).default('');
const botButtonTextSchema = z.string().trim().max(32).default('Открыть');
function isValidBotButtonUrl(value) {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  try {
    const parsed = new globalThis.URL(normalized);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}
function isValidBotButtonText(value) {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 32;
}
function isValidIanaTimeZone(value) {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  try {
    Intl.DateTimeFormat('ru-RU', { timeZone: normalized }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
export const chatSettingsSchema = z
  .object({
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
    globalCrossChatSpamEnabled: z.boolean().default(false),
    antiSpamEnabled: z.boolean().default(true),
    maxMessageLengthEnabled: z.boolean().default(false),
    maxMessageLength: z.number().int().min(50).max(1500).default(1500),
    photoMessageCooldownEnabled: z.boolean().default(false),
    photoMessageCooldownHours: z.number().int().min(1).max(24).default(1),
    videoMessagesEnabled: z.boolean().default(true),
    fileMessagesEnabled: z.boolean().default(true),
    voiceMessagesEnabled: z.boolean().default(true),
    messageLimitsBotMessageEnabled: z.boolean().default(false),
    messageLimitsWarnEnabled: z.boolean().default(false),
    messageLimitsBanEnabled: z.boolean().default(false),
    messageLimitsKickEnabled: z.boolean().default(false),
    messageLimitsBotButtonEnabled: z.boolean().default(false),
    messageLimitsBotButtonUrl: botButtonUrlSchema,
    messageLimitsBotButtonText: botButtonTextSchema,
    russianProfanityFilterEnabled: z.boolean().default(true),
    commercialAdsFilterEnabled: z.boolean().default(false),
    commercialAdsSensitivity: commercialAdsSensitivitySchema.default('BALANCED'),
    commercialAdsWarnThreshold: z.number().int().min(10).max(90).default(45),
    commercialAdsDeleteThreshold: z.number().int().min(20).max(100).default(65),
    profanityBotMessageEnabled: z.boolean().default(false),
    profanityWarnEnabled: z.boolean().default(false),
    profanityBanEnabled: z.boolean().default(false),
    profanityKickEnabled: z.boolean().default(false),
    textFiltersBotMessageEnabled: z.boolean().default(false),
    textFiltersBotMessageText: z.string().max(1000).default(''),
    textFiltersWarnEnabled: z.boolean().default(false),
    textFiltersWarnMessageText: z.string().max(1000).default(''),
    textFiltersBanEnabled: z.boolean().default(false),
    textFiltersKickEnabled: z.boolean().default(false),
    textFiltersBotButtonEnabled: z.boolean().default(false),
    textFiltersBotButtonUrl: botButtonUrlSchema,
    textFiltersBotButtonText: botButtonTextSchema,
    nightModeEnabled: z.boolean().default(false),
    nightModeStartTimeMinutes: z
      .number()
      .int()
      .min(0)
      .max(1439)
      .default(23 * 60),
    nightModeEndTimeMinutes: z
      .number()
      .int()
      .min(0)
      .max(1439)
      .default(8 * 60),
    nightModeTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
    nightModeBotMessageEnabled: z.boolean().default(true),
    nightModeBotMessageText: z.string().max(1000).default(''),
    nightModeBotButtonEnabled: z.boolean().default(false),
    nightModeBotButtonUrl: botButtonUrlSchema,
    nightModeBotButtonText: botButtonTextSchema,
    linkBotMessageEnabled: z.boolean().default(true),
    linkBotMessageText: z.string().max(1000).default(''),
    linkWarnEnabled: z.boolean().default(false),
    linkWarnMessageText: z.string().max(1000).default(''),
    linkBanEnabled: z.boolean().default(false),
    linkKickEnabled: z.boolean().default(false),
    linkBotButtonEnabled: z.boolean().default(false),
    linkBotButtonUrl: botButtonUrlSchema,
    linkBotButtonText: botButtonTextSchema,
    duplicateBotMessageEnabled: z.boolean().default(false),
    duplicateBotButtonEnabled: z.boolean().default(false),
    duplicateBotButtonUrl: botButtonUrlSchema,
    duplicateBotButtonText: botButtonTextSchema,
    banDurationHours: z.number().int().min(1).max(36).default(6),
    warnThreshold: z.number().int().min(1).max(10).default(3),
  })
  .superRefine((value, ctx) => {
    const warnEnabled = value.duplicateWarnEnabled;
    const banEnabled = value.duplicateBanEnabled;
    const kickEnabled = value.duplicateKickEnabled;
    if (warnEnabled && banEnabled) {
      if (value.duplicateBanWindowSec < value.duplicateWarnWindowSec) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['duplicateBanWindowSec'],
          message: 'Окно должно быть не меньше предыдущей ступени.',
        });
      }
      if (value.duplicateBanMaxCount < value.duplicateWarnMaxCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['duplicateBanMaxCount'],
          message: 'Лимит должен быть не меньше предыдущей ступени.',
        });
      }
    }
    if (warnEnabled && kickEnabled) {
      if (value.duplicateKickWindowSec < value.duplicateWarnWindowSec) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['duplicateKickWindowSec'],
          message: 'Окно должно быть не меньше предыдущей ступени.',
        });
      }
      if (value.duplicateKickMaxCount < value.duplicateWarnMaxCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['duplicateKickMaxCount'],
          message: 'Лимит должен быть не меньше предыдущей ступени.',
        });
      }
    }
    if (
      value.linkBotMessageEnabled &&
      value.linkBotButtonEnabled &&
      !isValidBotButtonUrl(value.linkBotButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkBotButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }
    if (
      value.linkBotMessageEnabled &&
      value.linkBotButtonEnabled &&
      !isValidBotButtonText(value.linkBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }
    if (
      value.duplicateBotMessageEnabled &&
      value.duplicateBotButtonEnabled &&
      !isValidBotButtonUrl(value.duplicateBotButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duplicateBotButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }
    if (
      value.duplicateBotMessageEnabled &&
      value.duplicateBotButtonEnabled &&
      !isValidBotButtonText(value.duplicateBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duplicateBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }
    if (
      value.messageLimitsBotMessageEnabled &&
      value.messageLimitsBotButtonEnabled &&
      !isValidBotButtonUrl(value.messageLimitsBotButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messageLimitsBotButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }
    if (
      value.messageLimitsBotMessageEnabled &&
      value.messageLimitsBotButtonEnabled &&
      !isValidBotButtonText(value.messageLimitsBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messageLimitsBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }
    if (
      value.textFiltersBotMessageEnabled &&
      value.textFiltersBotButtonEnabled &&
      !isValidBotButtonUrl(value.textFiltersBotButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['textFiltersBotButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }
    if (
      value.textFiltersBotMessageEnabled &&
      value.textFiltersBotButtonEnabled &&
      !isValidBotButtonText(value.textFiltersBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['textFiltersBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }
    if (!isValidIanaTimeZone(value.nightModeTimezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nightModeTimezone'],
        message: 'Укажите корректный часовой пояс.',
      });
    }
    if (
      value.nightModeBotMessageEnabled &&
      value.nightModeBotButtonEnabled &&
      !isValidBotButtonUrl(value.nightModeBotButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nightModeBotButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }
    if (
      value.nightModeBotMessageEnabled &&
      value.nightModeBotButtonEnabled &&
      !isValidBotButtonText(value.nightModeBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nightModeBotButtonText'],
        message: 'Введите название кнопки.',
      });
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
  chatTitle: z.string().optional(),
  senderId: z.string(),
  senderName: z.string().optional(),
  text: z.string().default(''),
  createdAt: z.string().datetime(),
});
export const maxUpdateSchema = z.object({
  updateId: z.string(),
  type: z.string(),
  message: maxMessagePayloadSchema.optional(),
  raw: z.record(z.any()).optional(),
});
