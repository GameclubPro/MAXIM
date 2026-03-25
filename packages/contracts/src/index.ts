import { z } from 'zod';
export {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  BOT_SPEECH_PRESETS,
  BOT_SPEECH_STYLE_METADATA,
  BOT_SPEECH_STYLE_OPTIONS,
  BOT_SPEECH_STYLE_VALUES,
  BOT_SPEECH_SYSTEM_TEMPLATE_KEYS,
  applyBotSpeechStylePreset,
  botSpeechStyleSchema,
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  hasBotSpeechEditableOverrides,
  resolveBotSpeechStyle,
  type BotSpeechEditableFieldKey,
  type BotSpeechSettingsSubset,
  type BotSpeechStyle,
  type BotSpeechSystemTemplateKey,
} from './bot-speech.js';
import { botSpeechStyleSchema } from './bot-speech.js';

export const sanctionActionSchema = z.enum(['NONE', 'WARN', 'DELETE_MESSAGE', 'KICK', 'BAN']);
export type SanctionAction = z.infer<typeof sanctionActionSchema>;

export const linkPolicySchema = z.enum(['ALLOWLIST_ONLY', 'BLOCKLIST_ONLY', 'ALERT_ONLY']);
export const commercialAdsSensitivitySchema = z.enum(['BALANCED', 'STRICT']);
export const managedEntityTypeSchema = z.enum(['chat', 'channel']);
export const applySettingsSectionSchema = z.enum([
  'links',
  'greeting',
  'profanityFilter',
  'commercialFilter',
  'thematicFilters',
  'duplicates',
  'limits',
  'night',
  'requiredSubscription',
  'extra',
]);
export const channelAutoPostButtonsModeSchema = z.enum(['OFF', 'COMMENTS', 'SUGGEST', 'BOTH']);
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
export type ManagedEntityType = z.infer<typeof managedEntityTypeSchema>;
export type ApplySettingsSection = z.infer<typeof applySettingsSectionSchema>;
export type ChannelAutoPostButtonsMode = z.infer<typeof channelAutoPostButtonsModeSchema>;
export type ManagedPollStatus = z.infer<typeof managedPollStatusSchema>;
export type ManagedGiveawayStatus = z.infer<typeof managedGiveawayStatusSchema>;
export type GiveawayEligibilityState = z.infer<typeof giveawayEligibilityStateSchema>;
export type ManagedGiveawayWinnerStatus = z.infer<typeof managedGiveawayWinnerStatusSchema>;
export type BroadcastTextFormat = z.infer<typeof broadcastTextFormatSchema>;

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
export const MESSAGE_LIMITS_BLOCKED_WORDS_MAX = 50;
export const DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES = 0.5;
export const DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES = 60;
export const DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES = 2;
export const DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES = Object.freeze([
  DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES,
  ...Array.from({ length: DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES }, (_, index) => index + 1),
]);

const duplicateWindowSecSchema = z.number().int().min(3_600).max(604_800);
const duplicateMaxCountSchema = z.number().int().min(2).max(20);
const botButtonUrlSchema = z.string().trim().max(2_048).default('');
const botButtonTextSchema = z.string().trim().max(32).default('Открыть');
const botMessageTextSchema = z.string().max(1_000).default('');
const thematicCodewordSchema = z.string().trim().max(32).default('');
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
const chatRulesImageBase64Schema = z.string().trim().max(1_500_000).default('');
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

export function isValidDeleteBotMessagesDelayMinutes(value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }

  return DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.some(
    (candidate) => Math.abs(candidate - value) < 1e-9,
  );
}

export function normalizeDeleteBotMessagesDelayMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES;
  }

  let closest = DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES[0];
  let closestDistance = Math.abs(closest - value);

  for (const candidate of DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.slice(1)) {
    const distance = Math.abs(candidate - value);
    if (distance < closestDistance || (distance === closestDistance && candidate > closest)) {
      closest = candidate;
      closestDistance = distance;
    }
  }

  return closest;
}

export function stepDeleteBotMessagesDelayMinutes(value: number, direction: number): number {
  const normalized = normalizeDeleteBotMessagesDelayMinutes(value);
  const currentIndex = DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.findIndex(
    (candidate) => Math.abs(candidate - normalized) < 1e-9,
  );
  if (currentIndex < 0) {
    return normalized;
  }

  const nextIndex = Math.min(
    DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES.length - 1,
    Math.max(0, currentIndex + Math.sign(direction)),
  );

  return DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES[nextIndex] ?? normalized;
}

export function formatDeleteBotMessagesDelayLabel(value: number): string {
  const normalized = normalizeDeleteBotMessagesDelayMinutes(value);
  if (normalized < 1) {
    return '30 сек';
  }

  return `${normalized} мин`;
}

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

  return fragments[0];
}

function isValidBotButtonUrl(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }

    return !(parsed.searchParams.get('start')?.trim() ?? '').startsWith('pmh-');
  } catch {
    return false;
  }
}

const ALLOWLIST_URL_CANDIDATE_PATTERN =
  /(?:https?:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,})[^\s<>"'()[\]{}]*/i;
const ENCODED_WHITESPACE_PATTERN = /%(?:09|0a|0d|20)/i;
const ALLOWLIST_HOST_ALIASES = new Map<string, string>([
  ['vk.com', 'vk.com'],
  ['www.vk.com', 'vk.com'],
  ['vk.ru', 'vk.com'],
  ['www.vk.ru', 'vk.com'],
  ['instagram.com', 'instagram.com'],
  ['www.instagram.com', 'instagram.com'],
]);
export const ALLOWLIST_DOMAIN_RULE_PREFIX = 'domain:';
export const allowlistMatchTypeSchema = z.enum(['EXACT', 'DOMAIN']);
export type AllowlistMatchType = z.infer<typeof allowlistMatchTypeSchema>;

type ParsedAllowlistCandidate = {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
};

function tryDecodeUriComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function extractAllowlistUrlCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const decoded = tryDecodeUriComponent(trimmed);
  const candidates =
    decoded && decoded !== trimmed && ENCODED_WHITESPACE_PATTERN.test(trimmed)
      ? [decoded, trimmed]
      : decoded && decoded !== trimmed
        ? [trimmed, decoded]
        : [trimmed];

  for (const candidate of candidates) {
    const match = candidate.match(ALLOWLIST_URL_CANDIDATE_PATTERN);
    if (!match) {
      continue;
    }

    const extracted = match[0].replace(/[),.;!?]+$/u, '');
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

function canonicalizeAllowlistHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return ALLOWLIST_HOST_ALIASES.get(normalized) ?? normalized;
}

function parseAllowlistCandidate(value: string): ParsedAllowlistCandidate | null {
  const raw = extractAllowlistUrlCandidate(value);
  if (!raw) {
    return null;
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    return null;
  }

  const hostname = canonicalizeAllowlistHostname(parsed.hostname);
  if (!hostname) {
    return null;
  }

  return {
    protocol,
    hostname,
    port: parsed.port,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

export function normalizeAllowlistLink(value: string): string | null {
  const parsed = parseAllowlistCandidate(value);
  if (!parsed) {
    return null;
  }

  const shouldKeepPort =
    parsed.port.length > 0 &&
    !(
      (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')
    );
  const port = shouldKeepPort ? `:${parsed.port}` : '';
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;

  return `${parsed.protocol}//${parsed.hostname}${port}${pathname}${parsed.search}${parsed.hash}`;
}

export function normalizeAllowlistDomain(value: string): string | null {
  const parsed = parseAllowlistCandidate(value);
  if (!parsed) {
    return null;
  }

  return parsed.hostname;
}

export function inferAllowlistMatchType(value: string): AllowlistMatchType | null {
  const parsed = parseAllowlistCandidate(value);
  if (!parsed) {
    return null;
  }

  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    return 'EXACT';
  }

  return 'DOMAIN';
}

export function normalizeStoredAllowlistEntry(
  value: string,
  matchType: AllowlistMatchType,
): string | null {
  if (matchType === 'DOMAIN') {
    const normalizedDomain = normalizeAllowlistDomain(value);
    return normalizedDomain ? `${ALLOWLIST_DOMAIN_RULE_PREFIX}${normalizedDomain}` : null;
  }

  return normalizeAllowlistLink(value);
}

export function parseStoredAllowlistEntry(value: string): {
  domain: string;
  normalizedValue: string;
  matchType: AllowlistMatchType;
} | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.toLowerCase().startsWith(ALLOWLIST_DOMAIN_RULE_PREFIX)) {
    const normalizedDomain = normalizeAllowlistDomain(
      trimmed.slice(ALLOWLIST_DOMAIN_RULE_PREFIX.length),
    );
    if (!normalizedDomain) {
      return null;
    }

    return {
      domain: normalizedDomain,
      normalizedValue: `${ALLOWLIST_DOMAIN_RULE_PREFIX}${normalizedDomain}`,
      matchType: 'DOMAIN',
    };
  }

  const normalizedLink = normalizeAllowlistLink(trimmed);
  if (!normalizedLink) {
    return null;
  }

  return {
    domain: normalizedLink,
    normalizedValue: normalizedLink,
    matchType: 'EXACT',
  };
}

function isValidAllowlistLink(value: string): boolean {
  return normalizeAllowlistLink(value) !== null;
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
    botSpeechStyle: botSpeechStyleSchema.nullable().default('FRIENDLY'),
    greetingEnabled: z.boolean().default(false),
    greetingBotMessageEnabled: z.boolean().default(false),
    greetingDeleteBotMessageEnabled: z.boolean().default(false),
    greetingBotMessageText: botMessageTextSchema,
    greetingBotButtonEnabled: z.boolean().default(false),
    greetingBotButtonUrl: botButtonUrlSchema,
    greetingBotButtonText: botButtonTextSchema,
    greetingRulesButtonEnabled: z.boolean().default(false),
    requiredSubscriptionEnabled: z.boolean().default(false),
    requiredSubscriptionChannelIds: requiredSubscriptionChannelIdsSchema,
    requiredSubscriptionBotMessageEnabled: z.boolean().default(true),
    requiredSubscriptionBotMessageText: botMessageTextSchema,
    requiredSubscriptionWarnEnabled: z.boolean().default(false),
    requiredSubscriptionWarnMessageText: botMessageTextSchema,
    requiredSubscriptionBanEnabled: z.boolean().default(false),
    requiredSubscriptionKickEnabled: z.boolean().default(false),
    commentsEnabled: z.boolean().default(false),
    commentsAdminsEnabled: z.boolean().default(true),
    commentsAllEnabled: z.boolean().default(false),
    commentsChatBroadcastsEnabled: z.boolean().default(false),
    deleteBotMessagesEnabled: z.boolean().default(true),
    deleteBotMessagesDelayMinutes: z
      .number()
      .min(DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES)
      .max(DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES)
      .refine(isValidDeleteBotMessagesDelayMinutes, {
        message: 'Допустимо 30 сек или целое число минут от 1 до 60.',
      })
      .default(DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES),
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
    videoMessagesEnabled: z.boolean().default(true),
    fileMessagesEnabled: z.boolean().default(true),
    voiceMessagesEnabled: z.boolean().default(true),
    messageLimitsBlockedWords: messageLimitsBlockedWordsSchema,
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
    textFiltersRulesButtonEnabled: z.boolean().default(false),
    thematicCodewordEnabled: z.boolean().default(false),
    thematicCodeword: thematicCodewordSchema,
    thematicFiltersBotMessageEnabled: z.boolean().default(false),
    thematicFiltersWarnEnabled: z.boolean().default(false),
    thematicFiltersBanEnabled: z.boolean().default(false),
    thematicFiltersKickEnabled: z.boolean().default(false),
    thematicFiltersBotButtonEnabled: z.boolean().default(false),
    thematicFiltersBotButtonUrl: botButtonUrlSchema,
    thematicFiltersBotButtonText: botButtonTextSchema,
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
    linkKickEnabled: z.boolean().default(false),
    linkBotButtonEnabled: z.boolean().default(false),
    linkBotButtonUrl: botButtonUrlSchema,
    linkBotButtonText: botButtonTextSchema,
    linkRulesButtonEnabled: z.boolean().default(false),
    duplicateBotMessageEnabled: z.boolean().default(false),
    duplicateBotMessageText: botMessageTextSchema,
    duplicateBotButtonEnabled: z.boolean().default(false),
    duplicateBotButtonUrl: botButtonUrlSchema,
    duplicateBotButtonText: botButtonTextSchema,
    duplicateRulesButtonEnabled: z.boolean().default(false),
    messageLimitsRulesButtonEnabled: z.boolean().default(false),
    rulesAttachViolationsEnabled: z.boolean().default(true),
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

    if (value.requiredSubscriptionEnabled && value.requiredSubscriptionChannelIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredSubscriptionChannelIds'],
        message: 'Выберите хотя бы один канал для обязательной подписки.',
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

    if (
      value.thematicFiltersBotMessageEnabled &&
      value.thematicFiltersBotButtonEnabled &&
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
  });
export type ChatSettings = z.infer<typeof chatSettingsSchema>;

const chatRulesObjectSchema = z.object({
  text: chatRulesTextSchema,
  imageBase64: chatRulesImageBase64Schema,
  imageMimeType: chatRulesImageMimeTypeSchema,
  imageFileName: chatRulesImageFileNameSchema,
  autoTextEnabled: z.boolean().default(false),
  publishedMessageId: z.string().trim().min(1).nullable().default(null),
  publishedUrl: z.string().trim().max(2_048).nullable().default(null),
  publishedAt: z.string().datetime().nullable().default(null),
});

export const chatRulesSchema = chatRulesObjectSchema.superRefine((value, ctx) => {
  if (value.imageBase64) {
    if (!value.imageMimeType.trim() || !value.imageMimeType.toLowerCase().startsWith('image/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageMimeType'],
        message: 'Неверный формат фото.',
      });
    }
  }

  if (value.publishedUrl && !isValidBotButtonUrl(value.publishedUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publishedUrl'],
      message: 'Сохранена некорректная ссылка на пост правил.',
    });
  }
});
export type ChatRules = z.infer<typeof chatRulesSchema>;

export const updateChatRulesRequestSchema = chatRulesObjectSchema.pick({
  text: true,
  imageBase64: true,
  imageMimeType: true,
  imageFileName: true,
  autoTextEnabled: true,
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
    engagementMessageText: botMessageTextSchema.default(
      'Есть идея или обратная связь? Нажмите кнопку ниже.',
    ),
    postSuggestionsButtonEnabled: z.boolean().default(false),
    postSuggestionsButtonText: z.string().trim().max(32).default('Предложить пост'),
    postSuggestionsButtonUrl: botButtonUrlSchema,
    commentsEnabled: z.boolean().default(true),
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
    imageBase64: z.string().trim().max(1_500_000).default(''),
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
  metadata: z.record(z.unknown()).nullable().optional(),
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

export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
  entityType: managedEntityTypeSchema.default('chat'),
  link: z.string().trim().max(2048).nullable().optional().default(null),
  channelOverview: channelOverviewSchema.nullable().optional().default(null),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const managedEntitiesRefreshStateSchema = z.object({
  complete: z.boolean(),
  cursor: z.number().int().nullable(),
  backoffActive: z.boolean(),
});
export type ManagedEntitiesRefreshState = z.infer<typeof managedEntitiesRefreshStateSchema>;

export const managedEntitiesListResponseSchema = z.object({
  items: z.array(chatSummarySchema),
  refresh: managedEntitiesRefreshStateSchema,
});
export type ManagedEntitiesListResponse = z.infer<typeof managedEntitiesListResponseSchema>;

export const managedEntityHeaderSchema = z.object({
  id: z.string(),
  title: z.string(),
  entityType: managedEntityTypeSchema,
  link: z.string().trim().max(2048).nullable(),
  participantsCount: z.number().int().min(0).nullable(),
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

export const applySectionToAllRequestSchema = z.object({
  section: applySettingsSectionSchema,
});
export type ApplySectionToAllRequest = z.infer<typeof applySectionToAllRequestSchema>;

export const applySectionToAllResponseSchema = z.object({
  section: applySettingsSectionSchema,
  sourceChatId: z.string(),
  updatedChats: z.number().int().min(0),
  appliedChatIds: z.array(z.string()),
});
export type ApplySectionToAllResponse = z.infer<typeof applySectionToAllResponseSchema>;

export const meSchema = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().trim().url().nullable().default(null),
  profileUrl: z.string().trim().url().nullable().default(null),
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

export const channelStatsResponseSchema = z.object({
  channel: z.object({
    id: z.string(),
    title: z.string(),
    participantsCount: z.number().int().min(0).nullable(),
    status: z.string().nullable(),
    isPublic: z.boolean().nullable(),
    link: z.string().trim().max(2_048).nullable(),
    lastEventAt: z.string().datetime().nullable(),
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
      reactions: z.number().int().min(0),
      topReactions: z.array(channelStatsReactionSchema),
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
    netUsers: z.number().int(),
  }),
  violationsSummary: z.object({
    warn: z.number().int().min(0),
    deleteMessage: z.number().int().min(0),
    kick: z.number().int().min(0),
    ban: z.number().int().min(0),
    unban: z.number().int().min(0),
    affectedUsers: z.number().int().min(0),
    total: z.number().int().min(0),
  }),
  violations: z.array(logsDashboardViolationSchema),
  activityFeed: membershipActivityPageSchema,
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

export const sendBroadcastRequestSchema = z
  .object({
    text: z
      .string()
      .trim()
      .max(2_000, 'Текст рассылки слишком длинный. Максимум 2000 символов.')
      .default(''),
    textFormat: broadcastTextFormatSchema.default('plain'),
    applyToAllChats: z.boolean().default(false),
    buttonEnabled: z.boolean().default(false),
    buttonUrl: botButtonUrlSchema,
    buttonText: botButtonTextSchema,
    imageEnabled: z.boolean().default(false),
    imageBase64: z.string().trim().max(4_000_000).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
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
          message: 'Укажите интервал циклической рассылки.',
        });
      }
    }
  })
  .transform((value) => ({
    ...value,
    cycleEveryHours: value.cycleEveryHours ?? (value.cycleEveryDays ?? 1) * 24,
    scheduledSlots: normalizeBroadcastScheduledSlots(value.scheduledSlots),
  }));
export type SendBroadcastRequest = z.infer<typeof sendBroadcastRequestSchema>;

export const broadcastHandoffRequestSchema = z
  .object({
    applyToAllChats: z.boolean().default(false),
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
          message: 'Укажите интервал циклической рассылки.',
        });
      }
    }
  })
  .transform((value) => ({
    ...value,
    cycleEveryHours: value.cycleEveryHours ?? (value.cycleEveryDays ?? 1) * 24,
    scheduledSlots: normalizeBroadcastScheduledSlots(value.scheduledSlots),
  }));
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
  applyToAllChats: z.boolean(),
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

export const sendBroadcastResultSchema = z.object({
  sourceChatId: z.string(),
  targetChats: z.number().int().min(1),
  sentChats: z.number().int().min(0),
  failedChats: z.number().int().min(0),
  sentChatIds: z.array(z.string()),
  failedChatIds: z.array(z.string()),
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

export const managedBroadcastStatusSchema = z.enum([
  'ACTIVE',
  'PARTIAL',
  'FAILED',
  'COMPLETED',
  'CANCELED',
]);
export type ManagedBroadcastStatus = z.infer<typeof managedBroadcastStatusSchema>;

export const managedBroadcastSummarySchema = z.object({
  id: z.string(),
  status: managedBroadcastStatusSchema,
  textPreview: z.string(),
  textLength: z.number().int().min(0),
  applyToAllChats: z.boolean(),
  targetChats: z.number().int().min(1),
  hasImage: z.boolean(),
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
  applyToAllChats: z.boolean(),
  targetChatIds: z.array(z.string()),
  buttonEnabled: z.boolean(),
  buttonUrl: botButtonUrlSchema,
  buttonText: botButtonTextSchema,
  imageEnabled: z.boolean(),
  imageBase64: z.string(),
  imageMimeType: z.string(),
  imageFileName: z.string(),
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
  canRetry: z.boolean(),
  remainingCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().nullable(),
});
export type ManagedBroadcastDetails = z.infer<typeof managedBroadcastDetailsSchema>;

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

export const channelDialogTypeSchema = z.enum(['comments', 'suggest']);
export type ChannelDialogType = z.infer<typeof channelDialogTypeSchema>;

export const publishChannelEngagementRequestSchema = z
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

export const publishChannelEngagementResultSchema = z.object({
  chatId: z.string(),
  sent: z.boolean(),
  messageId: z.string().nullable(),
  updatedExisting: z.boolean().default(false),
  publishedAt: z.string().datetime().nullable().default(null),
});
export type PublishChannelEngagementResult = z.infer<typeof publishChannelEngagementResultSchema>;

export const createChannelDialogMessageRequestSchema = z
  .object({
    token: z.string().trim().min(16).max(256),
    text: z.string().trim().max(2_000).default(''),
    replyToMessageId: z.string().trim().min(1).max(191).nullable().optional(),
    imageBase64: z.string().trim().max(4_000_000).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
  })
  .superRefine((value, ctx) => {
    if (
      value.imageBase64 &&
      (!value.imageMimeType.trim() || !value.imageMimeType.toLowerCase().startsWith('image/'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageMimeType'],
        message: 'Неверный формат фото.',
      });
    }
  });
export type CreateChannelDialogMessageRequest = z.infer<
  typeof createChannelDialogMessageRequestSchema
>;

export const channelDialogReactionGroupSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
  count: z.number().int().min(1),
  reactedByMe: z.boolean().default(false),
});
export type ChannelDialogReactionGroup = z.infer<typeof channelDialogReactionGroupSchema>;

export const channelDialogReplyPreviewSchema = z.object({
  messageId: z.string(),
  authorDisplayName: z.string().nullable(),
  text: z.string(),
});
export type ChannelDialogReplyPreview = z.infer<typeof channelDialogReplyPreviewSchema>;

export const channelDialogSuggestionReviewStatusSchema = z.enum([
  'pending',
  'published',
  'cancelled',
]);
export type ChannelDialogSuggestionReviewStatus = z.infer<
  typeof channelDialogSuggestionReviewStatusSchema
>;

export const channelDialogMessageSchema = z.object({
  id: z.string(),
  type: channelDialogTypeSchema,
  text: z.string(),
  authorUserId: z.string(),
  authorDisplayName: z.string().nullable(),
  isAdmin: z.boolean().default(false),
  avatarUrl: z.string().trim().url().nullable().default(null),
  createdAt: z.string().datetime(),
  replyToMessageId: z.string().nullable().optional(),
  replyTo: channelDialogReplyPreviewSchema.nullable().optional(),
  reactionGroups: z.array(channelDialogReactionGroupSchema).default([]),
  delivered: z.boolean().optional(),
  deliveredToUserId: z.string().nullable().optional(),
  reviewStatus: channelDialogSuggestionReviewStatusSchema.optional(),
  publishedUrl: z.string().trim().max(2_048).nullable().optional(),
  hasImage: z.boolean().optional(),
  imageFileName: z.string().trim().max(128).nullable().optional(),
});
export type ChannelDialogMessage = z.infer<typeof channelDialogMessageSchema>;

export const channelDialogResponseSchema = z.object({
  chatId: z.string(),
  type: channelDialogTypeSchema,
  introText: z.string().nullable().default(null),
  messages: z.array(channelDialogMessageSchema),
});
export type ChannelDialogResponse = z.infer<typeof channelDialogResponseSchema>;

export const createChannelDialogMessageResponseSchema = z.object({
  ok: z.boolean(),
  message: channelDialogMessageSchema,
});
export type CreateChannelDialogMessageResponse = z.infer<
  typeof createChannelDialogMessageResponseSchema
>;

export const toggleChannelDialogReactionRequestSchema = z.object({
  token: z.string().trim().min(16).max(256),
  emoji: z.string().trim().min(1).max(16),
});
export type ToggleChannelDialogReactionRequest = z.infer<
  typeof toggleChannelDialogReactionRequestSchema
>;

export const toggleChannelDialogReactionResponseSchema = z.object({
  ok: z.boolean(),
  message: channelDialogMessageSchema,
});
export type ToggleChannelDialogReactionResponse = z.infer<
  typeof toggleChannelDialogReactionResponseSchema
>;

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
