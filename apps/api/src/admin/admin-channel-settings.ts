import { channelSettingsSchema, type ChannelSettings } from '@maxim/contracts';
import { BadRequestException, type Logger } from '@nestjs/common';
import { ChatCatalogKind, ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY,
  CHANNEL_SETTINGS_BUTTON_URL_KEYS,
  DEFAULT_CHANNEL_SETTINGS,
  type AdminActionSource,
} from './admin.service.support';
import type { ResolvedBotAssignmentData } from './admin-chat-settings';
import { normalizeLegacyProfileButtonUrl } from './admin-profile-links';

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function sanitizeStoredChannelSettings(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return settings;
  }

  let normalizedSettings = settings as Record<string, unknown>;

  for (const key of CHANNEL_SETTINGS_BUTTON_URL_KEYS) {
    const normalizedUrl = normalizeLegacyProfileButtonUrl(
      normalizedSettings[key] as string | null | undefined,
    );
    const enabledKey = CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY[key];
    const shouldDisableButton =
      normalizedUrl.length === 0 && normalizedSettings[enabledKey] === true;
    if (normalizedUrl !== normalizedSettings[key] || shouldDisableButton) {
      normalizedSettings = {
        ...normalizedSettings,
        [key]: normalizedUrl,
        ...(shouldDisableButton ? { [enabledKey]: false } : {}),
      };
    }
  }

  return normalizedSettings;
}

export function normalizeChannelSettingsButtonUrls(settings: ChannelSettings): ChannelSettings {
  let normalizedSettings = settings;

  for (const key of CHANNEL_SETTINGS_BUTTON_URL_KEYS) {
    const normalizedUrl = normalizeLegacyProfileButtonUrl(settings[key]);
    const enabledKey = CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY[key];
    const shouldDisableButton = normalizedUrl.length === 0 && normalizedSettings[enabledKey];
    if (normalizedUrl !== normalizedSettings[key] || shouldDisableButton) {
      normalizedSettings = {
        ...normalizedSettings,
        [key]: normalizedUrl,
        ...(shouldDisableButton ? { [enabledKey]: false } : {}),
      };
    }
  }

  return normalizedSettings;
}

export function normalizeChannelSettings(
  settings: ChannelSettings,
  chatId?: string,
): ChannelSettings {
  const normalizedSettings = { ...settings };
  return chatId ? normalizeChannelSettingsButtonUrls(normalizedSettings) : normalizedSettings;
}

export function getStoredChannelSettingsSanitizationChanges(
  current: unknown,
  sanitized: ChannelSettings,
): Partial<ChannelSettings> {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return {};
  }

  const currentSettings = current as Record<string, unknown>;
  const changes: Partial<ChannelSettings> = {};

  for (const key of CHANNEL_SETTINGS_BUTTON_URL_KEYS) {
    const currentUrl = readTrimmedString(currentSettings[key]) ?? '';
    if (currentUrl !== sanitized[key]) {
      changes[key] = sanitized[key];
    }

    const enabledKey = CHANNEL_SETTINGS_BUTTON_ENABLED_BY_URL_KEY[key];
    const currentEnabled = currentSettings[enabledKey] === true;
    if (currentEnabled !== sanitized[enabledKey]) {
      changes[enabledKey] = sanitized[enabledKey];
    }
  }

  return changes;
}

export function getChannelSettingsNormalizationChanges(
  current: Pick<ChannelSettings, 'postSuggestionsButtonEnabled' | 'postSuggestionsButtonUrl'>,
  normalized: Pick<ChannelSettings, 'postSuggestionsButtonEnabled' | 'postSuggestionsButtonUrl'>,
): Partial<ChannelSettings> {
  const changes: Partial<ChannelSettings> = {};

  if (current.postSuggestionsButtonUrl !== normalized.postSuggestionsButtonUrl) {
    changes.postSuggestionsButtonUrl = normalized.postSuggestionsButtonUrl;
  }

  if (current.postSuggestionsButtonEnabled !== normalized.postSuggestionsButtonEnabled) {
    changes.postSuggestionsButtonEnabled = normalized.postSuggestionsButtonEnabled;
  }

  return changes;
}

export async function readChannelSettings(params: {
  prisma: PrismaService;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  botAssignmentData?: ResolvedBotAssignmentData;
}): Promise<ChannelSettings> {
  const chat = await params.prisma.chat.upsert({
    where: { id: params.chatId },
    create: {
      id: params.chatId,
      title: `Channel ${params.chatId}`,
      entityType: ChatEntityType.CHANNEL,
      catalogKind: ChatCatalogKind.MANAGED,
      ...params.botAssignmentData,
      channelSettings: {
        create: {
          commentsEnabled: false,
        },
      },
    },
    update: {
      entityType: ChatEntityType.CHANNEL,
      catalogKind: ChatCatalogKind.MANAGED,
      channelSettings: {
        upsert: {
          update: {},
          create: {
            commentsEnabled: false,
          },
        },
      },
    },
    include: { channelSettings: true },
  });

  if (!chat.channelSettings) {
    throw new Error('Channel settings missing after upsert');
  }

  const sanitizedStoredSettings = sanitizeStoredChannelSettings(chat.channelSettings);
  const parsed = channelSettingsSchema.safeParse(sanitizedStoredSettings);
  if (parsed.success) {
    const normalized = normalizeChannelSettings(parsed.data, params.chatId);
    const normalizationChanges = {
      ...getStoredChannelSettingsSanitizationChanges(chat.channelSettings, parsed.data),
      ...getChannelSettingsNormalizationChanges(parsed.data, normalized),
    };
    if (Object.keys(normalizationChanges).length > 0) {
      await params.prisma.channelSettings.updateMany({
        where: { chatId: params.chatId, updatedAt: chat.channelSettings.updatedAt },
        data: normalizationChanges,
      });
    }
    return normalized;
  }

  params.logger.warn(
    {
      chatId: params.chatId,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
    'Invalid channel settings found in DB, applying defaults',
  );

  await params.prisma.channelSettings.updateMany({
    where: { chatId: params.chatId, updatedAt: chat.channelSettings.updatedAt },
    data: {
      ...DEFAULT_CHANNEL_SETTINGS,
    },
  });

  return DEFAULT_CHANNEL_SETTINGS;
}

export async function saveChannelSettings(params: {
  prisma: PrismaService;
  chatContextCache: { invalidate(chatId: string): Promise<unknown> | unknown };
  chatId: string;
  actorUserId: string;
  body: unknown;
  source: AdminActionSource;
  resolveBotAssignmentData: () => Promise<ResolvedBotAssignmentData> | ResolvedBotAssignmentData;
  refreshExecutionReadiness: () => Promise<void>;
}): Promise<ChannelSettings> {
  const parsed = channelSettingsSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }
  const normalizedSettings = normalizeChannelSettings(parsed.data, params.chatId);
  const botAssignmentData = await params.resolveBotAssignmentData();
  const settingsToSave = normalizedSettings;

  await params.prisma.chat.upsert({
    where: { id: params.chatId },
    create: {
      id: params.chatId,
      title: `Channel ${params.chatId}`,
      entityType: ChatEntityType.CHANNEL,
      catalogKind: ChatCatalogKind.MANAGED,
      ...botAssignmentData,
      channelSettings: {
        create: {
          ...settingsToSave,
        },
      },
    },
    update: {
      entityType: ChatEntityType.CHANNEL,
      catalogKind: ChatCatalogKind.MANAGED,
      channelSettings: {
        upsert: {
          update: {
            ...settingsToSave,
          },
          create: {
            ...settingsToSave,
          },
        },
      },
    },
  });

  await params.prisma.auditLog.create({
    data: {
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      action: 'UPDATE_CHANNEL_SETTINGS',
      payload: {
        ...settingsToSave,
        source: params.source,
      },
    },
  });
  await params.chatContextCache.invalidate(params.chatId);
  await params.refreshExecutionReadiness();

  return settingsToSave;
}
