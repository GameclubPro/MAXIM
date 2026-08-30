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
import { BadRequestException, ConflictException } from '@nestjs/common';
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
import {
  CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
  resolveChatSettingsBotCapabilityRequirements,
  type ChatSettingsBotCapabilityRequirement,
} from './chat-settings-bot-capability';
import { BotCapabilityRequiredException } from './bot-capability-required.error';

type SettingsApplyReadinessRefresh = {
  chatIds: readonly string[];
  skipManagedEntityBotRefreshChatIds?: readonly string[];
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
  assertBotCapabilities: (
    chatId: string,
    requirements: readonly ChatSettingsBotCapabilityRequirement[],
  ) => Promise<void>;
  recordConcurrentWriteConflict: (params: {
    sourceChatId: string;
    conflictChatId: string | null;
    appliedCount: number;
    appliedChatIds: readonly string[];
  }) => void;
  onPartialApplied: (chatIds: readonly string[]) => Promise<void>;
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

  const capabilityRelevantUpdate = Object.keys(majorSettingsUpdatePayload).some((key) =>
    Object.hasOwn(CHAT_SETTINGS_BOT_CAPABILITY_SELECT, key) ||
    key === 'requiredSubscriptionChannelIds',
  );
  const capabilityPreflightConfirmedChatIds = new Set<string>();
  let writeBaselineByChatId = new Map<string, Date>();
  if (capabilityRelevantUpdate) {
    const currentRows = await params.prisma.chatSettings.findMany({
      where: { chatId: { in: appliedChatIds } },
      select: { chatId: true, updatedAt: true, ...CHAT_SETTINGS_BOT_CAPABILITY_SELECT },
    });
    const currentByChatId = new Map(currentRows.map((row) => [row.chatId, row]));
    const targetByChatId = new Map(targetChats.map((chat) => [chat.id, chat]));
    let firstPreflightError: unknown = null;
    await mapWithConcurrencyLimit(
      appliedChatIds,
      APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY,
      async (chatId) => {
        if (firstPreflightError) {
          return;
        }
        const current = {
          ...DEFAULT_CHAT_SETTINGS,
          ...(currentByChatId.get(chatId) ?? {}),
        } as ChatSettings;
        const next = { ...current, ...majorSettingsUpdatePayload } as ChatSettings;
        const requirements = resolveChatSettingsBotCapabilityRequirements({
          current,
          next,
          requestedSettings: majorSettingsUpdatePayload,
        });
        if (requirements.length > 0) {
          try {
            await params.assertBotCapabilities(chatId, requirements);
            capabilityPreflightConfirmedChatIds.add(chatId);
          } catch (error: unknown) {
            if (!firstPreflightError) {
              const targetChat = targetByChatId.get(chatId);
              firstPreflightError =
                error instanceof BotCapabilityRequiredException && targetChat
                  ? new BotCapabilityRequiredException({
                      missingPermissions: error.missingPermissions,
                      featureKeys: error.featureKeys,
                      checkedAt: error.checkedAt,
                      blockerCode: error.blockerCode,
                      stale: error.stale,
                      canRecheck: error.canRecheck,
                      affectedEntities: [{ id: targetChat.id, title: targetChat.title }],
                    })
                  : error;
            }
          }
        }
      },
    );
    if (firstPreflightError) {
      throw firstPreflightError;
    }
    const refreshedRows = await params.prisma.chatSettings.findMany({
      where: { chatId: { in: appliedChatIds } },
      select: { chatId: true, updatedAt: true },
    });
    const initialRevisionByChatId = new Map(
      currentRows.map((row) => [row.chatId, row.updatedAt]),
    );
    writeBaselineByChatId = new Map(
      refreshedRows.map((row) => [row.chatId, row.updatedAt]),
    );
    if (
      appliedChatIds.some(
        (chatId) =>
          initialRevisionByChatId.get(chatId)?.getTime() !==
          writeBaselineByChatId.get(chatId)?.getTime(),
      )
    ) {
      params.recordConcurrentWriteConflict({
        sourceChatId: params.sourceChatId,
        conflictChatId: null,
        appliedCount: 0,
        appliedChatIds: [],
      });
      throw settingsApplyRevisionConflict(undefined, []);
    }
  } else {
    const currentRows = await params.prisma.chatSettings.findMany({
      where: { chatId: { in: appliedChatIds } },
      select: { chatId: true, updatedAt: true },
    });
    writeBaselineByChatId = new Map(currentRows.map((row) => [row.chatId, row.updatedAt]));
  }

  const successfullyAppliedChatIds = new Set<string>();
  let firstWriteError: unknown = null;
  let conflictChatId: string | null = null;
  await mapWithConcurrencyLimit(
    appliedChatIds,
    APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY,
    async (chatId) => {
      if (firstWriteError) {
        return;
      }
      try {
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
                currentTargetSettings?.botSpeechMedia as
                  | ChatSettings['botSpeechMedia']
                  | undefined,
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
        try {
          await params.prisma.$transaction(async (tx) => {
            await tx.chat.upsert({
              where: { id: chatId },
              create: {
                id: chatId,
                title: `Chat ${chatId}`,
                entityType: ChatEntityType.CHAT,
                catalogKind: ChatCatalogKind.MANAGED,
                ...botAssignmentData,
              },
              update: { catalogKind: ChatCatalogKind.MANAGED },
            });
            const baselineUpdatedAt = writeBaselineByChatId.get(chatId);
            if (baselineUpdatedAt) {
              const changed = await tx.chatSettings.updateMany({
                where: { chatId, updatedAt: baselineUpdatedAt },
                data: updatePayloadForChat,
              });
              if (changed.count !== 1) {
                throw settingsApplyRevisionConflict(chatId, []);
              }
            } else {
              await tx.chatSettings.create({
                data: { chatId, ...createPayloadForChat },
              });
            }
            await tx.auditLog.create({
              data: {
                chatId,
                actorUserId: params.actorUserId,
                action: 'APPLY_SETTINGS_TO_ALL_CHATS',
                payload: {
                  sourceChatId: params.sourceChatId,
                  targetChatId: chatId,
                  source: params.source,
                  targetMode: target.mode,
                  ...(target.favoriteTypes.length > 0
                    ? { favoriteTypes: target.favoriteTypes }
                    : {}),
                  ...(filteredSettingKeys.length > 0
                    ? { settingKeys: filteredSettingKeys }
                    : {}),
                },
              },
            });
          });
        } catch (error: unknown) {
          if ((error as { code?: unknown })?.code === 'P2002') {
            throw settingsApplyRevisionConflict(chatId, []);
          }
          throw error;
        }
        successfullyAppliedChatIds.add(chatId);
        await params.chatContextCache.invalidate(chatId);
      } catch (error: unknown) {
        if (!firstWriteError) {
          firstWriteError = error;
          if (
            error instanceof ConflictException &&
            (error.getResponse() as { code?: unknown })?.code ===
              'CHAT_SETTINGS_CONCURRENT_UPDATE'
          ) {
            conflictChatId = chatId;
          }
        }
      }
    },
  );

  if (firstWriteError) {
    const partialAppliedChatIds = appliedChatIds.filter((chatId) =>
      successfullyAppliedChatIds.has(chatId),
    );
    if (partialAppliedChatIds.length > 0) {
      params.scheduleReadinessRefresh({
        chatIds: partialAppliedChatIds,
        ...(capabilityPreflightConfirmedChatIds.size > 0
          ? {
              skipManagedEntityBotRefreshChatIds: partialAppliedChatIds.filter((chatId) =>
                capabilityPreflightConfirmedChatIds.has(chatId),
              ),
            }
          : {}),
        shouldRefreshRequiredSubscription:
          shouldValidateRequiredSubscription &&
          params.isRequiredSubscriptionCurrentlyActive(normalizedSettings),
        requiredSubscriptionChannelIds: normalizedSettings.requiredSubscriptionChannelIds,
      });
      await params.onPartialApplied(partialAppliedChatIds);
    }
    if (
      firstWriteError instanceof ConflictException &&
      (firstWriteError.getResponse() as { code?: unknown })?.code ===
        'CHAT_SETTINGS_CONCURRENT_UPDATE'
    ) {
      params.recordConcurrentWriteConflict({
        sourceChatId: params.sourceChatId,
        conflictChatId,
        appliedCount: partialAppliedChatIds.length,
        appliedChatIds: partialAppliedChatIds.slice(0, 20),
      });
      throw settingsApplyRevisionConflict(conflictChatId ?? undefined, partialAppliedChatIds);
    }
    throw firstWriteError;
  }

  params.scheduleReadinessRefresh({
    chatIds: appliedChatIds,
    ...(capabilityPreflightConfirmedChatIds.size > 0
      ? {
          skipManagedEntityBotRefreshChatIds: appliedChatIds.filter((chatId) =>
            capabilityPreflightConfirmedChatIds.has(chatId),
          ),
        }
      : {}),
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

function settingsApplyRevisionConflict(
  chatId: string | undefined,
  appliedChatIds: readonly string[],
): ConflictException {
  const boundedAppliedChatIds = appliedChatIds.slice(0, 20);
  return new ConflictException({
    code: 'CHAT_SETTINGS_CONCURRENT_UPDATE',
    message: 'Настройки чатов изменились параллельно. Обновите экран и повторите попытку.',
    ...(chatId ? { chatId } : {}),
    partialApplied: appliedChatIds.length > 0,
    appliedCount: appliedChatIds.length,
    appliedChatIds: boundedAppliedChatIds,
  });
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
