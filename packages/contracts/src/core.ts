import { z } from 'zod';
export * from './bot-speech.js';
import { botSpeechPersonaSchema, botSpeechStyleSchema } from './bot-speech.js';
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
export const managedEntityTypeSchema = z.enum(['chat', 'channel']);
export const managedEntityBotRoleSchema = z.enum(['primary', 'standby']);
export const managedEntityBotMembershipStatusSchema = z.enum(['active', 'removed']);
export const managedEntityBotLifecycleStateSchema = z.enum([
  'active',
  'dormant',
  'draining',
  'disabled',
]);
export const managedEntityBotCapabilitySchema = z.enum([
  'background_scans',
  'channel_stats',
  'suggestion_delivery',
  'membership_prewarm',
  'access_prewarm',
]);
export const managedEntitySharedModeSchema = z.enum([
  'owned',
  'shared-standby',
  'shared-assist',
  'shared-failover',
]);
export const managedEntityFavoriteTypeSchema = z.enum([
  'important',
  'watch',
  'broadcast',
  'test',
  'partner',
  'service',
]);
export const applySettingsSectionSchema = z.enum([
  'links',
  'greeting',
  'profanityFilter',
  'commercialFilter',
  'thematicFilters',
  'duplicates',
  'limits',
  'phones',
  'night',
  'requiredSubscription',
  'invitationAccess',
  'extra',
]);
export const channelAutoPostButtonsModeSchema = z.enum(['OFF', 'COMMENTS', 'SUGGEST', 'BOTH']);
export const channelSuggestionEntryModeSchema = z.enum(['BOT', 'MINIAPP']);
export const managedPollStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'CLOSED']);
export const managedGiveawayStatusSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'DRAWING',
  'COMPLETED',
  'CANCELED',
]);
export const giveawayEligibilityStateSchema = z.enum(['PENDING', 'VERIFIED', 'REJECTED']);
export const managedGiveawayWinnerStatusSchema = z.enum([
  'SELECTED',
  'CLAIMED',
  'DELIVERED',
  'EXPIRED',
  'REROLLED',
]);
export const broadcastTextFormatSchema = z.enum(['plain', 'markdown']);
export const broadcastTargetModeSchema = z.enum(['current', 'selected', 'all']);
export const broadcastMediaTypeSchema = z.enum(['image', 'video']);
export type ManagedEntityType = z.infer<typeof managedEntityTypeSchema>;
export type ManagedEntityBotRole = z.infer<typeof managedEntityBotRoleSchema>;
export type ManagedEntityBotMembershipStatus = z.infer<
  typeof managedEntityBotMembershipStatusSchema
>;
export type ManagedEntityBotLifecycleState = z.infer<typeof managedEntityBotLifecycleStateSchema>;
export type ManagedEntityBotCapability = z.infer<typeof managedEntityBotCapabilitySchema>;
export type ManagedEntitySharedMode = z.infer<typeof managedEntitySharedModeSchema>;
export type ManagedEntityFavoriteType = z.infer<typeof managedEntityFavoriteTypeSchema>;
export type ApplySettingsSection = z.infer<typeof applySettingsSectionSchema>;
export type ChannelAutoPostButtonsMode = z.infer<typeof channelAutoPostButtonsModeSchema>;
export type ChannelSuggestionEntryMode = z.infer<typeof channelSuggestionEntryModeSchema>;
export type ManagedPollStatus = z.infer<typeof managedPollStatusSchema>;
export type ManagedGiveawayStatus = z.infer<typeof managedGiveawayStatusSchema>;
export type GiveawayEligibilityState = z.infer<typeof giveawayEligibilityStateSchema>;
export type ManagedGiveawayWinnerStatus = z.infer<typeof managedGiveawayWinnerStatusSchema>;
export type BroadcastTextFormat = z.infer<typeof broadcastTextFormatSchema>;
export type BroadcastTargetMode = z.infer<typeof broadcastTargetModeSchema>;
export type BroadcastMediaType = z.infer<typeof broadcastMediaTypeSchema>;

export const MANAGED_POLL_MIN_OPTIONS = 2;
export const MANAGED_POLL_MAX_OPTIONS = 6;
export const MANAGED_POLL_QUESTION_MAX_LENGTH = 280;
export const MANAGED_POLL_OPTION_MAX_LENGTH = 80;
export const MANAGED_GIVEAWAY_MAX_PRIZES = 10;
export const MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS = 10;
export const MANAGED_GIVEAWAY_TITLE_MAX_LENGTH = 120;
export const MANAGED_GIVEAWAY_DESCRIPTION_MAX_LENGTH = 2_000;
export const MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH = 120;
export const REQUIRED_SUBSCRIPTION_MAX_CHANNELS = 10;
export const REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN = 1;
export const REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX = 14;
export const REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT = 7;
export const INVITATION_ACCESS_REQUIRED_COUNT_MIN = 1;
export const INVITATION_ACCESS_REQUIRED_COUNT_MAX = 10;
export const MESSAGE_LIMITS_BLOCKED_WORDS_MAX = 999;
export const DEFAULT_BROADCAST_BUTTON_TEXT = 'Открыть';
export const MAX_BROADCAST_LINK_BUTTONS = 8;
export const MAX_BROADCAST_LINK_BUTTONS_PER_ROW = 3;
export const MAX_BROADCAST_IMAGES = 10;
export const MAX_BROADCAST_IMAGE_BASE64_LENGTH = 8_000_000;
export const MAX_BROADCAST_IMAGES_TOTAL_BASE64 = 24_000_000;
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
const messageLimitsBlockedWordSchema = z.string().trim().max(32);
const messageLimitsBlockedWordsSchema = z
  .array(messageLimitsBlockedWordSchema)
  .max(MESSAGE_LIMITS_BLOCKED_WORDS_MAX, `До ${MESSAGE_LIMITS_BLOCKED_WORDS_MAX} слов.`)
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
const managedGiveawayTitleSchema = z.string().trim().min(1).max(MANAGED_GIVEAWAY_TITLE_MAX_LENGTH);
const managedGiveawayDescriptionSchema = z
  .string()
  .trim()
  .max(MANAGED_GIVEAWAY_DESCRIPTION_MAX_LENGTH)
  .default('');
const managedGiveawayPrizeTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH);

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
    if (value.linkBotMessageEnabled && value.linkBotButtonEnabled && linkBotButtons.length > 0) {
      addStoredLinkButtonIssues(linkBotButtons, ctx, ['linkBotButtons']);
    } else if (
      value.linkBotMessageEnabled &&
      value.linkBotButtonEnabled &&
      linkBotButtons.length === 0 &&
      !isValidBotButtonUrl(value.linkBotButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkBotButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (value.linkBotMessageEnabled && value.linkBotButtonEnabled && linkBotButtons.length > 0) {
      // Validation already added above.
    } else if (
      value.linkBotMessageEnabled &&
      value.linkBotButtonEnabled &&
      linkBotButtons.length === 0 &&
      !isValidBotButtonText(value.linkBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }

    const greetingBotButtons = resolveStoredLinkButtons({
      buttons: value.greetingBotButtons,
      buttonUrl: value.greetingBotButtonUrl,
      buttonText: value.greetingBotButtonText,
    });
    if (
      value.greetingEnabled &&
      value.greetingBotMessageEnabled &&
      value.greetingBotButtonEnabled &&
      greetingBotButtons.length > 0
    ) {
      addStoredLinkButtonIssues(greetingBotButtons, ctx, ['greetingBotButtons']);
    } else if (
      value.greetingEnabled &&
      value.greetingBotMessageEnabled &&
      value.greetingBotButtonEnabled &&
      value.greetingBotButtons.length === 0 &&
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
      greetingBotButtons.length > 0
    ) {
      // Validation already added above.
    } else if (
      value.greetingEnabled &&
      value.greetingBotMessageEnabled &&
      value.greetingBotButtonEnabled &&
      value.greetingBotButtons.length === 0 &&
      !isValidBotButtonText(value.greetingBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['greetingBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }

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
    if (
      value.duplicateBotMessageEnabled &&
      value.duplicateBotButtonEnabled &&
      duplicateBotButtons.length > 0
    ) {
      addStoredLinkButtonIssues(duplicateBotButtons, ctx, ['duplicateBotButtons']);
    } else if (
      value.duplicateBotMessageEnabled &&
      value.duplicateBotButtonEnabled &&
      value.duplicateBotButtons.length === 0 &&
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
      duplicateBotButtons.length > 0
    ) {
      // Validation already added above.
    } else if (
      value.duplicateBotMessageEnabled &&
      value.duplicateBotButtonEnabled &&
      value.duplicateBotButtons.length === 0 &&
      !isValidBotButtonText(value.duplicateBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duplicateBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }

    const messageLimitsBotButtons = resolveStoredLinkButtons({
      buttons: value.messageLimitsBotButtons,
      buttonUrl: value.messageLimitsBotButtonUrl,
      buttonText: value.messageLimitsBotButtonText,
    });
    if (
      value.messageLimitsBotMessageEnabled &&
      value.messageLimitsBotButtonEnabled &&
      messageLimitsBotButtons.length > 0
    ) {
      addStoredLinkButtonIssues(messageLimitsBotButtons, ctx, ['messageLimitsBotButtons']);
    } else if (
      value.messageLimitsBotMessageEnabled &&
      value.messageLimitsBotButtonEnabled &&
      value.messageLimitsBotButtons.length === 0 &&
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
      messageLimitsBotButtons.length > 0
    ) {
      // Validation already added above.
    } else if (
      value.messageLimitsBotMessageEnabled &&
      value.messageLimitsBotButtonEnabled &&
      value.messageLimitsBotButtons.length === 0 &&
      !isValidBotButtonText(value.messageLimitsBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messageLimitsBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }

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

    const textFiltersBotButtons = resolveStoredLinkButtons({
      buttons: value.textFiltersBotButtons,
      buttonUrl: value.textFiltersBotButtonUrl,
      buttonText: value.textFiltersBotButtonText,
    });
    if (
      value.textFiltersBotMessageEnabled &&
      value.textFiltersBotButtonEnabled &&
      textFiltersBotButtons.length > 0
    ) {
      addStoredLinkButtonIssues(textFiltersBotButtons, ctx, ['textFiltersBotButtons']);
    } else if (
      value.textFiltersBotMessageEnabled &&
      value.textFiltersBotButtonEnabled &&
      value.textFiltersBotButtons.length === 0 &&
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
      textFiltersBotButtons.length > 0
    ) {
      // Validation already added above.
    } else if (
      value.textFiltersBotMessageEnabled &&
      value.textFiltersBotButtonEnabled &&
      value.textFiltersBotButtons.length === 0 &&
      !isValidBotButtonText(value.textFiltersBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['textFiltersBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }

    const thematicFiltersBotButtons = resolveStoredLinkButtons({
      buttons: value.thematicFiltersBotButtons,
      buttonUrl: value.thematicFiltersBotButtonUrl,
      buttonText: value.thematicFiltersBotButtonText,
    });
    if (
      value.thematicFiltersBotMessageEnabled &&
      value.thematicFiltersBotButtonEnabled &&
      thematicFiltersBotButtons.length > 0
    ) {
      addStoredLinkButtonIssues(thematicFiltersBotButtons, ctx, ['thematicFiltersBotButtons']);
    } else if (
      value.thematicFiltersBotMessageEnabled &&
      value.thematicFiltersBotButtonEnabled &&
      value.thematicFiltersBotButtons.length === 0 &&
      !isValidBotButtonUrl(value.thematicFiltersBotButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thematicFiltersBotButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (
      value.thematicFiltersBotMessageEnabled &&
      value.thematicFiltersBotButtonEnabled &&
      thematicFiltersBotButtons.length > 0
    ) {
      // Validation already added above.
    } else if (
      value.thematicFiltersBotMessageEnabled &&
      value.thematicFiltersBotButtonEnabled &&
      value.thematicFiltersBotButtons.length === 0 &&
      !isValidBotButtonText(value.thematicFiltersBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thematicFiltersBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }

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
    if (
      value.nightModeBotMessageEnabled &&
      value.nightModeBotButtonEnabled &&
      nightModeBotButtons.length > 0
    ) {
      addStoredLinkButtonIssues(nightModeBotButtons, ctx, ['nightModeBotButtons']);
    } else if (
      value.nightModeBotMessageEnabled &&
      value.nightModeBotButtonEnabled &&
      value.nightModeBotButtons.length === 0 &&
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
      nightModeBotButtons.length > 0
    ) {
      // Validation already added above.
    } else if (
      value.nightModeBotMessageEnabled &&
      value.nightModeBotButtonEnabled &&
      value.nightModeBotButtons.length === 0 &&
      !isValidBotButtonText(value.nightModeBotButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nightModeBotButtonText'],
        message: 'Введите название кнопки.',
      });
    }

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

export const managedGiveawayPrizeDraftSchema = z.object({
  position: z.number().int().min(1).max(MANAGED_GIVEAWAY_MAX_PRIZES),
  title: managedGiveawayPrizeTitleSchema,
});
export type ManagedGiveawayPrizeDraft = z.infer<typeof managedGiveawayPrizeDraftSchema>;

export const updateManagedGiveawayRequestSchema = z
  .object({
    title: managedGiveawayTitleSchema,
    description: managedGiveawayDescriptionSchema,
    imageEnabled: z.boolean().default(false),
    imageBase64: z.string().trim().max(MAX_BROADCAST_IMAGE_BASE64_LENGTH).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
    startsAt: z.string().datetime().nullable().default(null),
    endsAt: z.string().datetime(),
    claimHours: z.number().int().min(1).max(336).default(24),
    requiredChannelIds: z
      .array(z.string().trim().min(1).max(128))
      .max(MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS)
      .default([]),
    prizes: z.array(managedGiveawayPrizeDraftSchema).min(1).max(MANAGED_GIVEAWAY_MAX_PRIZES),
  })
  .superRefine((value, ctx) => {
    const startsAt = value.startsAt ? Date.parse(value.startsAt) : Date.now();
    const endsAt = Date.parse(value.endsAt);

    if (!Number.isFinite(endsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Укажите корректное время завершения.',
      });
    } else if (endsAt <= startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Завершение должно быть позже старта.',
      });
    }

    if (value.imageEnabled) {
      if (!value.imageBase64.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['imageBase64'],
          message: 'Добавьте изображение розыгрыша.',
        });
      }

      if (!value.imageMimeType.trim() || !value.imageMimeType.toLowerCase().startsWith('image/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['imageMimeType'],
          message: 'Поддерживаются только изображения.',
        });
      }
    }

    const positions = new Set<number>();
    const normalizedTitles = new Set<string>();
    for (const [index, prize] of value.prizes.entries()) {
      if (positions.has(prize.position)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prizes', index, 'position'],
          message: 'Позиции призов не должны повторяться.',
        });
      }
      positions.add(prize.position);

      const titleKey = prize.title.trim().replace(/\s+/gu, ' ').toLowerCase().replace(/ё/gu, 'е');
      if (normalizedTitles.has(titleKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prizes', index, 'title'],
          message: 'Названия призов не должны повторяться.',
        });
      }
      normalizedTitles.add(titleKey);
    }

    const normalizedRequiredChannels = new Set<string>();
    for (const [index, channelId] of value.requiredChannelIds.entries()) {
      const key = channelId.trim().toLowerCase().replace(/\s+/gu, '');
      if (normalizedRequiredChannels.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredChannelIds', index],
          message: 'Каналы не должны повторяться.',
        });
      }
      normalizedRequiredChannels.add(key);
    }
  });
export type UpdateManagedGiveawayRequest = z.infer<typeof updateManagedGiveawayRequestSchema>;

export const managedGiveawayPrizeSchema = z.object({
  id: z.string(),
  position: z.number().int().min(1),
  title: managedGiveawayPrizeTitleSchema,
});
export type ManagedGiveawayPrize = z.infer<typeof managedGiveawayPrizeSchema>;

export const managedGiveawayWinnerSchema = z.object({
  id: z.string(),
  prizeId: z.string(),
  prizePosition: z.number().int().min(1),
  prizeTitle: managedGiveawayPrizeTitleSchema,
  entryId: z.string(),
  userId: z.string(),
  displayName: z.string().nullable(),
  status: managedGiveawayWinnerStatusSchema,
  selectedAt: z.string().datetime(),
  claimDeadlineAt: z.string().datetime().nullable(),
  claimedAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  expiredAt: z.string().datetime().nullable(),
  rerolledAt: z.string().datetime().nullable(),
});
export type ManagedGiveawayWinner = z.infer<typeof managedGiveawayWinnerSchema>;

export const managedGiveawaySummarySchema = z.object({
  id: z.string(),
  title: managedGiveawayTitleSchema,
  status: managedGiveawayStatusSchema,
  hasImage: z.boolean(),
  entriesCount: z.number().int().min(0),
  verifiedEntriesCount: z.number().int().min(0),
  pendingEntriesCount: z.number().int().min(0),
  winnersCount: z.number().int().min(0),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  publicationUrl: z.string().nullable(),
  resultsUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ManagedGiveawaySummary = z.infer<typeof managedGiveawaySummarySchema>;

export const managedGiveawayDetailsSchema = managedGiveawaySummarySchema.extend({
  sourceChatId: z.string(),
  entityType: managedEntityTypeSchema,
  description: managedGiveawayDescriptionSchema,
  imageEnabled: z.boolean(),
  imageBase64: z.string(),
  imageMimeType: z.string(),
  imageFileName: z.string(),
  claimHours: z.number().int().min(1).max(336),
  requiredChannelIds: z.array(z.string()),
  publicationMessageId: z.string().nullable(),
  resultsMessageId: z.string().nullable(),
  prizes: z.array(managedGiveawayPrizeSchema),
  winners: z.array(managedGiveawayWinnerSchema),
});
export type ManagedGiveawayDetails = z.infer<typeof managedGiveawayDetailsSchema>;

export const managedGiveawayPublicChannelSchema = z.object({
  id: z.string(),
  title: z.string(),
  link: z.string().nullable(),
});
export type ManagedGiveawayPublicChannel = z.infer<typeof managedGiveawayPublicChannelSchema>;

export const managedGiveawayPublicWinnerSchema = z.object({
  prizePosition: z.number().int().min(1),
  prizeTitle: managedGiveawayPrizeTitleSchema,
  displayName: z.string().nullable(),
  status: managedGiveawayWinnerStatusSchema,
});
export type ManagedGiveawayPublicWinner = z.infer<typeof managedGiveawayPublicWinnerSchema>;

export const managedGiveawayPublicSchema = z.object({
  id: z.string(),
  sourceChatId: z.string(),
  sourceTitle: z.string(),
  sourceLink: z.string().nullable(),
  entityType: managedEntityTypeSchema,
  title: managedGiveawayTitleSchema,
  description: managedGiveawayDescriptionSchema,
  status: managedGiveawayStatusSchema,
  imageEnabled: z.boolean(),
  imageBase64: z.string(),
  imageMimeType: z.string(),
  imageFileName: z.string(),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime(),
  claimHours: z.number().int().min(1).max(336),
  requiredChannelIds: z.array(z.string()),
  requiredChannels: z.array(managedGiveawayPublicChannelSchema),
  entriesCount: z.number().int().min(0),
  winnersCount: z.number().int().min(0),
  publishedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  publicationUrl: z.string().nullable(),
  resultsUrl: z.string().nullable(),
  prizes: z.array(managedGiveawayPrizeSchema),
  winners: z.array(managedGiveawayPublicWinnerSchema),
});
export type ManagedGiveawayPublic = z.infer<typeof managedGiveawayPublicSchema>;

export const managedGiveawayParticipantStateSchema = z.object({
  joined: z.boolean(),
  entryId: z.string().nullable(),
  eligibilityState: giveawayEligibilityStateSchema.nullable(),
  eligibilityReason: z.string().nullable(),
  missingChannelIds: z.array(z.string()),
  joinedAt: z.string().datetime().nullable(),
  isWinner: z.boolean(),
  winnerId: z.string().nullable(),
  winnerStatus: managedGiveawayWinnerStatusSchema.nullable(),
  claimDeadlineAt: z.string().datetime().nullable(),
  prizePosition: z.number().int().min(1).nullable(),
  prizeTitle: z.string().nullable(),
  canClaim: z.boolean(),
  claimBotUrl: z.string().nullable(),
});
export type ManagedGiveawayParticipantState = z.infer<typeof managedGiveawayParticipantStateSchema>;

export const rerollManagedGiveawayWinnerRequestSchema = z.object({
  winnerId: z.string().trim().min(1),
});
export type RerollManagedGiveawayWinnerRequest = z.infer<
  typeof rerollManagedGiveawayWinnerRequestSchema
>;

export const markManagedGiveawayWinnerDeliveredRequestSchema = z.object({
  winnerId: z.string().trim().min(1),
});
export type MarkManagedGiveawayWinnerDeliveredRequest = z.infer<
  typeof markManagedGiveawayWinnerDeliveredRequestSchema
>;

export const managedGiveawayHandoffRequestSchema = z.object({
  giveawayId: z.string().trim().min(1).nullable().default(null),
});
export type ManagedGiveawayHandoffRequest = z.infer<typeof managedGiveawayHandoffRequestSchema>;

export const claimManagedGiveawayResponseSchema = z.object({
  ok: z.literal(true),
  winner: managedGiveawayWinnerSchema,
});
export type ClaimManagedGiveawayResponse = z.infer<typeof claimManagedGiveawayResponseSchema>;

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

export const channelOverviewSchema = z.object({
  enabledScenariosCount: z.number().int().min(0).max(2),
  commentsEnabled: z.boolean(),
  postSuggestionsEnabled: z.boolean(),
  commentsModerationEnabled: z.boolean(),
});
export type ChannelOverview = z.infer<typeof channelOverviewSchema>;

export const managedEntityAssignedBotSchema = z.object({
  botId: z.string(),
  label: z.string(),
  role: managedEntityBotRoleSchema,
  membershipStatus: managedEntityBotMembershipStatusSchema,
  lifecycleState: managedEntityBotLifecycleStateSchema,
  speechPersona: botSpeechPersonaSchema.default('male'),
  characterName: z.string().nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional().default(null),
  capabilities: z.array(managedEntityBotCapabilitySchema).optional().default([]),
  permissionsSummary: z
    .object({
      checkedAt: z.string().datetime().nullable().default(null),
      isAdmin: z.boolean().default(false),
      isOwner: z.boolean().default(false),
      permissions: z.array(z.string()).default([]),
    })
    .nullable()
    .optional()
    .default(null),
});
export type ManagedEntityAssignedBot = z.infer<typeof managedEntityAssignedBotSchema>;

export const managedEntityBotExecutionPlanSchema = z.object({
  chatId: z.string(),
  entityType: managedEntityTypeSchema,
  primaryBotId: z.string().nullable(),
  speakerBotId: z.string().nullable(),
  workerBotId: z.string().nullable(),
  linkBotId: z.string().nullable(),
  partnerBotId: z.string().nullable(),
  sharedMode: managedEntitySharedModeSchema,
  userFacingPolicy: z.literal('owner-only'),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  assignedBots: z.array(managedEntityAssignedBotSchema),
});
export type ManagedEntityBotExecutionPlan = z.infer<typeof managedEntityBotExecutionPlanSchema>;

export const updateManagedEntityPrimaryBotRequestSchema = z.object({
  botId: z.string().trim().min(1),
});
export type UpdateManagedEntityPrimaryBotRequest = z.infer<
  typeof updateManagedEntityPrimaryBotRequestSchema
>;

export const updateManagedEntityPartnerAssistRequestSchema = z.object({
  botId: z.string().trim().min(1),
  enabled: z.boolean(),
});
export type UpdateManagedEntityPartnerAssistRequest = z.infer<
  typeof updateManagedEntityPartnerAssistRequestSchema
>;

export const promoteManagedEntityStandbyRequestSchema = z.object({
  botId: z.string().trim().min(1).optional(),
});
export type PromoteManagedEntityStandbyRequest = z.infer<
  typeof promoteManagedEntityStandbyRequestSchema
>;

export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
  entityType: managedEntityTypeSchema.default('chat'),
  link: z.string().trim().max(2048).nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional(),
  channelOverview: channelOverviewSchema.nullable().optional().default(null),
  primaryBotId: z.string().nullable().optional().default(null),
  assignedBots: z.array(managedEntityAssignedBotSchema).optional().default([]),
  sharedMode: managedEntitySharedModeSchema.optional().default('owned'),
  favoriteTypes: z.array(managedEntityFavoriteTypeSchema).optional(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const managedEntitiesRefreshStateSchema = z.object({
  complete: z.boolean(),
  cursor: z.number().int().nullable(),
  backoffActive: z.boolean(),
  userVisibleComplete: z.boolean().optional(),
  nextPollAfterMs: z.number().int().min(0).default(1500),
  processedCandidates: z.number().int().min(0).nullable().optional().default(null),
  totalCandidates: z.number().int().min(0).nullable().optional().default(null),
  progressPercent: z.number().int().min(0).max(100).nullable().optional().default(null),
  lastSyncedAt: z.string().datetime().nullable().optional().default(null),
  manualRefreshBlockedReason: z
    .enum(['in_progress', 'recent_sync', 'backoff'])
    .nullable()
    .optional()
    .default(null),
  manualRefreshRetryAfterMs: z.number().int().min(0).nullable().optional().default(null),
});
export type ManagedEntitiesRefreshState = z.infer<typeof managedEntitiesRefreshStateSchema>;

export const managedEntitiesResponseSnapshotSchema = z.object({
  version: z.string().trim().min(1),
  builtAt: z.string().datetime(),
  lastSyncedAt: z.string().datetime().nullable().optional().default(null),
  source: z
    .enum(['published_snapshot', 'live_discovery', 'allowlist_cache', 'last_success_fallback'])
    .optional()
    .default('published_snapshot'),
  stale: z.boolean().optional().default(false),
});
export type ManagedEntitiesResponseSnapshot = z.infer<typeof managedEntitiesResponseSnapshotSchema>;

export const managedEntitiesResponseDiffNoopSchema = z.object({
  mode: z.literal('noop'),
  baseVersion: z.string().trim().min(1),
  nextVersion: z.string().trim().min(1),
});
export const managedEntitiesResponseDiffPatchSchema = z.object({
  mode: z.literal('patch'),
  baseVersion: z.string().trim().min(1),
  nextVersion: z.string().trim().min(1),
  added: z.array(chatSummarySchema).optional().default([]),
  updated: z.array(chatSummarySchema).optional().default([]),
  removedIds: z.array(z.string().trim().min(1)).optional().default([]),
  orderedIds: z.array(z.string().trim().min(1)).optional().default([]),
});
export const managedEntitiesResponseDiffSchema = z.discriminatedUnion('mode', [
  managedEntitiesResponseDiffNoopSchema,
  managedEntitiesResponseDiffPatchSchema,
]);
export type ManagedEntitiesResponseDiff = z.infer<typeof managedEntitiesResponseDiffSchema>;

export const managedEntitiesListResponseSchema = z.object({
  items: z.array(chatSummarySchema),
  refresh: managedEntitiesRefreshStateSchema,
  snapshot: managedEntitiesResponseSnapshotSchema.nullable().optional(),
  diff: managedEntitiesResponseDiffSchema.nullable().optional(),
});
export type ManagedEntitiesListResponse = z.infer<typeof managedEntitiesListResponseSchema>;

export const managedEntityHeaderSchema = z.object({
  id: z.string(),
  title: z.string(),
  entityType: managedEntityTypeSchema,
  link: z.string().trim().max(2048).nullable(),
  participantsCount: z.number().int().min(0).nullable(),
  avatarUrl: z.string().trim().url().nullable().optional(),
  primaryBotId: z.string().nullable().optional().default(null),
  assignedBots: z.array(managedEntityAssignedBotSchema).optional().default([]),
  sharedMode: managedEntitySharedModeSchema.optional().default('owned'),
});
export type ManagedEntityHeader = z.infer<typeof managedEntityHeaderSchema>;

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

export const updateManagedEntityFavoritesRequestSchema = z
  .object({
    favoriteTypes: z.array(managedEntityFavoriteTypeSchema).max(6).default([]),
  })
  .transform((value) => ({
    favoriteTypes: Array.from(new Set(value.favoriteTypes)),
  }));
export type UpdateManagedEntityFavoritesRequest = z.infer<
  typeof updateManagedEntityFavoritesRequestSchema
>;

export const managedEntityFavoritesResponseSchema = z.object({
  entityType: managedEntityTypeSchema,
  entityId: z.string().trim().min(1),
  favoriteTypes: z.array(managedEntityFavoriteTypeSchema),
});
export type ManagedEntityFavoritesResponse = z.infer<typeof managedEntityFavoritesResponseSchema>;

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

export const logsDashboardRangeSchema = z.enum(['24h', '7d', '30d']);
export type LogsDashboardRange = z.infer<typeof logsDashboardRangeSchema>;

const booleanQueryFlagSchema = z.preprocess((input) => {
  if (input === true || input === false) {
    return input;
  }
  if (input === '1' || input === 'true') {
    return true;
  }
  if (input === '0' || input === 'false') {
    return false;
  }
  return input;
}, z.boolean());

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

export const membershipActivityRangeSchema = logsDashboardRangeSchema;
export type MembershipActivityRange = z.infer<typeof membershipActivityRangeSchema>;

export const membershipActivityFilterSchema = z.enum(['all', 'joined', 'left']);
export type MembershipActivityFilter = z.infer<typeof membershipActivityFilterSchema>;

export const membershipActivityItemSchema = z.object({
  id: z.string(),
  type: z.enum(['joined', 'left']),
  userId: z.string(),
  userDisplayName: z.string().min(1),
  avatarUrl: z.string().trim().url().nullable().default(null),
  profileUrl: z.string().trim().url().nullable().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type MembershipActivityItem = z.infer<typeof membershipActivityItemSchema>;

export const membershipActivityPageSchema = z.object({
  items: z.array(membershipActivityItemSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().trim().min(1).nullable(),
});
export type MembershipActivityPage = z.infer<typeof membershipActivityPageSchema>;

export const membershipActivityQuerySchema = z.object({
  range: membershipActivityRangeSchema.default('7d'),
  filter: membershipActivityFilterSchema.default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional(),
});
export type MembershipActivityQuery = z.infer<typeof membershipActivityQuerySchema>;

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

export const channelStatsRangeSchema = z.enum(['24h', '7d', '30d']);
export type ChannelStatsRange = z.infer<typeof channelStatsRangeSchema>;

export const channelStatsQuerySchema = z.object({
  range: channelStatsRangeSchema.default('7d'),
});
export type ChannelStatsQuery = z.infer<typeof channelStatsQuerySchema>;

export const channelStatsBucketSchema = z.enum(['hour', 'day']);
export type ChannelStatsBucket = z.infer<typeof channelStatsBucketSchema>;

export const channelStatsMissingMetricSchema = z.enum(['reach', 'uniqueViews']);
export type ChannelStatsMissingMetric = z.infer<typeof channelStatsMissingMetricSchema>;

export const channelStatsReactionSchema = z.object({
  emoji: z.string().min(1),
  count: z.number().int().min(0),
});
export type ChannelStatsReaction = z.infer<typeof channelStatsReactionSchema>;

export const channelStatsViewModeSchema = z.enum(['observedDelta', 'latestTotal']);
export type ChannelStatsViewMode = z.infer<typeof channelStatsViewModeSchema>;

export const channelStatsTopPostSchema = z.object({
  messageId: z.string(),
  publishedAt: z.string().datetime(),
  url: z.string().trim().max(2_048).nullable(),
  views: z.number().int().min(0),
  viewsDelta: z.number().int().min(0),
  reactions: z.number().int().min(0),
});
export type ChannelStatsTopPost = z.infer<typeof channelStatsTopPostSchema>;

export const channelStatsResponseSchema = z.object({
  channel: z.object({
    id: z.string(),
    title: z.string(),
    participantsCount: z.number().int().min(0).nullable(),
    status: z.string().nullable(),
    isPublic: z.boolean().nullable(),
    link: z.string().trim().max(2_048).nullable(),
    lastEventAt: z.string().datetime().nullable(),
    avatarUrl: z.string().trim().url().nullable().optional(),
  }),
  period: z.object({
    range: channelStatsRangeSchema,
    from: z.string().datetime(),
    to: z.string().datetime(),
    bucket: channelStatsBucketSchema,
  }),
  official: z.object({
    audience: z.object({
      joined: z.number().int().min(0),
      left: z.number().int().min(0).nullable(),
      net: z.number().int().nullable(),
    }),
    content: z.object({
      posts: z.number().int().min(0),
      views: z.number().int().min(0),
      viewsTotal: z.number().int().min(0),
      viewsMode: channelStatsViewModeSchema,
      reactions: z.number().int().min(0),
      topReactions: z.array(channelStatsReactionSchema),
      topPosts: z.array(channelStatsTopPostSchema),
      lastPublishedAt: z.string().datetime().nullable(),
    }),
    series: z.object({
      participants: z.array(
        z.object({
          at: z.string().datetime(),
          participantsCount: z.number().int().min(0).nullable(),
        }),
      ),
      membership: z.array(
        z.object({
          at: z.string().datetime(),
          joined: z.number().int().min(0),
          left: z.number().int().min(0).nullable(),
        }),
      ),
      views: z.array(
        z.object({
          at: z.string().datetime(),
          views: z.number().int().min(0),
          cumulativeViews: z.number().int().min(0),
        }),
      ),
    }),
  }),
  secondary: z.object({
    postsWithButtons: z.number().int().min(0),
    comments: z.number().int().min(0),
    suggestions: z.number().int().min(0),
    commentAuthors: z.number().int().min(0),
    suggestionAuthors: z.number().int().min(0),
    suggestionsDelivered: z.number().int().min(0),
    suggestionsFailed: z.number().int().min(0),
    lastBotActivityAt: z.string().datetime().nullable(),
  }),
  meta: z.object({
    maxSnapshotAvailable: z.boolean(),
    viewsAvailable: z.boolean(),
    churnAvailable: z.boolean(),
    officialCoverageFrom: z.string().datetime().nullable(),
    missingOfficialMetrics: z.array(channelStatsMissingMetricSchema),
  }),
  activityFeed: membershipActivityPageSchema,
});
export type ChannelStatsResponse = z.infer<typeof channelStatsResponseSchema>;

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

function normalizeBroadcastScheduledSlots(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function normalizeBroadcastTargetChatIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function resolveBroadcastTargetMode(value: {
  targetMode?: BroadcastTargetMode;
  applyToAllChats?: boolean;
  targetChatIds?: string[];
}): BroadcastTargetMode {
  if (value.targetMode === 'all' || value.applyToAllChats) {
    return 'all';
  }

  if (value.targetMode === 'selected') {
    return 'selected';
  }

  if (value.targetMode === 'current') {
    return 'current';
  }

  if (normalizeBroadcastTargetChatIds(value.targetChatIds ?? []).length > 0) {
    return 'selected';
  }

  return 'current';
}

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
    const targetMode = resolveBroadcastTargetMode(value);
    const targetChatIds = normalizeBroadcastTargetChatIds(value.targetChatIds);
    if (targetMode === 'selected' && targetChatIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetChatIds'],
        message: 'Выберите хотя бы один чат.',
      });
    }

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

    if (
      value.buttons.length === 0 &&
      value.buttonEnabled &&
      !isValidBotButtonUrl(value.buttonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buttonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (
      value.buttons.length === 0 &&
      value.buttonEnabled &&
      !isValidBotButtonText(value.buttonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buttonText'],
        message: 'Введите название кнопки.',
      });
    }

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

    if (value.scheduleMode === 'calendar') {
      if (normalizeBroadcastScheduledSlots(value.scheduledSlots).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scheduledSlots'],
          message: 'Добавьте хотя бы один слот публикации.',
        });
      }
    } else {
      if (value.cycleEnabled && value.cycleCount < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cycleCount'],
          message: 'Для цикла укажите минимум 2 отправки.',
        });
      }

      if (value.cycleEnabled && value.cycleEveryHours == null && value.cycleEveryDays == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cycleEveryHours'],
          message: 'Укажите интервал циклического автопостинга.',
        });
      }
    }
  })
  .transform((value) => {
    const buttons = resolveBroadcastLinkButtons(value);
    const primaryButton = buttons[0];
    const targetMode = resolveBroadcastTargetMode(value);
    const images = normalizeBroadcastImages(value);
    const hasVideoPayload =
      value.mediaType === 'video' &&
      value.mediaPayload !== null &&
      Object.keys(value.mediaPayload).length > 0;
    const hasImageGallery = !hasVideoPayload && images.length > 1;
    const firstImage = !hasVideoPayload ? images[0] : undefined;

    return {
      ...value,
      targetMode,
      targetChatIds: normalizeBroadcastTargetChatIds(value.targetChatIds),
      applyToAllChats: targetMode === 'all',
      buttons,
      buttonEnabled: buttons.length > 0,
      buttonUrl: primaryButton?.url ?? '',
      buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
      imageEnabled: Boolean(firstImage),
      imageBase64: firstImage?.base64 ?? '',
      imageMimeType: firstImage?.mimeType ?? '',
      imageFileName: firstImage?.fileName ?? '',
      images: hasVideoPayload ? [] : images,
      mediaType: hasVideoPayload ? 'video' : hasImageGallery ? 'image' : null,
      mediaPayload: hasVideoPayload ? value.mediaPayload : hasImageGallery ? { images } : null,
      mediaMimeType: hasVideoPayload ? value.mediaMimeType.trim() : '',
      mediaFileName: hasVideoPayload ? value.mediaFileName.trim() : '',
      cycleEveryHours: value.cycleEveryHours ?? (value.cycleEveryDays ?? 1) * 24,
      scheduledSlots: normalizeBroadcastScheduledSlots(value.scheduledSlots),
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
    const targetMode = resolveBroadcastTargetMode(value);
    const targetChatIds = normalizeBroadcastTargetChatIds(value.targetChatIds);
    if (targetMode === 'selected' && targetChatIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetChatIds'],
        message: 'Выберите хотя бы один чат.',
      });
    }

    if (
      value.buttons.length === 0 &&
      value.buttonEnabled &&
      !isValidBotButtonUrl(value.buttonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buttonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (
      value.buttons.length === 0 &&
      value.buttonEnabled &&
      !isValidBotButtonText(value.buttonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buttonText'],
        message: 'Введите название кнопки.',
      });
    }

    if (value.scheduleMode === 'calendar') {
      if (normalizeBroadcastScheduledSlots(value.scheduledSlots).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scheduledSlots'],
          message: 'Добавьте хотя бы один слот публикации.',
        });
      }
    } else {
      if (value.cycleEnabled && value.cycleCount < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cycleCount'],
          message: 'Для цикла укажите минимум 2 отправки.',
        });
      }

      if (value.cycleEnabled && value.cycleEveryHours == null && value.cycleEveryDays == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cycleEveryHours'],
          message: 'Укажите интервал циклического автопостинга.',
        });
      }
    }
  })
  .transform((value) => {
    const buttons = resolveBroadcastLinkButtons(value);
    const primaryButton = buttons[0];
    const targetMode = resolveBroadcastTargetMode(value);

    return {
      ...value,
      targetMode,
      targetChatIds: normalizeBroadcastTargetChatIds(value.targetChatIds),
      applyToAllChats: targetMode === 'all',
      buttons,
      buttonEnabled: buttons.length > 0,
      buttonUrl: primaryButton?.url ?? '',
      buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
      cycleEveryHours: value.cycleEveryHours ?? (value.cycleEveryDays ?? 1) * 24,
      scheduledSlots: normalizeBroadcastScheduledSlots(value.scheduledSlots),
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

export const channelDialogTypeSchema = /*#__PURE__*/ z.enum(['comments', 'suggest']);
export type ChannelDialogType = z.infer<typeof channelDialogTypeSchema>;
export const MAX_CHANNEL_DIALOG_SUGGEST_IMAGES = 10;
export const MAX_CHANNEL_DIALOG_ATTACHMENTS = 5;
export const MAX_CHANNEL_DIALOG_COMMENT_FILES = 3;
export const MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH = 8_000_000;
export const MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64 = 24_000_000;

export const publishChannelEngagementRequestSchema = /*#__PURE__*/ z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .default('Есть идея или обратная связь? Нажмите кнопку ниже.'),
    commentsButtonText: z.string().trim().min(1).max(32).default('💬 Комментарии'),
    suggestButtonText: z.string().trim().min(1).max(32).default('📰 Предложить пост'),
    includeCommentsButton: z.boolean().default(true),
    includeSuggestButton: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (!value.includeCommentsButton && !value.includeSuggestButton) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['includeCommentsButton'],
        message: 'Включите хотя бы один вариант кнопки под постом.',
      });
    }
  });
export type PublishChannelEngagementRequest = z.infer<typeof publishChannelEngagementRequestSchema>;

export const publishChannelEngagementResultSchema = /*#__PURE__*/ z.object({
  chatId: z.string(),
  sent: z.boolean(),
  messageId: z.string().nullable(),
  updatedExisting: z.boolean().default(false),
  publishedAt: z.string().datetime().nullable().default(null),
});
export type PublishChannelEngagementResult = z.infer<typeof publishChannelEngagementResultSchema>;

export const channelDialogImageInputSchema = /*#__PURE__*/ z
  .object({
    base64: z.string().trim().max(MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH).default(''),
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
export type ChannelDialogImageInput = z.infer<typeof channelDialogImageInputSchema>;

export const channelDialogAttachmentKindSchema = /*#__PURE__*/ z.enum(['image', 'file']);
export type ChannelDialogAttachmentKind = z.infer<typeof channelDialogAttachmentKindSchema>;

export const channelDialogAttachmentInputSchema = /*#__PURE__*/ z
  .object({
    type: channelDialogAttachmentKindSchema,
    base64: z.string().trim().max(MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH).default(''),
    mimeType: z.string().trim().max(128).default(''),
    fileName: z.string().trim().max(128).default(''),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.base64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['base64'],
        message: value.type === 'image' ? 'Добавьте фото.' : 'Добавьте файл.',
      });
    }

    if (value.type === 'image') {
      if (!value.mimeType.trim() || !value.mimeType.toLowerCase().startsWith('image/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mimeType'],
          message: 'Неверный формат фото.',
        });
      }
      return;
    }

    if (!value.mimeType.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mimeType'],
        message: 'Неверный формат файла.',
      });
    }
  });
export type ChannelDialogAttachmentInput = z.infer<typeof channelDialogAttachmentInputSchema>;

export const createChannelDialogMessageRequestSchema = /*#__PURE__*/ z
  .object({
    token: z.string().trim().min(16).max(256),
    text: z.string().trim().max(2_000).default(''),
    textFormat: broadcastTextFormatSchema.default('plain'),
    replyToMessageId: z.string().trim().min(1).max(191).nullable().optional(),
    attachments: z
      .array(channelDialogAttachmentInputSchema)
      .max(MAX_CHANNEL_DIALOG_ATTACHMENTS)
      .default([]),
    imageBase64: z.string().trim().max(MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
    images: z
      .array(channelDialogImageInputSchema)
      .max(MAX_CHANNEL_DIALOG_SUGGEST_IMAGES)
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (
      value.images.length === 0 &&
      value.imageBase64 &&
      (!value.imageMimeType.trim() || !value.imageMimeType.toLowerCase().startsWith('image/'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageMimeType'],
        message: 'Неверный формат фото.',
      });
    }

    const legacyImageAttachment =
      value.images.length === 0 && value.imageBase64
        ? {
            type: 'image' as const,
            base64: value.imageBase64.trim(),
            mimeType: value.imageMimeType.trim(),
            fileName: value.imageFileName.trim(),
          }
        : null;
    const normalizedAttachments = [
      ...value.attachments,
      ...(legacyImageAttachment ? [legacyImageAttachment] : []),
    ];
    const normalizedMedia = [
      ...normalizedAttachments,
      ...value.images.map((image) => ({
        type: 'image' as const,
        base64: image.base64,
        mimeType: image.mimeType,
        fileName: image.fileName,
      })),
    ];

    if (normalizedAttachments.length > MAX_CHANNEL_DIALOG_ATTACHMENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachments'],
        message: `Можно добавить до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} вложений.`,
      });
    }

    const fileAttachments = normalizedAttachments.filter(
      (attachment) => attachment.type === 'file',
    );
    if (fileAttachments.length > MAX_CHANNEL_DIALOG_COMMENT_FILES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachments'],
        message: `Можно прикрепить до ${MAX_CHANNEL_DIALOG_COMMENT_FILES} файлов.`,
      });
    }

    const totalBase64Length = normalizedMedia.reduce(
      (acc, attachment) => acc + attachment.base64.trim().length,
      0,
    );
    if (totalBase64Length > MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachments'],
        message: 'Суммарный размер вложений слишком большой.',
      });
    }
  })
  .transform((value) => ({
    ...value,
    images:
      value.images.length > 0
        ? value.images
        : value.imageBase64
          ? [
              {
                base64: value.imageBase64.trim(),
                mimeType: value.imageMimeType.trim(),
                fileName: value.imageFileName.trim(),
              },
            ]
          : [],
    attachments: [
      ...value.attachments,
      ...(value.images.length === 0 && value.imageBase64
        ? [
            {
              type: 'image' as const,
              base64: value.imageBase64.trim(),
              mimeType: value.imageMimeType.trim(),
              fileName: value.imageFileName.trim(),
              width: undefined,
              height: undefined,
            },
          ]
        : []),
    ].slice(0, MAX_CHANNEL_DIALOG_ATTACHMENTS),
  }));
export type CreateChannelDialogMessageRequest = z.infer<
  typeof createChannelDialogMessageRequestSchema
>;

export const channelDialogReactionGroupSchema = /*#__PURE__*/ z.object({
  emoji: z.string().trim().min(1).max(16),
  count: z.number().int().min(1),
  reactedByMe: z.boolean().default(false),
});
export type ChannelDialogReactionGroup = z.infer<typeof channelDialogReactionGroupSchema>;

export const channelDialogReplyPreviewSchema = /*#__PURE__*/ z.object({
  messageId: z.string(),
  authorDisplayName: z.string().nullable(),
  text: z.string(),
});
export type ChannelDialogReplyPreview = z.infer<typeof channelDialogReplyPreviewSchema>;

export const channelDialogSuggestionReviewStatusSchema = /*#__PURE__*/ z.enum([
  'pending',
  'published',
  'cancelled',
]);
export type ChannelDialogSuggestionReviewStatus = z.infer<
  typeof channelDialogSuggestionReviewStatusSchema
>;

export const channelDialogAttachmentSchema = /*#__PURE__*/ z.object({
  kind: channelDialogAttachmentKindSchema,
  url: z.string().trim().url().nullable().default(null),
  previewUrl: z.string().trim().url().nullable().default(null),
  fileName: z.string().trim().max(128).nullable().default(null),
  mimeType: z.string().trim().max(128).nullable().default(null),
  size: z.number().int().min(0).nullable().default(null),
  width: z.number().int().min(1).nullable().optional(),
  height: z.number().int().min(1).nullable().optional(),
});
export type ChannelDialogAttachment = z.infer<typeof channelDialogAttachmentSchema>;

export const channelDialogMessageSchema = /*#__PURE__*/ z.object({
  id: z.string(),
  type: channelDialogTypeSchema,
  text: z.string(),
  authorUserId: z.string(),
  authorDisplayName: z.string().nullable(),
  isAdmin: z.boolean().default(false),
  avatarUrl: z.string().trim().url().nullable().default(null),
  textFormat: broadcastTextFormatSchema.optional(),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable().optional(),
  replyToMessageId: z.string().nullable().optional(),
  replyTo: channelDialogReplyPreviewSchema.nullable().optional(),
  attachments: z
    .array(channelDialogAttachmentSchema)
    .max(MAX_CHANNEL_DIALOG_ATTACHMENTS)
    .default([]),
  reactionGroups: z.array(channelDialogReactionGroupSchema).default([]),
  canEdit: z.boolean().default(false),
  canDelete: z.boolean().default(false),
  canDeleteAsAdmin: z.boolean().default(false),
  delivered: z.boolean().optional(),
  deliveredToUserId: z.string().nullable().optional(),
  reviewStatus: channelDialogSuggestionReviewStatusSchema.optional(),
  publishedUrl: z.string().trim().max(2_048).nullable().optional(),
  hasImage: z.boolean().optional(),
  imageCount: z.number().int().min(0).optional(),
  imageFileName: z.string().trim().max(128).nullable().optional(),
  imageFileNames: z
    .array(z.string().trim().max(128))
    .max(MAX_CHANNEL_DIALOG_SUGGEST_IMAGES)
    .optional(),
  hasVideo: z.boolean().optional(),
  videoFileName: z.string().trim().max(128).nullable().optional(),
});
export type ChannelDialogMessage = z.infer<typeof channelDialogMessageSchema>;

export const channelDialogResponseSchema = /*#__PURE__*/ z.object({
  chatId: z.string(),
  type: channelDialogTypeSchema,
  introText: z.string().nullable().default(null),
  messages: z.array(channelDialogMessageSchema),
});
export type ChannelDialogResponse = z.infer<typeof channelDialogResponseSchema>;

export const channelSuggestionRedirectResponseSchema = /*#__PURE__*/ z.object({
  url: z.string().trim().url(),
  title: z.string().trim().max(256).nullable().default(null),
});
export type ChannelSuggestionRedirectResponse = z.infer<
  typeof channelSuggestionRedirectResponseSchema
>;

export const createChannelDialogMessageResponseSchema = /*#__PURE__*/ z.object({
  ok: z.boolean(),
  message: channelDialogMessageSchema,
});
export type CreateChannelDialogMessageResponse = z.infer<
  typeof createChannelDialogMessageResponseSchema
>;

export const updateChannelDialogMessageRequestSchema = /*#__PURE__*/ z.object({
  token: z.string().trim().min(16).max(256),
  text: z.string().trim().max(2_000).default(''),
});
export type UpdateChannelDialogMessageRequest = z.infer<
  typeof updateChannelDialogMessageRequestSchema
>;

export const updateChannelDialogMessageResponseSchema = /*#__PURE__*/ z.object({
  ok: z.boolean(),
  message: channelDialogMessageSchema,
});
export type UpdateChannelDialogMessageResponse = z.infer<
  typeof updateChannelDialogMessageResponseSchema
>;

export const toggleChannelDialogReactionRequestSchema = /*#__PURE__*/ z.object({
  token: z.string().trim().min(16).max(256),
  emoji: z.string().trim().min(1).max(16),
});
export type ToggleChannelDialogReactionRequest = z.infer<
  typeof toggleChannelDialogReactionRequestSchema
>;

export const toggleChannelDialogReactionResponseSchema = /*#__PURE__*/ z.object({
  ok: z.boolean(),
  message: channelDialogMessageSchema,
});
export type ToggleChannelDialogReactionResponse = z.infer<
  typeof toggleChannelDialogReactionResponseSchema
>;

export const deleteChannelDialogMessageRequestSchema = /*#__PURE__*/ z.object({
  token: z.string().trim().min(16).max(256),
});
export type DeleteChannelDialogMessageRequest = z.infer<
  typeof deleteChannelDialogMessageRequestSchema
>;

export const deleteChannelDialogMessageResponseSchema = /*#__PURE__*/ z.object({
  ok: z.boolean(),
  deletedMessageId: z.string(),
});
export type DeleteChannelDialogMessageResponse = z.infer<
  typeof deleteChannelDialogMessageResponseSchema
>;

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
