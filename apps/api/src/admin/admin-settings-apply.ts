import {
  applySectionTargetPreviewRequestSchema,
  applySectionTargetPreviewResponseSchema,
  applySectionToAllRequestSchema,
  applySectionToAllResponseSchema,
  chatSettingsSchema,
  type ApplySectionTargetPreviewResponse,
  type ApplySectionToAllResponse,
  type ApplySettingsTarget,
  type ChatSettings,
  type ChatSummary,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { ChatCatalogKind, ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { mapWithConcurrencyLimit } from './admin-legacy-utils';
import type { ResolvedBotAssignmentData } from './admin-chat-settings';
import {
  APPLY_SECTION_TARGET_PREVIEW_SAMPLE_LIMIT,
  APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY,
  DEFAULT_CHAT_SETTINGS,
  SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS,
  REQUIRED_SUBSCRIPTION_SETTING_KEYS,
  SETTINGS_SECTION_KEYS,
  type AdminActionSource,
  type ApplySettingsToAllChatsResult,
} from './admin.service.support';
import {
  DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS,
  omitPublisherOwnedChatSettings,
} from './publisher-owned-chat-settings';

type SettingsApplyReadinessRefresh = {
  chatIds: readonly string[];
  shouldRefreshRequiredSubscription: boolean;
  requiredSubscriptionChannelIds: readonly string[];
};

function hasOwnSetting(value: unknown, key: keyof ChatSettings): boolean {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key),
  );
}

function mergeBotSpeechMediaForKeys(
  current: ChatSettings['botSpeechMedia'] | undefined,
  source: ChatSettings['botSpeechMedia'],
  keys: readonly string[],
): ChatSettings['botSpeechMedia'] {
  if (keys.length === 0) {
    return current ?? {};
  }

  const next = { ...(current ?? {}) };
  for (const key of keys) {
    const sourceImage = source[key as keyof typeof source];
    if (sourceImage && sourceImage.base64.trim()) {
      next[key as keyof typeof next] = sourceImage;
    } else {
      delete next[key as keyof typeof next];
    }
  }
  return next;
}

export async function previewApplySettingsSectionTarget(params: {
  sourceChatId: string;
  body: unknown;
  resolveTargetChats: (target: ApplySettingsTarget) => Promise<ChatSummary[]>;
}): Promise<ApplySectionTargetPreviewResponse> {
  const parsed = applySectionTargetPreviewRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const target = parsed.data.target;
  const targetChats = await params.resolveTargetChats(target);

  return applySectionTargetPreviewResponseSchema.parse({
    sourceChatId: params.sourceChatId,
    targetMode: target.mode,
    favoriteTypes: target.favoriteTypes,
    updatedChats: targetChats.length,
    appliedChatIds: targetChats.map((chat) => chat.id),
    sampleChats: targetChats.slice(0, APPLY_SECTION_TARGET_PREVIEW_SAMPLE_LIMIT),
  });
}

export async function applySettingsToAllChats(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  sourceChatId: string;
  actorUserId: string;
  body: unknown;
  source: AdminActionSource;
  targetOrSettingKeys?: ApplySettingsTarget | readonly (keyof ChatSettings)[];
  settingKeys?: readonly (keyof ChatSettings)[];
  normalizeSettings: (settings: ChatSettings) => ChatSettings;
  resolveTargetChats: (target: ApplySettingsTarget) => Promise<ChatSummary[]>;
  resolveBotAssignmentData: (
    chatId: string,
  ) => Promise<ResolvedBotAssignmentData> | ResolvedBotAssignmentData;
  assertRequiredSubscriptionSettings: (settings: ChatSettings) => Promise<ChatSettings | void>;
  isRequiredSubscriptionCurrentlyActive: (settings: ChatSettings) => boolean;
  scheduleReadinessRefresh: (params: SettingsApplyReadinessRefresh) => void;
  getCurrentSourceSettings?: () => Promise<
    Pick<ChatSettings, 'profanitySensitivity'> | null
  >;
  botSpeechMediaKeys?: readonly string[];
}): Promise<ApplySettingsToAllChatsResult> {
  const parsed = chatSettingsSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }
  const currentSourceSettings =
    !hasOwnSetting(params.body, 'profanitySensitivity') && params.getCurrentSourceSettings
      ? await params.getCurrentSourceSettings()
      : null;
  const parsedSettings = currentSourceSettings
    ? {
        ...parsed.data,
        profanitySensitivity: currentSourceSettings.profanitySensitivity,
      }
    : parsed.data;
  let normalizedSettings = params.normalizeSettings(parsedSettings);

  const targetOrSettingKeys = params.targetOrSettingKeys ?? {
    mode: 'all' as const,
    favoriteTypes: [],
    chatIds: [],
  };
  const usesLegacySettingKeys = Array.isArray(targetOrSettingKeys);
  const target: ApplySettingsTarget = usesLegacySettingKeys
    ? { mode: 'all' as const, favoriteTypes: [], chatIds: [] }
    : (targetOrSettingKeys as ApplySettingsTarget);
  const effectiveSettingKeys = usesLegacySettingKeys
    ? (targetOrSettingKeys as readonly (keyof ChatSettings)[])
    : params.settingKeys;
  const targetChats = await params.resolveTargetChats(target);
  if (targetChats.length === 0) {
    throw new BadRequestException('Нет доступных чатов для применения настроек.');
  }
  const appliedChatIds = targetChats.map((chat) => chat.id);
  const filteredSettingKeys = Array.isArray(effectiveSettingKeys)
    ? Array.from(new Set(effectiveSettingKeys)).filter(
        (key): key is keyof ChatSettings => typeof key === 'string' && key in normalizedSettings,
      )
    : [];
  const shouldApplyBotSpeechMedia =
    filteredSettingKeys.length === 0 || filteredSettingKeys.includes('botSpeechMedia');
  const botSpeechMediaKeys =
    shouldApplyBotSpeechMedia && Array.isArray(params.botSpeechMediaKeys)
      ? params.botSpeechMediaKeys
      : [];
  const shouldValidateRequiredSubscription =
    filteredSettingKeys.length === 0 ||
    filteredSettingKeys.some((key) =>
      REQUIRED_SUBSCRIPTION_SETTING_KEYS.includes(
        key as (typeof REQUIRED_SUBSCRIPTION_SETTING_KEYS)[number],
      ),
    );
  if (shouldValidateRequiredSubscription) {
    normalizedSettings =
      (await params.assertRequiredSubscriptionSettings(normalizedSettings)) ?? normalizedSettings;
  }
  const settingsUpdatePayload: Partial<ChatSettings> =
    filteredSettingKeys.length > 0
      ? filteredSettingKeys.reduce<Partial<ChatSettings>>((acc, key) => {
          (acc as Record<keyof ChatSettings, ChatSettings[keyof ChatSettings]>)[key] =
            normalizedSettings[key];
          return acc;
        }, {})
      : normalizedSettings;
  const settingsCreatePayload =
    filteredSettingKeys.length > 0
      ? {
          ...DEFAULT_CHAT_SETTINGS,
          ...settingsUpdatePayload,
        }
      : normalizedSettings;
  // FLAG: Major bulk UPDATE payloads omit Publisher-owned comment fields entirely.
  const majorSettingsUpdatePayload = omitPublisherOwnedChatSettings(settingsUpdatePayload);
  const majorSettingsCreatePayload = {
    ...omitPublisherOwnedChatSettings(settingsCreatePayload),
    ...DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS,
  };

  await mapWithConcurrencyLimit(
    appliedChatIds,
    APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY,
    async (chatId) => {
      const botAssignmentData = await params.resolveBotAssignmentData(chatId);
      const currentTargetSettings =
        shouldApplyBotSpeechMedia && botSpeechMediaKeys.length > 0
          ? await params.prisma.chatSettings.findUnique({
              where: { chatId },
              select: { botSpeechMedia: true },
            })
          : null;
      const scopedBotSpeechMedia =
        shouldApplyBotSpeechMedia && botSpeechMediaKeys.length > 0
          ? mergeBotSpeechMediaForKeys(
              currentTargetSettings?.botSpeechMedia as ChatSettings['botSpeechMedia'] | undefined,
              normalizedSettings.botSpeechMedia,
              botSpeechMediaKeys,
            )
          : normalizedSettings.botSpeechMedia;
      const updatePayloadForChat = {
        ...majorSettingsUpdatePayload,
        ...(shouldApplyBotSpeechMedia && botSpeechMediaKeys.length > 0
          ? { botSpeechMedia: scopedBotSpeechMedia }
          : {}),
      };
      const createPayloadForChat = {
        ...majorSettingsCreatePayload,
        ...(shouldApplyBotSpeechMedia && botSpeechMediaKeys.length > 0
          ? { botSpeechMedia: scopedBotSpeechMedia }
          : {}),
      };
      await params.prisma.$transaction([
        params.prisma.chat.upsert({
          where: { id: chatId },
          create: {
            id: chatId,
            title: `Chat ${chatId}`,
            entityType: ChatEntityType.CHAT,
            catalogKind: ChatCatalogKind.MANAGED,
            ...botAssignmentData,
            settings: {
              create: {
                ...createPayloadForChat,
              },
            },
          },
          update: {
            catalogKind: ChatCatalogKind.MANAGED,
            settings: {
              upsert: {
                update: {
                  ...updatePayloadForChat,
                },
                create: {
                  ...createPayloadForChat,
                },
              },
            },
          },
        }),
        params.prisma.auditLog.create({
          data: {
            chatId,
            actorUserId: params.actorUserId,
            action: 'APPLY_SETTINGS_TO_ALL_CHATS',
            payload: {
              sourceChatId: params.sourceChatId,
              targetChatId: chatId,
              source: params.source,
              targetMode: target.mode,
              ...(target.favoriteTypes.length > 0 ? { favoriteTypes: target.favoriteTypes } : {}),
              ...(filteredSettingKeys.length > 0 ? { settingKeys: filteredSettingKeys } : {}),
            },
          },
        }),
      ]);

      await params.chatContextCache.invalidate(chatId);
    },
  );

  params.scheduleReadinessRefresh({
    chatIds: appliedChatIds,
    shouldRefreshRequiredSubscription:
      shouldValidateRequiredSubscription &&
      params.isRequiredSubscriptionCurrentlyActive(normalizedSettings),
    requiredSubscriptionChannelIds: normalizedSettings.requiredSubscriptionChannelIds,
  });

  return {
    sourceChatId: params.sourceChatId,
    updatedChats: appliedChatIds.length,
    appliedChatIds,
  };
}

export async function applySettingsSectionToAllChats(params: {
  sourceChatId: string;
  body: unknown;
  source: AdminActionSource;
  getSourceSettings: () => Promise<ChatSettings>;
  applySettings: (
    settings: ChatSettings,
    target: ApplySettingsTarget,
    settingKeys: readonly (keyof ChatSettings)[],
    botSpeechMediaKeys?: readonly string[],
  ) => Promise<ApplySettingsToAllChatsResult>;
  syncDomainAllowlistToChats: (targetChatIds: readonly string[]) => Promise<void>;
}): Promise<ApplySectionToAllResponse> {
  const parsed = applySectionToAllRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }
  const section = parsed.data.section;

  const sourceSettings = await params.getSourceSettings();
  const result = await params.applySettings(
    sourceSettings,
    parsed.data.target,
    [
      ...SETTINGS_SECTION_KEYS[section],
      ...(SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS[section].length > 0
        ? ['botSpeechMedia' as const]
        : []),
    ],
    SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS[section],
  );

  if (section === 'links') {
    await params.syncDomainAllowlistToChats(result.appliedChatIds);
  }

  return applySectionToAllResponseSchema.parse({
    section,
    targetMode: parsed.data.target.mode,
    favoriteTypes: parsed.data.target.favoriteTypes,
    ...result,
  });
}
