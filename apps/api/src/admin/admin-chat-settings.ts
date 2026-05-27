import {
  chatSettingsSchema,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT,
  normalizeMessageLimitsBlockedDomainCandidate,
  normalizeMessageLimitsBlockedWordCandidate,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
  type BroadcastLinkButton,
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
  REQUIRED_SUBSCRIPTION_DURATION_DAY_MS,
} from './admin.service.support';
import { buildStoredLinkButtonState } from './admin-chat-rules';

export type ChatSettingsCurrentState = Pick<
  ChatSettings,
  | 'nightModeForceCloseEnabled'
  | 'nightModeForceCloseForever'
  | 'nightModeForceCloseHours'
  | 'nightModeForceCloseDays'
  | 'nightModeForceCloseUntil'
  | 'requiredSubscriptionEnabled'
  | 'requiredSubscriptionChannelIds'
  | 'requiredSubscriptionDurationDays'
  | 'requiredSubscriptionExpiresAt'
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

export function normalizeRequiredSubscriptionExpiresAt(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value.trim();
  if (!normalized) {
    return '';
  }

  const timestampMs = Date.parse(normalized);
  if (!Number.isFinite(timestampMs)) {
    return '';
  }

  return new Date(timestampMs).toISOString();
}

export function hasRequiredSubscriptionExpired(
  settings: Pick<ChatSettings, 'requiredSubscriptionExpiresAt'>,
): boolean {
  const expiresAt = normalizeRequiredSubscriptionExpiresAt(settings.requiredSubscriptionExpiresAt);
  if (!expiresAt) {
    return false;
  }

  return Date.parse(expiresAt) <= Date.now();
}

export function isRequiredSubscriptionCurrentlyActive(
  settings: Pick<
    ChatSettings,
    | 'requiredSubscriptionEnabled'
    | 'requiredSubscriptionChannelIds'
    | 'requiredSubscriptionExpiresAt'
  >,
): boolean {
  return (
    settings.requiredSubscriptionEnabled &&
    settings.requiredSubscriptionChannelIds.length > 0 &&
    !hasRequiredSubscriptionExpired(settings)
  );
}

function buildRequiredSubscriptionExpiresAt(durationDays: number): string {
  return new Date(Date.now() + durationDays * REQUIRED_SUBSCRIPTION_DURATION_DAY_MS).toISOString();
}

function resolveRequiredSubscriptionExpiresAt(
  settings: Pick<
    ChatSettings,
    | 'requiredSubscriptionEnabled'
    | 'requiredSubscriptionChannelIds'
    | 'requiredSubscriptionDurationDays'
    | 'requiredSubscriptionExpiresAt'
  >,
  currentState?: Pick<
    ChatSettings,
    | 'requiredSubscriptionEnabled'
    | 'requiredSubscriptionChannelIds'
    | 'requiredSubscriptionDurationDays'
    | 'requiredSubscriptionExpiresAt'
  > | null,
  options?: {
    resetRequiredSubscriptionExpiration?: boolean;
  },
): string {
  if (!settings.requiredSubscriptionEnabled || settings.requiredSubscriptionChannelIds.length === 0) {
    return '';
  }

  if (options?.resetRequiredSubscriptionExpiration) {
    return buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
  }

  if (currentState === undefined) {
    return normalizeRequiredSubscriptionExpiresAt(settings.requiredSubscriptionExpiresAt);
  }

  if (!currentState?.requiredSubscriptionEnabled) {
    return buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
  }

  const currentExpiresAt = normalizeRequiredSubscriptionExpiresAt(
    currentState.requiredSubscriptionExpiresAt,
  );
  if (!currentExpiresAt || hasRequiredSubscriptionExpired(currentState)) {
    return buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
  }

  if (currentState.requiredSubscriptionDurationDays !== settings.requiredSubscriptionDurationDays) {
    return buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
  }

  if (
    currentState.requiredSubscriptionChannelIds.length !==
    settings.requiredSubscriptionChannelIds.length
  ) {
    return buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
  }

  for (const [index, channelId] of settings.requiredSubscriptionChannelIds.entries()) {
    if (currentState.requiredSubscriptionChannelIds[index] !== channelId) {
      return buildRequiredSubscriptionExpiresAt(settings.requiredSubscriptionDurationDays);
    }
  }

  return currentExpiresAt;
}

function normalizeRequiredSubscriptionSettings(
  settings: ChatSettings,
  currentState?: Pick<
    ChatSettings,
    | 'requiredSubscriptionEnabled'
    | 'requiredSubscriptionChannelIds'
    | 'requiredSubscriptionDurationDays'
    | 'requiredSubscriptionExpiresAt'
  > | null,
  options?: {
    resetRequiredSubscriptionExpiration?: boolean;
  },
): ChatSettings {
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
  const requiredSubscriptionEnabled =
    settings.requiredSubscriptionEnabled && requiredSubscriptionChannelIds.length > 0;
  const requiredSubscriptionExpiresAt = requiredSubscriptionEnabled
    ? resolveRequiredSubscriptionExpiresAt(
        {
          ...settings,
          requiredSubscriptionEnabled,
          requiredSubscriptionChannelIds,
          requiredSubscriptionDurationDays,
          requiredSubscriptionExpiresAt: settings.requiredSubscriptionExpiresAt,
        },
        currentState,
        options,
      )
    : '';

  return {
    ...settings,
    requiredSubscriptionEnabled,
    requiredSubscriptionChannelIds,
    requiredSubscriptionDurationDays,
    requiredSubscriptionExpiresAt,
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
  options?: {
    resetRequiredSubscriptionExpiration?: boolean;
  },
): ChatSettings {
  const normalized = normalizeNightModeSettings(
    normalizeInvitationAccessSettings(
      normalizeMessageLimitsBlockedLists(
        normalizeRequiredSubscriptionSettings(settings, currentState, options),
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
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: true,
      requiredSubscriptionDurationDays: true,
      requiredSubscriptionExpiresAt: true,
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
      requiredSubscriptionEnabled: currentSettings?.requiredSubscriptionEnabled ?? false,
      requiredSubscriptionChannelIds: Array.isArray(currentSettings?.requiredSubscriptionChannelIds)
        ? currentSettings.requiredSubscriptionChannelIds
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [],
      requiredSubscriptionDurationDays:
        currentSettings?.requiredSubscriptionDurationDays ??
        REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT,
      requiredSubscriptionExpiresAt: normalizeRequiredSubscriptionExpiresAt(
        currentSettings?.requiredSubscriptionExpiresAt,
      ),
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
