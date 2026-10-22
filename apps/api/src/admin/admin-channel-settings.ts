import { assertFixedModeratorCapabilitiesForSettings } from '../max/fixed-moderator-capabilities';
import { channelSettingsSchema, type ChannelSettings } from '@maxim/contracts';
import { BadRequestException, ConflictException, HttpException, type Logger } from '@nestjs/common';
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
import type { NetworkSettingsWriteOptions } from './network-settings-write';

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

export async function readPublicChannelSettings(
  prisma: PrismaService,
  chatId: string,
): Promise<ChannelSettings> {
  const settings = await prisma.channelSettings.findUnique({ where: { chatId } });
  if (!settings) {
    return DEFAULT_CHANNEL_SETTINGS;
  }
  const parsed = channelSettingsSchema.safeParse(sanitizeStoredChannelSettings(settings));
  return parsed.success ? normalizeChannelSettings(parsed.data, chatId) : DEFAULT_CHANNEL_SETTINGS;
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
      const repaired = await params.prisma.channelSettings.updateMany({
        where: { chatId: params.chatId, revision: chat.channelSettings.revision },
        data: { ...normalizationChanges, revision: { increment: 1 } },
      });
      if (!repaired.count)
        throw new ConflictException('Настройки канала изменились. Обновите экран.');
      return { ...normalized, revision: chat.channelSettings.revision + 1 };
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

  const repaired = await params.prisma.channelSettings.updateMany({
    where: { chatId: params.chatId, revision: chat.channelSettings.revision },
    data: {
      ...DEFAULT_CHANNEL_SETTINGS,
      revision: { increment: 1 },
    },
  });

  if (!repaired.count) throw new ConflictException('Настройки канала изменились. Обновите экран.');
  return { ...DEFAULT_CHANNEL_SETTINGS, revision: chat.channelSettings.revision + 1 };
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
  networkWrite?: NetworkSettingsWriteOptions;
}): Promise<ChannelSettings> {
  const parsed = channelSettingsSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }
  if (parsed.data.revision === undefined)
    throw new HttpException(
      {
        code: 'CHANNEL_SETTINGS_REVISION_REQUIRED',
        message: 'Обновите экран настроек перед сохранением.',
      },
      428,
    );
  const normalizedSettings = normalizeChannelSettings(parsed.data, params.chatId);
  const botAssignmentData = await params.resolveBotAssignmentData();
  const settingsToSave = normalizedSettings;
  const settingsToUpdate: Partial<ChannelSettings> = { ...settingsToSave };
  delete settingsToUpdate.revision;
  if (params.networkWrite?.authoredChannelKeys) {
    const authored = new Set(params.networkWrite.authoredChannelKeys);
    for (const key of Object.keys(settingsToUpdate) as Array<keyof ChannelSettings>)
      if (!authored.has(key)) delete settingsToUpdate[key];
  }
  // FLAG: Older clients must not disable subscription protection by omitting new fields.
  for (const key of [
    'postSuggestionsRequireSubscription',
    'postSuggestionsDeleteOnUnsubscribe',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(params.body, key)) delete settingsToUpdate[key];
  }

  if (params.networkWrite?.validateOnly) {
    const current = await params.prisma.channelSettings.findUnique({
      where: { chatId: params.chatId },
      select: { revision: true },
    });
    if ((current?.revision ?? 0) !== parsed.data.revision)
      throw new ConflictException('Настройки канала изменились. Обновите экран.');
    const chat = await params.prisma.chat.findUniqueOrThrow({ where: { id: params.chatId } });
    await assertFixedModeratorCapabilitiesForSettings(
      params.prisma,
      chat,
      settingsToSave.commentsEnabled ||
        settingsToSave.postSuggestionsEnabled ||
        settingsToSave.quickButtonsEnabled
        ? ['send_message', 'edit_message']
        : [],
    );
    return normalizedSettings;
  }
  let savedRevision = parsed.data.revision;
  await params.prisma.$transaction(async (tx) => {
    const lockedChat = await tx.chat.upsert({
      where: { id: params.chatId },
      create: {
        id: params.chatId,
        title: `Channel ${params.chatId}`,
        entityType: ChatEntityType.CHANNEL,
        catalogKind: ChatCatalogKind.MANAGED,
        ...botAssignmentData,
      },
      update: { entityType: ChatEntityType.CHANNEL, catalogKind: ChatCatalogKind.MANAGED },
    });
    const editingEnabled =
      settingsToSave.commentsEnabled ||
      settingsToSave.postSuggestionsEnabled ||
      settingsToSave.quickButtonsEnabled;
    await assertFixedModeratorCapabilitiesForSettings(
      tx,
      lockedChat,
      editingEnabled ? ['send_message', 'edit_message'] : [],
    );
    const current = await tx.channelSettings.findUnique({
      where: { chatId: params.chatId },
      select: { revision: true },
    });
    if (current) {
      const changed = await tx.channelSettings.updateMany({
        where: { chatId: params.chatId, revision: parsed.data.revision },
        data: { ...settingsToUpdate, revision: { increment: 1 } },
      });
      if (!changed.count)
        throw new ConflictException({
          code: 'CHANNEL_SETTINGS_CONCURRENT_UPDATE',
          message: 'Настройки канала изменились. Обновите экран.',
        });
    } else {
      if (parsed.data.revision !== 0) throw new ConflictException('Настройки канала изменились.');
      await tx.channelSettings.create({
        data: { chatId: params.chatId, ...settingsToSave, revision: 1 },
      });
    }
    await tx.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        action: 'UPDATE_CHANNEL_SETTINGS',
        payload: { settingKeys: Object.keys(settingsToUpdate), source: params.source },
      },
    });
    const written = await tx.channelSettings.findUniqueOrThrow({
      where: { chatId: params.chatId },
      select: { revision: true },
    });
    savedRevision = written.revision;
    await params.networkWrite?.onCommitted?.(tx, String(savedRevision));
  });
  if (params.networkWrite?.deferFollowup) return { ...settingsToSave, revision: savedRevision };
  await params.chatContextCache.invalidate(params.chatId);
  await params.refreshExecutionReadiness();

  return { ...settingsToSave, revision: savedRevision };
}
