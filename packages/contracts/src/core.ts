import { z } from 'zod';
export * from './bot-speech.js';
export * from './broadcast-common.js';
export * from './channel-stats.js';
export * from './channel-dialog.js';
export * from './giveaway.js';
export * from './managed-entities.js';
export { logsDashboardRangeSchema, type LogsDashboardRange } from './dashboard-common.js';
export * from './membership-activity.js';
import { botSpeechStyleSchema } from './bot-speech.js';
import { broadcastTextFormatSchema } from './broadcast-common.js';
import { booleanQueryFlagSchema, logsDashboardRangeSchema } from './dashboard-common.js';
import {
  addBroadcastAudienceIssues,
  addBroadcastScheduleIssues,
  buildBroadcastAudienceState,
  buildBroadcastScheduleState,
} from './broadcast-request-utils.js';
import { membershipActivityPageSchema } from './membership-activity.js';
import {
  chatSummarySchema,
  managedEntityFavoriteTypeSchema,
  managedEntityHeaderSchema,
  managedEntityTypeSchema,
} from './managed-entities.js';
import {
  DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES,
  DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES,
  DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES,
  allowlistMatchTypeSchema,
  isValidDeleteBotMessagesDelayMinutes,
  normalizeAllowlistDomain,
  normalizeAllowlistLink,
} from './settings-utils.js';
export * from './settings-utils.js';
export * from './system-core.js';

export const sanctionActionSchema = z.enum([
  'NONE',
  'WARN',
  'DELETE_MESSAGE',
  'MUTE',
  'KICK',
  'BAN',
]);
export type SanctionAction = z.infer<typeof sanctionActionSchema>;

export const linkPolicySchema = z.enum(['ALLOWLIST_ONLY', 'BLOCKLIST_ONLY', 'ALERT_ONLY']);
export const duplicateDetectionPresetSchema = z.enum(['STANDARD', 'STRICT', 'CUSTOM']);
export const commercialAdsSensitivitySchema = z.enum(['BALANCED', 'STRICT']);
export const applySettingsSectionSchema = z.enum([
  'links',
  'greeting',
  'profanityFilter',
  'commercialFilter',
  'thematicFilters',
  'duplicates',
  'limits',
  'stopWords',
  'phones',
  'night',
  'requiredSubscription',
  'invitationAccess',
  'extra',
]);
export const channelAutoPostButtonsModeSchema = z.enum(['OFF', 'COMMENTS', 'SUGGEST', 'BOTH']);
export const channelSuggestionEntryModeSchema = z.enum(['BOT', 'MINIAPP']);
export const managedPollStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'CLOSED']);
export const broadcastTargetModeSchema = z.enum(['current', 'selected', 'all']);
export const broadcastMediaTypeSchema = z.enum(['image', 'video']);
export type ApplySettingsSection = z.infer<typeof applySettingsSectionSchema>;
export type ChannelAutoPostButtonsMode = z.infer<typeof channelAutoPostButtonsModeSchema>;
export type ChannelSuggestionEntryMode = z.infer<typeof channelSuggestionEntryModeSchema>;
export type ManagedPollStatus = z.infer<typeof managedPollStatusSchema>;
export type BroadcastTargetMode = z.infer<typeof broadcastTargetModeSchema>;
export type BroadcastMediaType = z.infer<typeof broadcastMediaTypeSchema>;

export const MANAGED_POLL_MIN_OPTIONS = 2;
export const MANAGED_POLL_MAX_OPTIONS = 6;
export const MANAGED_POLL_QUESTION_MAX_LENGTH = 280;
export const MANAGED_POLL_OPTION_MAX_LENGTH = 80;
export const REQUIRED_SUBSCRIPTION_MAX_CHANNELS = 10;
export const REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN = 1;
export const REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX = 14;
export const REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT = 7;
export const INVITATION_ACCESS_REQUIRED_COUNT_MIN = 1;
export const INVITATION_ACCESS_REQUIRED_COUNT_MAX = 10;
export const MESSAGE_LIMITS_BLOCKED_WORDS_MAX = 999;
export const MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX = 300;
export const DEFAULT_BROADCAST_BUTTON_TEXT = 'Открыть';
export const MAX_BROADCAST_LINK_BUTTONS = 8;
export const MAX_BROADCAST_LINK_BUTTONS_PER_ROW = 3;
export const MAX_BROADCAST_IMAGES = 10;
export const MAX_BROADCAST_IMAGE_BASE64_LENGTH = 8_000_000;
export const MAX_BROADCAST_IMAGES_TOTAL_BASE64 = 24_000_000;
export const VK_PARSING_MAX_PHOTOS = 10;
export const VK_PARSING_MAX_LINKS = 20;
export const VK_PARSING_MAX_PUBLISH_TEXT_LENGTH = 4_000;
const duplicateWindowSecSchema = z.number().int().min(3_600).max(604_800);
const duplicateMaxCountSchema = z.number().int().min(1).max(20);
const escalationWindowHoursSchema = z.number().int().min(1).max(168);
const escalationMaxCountSchema = z.number().int().min(1).max(20);
const autoMuteDurationHoursSchema = z.number().int().min(1).max(168).default(6);
const requiredSubscriptionMuteDurationHoursSchema = z.number().int().min(1).max(336).default(6);
const requiredSubscriptionDurationDaysSchema = z
  .number()
  .int()
  .min(REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN)
  .max(REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX)
  .default(REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT);
const requiredSubscriptionExpiresAtSchema = z.string().trim().max(64).default('');
const invitationAccessRequiredCountSchema = z
  .number()
  .int()
  .min(INVITATION_ACCESS_REQUIRED_COUNT_MIN)
  .max(INVITATION_ACCESS_REQUIRED_COUNT_MAX)
  .default(INVITATION_ACCESS_REQUIRED_COUNT_MIN);
const deleteBotMessagesDelayMinutesSchema = z
  .number()
  .min(DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES)
  .max(DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES)
  .refine(isValidDeleteBotMessagesDelayMinutes, {
    message: 'Допустимо 30 сек или целое число минут от 1 до 60.',
  })
  .default(DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES);
const botButtonUrlSchema = z.string().trim().max(2_048).default('');
const botButtonTextSchema = z.string().trim().max(32).default(DEFAULT_BROADCAST_BUTTON_TEXT);
const botMessageTextSchema = z.string().max(1_000).default('');
const thematicCodewordSchema = z.string().trim().max(32).default('');
export const broadcastLinkButtonSchema = z
  .object({
    text: botButtonTextSchema,
    url: botButtonUrlSchema,
  })
  .superRefine((value, ctx) => {
    if (!isValidBotButtonUrl(value.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (!isValidBotButtonText(value.text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Введите название кнопки.',
      });
    }
  });
export type BroadcastLinkButton = z.infer<typeof broadcastLinkButtonSchema>;
export const broadcastImageSchema = z
  .object({
    base64: z.string().trim().max(MAX_BROADCAST_IMAGE_BASE64_LENGTH).default(''),
    mimeType: z.string().trim().max(128).default(''),
    fileName: z.string().trim().max(128).default(''),
  })
  .superRefine((value, ctx) => {
    if (!value.base64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['base64'],
        message: 'Добавьте фото.',
      });
    }

    if (!value.mimeType.trim() || !value.mimeType.toLowerCase().startsWith('image/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mimeType'],
        message: 'Неверный формат фото.',
      });
    }
  });
export type BroadcastImage = z.infer<typeof broadcastImageSchema>;

function isRecordPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBroadcastImagePayload(value: unknown): BroadcastImage | null {
  if (!isRecordPayload(value)) {
    return null;
  }

  const base64 = typeof value.base64 === 'string' ? value.base64.trim() : '';
  if (!base64) {
    return null;
  }

  return {
    base64,
    mimeType: typeof value.mimeType === 'string' ? value.mimeType.trim() : '',
    fileName: typeof value.fileName === 'string' ? value.fileName.trim() : '',
  };
}

function readBroadcastMediaPayloadImages(value: unknown): BroadcastImage[] {
  if (!isRecordPayload(value) || !Array.isArray(value.images)) {
    return [];
  }

  return value.images
    .map((item) => readBroadcastImagePayload(item))
    .filter((image): image is BroadcastImage => image !== null)
    .slice(0, MAX_BROADCAST_IMAGES);
}

function normalizeBroadcastImages(value: {
  images?: BroadcastImage[];
  imageBase64?: string;
  imageMimeType?: string;
  imageFileName?: string;
  mediaType?: BroadcastMediaType | null;
  mediaPayload?: Record<string, unknown> | null;
}): BroadcastImage[] {
  const explicitImages = Array.isArray(value.images)
    ? value.images.filter((image) => image.base64.trim().length > 0)
    : [];
  if (explicitImages.length > 0) {
    return explicitImages.slice(0, MAX_BROADCAST_IMAGES);
  }

  const payloadImages =
    value.mediaType === 'image' ? readBroadcastMediaPayloadImages(value.mediaPayload) : [];
  if (payloadImages.length > 0) {
    return payloadImages;
  }

  const imageBase64 = value.imageBase64?.trim() ?? '';
  if (!imageBase64) {
    return [];
  }

  return [
    {
      base64: imageBase64,
      mimeType: value.imageMimeType?.trim() ?? '',
      fileName: value.imageFileName?.trim() ?? '',
    },
  ];
}

function getBroadcastImagesTotalBase64Length(images: BroadcastImage[]): number {
  return images.reduce((total, image) => total + image.base64.trim().length, 0);
}

const storedLinkButtonDraftSchema = z.object({
  text: botButtonTextSchema,
  url: botButtonUrlSchema,
});

function normalizeStoredLinkButtons(values: BroadcastLinkButton[]): BroadcastLinkButton[] {
  return values.map((value) => ({
    text: value.text.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
    url: value.url.trim(),
  }));
}

function resolveStoredLinkButtons(value: {
  buttons?: BroadcastLinkButton[];
  buttonUrl?: string;
  buttonText?: string;
}): BroadcastLinkButton[] {
  if (Array.isArray(value.buttons) && value.buttons.length > 0) {
    return normalizeStoredLinkButtons(value.buttons);
  }

  const legacyUrl = value.buttonUrl?.trim() ?? '';
  if (!legacyUrl) {
    return [];
  }

  return normalizeStoredLinkButtons([
    {
      text: value.buttonText ?? DEFAULT_BROADCAST_BUTTON_TEXT,
      url: legacyUrl,
    },
  ]);
}

function buildStoredLinkButtonState(value: {
  buttons?: BroadcastLinkButton[];
  buttonEnabled?: boolean;
  buttonUrl?: string;
  buttonText?: string;
}): {
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
} {
  const buttons = resolveStoredLinkButtons(value);
  const primaryButton = buttons[0];

  return {
    buttons,
    buttonEnabled: value.buttonEnabled === true,
    buttonUrl: primaryButton?.url ?? value.buttonUrl?.trim() ?? '',
    buttonText: primaryButton?.text ?? (value.buttonText?.trim() || DEFAULT_BROADCAST_BUTTON_TEXT),
  };
}

function addStoredLinkButtonIssues(
  buttons: BroadcastLinkButton[],
  ctx: z.RefinementCtx,
  path: [string],
): void {
  buttons.forEach((button, index) => {
    if (!isValidBotButtonUrl(button.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, 'url'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (!isValidBotButtonText(button.text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, 'text'],
        message: 'Введите название кнопки.',
      });
    }
  });
}

function addStoredBotButtonGroupIssues(
  value: {
    enabled: boolean;
    buttons: BroadcastLinkButton[];
    buttonsPath: string;
    buttonUrl: string;
    buttonText: string;
    buttonUrlPath: string;
    buttonTextPath: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (!value.enabled) {
    return;
  }

  if (value.buttons.length > 0) {
    addStoredLinkButtonIssues(value.buttons, ctx, [value.buttonsPath]);
    return;
  }

  if (!isValidBotButtonUrl(value.buttonUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.buttonUrlPath],
      message: 'Укажите корректную ссылку для кнопки (http/https).',
    });
  }

  if (!isValidBotButtonText(value.buttonText)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.buttonTextPath],
      message: 'Введите название кнопки.',
    });
  }
}
const messageLimitsBlockedWordSchema = z.string().trim().max(32);
const messageLimitsBlockedWordsSchema = z
  .array(messageLimitsBlockedWordSchema)
  .max(MESSAGE_LIMITS_BLOCKED_WORDS_MAX, `До ${MESSAGE_LIMITS_BLOCKED_WORDS_MAX} слов.`)
  .default([]);
const messageLimitsBlockedDomainSchema = z.string().trim().max(253);
const messageLimitsBlockedDomainsSchema = z
  .array(messageLimitsBlockedDomainSchema)
  .max(MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX, `До ${MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX} доменов.`)
  .default([]);
const nightModeForceCloseUntilSchema = z.string().trim().max(64).default('');
const requiredSubscriptionChannelIdsSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(REQUIRED_SUBSCRIPTION_MAX_CHANNELS)
  .default([]);
const chatRulesTextSchema = z.string().max(2_000).default('');
const chatRulesImageBase64Schema = z
  .string()
  .trim()
  .max(MAX_BROADCAST_IMAGE_BASE64_LENGTH)
  .default('');
const chatRulesImageMimeTypeSchema = z.string().trim().max(128).default('');
const chatRulesImageFileNameSchema = z.string().trim().max(128).default('');
const managedPollQuestionSchema = z.string().max(MANAGED_POLL_QUESTION_MAX_LENGTH).default('');
const managedPollOptionDraftSchema = z.string().max(MANAGED_POLL_OPTION_MAX_LENGTH).default('');
const managedPollOptionsDraftSchema = z
  .array(managedPollOptionDraftSchema)
  .min(MANAGED_POLL_MIN_OPTIONS)
  .max(MANAGED_POLL_MAX_OPTIONS)
  .default(['', '']);

function normalizeThematicCodewordCandidate(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/ё/g, 'е');
  if (!normalized) {
    return null;
  }

  const parts = normalized.split(/\s+/u).filter(Boolean);
  if (parts.length !== 1) {
    return null;
  }

  const fragments = parts[0].match(/[\p{L}\p{N}]+/gu);
  if (!fragments || fragments.length === 0) {
    return null;
  }

  return fragments.join('');
}

export function normalizeMessageLimitsBlockedWordCandidate(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/ё/g, 'е');
  if (!normalized) {
    return null;
  }

  const parts = normalized.split(/\s+/u).filter(Boolean);
  if (parts.length !== 1) {
    return null;
  }

  const fragments = parts[0].match(/[\p{L}\p{N}]+/gu);
  if (!fragments || fragments.length !== 1) {
    return null;
  }

  const [candidate] = fragments;
  return candidate.length >= 2 && candidate.length <= 32 ? candidate : null;
}

export function normalizeMessageLimitsBlockedDomainCandidate(value: string): string | null {
  const normalizedDomain = normalizeAllowlistDomain(value);
  if (!normalizedDomain) {
    return null;
  }

  const candidate = normalizedDomain
    .trim()
    .toLowerCase()
    .replace(/\.$/u, '')
    .replace(/^www\./u, '');
  if (candidate.length < 4 || candidate.length > 253 || !candidate.includes('.')) {
    return null;
  }

  const labels = candidate.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63)) {
    return null;
  }

  return candidate;
}

function parseHttpButtonUrl(value: string): URL | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function isValidAdminContactButtonUrl(value: string): boolean {
  return parseHttpButtonUrl(value) !== null;
}

function isValidBotButtonUrl(value: string): boolean {
  const parsed = parseHttpButtonUrl(value);
  if (!parsed) {
    return false;
  }

  return !(parsed.searchParams.get('start')?.trim() ?? '').startsWith('pmh-');
}

const CHAT_ADMIN_CONTACT_BUTTON_GROUPS = [
  ['requiredSubscriptionAdminContactButtonEnabled', 'requiredSubscriptionAdminContactButtonUrl'],
  ['invitationAccessAdminContactButtonEnabled', 'invitationAccessAdminContactButtonUrl'],
  ['messageLimitsAdminContactButtonEnabled', 'messageLimitsAdminContactButtonUrl'],
  ['phoneNumbersAdminContactButtonEnabled', 'phoneNumbersAdminContactButtonUrl'],
  ['profanityAdminContactButtonEnabled', 'profanityAdminContactButtonUrl'],
  ['textFiltersAdminContactButtonEnabled', 'textFiltersAdminContactButtonUrl'],
  ['thematicFiltersAdminContactButtonEnabled', 'thematicFiltersAdminContactButtonUrl'],
  ['linkAdminContactButtonEnabled', 'linkAdminContactButtonUrl'],
  ['duplicateAdminContactButtonEnabled', 'duplicateAdminContactButtonUrl'],
] as const;

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

const AUTO_MUTE_DURATION_FIELD_KEYS = [
  'duplicateMuteDurationHours',
  'linkMuteDurationHours',
  'messageLimitsMuteDurationHours',
  'phoneNumbersMuteDurationHours',
  'profanityMuteDurationHours',
  'requiredSubscriptionMuteDurationHours',
  'invitationAccessMuteDurationHours',
  'textFiltersMuteDurationHours',
  'thematicFiltersMuteDurationHours',
] as const;

export const chatSettingsSchema = z
  .preprocess(
    (input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return input;
      }

      const value = input as Record<string, unknown>;
      const legacyMuteDurationHours =
        typeof value.muteDurationHours === 'number' && Number.isFinite(value.muteDurationHours)
          ? value.muteDurationHours
          : null;

      if (legacyMuteDurationHours === null) {
        return value;
      }

      const nextValue = { ...value };
      for (const key of AUTO_MUTE_DURATION_FIELD_KEYS) {
        if (nextValue[key] === undefined) {
          nextValue[key] = legacyMuteDurationHours;
        }
      }

      return nextValue;
    },
    z.object({
      duplicateWarnEnabled: z.boolean().default(true),
      duplicateMuteEnabled: z.boolean().default(true),
      duplicateBanEnabled: z.boolean().default(true),
      antiDuplicateEnabled: z.boolean().default(true),
      duplicateDetectionPreset: duplicateDetectionPresetSchema.default('STRICT'),
      duplicateIgnoreLinksEnabled: z.boolean().default(false),
      duplicateIgnorePhonesEnabled: z.boolean().default(false),
      duplicateNearMatchEnabled: z.boolean().default(false),
      duplicateWarnWindowSec: duplicateWindowSecSchema.default(43_200),
      duplicateWarnMaxCount: duplicateMaxCountSchema.default(2),
      duplicateMuteWindowSec: duplicateWindowSecSchema.default(86_400),
      duplicateMuteMaxCount: duplicateMaxCountSchema.default(3),
      duplicateMuteDurationHours: autoMuteDurationHoursSchema,
      duplicateBanWindowSec: duplicateWindowSecSchema.default(172_800),
      duplicateBanMaxCount: duplicateMaxCountSchema.default(4),
      linkPolicy: linkPolicySchema.default('ALLOWLIST_ONLY'),
      linkEscalationWindowHours: escalationWindowHoursSchema.default(24),
      linkWarnMaxCount: escalationMaxCountSchema.default(2),
      linkMuteMaxCount: escalationMaxCountSchema.default(3),
      linkBanMaxCount: escalationMaxCountSchema.default(4),
      botSpeechStyle: botSpeechStyleSchema.nullable().default('FRIENDLY'),
      greetingEnabled: z.boolean().default(false),
      greetingBotMessageEnabled: z.boolean().default(false),
      greetingDeleteBotMessageEnabled: z.boolean().default(false),
      greetingDeleteBotMessageDelayMinutes: deleteBotMessagesDelayMinutesSchema,
      greetingBotMessageText: botMessageTextSchema,
      greetingBotButtonEnabled: z.boolean().default(false),
      greetingBotButtonUrl: botButtonUrlSchema,
      greetingBotButtonText: botButtonTextSchema,
      greetingBotButtons: z
        .array(storedLinkButtonDraftSchema)
        .max(MAX_BROADCAST_LINK_BUTTONS)
        .default([]),
      greetingRulesButtonEnabled: z.boolean().default(false),
      requiredSubscriptionEnabled: z.boolean().default(false),
      requiredSubscriptionChannelIds: requiredSubscriptionChannelIdsSchema,
      requiredSubscriptionDurationDays: requiredSubscriptionDurationDaysSchema,
      requiredSubscriptionExpiresAt: requiredSubscriptionExpiresAtSchema,
      requiredSubscriptionBotMessageEnabled: z.boolean().default(true),
      requiredSubscriptionBotMessageText: botMessageTextSchema,
      requiredSubscriptionAdminContactButtonEnabled: z.boolean().default(false),
      requiredSubscriptionAdminContactButtonUrl: botButtonUrlSchema,
      requiredSubscriptionWarnEnabled: z.boolean().default(false),
      requiredSubscriptionWarnMessageText: botMessageTextSchema,
      requiredSubscriptionBanEnabled: z.boolean().default(false),
      requiredSubscriptionMuteEnabled: z.boolean().default(false),
      requiredSubscriptionMuteDurationHours: requiredSubscriptionMuteDurationHoursSchema,
      invitationAccessEnabled: z.boolean().default(false),
      invitationAccessRequiredCount: invitationAccessRequiredCountSchema,
      invitationAccessBotMessageEnabled: z.boolean().default(true),
      invitationAccessBotMessageText: botMessageTextSchema,
      invitationAccessAdminContactButtonEnabled: z.boolean().default(false),
      invitationAccessAdminContactButtonUrl: botButtonUrlSchema,
      invitationAccessWarnEnabled: z.boolean().default(false),
      invitationAccessWarnMessageText: botMessageTextSchema,
      invitationAccessBanEnabled: z.boolean().default(false),
      invitationAccessMuteEnabled: z.boolean().default(false),
      invitationAccessMuteDurationHours: autoMuteDurationHoursSchema,
      commentsEnabled: z.boolean().default(false),
      commentsAdminsEnabled: z.boolean().default(true),
      commentsAllEnabled: z.boolean().default(false),
      commentsChatBroadcastsEnabled: z.boolean().default(false),
      deleteBotMessagesEnabled: z.boolean().default(true),
      deleteBotMessagesDelayMinutes: deleteBotMessagesDelayMinutesSchema,
      removeBotsFromGroupEnabled: z.boolean().default(true),
      deleteSpammersEnabled: z.boolean().default(false),
      antiSpamEnabled: z.boolean().default(true),
      messageCountLimitEnabled: z.boolean().default(false),
      messageCountLimitMessages: z.number().int().min(1).max(10).default(5),
      messageCountLimitWindowHours: z.number().int().min(1).max(24).default(1),
      maxMessageLengthEnabled: z.boolean().default(false),
      maxMessageLength: z.number().int().min(50).max(1500).default(1500),
      photoMessageCooldownEnabled: z.boolean().default(false),
      photoMessageCooldownHours: z.number().int().min(1).max(24).default(1),
      stickerMessageCooldownEnabled: z.boolean().default(false),
      stickerMessageCooldownMinutes: z.number().int().min(1).max(60).default(5),
      photoMessagesEnabled: z.boolean().default(true),
      videoMessagesEnabled: z.boolean().default(true),
      fileMessagesEnabled: z.boolean().default(true),
      voiceMessagesEnabled: z.boolean().default(true),
      phoneNumbersEnabled: z.boolean().default(true),
      phoneNumbersBotMessageEnabled: z.boolean().default(false),
      phoneNumbersBotMessageText: botMessageTextSchema,
      phoneNumbersWarnEnabled: z.boolean().default(false),
      phoneNumbersMuteEnabled: z.boolean().default(false),
      phoneNumbersMuteDurationHours: autoMuteDurationHoursSchema,
      phoneNumbersBanEnabled: z.boolean().default(false),
      phoneNumbersEscalationWindowHours: escalationWindowHoursSchema.default(12),
      phoneNumbersWarnMaxCount: escalationMaxCountSchema.default(2),
      phoneNumbersMuteMaxCount: escalationMaxCountSchema.default(3),
      phoneNumbersBanMaxCount: escalationMaxCountSchema.default(4),
      phoneNumbersAdminContactButtonEnabled: z.boolean().default(false),
      phoneNumbersAdminContactButtonUrl: botButtonUrlSchema,
      messageLimitsBlockedWords: messageLimitsBlockedWordsSchema,
      messageLimitsBlockedDomains: messageLimitsBlockedDomainsSchema,
      messageLimitsBotMessageEnabled: z.boolean().default(false),
      messageLimitsBotMessageText: botMessageTextSchema,
      messageLimitsWarnEnabled: z.boolean().default(false),
      messageLimitsBanEnabled: z.boolean().default(false),
      messageLimitsMuteEnabled: z.boolean().default(false),
      messageLimitsMuteDurationHours: autoMuteDurationHoursSchema,
      messageLimitsAdminContactButtonEnabled: z.boolean().default(false),
      messageLimitsAdminContactButtonUrl: botButtonUrlSchema,
      messageLimitsBotButtonEnabled: z.boolean().default(false),
      messageLimitsBotButtonUrl: botButtonUrlSchema,
      messageLimitsBotButtonText: botButtonTextSchema,
      messageLimitsBotButtons: z
        .array(storedLinkButtonDraftSchema)
        .max(MAX_BROADCAST_LINK_BUTTONS)
        .default([]),
      russianProfanityFilterEnabled: z.boolean().default(true),
      commercialAdsFilterEnabled: z.boolean().default(false),
      commercialAdsSensitivity: commercialAdsSensitivitySchema.default('BALANCED'),
      commercialAdsWarnThreshold: z.number().int().min(10).max(90).default(45),
      commercialAdsDeleteThreshold: z.number().int().min(20).max(100).default(65),
      profanityBotMessageEnabled: z.boolean().default(false),
      profanityWarnEnabled: z.boolean().default(false),
      profanityBanEnabled: z.boolean().default(false),
      profanityMuteEnabled: z.boolean().default(false),
      profanityMuteDurationHours: autoMuteDurationHoursSchema,
      profanityAdminContactButtonEnabled: z.boolean().default(false),
      profanityAdminContactButtonUrl: botButtonUrlSchema,
      textFiltersBotMessageEnabled: z.boolean().default(false),
      textFiltersBotMessageText: botMessageTextSchema,
      textFiltersWarnEnabled: z.boolean().default(false),
      textFiltersWarnMessageText: botMessageTextSchema,
      textFiltersBanEnabled: z.boolean().default(false),
      textFiltersMuteEnabled: z.boolean().default(false),
      textFiltersMuteDurationHours: autoMuteDurationHoursSchema,
      textFiltersAdminContactButtonEnabled: z.boolean().default(false),
      textFiltersAdminContactButtonUrl: botButtonUrlSchema,
      textFiltersBotButtonEnabled: z.boolean().default(false),
      textFiltersBotButtonUrl: botButtonUrlSchema,
      textFiltersBotButtonText: botButtonTextSchema,
      textFiltersBotButtons: z
        .array(storedLinkButtonDraftSchema)
        .max(MAX_BROADCAST_LINK_BUTTONS)
        .default([]),
      textFiltersRulesButtonEnabled: z.boolean().default(false),
      thematicCodewordEnabled: z.boolean().default(false),
      thematicCodeword: thematicCodewordSchema,
      thematicFiltersBotMessageEnabled: z.boolean().default(false),
      thematicFiltersWarnEnabled: z.boolean().default(false),
      thematicFiltersBanEnabled: z.boolean().default(false),
      thematicFiltersMuteEnabled: z.boolean().default(false),
      thematicFiltersMuteDurationHours: autoMuteDurationHoursSchema,
      thematicFiltersAdminContactButtonEnabled: z.boolean().default(false),
      thematicFiltersAdminContactButtonUrl: botButtonUrlSchema,
      thematicFiltersBotButtonEnabled: z.boolean().default(false),
      thematicFiltersBotButtonUrl: botButtonUrlSchema,
      thematicFiltersBotButtonText: botButtonTextSchema,
      thematicFiltersBotButtons: z
        .array(storedLinkButtonDraftSchema)
        .max(MAX_BROADCAST_LINK_BUTTONS)
        .default([]),
      thematicFiltersRulesButtonEnabled: z.boolean().default(false),
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
      nightModeBotMessageEnabled: z.boolean().default(false),
      nightModeBotMessageText: botMessageTextSchema,
      nightModeCommentsEnabled: z.boolean().default(false),
      nightModeOpenMessageEnabled: z.boolean().default(true),
      nightModeOpenMessageText: botMessageTextSchema,
      nightModeBotButtonEnabled: z.boolean().default(false),
      nightModeBotButtonUrl: botButtonUrlSchema,
      nightModeBotButtonText: botButtonTextSchema,
      nightModeBotButtons: z
        .array(storedLinkButtonDraftSchema)
        .max(MAX_BROADCAST_LINK_BUTTONS)
        .default([]),
      nightModeRulesButtonEnabled: z.boolean().default(false),
      nightModeForceCloseEnabled: z.boolean().default(false),
      nightModeForceCloseForever: z.boolean().default(false),
      nightModeForceCloseHours: z.number().int().min(0).max(23).default(8),
      nightModeForceCloseDays: z.number().int().min(0).max(30).default(0),
      nightModeForceCloseUntil: nightModeForceCloseUntilSchema,
      linkBotMessageEnabled: z.boolean().default(true),
      linkBotMessageText: botMessageTextSchema,
      linkWarnEnabled: z.boolean().default(false),
      linkWarnMessageText: botMessageTextSchema,
      linkBanEnabled: z.boolean().default(false),
      linkMuteEnabled: z.boolean().default(false),
      linkMuteDurationHours: autoMuteDurationHoursSchema,
      linkAdminContactButtonEnabled: z.boolean().default(false),
      linkAdminContactButtonUrl: botButtonUrlSchema,
      linkBotButtonEnabled: z.boolean().default(false),
      linkBotButtonUrl: botButtonUrlSchema,
      linkBotButtonText: botButtonTextSchema,
      linkBotButtons: z
        .array(storedLinkButtonDraftSchema)
        .max(MAX_BROADCAST_LINK_BUTTONS)
        .default([]),
      linkRulesButtonEnabled: z.boolean().default(false),
      duplicateBotMessageEnabled: z.boolean().default(false),
      duplicateBotMessageText: botMessageTextSchema,
      duplicateAdminContactButtonEnabled: z.boolean().default(false),
      duplicateAdminContactButtonUrl: botButtonUrlSchema,
      duplicateBotButtonEnabled: z.boolean().default(false),
      duplicateBotButtonUrl: botButtonUrlSchema,
      duplicateBotButtonText: botButtonTextSchema,
      duplicateBotButtons: z
        .array(storedLinkButtonDraftSchema)
        .max(MAX_BROADCAST_LINK_BUTTONS)
        .default([]),
      duplicateRulesButtonEnabled: z.boolean().default(false),
      messageLimitsRulesButtonEnabled: z.boolean().default(false),
      rulesAttachViolationsEnabled: z.boolean().default(true),
      muteDurationHours: autoMuteDurationHoursSchema,
      warnThreshold: z.number().int().min(1).max(10).default(3),
    }),
  )
  .superRefine((value, ctx) => {
    const linkBotButtons = resolveStoredLinkButtons({
      buttons: value.linkBotButtons,
      buttonUrl: value.linkBotButtonUrl,
      buttonText: value.linkBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.linkBotMessageEnabled && value.linkBotButtonEnabled,
        buttons: linkBotButtons,
        buttonsPath: 'linkBotButtons',
        buttonUrl: value.linkBotButtonUrl,
        buttonText: value.linkBotButtonText,
        buttonUrlPath: 'linkBotButtonUrl',
        buttonTextPath: 'linkBotButtonText',
      },
      ctx,
    );

    const greetingBotButtons = resolveStoredLinkButtons({
      buttons: value.greetingBotButtons,
      buttonUrl: value.greetingBotButtonUrl,
      buttonText: value.greetingBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled:
          value.greetingEnabled &&
          value.greetingBotMessageEnabled &&
          value.greetingBotButtonEnabled,
        buttons: greetingBotButtons,
        buttonsPath: 'greetingBotButtons',
        buttonUrl: value.greetingBotButtonUrl,
        buttonText: value.greetingBotButtonText,
        buttonUrlPath: 'greetingBotButtonUrl',
        buttonTextPath: 'greetingBotButtonText',
      },
      ctx,
    );

    if (value.requiredSubscriptionEnabled && value.requiredSubscriptionChannelIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredSubscriptionChannelIds'],
        message: 'Выберите хотя бы один чат или канал для обязательной подписки.',
      });
    }

    for (const [enabledKey, urlKey] of CHAT_ADMIN_CONTACT_BUTTON_GROUPS) {
      if (value[enabledKey] && !isValidAdminContactButtonUrl(value[urlKey])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [urlKey],
          message: 'Не удалось сохранить ссылку на администратора.',
        });
      }
    }

    const duplicateBotButtons = resolveStoredLinkButtons({
      buttons: value.duplicateBotButtons,
      buttonUrl: value.duplicateBotButtonUrl,
      buttonText: value.duplicateBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.duplicateBotMessageEnabled && value.duplicateBotButtonEnabled,
        buttons: duplicateBotButtons,
        buttonsPath: 'duplicateBotButtons',
        buttonUrl: value.duplicateBotButtonUrl,
        buttonText: value.duplicateBotButtonText,
        buttonUrlPath: 'duplicateBotButtonUrl',
        buttonTextPath: 'duplicateBotButtonText',
      },
      ctx,
    );

    const messageLimitsBotButtons = resolveStoredLinkButtons({
      buttons: value.messageLimitsBotButtons,
      buttonUrl: value.messageLimitsBotButtonUrl,
      buttonText: value.messageLimitsBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.messageLimitsBotMessageEnabled && value.messageLimitsBotButtonEnabled,
        buttons: messageLimitsBotButtons,
        buttonsPath: 'messageLimitsBotButtons',
        buttonUrl: value.messageLimitsBotButtonUrl,
        buttonText: value.messageLimitsBotButtonText,
        buttonUrlPath: 'messageLimitsBotButtonUrl',
        buttonTextPath: 'messageLimitsBotButtonText',
      },
      ctx,
    );

    const normalizedMessageLimitsBlockedWords = new Set<string>();
    for (const rawWord of value.messageLimitsBlockedWords) {
      const normalizedWord = normalizeMessageLimitsBlockedWordCandidate(rawWord);
      if (!normalizedWord || normalizedWord.length < 2 || normalizedWord.length > 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messageLimitsBlockedWords'],
          message: 'Нужно одно слово без пробелов, от 2 до 32 символов.',
        });
        break;
      }

      if (normalizedMessageLimitsBlockedWords.has(normalizedWord)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messageLimitsBlockedWords'],
          message: 'Это слово уже есть в списке.',
        });
        break;
      }

      normalizedMessageLimitsBlockedWords.add(normalizedWord);
    }

    const normalizedMessageLimitsBlockedDomains = new Set<string>();
    for (const rawDomain of value.messageLimitsBlockedDomains) {
      const normalizedDomain = normalizeMessageLimitsBlockedDomainCandidate(rawDomain);
      if (!normalizedDomain) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messageLimitsBlockedDomains'],
          message: 'Укажите домен или ссылку.',
        });
        break;
      }

      if (normalizedMessageLimitsBlockedDomains.has(normalizedDomain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messageLimitsBlockedDomains'],
          message: 'Этот домен уже есть в списке.',
        });
        break;
      }

      normalizedMessageLimitsBlockedDomains.add(normalizedDomain);
    }

    const textFiltersBotButtons = resolveStoredLinkButtons({
      buttons: value.textFiltersBotButtons,
      buttonUrl: value.textFiltersBotButtonUrl,
      buttonText: value.textFiltersBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.textFiltersBotMessageEnabled && value.textFiltersBotButtonEnabled,
        buttons: textFiltersBotButtons,
        buttonsPath: 'textFiltersBotButtons',
        buttonUrl: value.textFiltersBotButtonUrl,
        buttonText: value.textFiltersBotButtonText,
        buttonUrlPath: 'textFiltersBotButtonUrl',
        buttonTextPath: 'textFiltersBotButtonText',
      },
      ctx,
    );

    const thematicFiltersBotButtons = resolveStoredLinkButtons({
      buttons: value.thematicFiltersBotButtons,
      buttonUrl: value.thematicFiltersBotButtonUrl,
      buttonText: value.thematicFiltersBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.thematicFiltersBotMessageEnabled && value.thematicFiltersBotButtonEnabled,
        buttons: thematicFiltersBotButtons,
        buttonsPath: 'thematicFiltersBotButtons',
        buttonUrl: value.thematicFiltersBotButtonUrl,
        buttonText: value.thematicFiltersBotButtonText,
        buttonUrlPath: 'thematicFiltersBotButtonUrl',
        buttonTextPath: 'thematicFiltersBotButtonText',
      },
      ctx,
    );

    if (value.thematicCodewordEnabled) {
      const codeword = value.thematicCodeword.trim();
      if (!codeword) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['thematicCodeword'],
          message: 'Укажите кодовое слово.',
        });
      } else if (codeword.split(/\s+/u).filter(Boolean).length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['thematicCodeword'],
          message: 'Кодовое слово должно быть одним словом без пробелов.',
        });
      } else {
        const normalizedCodeword = normalizeThematicCodewordCandidate(codeword);
        if (
          !normalizedCodeword ||
          normalizedCodeword.length < 2 ||
          normalizedCodeword.length > 32
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['thematicCodeword'],
            message: 'Кодовое слово должно содержать 2-32 буквы или цифры.',
          });
        }
      }
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

    const nightModeBotButtons = resolveStoredLinkButtons({
      buttons: value.nightModeBotButtons,
      buttonUrl: value.nightModeBotButtonUrl,
      buttonText: value.nightModeBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.nightModeBotMessageEnabled && value.nightModeBotButtonEnabled,
        buttons: nightModeBotButtons,
        buttonsPath: 'nightModeBotButtons',
        buttonUrl: value.nightModeBotButtonUrl,
        buttonText: value.nightModeBotButtonText,
        buttonUrlPath: 'nightModeBotButtonUrl',
        buttonTextPath: 'nightModeBotButtonText',
      },
      ctx,
    );

    if (
      value.nightModeForceCloseEnabled &&
      !value.nightModeForceCloseForever &&
      value.nightModeForceCloseHours === 0 &&
      value.nightModeForceCloseDays === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nightModeForceCloseHours'],
        message: 'Укажите длительность хотя бы на 1 час или 1 день.',
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nightModeForceCloseDays'],
        message: 'Укажите длительность хотя бы на 1 час или 1 день.',
      });
    }
  })
  .transform((value) => {
    const greetingBotButtonState = buildStoredLinkButtonState({
      buttons: value.greetingBotButtons,
      buttonEnabled: value.greetingBotButtonEnabled,
      buttonUrl: value.greetingBotButtonUrl,
      buttonText: value.greetingBotButtonText,
    });
    const messageLimitsBotButtonState = buildStoredLinkButtonState({
      buttons: value.messageLimitsBotButtons,
      buttonEnabled: value.messageLimitsBotButtonEnabled,
      buttonUrl: value.messageLimitsBotButtonUrl,
      buttonText: value.messageLimitsBotButtonText,
    });
    const textFiltersBotButtonState = buildStoredLinkButtonState({
      buttons: value.textFiltersBotButtons,
      buttonEnabled: value.textFiltersBotButtonEnabled,
      buttonUrl: value.textFiltersBotButtonUrl,
      buttonText: value.textFiltersBotButtonText,
    });
    const thematicFiltersBotButtonState = buildStoredLinkButtonState({
      buttons: value.thematicFiltersBotButtons,
      buttonEnabled: value.thematicFiltersBotButtonEnabled,
      buttonUrl: value.thematicFiltersBotButtonUrl,
      buttonText: value.thematicFiltersBotButtonText,
    });
    const nightModeBotButtonState = buildStoredLinkButtonState({
      buttons: value.nightModeBotButtons,
      buttonEnabled: value.nightModeBotButtonEnabled,
      buttonUrl: value.nightModeBotButtonUrl,
      buttonText: value.nightModeBotButtonText,
    });
    const linkBotButtonState = buildStoredLinkButtonState({
      buttons: value.linkBotButtons,
      buttonEnabled: value.linkBotButtonEnabled,
      buttonUrl: value.linkBotButtonUrl,
      buttonText: value.linkBotButtonText,
    });
    const duplicateBotButtonState = buildStoredLinkButtonState({
      buttons: value.duplicateBotButtons,
      buttonEnabled: value.duplicateBotButtonEnabled,
      buttonUrl: value.duplicateBotButtonUrl,
      buttonText: value.duplicateBotButtonText,
    });

    return {
      ...value,
      greetingBotButtons: greetingBotButtonState.buttons,
      greetingBotButtonEnabled: greetingBotButtonState.buttonEnabled,
      greetingBotButtonUrl: greetingBotButtonState.buttonUrl,
      greetingBotButtonText: greetingBotButtonState.buttonText,
      messageLimitsBotButtons: messageLimitsBotButtonState.buttons,
      messageLimitsBotButtonEnabled: messageLimitsBotButtonState.buttonEnabled,
      messageLimitsBotButtonUrl: messageLimitsBotButtonState.buttonUrl,
      messageLimitsBotButtonText: messageLimitsBotButtonState.buttonText,
      textFiltersBotButtons: textFiltersBotButtonState.buttons,
      textFiltersBotButtonEnabled: textFiltersBotButtonState.buttonEnabled,
      textFiltersBotButtonUrl: textFiltersBotButtonState.buttonUrl,
      textFiltersBotButtonText: textFiltersBotButtonState.buttonText,
      thematicFiltersBotButtons: thematicFiltersBotButtonState.buttons,
      thematicFiltersBotButtonEnabled: thematicFiltersBotButtonState.buttonEnabled,
      thematicFiltersBotButtonUrl: thematicFiltersBotButtonState.buttonUrl,
      thematicFiltersBotButtonText: thematicFiltersBotButtonState.buttonText,
      nightModeBotButtons: nightModeBotButtonState.buttons,
      nightModeBotButtonEnabled: nightModeBotButtonState.buttonEnabled,
      nightModeBotButtonUrl: nightModeBotButtonState.buttonUrl,
      nightModeBotButtonText: nightModeBotButtonState.buttonText,
      linkBotButtons: linkBotButtonState.buttons,
      linkBotButtonEnabled: linkBotButtonState.buttonEnabled,
      linkBotButtonUrl: linkBotButtonState.buttonUrl,
      linkBotButtonText: linkBotButtonState.buttonText,
      duplicateBotButtons: duplicateBotButtonState.buttons,
      duplicateBotButtonEnabled: duplicateBotButtonState.buttonEnabled,
      duplicateBotButtonUrl: duplicateBotButtonState.buttonUrl,
      duplicateBotButtonText: duplicateBotButtonState.buttonText,
    };
  });
export type ChatSettings = z.infer<typeof chatSettingsSchema>;

const chatRulesObjectSchema = z.object({
  text: chatRulesTextSchema,
  imageBase64: chatRulesImageBase64Schema,
  imageMimeType: chatRulesImageMimeTypeSchema,
  imageFileName: chatRulesImageFileNameSchema,
  autoTextEnabled: z.boolean().default(false),
  buttons: z.array(storedLinkButtonDraftSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
  buttonEnabled: z.boolean().default(false),
  buttonUrl: botButtonUrlSchema,
  buttonText: botButtonTextSchema,
  adminContactButtonEnabled: z.boolean().default(false),
  adminContactButtonUrl: botButtonUrlSchema,
  publishedMessageId: z.string().trim().min(1).nullable().default(null),
  publishedUrl: z.string().trim().max(2_048).nullable().default(null),
  publishedAt: z.string().datetime().nullable().default(null),
});

function addChatRulesDraftIssues(
  value: Pick<
    z.infer<typeof chatRulesObjectSchema>,
    | 'imageBase64'
    | 'imageMimeType'
    | 'buttons'
    | 'buttonEnabled'
    | 'buttonUrl'
    | 'buttonText'
    | 'adminContactButtonEnabled'
    | 'adminContactButtonUrl'
  > & { publishedUrl?: string | null },
  ctx: z.RefinementCtx,
) {
  const buttons = resolveStoredLinkButtons(value);
  if (value.imageBase64 && !value.imageMimeType.trim().toLowerCase().startsWith('image/')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['imageMimeType'],
      message: 'Неверный формат фото.',
    });
  }
  if (value.buttonEnabled && buttons.length > 0) {
    addStoredLinkButtonIssues(buttons, ctx, ['buttons']);
  } else if (
    value.buttonEnabled &&
    value.buttons.length === 0 &&
    !isValidBotButtonUrl(value.buttonUrl)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buttonUrl'],
      message: 'Укажите корректную ссылку для кнопки (http/https).',
    });
  }
  if (
    !(value.buttonEnabled && buttons.length > 0) &&
    value.buttonEnabled &&
    value.buttons.length === 0 &&
    !isValidBotButtonText(value.buttonText)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buttonText'],
      message: 'Введите название кнопки.',
    });
  }
  if (
    value.adminContactButtonEnabled &&
    !isValidAdminContactButtonUrl(value.adminContactButtonUrl)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['adminContactButtonUrl'],
      message: 'Ссылка на админа недоступна.',
    });
  }
  if (value.publishedUrl && !isValidBotButtonUrl(value.publishedUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publishedUrl'],
      message: 'Сохранена некорректная ссылка на пост правил.',
    });
  }
}

export const chatRulesSchema = chatRulesObjectSchema
  .superRefine(addChatRulesDraftIssues)
  .transform((value) => {
    const buttonState = buildStoredLinkButtonState(value);

    return {
      ...value,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
    };
  });
export type ChatRules = z.infer<typeof chatRulesSchema>;

export const updateChatRulesRequestSchema = chatRulesObjectSchema
  .pick({
    text: true,
    imageBase64: true,
    imageMimeType: true,
    imageFileName: true,
    autoTextEnabled: true,
    buttons: true,
    buttonEnabled: true,
    buttonUrl: true,
    buttonText: true,
    adminContactButtonEnabled: true,
    adminContactButtonUrl: true,
  })
  .superRefine(addChatRulesDraftIssues)
  .transform((value) => {
    const buttonState = buildStoredLinkButtonState(value);

    return {
      ...value,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
    };
  });
export type UpdateChatRulesRequest = z.infer<typeof updateChatRulesRequestSchema>;

export const publishChatRulesResultSchema = z.object({
  chatId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .refine((value) => isValidBotButtonUrl(value), {
      message: 'Укажите корректную ссылку на опубликованные правила.',
    })
    .nullable(),
  publishedAt: z.string().datetime(),
});
export type PublishChatRulesResult = z.infer<typeof publishChatRulesResultSchema>;

export const channelSettingsSchema = z
  .object({
    autoPostButtonsMode: channelAutoPostButtonsModeSchema.default('OFF'),
    postSuggestionsEnabled: z.boolean().default(false),
    postSuggestionsText: botMessageTextSchema,
    postSuggestionsDailyLimit: z.number().int().min(1).max(10).default(10),
    postSuggestionsEntryMode: channelSuggestionEntryModeSchema.default('BOT'),
    engagementMessageText: botMessageTextSchema.default(
      'Есть идея или обратная связь? Нажмите кнопку ниже.',
    ),
    postSuggestionsButtonEnabled: z.boolean().default(false),
    postSuggestionsButtonText: z.string().trim().max(32).default('Предложить пост'),
    postSuggestionsButtonUrl: botButtonUrlSchema,
    commentsEnabled: z.boolean().default(false),
    commentsModerationEnabled: z.boolean().default(false),
    commentsBlockLinksEnabled: z.boolean().default(true),
    commentsAntiSpamEnabled: z.boolean().default(true),
    commentsLimitTwoInRowEnabled: z.boolean().default(true),
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

export const updateManagedPollRequestSchema = z.object({
  question: managedPollQuestionSchema,
  options: managedPollOptionsDraftSchema,
});
export type UpdateManagedPollRequest = z.infer<typeof updateManagedPollRequestSchema>;

export const managedPollOptionResultSchema = z.object({
  option: managedPollOptionDraftSchema,
  votes: z.number().int().min(0).default(0),
  percent: z.number().int().min(0).max(100).default(0),
});
export type ManagedPollOptionResult = z.infer<typeof managedPollOptionResultSchema>;

export const managedPollSchema = z.object({
  question: managedPollQuestionSchema,
  options: managedPollOptionsDraftSchema,
  status: managedPollStatusSchema.default('DRAFT'),
  activeVersion: z.number().int().min(0).default(0),
  publishedMessageId: z.string().nullable().optional().default(null),
  publishedUrl: z.string().nullable().optional().default(null),
  publishedAt: z.string().datetime().nullable().optional().default(null),
  closedAt: z.string().datetime().nullable().optional().default(null),
  totalVotes: z.number().int().min(0).default(0),
  optionResults: z.array(managedPollOptionResultSchema).default([]),
});
export type ManagedPoll = z.infer<typeof managedPollSchema>;

export const moderationEventSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  userId: z.string(),
  eventType: z.enum(['MESSAGE', 'MEMBER_ACTION', 'SYSTEM']),
  ruleCode: z.string(),
  action: sanctionActionSchema,
  maskedExcerpt: z.string().nullable(),
  score: z.number(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.string().datetime(),
  operator: z.enum(['BOT', 'ADMIN']),
});
export type ModerationEvent = z.infer<typeof moderationEventSchema>;

export const resolveRequiredSubscriptionChannelRequestSchema = z.object({
  value: z.string().trim().min(1).max(2048),
});
export type ResolveRequiredSubscriptionChannelRequest = z.infer<
  typeof resolveRequiredSubscriptionChannelRequestSchema
>;

export const resolveRequiredSubscriptionChannelResponseSchema = z.object({
  channel: managedEntityHeaderSchema,
});
export type ResolveRequiredSubscriptionChannelResponse = z.infer<
  typeof resolveRequiredSubscriptionChannelResponseSchema
>;

export const applySettingsTargetModeSchema = z.enum([
  'all',
  'allFavorites',
  'favoriteTypes',
  'selectedChats',
  'current',
]);
export type ApplySettingsTargetMode = z.infer<typeof applySettingsTargetModeSchema>;

export const applySettingsTargetSchema = z
  .object({
    mode: applySettingsTargetModeSchema.default('all'),
    favoriteTypes: z.array(managedEntityFavoriteTypeSchema).max(6).default([]),
    chatIds: z.array(z.string().trim().min(1)).max(500).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'favoriteTypes' && value.favoriteTypes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['favoriteTypes'],
        message: 'Выберите хотя бы один тип избранного.',
      });
    }

    if (value.mode === 'selectedChats' && value.chatIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chatIds'],
        message: 'Выберите хотя бы один чат.',
      });
    }
  })
  .transform((value) => ({
    mode: value.mode,
    favoriteTypes: Array.from(new Set(value.favoriteTypes)),
    chatIds: Array.from(new Set(value.chatIds)),
  }));
export type ApplySettingsTarget = z.infer<typeof applySettingsTargetSchema>;

export const applySectionToAllRequestSchema = z.object({
  section: applySettingsSectionSchema,
  target: applySettingsTargetSchema
    .optional()
    .default({ mode: 'all', favoriteTypes: [], chatIds: [] }),
});
export type ApplySectionToAllRequest = z.infer<typeof applySectionToAllRequestSchema>;

export const applySectionToAllResponseSchema = z.object({
  section: applySettingsSectionSchema,
  sourceChatId: z.string(),
  updatedChats: z.number().int().min(0),
  appliedChatIds: z.array(z.string()),
  targetMode: applySettingsTargetModeSchema.optional().default('all'),
  favoriteTypes: z.array(managedEntityFavoriteTypeSchema).optional().default([]),
});
export type ApplySectionToAllResponse = z.infer<typeof applySectionToAllResponseSchema>;

export const applySectionTargetPreviewRequestSchema = z.object({
  target: applySettingsTargetSchema
    .optional()
    .default({ mode: 'all', favoriteTypes: [], chatIds: [] }),
});
export type ApplySectionTargetPreviewRequest = z.infer<
  typeof applySectionTargetPreviewRequestSchema
>;

export const applySectionTargetPreviewResponseSchema = z.object({
  sourceChatId: z.string(),
  targetMode: applySettingsTargetModeSchema,
  favoriteTypes: z.array(managedEntityFavoriteTypeSchema).default([]),
  updatedChats: z.number().int().min(0),
  appliedChatIds: z.array(z.string()),
  sampleChats: z.array(chatSummarySchema).default([]),
});
export type ApplySectionTargetPreviewResponse = z.infer<
  typeof applySectionTargetPreviewResponseSchema
>;

export const meSchema = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().trim().url().nullable().default(null),
  profileUrl: z.string().trim().url().nullable().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().default(null),
  canAccessSystem: z.boolean().optional(),
});
export type Me = z.infer<typeof meSchema>;

export const dateRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const logsDashboardQuerySchema = z.object({
  range: logsDashboardRangeSchema.default('7d'),
  includeActivityPreview: booleanQueryFlagSchema.default(true),
  includeModerationPreview: booleanQueryFlagSchema.default(true),
});
export type LogsDashboardQuery = z.infer<typeof logsDashboardQuerySchema>;

export const moderationFeedFilterSchema = z.enum([
  'ALL',
  'WARN',
  'DELETE_MESSAGE',
  'MUTE',
  'BAN',
  'UNMUTE',
  'UNBAN',
]);
export type ModerationFeedFilter = z.infer<typeof moderationFeedFilterSchema>;

export const moderationFeedQuerySchema = z.object({
  range: logsDashboardRangeSchema.default('7d'),
  filter: moderationFeedFilterSchema.default('ALL'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional(),
});
export type ModerationFeedQuery = z.infer<typeof moderationFeedQuerySchema>;

export const chatParticipantRoleSchema = z.enum(['owner', 'admin', 'member']);
export type ChatParticipantRole = z.infer<typeof chatParticipantRoleSchema>;

export const chatParticipantImmunitySchema = z.object({
  expiresAt: z.string().datetime(),
  dailyViolationLimit: z.number().int().min(1).max(10),
  usedViolatingMessagesToday: z.number().int().min(0),
  remainingViolatingMessagesToday: z.number().int().min(0),
});
export type ChatParticipantImmunity = z.infer<typeof chatParticipantImmunitySchema>;

export const chatParticipantItemSchema = z.object({
  userId: z.string(),
  userDisplayName: z.string().min(1),
  username: z.string().trim().min(1).nullable().default(null),
  avatarUrl: z.string().trim().url().nullable().default(null),
  profileUrl: z.string().trim().url().nullable().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().default(null),
  violationCount: z.number().int().min(0).default(0),
  immunity: chatParticipantImmunitySchema.nullable().default(null),
  role: chatParticipantRoleSchema,
  isBot: z.boolean().default(false),
});
export type ChatParticipantItem = z.infer<typeof chatParticipantItemSchema>;

export const chatParticipantsPageSchema = z.object({
  items: z.array(chatParticipantItemSchema),
  totalCount: z.number().int().min(0).nullable().default(null),
  hasMore: z.boolean(),
  nextCursor: z.string().trim().min(1).nullable(),
});
export type ChatParticipantsPage = z.infer<typeof chatParticipantsPageSchema>;

export const chatParticipantsQuerySchema = z.object({
  range: logsDashboardRangeSchema.default('7d'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().trim().min(1).optional(),
  search: z.string().trim().max(100).optional(),
});
export type ChatParticipantsQuery = z.infer<typeof chatParticipantsQuerySchema>;

export const chatParticipantImmunityUpdateRequestSchema = z
  .object({
    enabled: z.boolean(),
    durationHours: z
      .number()
      .int()
      .min(24, 'Срок должен быть от 1 до 30 дней.')
      .max(720, 'Срок должен быть от 1 до 30 дней.')
      .optional(),
    dailyViolationLimit: z.number().int().min(1).max(10).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && value.durationHours === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationHours'],
        message: 'Укажите срок иммунитета.',
      });
    }

    if (value.enabled && value.dailyViolationLimit === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dailyViolationLimit'],
        message: 'Укажите лимит.',
      });
    }

    if (!value.enabled && value.durationHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationHours'],
        message: 'Срок доступен только для активного иммунитета.',
      });
    }

    if (!value.enabled && value.dailyViolationLimit !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dailyViolationLimit'],
        message: 'Лимит доступен только для активного иммунитета.',
      });
    }
  });
export type ChatParticipantImmunityUpdateRequest = z.infer<
  typeof chatParticipantImmunityUpdateRequestSchema
>;

export const chatParticipantImmunityUpdateResultSchema = z.object({
  immunity: chatParticipantImmunitySchema.nullable().default(null),
  message: z.string().min(1),
});
export type ChatParticipantImmunityUpdateResult = z.infer<
  typeof chatParticipantImmunityUpdateResultSchema
>;

export const logsDashboardViolationSchema = z.object({
  id: z.string(),
  action: sanctionActionSchema,
  ruleCode: z.string(),
  userId: z.string(),
  userDisplayName: z.string().nullable(),
  avatarUrl: z.string().trim().url().nullable().default(null),
  profileUrl: z.string().trim().url().nullable().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().default(null),
  createdAt: z.string().datetime(),
  maskedExcerpt: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type LogsDashboardViolation = z.infer<typeof logsDashboardViolationSchema>;

export const moderationFeedPageSchema = z.object({
  items: z.array(logsDashboardViolationSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type ModerationFeedPage = z.infer<typeof moderationFeedPageSchema>;

export const logsDashboardResponseSchema = z.object({
  chat: z.object({
    id: z.string(),
    title: z.string(),
    participantsCount: z.number().int().min(0).nullable(),
    avatarUrl: z.string().trim().url().nullable().optional(),
  }),
  period: z.object({
    range: logsDashboardRangeSchema,
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  membership: z.object({
    joinedUsers: z.number().int().min(0),
    leftUsers: z.number().int().min(0),
    netUsers: z.number().int(),
  }),
  violationsSummary: z.object({
    warn: z.number().int().min(0),
    deleteMessage: z.number().int().min(0),
    mute: z.number().int().min(0),
    ban: z.number().int().min(0),
    unmute: z.number().int().min(0),
    unban: z.number().int().min(0),
    affectedUsers: z.number().int().min(0),
    total: z.number().int().min(0),
  }),
  violations: z.array(logsDashboardViolationSchema),
  moderationFeed: moderationFeedPageSchema,
  activityFeed: membershipActivityPageSchema,
});
export type LogsDashboardResponse = z.infer<typeof logsDashboardResponseSchema>;

export const manualModerationActionSchema = z.enum(['MUTE', 'BAN', 'UNMUTE', 'UNBAN']);
export type ManualModerationAction = z.infer<typeof manualModerationActionSchema>;

export const manualModerationActionRequestSchema = z
  .object({
    action: manualModerationActionSchema,
    muteDurationHours: z.number().int().min(1).max(336).optional(),
    mutePermanent: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const mutePermanent = value.mutePermanent === true;

    if (value.action === 'MUTE' && !mutePermanent && value.muteDurationHours === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['muteDurationHours'],
        message: 'Укажите длительность мута в часах.',
      });
    }

    if (value.action === 'MUTE' && mutePermanent && value.muteDurationHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['muteDurationHours'],
        message: 'Для бессрочного мута длительность не нужна.',
      });
    }

    if (value.action !== 'MUTE' && value.muteDurationHours !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['muteDurationHours'],
        message: 'Длительность мута доступна только для действия MUTE.',
      });
    }

    if (value.action !== 'MUTE' && value.mutePermanent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mutePermanent'],
        message: 'Бессрочный мут доступен только для действия MUTE.',
      });
    }
  });
export type ManualModerationActionRequest = z.infer<typeof manualModerationActionRequestSchema>;

export const manualModerationActionResultSchema = z.object({
  ok: z.literal(true),
  action: manualModerationActionSchema,
  userId: z.string(),
  muteDurationHours: z.number().int().min(1).max(336).nullable(),
  muteExpiresAt: z.string().datetime().nullable(),
  message: z.string().min(1),
});
export type ManualModerationActionResult = z.infer<typeof manualModerationActionResultSchema>;

export const globalSpammerCandidateStatusSchema = z.enum([
  'PENDING',
  'AUTO_APPROVED',
  'APPROVED',
  'SUPPRESSED',
]);
export type GlobalSpammerCandidateStatus = z.infer<typeof globalSpammerCandidateStatusSchema>;

export const globalSpammerReviewActionSchema = z.enum(['APPROVE', 'SUPPRESS']);
export type GlobalSpammerReviewAction = z.infer<typeof globalSpammerReviewActionSchema>;

export const globalSpammerConfidenceLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type GlobalSpammerConfidenceLevel = z.infer<typeof globalSpammerConfidenceLevelSchema>;

export const globalSpammerReviewRequestSchema = z.object({
  action: globalSpammerReviewActionSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});
export type GlobalSpammerReviewRequest = z.infer<typeof globalSpammerReviewRequestSchema>;

export const globalSpammerReviewResultSchema = z.object({
  ok: z.literal(true),
  status: globalSpammerCandidateStatusSchema,
  userId: z.string(),
});
export type GlobalSpammerReviewResult = z.infer<typeof globalSpammerReviewResultSchema>;

export const globalSpammerCandidateChatSchema = z.object({
  chatId: z.string(),
  detectionsCount: z.number().int().min(0),
  lastMessageId: z.string().nullable(),
  lastExcerpt: z.string().nullable(),
  lastUserLabel: z.string().nullable(),
  lastDetectedAt: z.string().datetime(),
});
export type GlobalSpammerCandidateChat = z.infer<typeof globalSpammerCandidateChatSchema>;

export const globalSpammerObservationSchema = z.object({
  id: z.string(),
  source: z.string(),
  score: z.number().min(0).max(1),
  confidenceLevel: globalSpammerConfidenceLevelSchema,
  reason: z.string(),
  chatId: z.string().nullable(),
  messageId: z.string().nullable(),
  evidenceHash: z.string(),
  evidence: z.unknown().nullable(),
  observedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  suppressedAt: z.string().datetime().nullable(),
  suppressionReason: z.string().nullable(),
});
export type GlobalSpammerObservation = z.infer<typeof globalSpammerObservationSchema>;

export const globalSpammerReviewCandidateSchema = z.object({
  userId: z.string(),
  displayName: z.string().trim().nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional().default(null),
  profileUrl: z.string().trim().url().nullable().optional().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().optional().default(null),
  status: globalSpammerCandidateStatusSchema,
  confidenceScore: z.number().min(0).max(1),
  sourceBreakdown: z.unknown(),
  lastReason: z.string(),
  lastChatId: z.string().nullable(),
  lastEvidence: z.unknown().nullable(),
  lastUserLabel: z.string().nullable(),
  suppressedUntil: z.string().datetime().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  reviewedByUserId: z.string().nullable(),
  reviewReason: z.string().nullable(),
  falsePositive: z.boolean(),
  chats: z.array(globalSpammerCandidateChatSchema),
  observations: z.array(globalSpammerObservationSchema),
});
export type GlobalSpammerReviewCandidate = z.infer<typeof globalSpammerReviewCandidateSchema>;

export const globalSpammerReviewQueueSchema = z.object({
  items: z.array(globalSpammerReviewCandidateSchema),
  limit: z.number().int().min(1).max(100),
});
export type GlobalSpammerReviewQueue = z.infer<typeof globalSpammerReviewQueueSchema>;

export const globalSpammerCampaignSummarySchema = z.object({
  clusterId: z.string(),
  signalType: z.string(),
  status: z.string(),
  confidenceScore: z.number().min(0).max(1),
  distinctUsersCount: z.number().int().min(0),
  distinctChatsCount: z.number().int().min(0),
  observationsCount: z.number().int().min(0),
  lastSeenAt: z.string().datetime(),
  preview: z.string().nullable(),
});
export type GlobalSpammerCampaignSummary = z.infer<typeof globalSpammerCampaignSummarySchema>;

export const globalSpammerShadowScoreSummarySchema = z.object({
  currentScore: z.number().min(0).max(1),
  v2Score: z.number().min(0).max(1),
  scoreDelta: z.number().min(-1).max(1),
  currentBand: z.string(),
  v2Band: z.string(),
  wouldPromote: z.boolean(),
  wouldSuppress: z.boolean(),
  createdAt: z.string().datetime(),
});
export type GlobalSpammerShadowScoreSummary = z.infer<
  typeof globalSpammerShadowScoreSummarySchema
>;

export const globalSpammerReviewMetricsSchema = z.object({
  pending: z.number().int().min(0),
  approved: z.number().int().min(0),
  suppressed: z.number().int().min(0),
  reviewed: z.number().int().min(0),
  activeRegistry: z.number().int().min(0).default(0),
  expiredRegistry: z.number().int().min(0).default(0),
  archivedExpired: z.number().int().min(0).default(0),
  newCandidates24h: z.number().int().min(0).default(0),
  autoApproved24h: z.number().int().min(0).default(0),
  suppressed24h: z.number().int().min(0).default(0),
  shadowWouldEnforceCount: z.number().int().min(0).default(0),
  topCampaigns: z.array(globalSpammerCampaignSummarySchema).default([]),
  enforcementMode: z.enum(['enforce', 'shadow']).default('enforce'),
  falsePositiveCount: z.number().int().min(0),
  falsePositiveRate: z.number().min(0).max(1),
  recentObservations: z.array(
    z.object({
      source: z.string(),
      count: z.number().int().min(0),
    }),
  ),
  suppressedObservations: z.array(
    z.object({
      source: z.string(),
      count: z.number().int().min(0),
    }),
  ),
  sourceAlerts: z.array(
    z.object({
      source: z.string(),
      level: z.enum(['warning', 'critical']),
      reason: z.string(),
    }),
  ),
  sourceReputation: z
    .array(
      z.object({
        source: z.string(),
        weight: z.number().min(0).max(1),
        falsePositiveRate: z.number().min(0).max(1),
        observations: z.number().int().min(0),
        suppressed: z.number().int().min(0),
      }),
    )
    .default([]),
});
export type GlobalSpammerReviewMetrics = z.infer<typeof globalSpammerReviewMetricsSchema>;

export const globalSpammerRegistryStatusSchema = z.enum([
  'NONE',
  'ACTIVE_CONFIRMED',
  'LOCAL_BLOCKED',
  'MEDIUM_REVIEW',
  'SUPPRESSED',
  'EXPIRED',
  'ADMIN_EXEMPT',
]);
export type GlobalSpammerRegistryStatus = z.infer<typeof globalSpammerRegistryStatusSchema>;

export const globalSpammerPolicyActionSchema = z.enum([
  'NONE',
  'DELETE_AND_KICK',
  'SHADOW_DELETE_AND_KICK',
]);
export type GlobalSpammerPolicyAction = z.infer<typeof globalSpammerPolicyActionSchema>;

export const globalSpammerPolicyDecisionSchema = z.object({
  userId: z.string(),
  chatId: z.string().nullable(),
  trigger: z.string(),
  registryStatus: globalSpammerRegistryStatusSchema,
  action: globalSpammerPolicyActionSchema,
  enforcementMode: z.enum(['enforce', 'shadow']),
  policyBand: z
    .enum(['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH', 'CONFIRMED'])
    .default('LOW'),
  deleteSpammersEnabled: z.boolean(),
  adminExempt: z.boolean(),
  shadow: z.boolean(),
  wouldEnforce: z.boolean(),
  enforced: z.boolean(),
  confidenceScore: z.number().min(0).max(1).nullable(),
  shadowScore: z.number().min(0).max(1).nullable().default(null),
  reason: z.string(),
  expiresAt: z.string().datetime().nullable(),
  sourceBreakdown: z.unknown().nullable(),
  campaignBreakdown: z.unknown().nullable().default(null),
});
export type GlobalSpammerPolicyDecision = z.infer<typeof globalSpammerPolicyDecisionSchema>;

export const localAdminSpammerDecisionSchema = z.enum(['ALLOW', 'BLOCK', 'REVIEW']);
export type LocalAdminSpammerDecision = z.infer<typeof localAdminSpammerDecisionSchema>;

export const globalSpammerUserDiagnosticsSchema = z.object({
  userId: z.string(),
  chatId: z.string().nullable(),
  displayName: z.string().trim().nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional().default(null),
  profileUrl: z.string().trim().url().nullable().optional().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().optional().default(null),
  policy: globalSpammerPolicyDecisionSchema,
  registry: z.object({
    active: z.boolean(),
    expired: z.boolean(),
    confidenceScore: z.number().min(0).max(1).nullable(),
    confirmedAt: z.string().datetime().nullable(),
    confirmedByUserId: z.string().nullable(),
    reason: z.string().nullable(),
    expiresAt: z.string().datetime().nullable(),
    sourceBreakdown: z.unknown().nullable(),
  }),
  candidate: z
    .object({
      status: z.string(),
      confidenceScore: z.number().min(0).max(1),
      lastReason: z.string(),
      reviewedAt: z.string().datetime().nullable(),
      reviewedByUserId: z.string().nullable(),
      reviewReason: z.string().nullable(),
      falsePositive: z.boolean(),
    })
    .nullable(),
  activeSuppression: z
    .object({
      source: z.string(),
      reason: z.string(),
      adminUserId: z.string().nullable(),
      suppressedUntil: z.string().datetime(),
    })
    .nullable(),
  observations: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      score: z.number().min(0).max(1),
      confidenceLevel: z.string(),
      reason: z.string(),
      chatId: z.string().nullable(),
      observedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      suppressedAt: z.string().datetime().nullable(),
    }),
  ),
  graphSignals: z.array(
    z.object({
      signalType: z.string(),
      source: z.string(),
      score: z.number().min(0).max(1),
      chatId: z.string().nullable(),
      observedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
    }),
  ),
  sourceReputation: z.array(
    z.object({
      source: z.string(),
      weight: z.number().min(0).max(1),
      falsePositiveRate: z.number().min(0).max(1),
      observations: z.number().int().min(0),
      suppressed: z.number().int().min(0),
    }),
  ),
  campaigns: z.array(globalSpammerCampaignSummarySchema).default([]),
  latestShadowScore: globalSpammerShadowScoreSummarySchema.nullable().default(null),
  localAdminDecision: z
    .object({
      decision: localAdminSpammerDecisionSchema,
      reason: z.string(),
      sourceChatId: z.string().nullable(),
      decidedByUserIds: z.array(z.string()).default([]),
      updatedAt: z.string().datetime(),
    })
    .nullable()
    .default(null),
  reputationSummary: z
    .object({
      naturalBanSignals: z.number().int().min(0).default(0),
      localBlockSignals: z.number().int().min(0).default(0),
      localAllowSignals: z.number().int().min(0).default(0),
      onlyReputationSignals: z.boolean().default(false),
      note: z.string().default('Репутационные сигналы учитываются как фон, а не как приговор.'),
    })
    .default({
      naturalBanSignals: 0,
      localBlockSignals: 0,
      localAllowSignals: 0,
      onlyReputationSignals: false,
      note: 'Репутационные сигналы учитываются как фон, а не как приговор.',
    }),
});
export type GlobalSpammerUserDiagnostics = z.infer<typeof globalSpammerUserDiagnosticsSchema>;

export const updateSettingsRequestSchema = chatSettingsSchema;

export const addAdminRequestSchema = z.object({
  userId: z.string(),
});

export const addDomainRequestSchema = z
  .object({
    domain: z.string().trim().min(3).max(2_048),
    matchType: allowlistMatchTypeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const normalized =
      value.matchType === 'DOMAIN'
        ? normalizeAllowlistDomain(value.domain)
        : value.matchType === 'EXACT'
          ? normalizeAllowlistLink(value.domain)
          : (normalizeAllowlistLink(value.domain) ?? normalizeAllowlistDomain(value.domain));

    if (normalized) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        value.matchType === 'DOMAIN'
          ? 'Укажите корректный домен.'
          : value.matchType === 'EXACT'
            ? 'Укажите корректную ссылку (http/https).'
            : 'Укажите корректную ссылку или домен.',
      path: ['domain'],
    });
  });

export const domainAllowlistEntrySchema = z.object({
  domain: z.string().trim().min(3).max(2_048),
  normalizedValue: z.string().trim().min(3).max(2_048),
  matchType: allowlistMatchTypeSchema,
  removeAfterAt: z.string().datetime().nullable(),
});
export type DomainAllowlistEntry = z.infer<typeof domainAllowlistEntrySchema>;

export const scheduleDomainRemovalRequestSchema = z.object({
  removeAfterAt: z.string().datetime().nullable(),
});

export const broadcastScheduleModeSchema = z.enum(['legacy', 'calendar']);
export type BroadcastScheduleMode = z.infer<typeof broadcastScheduleModeSchema>;

const MAX_BROADCAST_CALENDAR_SLOTS = 186;

function normalizeBroadcastLinkButtons(values: BroadcastLinkButton[]): BroadcastLinkButton[] {
  return values.map((value) => ({
    text: value.text.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
    url: value.url.trim(),
  }));
}

function resolveBroadcastLinkButtons(value: {
  buttons?: BroadcastLinkButton[];
  buttonEnabled?: boolean;
  buttonUrl?: string;
  buttonText?: string;
}): BroadcastLinkButton[] {
  if (Array.isArray(value.buttons) && value.buttons.length > 0) {
    return normalizeBroadcastLinkButtons(value.buttons);
  }

  if (!value.buttonEnabled) {
    return [];
  }

  return normalizeBroadcastLinkButtons([
    {
      text: value.buttonText ?? DEFAULT_BROADCAST_BUTTON_TEXT,
      url: value.buttonUrl ?? '',
    },
  ]);
}

function addBroadcastButtonIssues(
  value: {
    buttons?: BroadcastLinkButton[];
    buttonEnabled?: boolean;
    buttonUrl?: string;
    buttonText?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if ((value.buttons?.length ?? 0) > 0 || !value.buttonEnabled) {
    return;
  }

  if (!isValidBotButtonUrl(value.buttonUrl ?? '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buttonUrl'],
      message: 'Укажите корректную ссылку для кнопки (http/https).',
    });
  }

  if (!isValidBotButtonText(value.buttonText ?? '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buttonText'],
      message: 'Введите название кнопки.',
    });
  }
}

function buildBroadcastButtonState(value: {
  buttons?: BroadcastLinkButton[];
  buttonEnabled?: boolean;
  buttonUrl?: string;
  buttonText?: string;
}): {
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
} {
  const buttons = resolveBroadcastLinkButtons(value);
  const primaryButton = buttons[0];

  return {
    buttons,
    buttonEnabled: buttons.length > 0,
    buttonUrl: primaryButton?.url ?? '',
    buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
  };
}

export const sendBroadcastRequestSchema = z
  .object({
    text: z
      .string()
      .max(2_000, 'Текст автопостинга слишком длинный. Максимум 2000 символов.')
      .default(''),
    textFormat: broadcastTextFormatSchema.default('plain'),
    targetMode: broadcastTargetModeSchema.optional(),
    targetChatIds: z.array(z.string().trim().min(1)).default([]),
    applyToAllChats: z.boolean().default(false),
    buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
    buttonEnabled: z.boolean().default(false),
    buttonUrl: botButtonUrlSchema,
    buttonText: botButtonTextSchema,
    imageEnabled: z.boolean().default(false),
    imageBase64: z.string().trim().max(MAX_BROADCAST_IMAGE_BASE64_LENGTH).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
    images: z.array(broadcastImageSchema).max(MAX_BROADCAST_IMAGES).default([]),
    mediaType: broadcastMediaTypeSchema.nullable().default(null),
    mediaPayload: z.record(z.string(), z.unknown()).nullable().default(null),
    mediaMimeType: z.string().trim().max(128).default(''),
    mediaFileName: z.string().trim().max(128).default(''),
    scheduleMode: broadcastScheduleModeSchema.default('legacy'),
    scheduleTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
    scheduledSlots: z.array(z.string().datetime()).max(MAX_BROADCAST_CALENDAR_SLOTS).default([]),
    replaceConflictingSlots: z.boolean().default(false),
    sendAt: z.string().datetime().nullable().default(null),
    cycleEnabled: z.boolean().default(false),
    cycleEveryHours: z
      .number()
      .int()
      .min(1)
      .max(14 * 24)
      .optional(),
    cycleEveryDays: z.number().int().min(1).max(14).optional(),
    cycleCount: z.number().int().min(1).max(100).default(1),
  })
  .superRefine((value, ctx) => {
    addBroadcastAudienceIssues(value, ctx);

    const images = normalizeBroadcastImages(value);
    const hasImages = images.length > 0;
    const hasVideoPayload =
      value.mediaType === 'video' &&
      value.mediaPayload !== null &&
      Object.keys(value.mediaPayload).length > 0;
    const hasImagePayload =
      value.mediaType === 'image' &&
      value.mediaPayload !== null &&
      readBroadcastMediaPayloadImages(value.mediaPayload).length > 0;
    const hasMediaPayload =
      hasVideoPayload || hasImagePayload || (value.mediaType === 'image' && hasImages);

    if (value.text.trim().length === 0 && !hasImages && !hasVideoPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Введите текст, добавьте фото или видео.',
      });
    }

    if (hasImages && hasVideoPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaType'],
        message: 'В одном автопостинге можно добавить либо фото, либо видео.',
      });
    }

    if ((value.mediaType && !hasMediaPayload) || (!value.mediaType && value.mediaPayload)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaPayload'],
        message: 'Медиа автопостинга не загружено.',
      });
    }

    addBroadcastButtonIssues(value, ctx);

    if (value.imageEnabled && !hasImages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageBase64'],
        message: 'Добавьте фото для автопостинга.',
      });
    }

    images.forEach((image, index) => {
      if (!image.base64.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['images', index, 'base64'],
          message: 'Добавьте фото.',
        });
      }

      if (!image.mimeType.trim() || !image.mimeType.toLowerCase().startsWith('image/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['images', index, 'mimeType'],
          message: 'Неверный формат фото.',
        });
      }
    });

    if (getBroadcastImagesTotalBase64Length(images) > MAX_BROADCAST_IMAGES_TOTAL_BASE64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['images'],
        message: 'Суммарный размер фото слишком большой.',
      });
    }

    addBroadcastScheduleIssues(value, ctx);
  })
  .transform((value) => {
    const audienceState = buildBroadcastAudienceState(value);
    const buttonState = buildBroadcastButtonState(value);
    const scheduleState = buildBroadcastScheduleState(value);
    const images = normalizeBroadcastImages(value);
    const hasVideoPayload =
      value.mediaType === 'video' &&
      value.mediaPayload !== null &&
      Object.keys(value.mediaPayload).length > 0;
    const hasImageGallery = !hasVideoPayload && images.length > 1;
    const firstImage = !hasVideoPayload ? images[0] : undefined;

    return {
      ...value,
      targetMode: audienceState.targetMode,
      targetChatIds: audienceState.targetChatIds,
      applyToAllChats: audienceState.applyToAllChats,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      imageEnabled: Boolean(firstImage),
      imageBase64: firstImage?.base64 ?? '',
      imageMimeType: firstImage?.mimeType ?? '',
      imageFileName: firstImage?.fileName ?? '',
      images: hasVideoPayload ? [] : images,
      mediaType: hasVideoPayload ? 'video' : hasImageGallery ? 'image' : null,
      mediaPayload: hasVideoPayload ? value.mediaPayload : hasImageGallery ? { images } : null,
      mediaMimeType: hasVideoPayload ? value.mediaMimeType.trim() : '',
      mediaFileName: hasVideoPayload ? value.mediaFileName.trim() : '',
      cycleEveryHours: scheduleState.cycleEveryHours,
      scheduledSlots: scheduleState.scheduledSlots,
    };
  });
export type SendBroadcastRequest = z.infer<typeof sendBroadcastRequestSchema>;

export const broadcastHandoffRequestSchema = z
  .object({
    targetMode: broadcastTargetModeSchema.optional(),
    targetChatIds: z.array(z.string().trim().min(1)).default([]),
    applyToAllChats: z.boolean().default(false),
    buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
    buttonEnabled: z.boolean().default(false),
    buttonUrl: botButtonUrlSchema,
    buttonText: botButtonTextSchema,
    scheduleMode: broadcastScheduleModeSchema.default('legacy'),
    scheduleTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
    scheduledSlots: z.array(z.string().datetime()).max(MAX_BROADCAST_CALENDAR_SLOTS).default([]),
    sendAt: z.string().datetime().nullable().default(null),
    cycleEnabled: z.boolean().default(false),
    cycleEveryHours: z
      .number()
      .int()
      .min(1)
      .max(14 * 24)
      .optional(),
    cycleEveryDays: z.number().int().min(1).max(14).optional(),
    cycleCount: z.number().int().min(1).max(100).default(1),
  })
  .superRefine((value, ctx) => {
    addBroadcastAudienceIssues(value, ctx);
    addBroadcastButtonIssues(value, ctx);
    addBroadcastScheduleIssues(value, ctx);
  })
  .transform((value) => {
    const audienceState = buildBroadcastAudienceState(value);
    const buttonState = buildBroadcastButtonState(value);
    const scheduleState = buildBroadcastScheduleState(value);

    return {
      ...value,
      targetMode: audienceState.targetMode,
      targetChatIds: audienceState.targetChatIds,
      applyToAllChats: audienceState.applyToAllChats,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      cycleEveryHours: scheduleState.cycleEveryHours,
      scheduledSlots: scheduleState.scheduledSlots,
    };
  });
export type BroadcastHandoffRequest = z.infer<typeof broadcastHandoffRequestSchema>;

export const broadcastHandoffResponseSchema = z.object({
  botUrl: z.string().url(),
});
export type BroadcastHandoffResponse = z.infer<typeof broadcastHandoffResponseSchema>;

export const profileMentionHandoffRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(128),
});
export type ProfileMentionHandoffRequest = z.infer<typeof profileMentionHandoffRequestSchema>;

export const broadcastHandoffStateSchema = z.object({
  targetMode: broadcastTargetModeSchema.default('current'),
  targetChatIds: z.array(z.string().trim().min(1)).default([]),
  applyToAllChats: z.boolean(),
  buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
  buttonEnabled: z.boolean(),
  buttonUrl: botButtonUrlSchema,
  buttonText: botButtonTextSchema,
  scheduleMode: broadcastScheduleModeSchema.default('legacy'),
  scheduleTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
  scheduledSlots: z.array(z.string().datetime()).default([]),
  sendAt: z.string().datetime().nullable().default(null),
  cycleEnabled: z.boolean(),
  cycleEveryHours: z.number().int().min(1),
  cycleCount: z.number().int().min(1),
  hasContent: z.boolean().default(false),
});
export type BroadcastHandoffState = z.infer<typeof broadcastHandoffStateSchema>;

export const managedBroadcastTargetPreviewSchema = z.object({
  id: z.string(),
  title: z.string(),
  entityType: managedEntityTypeSchema.default('chat'),
  link: z.string().trim().max(2048).nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional().default(null),
});
export type ManagedBroadcastTargetPreview = z.infer<typeof managedBroadcastTargetPreviewSchema>;

export const sendBroadcastResultSchema = z.object({
  sourceChatId: z.string(),
  targetChats: z.number().int().min(1),
  sentChats: z.number().int().min(0),
  failedChats: z.number().int().min(0),
  sentChatIds: z.array(z.string()),
  failedChatIds: z.array(z.string()),
  sentChatPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
  failedChatPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
  sentChatOverflowCount: z.number().int().min(0).default(0),
  failedChatOverflowCount: z.number().int().min(0).default(0),
  scheduleMode: broadcastScheduleModeSchema.default('legacy'),
  scheduleTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
  scheduledSlots: z.array(z.string().datetime()).default([]),
  sendAt: z.string().datetime().nullable(),
  nextSendAt: z.string().datetime().nullable().default(null),
  cycleEnabled: z.boolean(),
  cycleEveryHours: z.number().int().min(1),
  cycleEveryDays: z.number().int().min(1).optional(),
  cycleCount: z.number().int().min(1),
  scheduleId: z.string().nullable().default(null),
  scheduledOccurrences: z.number().int().min(0).default(0),
});
export type SendBroadcastResult = z.infer<typeof sendBroadcastResultSchema>;

export const sendBroadcastTestResultSchema = z.object({
  delivered: z.boolean(),
  messageId: z.string().nullable(),
  chatId: z.string().nullable(),
  url: z.string().url().nullable(),
});
export type SendBroadcastTestResult = z.infer<typeof sendBroadcastTestResultSchema>;

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

export const managedBroadcastSummarySchema = z.object({
  id: z.string(),
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
  scheduleTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
  scheduledSlots: z.array(z.string().datetime()).default([]),
  nextSendAt: z.string().datetime().nullable(),
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
});
export type ManagedBroadcastSummary = z.infer<typeof managedBroadcastSummarySchema>;

export const managedBroadcastDetailsSchema = z.object({
  id: z.string(),
  status: managedBroadcastStatusSchema,
  text: z.string(),
  textFormat: broadcastTextFormatSchema,
  targetMode: broadcastTargetModeSchema.default('current'),
  applyToAllChats: z.boolean(),
  targetChatIds: z.array(z.string()),
  targetPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
  targetOverflowCount: z.number().int().min(0).default(0),
  buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
  buttonEnabled: z.boolean(),
  buttonUrl: botButtonUrlSchema,
  buttonText: botButtonTextSchema,
  imageEnabled: z.boolean(),
  imageBase64: z.string(),
  imageMimeType: z.string(),
  imageFileName: z.string(),
  images: z.array(broadcastImageSchema).max(MAX_BROADCAST_IMAGES).default([]),
  mediaType: broadcastMediaTypeSchema.nullable().default(null),
  mediaPayload: z.record(z.string(), z.unknown()).nullable().default(null),
  mediaMimeType: z.string().default(''),
  mediaFileName: z.string().default(''),
  scheduleMode: broadcastScheduleModeSchema.default('legacy'),
  scheduleTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
  scheduledSlots: z.array(z.string().datetime()).default([]),
  nextSendAt: z.string().datetime().nullable(),
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
});
export type ManagedBroadcastDetails = z.infer<typeof managedBroadcastDetailsSchema>;

export const managedBroadcastCalendarSlotSchema = z.object({
  broadcastId: z.string(),
  sourceChatId: z.string(),
  scheduledAt: z.string().datetime(),
  status: managedBroadcastStatusSchema,
  textPreview: z.string(),
  targetMode: broadcastTargetModeSchema.default('current'),
  targetChatIds: z.array(z.string()).default([]),
  targetChats: z.number().int().min(1),
  targetPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
  targetOverflowCount: z.number().int().min(0).default(0),
  overlapChatIds: z.array(z.string()).default([]),
  overlapPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
  overlapOverflowCount: z.number().int().min(0).default(0),
  hasTargetOverlap: z.boolean().default(false),
});
export type ManagedBroadcastCalendarSlot = z.infer<typeof managedBroadcastCalendarSlotSchema>;

export const managedBroadcastCalendarResponseSchema = z.object({
  sourceChatId: z.string(),
  entityType: managedEntityTypeSchema,
  from: z.string().datetime(),
  to: z.string().datetime(),
  targetChatIds: z.array(z.string()).default([]),
  slots: z.array(managedBroadcastCalendarSlotSchema).default([]),
});
export type ManagedBroadcastCalendarResponse = z.infer<
  typeof managedBroadcastCalendarResponseSchema
>;

export const vkParsingSourceStatusSchema = z.enum(['ACTIVE', 'DISABLED']);
export type VkParsingSourceStatus = z.infer<typeof vkParsingSourceStatusSchema>;

export const vkParsingSourceSyncStatusSchema = z.enum([
  'IDLE',
  'QUEUED',
  'SYNCING',
  'BACKOFF',
  'ERROR',
]);
export type VkParsingSourceSyncStatus = z.infer<typeof vkParsingSourceSyncStatusSchema>;

export const vkParsingPostStatusSchema = z.enum([
  'NEW',
  'PUBLISHED',
  'FAILED',
  'CHANGED_AFTER_PUBLISH',
  'UNAVAILABLE',
  'SKIPPED',
]);
export type VkParsingPostStatus = z.infer<typeof vkParsingPostStatusSchema>;

export const vkParsingPublishModeSchema = z.enum(['IMMEDIATE', 'QUEUE', 'REVIEW']);
export type VkParsingPublishMode = z.infer<typeof vkParsingPublishModeSchema>;

export const vkParsingSourcePrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH']);
export type VkParsingSourcePriority = z.infer<typeof vkParsingSourcePrioritySchema>;

export const vkParsingBulkPresetSchema = z.enum(['NEWS', 'SLOW', 'REVIEW', 'CLEAN']);
export type VkParsingBulkPreset = z.infer<typeof vkParsingBulkPresetSchema>;

export const vkParsingPostSkipReasonSchema = z.enum([
  'AD',
  'EMPTY_AFTER_LINK_FILTER',
  'NO_SUPPORTED_CONTENT',
]);
export type VkParsingPostSkipReason = z.infer<typeof vkParsingPostSkipReasonSchema>;

export const vkParsingPostFilterStatusSchema = z.union([
  z.literal('ALL'),
  z.literal('QUEUED'),
  vkParsingPostStatusSchema,
]);
export type VkParsingPostFilterStatus = z.infer<typeof vkParsingPostFilterStatusSchema>;

export const vkParsingTimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);

export const vkParsingUnsupportedAttachmentSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().default(''),
    title: z.string().nullable().default(null),
    url: z.string().url().nullable().default(null),
    count: z.number().int().min(1).default(1),
    reason: z.string().nullable().default(null),
  })
  .passthrough();
export type VkParsingUnsupportedAttachment = z.infer<typeof vkParsingUnsupportedAttachmentSchema>;

export const vkParsingSettingsSchema = z.object({
  chatId: z.string(),
  autoPublishEnabled: z.boolean().default(false),
  autoPublishEnabledAt: z.string().datetime().nullable().default(null),
  autoPublishKillSwitchEnabled: z.boolean().default(false),
  stripLinksEnabled: z.boolean().default(false),
  skipAdsEnabled: z.boolean().default(false),
  schedulerTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
  quietHoursStart: vkParsingTimeOfDaySchema.nullable().default(null),
  quietHoursEnd: vkParsingTimeOfDaySchema.nullable().default(null),
  workHoursStart: vkParsingTimeOfDaySchema.default('09:00'),
  workHoursEnd: vkParsingTimeOfDaySchema.default('22:00'),
  distributeEvenlyEnabled: z.boolean().default(true),
  roundRobinEnabled: z.boolean().default(true),
  circuitBreakerEnabled: z.boolean().default(true),
  circuitBreakerWindowMinutes: z.number().int().min(1).max(1440).default(10),
  circuitBreakerPostLimit: z.number().int().min(1).max(500).default(10),
  updatedAt: z.string().datetime().nullable().default(null),
});
export type VkParsingSettings = z.infer<typeof vkParsingSettingsSchema>;

export const vkParsingSourceSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  ownerId: z.number().int(),
  wallOwnerId: z.number().int(),
  screenName: z.string(),
  title: z.string(),
  url: z.string().url(),
  status: vkParsingSourceStatusSchema,
  importEnabled: z.boolean().default(true),
  autoPublishEnabled: z.boolean().default(false),
  autoPublishEnabledAt: z.string().datetime().nullable().default(null),
  autoPublishPausedAt: z.string().datetime().nullable().default(null),
  autoPublishPausedReason: z.string().nullable().default(null),
  publishIntervalMinutes: z.number().int().min(5).max(10080).default(60),
  dailyLimit: z.number().int().min(1).max(500).default(3),
  minPublishIntervalMinutes: z.number().int().min(0).max(1440).default(30),
  publishMode: vkParsingPublishModeSchema.default('QUEUE'),
  priority: vkParsingSourcePrioritySchema.default('NORMAL'),
  quietHoursStart: vkParsingTimeOfDaySchema.nullable().default(null),
  quietHoursEnd: vkParsingTimeOfDaySchema.nullable().default(null),
  lastAutoPublishedAt: z.string().datetime().nullable().default(null),
  newPostCount: z.number().int().min(0).default(0),
  queuedPostCount: z.number().int().min(0).default(0),
  publishedPostCount: z.number().int().min(0).default(0),
  skippedPostCount: z.number().int().min(0).default(0),
  failedPostCount: z.number().int().min(0).default(0),
  syncStatus: vkParsingSourceSyncStatusSchema.default('IDLE'),
  nextSyncAt: z.string().datetime().nullable().default(null),
  nextRetryAt: z.string().datetime().nullable().default(null),
  lastSyncAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable().default(null),
  syncStartedAt: z.string().datetime().nullable().default(null),
  consecutiveFailures: z.number().int().min(0).default(0),
  terminalFailureCount: z.number().int().min(0).default(0),
  circuitOpenedAt: z.string().datetime().nullable().default(null),
  circuitReasonCode: z.string().nullable().default(null),
  circuitReason: z.string().nullable().default(null),
  circuitRetryAt: z.string().datetime().nullable().default(null),
  lastErrorCode: z.string().nullable().default(null),
  lastImportedCount: z.number().int().min(0).default(0),
  lastFetchedCount: z.number().int().min(0).default(0),
  lastFetchedPages: z.number().int().min(0).default(0),
  lastFetchedOffsets: z.array(z.number().int().min(0)).default([]),
  lastVkNewestPostId: z.number().int().nullable().default(null),
  lastVkNewestPublishedAt: z.string().datetime().nullable().default(null),
  adaptiveIntervalMs: z.number().int().min(0).nullable().default(null),
  lastSyncDurationMs: z.number().int().min(0).nullable().default(null),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VkParsingSource = z.infer<typeof vkParsingSourceSchema>;

export const vkParsingPostSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  chatId: z.string(),
  sourceTitle: z.string(),
  sourceUrl: z.string().url(),
  vkOwnerId: z.number().int(),
  vkPostId: z.number().int(),
  vkPublishedAt: z.string().datetime().nullable(),
  text: z.string(),
  url: z.string().url(),
  photoUrls: z.array(z.string().url()).max(VK_PARSING_MAX_PHOTOS).default([]),
  linkUrls: z.array(z.string().url()).max(VK_PARSING_MAX_LINKS).default([]),
  attachmentTypes: z.array(z.string()).default([]),
  unsupportedAttachments: z.array(vkParsingUnsupportedAttachmentSchema).default([]),
  hasUnsupportedAttachments: z.boolean().default(false),
  isAdvertising: z.boolean().default(false),
  advertisingMarkers: z.array(z.string()).default([]),
  status: vkParsingPostStatusSchema,
  contentHash: z.string().default(''),
  publishedContentHash: z.string().nullable().default(null),
  publishedMessageId: z.string().nullable(),
  publishedUrl: z.string().url().nullable(),
  publishedAtMax: z.string().datetime().nullable(),
  autoPublishedAt: z.string().datetime().nullable().default(null),
  autoPublishError: z.string().nullable().default(null),
  skippedAt: z.string().datetime().nullable().default(null),
  skipReason: vkParsingPostSkipReasonSchema.nullable().default(null),
  lastSeenAt: z.string().datetime().nullable().default(null),
  missingSinceAt: z.string().datetime().nullable().default(null),
  missingSeenCount: z.number().int().min(0).default(0),
  lastAvailabilityCheckedAt: z.string().datetime().nullable().default(null),
  unavailableAt: z.string().datetime().nullable().default(null),
  publishQueuedAt: z.string().datetime().nullable().default(null),
  publishScheduledAt: z.string().datetime().nullable().default(null),
  publishCancelledAt: z.string().datetime().nullable().default(null),
  publishCancelledByUserId: z.string().nullable().default(null),
  publishLockedAt: z.string().datetime().nullable().default(null),
  publishAttemptCount: z.number().int().min(0).default(0),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VkParsingPost = z.infer<typeof vkParsingPostSchema>;

export const vkParsingCapabilitySchema = z.object({
  enabled: z.boolean().default(false),
  canUse: z.boolean().default(false),
  reasonCode: z.enum(['NOT_CONFIGURED', 'ACCESS_DENIED', 'NOT_FOUND']).nullable().default(null),
  reason: z.string().nullable().default(null),
});
export type VkParsingCapability = z.infer<typeof vkParsingCapabilitySchema>;

export const vkParsingFeedPaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  total: z.number().int().min(0).default(0),
  hasMore: z.boolean().default(false),
  nextOffset: z.number().int().min(0).nullable().default(null),
});
export type VkParsingFeedPagination = z.infer<typeof vkParsingFeedPaginationSchema>;

export const vkParsingHealthSummarySchema = z.object({
  chatId: z.string(),
  generatedAt: z.string().datetime(),
  vkApiRps: z.number().min(0).default(0),
  vkApiErrorRate: z.number().min(0).max(1).default(0),
  sourceCount: z.number().int().min(0).default(0),
  staleSourceCount: z.number().int().min(0).default(0),
  importLagSeconds: z.number().int().min(0).nullable().default(null),
  publishLagSeconds: z.number().int().min(0).nullable().default(null),
  publishBacklogAgeSeconds: z.number().int().min(0).nullable().default(null),
  publishBacklog: z.number().int().min(0).default(0),
  staleSyncLockCount: z.number().int().min(0).default(0),
  circuitOpenSourceCount: z.number().int().min(0).default(0),
  importSuccessRate: z.number().min(0).max(1).default(1),
  p95SyncDurationMs: z.number().int().min(0).nullable().default(null),
  mediaFailureRatio: z.number().min(0).max(1).default(0),
  recentErrors: z
    .array(
      z.object({
        code: z.string(),
        count: z.number().int().min(0),
      }),
    )
    .default([]),
});
export type VkParsingHealthSummary = z.infer<typeof vkParsingHealthSummarySchema>;

export const vkParsingFeedSchema = z.object({
  capabilities: vkParsingCapabilitySchema.default({
    enabled: false,
    canUse: false,
    reasonCode: null,
    reason: null,
  }),
  settings: vkParsingSettingsSchema.default({
    chatId: '',
    autoPublishEnabled: false,
    autoPublishEnabledAt: null,
    autoPublishKillSwitchEnabled: false,
    stripLinksEnabled: false,
    skipAdsEnabled: false,
    schedulerTimezone: 'Europe/Moscow',
    quietHoursStart: null,
    quietHoursEnd: null,
    workHoursStart: '09:00',
    workHoursEnd: '22:00',
    distributeEvenlyEnabled: true,
    roundRobinEnabled: true,
    circuitBreakerEnabled: true,
    circuitBreakerWindowMinutes: 10,
    circuitBreakerPostLimit: 10,
    updatedAt: null,
  }),
  sources: z.array(vkParsingSourceSchema).default([]),
  posts: z.array(vkParsingPostSchema).default([]),
  queue: z.array(vkParsingPostSchema).default([]),
  auditEvents: z
    .array(
      z.object({
        id: z.string(),
        action: z.string(),
        actorUserId: z.string(),
        payload: z.record(z.string(), z.unknown()).default({}),
        createdAt: z.string().datetime(),
      }),
    )
    .default([]),
  pagination: vkParsingFeedPaginationSchema.default({
    limit: 50,
    offset: 0,
    total: 0,
    hasMore: false,
    nextOffset: null,
  }),
  summary: vkParsingHealthSummarySchema.nullable().default(null),
});
export type VkParsingFeed = z.infer<typeof vkParsingFeedSchema>;

export const vkParsingFeedQuerySchema = z.object({
  status: vkParsingPostFilterStatusSchema.default('ALL'),
  sourceId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type VkParsingFeedQuery = z.infer<typeof vkParsingFeedQuerySchema>;

export const updateVkParsingSettingsRequestSchema = z
  .object({
    autoPublishEnabled: z.boolean().optional(),
    autoPublishKillSwitchEnabled: z.boolean().optional(),
    stripLinksEnabled: z.boolean().optional(),
    skipAdsEnabled: z.boolean().optional(),
    schedulerTimezone: z.string().trim().min(1).max(64).optional(),
    quietHoursStart: vkParsingTimeOfDaySchema.nullable().optional(),
    quietHoursEnd: vkParsingTimeOfDaySchema.nullable().optional(),
    workHoursStart: vkParsingTimeOfDaySchema.optional(),
    workHoursEnd: vkParsingTimeOfDaySchema.optional(),
    distributeEvenlyEnabled: z.boolean().optional(),
    roundRobinEnabled: z.boolean().optional(),
    circuitBreakerEnabled: z.boolean().optional(),
    circuitBreakerWindowMinutes: z.number().int().min(1).max(1440).optional(),
    circuitBreakerPostLimit: z.number().int().min(1).max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Передайте хотя бы одну настройку.',
  });
export type UpdateVkParsingSettingsRequest = z.infer<typeof updateVkParsingSettingsRequestSchema>;

export const updateVkParsingSourceRequestSchema = z
  .object({
    importEnabled: z.boolean().optional(),
    autoPublishEnabled: z.boolean().optional(),
    publishIntervalMinutes: z.number().int().min(5).max(10080).optional(),
    dailyLimit: z.number().int().min(1).max(500).optional(),
    minPublishIntervalMinutes: z.number().int().min(0).max(1440).optional(),
    publishMode: vkParsingPublishModeSchema.optional(),
    priority: vkParsingSourcePrioritySchema.optional(),
    quietHoursStart: vkParsingTimeOfDaySchema.nullable().optional(),
    quietHoursEnd: vkParsingTimeOfDaySchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Передайте хотя бы одну настройку.',
  });
export type UpdateVkParsingSourceRequest = z.infer<typeof updateVkParsingSourceRequestSchema>;

export const bulkUpdateVkParsingSourcesRequestSchema = z.object({
  sourceIds: z.array(z.string().min(1)).min(1).max(50),
  preset: vkParsingBulkPresetSchema,
});
export type BulkUpdateVkParsingSourcesRequest = z.infer<
  typeof bulkUpdateVkParsingSourcesRequestSchema
>;

export const addVkParsingSourceRequestSchema = z.object({
  url: z.string().trim().min(2).max(512),
});
export type AddVkParsingSourceRequest = z.infer<typeof addVkParsingSourceRequestSchema>;

export const publishVkParsingPostRequestSchema = z
  .object({
    text: z.string().max(VK_PARSING_MAX_PUBLISH_TEXT_LENGTH).default(''),
    photoUrls: z.array(z.string().url()).max(VK_PARSING_MAX_PHOTOS).default([]),
    linkUrls: z.array(z.string().url()).max(VK_PARSING_MAX_LINKS).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      value.text.trim().length === 0 &&
      value.photoUrls.length === 0 &&
      value.linkUrls.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Добавьте текст, фото или ссылку.',
      });
    }
  });
export type PublishVkParsingPostRequest = z.infer<typeof publishVkParsingPostRequestSchema>;

export const scheduleVkParsingPostRequestSchema = z.object({
  scheduledAt: z.string().datetime(),
});
export type ScheduleVkParsingPostRequest = z.infer<typeof scheduleVkParsingPostRequestSchema>;

export const vkParsingDryRunResultSchema = z.object({
  chatId: z.string(),
  sourceId: z.string().nullable().default(null),
  generatedAt: z.string().datetime(),
  globalEnabled: z.boolean().default(false),
  killSwitchEnabled: z.boolean().default(false),
  baselineAt: z.string().datetime().nullable().default(null),
  eligibleNow: z.number().int().min(0).default(0),
  latestImportedVkPublishedAt: z.string().datetime().nullable().default(null),
  sourcesWithoutSuccessfulSync: z.number().int().min(0).default(0),
});
export type VkParsingDryRunResult = z.infer<typeof vkParsingDryRunResultSchema>;

export const rollbackVkParsingRequestSchema = z.object({
  since: z.string().datetime(),
  until: z.string().datetime(),
  sourceId: z.string().trim().min(1).optional(),
  deleteMessages: z.boolean().default(false),
});
export type RollbackVkParsingRequest = z.infer<typeof rollbackVkParsingRequestSchema>;

export const rollbackVkParsingResultSchema = z.object({
  matched: z.number().int().min(0).default(0),
  deleted: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  posts: z.array(vkParsingPostSchema).default([]),
});
export type RollbackVkParsingResult = z.infer<typeof rollbackVkParsingResultSchema>;

export const vkParsingRefreshResultSchema = vkParsingFeedSchema.extend({
  imported: z.number().int().min(0).default(0),
  queued: z.number().int().min(0).default(0),
});
export type VkParsingRefreshResult = z.infer<typeof vkParsingRefreshResultSchema>;

export const publishVkParsingPostResultSchema = z.object({
  post: vkParsingPostSchema,
  messageId: z.string(),
  url: z.string().url().nullable(),
});
export type PublishVkParsingPostResult = z.infer<typeof publishVkParsingPostResultSchema>;

export const retryVkParsingPostResultSchema = z.object({
  post: vkParsingPostSchema,
  queued: z.number().int().min(0).default(0),
});
export type RetryVkParsingPostResult = z.infer<typeof retryVkParsingPostResultSchema>;

export const chatSettingsScreenResponseSchema = z.object({
  settings: chatSettingsSchema,
  rules: chatRulesSchema,
  header: managedEntityHeaderSchema,
  requiredSubscriptionChannels: z.array(managedEntityHeaderSchema).default([]),
  domains: z.array(domainAllowlistEntrySchema),
  managedBroadcasts: z.array(managedBroadcastSummarySchema).default([]),
});
export type ChatSettingsScreenResponse = z.infer<typeof chatSettingsScreenResponseSchema>;

export const channelSettingsScreenResponseSchema = z.object({
  settings: channelSettingsSchema,
  header: managedEntityHeaderSchema,
  managedBroadcasts: z.array(managedBroadcastSummarySchema),
});
export type ChannelSettingsScreenResponse = z.infer<typeof channelSettingsScreenResponseSchema>;

export const maxMessagePayloadSchema = z.object({
  messageId: z.string(),
  chatId: z.string(),
  chatTitle: z.string().optional(),
  entityType: z.enum(['chat', 'channel']).optional(),
  senderId: z.string(),
  senderName: z.string().optional(),
  text: z.string().default(''),
  createdAt: z.string().datetime(),
});

export const maxMembershipChangeSchema = z.object({
  action: z.enum(['added', 'removed']),
  memberUserIds: z.array(z.string()).min(1),
  inviterId: z.string().optional(),
});

export const maxUpdateSchema = z.object({
  updateId: z.string(),
  botId: z.string().optional(),
  type: z.string(),
  message: maxMessagePayloadSchema.optional(),
  membership: maxMembershipChangeSchema.optional(),
  raw: z.record(z.string(), z.any()).optional(),
});

export type MaxUpdate = z.infer<typeof maxUpdateSchema>;
