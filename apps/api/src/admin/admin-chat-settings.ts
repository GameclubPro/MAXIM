import {
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
  botSpeechMediaSchema,
  chatSettingsSchema,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  normalizeMessageLimitsBlockedDomainCandidate,
  normalizeMessageLimitsBlockedWordCandidate,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
  type BroadcastLinkButton,
  type BotSpeechMedia,
  type ChatSettings,
} from '@maxim/contracts';
import { BadRequestException, type Logger } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CHAT_SETTINGS_BUTTON_GROUPS,
  DEFAULT_CHAT_SETTINGS,
  type AdminActionSource,
} from './admin.service.support';
import { buildStoredLinkButtonState } from './admin-chat-rules';

function readLegacyPrimaryAdminCommandName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  return value
    .split(',')
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .find((item) => item.length > 0) ?? fallback;
}

export type ChatSettingsCurrentState = Pick<
  ChatSettings,
  | 'nightModeForceCloseEnabled'
  | 'nightModeForceCloseForever'
  | 'nightModeForceCloseHours'
  | 'nightModeForceCloseDays'
  | 'nightModeForceCloseUntil'
>;

export type ResolvedBotAssignmentData = {
  botId?: string;
  primaryBotId?: string;
};

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  settings: Pick<
    ChatSettings,
    | 'requiredSubscriptionEnabled'
    | 'requiredSubscriptionChannelIds'
  >,
): boolean {
  return (
    settings.requiredSubscriptionEnabled &&
    settings.requiredSubscriptionChannelIds.length > 0
  );
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
        normalizeMessageLimitsBlockedLists(
          normalizeRequiredSubscriptionSettings(settings),
        ),
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

  return normalizedSettings;
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
      ...params.botAssignmentData,
      settings: {
        create: {},
      },
    },
    update: {
      ...params.botAssignmentData,
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
      await params.prisma.chatSettings.update({
        where: { chatId: params.chatId },
        data: normalizationChanges,
      });
      await params.chatContextCache.invalidate(params.chatId);
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
  await params.prisma.chatSettings.update({
    where: { chatId: params.chatId },
    data: {
      ...fallback,
    },
  });
  await params.chatContextCache.invalidate(params.chatId);

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
  assertRequiredSubscriptionSettings: (settings: ChatSettings) => Promise<void>;
  refreshExecutionReadiness: (settings: ChatSettings) => Promise<void>;
}): Promise<ChatSettings> {
  const parsed = chatSettingsSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const currentSettings = await params.prisma.chatSettings.findUnique({
    where: { chatId: params.chatId },
    select: {
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: true,
      nightModeForceCloseHours: true,
      nightModeForceCloseDays: true,
      nightModeForceCloseUntil: true,
    },
  });
  const normalizedSettings = normalizeChatSettings(
    parsed.data,
    {
      nightModeForceCloseEnabled: currentSettings?.nightModeForceCloseEnabled ?? false,
      nightModeForceCloseForever: currentSettings?.nightModeForceCloseForever ?? false,
      nightModeForceCloseHours: currentSettings?.nightModeForceCloseHours ?? 0,
      nightModeForceCloseDays: currentSettings?.nightModeForceCloseDays ?? 0,
      nightModeForceCloseUntil: currentSettings?.nightModeForceCloseUntil ?? '',
    },
    params.chatId,
  );
  await params.assertRequiredSubscriptionSettings(normalizedSettings);
  const botAssignmentData = await params.resolveBotAssignmentData();

  await params.prisma.chat.upsert({
    where: { id: params.chatId },
    create: {
      id: params.chatId,
      title: `Chat ${params.chatId}`,
      entityType: ChatEntityType.CHAT,
      ...botAssignmentData,
      settings: {
        create: {
          ...normalizedSettings,
        },
      },
    },
    update: {
      ...botAssignmentData,
      settings: {
        upsert: {
          update: {
            ...normalizedSettings,
          },
          create: {
            ...normalizedSettings,
          },
        },
      },
    },
  });

  await params.prisma.auditLog.create({
    data: {
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      action: 'UPDATE_SETTINGS',
      payload: {
        ...normalizedSettings,
        source: params.source,
      },
    },
  });
  await params.chatContextCache.invalidate(params.chatId);
  await params.refreshExecutionReadiness(normalizedSettings);

  return normalizedSettings;
}
