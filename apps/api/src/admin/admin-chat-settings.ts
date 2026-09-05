import {
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
  ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
  botSpeechMediaSchema,
  chatSettingsSchema,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  normalizeHttpButtonUrl,
  normalizeMessageLimitsBlockedDomainCandidate,
  normalizeMessageLimitsBlockedWordCandidate,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
  updateSettingsRequestSchema,
  type BroadcastLinkButton,
  type BotSpeechMedia,
  type ChatSettings,
} from '@maxim/contracts';
import { BadRequestException, ConflictException, type Logger } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { ChatCatalogKind, ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CHAT_SETTINGS_BUTTON_GROUPS,
  DEFAULT_CHAT_SETTINGS,
  type AdminActionSource,
} from './admin.service.support';
import { buildStoredLinkButtonState } from './admin-chat-rules';
import {
  DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS,
  omitPublisherOwnedChatSettings,
} from './publisher-owned-chat-settings';
import {
  CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
  resolveChatSettingsBotCapabilityRequirements,
  type ChatSettingsBotCapabilityRequirement,
} from './chat-settings-bot-capability';

function readLegacyPrimaryAdminCommandName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  return (
    value
      .split(',')
      .map((item) => item.trim().replace(/\s+/g, ' '))
      .find((item) => item.length > 0) ?? fallback
  );
}

export type ChatSettingsCurrentState = Pick<
  ChatSettings,
  | 'nightModeForceCloseEnabled'
  | 'nightModeForceCloseForever'
  | 'nightModeForceCloseHours'
  | 'nightModeForceCloseDays'
  | 'nightModeForceCloseUntil'
>;

// Compatibility data for Chat create branches; existing routes are owned by MaxBotLinkService.
export type ResolvedBotAssignmentData = {
  botId?: string;
  primaryBotId?: string;
};

export const UPDATE_SETTINGS_AUDIT_PAYLOAD_MAX_SERIALIZED_BYTES = 16 * 1024;

type UpdateSettingsAuditMediaEntry = {
  key: string;
  mimeType: string | null;
  byteCount: number;
};

export type UpdateSettingsAuditPayload = {
  source: AdminActionSource;
  settingKeys: Array<keyof ChatSettings>;
  botSpeechMedia?: UpdateSettingsAuditMediaEntry[];
};

const CHAT_SETTINGS_ADMIN_CONTACT_BUTTON_GROUPS = [
  {
    enabled: 'requiredSubscriptionAdminContactButtonEnabled',
    url: 'requiredSubscriptionAdminContactButtonUrl',
  },
  {
    enabled: 'invitationAccessAdminContactButtonEnabled',
    url: 'invitationAccessAdminContactButtonUrl',
  },
  {
    enabled: 'messageLimitsAdminContactButtonEnabled',
    url: 'messageLimitsAdminContactButtonUrl',
  },
  {
    enabled: 'phoneNumbersAdminContactButtonEnabled',
    url: 'phoneNumbersAdminContactButtonUrl',
  },
  {
    enabled: 'profanityAdminContactButtonEnabled',
    url: 'profanityAdminContactButtonUrl',
  },
  {
    enabled: 'textFiltersAdminContactButtonEnabled',
    url: 'textFiltersAdminContactButtonUrl',
  },
  {
    enabled: 'linkAdminContactButtonEnabled',
    url: 'linkAdminContactButtonUrl',
  },
  {
    enabled: 'duplicateAdminContactButtonEnabled',
    url: 'duplicateAdminContactButtonUrl',
  },
] as const;

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAdminContactButtonUrl(value: unknown): string {
  const trimmed = readTrimmedString(value);
  return trimmed ? (normalizeHttpButtonUrl(trimmed) ?? '') : '';
}

export function areBroadcastButtonsEqual(
  left: readonly BroadcastLinkButton[],
  right: unknown,
): boolean {
  if (!Array.isArray(right)) {
    return left.length === 0;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every((button, index) => {
    const candidate = right[index];
    if (!candidate || typeof candidate !== 'object') {
      return false;
    }

    const row = candidate as { text?: unknown; url?: unknown };
    return row.text === button.text && row.url === button.url;
  });
}

export function isRequiredSubscriptionCurrentlyActive(
  settings: Pick<ChatSettings, 'requiredSubscriptionEnabled' | 'requiredSubscriptionChannelIds'>,
): boolean {
  return settings.requiredSubscriptionEnabled && settings.requiredSubscriptionChannelIds.length > 0;
}

function normalizeRequiredSubscriptionSettings(settings: ChatSettings): ChatSettings {
  const requiredSubscriptionChannelIds = Array.from(
    new Set(
      settings.requiredSubscriptionChannelIds
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
  const requiredSubscriptionDurationDays = Math.min(
    REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
    Math.max(
      REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
      Math.round(Number(settings.requiredSubscriptionDurationDays)),
    ),
  );
  const requiredSubscriptionEnabled = requiredSubscriptionChannelIds.length > 0;

  return {
    ...settings,
    requiredSubscriptionEnabled,
    requiredSubscriptionChannelIds,
    requiredSubscriptionBotMessageEnabled: requiredSubscriptionEnabled,
    requiredSubscriptionDurationDays,
    requiredSubscriptionExpiresAt: '',
  };
}

function normalizeInvitationAccessSettings(settings: ChatSettings): ChatSettings {
  const invitationAccessRequiredCount = Math.min(
    INVITATION_ACCESS_REQUIRED_COUNT_MAX,
    Math.max(
      INVITATION_ACCESS_REQUIRED_COUNT_MIN,
      Math.round(Number(settings.invitationAccessRequiredCount)),
    ),
  );

  return { ...settings, invitationAccessEnabled: false, invitationAccessRequiredCount };
}

function normalizeMessageLimitsBlockedLists(settings: ChatSettings): ChatSettings {
  const messageLimitsBlockedWords = Array.from(
    new Set(
      settings.messageLimitsBlockedWords.flatMap(
        (item) => normalizeMessageLimitsBlockedWordCandidate(item) ?? [],
      ),
    ),
  );
  const messageLimitsBlockedDomains = Array.from(
    new Set(
      settings.messageLimitsBlockedDomains.flatMap(
        (item) => normalizeMessageLimitsBlockedDomainCandidate(item) ?? [],
      ),
    ),
  );
  return {
    ...settings,
    messageLimitsBlockedWords,
    messageLimitsBlockedDomains,
  };
}

function areBotSpeechMediaEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function readBotSpeechMediaRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readAuditMediaEntry(value: unknown): { base64: string; mimeType: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const media = value as Record<string, unknown>;
  return {
    base64: typeof media.base64 === 'string' ? media.base64 : '',
    mimeType: typeof media.mimeType === 'string' ? media.mimeType : '',
  };
}

export function buildUpdateSettingsAuditPayload(params: {
  requestedSettings: unknown;
  normalizedSettings: ChatSettings;
  source: AdminActionSource;
}): UpdateSettingsAuditPayload {
  const requested =
    params.requestedSettings &&
    typeof params.requestedSettings === 'object' &&
    !Array.isArray(params.requestedSettings)
      ? (params.requestedSettings as Record<string, unknown>)
      : {};
  const normalizedKeySet = new Set(Object.keys(params.normalizedSettings));
  const settingKeys = (Object.keys(requested) as Array<keyof ChatSettings>)
    .filter((key) => normalizedKeySet.has(key))
    .sort();
  const payload: UpdateSettingsAuditPayload = {
    source: params.source,
    settingKeys,
  };

  if (!settingKeys.includes('botSpeechMedia')) {
    return payload;
  }

  const requestedMedia = readBotSpeechMediaRecord(requested.botSpeechMedia);
  const nextMedia = readBotSpeechMediaRecord(params.normalizedSettings.botSpeechMedia);
  const mediaKeys = Object.keys(requestedMedia)
    .filter((key) => Object.hasOwn(nextMedia, key))
    .sort();
  payload.botSpeechMedia = mediaKeys.map((key) => {
    const media = readAuditMediaEntry(nextMedia[key]);
    return {
      key,
      mimeType: media?.mimeType || null,
      byteCount: media ? Buffer.byteLength(media.base64, 'base64') : 0,
    };
  });

  return payload;
}

function normalizeBotSpeechMedia(settings: ChatSettings): ChatSettings {
  const parsed = botSpeechMediaSchema.safeParse(settings.botSpeechMedia);
  const botSpeechMedia: BotSpeechMedia = parsed.success ? parsed.data : {};
  return areBotSpeechMediaEqual(settings.botSpeechMedia, botSpeechMedia)
    ? settings
    : {
        ...settings,
        botSpeechMedia,
      };
}

function isFutureIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function normalizeNightModeForceCloseSettings(
  settings: ChatSettings,
  currentState?: Pick<
    ChatSettings,
    | 'nightModeForceCloseEnabled'
    | 'nightModeForceCloseForever'
    | 'nightModeForceCloseHours'
    | 'nightModeForceCloseDays'
    | 'nightModeForceCloseUntil'
  > | null,
): ChatSettings {
  if (!settings.nightModeForceCloseEnabled) {
    return settings.nightModeForceCloseUntil
      ? {
          ...settings,
          nightModeForceCloseUntil: '',
        }
      : settings;
  }

  if (settings.nightModeForceCloseForever) {
    return settings.nightModeForceCloseUntil
      ? {
          ...settings,
          nightModeForceCloseUntil: '',
        }
      : settings;
  }

  const totalHours = settings.nightModeForceCloseDays * 24 + settings.nightModeForceCloseHours;
  if (totalHours <= 0) {
    return {
      ...settings,
      nightModeForceCloseEnabled: false,
      nightModeForceCloseUntil: '',
    };
  }

  if (!currentState) {
    return isFutureIsoTimestamp(settings.nightModeForceCloseUntil)
      ? settings
      : {
          ...settings,
          nightModeForceCloseEnabled: false,
          nightModeForceCloseUntil: '',
        };
  }

  const currentUntil = currentState?.nightModeForceCloseUntil ?? '';
  const shouldRefreshUntil =
    !currentState?.nightModeForceCloseEnabled ||
    currentState.nightModeForceCloseForever ||
    currentState.nightModeForceCloseHours !== settings.nightModeForceCloseHours ||
    currentState.nightModeForceCloseDays !== settings.nightModeForceCloseDays ||
    !isFutureIsoTimestamp(currentUntil);

  const nextUntil = shouldRefreshUntil
    ? new Date(Date.now() + totalHours * 60 * 60 * 1_000).toISOString()
    : currentUntil;

  return {
    ...settings,
    nightModeForceCloseUntil: nextUntil,
  };
}

function normalizeNightModeSettings(
  settings: ChatSettings,
  currentState?: Pick<
    ChatSettings,
    | 'nightModeForceCloseEnabled'
    | 'nightModeForceCloseForever'
    | 'nightModeForceCloseHours'
    | 'nightModeForceCloseDays'
    | 'nightModeForceCloseUntil'
  > | null,
): ChatSettings {
  let normalized = settings;

  if (!normalized.nightModeEnabled) {
    normalized = {
      ...normalized,
      nightModeBotMessageEnabled: false,
      nightModeCommentsEnabled: false,
      nightModeBotButtonEnabled: false,
      nightModeRulesButtonEnabled: false,
    };
  } else if (!normalized.nightModeBotMessageEnabled) {
    normalized = {
      ...normalized,
      nightModeCommentsEnabled: false,
      nightModeBotButtonEnabled: false,
      nightModeRulesButtonEnabled: false,
    };
  }

  return normalizeNightModeForceCloseSettings(normalized, currentState);
}

export function normalizeChatSettingsButtonUrls(settings: ChatSettings): ChatSettings {
  let normalizedSettings = settings;

  for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
    const buttonState = buildStoredLinkButtonState(normalizedSettings[group.buttons], {
      buttonUrl: normalizedSettings[group.url],
      buttonText: normalizedSettings[group.text],
    });
    const shouldDisableButton =
      buttonState.buttons.length === 0 && normalizedSettings[group.enabled];
    if (
      !areBroadcastButtonsEqual(buttonState.buttons, normalizedSettings[group.buttons]) ||
      buttonState.buttonUrl !== normalizedSettings[group.url] ||
      buttonState.buttonText !== normalizedSettings[group.text] ||
      shouldDisableButton
    ) {
      normalizedSettings = {
        ...normalizedSettings,
        [group.buttons]: buttonState.buttons,
        [group.url]: buttonState.buttonUrl,
        [group.text]: buttonState.buttonText,
        ...(shouldDisableButton ? { [group.enabled]: false } : {}),
      };
    }
  }

  for (const group of CHAT_SETTINGS_ADMIN_CONTACT_BUTTON_GROUPS) {
    const currentUrl = normalizedSettings[group.url];
    const normalizedUrl = normalizeAdminContactButtonUrl(currentUrl);
    const shouldDisableButton =
      normalizedSettings[group.enabled] === true && normalizedUrl.length === 0;
    if (currentUrl !== normalizedUrl || shouldDisableButton) {
      normalizedSettings = {
        ...normalizedSettings,
        [group.url]: normalizedUrl,
        ...(shouldDisableButton ? { [group.enabled]: false } : {}),
      };
    }
  }

  return normalizedSettings;
}

export function normalizeChatSettings(
  settings: ChatSettings,
  currentState?: ChatSettingsCurrentState | null,
  chatId?: string,
): ChatSettings {
  const normalized = normalizeNightModeSettings(
    normalizeBotSpeechMedia(
      normalizeInvitationAccessSettings(
        normalizeMessageLimitsBlockedLists(normalizeRequiredSubscriptionSettings(settings)),
      ),
    ),
    currentState,
  );

  return chatId ? normalizeChatSettingsButtonUrls(normalized) : normalized;
}

export function sanitizeStoredChatSettings(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return settings;
  }

  let normalizedSettings = settings as Record<string, unknown>;

  if (typeof normalizedSettings.adminBanCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminBanCommandName: ADMIN_BAN_COMMAND_NAME_DEFAULT,
    };
  }
  if (typeof normalizedSettings.adminBanAllCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminBanAllCommandName: ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
    };
  }
  if (typeof normalizedSettings.adminMuteCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminMuteCommandName: readLegacyPrimaryAdminCommandName(
        normalizedSettings.adminMuteCommandAliases,
        ADMIN_MUTE_COMMAND_NAME_DEFAULT,
      ),
    };
  }
  if (typeof normalizedSettings.adminPermanentMuteCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminPermanentMuteCommandName: ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
    };
  }
  if (typeof normalizedSettings.adminRulesCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminRulesCommandName: readLegacyPrimaryAdminCommandName(
        normalizedSettings.adminRulesCommandAliases,
        ADMIN_RULES_COMMAND_NAME_DEFAULT,
      ),
    };
  }
  if (typeof normalizedSettings.adminSilenceCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminSilenceCommandName: ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
    };
  }
  if (typeof normalizedSettings.adminOpenChatCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminOpenChatCommandName: ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
    };
  }

  for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
    const buttonState = buildStoredLinkButtonState(normalizedSettings[group.buttons], {
      buttonUrl: normalizedSettings[group.url] as string | null | undefined,
      buttonText: normalizedSettings[group.text] as string | null | undefined,
    });
    const enabled = normalizedSettings[group.enabled] === true;
    const shouldDisableButton = enabled && buttonState.buttons.length === 0;
    const currentUrl = normalizedSettings[group.url];
    const currentText = normalizedSettings[group.text];
    const currentButtons = normalizedSettings[group.buttons];

    if (
      !areBroadcastButtonsEqual(buttonState.buttons, currentButtons) ||
      currentUrl !== buttonState.buttonUrl ||
      currentText !== buttonState.buttonText ||
      shouldDisableButton
    ) {
      normalizedSettings = {
        ...normalizedSettings,
        [group.buttons]: buttonState.buttons,
        [group.url]: buttonState.buttonUrl,
        [group.text]: buttonState.buttonText,
        ...(shouldDisableButton ? { [group.enabled]: false } : {}),
      };
    }
  }

  for (const group of CHAT_SETTINGS_ADMIN_CONTACT_BUTTON_GROUPS) {
    const currentUrl = normalizedSettings[group.url];
    const normalizedUrl = normalizeAdminContactButtonUrl(currentUrl);
    const shouldDisableButton =
      normalizedSettings[group.enabled] === true && normalizedUrl.length === 0;
    if (currentUrl !== normalizedUrl || shouldDisableButton) {
      normalizedSettings = {
        ...normalizedSettings,
        [group.url]: normalizedUrl,
        ...(shouldDisableButton ? { [group.enabled]: false } : {}),
      };
    }
  }

  return normalizedSettings;
}

export type PublicChatCommentSettings = Pick<
  ChatSettings,
  | 'commentsEnabled'
  | 'commentsAdminsEnabled'
  | 'commentsAllEnabled'
  | 'commentsChatBroadcastsEnabled'
>;

export async function readPublicChatCommentSettings(
  prisma: PrismaService,
  chatId: string,
): Promise<PublicChatCommentSettings> {
  const settings = await prisma.chatSettings.findUnique({ where: { chatId } });
  const parsed = settings
    ? chatSettingsSchema.safeParse(sanitizeStoredChatSettings(settings))
    : null;
  const normalized = parsed?.success
    ? normalizeChatSettings(parsed.data, undefined, chatId)
    : DEFAULT_CHAT_SETTINGS;
  return {
    commentsEnabled: normalized.commentsEnabled,
    commentsAdminsEnabled: normalized.commentsAdminsEnabled,
    commentsAllEnabled: normalized.commentsAllEnabled,
    commentsChatBroadcastsEnabled: normalized.commentsChatBroadcastsEnabled,
  };
}

export function getChatSettingsNormalizationChanges(
  current: ChatSettings,
  normalized: ChatSettings,
): Partial<ChatSettings> {
  const changes: Partial<ChatSettings> = {};

  for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
    if (!areBroadcastButtonsEqual(normalized[group.buttons], current[group.buttons])) {
      changes[group.buttons] = normalized[group.buttons];
    }
    if (current[group.url] !== normalized[group.url]) {
      changes[group.url] = normalized[group.url];
    }
    if (current[group.text] !== normalized[group.text]) {
      changes[group.text] = normalized[group.text];
    }
    if (current[group.enabled] !== normalized[group.enabled]) {
      changes[group.enabled] = normalized[group.enabled];
    }
  }

  if (current.nightModeBotMessageEnabled !== normalized.nightModeBotMessageEnabled) {
    changes.nightModeBotMessageEnabled = normalized.nightModeBotMessageEnabled;
  }
  if (current.nightModeCommentsEnabled !== normalized.nightModeCommentsEnabled) {
    changes.nightModeCommentsEnabled = normalized.nightModeCommentsEnabled;
  }
  if (current.nightModeBotButtonEnabled !== normalized.nightModeBotButtonEnabled) {
    changes.nightModeBotButtonEnabled = normalized.nightModeBotButtonEnabled;
  }
  if (current.nightModeRulesButtonEnabled !== normalized.nightModeRulesButtonEnabled) {
    changes.nightModeRulesButtonEnabled = normalized.nightModeRulesButtonEnabled;
  }
  if (current.nightModeForceCloseEnabled !== normalized.nightModeForceCloseEnabled) {
    changes.nightModeForceCloseEnabled = normalized.nightModeForceCloseEnabled;
  }
  if (current.nightModeForceCloseUntil !== normalized.nightModeForceCloseUntil) {
    changes.nightModeForceCloseUntil = normalized.nightModeForceCloseUntil;
  }
  if (
    current.requiredSubscriptionBotMessageEnabled !==
    normalized.requiredSubscriptionBotMessageEnabled
  ) {
    changes.requiredSubscriptionBotMessageEnabled =
      normalized.requiredSubscriptionBotMessageEnabled;
  }
  if (!areBotSpeechMediaEqual(current.botSpeechMedia, normalized.botSpeechMedia)) {
    changes.botSpeechMedia = normalized.botSpeechMedia;
  }

  return changes;
}

export function getStoredChatSettingsSanitizationChanges(
  current: unknown,
  sanitized: ChatSettings,
): Partial<ChatSettings> {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return {};
  }

  const currentSettings = current as Record<string, unknown>;
  const changes: Partial<ChatSettings> = {};
  if (!areBotSpeechMediaEqual(currentSettings.botSpeechMedia, sanitized.botSpeechMedia)) {
    changes.botSpeechMedia = sanitized.botSpeechMedia;
  }

  for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
    if (!areBroadcastButtonsEqual(sanitized[group.buttons], currentSettings[group.buttons])) {
      changes[group.buttons] = sanitized[group.buttons];
    }

    const currentUrl = readTrimmedString(currentSettings[group.url]) ?? '';
    if (currentUrl !== sanitized[group.url]) {
      changes[group.url] = sanitized[group.url];
    }

    const currentText = readTrimmedString(currentSettings[group.text]) ?? '';
    if (currentText !== sanitized[group.text]) {
      changes[group.text] = sanitized[group.text];
    }

    const currentEnabled = currentSettings[group.enabled] === true;
    if (currentEnabled !== sanitized[group.enabled]) {
      changes[group.enabled] = sanitized[group.enabled];
    }
  }

  for (const group of CHAT_SETTINGS_ADMIN_CONTACT_BUTTON_GROUPS) {
    const currentUrl = readTrimmedString(currentSettings[group.url]) ?? '';
    if (currentUrl !== sanitized[group.url]) {
      changes[group.url] = sanitized[group.url];
    }

    const currentEnabled = currentSettings[group.enabled] === true;
    if (currentEnabled !== sanitized[group.enabled]) {
      changes[group.enabled] = sanitized[group.enabled];
    }
  }

  return changes;
}

export async function readChatSettings(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  botAssignmentData?: ResolvedBotAssignmentData;
}): Promise<ChatSettings> {
  const chat = await params.prisma.chat.upsert({
    where: { id: params.chatId },
    create: {
      id: params.chatId,
      title: `Chat ${params.chatId}`,
      entityType: ChatEntityType.CHAT,
      catalogKind: ChatCatalogKind.MANAGED,
      ...params.botAssignmentData,
      settings: {
        create: {},
      },
    },
    update: {
      catalogKind: ChatCatalogKind.MANAGED,
      settings: {
        upsert: {
          update: {},
          create: {},
        },
      },
    },
    include: { settings: true },
  });

  if (!chat.settings) {
    throw new Error('Chat settings missing after upsert');
  }

  const sanitizedStoredSettings = sanitizeStoredChatSettings(chat.settings);
  const parsed = chatSettingsSchema.safeParse(sanitizedStoredSettings);
  if (parsed.success) {
    const normalizedSettings = normalizeChatSettings(parsed.data, undefined, params.chatId);
    const normalizationChanges = {
      ...getStoredChatSettingsSanitizationChanges(chat.settings, parsed.data),
      ...getChatSettingsNormalizationChanges(parsed.data, normalizedSettings),
    };
    if (Object.keys(normalizationChanges).length > 0) {
      const repaired = await params.prisma.chatSettings.updateMany({
        where: { chatId: params.chatId, updatedAt: chat.settings.updatedAt },
        data: normalizationChanges,
      });
      if (repaired.count > 0) {
        await params.chatContextCache.invalidate(params.chatId);
      }
    }

    return normalizedSettings;
  }

  params.logger.warn(
    {
      chatId: params.chatId,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
    'Invalid chat settings found in DB, applying defaults',
  );

  const fallback = DEFAULT_CHAT_SETTINGS;
  const repaired = await params.prisma.chatSettings.updateMany({
    where: { chatId: params.chatId, updatedAt: chat.settings.updatedAt },
    data: {
      ...fallback,
    },
  });
  if (repaired.count > 0) {
    await params.chatContextCache.invalidate(params.chatId);
  }

  return fallback;
}

export async function saveChatSettings(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  chatId: string;
  actorUserId: string;
  body: unknown;
  source: AdminActionSource;
  resolveBotAssignmentData: () => Promise<ResolvedBotAssignmentData> | ResolvedBotAssignmentData;
  assertRequiredSubscriptionSettings: (settings: ChatSettings) => Promise<ChatSettings | void>;
  assertBotCapabilities: (
    requirements: readonly ChatSettingsBotCapabilityRequirement[],
  ) => Promise<void>;
  refreshExecutionReadiness: (
    settings: ChatSettings,
    options?: { skipManagedEntityBotRefresh?: boolean },
  ) => Promise<void>;
}): Promise<ChatSettings> {
  const parsed = updateSettingsRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const currentSettings = await params.prisma.chatSettings.findUnique({
    where: { chatId: params.chatId },
    select: {
      ...CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
      duplicatePhotoMatchPreset: true,
      duplicatePhotoScope: true,
      duplicateDetectionPreset: true,
      duplicateIgnoreLinksEnabled: true,
      duplicateIgnorePhonesEnabled: true,
      duplicateNearMatchEnabled: true,
      profanitySensitivity: true,
      nightModeForceCloseForever: true,
      nightModeForceCloseHours: true,
      nightModeForceCloseDays: true,
      nightModeForceCloseUntil: true,
      karavanStorefrontEnabled: true,
      karavanStorefrontAdminsOnly: true,
      forwardedMessagesEnabled: true,
      updatedAt: true,
    },
  });
  const settingsInput = {
    ...parsed.data,
    duplicatePhotoEnabled: hasOwnSetting(params.body, 'duplicatePhotoEnabled')
      ? parsed.data.duplicatePhotoEnabled
      : (currentSettings?.duplicatePhotoEnabled ?? parsed.data.duplicatePhotoEnabled),
    duplicatePhotoMatchPreset: hasOwnSetting(params.body, 'duplicatePhotoMatchPreset')
      ? parsed.data.duplicatePhotoMatchPreset
      : (currentSettings?.duplicatePhotoMatchPreset ?? parsed.data.duplicatePhotoMatchPreset),
    duplicatePhotoScope: hasOwnSetting(params.body, 'duplicatePhotoScope')
      ? parsed.data.duplicatePhotoScope
      : (currentSettings?.duplicatePhotoScope ?? parsed.data.duplicatePhotoScope),
    duplicateDetectionPreset: hasOwnSetting(params.body, 'duplicateDetectionPreset')
      ? parsed.data.duplicateDetectionPreset
      : (currentSettings?.duplicateDetectionPreset ?? parsed.data.duplicateDetectionPreset),
    duplicateIgnoreLinksEnabled: hasOwnSetting(params.body, 'duplicateIgnoreLinksEnabled')
      ? parsed.data.duplicateIgnoreLinksEnabled
      : (currentSettings?.duplicateIgnoreLinksEnabled ?? parsed.data.duplicateIgnoreLinksEnabled),
    duplicateIgnorePhonesEnabled: hasOwnSetting(params.body, 'duplicateIgnorePhonesEnabled')
      ? parsed.data.duplicateIgnorePhonesEnabled
      : (currentSettings?.duplicateIgnorePhonesEnabled ?? parsed.data.duplicateIgnorePhonesEnabled),
    duplicateNearMatchEnabled: hasOwnSetting(params.body, 'duplicateNearMatchEnabled')
      ? parsed.data.duplicateNearMatchEnabled
      : (currentSettings?.duplicateNearMatchEnabled ?? parsed.data.duplicateNearMatchEnabled),
    // Older clients omit settings introduced after their bundled contract.
    profanitySensitivity: hasOwnSetting(params.body, 'profanitySensitivity')
      ? parsed.data.profanitySensitivity
      : (currentSettings?.profanitySensitivity ?? parsed.data.profanitySensitivity),
    karavanStorefrontEnabled: hasOwnSetting(params.body, 'karavanStorefrontEnabled')
      ? parsed.data.karavanStorefrontEnabled
      : (currentSettings?.karavanStorefrontEnabled ?? parsed.data.karavanStorefrontEnabled),
    karavanStorefrontAdminsOnly: hasOwnSetting(params.body, 'karavanStorefrontAdminsOnly')
      ? parsed.data.karavanStorefrontAdminsOnly
      : (currentSettings?.karavanStorefrontAdminsOnly ?? parsed.data.karavanStorefrontAdminsOnly),
    forwardedMessagesEnabled: hasOwnSetting(params.body, 'forwardedMessagesEnabled')
      ? parsed.data.forwardedMessagesEnabled
      : (currentSettings?.forwardedMessagesEnabled ?? parsed.data.forwardedMessagesEnabled),
  };
  let normalizedSettings = normalizeChatSettings(
    settingsInput,
    {
      nightModeForceCloseEnabled: currentSettings?.nightModeForceCloseEnabled ?? false,
      nightModeForceCloseForever: currentSettings?.nightModeForceCloseForever ?? false,
      nightModeForceCloseHours: currentSettings?.nightModeForceCloseHours ?? 0,
      nightModeForceCloseDays: currentSettings?.nightModeForceCloseDays ?? 0,
      nightModeForceCloseUntil: currentSettings?.nightModeForceCloseUntil ?? '',
    },
    params.chatId,
  );
  normalizedSettings =
    (await params.assertRequiredSubscriptionSettings(normalizedSettings)) ?? normalizedSettings;
  const capabilityRequirements = resolveChatSettingsBotCapabilityRequirements({
    current: { ...DEFAULT_CHAT_SETTINGS, ...(currentSettings ?? {}) },
    next: normalizedSettings,
    requestedSettings: params.body,
  });
  if (capabilityRequirements.length > 0) {
    await params.assertBotCapabilities(capabilityRequirements);
  }
  const botAssignmentData = await params.resolveBotAssignmentData();
  // FLAG: Major never includes Publisher-owned comment fields in UPDATE, so concurrent Publisher
  // writes cannot be overwritten by a stale read-modify-write cycle.
  const majorOwnedSettings = omitPublisherOwnedChatSettings(normalizedSettings);
  const createSettings = {
    ...majorOwnedSettings,
    ...DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS,
  };

  try {
    await params.prisma.$transaction(async (tx) => {
      await tx.chat.upsert({
        where: { id: params.chatId },
        create: {
          id: params.chatId,
          title: `Chat ${params.chatId}`,
          entityType: ChatEntityType.CHAT,
          catalogKind: ChatCatalogKind.MANAGED,
          ...botAssignmentData,
        },
        update: { catalogKind: ChatCatalogKind.MANAGED },
      });
      if (currentSettings) {
        const changed = await tx.chatSettings.updateMany({
          where: { chatId: params.chatId, updatedAt: currentSettings.updatedAt },
          data: majorOwnedSettings,
        });
        if (changed.count !== 1) {
          throw chatSettingsRevisionConflict();
        }
      } else {
        await tx.chatSettings.create({
          data: { chatId: params.chatId, ...createSettings },
        });
      }
      await tx.auditLog.create({
        data: {
          chatId: params.chatId,
          actorUserId: params.actorUserId,
          action: 'UPDATE_SETTINGS',
          payload: buildUpdateSettingsAuditPayload({
            requestedSettings: params.body,
            normalizedSettings,
            source: params.source,
          }),
        },
      });
    });
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code === 'P2002') {
      throw chatSettingsRevisionConflict();
    }
    throw error;
  }
  const publisherOwnedSettings = await params.prisma.chatSettings.findUnique({
    where: { chatId: params.chatId },
    select: {
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: true,
      commentsChatBroadcastsEnabled: true,
    },
  });
  const resultingSettings = {
    ...normalizedSettings,
    commentsEnabled:
      publisherOwnedSettings?.commentsEnabled ??
      DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS.commentsEnabled,
    commentsAdminsEnabled:
      publisherOwnedSettings?.commentsAdminsEnabled ??
      DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS.commentsAdminsEnabled,
    commentsAllEnabled:
      publisherOwnedSettings?.commentsAllEnabled ??
      DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS.commentsAllEnabled,
    commentsChatBroadcastsEnabled:
      publisherOwnedSettings?.commentsChatBroadcastsEnabled ??
      DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS.commentsChatBroadcastsEnabled,
  };
  await params.chatContextCache.invalidate(params.chatId);
  if (capabilityRequirements.length > 0) {
    await params.refreshExecutionReadiness(resultingSettings, {
      skipManagedEntityBotRefresh: true,
    });
  } else {
    await params.refreshExecutionReadiness(resultingSettings);
  }

  return resultingSettings;
}

function chatSettingsRevisionConflict(): ConflictException {
  return new ConflictException({
    code: 'CHAT_SETTINGS_CONCURRENT_UPDATE',
    message: 'Настройки чата изменились параллельно. Обновите экран и повторите попытку.',
  });
}

function hasOwnSetting(body: unknown, key: string): boolean {
  return (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, key)
  );
}
