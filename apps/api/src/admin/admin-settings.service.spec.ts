import { channelSettingsSchema, chatSettingsSchema } from '@maxim/contracts';
import {
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { resolvePhotoDuplicateRuntimePolicy } from '../moderation/photo-duplicate/photo-duplicate.runtime';
import { UPDATE_SETTINGS_AUDIT_PAYLOAD_MAX_SERIALIZED_BYTES } from './admin-chat-settings';
import { AdminSettingsService } from './admin-settings.service';

const user = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

function createPrismaUniqueConflictError() {
  return Object.assign(new Error('Unique constraint failed on the fields: (`chat_id`)'), {
    code: 'P2002',
  });
}

function createPersistedChatRules(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rules-1',
    chatId: 'chat-1',
    text: 'Пишите по теме.',
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    autoTextEnabled: false,
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
    adminContactButtonEnabled: false,
    adminContactButtonUrl: '',
    publishedMessageId: null,
    publishedBotId: null,
    publishedUrl: null,
    publishedAt: null,
    publishOperationId: null,
    publishOperationBotId: null,
    publishSendStartedAt: null,
    pendingCleanupMessageId: null,
    pendingCleanupBotId: null,
    pendingCleanupIntentId: null,
    pendingCleanupKind: null,
    createdAt: new Date('2026-03-09T09:00:00.000Z'),
    updatedAt: new Date('2026-03-09T09:00:00.000Z'),
    ...overrides,
  };
}

function createPersistedChatSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings-1',
    chatId: 'chat-1',
    ...chatSettingsSchema.parse({}),
    createdAt: new Date('2026-03-09T09:00:00.000Z'),
    updatedAt: new Date('2026-03-09T09:00:00.000Z'),
    ...overrides,
  };
}

function createPersistedChannelSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'channel-settings-1',
    chatId: 'channel-1',
    ...channelSettingsSchema.parse({}),
    createdAt: new Date('2026-03-09T09:00:00.000Z'),
    updatedAt: new Date('2026-03-09T09:00:00.000Z'),
    ...overrides,
  };
}

function createManagedEntityHeader(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chat-1',
    title: 'Тестовый чат',
    entityType: 'chat',
    link: null,
    participantsCount: null,
    avatarUrl: null,
    primaryBotId: null,
    assignedBots: [],
    sharedMode: 'owned',
    accessDiagnostics: {
      state: 'ok',
      lastDetectedAt: null,
      lastCheckedAt: null,
      freshUntil: null,
      source: 'unknown',
      activeBotCount: 0,
      lostBots: [],
    },
    viewerAccess: {
      state: 'checking',
      reason: null,
      checkedAt: null,
      canEdit: false,
    },
    ...overrides,
  };
}

function createChatSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chat-1',
    title: 'Тестовый чат',
    createdAt: '2026-03-09T09:00:00.000Z',
    entityType: 'chat',
    link: null,
    avatarUrl: null,
    channelOverview: null,
    primaryBotId: null,
    assignedBots: [],
    sharedMode: 'owned',
    ...overrides,
  };
}

function createManagedBroadcastSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'broadcast-1',
    status: 'ACTIVE',
    textPreview: 'Анонс',
    textLength: 5,
    targetMode: 'current',
    applyToAllChats: false,
    targetChatIds: [],
    targetChats: 1,
    targetPreviews: [],
    targetOverflowCount: 0,
    hasImage: false,
    imageCount: 0,
    hasVideo: false,
    buttons: [],
    buttonEnabled: false,
    scheduleMode: 'legacy',
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: [],
    nextSendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 24,
    cycleCount: 1,
    sentCount: 0,
    currentOccurrence: 1,
    deliveredChats: 0,
    failedChats: 0,
    pendingChats: 1,
    blockedChats: 0,
    failureBreakdown: {
      transient: 0,
      permanentTarget: 0,
      quarantined: 0,
      unknown: 0,
    },
    canRetry: false,
    remainingCount: 1,
    createdAt: '2026-03-09T09:00:00.000Z',
    updatedAt: '2026-03-09T09:00:00.000Z',
    lastError: null,
    ...overrides,
  };
}

function createService(
  options: {
    applyTargetChats?: Array<Record<string, unknown>>;
    botAssignmentData?: { botId?: string; primaryBotId?: string };
    botSpeechPreviewProfile?: { persona: 'male' | 'female' | 'neutral'; characterName: string };
    currentSettings?: Record<string, unknown> | null;
    channelPostSignatureService?: {
      getSettings: jest.Mock;
      preparePostText: jest.Mock;
      updateSettings: jest.Mock;
    };
    domainAllowlistDetails?: Array<Record<string, unknown>>;
    photoDuplicateConfig?: Record<string, string>;
    photoDuplicateDeleteIntentRollout?: 'off' | 'observed' | 'execute';
    managedBroadcasts?: Array<Record<string, unknown>>;
    managedEntityHeader?: Record<string, unknown>;
    persistedChannelSettings?: ReturnType<typeof createPersistedChannelSettings>;
    persistedSettings?: ReturnType<typeof createPersistedChatSettings>;
    persistedRules?: ReturnType<typeof createPersistedChatRules>;
    persistedRulesUpdate?: ReturnType<typeof createPersistedChatRules>;
    publishedRulesMessage?: { messageId: string; url: string | null };
    requiredSubscriptionChannels?: Array<Record<string, unknown>>;
    resolvedRequiredSubscriptionChannel?: Record<string, unknown>;
    resolvedRulesUrl?: string | null;
    nightModeTransitionScheduler?: { reconcileChats: jest.Mock };
  } = {},
) {
  const legacyAdminService = {
    assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined),
    assertRequiredSubscriptionSettingsForChatSettings: jest.fn().mockResolvedValue(undefined),
    buildAutofilledChatRulesTextFromCurrentSettings: jest.fn().mockResolvedValue('Автоправила.'),
    buildFormattedChatRulesPublicationText: jest.fn().mockImplementation((_chatId, sourceText) =>
      Promise.resolve({
        text: sourceText,
        textFormat: 'markdown',
      }),
    ),
    getSettings: jest.fn(),
    getChatSettingsScreen: jest.fn(),
    getChannelSettings: jest.fn(),
    getChannelSettingsScreen: jest.fn(),
    getRules: jest.fn(),
    applySettingsToAllChats: jest.fn(),
    applySettingsSectionToAllChats: jest.fn(),
    previewApplySettingsSectionTarget: jest.fn(),
    publishChannelEngagementMessage: jest.fn(),
    publishRules: jest.fn(),
    resolveRequiredSubscriptionChannel: jest.fn(),
    resolveRequiredSubscriptionChannelReferenceValue: jest.fn().mockResolvedValue(
      options.resolvedRequiredSubscriptionChannel ??
        createManagedEntityHeader({
          id: 'channel-1',
          title: 'Канал новостей',
          entityType: 'channel',
        }),
    ),
    refreshChatSettingsExecutionReadiness: jest.fn().mockResolvedValue(undefined),
    resolveRequiredSubscriptionChannelHeadersForSettings: jest
      .fn()
      .mockResolvedValue(options.requiredSubscriptionChannels ?? []),
    resolveChatSettingsReadBotAssignmentData: jest
      .fn()
      .mockResolvedValue(options.botAssignmentData ?? {}),
    resolveChatSettingsWriteBotAssignmentData: jest
      .fn()
      .mockResolvedValue(options.botAssignmentData ?? {}),
    resolveChannelSettingsReadBotAssignmentData: jest
      .fn()
      .mockResolvedValue(options.botAssignmentData ?? {}),
    resolveChannelSettingsWriteBotAssignmentData: jest
      .fn()
      .mockResolvedValue(options.botAssignmentData ?? {}),
    resolveChatRulesActionBotId: jest.fn().mockResolvedValue(options.botAssignmentData?.botId),
    resolveChannelEngagementActionBotId: jest
      .fn()
      .mockResolvedValue(options.botAssignmentData?.botId),
    resolveChannelEngagementEditBotId: jest
      .fn()
      .mockResolvedValue(options.botAssignmentData?.botId),
    buildChannelEngagementDialogArtifacts: jest.fn().mockImplementation((params) => ({
      commentsUrl: `https://max.ru/${params.chatId}/comments/${params.threadId}`,
      suggestPayload: `cds-${params.chatId}-${params.threadId}`,
      suggestUrl: `https://max.ru/777000_bot?start=cds-${params.chatId}-${params.threadId}`,
      commentsButton: {
        type: 'link',
        text: params.formattedCommentsButtonText,
        url: `https://max.ru/777000_bot?startapp=comments-${params.threadId}`,
      },
      suggestButton: {
        type: 'link',
        text: params.suggestButtonText,
        url: `https://max.ru/777000_bot?start=cds-${params.chatId}-${params.threadId}`,
      },
    })),
    normalizeChatSettingsForApply: jest.fn().mockImplementation((_sourceChatId, settings) => ({
      ...settings,
    })),
    resolveSettingsApplyTargetChatsForSettings: jest
      .fn()
      .mockResolvedValue(
        options.applyTargetChats ?? [
          createChatSummary(),
          createChatSummary({ id: 'chat-2', title: 'Второй чат' }),
        ],
      ),
    resolveSettingsApplyBotAssignmentData: jest
      .fn()
      .mockResolvedValue(options.botAssignmentData ?? {}),
    isRequiredSubscriptionCurrentlyActiveForSettings: jest.fn().mockReturnValue(false),
    scheduleApplySettingsToAllReadinessRefreshForSettings: jest.fn(),
    syncDomainAllowlistToChatsForSettings: jest.fn().mockResolvedValue(undefined),
    resetPublishedRules: jest.fn(),
    refreshChannelSettingsExecutionReadiness: jest.fn().mockResolvedValue(undefined),
    sendPublishedChatRulesPrivateConfirmation: jest.fn().mockResolvedValue(undefined),
    updateSettings: jest.fn(),
    updateChannelSettings: jest.fn(),
    updateRules: jest.fn(),
  };
  const prisma = {
    $transaction: jest.fn().mockImplementation((operations) => Promise.all(operations)),
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        settings: options.persistedSettings ?? createPersistedChatSettings(),
        channelSettings: options.persistedChannelSettings ?? createPersistedChannelSettings(),
      }),
    },
    chatAdminAllowlist: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue(options.currentSettings ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
    channelSettings: {
      findUnique: jest.fn().mockResolvedValue(
        options.persistedChannelSettings
          ? {
              postSuggestionsEnabled:
                options.persistedChannelSettings.postSuggestionsEnabled === true,
            }
          : null,
      ),
      upsert: jest
        .fn()
        .mockResolvedValue(options.persistedChannelSettings ?? createPersistedChannelSettings()),
      update: jest.fn().mockResolvedValue({}),
    },
    chatRules: {
      findUnique: jest.fn().mockResolvedValue(options.persistedRules ?? createPersistedChatRules()),
      upsert: jest.fn().mockResolvedValue(options.persistedRules ?? createPersistedChatRules()),
      update: jest
        .fn()
        .mockResolvedValue(options.persistedRulesUpdate ?? createPersistedChatRules()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const chatContextCache = {
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  const maxClient = {
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    resolveMessageLink: jest.fn().mockResolvedValue(options.resolvedRulesUrl ?? null),
    sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue(
      options.publishedRulesMessage ?? {
        messageId: 'message-2',
        url: 'https://max.ru/chats/chat-1/message/2',
      },
    ),
    uploadImage: jest.fn().mockResolvedValue({ token: 'rules-image-1' }),
  };
  const managedEntitiesService = {
    assertManagedEntityDiagnosticsAccess: jest.fn().mockResolvedValue(undefined),
    getChatHeader: jest
      .fn()
      .mockResolvedValue(options.managedEntityHeader ?? createManagedEntityHeader()),
    getChatHeaderWithBotSpeechPreviewProfile: jest.fn().mockResolvedValue({
      header: options.managedEntityHeader ?? createManagedEntityHeader(),
      botSpeechPreviewProfile: options.botSpeechPreviewProfile ?? {
        persona: 'neutral',
        characterName: 'Чат-бот',
      },
    }),
    getChannelHeader: jest
      .fn()
      .mockResolvedValue(
        options.managedEntityHeader ??
          createManagedEntityHeader({ id: 'channel-1', entityType: 'channel' }),
      ),
  };
  const manualModerationService = {
    getDomainAllowlistDetails: jest.fn().mockResolvedValue(options.domainAllowlistDetails ?? []),
  };
  const managedBroadcastService = {
    listManagedBroadcasts: jest.fn().mockResolvedValue(options.managedBroadcasts ?? []),
    listChannelManagedBroadcasts: jest.fn().mockResolvedValue(options.managedBroadcasts ?? []),
  };
  const nightModeTransitionScheduler = options.nightModeTransitionScheduler ?? {
    reconcileChats: jest.fn().mockResolvedValue(undefined),
  };
  const channelPostSignatureService = options.channelPostSignatureService ?? {
    getSettings: jest.fn().mockResolvedValue({
      enabled: false,
      text: 'Подписаться на канал',
      url: '',
    }),
    preparePostText: jest
      .fn()
      .mockImplementation((_chatId, payload) =>
        Promise.resolve({ ...payload, signatureApplied: false }),
      ),
    updateSettings: jest.fn().mockResolvedValue({
      enabled: true,
      text: 'Читать канал',
      url: 'https://max.ru/contact',
    }),
  };
  const configService = {
    get: jest.fn((key: string) => options.photoDuplicateConfig?.[key]),
  };
  const photoDuplicateRuntimePolicy = {
    resolveEffectivePolicy: jest.fn(
      (params: {
        chatId: string;
        preset: 'SAME_IMAGE' | 'MINOR_EDITS';
        scope: 'SAME_AUTHOR' | 'CHAT';
      }) =>
        Promise.resolve(
          resolvePhotoDuplicateRuntimePolicy({
            ...params,
            configService,
          }),
        ),
    ),
  };
  const moderationDeleteIntents = {
    getRolloutForRule: jest
      .fn()
      .mockReturnValue(options.photoDuplicateDeleteIntentRollout ?? 'execute'),
  };
  const accessObservability = {
    recordRejection: jest.fn(),
  };
  const service = new AdminSettingsService(
    legacyAdminService as never,
    prisma as never,
    chatContextCache as never,
    maxClient as never,
    managedEntitiesService as never,
    manualModerationService as never,
    managedBroadcastService as never,
    photoDuplicateRuntimePolicy as never,
    moderationDeleteIntents as never,
    nightModeTransitionScheduler as never,
    undefined,
    channelPostSignatureService as never,
    accessObservability as never,
  );

  return {
    accessObservability,
    chatContextCache,
    channelPostSignatureService,
    configService,
    photoDuplicateRuntimePolicy,
    moderationDeleteIntents,
    legacyAdminService,
    managedBroadcastService,
    managedEntitiesService,
    manualModerationService,
    maxClient,
    nightModeTransitionScheduler,
    prisma,
    service,
  };
}

describe('AdminSettingsService chat rules', () => {
  it.each([
    {
      description: 'user access denial',
      error: new ForbiddenException('Пользователь не является администратором чата.'),
      code: 'SETTINGS_ACCESS_USER_DENIED',
      retryable: false,
      recovery: 'return_to_entities',
    },
    {
      description: 'bot access denial',
      error: new ForbiddenException(
        'Действие недоступно: бот больше не состоит в этом чате MAX или утратил права администратора.',
      ),
      code: 'SETTINGS_ACCESS_BOT_DENIED',
      retryable: false,
      recovery: 'recheck_bot_access',
    },
    {
      description: 'temporarily unavailable access check',
      error: new ServiceUnavailableException(
        'Не удалось проверить права администратора в MAX. Повторите попытку.',
      ),
      code: 'SETTINGS_ACCESS_CHECK_UNAVAILABLE',
      retryable: true,
      recovery: 'retry',
    },
  ])('returns a machine-readable settings error for $description', async (testCase) => {
    const { accessObservability, legacyAdminService, service } = createService();
    legacyAdminService.assertManagedEntityAdminAccess.mockRejectedValueOnce(testCase.error);

    const rejected = await service
      .getChatSettingsScreen('chat-1', user as never)
      .catch((error: unknown) => error);

    expect(rejected).not.toBe(testCase.error);
    expect((rejected as ForbiddenException | ServiceUnavailableException).getResponse()).toEqual({
      statusCode: testCase.error.getStatus(),
      error: testCase.error.getStatus() === 403 ? 'Forbidden' : 'Service Unavailable',
      message: testCase.error.message,
      code: testCase.code,
      retryable: testCase.retryable,
      recovery: testCase.recovery,
    });
    expect(accessObservability.recordRejection).toHaveBeenCalledWith({
      scope: 'settings_screen',
      code: testCase.code,
      retryable: testCase.retryable,
      recovery: testCase.recovery,
    });
  });

  it('keeps channel settings screens strict when prefetch asks for cached access', async () => {
    const { accessObservability, legacyAdminService, service } = createService();
    const sourceError = new ForbiddenException('Пользователь не является администратором чата.');
    legacyAdminService.assertManagedEntityAdminAccess.mockRejectedValueOnce(sourceError);

    const rejected = await service
      .getChannelSettingsScreen('channel-1', user as never, { liveAdminCheck: false })
      .catch((error: unknown) => error);

    expect((rejected as ForbiddenException).getResponse()).toMatchObject({
      code: 'SETTINGS_ACCESS_USER_DENIED',
      retryable: false,
      recovery: 'return_to_entities',
    });
    expect(accessObservability.recordRejection).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SETTINGS_ACCESS_USER_DENIED' }),
    );
  });

  it('preserves unknown access errors without recording a rejection metric', async () => {
    const { accessObservability, legacyAdminService, service } = createService();
    const sourceError = new InternalServerErrorException('Unexpected access failure');
    legacyAdminService.assertManagedEntityAdminAccess.mockRejectedValueOnce(sourceError);

    await expect(service.getChatSettingsScreen('chat-1', user as never)).rejects.toBe(sourceError);
    expect(accessObservability.recordRejection).not.toHaveBeenCalled();
  });

  it('does not classify failures after the settings access check', async () => {
    const { accessObservability, managedEntitiesService, service } = createService();
    const sourceError = new ServiceUnavailableException('Settings payload is unavailable');
    managedEntitiesService.getChatHeaderWithBotSpeechPreviewProfile.mockRejectedValueOnce(
      sourceError,
    );

    await expect(service.getChatSettingsScreen('chat-1', user as never)).rejects.toBe(sourceError);
    expect(accessObservability.recordRejection).not.toHaveBeenCalled();
  });

  it('builds chat settings screen without routing through legacy getChatSettingsScreen', async () => {
    const requiredChannel = createManagedEntityHeader({
      id: 'channel-1',
      title: 'Канал новостей',
      entityType: 'channel',
      primaryBotId: 'bot-1',
      assignedBots: [
        {
          botId: 'bot-1',
          label: 'Owner bot',
          role: 'primary',
          membershipStatus: 'active',
          lifecycleState: 'active',
          speechPersona: 'male',
          capabilities: [],
          permissionsSummary: null,
        },
        {
          botId: 'bot-2',
          label: 'Assist bot',
          role: 'standby',
          membershipStatus: 'active',
          lifecycleState: 'active',
          speechPersona: 'female',
          capabilities: ['suggestion_delivery'],
          permissionsSummary: null,
        },
      ],
      sharedMode: 'shared-assist',
    });
    const {
      legacyAdminService,
      managedBroadcastService,
      managedEntitiesService,
      manualModerationService,
      service,
    } = createService({
      persistedSettings: createPersistedChatSettings({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionExpiresAt: '2026-03-16T09:00:00.000Z',
      }),
      domainAllowlistDetails: [
        {
          domain: 'example.com',
          normalizedValue: 'example.com',
          matchType: 'DOMAIN',
          removeAfterAt: null,
        },
      ],
      managedBroadcasts: [createManagedBroadcastSummary()],
      botSpeechPreviewProfile: {
        persona: 'female',
        characterName: 'Майор Максимова',
      },
      requiredSubscriptionChannels: [requiredChannel],
    });

    const result = await service.getChatSettingsScreen('chat-1', user as never, {
      liveAdminCheck: false,
    });

    expect(result.requiredSubscriptionChannels).toEqual([
      expect.objectContaining({
        id: 'channel-1',
        title: 'Канал новостей',
        entityType: 'channel',
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
        botCount: 2,
        hasSharedAutomation: true,
      }),
    ]);
    expect(result.domains).toHaveLength(1);
    expect(result.managedBroadcasts).toHaveLength(1);
    expect(result.botSpeechPreviewProfile).toEqual({
      persona: 'female',
      characterName: 'Майор Максимова',
    });
    expect(result.duplicatePhotoModerationMode).toBe('OBSERVE');
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.getChatSettingsScreen).not.toHaveBeenCalled();
    expect(managedEntitiesService.getChatHeaderWithBotSpeechPreviewProfile).toHaveBeenCalledWith(
      'chat-1',
      user,
      {
        skipAdminCheck: true,
        skipEntityCheck: true,
      },
    );
    expect(manualModerationService.getDomainAllowlistDetails).toHaveBeenCalledWith('chat-1', user, {
      skipAdminCheck: true,
    });
    expect(managedBroadcastService.listManagedBroadcasts).toHaveBeenCalledWith('chat-1', user, {
      skipAdminCheck: true,
      skipEntityCheck: true,
    });
    expect(
      legacyAdminService.resolveRequiredSubscriptionChannelHeadersForSettings,
    ).toHaveBeenCalledWith(['channel-1']);
  });

  it.each<{
    expected: string;
    config: Record<string, string>;
    settings: Record<string, unknown>;
  }>([
    {
      expected: 'OFF',
      config: { PHOTO_DUPLICATE_ROLLOUT_MODE: 'off' },
      settings: {},
    },
    {
      expected: 'DELETE_ONLY',
      config: {
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'delete_only',
        PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
      },
      settings: {},
    },
    {
      expected: 'FULL',
      config: {
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
        PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
        PHOTO_DUPLICATE_MAX_ACTION: 'BAN',
      },
      settings: {},
    },
    {
      expected: 'DELETE_ONLY',
      config: {
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
        PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
      },
      settings: {},
    },
    {
      expected: 'OBSERVE',
      config: {
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
        PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-2',
      },
      settings: {},
    },
    {
      expected: 'OBSERVE',
      config: {
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
        PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
      },
      settings: { duplicatePhotoMatchPreset: 'MINOR_EDITS' },
    },
    {
      expected: 'OBSERVE',
      config: {
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
        PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
        PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: '',
        PHOTO_DUPLICATE_MAX_ACTION: 'BAN',
      },
      settings: {},
    },
  ])(
    'reports the effective photo duplicate mode as $expected',
    async ({ config, expected, settings }) => {
      const { service } = createService({
        persistedSettings: createPersistedChatSettings(settings),
        photoDuplicateConfig: config,
      });

      const result = await service.getChatSettingsScreen('chat-1', user as never, {
        liveAdminCheck: false,
      });

      expect(result.duplicatePhotoModerationMode).toBe(expected);
    },
  );

  it('returns base and advanced photo policies with their exact action ceiling', async () => {
    const { service } = createService({
      photoDuplicateConfig: {
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
        PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
        PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS: 'chat-1',
        PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS: 'canonical_sha256,pdq',
        PHOTO_DUPLICATE_MAX_ACTION: 'MUTE',
      },
    });

    const result = await service.getChatSettingsScreen('chat-1', user as never, {
      liveAdminCheck: false,
    });

    expect(result.duplicatePhotoPolicyMatrix).toEqual({
      base: {
        moderationMode: 'FULL',
        actionCeiling: 'MUTE',
        allowedMatchKinds: ['canonical_sha256', 'pdq'],
      },
      advanced: {
        moderationMode: 'FULL',
        actionCeiling: 'MUTE',
        allowedMatchKinds: ['canonical_sha256', 'pdq'],
      },
    });
  });

  it.each(['off', 'observed'] as const)(
    'reports photo observation-only while durable delete rollout is %s',
    async (photoDuplicateDeleteIntentRollout) => {
      const { moderationDeleteIntents, service } = createService({
        photoDuplicateDeleteIntentRollout,
        photoDuplicateConfig: {
          PHOTO_DUPLICATE_ROLLOUT_MODE: 'full',
          PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: 'chat-1',
          PHOTO_DUPLICATE_MAX_ACTION: 'BAN',
        },
      });

      const result = await service.getChatSettingsScreen('chat-1', user as never, {
        liveAdminCheck: false,
      });

      expect(result.duplicatePhotoModerationMode).toBe('OBSERVE');
      expect(result.duplicatePhotoPolicyMatrix).toMatchObject({
        base: { moderationMode: 'OBSERVE' },
        advanced: { moderationMode: 'OBSERVE' },
      });
      expect(moderationDeleteIntents.getRolloutForRule).toHaveBeenCalledWith(
        'chat-1',
        'DUPLICATE_DELETE',
      );
    },
  );

  it('recovers chat settings screen when chat rules lazy creation races', async () => {
    const recoveredRules = createPersistedChatRules({
      text: 'Строку правил создал параллельный запрос.',
    });
    const { prisma, service } = createService();
    prisma.chatRules.upsert.mockRejectedValueOnce(createPrismaUniqueConflictError());
    prisma.chatRules.findUnique.mockResolvedValueOnce(recoveredRules);

    const result = await service.getChatSettingsScreen('chat-1', user as never, {
      liveAdminCheck: false,
    });

    expect(result.rules.text).toBe('Строку правил создал параллельный запрос.');
    expect(prisma.chatRules.findUnique).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
    });
  });

  it('reads chat settings without routing through legacy getSettings', async () => {
    const { chatContextCache, legacyAdminService, prisma, service } = createService({
      botAssignmentData: {
        botId: 'bot-1',
        primaryBotId: 'bot-1',
      },
      persistedSettings: createPersistedChatSettings({
        antiSpamEnabled: false,
      }),
    });

    const result = await service.getSettings('chat-1', user as never);

    expect(result.antiSpamEnabled).toBe(false);
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.resolveChatSettingsReadBotAssignmentData).toHaveBeenCalledWith(
      'chat-1',
    );
    expect(legacyAdminService.getSettings).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      create: {
        id: 'chat-1',
        title: 'Chat chat-1',
        entityType: 'CHAT',
        catalogKind: 'MANAGED',
        botId: 'bot-1',
        primaryBotId: 'bot-1',
        settings: {
          create: {},
        },
      },
      update: {
        catalogKind: 'MANAGED',
        settings: {
          upsert: {
            update: {},
            create: {},
          },
        },
      },
      include: { settings: true },
    });
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
  });

  it('updates chat settings without routing through legacy updateSettings', async () => {
    const { chatContextCache, legacyAdminService, nightModeTransitionScheduler, prisma, service } =
      createService({
        botAssignmentData: {
          botId: 'bot-1',
          primaryBotId: 'bot-1',
        },
        currentSettings: createPersistedChatSettings(),
      });

    const result = await service.updateSettings('chat-1', user as never, {
      antiSpamEnabled: false,
    });

    expect(result.antiSpamEnabled).toBe(false);
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.updateSettings).not.toHaveBeenCalled();
    expect(legacyAdminService.resolveChatSettingsWriteBotAssignmentData).toHaveBeenCalledWith(
      'chat-1',
    );
    expect(
      legacyAdminService.assertRequiredSubscriptionSettingsForChatSettings,
    ).toHaveBeenCalledWith(expect.objectContaining({ antiSpamEnabled: false }));
    const settingsUpsert = prisma.chat.upsert.mock.calls.find(
      ([args]) => args?.where?.id === 'chat-1',
    )?.[0];
    expect(settingsUpsert).toEqual(
      expect.objectContaining({
        where: { id: 'chat-1' },
        create: expect.objectContaining({
          botId: 'bot-1',
          primaryBotId: 'bot-1',
          settings: {
            create: expect.objectContaining({
              antiSpamEnabled: false,
            }),
          },
        }),
        update: expect.objectContaining({
          settings: {
            upsert: {
              update: expect.objectContaining({
                antiSpamEnabled: false,
              }),
              create: expect.objectContaining({
                antiSpamEnabled: false,
              }),
            },
          },
        }),
      }),
    );
    expect(settingsUpsert?.update).not.toHaveProperty('botId');
    expect(settingsUpsert?.update).not.toHaveProperty('primaryBotId');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'UPDATE_SETTINGS',
        payload: {
          source: 'miniapp',
          settingKeys: ['antiSpamEnabled'],
        },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith([expect.any(Promise), expect.any(Promise)]);
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(legacyAdminService.refreshChatSettingsExecutionReadiness).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ antiSpamEnabled: false }),
    );
    expect(nightModeTransitionScheduler.reconcileChats).not.toHaveBeenCalled();
  });

  it('keeps UPDATE_SETTINGS audit metadata bounded and excludes bot speech media content', async () => {
    const { prisma, service } = createService();
    const mediaBase64 = 'A'.repeat(1_000_000);

    await service.updateSettings('chat-1', user as never, {
      botSpeechMedia: {
        greetingBotMessageText: {
          base64: mediaBase64,
          mimeType: 'image/png',
          fileName: 'private-image-name.png',
        },
      },
    });

    const auditPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      source: string;
      settingKeys: string[];
      botSpeechMedia: Array<{ key: string; mimeType: string | null; byteCount: number }>;
    };
    expect(auditPayload).toEqual({
      source: 'miniapp',
      settingKeys: ['botSpeechMedia'],
      botSpeechMedia: [
        {
          key: 'greetingBotMessageText',
          mimeType: 'image/png',
          byteCount: 750_000,
        },
      ],
    });

    const serializedPayload = JSON.stringify(auditPayload);
    expect(serializedPayload).not.toContain(mediaBase64);
    expect(serializedPayload).not.toContain('private-image-name.png');
    expect(Buffer.byteLength(serializedPayload)).toBeLessThanOrEqual(
      UPDATE_SETTINGS_AUDIT_PAYLOAD_MAX_SERIALIZED_BYTES,
    );
  });

  it('records only requested photo duplicate settings in UPDATE_SETTINGS audit metadata', async () => {
    const { prisma, service } = createService();

    await service.updateSettings('chat-1', user as never, {
      duplicatePhotoEnabled: true,
      duplicatePhotoMatchPreset: 'MINOR_EDITS',
      duplicatePhotoScope: 'CHAT',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE_SETTINGS',
        payload: {
          source: 'miniapp',
          settingKeys: [
            'duplicatePhotoEnabled',
            'duplicatePhotoMatchPreset',
            'duplicatePhotoScope',
          ],
        },
      }),
    });
  });

  it('preserves photo duplicate settings when a stale client omits the new fields', async () => {
    const { prisma, service } = createService({
      currentSettings: createPersistedChatSettings({
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: 'MINOR_EDITS',
        duplicatePhotoScope: 'CHAT',
      }),
    });

    await service.updateSettings('chat-1', user as never, {
      antiSpamEnabled: false,
    });

    const upsert = prisma.chat.upsert.mock.calls[0]?.[0];
    expect(upsert.update.settings.upsert.update).toEqual(
      expect.objectContaining({
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: 'MINOR_EDITS',
        duplicatePhotoScope: 'CHAT',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: {
          source: 'miniapp',
          settingKeys: ['antiSpamEnabled'],
        },
      }),
    });
  });

  it('normalizes required subscription settings to indefinite auto-enabled state', async () => {
    const { legacyAdminService, prisma, service } = createService();

    const result = await service.updateSettings('chat-1', user as never, {
      requiredSubscriptionEnabled: false,
      requiredSubscriptionChannelIds: [' channel-1 ', 'channel-1'],
      requiredSubscriptionButtonText: '  Подписаться  ',
      requiredSubscriptionExpiresAt: '2026-03-16T09:00:00.000Z',
    });

    expect(result.requiredSubscriptionEnabled).toBe(true);
    expect(result.requiredSubscriptionChannelIds).toEqual(['channel-1']);
    expect(result.requiredSubscriptionButtonText).toBe('Подписаться');
    expect(result.requiredSubscriptionExpiresAt).toBe('');
    expect(
      legacyAdminService.assertRequiredSubscriptionSettingsForChatSettings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionExpiresAt: '',
      }),
    );
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          settings: {
            upsert: {
              update: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1'],
                requiredSubscriptionButtonText: 'Подписаться',
                requiredSubscriptionExpiresAt: '',
              }),
              create: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1'],
                requiredSubscriptionButtonText: 'Подписаться',
                requiredSubscriptionExpiresAt: '',
              }),
            },
          },
        }),
      }),
    );
  });

  it('normalizes empty required subscription source list to disabled indefinite state', async () => {
    const { prisma, service } = createService({
      persistedSettings: createPersistedChatSettings({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionExpiresAt: '2026-03-16T09:00:00.000Z',
      }),
    });

    const result = await service.updateSettings('chat-1', user as never, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: [],
    });

    expect(result.requiredSubscriptionEnabled).toBe(false);
    expect(result.requiredSubscriptionChannelIds).toEqual([]);
    expect(result.requiredSubscriptionExpiresAt).toBe('');
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          settings: {
            upsert: {
              update: expect.objectContaining({
                requiredSubscriptionEnabled: false,
                requiredSubscriptionChannelIds: [],
                requiredSubscriptionExpiresAt: '',
              }),
              create: expect.objectContaining({
                requiredSubscriptionEnabled: false,
                requiredSubscriptionChannelIds: [],
                requiredSubscriptionExpiresAt: '',
              }),
            },
          },
        }),
      }),
    );
  });

  it('reconciles night mode transition jobs when schedule settings change', async () => {
    const { nightModeTransitionScheduler, service } = createService();

    await service.updateSettings('chat-1', user as never, {
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 22 * 60,
      nightModeEndTimeMinutes: 7 * 60,
      nightModeTimezone: 'Europe/Moscow',
    });

    expect(nightModeTransitionScheduler.reconcileChats).toHaveBeenCalledWith(['chat-1']);
  });

  it('builds channel settings screen without routing through legacy getChannelSettingsScreen', async () => {
    const channelHeader = createManagedEntityHeader({
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'channel',
    });
    const { legacyAdminService, managedBroadcastService, managedEntitiesService, service } =
      createService({
        botAssignmentData: {
          botId: 'bot-1',
          primaryBotId: 'bot-1',
        },
        managedBroadcasts: [createManagedBroadcastSummary()],
        managedEntityHeader: channelHeader,
        persistedChannelSettings: createPersistedChannelSettings({
          commentsEnabled: true,
        }),
      });

    const result = await service.getChannelSettingsScreen('channel-1', user as never, {
      liveAdminCheck: false,
    });

    expect(result.settings.commentsEnabled).toBe(true);
    expect(result.postSignature).toEqual({
      enabled: false,
      text: 'Подписаться на канал',
      url: '',
    });
    expect(result.header).toEqual(channelHeader);
    expect(result.managedBroadcasts).toHaveLength(1);
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'channel-1',
      'admin-1',
      'channel',
    );
    expect(legacyAdminService.getChannelSettingsScreen).not.toHaveBeenCalled();
    expect(legacyAdminService.getChannelSettings).not.toHaveBeenCalled();
    expect(legacyAdminService.resolveChannelSettingsReadBotAssignmentData).toHaveBeenCalledWith(
      'channel-1',
    );
    expect(managedEntitiesService.getChannelHeader).toHaveBeenCalledWith('channel-1', user, {
      skipAdminCheck: true,
      skipEntityCheck: true,
    });
    expect(managedBroadcastService.listChannelManagedBroadcasts).toHaveBeenCalledWith(
      'channel-1',
      user,
      {
        skipAdminCheck: true,
        skipEntityCheck: true,
      },
    );
  });

  it('checks channel access and delegates independent post signature reads and updates', async () => {
    const { channelPostSignatureService, legacyAdminService, service } = createService();

    await expect(service.getChannelPostSignature('channel-1', user as never)).resolves.toEqual({
      enabled: false,
      text: 'Подписаться на канал',
      url: '',
    });
    await expect(
      service.updateChannelPostSignature('channel-1', user as never, {
        enabled: true,
        text: 'Читать канал',
        url: 'https://max.ru/contact',
      }),
    ).resolves.toEqual({
      enabled: true,
      text: 'Читать канал',
      url: 'https://max.ru/contact',
    });

    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'channel-1',
      'admin-1',
      'channel',
    );
    expect(channelPostSignatureService.getSettings).toHaveBeenCalledWith('channel-1');
    expect(channelPostSignatureService.updateSettings).toHaveBeenCalledWith(
      'channel-1',
      'admin-1',
      { enabled: true, text: 'Читать канал', url: 'https://max.ru/contact' },
    );
  });

  it('updates channel settings without routing through legacy updateChannelSettings', async () => {
    const { chatContextCache, legacyAdminService, prisma, service } = createService({
      botAssignmentData: {
        botId: 'bot-1',
        primaryBotId: 'bot-1',
      },
    });

    const result = await service.updateChannelSettings('channel-1', user as never, {
      commentsEnabled: true,
      postSuggestionsEnabled: true,
    });

    expect(result).toMatchObject({ commentsEnabled: true, postSuggestionsEnabled: true });
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'channel-1',
      'admin-1',
      'channel',
    );
    expect(legacyAdminService.updateChannelSettings).not.toHaveBeenCalled();
    expect(legacyAdminService.resolveChannelSettingsWriteBotAssignmentData).toHaveBeenCalledWith(
      'channel-1',
    );
    const channelSettingsUpsert = prisma.chat.upsert.mock.calls.find(
      ([args]) => args?.where?.id === 'channel-1',
    )?.[0];
    expect(channelSettingsUpsert).toEqual(
      expect.objectContaining({
        where: { id: 'channel-1' },
        create: expect.objectContaining({
          botId: 'bot-1',
          primaryBotId: 'bot-1',
          channelSettings: {
            create: expect.objectContaining({
              commentsEnabled: true,
              postSuggestionsEnabled: true,
            }),
          },
        }),
        update: expect.objectContaining({
          channelSettings: {
            upsert: {
              update: expect.objectContaining({
                commentsEnabled: true,
                postSuggestionsEnabled: true,
              }),
              create: expect.objectContaining({
                commentsEnabled: true,
                postSuggestionsEnabled: true,
              }),
            },
          },
        }),
      }),
    );
    expect(channelSettingsUpsert?.update).not.toHaveProperty('botId');
    expect(channelSettingsUpsert?.update).not.toHaveProperty('primaryBotId');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'UPDATE_CHANNEL_SETTINGS',
        payload: expect.objectContaining({
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          source: 'miniapp',
        }),
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('channel-1');
    expect(legacyAdminService.refreshChannelSettingsExecutionReadiness).toHaveBeenCalledWith(
      'channel-1',
    );
  });

  it('publishes channel engagement without routing through legacy publishChannelEngagementMessage', async () => {
    const { channelPostSignatureService, legacyAdminService, maxClient, prisma, service } =
      createService({
        botAssignmentData: {
          botId: 'bot-1',
          primaryBotId: 'bot-1',
        },
        persistedChannelSettings: createPersistedChannelSettings({
          chatId: 'channel-1',
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          engagementPublishedMessageId: null,
          engagementPublishedThreadId: null,
          engagementPublishedAt: null,
          postSuggestionsEntryMode: 'BOT',
        }),
      });

    const result = await service.publishChannelEngagementMessage('channel-1', user as never, {
      text: 'Нажмите кнопку ниже.',
      commentsButtonText: 'Комментарии',
      suggestButtonText: 'Предложить',
    });

    const artifactParams =
      legacyAdminService.buildChannelEngagementDialogArtifacts.mock.calls[0]?.[0];
    const threadId = artifactParams.threadId;

    expect(result).toMatchObject({
      chatId: 'channel-1',
      sent: true,
      messageId: 'message-2',
      updatedExisting: false,
      publishedAt: expect.any(String),
    });
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'channel-1',
      'admin-1',
      'channel',
    );
    expect(legacyAdminService.publishChannelEngagementMessage).not.toHaveBeenCalled();
    expect(channelPostSignatureService.preparePostText).toHaveBeenCalledWith(
      'channel-1',
      { text: 'Нажмите кнопку ниже.' },
      {
        entityType: 'channel',
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      },
    );
    expect(legacyAdminService.resolveChannelEngagementActionBotId).toHaveBeenCalledWith(
      'channel-1',
    );
    expect(artifactParams).toMatchObject({
      chatId: 'channel-1',
      threadId: expect.any(String),
      formattedCommentsButtonText: 'Комментарии · 0',
      suggestButtonText: 'Предложить',
      botId: 'bot-1',
      suggestionEntryMode: 'BOT',
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Нажмите кнопку ниже.',
      {
        buttons: [
          [
            {
              type: 'link',
              text: 'Комментарии · 0',
              url: `https://max.ru/777000_bot?startapp=comments-${threadId}`,
            },
          ],
          [
            {
              type: 'link',
              text: 'Предложить',
              url: `https://max.ru/777000_bot?start=cds-channel-1-${threadId}`,
            },
          ],
        ],
      },
      {
        botId: 'bot-1',
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        timeoutMs: 10_000,
      },
    );
    expect(prisma.channelSettings.upsert).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      create: {
        chatId: 'channel-1',
        commentsEnabled: false,
      },
      update: {},
      select: {
        engagementPublishedMessageId: true,
        engagementPublishedBotId: true,
        engagementPublishedThreadId: true,
        engagementPublishedAt: true,
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSuggestionsEntryMode: true,
      },
    });
    expect(prisma.channelSettings.update).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      data: {
        engagementPublishedMessageId: 'message-2',
        engagementPublishedBotId: 'bot-1',
        engagementPublishedThreadId: threadId,
        engagementPublishedAt: expect.any(Date),
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'PUBLISH_CHANNEL_ENGAGEMENT',
        payload: expect.objectContaining({
          messageId: 'message-2',
          text: 'Нажмите кнопку ниже.',
          commentsButtonText: 'Комментарии',
          suggestButtonText: 'Предложить',
          includeCommentsButton: true,
          includeSuggestButton: true,
          threadId,
          updatedExisting: false,
          recreatedFromMessageId: null,
          commentsUrl: `https://max.ru/channel-1/comments/${threadId}`,
          suggestPayload: `cds-channel-1-${threadId}`,
          suggestUrl: `https://max.ru/777000_bot?start=cds-channel-1-${threadId}`,
          suggestionEntryMode: 'BOT',
          botId: 'bot-1',
        }),
      },
    });
  });

  it('uses the edit-capable bot when updating a legacy channel engagement post without a stored bot id', async () => {
    const { legacyAdminService, maxClient, prisma, service } = createService({
      persistedChannelSettings: createPersistedChannelSettings({
        chatId: 'channel-1',
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        engagementPublishedMessageId: 'message-old',
        engagementPublishedBotId: null,
        engagementPublishedThreadId: 'thread-existing',
        engagementPublishedAt: new Date('2026-03-20T09:00:00.000Z'),
        postSuggestionsEntryMode: 'BOT',
      }),
    });
    legacyAdminService.resolveChannelEngagementActionBotId.mockResolvedValue('send-bot');
    legacyAdminService.resolveChannelEngagementEditBotId.mockResolvedValue('edit-bot');

    const result = await service.publishChannelEngagementMessage('channel-1', user as never, {
      text: 'Обновленный пост.',
      commentsButtonText: 'Комментарии',
      suggestButtonText: 'Предложить',
    });

    expect(result).toMatchObject({
      chatId: 'channel-1',
      sent: true,
      messageId: 'message-old',
      updatedExisting: true,
    });
    expect(legacyAdminService.resolveChannelEngagementActionBotId).not.toHaveBeenCalled();
    expect(legacyAdminService.resolveChannelEngagementEditBotId).toHaveBeenCalledWith('channel-1');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'message-old',
      'Обновленный пост.',
      expect.any(Object),
      expect.objectContaining({ botId: 'edit-bot' }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.channelSettings.update).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      data: {
        engagementPublishedMessageId: 'message-old',
        engagementPublishedBotId: 'edit-bot',
        engagementPublishedThreadId: 'thread-existing',
        engagementPublishedAt: new Date('2026-03-20T09:00:00.000Z'),
      },
    });
  });

  it('applies settings to target chats without routing through legacy applySettingsToAllChats', async () => {
    const { chatContextCache, legacyAdminService, nightModeTransitionScheduler, prisma, service } =
      createService({
        botAssignmentData: {
          botId: 'bot-1',
          primaryBotId: 'bot-1',
        },
        applyTargetChats: [
          createChatSummary({ id: 'chat-1' }),
          createChatSummary({ id: 'chat-2', title: 'Второй чат' }),
        ],
      });
    const settings = chatSettingsSchema.parse({ antiSpamEnabled: false });

    const result = await service.applySettingsToAllChats('chat-1', user as never, settings);

    expect(result).toEqual({
      sourceChatId: 'chat-1',
      updatedChats: 2,
      appliedChatIds: ['chat-1', 'chat-2'],
    });
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.applySettingsToAllChats).not.toHaveBeenCalled();
    expect(legacyAdminService.normalizeChatSettingsForApply).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ antiSpamEnabled: false }),
    );
    expect(legacyAdminService.resolveSettingsApplyTargetChatsForSettings).toHaveBeenCalledWith(
      'chat-1',
      user,
      { mode: 'all', favoriteTypes: [], chatIds: [] },
    );
    expect(legacyAdminService.resolveSettingsApplyBotAssignmentData).toHaveBeenCalledWith('chat-1');
    expect(legacyAdminService.resolveSettingsApplyBotAssignmentData).toHaveBeenCalledWith('chat-2');
    const targetSettingsUpsert = prisma.chat.upsert.mock.calls.find(
      ([args]) => args?.where?.id === 'chat-2',
    )?.[0];
    expect(targetSettingsUpsert).toEqual(
      expect.objectContaining({
        where: { id: 'chat-2' },
        create: expect.objectContaining({
          botId: 'bot-1',
          primaryBotId: 'bot-1',
          settings: {
            create: expect.objectContaining({
              antiSpamEnabled: false,
            }),
          },
        }),
        update: expect.objectContaining({
          settings: {
            upsert: {
              update: expect.objectContaining({
                antiSpamEnabled: false,
              }),
              create: expect.objectContaining({
                antiSpamEnabled: false,
              }),
            },
          },
        }),
      }),
    );
    expect(targetSettingsUpsert?.update).not.toHaveProperty('botId');
    expect(targetSettingsUpsert?.update).not.toHaveProperty('primaryBotId');
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-2',
        actorUserId: 'admin-1',
        action: 'APPLY_SETTINGS_TO_ALL_CHATS',
        payload: {
          sourceChatId: 'chat-1',
          targetChatId: 'chat-2',
          source: 'miniapp',
          targetMode: 'all',
        },
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-2');
    expect(
      legacyAdminService.scheduleApplySettingsToAllReadinessRefreshForSettings,
    ).toHaveBeenCalledWith({
      chatIds: ['chat-1', 'chat-2'],
      shouldRefreshRequiredSubscription: false,
      requiredSubscriptionChannelIds: [],
    });
    expect(nightModeTransitionScheduler.reconcileChats).toHaveBeenCalledWith(['chat-1', 'chat-2']);
  });

  it('applies settings sections without routing through legacy section endpoint', async () => {
    const { legacyAdminService, nightModeTransitionScheduler, prisma, service } = createService({
      applyTargetChats: [createChatSummary({ id: 'chat-2', title: 'Второй чат' })],
      persistedSettings: createPersistedChatSettings({
        linkPolicy: 'BLOCKLIST_ONLY',
        linkBotMessageEnabled: true,
        linkBotMessageText: 'Ссылки нельзя.',
      }),
    });

    const result = await service.applySettingsSectionToAllChats('chat-1', user as never, {
      section: 'links',
      target: { mode: 'selectedChats', favoriteTypes: [], chatIds: ['chat-2'] },
    });

    expect(result).toEqual({
      section: 'links',
      targetMode: 'selectedChats',
      favoriteTypes: [],
      sourceChatId: 'chat-1',
      updatedChats: 1,
      appliedChatIds: ['chat-2'],
    });
    expect(legacyAdminService.applySettingsSectionToAllChats).not.toHaveBeenCalled();
    expect(legacyAdminService.applySettingsToAllChats).not.toHaveBeenCalled();
    expect(legacyAdminService.getSettings).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-2' },
        update: expect.objectContaining({
          settings: {
            upsert: {
              update: expect.objectContaining({
                linkPolicy: 'BLOCKLIST_ONLY',
                linkBotMessageEnabled: true,
                linkBotMessageText: 'Ссылки нельзя.',
              }),
              create: expect.objectContaining({
                linkPolicy: 'BLOCKLIST_ONLY',
                linkBotMessageEnabled: true,
                linkBotMessageText: 'Ссылки нельзя.',
              }),
            },
          },
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-2',
        action: 'APPLY_SETTINGS_TO_ALL_CHATS',
        payload: expect.objectContaining({
          sourceChatId: 'chat-1',
          targetChatId: 'chat-2',
          targetMode: 'selectedChats',
          settingKeys: expect.arrayContaining(['linkPolicy', 'linkBotMessageText']),
        }),
      }),
    });
    expect(legacyAdminService.syncDomainAllowlistToChatsForSettings).toHaveBeenCalledWith(
      'chat-1',
      ['chat-2'],
    );
    expect(nightModeTransitionScheduler.reconcileChats).not.toHaveBeenCalled();
  });

  it('defaults section apply target to the current chat when target is omitted', async () => {
    const { legacyAdminService, prisma, service } = createService({
      applyTargetChats: [createChatSummary()],
      persistedSettings: createPersistedChatSettings({
        linkPolicy: 'BLOCKLIST_ONLY',
        linkBotMessageEnabled: true,
      }),
    });

    legacyAdminService.resolveSettingsApplyTargetChatsForSettings.mockImplementation(
      async (_sourceChatId: string, _user: unknown, target: { mode: string }) =>
        target.mode === 'current'
          ? [createChatSummary()]
          : [createChatSummary(), createChatSummary({ id: 'chat-2', title: 'Второй чат' })],
    );

    const result = await service.applySettingsSectionToAllChats('chat-1', user as never, {
      section: 'links',
    });

    expect(result).toEqual({
      section: 'links',
      targetMode: 'current',
      favoriteTypes: [],
      sourceChatId: 'chat-1',
      updatedChats: 1,
      appliedChatIds: ['chat-1'],
    });
    expect(legacyAdminService.resolveSettingsApplyTargetChatsForSettings).toHaveBeenCalledWith(
      'chat-1',
      user,
      { mode: 'current', favoriteTypes: [], chatIds: [] },
    );
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-1' },
      }),
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-2' },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'APPLY_SETTINGS_TO_ALL_CHATS',
        payload: expect.objectContaining({
          sourceChatId: 'chat-1',
          targetChatId: 'chat-1',
          targetMode: 'current',
        }),
      }),
    });
  });

  it('applies required subscription section without copying duration or expiry fields', async () => {
    const { legacyAdminService, prisma, service } = createService({
      applyTargetChats: [createChatSummary({ id: 'chat-2', title: 'Второй чат' })],
      persistedSettings: createPersistedChatSettings({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionDurationDays: 14,
        requiredSubscriptionExpiresAt: '2026-03-16T09:00:00.000Z',
      }),
    });

    legacyAdminService.isRequiredSubscriptionCurrentlyActiveForSettings.mockReturnValue(true);

    const result = await service.applySettingsSectionToAllChats('chat-1', user as never, {
      section: 'requiredSubscription',
      target: { mode: 'selectedChats', favoriteTypes: [], chatIds: ['chat-2'] },
    });

    expect(result.updatedChats).toBe(1);
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat-2' },
        update: expect.objectContaining({
          settings: {
            upsert: {
              update: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1'],
              }),
              create: expect.objectContaining({
                requiredSubscriptionEnabled: true,
                requiredSubscriptionChannelIds: ['channel-1'],
              }),
            },
          },
        }),
      }),
    );
    const updatePayload = prisma.chat.upsert.mock.calls[0]?.[0].update.settings.upsert.update;
    const createPayload = prisma.chat.upsert.mock.calls[0]?.[0].update.settings.upsert.create;
    expect(updatePayload).not.toHaveProperty('requiredSubscriptionDurationDays');
    expect(updatePayload).not.toHaveProperty('requiredSubscriptionExpiresAt');
    expect(createPayload).not.toHaveProperty('requiredSubscriptionDurationDays');
    expect(createPayload).not.toHaveProperty('requiredSubscriptionExpiresAt');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-2',
        action: 'APPLY_SETTINGS_TO_ALL_CHATS',
        payload: expect.objectContaining({
          settingKeys: expect.arrayContaining([
            'requiredSubscriptionEnabled',
            'requiredSubscriptionChannelIds',
          ]),
        }),
      }),
    });
    const auditPayload = prisma.auditLog.create.mock.calls[0]?.[0].data.payload;
    expect(auditPayload.settingKeys).not.toContain('requiredSubscriptionDurationDays');
    expect(auditPayload.settingKeys).not.toContain('requiredSubscriptionExpiresAt');
  });

  it('previews apply-settings target without routing through legacy preview endpoint', async () => {
    const { legacyAdminService, service } = createService({
      applyTargetChats: [createChatSummary({ id: 'chat-2', title: 'Второй чат' })],
    });

    const result = await service.previewApplySettingsSectionTarget('chat-1', user as never, {
      target: { mode: 'selectedChats', favoriteTypes: [], chatIds: ['chat-2'] },
    });

    expect(result).toEqual({
      sourceChatId: 'chat-1',
      targetMode: 'selectedChats',
      favoriteTypes: [],
      updatedChats: 1,
      appliedChatIds: ['chat-2'],
      sampleChats: [createChatSummary({ id: 'chat-2', title: 'Второй чат' })],
    });
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.previewApplySettingsSectionTarget).not.toHaveBeenCalled();
    expect(legacyAdminService.resolveSettingsApplyTargetChatsForSettings).toHaveBeenCalledWith(
      'chat-1',
      user,
      { mode: 'selectedChats', favoriteTypes: [], chatIds: ['chat-2'] },
    );
  });

  it('resolves required subscription channel without routing through legacy endpoint method', async () => {
    const { legacyAdminService, service } = createService({
      resolvedRequiredSubscriptionChannel: createManagedEntityHeader({
        id: 'channel-1',
        title: 'Канал новостей',
        entityType: 'channel',
        primaryBotId: 'bot-1',
        assignedBots: [
          {
            botId: 'bot-1',
            label: 'Owner bot',
            role: 'primary',
            membershipStatus: 'active',
            lifecycleState: 'active',
            speechPersona: 'male',
            capabilities: [],
            permissionsSummary: null,
          },
        ],
        sharedMode: 'shared-standby',
      }),
    });

    const result = await service.resolveRequiredSubscriptionChannel('chat-1', user as never, {
      value: 'https://max.ru/channels/news',
    });

    expect(result.channel).toMatchObject({
      id: 'channel-1',
      title: 'Канал новостей',
      entityType: 'channel',
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned',
    });
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.resolveRequiredSubscriptionChannel).not.toHaveBeenCalled();
    expect(
      legacyAdminService.resolveRequiredSubscriptionChannelReferenceValue,
    ).toHaveBeenCalledWith('https://max.ru/channels/news');
  });

  it('reads rules without routing through legacy getRules', async () => {
    const { chatContextCache, legacyAdminService, maxClient, prisma, service } = createService({
      botAssignmentData: {
        botId: 'bot-1',
        primaryBotId: 'bot-1',
      },
      persistedRules: createPersistedChatRules({
        publishedMessageId: 'message-1',
        publishedUrl: '',
        publishedAt: new Date('2026-03-09T09:30:00.000Z'),
      }),
      resolvedRulesUrl: 'https://max.ru/chats/chat-1/message/1',
    });

    const result = await service.getRules('chat-1', user as never);

    expect(result).toMatchObject({
      text: 'Пишите по теме.',
      publishedMessageId: 'message-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/1',
      publishedAt: '2026-03-09T09:30:00.000Z',
    });
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.getRules).not.toHaveBeenCalled();
    expect(prisma.chatRules.upsert).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      create: {
        chatId: 'chat-1',
        autoTextEnabled: true,
      },
      update: {},
    });
    expect(legacyAdminService.resolveChatSettingsReadBotAssignmentData).toHaveBeenCalledWith(
      'chat-1',
    );
    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
        timeoutMs: 2500,
      }),
    );
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: {
        publishedUrl: 'https://max.ru/chats/chat-1/message/1',
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
  });

  it('hydrates a published rules URL through the persisted publication bot first', async () => {
    const { maxClient, service } = createService({
      botAssignmentData: {
        botId: 'current-route-bot',
        primaryBotId: 'current-route-bot',
      },
      persistedRules: createPersistedChatRules({
        publishedMessageId: 'message-1',
        publishedBotId: 'rules-author-bot',
        publishedUrl: '',
        publishedAt: new Date('2026-03-09T09:30:00.000Z'),
      }),
      resolvedRulesUrl: 'https://max.ru/chats/chat-1/message/1',
    });

    await service.getRules('chat-1', user as never);

    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith('message-1', {
      botId: 'rules-author-bot',
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
      timeoutMs: 2500,
    });
  });

  it('publishes rules without routing through legacy publishRules', async () => {
    const { chatContextCache, legacyAdminService, maxClient, prisma, service } = createService({
      botAssignmentData: {
        botId: 'bot-1',
        primaryBotId: 'bot-1',
      },
      persistedRules: createPersistedChatRules({
        text: 'Пишите по теме.',
        buttons: [{ text: 'Подробнее', url: 'https://example.com/rules' }],
        buttonEnabled: true,
        buttonUrl: 'https://example.com/rules',
        buttonText: 'Подробнее',
      }),
    });

    const result = await service.publishRules('chat-1', user as never);

    expect(result).toEqual({
      chatId: 'chat-1',
      messageId: 'message-2',
      url: 'https://max.ru/chats/chat-1/message/2',
      publishedAt: expect.any(String),
    });
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.publishRules).not.toHaveBeenCalled();
    expect(legacyAdminService.resolveChatRulesActionBotId).toHaveBeenCalledWith('chat-1');
    expect(legacyAdminService.buildFormattedChatRulesPublicationText).toHaveBeenCalledWith(
      'chat-1',
      'Пишите по теме.',
      {
        adminContactButtonEnabled: false,
        adminContactButtonUrl: '',
      },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Пишите по теме.',
      {
        textFormat: 'markdown',
        buttons: [[{ type: 'link', text: 'Подробнее', url: 'https://example.com/rules' }]],
      },
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
        timeoutMs: 12000,
      }),
    );
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', publishOperationId: expect.any(String) },
      data: expect.objectContaining({
        publishedMessageId: 'message-2',
        publishedBotId: 'bot-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/2',
        publishedAt: expect.any(Date),
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'PUBLISH_CHAT_RULES',
        payload: expect.objectContaining({
          buttonEnabled: true,
          source: 'miniapp',
        }),
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(legacyAdminService.sendPublishedChatRulesPrivateConfirmation).toHaveBeenCalledWith(
      user,
      'https://max.ru/chats/chat-1/message/2',
    );
  });

  it('does not promise photo enforcement in autofilled rules while rollout is observe-only', async () => {
    const { legacyAdminService, service } = createService({
      persistedRules: createPersistedChatRules({
        autoTextEnabled: true,
        text: '',
      }),
      persistedSettings: createPersistedChatSettings({
        antiDuplicateEnabled: true,
        duplicatePhotoEnabled: true,
      }),
      photoDuplicateConfig: {
        PHOTO_DUPLICATE_ROLLOUT_MODE: 'shadow',
      },
    });

    await service.publishRules('chat-1', user as never);

    const generatedText =
      legacyAdminService.buildFormattedChatRulesPublicationText.mock.calls[0]?.[1];
    expect(generatedText).toContain('Не повторяйте одно и то же сообщение');
    expect(generatedText).not.toContain('сообщения и фото');
    expect(
      legacyAdminService.buildAutofilledChatRulesTextFromCurrentSettings,
    ).not.toHaveBeenCalled();
  });

  it('hydrates a published rules URL through the action bot when MAX send omits the URL', async () => {
    const { legacyAdminService, maxClient, service } = createService({
      botAssignmentData: {
        botId: 'bot-1',
        primaryBotId: 'bot-1',
      },
      persistedRules: createPersistedChatRules({
        text: 'Пишите по теме.',
      }),
      publishedRulesMessage: {
        messageId: 'message-2',
        url: null,
      },
      resolvedRulesUrl: 'https://max.ru/chats/chat-1/message/2',
    });

    const result = await service.publishRules('chat-1', user as never);

    expect(result.url).toBe('https://max.ru/chats/chat-1/message/2');
    expect(legacyAdminService.resolveChatRulesActionBotId).toHaveBeenCalledWith('chat-1');
    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith(
      'message-2',
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
        timeoutMs: 2500,
      }),
    );
  });

  it('resets published rules without routing through legacy resetPublishedRules', async () => {
    const { chatContextCache, legacyAdminService, maxClient, prisma, service } = createService({
      botAssignmentData: {
        botId: 'bot-1',
        primaryBotId: 'bot-1',
      },
      persistedRules: createPersistedChatRules({
        publishedMessageId: 'message-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/1',
        publishedAt: new Date('2026-03-09T09:30:00.000Z'),
      }),
      persistedRulesUpdate: createPersistedChatRules({
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      }),
    });

    const result = await service.resetPublishedRules('chat-1', user as never);

    expect(result.publishedMessageId).toBeNull();
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.resetPublishedRules).not.toHaveBeenCalled();
    expect(legacyAdminService.resolveChatRulesActionBotId).toHaveBeenCalledWith('chat-1');
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'message-1', {
      immediate: true,
      botId: 'bot-1',
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
      timeoutMs: 12000,
    });
    expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          publishedMessageId: 'message-1',
          pendingCleanupMessageId: null,
        }),
        data: expect.objectContaining({
          pendingCleanupMessageId: 'message-1',
          pendingCleanupKind: 'reset_current',
        }),
      }),
    );
    expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { chatId: 'chat-1', publishedMessageId: 'message-1' },
        data: expect.objectContaining({
          publishedMessageId: null,
          pendingCleanupMessageId: null,
          pendingCleanupKind: null,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'RESET_CHAT_RULES_PUBLICATION',
        payload: {
          deletedPost: true,
          cleanupOutcome: 'confirmed',
          messageId: 'message-1',
          botId: 'bot-1',
          source: 'miniapp',
        },
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
  });

  it('updates rules draft without routing through legacy updateRules', async () => {
    const { chatContextCache, legacyAdminService, prisma, service } = createService();

    const result = await service.updateRules('chat-1', user as never, {
      text: 'Пишите по теме.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
    });

    expect(result.text).toBe('Пишите по теме.');
    expect(legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(legacyAdminService.updateRules).not.toHaveBeenCalled();
    expect(prisma.chatRules.upsert).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      create: expect.objectContaining({
        chatId: 'chat-1',
        text: 'Пишите по теме.',
        imageBase64: '',
      }),
      update: expect.objectContaining({
        text: 'Пишите по теме.',
        imageBase64: '',
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'UPDATE_CHAT_RULES',
        payload: expect.objectContaining({
          autoTextEnabled: false,
          buttonEnabled: false,
          source: 'miniapp',
          textLength: 'Пишите по теме.'.length,
        }),
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
  });

  it('updates rules draft after concurrent chat rules creation wins the upsert race', async () => {
    const { prisma, service } = createService();
    prisma.chatRules.upsert.mockRejectedValueOnce(createPrismaUniqueConflictError());
    prisma.chatRules.update.mockResolvedValueOnce(
      createPersistedChatRules({
        text: 'Пишите по теме.',
        autoTextEnabled: false,
      }),
    );

    const result = await service.updateRules('chat-1', user as never, {
      text: 'Пишите по теме.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
    });

    expect(result.text).toBe('Пишите по теме.');
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        text: 'Пишите по теме.',
        autoTextEnabled: false,
      }),
    });
  });
});
