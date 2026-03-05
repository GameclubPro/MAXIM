import { z } from 'zod';

export const sanctionActionSchema = z.enum(['NONE', 'WARN', 'DELETE_MESSAGE', 'KICK', 'BAN']);
export type SanctionAction = z.infer<typeof sanctionActionSchema>;

export const linkPolicySchema = z.enum(['ALLOWLIST_ONLY', 'BLOCKLIST_ONLY', 'ALERT_ONLY']);
export const commercialAdsSensitivitySchema = z.enum(['BALANCED', 'STRICT']);
export const managedEntityTypeSchema = z.enum(['chat', 'channel']);
export type ManagedEntityType = z.infer<typeof managedEntityTypeSchema>;

const duplicateWindowSecSchema = z.number().int().min(3_600).max(604_800);
const duplicateMaxCountSchema = z.number().int().min(2).max(20);
const botButtonUrlSchema = z.string().trim().max(2_048).default('');
const botButtonTextSchema = z.string().trim().max(32).default('Открыть');
const botMessageTextSchema = z.string().max(1_000).default('');

function isValidBotButtonUrl(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isValidAllowlistLink(value: string): boolean {
  const raw = value.trim();
  if (!raw) {
    return false;
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isValidBotButtonText(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 32;
}

function isValidIanaTimeZone(value: string): boolean {
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
    antiDuplicateEnabled: z.boolean().default(true),
    duplicateWarnWindowSec: duplicateWindowSecSchema.default(43_200),
    duplicateWarnMaxCount: duplicateMaxCountSchema.default(2),
    duplicateKickWindowSec: duplicateWindowSecSchema.default(86_400),
    duplicateKickMaxCount: duplicateMaxCountSchema.default(3),
    duplicateBanWindowSec: duplicateWindowSecSchema.default(172_800),
    duplicateBanMaxCount: duplicateMaxCountSchema.default(4),
    linkPolicy: linkPolicySchema.default('ALLOWLIST_ONLY'),
    greetingEnabled: z.boolean().default(false),
    greetingBotMessageEnabled: z.boolean().default(true),
    greetingBotMessageText: botMessageTextSchema,
    greetingBotButtonEnabled: z.boolean().default(false),
    greetingBotButtonUrl: botButtonUrlSchema,
    greetingBotButtonText: botButtonTextSchema,
    deleteBotMessagesEnabled: z.boolean().default(true),
    deleteBotMessagesDelayMinutes: z.number().int().min(1).max(60).default(2),
    removeBotsFromGroupEnabled: z.boolean().default(false),
    globalUserBlacklistEnabled: z.boolean().default(false),
    globalCrossChatSpamEnabled: z.boolean().default(false),
    antiSpamEnabled: z.boolean().default(true),
    maxMessageLengthEnabled: z.boolean().default(false),
    maxMessageLength: z.number().int().min(50).max(1500).default(1500),
    photoMessageCooldownEnabled: z.boolean().default(false),
    photoMessageCooldownHours: z.number().int().min(1).max(24).default(1),
    stickerMessageCooldownEnabled: z.boolean().default(false),
    stickerMessageCooldownMinutes: z.number().int().min(1).max(60).default(5),
    videoMessagesEnabled: z.boolean().default(true),
    fileMessagesEnabled: z.boolean().default(true),
    voiceMessagesEnabled: z.boolean().default(true),
    messageLimitsBotMessageEnabled: z.boolean().default(false),
    messageLimitsBotMessageText: botMessageTextSchema,
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
    textFiltersBotMessageText: botMessageTextSchema,
    textFiltersWarnEnabled: z.boolean().default(false),
    textFiltersWarnMessageText: botMessageTextSchema,
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
      .max(1_439)
      .default(23 * 60),
    nightModeEndTimeMinutes: z
      .number()
      .int()
      .min(0)
      .max(1_439)
      .default(8 * 60),
    nightModeTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
    nightModeBotMessageEnabled: z.boolean().default(true),
    nightModeBotMessageText: botMessageTextSchema,
    nightModeBotButtonEnabled: z.boolean().default(false),
    nightModeBotButtonUrl: botButtonUrlSchema,
    nightModeBotButtonText: botButtonTextSchema,
    linkBotMessageEnabled: z.boolean().default(true),
    linkBotMessageText: botMessageTextSchema,
    linkWarnEnabled: z.boolean().default(false),
    linkWarnMessageText: botMessageTextSchema,
    linkBanEnabled: z.boolean().default(false),
    linkKickEnabled: z.boolean().default(false),
    linkBotButtonEnabled: z.boolean().default(false),
    linkBotButtonUrl: botButtonUrlSchema,
    linkBotButtonText: botButtonTextSchema,
    duplicateBotMessageEnabled: z.boolean().default(false),
    duplicateBotMessageText: botMessageTextSchema,
    duplicateBotButtonEnabled: z.boolean().default(false),
    duplicateBotButtonUrl: botButtonUrlSchema,
    duplicateBotButtonText: botButtonTextSchema,
    banDurationHours: z.number().int().min(1).max(36).default(6),
    warnThreshold: z.number().int().min(1).max(10).default(3),
  })
  .superRefine((value, ctx) => {
    const warnEnabled = value.antiDuplicateEnabled && value.duplicateWarnEnabled;
    const banEnabled = value.antiDuplicateEnabled && value.duplicateBanEnabled;
    const kickEnabled = value.antiDuplicateEnabled && value.duplicateKickEnabled;

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
      value.greetingEnabled &&
      value.greetingBotMessageEnabled &&
      value.greetingBotButtonEnabled &&
      !isValidBotButtonUrl(value.greetingBotButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['greetingBotButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (
      value.greetingEnabled &&
      value.greetingBotMessageEnabled &&
      value.greetingBotButtonEnabled &&
      !isValidBotButtonText(value.greetingBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['greetingBotButtonText'],
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

    if (value.commercialAdsDeleteThreshold <= value.commercialAdsWarnThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commercialAdsDeleteThreshold'],
        message: 'Порог удаления должен быть выше порога предупреждения.',
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
export type ChatSettings = z.infer<typeof chatSettingsSchema>;

export const channelSettingsSchema = z
  .object({
    postSuggestionsEnabled: z.boolean().default(false),
    postSuggestionsText: botMessageTextSchema,
    postSuggestionsButtonEnabled: z.boolean().default(false),
    postSuggestionsButtonText: z.string().trim().max(32).default('Предложить пост'),
    postSuggestionsButtonUrl: botButtonUrlSchema,
    commentsEnabled: z.boolean().default(true),
    commentsModerationEnabled: z.boolean().default(false),
    commentsSlowModeSeconds: z.number().int().min(0).max(3600).default(0),
    commentsMessageText: botMessageTextSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.postSuggestionsEnabled &&
      value.postSuggestionsButtonEnabled &&
      !isValidBotButtonUrl(value.postSuggestionsButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postSuggestionsButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (
      value.postSuggestionsEnabled &&
      value.postSuggestionsButtonEnabled &&
      !isValidBotButtonText(value.postSuggestionsButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postSuggestionsButtonText'],
        message: 'Введите название кнопки.',
      });
    }
  });
export type ChannelSettings = z.infer<typeof channelSettingsSchema>;

export const moderationEventSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  userId: z.string(),
  eventType: z.enum(['MESSAGE', 'MEMBER_ACTION', 'SYSTEM']),
  ruleCode: z.string(),
  action: sanctionActionSchema,
  maskedExcerpt: z.string().nullable(),
  score: z.number(),
  metadata: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string().datetime(),
  operator: z.enum(['BOT', 'ADMIN']),
});
export type ModerationEvent = z.infer<typeof moderationEventSchema>;

export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
  entityType: managedEntityTypeSchema.default('chat'),
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

export const logsDashboardRangeSchema = z.enum(['24h', '7d', '30d']);
export type LogsDashboardRange = z.infer<typeof logsDashboardRangeSchema>;

export const logsDashboardQuerySchema = z.object({
  range: logsDashboardRangeSchema.default('7d'),
});
export type LogsDashboardQuery = z.infer<typeof logsDashboardQuerySchema>;

export const logsDashboardViolationSchema = z.object({
  id: z.string(),
  action: sanctionActionSchema,
  ruleCode: z.string(),
  userId: z.string(),
  userDisplayName: z.string().nullable(),
  createdAt: z.string().datetime(),
  maskedExcerpt: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type LogsDashboardViolation = z.infer<typeof logsDashboardViolationSchema>;

export const logsDashboardResponseSchema = z.object({
  chat: z.object({
    id: z.string(),
    title: z.string(),
  }),
  period: z.object({
    range: logsDashboardRangeSchema,
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  membership: z.object({
    joinedUsers: z.number().int().min(0),
    leftUsers: z.number().int().min(0),
  }),
  violationsSummary: z.object({
    warn: z.number().int().min(0),
    deleteMessage: z.number().int().min(0),
    kick: z.number().int().min(0),
    ban: z.number().int().min(0),
    total: z.number().int().min(0),
  }),
  violations: z.array(logsDashboardViolationSchema),
});
export type LogsDashboardResponse = z.infer<typeof logsDashboardResponseSchema>;

export const manualModerationActionSchema = z.enum(['KICK', 'BAN', 'UNBAN']);
export type ManualModerationAction = z.infer<typeof manualModerationActionSchema>;

export const manualModerationActionRequestSchema = z
  .object({
    action: manualModerationActionSchema,
    banDurationHours: z.number().int().min(1).max(336).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'BAN' && value.banDurationHours === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['banDurationHours'],
        message: 'Укажите длительность бана в часах.',
      });
    }

    if (value.action !== 'BAN' && value.banDurationHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['banDurationHours'],
        message: 'Длительность бана доступна только для действия BAN.',
      });
    }
  });
export type ManualModerationActionRequest = z.infer<typeof manualModerationActionRequestSchema>;

export const manualModerationActionResultSchema = z.object({
  ok: z.literal(true),
  action: manualModerationActionSchema,
  userId: z.string(),
  banDurationHours: z.number().int().min(1).max(336).nullable(),
  unbanScheduledAt: z.string().datetime().nullable(),
  message: z.string().min(1),
});
export type ManualModerationActionResult = z.infer<typeof manualModerationActionResultSchema>;

export const updateSettingsRequestSchema = chatSettingsSchema;

export const addAdminRequestSchema = z.object({
  userId: z.string(),
});

export const addDomainRequestSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(3)
    .max(2_048)
    .refine((value) => isValidAllowlistLink(value), {
      message: 'Укажите корректную ссылку (http/https).',
    }),
});

export const domainAllowlistEntrySchema = z.object({
  domain: z.string().trim().min(3).max(2_048),
  removeAfterAt: z.string().datetime().nullable(),
});
export type DomainAllowlistEntry = z.infer<typeof domainAllowlistEntrySchema>;

export const scheduleDomainRemovalRequestSchema = z.object({
  removeAfterAt: z.string().datetime().nullable(),
});

export const globalUserBlacklistEntrySchema = z.object({
  userId: z.string().trim().min(1),
  createdAt: z.string().datetime(),
});
export type GlobalUserBlacklistEntry = z.infer<typeof globalUserBlacklistEntrySchema>;

export const addGlobalUserBlacklistRequestSchema = z.object({
  userId: z.string().trim().min(1),
});

export const sendBroadcastRequestSchema = z
  .object({
    text: z.string().trim().max(1_000).default(''),
    applyToAllChats: z.boolean().default(false),
    buttonEnabled: z.boolean().default(false),
    buttonUrl: botButtonUrlSchema,
    buttonText: botButtonTextSchema,
    imageEnabled: z.boolean().default(false),
    imageBase64: z.string().trim().max(1_500_000).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
    sendAt: z.string().datetime().nullable().default(null),
    cycleEnabled: z.boolean().default(false),
    cycleEveryDays: z.number().int().min(1).max(14).default(1),
    cycleCount: z.number().int().min(1).max(14).default(1),
  })
  .superRefine((value, ctx) => {
    if (value.text.length === 0 && !value.imageEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Введите текст или добавьте фото.',
      });
    }

    if (value.buttonEnabled && !isValidBotButtonUrl(value.buttonUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buttonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (value.buttonEnabled && !isValidBotButtonText(value.buttonText)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buttonText'],
        message: 'Введите название кнопки.',
      });
    }

    if (value.imageEnabled) {
      if (!value.imageBase64.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['imageBase64'],
          message: 'Добавьте фото для рассылки.',
        });
      }

      if (!value.imageMimeType.trim() || !value.imageMimeType.toLowerCase().startsWith('image/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['imageMimeType'],
          message: 'Неверный формат фото.',
        });
      }
    }

    if (value.cycleEnabled && value.cycleCount < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cycleCount'],
        message: 'Для цикла укажите минимум 2 отправки.',
      });
    }
  });
export type SendBroadcastRequest = z.infer<typeof sendBroadcastRequestSchema>;

export const sendBroadcastResultSchema = z.object({
  sourceChatId: z.string(),
  targetChats: z.number().int().min(1),
  sentChats: z.number().int().min(0),
  failedChats: z.number().int().min(0),
  sentChatIds: z.array(z.string()),
  failedChatIds: z.array(z.string()),
  sendAt: z.string().datetime().nullable(),
  cycleEnabled: z.boolean(),
  cycleEveryDays: z.number().int().min(1),
  cycleCount: z.number().int().min(1),
});
export type SendBroadcastResult = z.infer<typeof sendBroadcastResultSchema>;

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

export type MaxUpdate = z.infer<typeof maxUpdateSchema>;
