import {
  addDomainRequestSchema,
  applySectionTargetPreviewResponseSchema,
  applySectionToAllResponseSchema,
  applySettingsTargetSchema,
  broadcastHandoffStateSchema,
  channelPostSignatureSettingsSchema,
  channelSettingsSchema,
  channelSettingsScreenResponseSchema,
  chatRulesSchema,
  chatSettingsSchema,
  chatSettingsScreenResponseSchema,
  domainAllowlistEntrySchema,
  inferAllowlistMatchType,
  managedBroadcastDetailsSchema,
  managedEntityHeaderSchema,
  normalizeStoredNavigationAllowlistEntry,
  parseStoredAllowlistEntry,
  publishChannelEngagementResultSchema,
  publishChatRulesResultSchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  sendBroadcastTestResultSchema,
  updateChannelPostSignatureRequestSchema,
  updateManagedEntityPartnerAssistRequestSchema,
  updateManagedEntityPrimaryBotRequestSchema,
  type BroadcastHandoffResponse,
  type BroadcastHandoffState,
  type ChannelSettingsScreenResponse,
  type ChatSettingsScreenResponse,
  type ManagedBroadcastDetails,
  type PublishChannelEngagementResult,
  type PublishChatRulesResult,
} from '@maxim/contracts';
import {
  createManagedPollRequestSchema,
  managedPollDetailsSchema,
  managedPollListQuerySchema,
  managedPollListResponseSchema,
  managedPollVotersQuerySchema,
  managedPollVotersResponseSchema,
  updateManagedPollRequestSchema,
} from '@maxim/contracts/poll';
import {
  resolveChannelAvatarUrl,
  resolveChannelTitle,
  resolveChatAvatarUrl,
  resolveChatTitle,
} from './preview-transport-dialog';
import {
  PREVIEW_NOT_HANDLED,
  readPreviewClock,
  resolvePreviewEntityRequest,
  type PreviewClock,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import { cloneJson } from './preview-transport-shared';
import {
  PREVIEW_STANDBY_BOT_ID,
  buildPreviewAssignedBots,
  buildPreviewBotExecutionPlan,
  buildPreviewBotSpeechProfile,
  buildPreviewSharedMode,
  resolvePreviewApplyTargetChats,
} from './preview-transport-system';
import type { PreviewState } from './preview-transport-state';

export function buildBroadcastSummary(details: ManagedBroadcastDetails) {
  const imageCount = details.images.length || (details.imageEnabled ? 1 : 0);
  return {
    id: details.id,
    status: details.status,
    textPreview:
      details.text.trim().slice(0, 120) ||
      (imageCount > 0 ? 'Фото без текста' : 'Пустой автопостинг'),
    textLength: details.text.length,
    targetMode: details.targetMode,
    applyToAllChats: details.applyToAllChats,
    targetChats: details.targetChatIds.length || 1,
    hasImage: imageCount > 0,
    imageCount,
    hasVideo: details.mediaType === 'video',
    buttons: details.buttons,
    buttonEnabled: details.buttonEnabled,
    scheduleMode: details.scheduleMode,
    scheduleTimezone: details.scheduleTimezone,
    scheduledSlots: details.scheduledSlots,
    nextSendAt: details.nextSendAt,
    cycleEnabled: details.cycleEnabled,
    cycleEveryHours: details.cycleEveryHours,
    cycleCount: details.cycleCount,
    sentCount: details.sentCount,
    currentOccurrence: details.currentOccurrence,
    deliveredChats: details.deliveredChats,
    failedChats: details.failedChats,
    pendingChats: details.pendingChats,
    blockedChats: details.blockedChats,
    failureBreakdown: details.failureBreakdown,
    canRetry: details.canRetry,
    remainingCount: details.remainingCount,
    createdAt: details.createdAt,
    updatedAt: details.updatedAt,
    lastError: details.lastError,
  };
}

export function buildBroadcastHandoffState(
  details: ManagedBroadcastDetails,
): BroadcastHandoffState {
  return broadcastHandoffStateSchema.parse({
    targetMode: details.targetMode,
    targetChatIds: details.targetChatIds,
    applyToAllChats: details.applyToAllChats,
    buttons: details.buttons,
    buttonEnabled: details.buttonEnabled,
    buttonUrl: details.buttonUrl,
    buttonText: details.buttonText,
    scheduleMode: details.scheduleMode,
    scheduleTimezone: details.scheduleTimezone,
    scheduledSlots: details.scheduledSlots,
    sendAt: details.nextSendAt,
    cycleEnabled: details.cycleEnabled,
    cycleEveryHours: details.cycleEveryHours,
    cycleCount: details.cycleCount,
    hasContent: Boolean(
      details.text.trim() || details.imageEnabled || details.mediaType === 'video',
    ),
  });
}

export function buildChatSettingsScreen(
  state: PreviewState,
  chatId: string,
): ChatSettingsScreenResponse {
  const assignedBots = buildPreviewAssignedBots(
    {
      primaryBotId: state.chatPrimaryBotId,
      assistEnabled: state.chatPartnerAssistEnabled,
    },
    state.clock,
  );
  return chatSettingsScreenResponseSchema.parse({
    settings: state.chatSettings,
    duplicatePhotoModerationMode: 'OBSERVE',
    rules: state.chatRules,
    header: {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      entityType: 'chat',
      link: null,
      participantsCount: state.chatHeaderParticipantsCount,
      avatarUrl: resolveChatAvatarUrl(chatId, state),
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned',
      botCount: assignedBots.length,
      hasSharedAutomation: assignedBots.length > 1,
      ...(state.accessDiagnostics ? { accessDiagnostics: state.accessDiagnostics } : {}),
    },
    botSpeechPreviewProfile: buildPreviewBotSpeechProfile(state.chatPrimaryBotId, assignedBots),
    requiredSubscriptionChannels: (state.chatSettings.requiredSubscriptionChannelIds ?? []).map(
      (channelId) => {
        const channel =
          state.channels.find((item) => item.id === channelId) ??
          state.chats.find((item) => item.id === channelId);
        return {
          id: channelId,
          title:
            channel?.title ??
            (channel?.entityType === 'chat'
              ? resolveChatTitle(channelId, state)
              : resolveChannelTitle(channelId, state)),
          entityType: channel?.entityType ?? 'channel',
          link: channel?.link ?? null,
          participantsCount: null,
          avatarUrl:
            channel?.avatarUrl ??
            (channel?.entityType === 'chat'
              ? resolveChatAvatarUrl(channelId, state)
              : resolveChannelAvatarUrl(channelId, state)),
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
          botCount: channel?.botCount,
          hasSharedAutomation: channel?.hasSharedAutomation,
        };
      },
    ),
    domains: state.chatDomains,
    managedBroadcasts: state.chatBroadcasts.map(buildBroadcastSummary),
  });
}

export function buildChannelSettingsScreen(
  state: PreviewState,
  channelId: string,
): ChannelSettingsScreenResponse {
  const assignedBots = buildPreviewAssignedBots(
    {
      primaryBotId: state.channelPrimaryBotId,
      assistEnabled: state.channelPartnerAssistEnabled,
    },
    state.clock,
  );
  return channelSettingsScreenResponseSchema.parse({
    settings: state.channelSettings,
    postSignature: state.channelPostSignature,
    header: {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      entityType: 'channel',
      link: 'https://max.ru/channels/yuzhnoe-news',
      participantsCount: state.channelHeaderParticipantsCount,
      avatarUrl: resolveChannelAvatarUrl(channelId, state),
      primaryBotId: state.channelPrimaryBotId,
      assignedBots,
      sharedMode: buildPreviewSharedMode(state.channelPartnerAssistEnabled),
      botCount: assignedBots.length,
      hasSharedAutomation: assignedBots.length > 1,
      ...(state.accessDiagnostics ? { accessDiagnostics: state.accessDiagnostics } : {}),
    },
    managedBroadcasts: state.channelBroadcasts.map(buildBroadcastSummary),
  });
}

export function parseJsonBody(init?: RequestInit): unknown {
  if (!init?.body || typeof init.body !== 'string') {
    return null;
  }

  return JSON.parse(init.body);
}

export function createBroadcastHandoffResponse(): BroadcastHandoffResponse {
  return {
    botUrl: 'https://max.ru/maxim-bot',
  };
}

export function createPublishRulesResult(
  chatId: string,
  clock: PreviewClock,
): PublishChatRulesResult {
  const now = readPreviewClock(clock);
  return publishChatRulesResultSchema.parse({
    chatId,
    messageId: `rules-${now.getTime()}`,
    url: 'https://max.ru/community/rules-preview',
    publishedAt: now.toISOString(),
  });
}

export function createPublishEngagementResult(
  chatId: string,
  clock: PreviewClock,
): PublishChannelEngagementResult {
  const now = readPreviewClock(clock);
  return publishChannelEngagementResultSchema.parse({
    chatId,
    sent: true,
    messageId: `engagement-${now.getTime()}`,
    updatedExisting: true,
    publishedAt: now.toISOString(),
  });
}

export function findBroadcast(
  broadcasts: ManagedBroadcastDetails[],
  broadcastId: string,
): ManagedBroadcastDetails | null {
  return broadcasts.find((item) => item.id === broadcastId) ?? null;
}

export async function handleChatRequest(
  state: PreviewState,
  chatId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): Promise<unknown> {
  if (tail[0] === 'header' && method === 'GET') {
    const assignedBots = buildPreviewAssignedBots(
      {
        primaryBotId: state.chatPrimaryBotId,
        assistEnabled: state.chatPartnerAssistEnabled,
      },
      state.clock,
    );

    return managedEntityHeaderSchema.parse({
      id: chatId,
      title: resolveChatTitle(chatId, state),
      entityType: 'chat',
      link: null,
      participantsCount: state.chatHeaderParticipantsCount,
      avatarUrl: resolveChatAvatarUrl(chatId, state),
      primaryBotId: state.chatPrimaryBotId,
      assignedBots,
      sharedMode: buildPreviewSharedMode(state.chatPartnerAssistEnabled),
      botCount: assignedBots.length,
      hasSharedAutomation: assignedBots.length > 1,
    });
  }

  if (tail[0] === 'settings-screen' && method === 'GET') {
    return cloneJson(buildChatSettingsScreen(state, chatId));
  }

  if (tail[0] === 'bots' && tail[1] === 'plan' && method === 'GET') {
    return cloneJson(buildPreviewBotExecutionPlan(state, 'chat', chatId));
  }

  if (tail[0] === 'bots' && tail[1] === 'primary' && method === 'POST') {
    const payload = updateManagedEntityPrimaryBotRequestSchema.parse(parseJsonBody(init));
    state.chatPrimaryBotId = payload.botId;
    return cloneJson(buildPreviewBotExecutionPlan(state, 'chat', chatId));
  }

  if (tail[0] === 'bots' && tail[1] === 'partner-assist' && method === 'POST') {
    const payload = updateManagedEntityPartnerAssistRequestSchema.parse(parseJsonBody(init));
    state.chatPartnerAssistEnabled =
      payload.enabled && payload.botId.trim() === PREVIEW_STANDBY_BOT_ID;
    return cloneJson(buildPreviewBotExecutionPlan(state, 'chat', chatId));
  }

  if (
    tail[0] === 'required-subscription' &&
    tail[1] === 'channels' &&
    tail[2] === 'resolve' &&
    method === 'POST'
  ) {
    const payload = resolveRequiredSubscriptionChannelRequestSchema.parse(parseJsonBody(init));
    const normalizedValue = payload.value.trim().toLowerCase();
    const normalizedLink = normalizedValue.startsWith('http')
      ? normalizedValue
      : normalizedValue.startsWith('max.ru/')
        ? `https://${normalizedValue}`
        : normalizedValue;
    const channel = [...state.chats, ...state.channels].find(
      (item) =>
        item.id === payload.value.trim() ||
        item.link?.trim().toLowerCase() === normalizedLink ||
        item.link?.trim().toLowerCase() === payload.value.trim().toLowerCase(),
    );

    if (!channel) {
      throw new Error('Чат или канал по этой ссылке не найден.');
    }

    return resolveRequiredSubscriptionChannelResponseSchema.parse({
      channel: {
        id: channel.id,
        title: channel.title,
        entityType: channel.entityType,
        link: channel.link ?? null,
        participantsCount: null,
        avatarUrl:
          channel.avatarUrl ??
          (channel.entityType === 'chat'
            ? resolveChatAvatarUrl(channel.id, state)
            : resolveChannelAvatarUrl(channel.id, state)),
      },
    });
  }

  if (tail[0] === 'settings' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatSettings);
    }

    if (method === 'PUT') {
      state.chatSettings = chatSettingsSchema.parse(parseJsonBody(init));
      return cloneJson(state.chatSettings);
    }
  }

  if (tail[0] === 'settings' && tail[1] === 'apply-section-to-all' && method === 'POST') {
    const payload = parseJsonBody(init) as { section?: string; target?: unknown } | null;
    const target = applySettingsTargetSchema.parse(payload?.target ?? { mode: 'current' });
    const targetChats = resolvePreviewApplyTargetChats(state, chatId, target);
    return applySectionToAllResponseSchema.parse({
      section: payload?.section ?? 'links',
      sourceChatId: chatId,
      updatedChats: targetChats.length,
      appliedChatIds: targetChats.map((item) => item.id),
      targetMode: target.mode,
      favoriteTypes: target.favoriteTypes,
    });
  }

  if (tail[0] === 'settings' && tail[1] === 'apply-section-preview' && method === 'POST') {
    const payload = parseJsonBody(init) as { target?: unknown } | null;
    const target = applySettingsTargetSchema.parse(payload?.target ?? { mode: 'current' });
    const targetChats = resolvePreviewApplyTargetChats(state, chatId, target);
    return applySectionTargetPreviewResponseSchema.parse({
      sourceChatId: chatId,
      targetMode: target.mode,
      favoriteTypes: target.favoriteTypes,
      updatedChats: targetChats.length,
      appliedChatIds: targetChats.map((item) => item.id),
      sampleChats: targetChats.slice(0, 8),
    });
  }

  if (tail[0] === 'rules' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatRules);
    }

    if (method === 'PUT') {
      state.chatRules = chatRulesSchema.parse({
        ...state.chatRules,
        ...(parseJsonBody(init) as Record<string, unknown> | null),
      });
      return cloneJson(state.chatRules);
    }
  }

  if (tail[0] === 'rules' && tail[1] === 'publish') {
    if (method === 'POST') {
      const published = createPublishRulesResult(chatId, state.clock);
      state.chatRules = chatRulesSchema.parse({
        ...state.chatRules,
        publishedMessageId: published.messageId,
        publishedUrl: published.url,
        publishedAt: published.publishedAt,
      });
      return published;
    }

    if (method === 'DELETE') {
      state.chatRules = chatRulesSchema.parse({
        ...state.chatRules,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      });
      return cloneJson(state.chatRules);
    }
  }

  if (tail[0] === 'rules' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'profile' && tail[3] === 'handoff') {
    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcast' && tail[1] === 'handoff') {
    if (method === 'GET') {
      return buildBroadcastHandoffState(state.chatBroadcasts[0] ?? state.channelBroadcasts[0]);
    }

    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcast' && tail[1] === 'test' && method === 'POST') {
    return sendBroadcastTestResultSchema.parse({
      delivered: true,
      messageId: `preview-broadcast-test-${readPreviewClock(state.clock).getTime()}`,
      chatId: 'preview-private-chat',
      url: null,
    });
  }

  if (tail[0] === 'broadcasts' && tail.length === 1 && method === 'GET') {
    return cloneJson(state.chatBroadcasts.map(buildBroadcastSummary));
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail.length === 2) {
    const details = findBroadcast(state.chatBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedBroadcastDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        updatedAt: readPreviewClock(state.clock).toISOString(),
      });
      state.chatBroadcasts = state.chatBroadcasts.map((item) =>
        item.id === details.id ? updated : item,
      );
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      const canceled = managedBroadcastDetailsSchema.parse({
        ...details,
        status: 'CANCELED',
        cycleEnabled: false,
        canRetry: false,
        updatedAt: readPreviewClock(state.clock).toISOString(),
      });
      state.chatBroadcasts = state.chatBroadcasts.map((item) =>
        item.id === details.id ? canceled : item,
      );
      return cloneJson(canceled);
    }
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail[2] === 'retry' && method === 'POST') {
    const details = findBroadcast(state.chatBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    const retried = managedBroadcastDetailsSchema.parse({
      ...details,
      status: 'ACTIVE',
      failedChats: 0,
      pendingChats: 0,
      canRetry: false,
      lastError: null,
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.chatBroadcasts = state.chatBroadcasts.map((item) =>
      item.id === details.id ? retried : item,
    );
    return cloneJson(retried);
  }

  if (tail[0] === 'domain-allowlist' && tail[1] === 'details' && method === 'GET') {
    return cloneJson(state.chatDomains);
  }

  if (tail[0] === 'domain-allowlist' && tail.length === 1 && method === 'POST') {
    const payload = addDomainRequestSchema.parse(parseJsonBody(init));
    const inputKind =
      payload.kind ?? payload.matchType ?? inferAllowlistMatchType(payload.domain) ?? 'WEB_EXACT';
    const normalizedValue = normalizeStoredNavigationAllowlistEntry(payload.domain, inputKind);
    const normalizedEntry = normalizedValue ? parseStoredAllowlistEntry(normalizedValue) : null;
    if (!normalizedEntry) {
      throw new Error('Preview navigation target is invalid');
    }

    if (
      !state.chatDomains.some((item) => item.normalizedValue === normalizedEntry.normalizedValue)
    ) {
      state.chatDomains = [
        domainAllowlistEntrySchema.parse({
          ...normalizedEntry,
          removeAfterAt: null,
        }),
        ...state.chatDomains,
      ];
    }
    return null;
  }

  if (tail[0] === 'domain-allowlist' && tail.length === 1 && method === 'DELETE') {
    const domain = url.searchParams.get('domain')?.trim();
    if (!domain) {
      throw new Error('Preview domain is required');
    }
    state.chatDomains = state.chatDomains.filter((item) => item.normalizedValue !== domain);
    return null;
  }

  if (tail[0] === 'domain-allowlist' && tail[1] && tail.length === 2 && method === 'DELETE') {
    const domain = decodeURIComponent(tail[1]);
    state.chatDomains = state.chatDomains.filter((item) => item.normalizedValue !== domain);
    return null;
  }

  if (
    tail[0] === 'domain-allowlist' &&
    tail[1] === 'removal-schedule' &&
    tail.length === 2 &&
    method === 'PUT'
  ) {
    const domain = url.searchParams.get('domain')?.trim();
    if (!domain) {
      throw new Error('Preview domain is required');
    }
    const payload = parseJsonBody(init) as { removeAfterAt?: string | null } | null;
    state.chatDomains = state.chatDomains.map((item) =>
      item.normalizedValue === domain
        ? domainAllowlistEntrySchema.parse({
            ...item,
            removeAfterAt: payload?.removeAfterAt ?? null,
          })
        : item,
    );
    return null;
  }

  if (
    tail[0] === 'domain-allowlist' &&
    tail[1] &&
    tail[2] === 'removal-schedule' &&
    method === 'PUT'
  ) {
    const domain = decodeURIComponent(tail[1]);
    const payload = parseJsonBody(init) as { removeAfterAt?: string | null } | null;
    state.chatDomains = state.chatDomains.map((item) =>
      item.normalizedValue === domain
        ? domainAllowlistEntrySchema.parse({
            ...item,
            removeAfterAt: payload?.removeAfterAt ?? null,
          })
        : item,
    );
    return null;
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

export async function handleChannelRequest(
  state: PreviewState,
  channelId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
  pollEntityType: 'chat' | 'channel' = 'channel',
): Promise<unknown> {
  let managedPolls = pollEntityType === 'chat' ? state.chatPolls : state.channelPolls;
  const managedPollVoters =
    pollEntityType === 'chat' ? state.chatPollVoters : state.channelPollVoters;
  const updateManagedPolls = (polls: typeof managedPolls) => {
    managedPolls = polls;
    if (pollEntityType === 'chat') {
      state.chatPolls = polls;
    } else {
      state.channelPolls = polls;
    }
  };

  if (tail[0] === 'header' && method === 'GET') {
    const assignedBots = buildPreviewAssignedBots(
      {
        primaryBotId: state.channelPrimaryBotId,
        assistEnabled: state.channelPartnerAssistEnabled,
      },
      state.clock,
    );

    return managedEntityHeaderSchema.parse({
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      entityType: 'channel',
      link: 'https://max.ru/channels/yuzhnoe-news',
      participantsCount: state.channelHeaderParticipantsCount,
      avatarUrl: resolveChannelAvatarUrl(channelId, state),
      primaryBotId: state.channelPrimaryBotId,
      assignedBots,
      sharedMode: buildPreviewSharedMode(state.channelPartnerAssistEnabled),
      botCount: assignedBots.length,
      hasSharedAutomation: assignedBots.length > 1,
    });
  }

  if (tail[0] === 'settings-screen' && method === 'GET') {
    return cloneJson(buildChannelSettingsScreen(state, channelId));
  }

  if (tail[0] === 'post-signature' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelPostSignature);
    }

    if (method === 'PATCH') {
      const payload = updateChannelPostSignatureRequestSchema.parse(parseJsonBody(init));
      state.channelPostSignature = channelPostSignatureSettingsSchema.parse({
        ...state.channelPostSignature,
        ...payload,
      });
      state.channelVkParsing.settings.appendChannelLinkEnabled = state.channelPostSignature.enabled;
      state.channelVkParsing.settings.channelLinkText = state.channelPostSignature.text;
      return cloneJson(state.channelPostSignature);
    }
  }

  if (tail[0] === 'bots' && tail[1] === 'plan' && method === 'GET') {
    return cloneJson(buildPreviewBotExecutionPlan(state, 'channel', channelId));
  }

  if (tail[0] === 'bots' && tail[1] === 'primary' && method === 'POST') {
    const payload = updateManagedEntityPrimaryBotRequestSchema.parse(parseJsonBody(init));
    state.channelPrimaryBotId = payload.botId;
    return cloneJson(buildPreviewBotExecutionPlan(state, 'channel', channelId));
  }

  if (tail[0] === 'bots' && tail[1] === 'partner-assist' && method === 'POST') {
    const payload = updateManagedEntityPartnerAssistRequestSchema.parse(parseJsonBody(init));
    state.channelPartnerAssistEnabled =
      payload.enabled && payload.botId.trim() === PREVIEW_STANDBY_BOT_ID;
    return cloneJson(buildPreviewBotExecutionPlan(state, 'channel', channelId));
  }

  if (tail[0] === 'settings' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelSettings);
    }

    if (method === 'PUT') {
      state.channelSettings = channelSettingsSchema.parse(parseJsonBody(init));
      return cloneJson(state.channelSettings);
    }
  }

  if (tail[0] === 'broadcast' && tail[1] === 'handoff') {
    if (method === 'GET') {
      return buildBroadcastHandoffState(state.channelBroadcasts[0] ?? state.chatBroadcasts[0]);
    }

    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcast' && tail[1] === 'test' && method === 'POST') {
    return sendBroadcastTestResultSchema.parse({
      delivered: true,
      messageId: `preview-channel-broadcast-test-${readPreviewClock(state.clock).getTime()}`,
      chatId: 'preview-private-chat',
      url: null,
    });
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'profile' && tail[3] === 'handoff') {
    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
  }

  if (tail[0] === 'broadcasts' && tail.length === 1 && method === 'GET') {
    return cloneJson(state.channelBroadcasts.map(buildBroadcastSummary));
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail.length === 2) {
    const details = findBroadcast(state.channelBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedBroadcastDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        updatedAt: readPreviewClock(state.clock).toISOString(),
      });
      state.channelBroadcasts = state.channelBroadcasts.map((item) =>
        item.id === details.id ? updated : item,
      );
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      const canceled = managedBroadcastDetailsSchema.parse({
        ...details,
        status: 'CANCELED',
        cycleEnabled: false,
        canRetry: false,
        updatedAt: readPreviewClock(state.clock).toISOString(),
      });
      state.channelBroadcasts = state.channelBroadcasts.map((item) =>
        item.id === details.id ? canceled : item,
      );
      return cloneJson(canceled);
    }
  }

  if (tail[0] === 'broadcasts' && tail[1] && tail[2] === 'retry' && method === 'POST') {
    const details = findBroadcast(state.channelBroadcasts, tail[1]);
    if (!details) {
      throw new Error(`Preview broadcast not found: ${tail[1]}`);
    }

    const retried = managedBroadcastDetailsSchema.parse({
      ...details,
      status: 'ACTIVE',
      failedChats: 0,
      pendingChats: 0,
      canRetry: false,
      lastError: null,
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    state.channelBroadcasts = state.channelBroadcasts.map((item) =>
      item.id === details.id ? retried : item,
    );
    return cloneJson(retried);
  }

  if (tail[0] === 'engagement-publish' && method === 'POST') {
    return createPublishEngagementResult(channelId, state.clock);
  }

  if (tail[0] === 'polls' && tail.length === 1) {
    if (method === 'GET') {
      const query = managedPollListQuerySchema.parse({
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
      });
      const polls = [...managedPolls].sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime() ||
          right.id.localeCompare(left.id),
      );
      const cursorIndex = query.cursor ? polls.findIndex((poll) => poll.id === query.cursor) : -1;
      const page = polls.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
      const lastPoll = page.at(-1);
      const lastIndex = lastPoll ? polls.findIndex((poll) => poll.id === lastPoll.id) : -1;
      return cloneJson(
        managedPollListResponseSchema.parse({
          items: page,
          nextCursor: lastPoll && lastIndex < polls.length - 1 ? lastPoll.id : null,
        }),
      );
    }

    if (method === 'POST') {
      if (managedPolls.some((poll) => poll.status !== 'CLOSED')) {
        throw new Error('Сначала завершите текущий опрос.');
      }
      const payload = createManagedPollRequestSchema.parse(parseJsonBody(init));
      const nowIso = readPreviewClock(state.clock).toISOString();
      const pollId = `poll-preview-${readPreviewClock(state.clock).getTime()}`;
      const created = managedPollDetailsSchema.parse({
        id: pollId,
        channelId,
        question: payload.question,
        questionFormat: payload.questionFormat,
        images: payload.images,
        imageCount: payload.images.length,
        status: 'DRAFT',
        visibility: payload.visibility,
        totalVotes: 0,
        options: payload.options.map((option, index) => ({
          id: `${pollId}-option-${index + 1}`,
          position: index,
          text: option.text,
          votes: 0,
          percent: 0,
        })),
        publicationPending: false,
        publicationNeedsReview: false,
        renderRepairNeeded: false,
        publicationUrl: null,
        publicationMessageId: null,
        publishedAt: null,
        closedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastError: null,
        lastRenderError: null,
      });
      updateManagedPolls([created, ...managedPolls]);
      return cloneJson(created);
    }
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'voters' && method === 'GET') {
    const poll = managedPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (poll.visibility !== 'OPEN') {
      throw new Error('Анонимный опрос не раскрывает участников.');
    }

    const query = managedPollVotersQuerySchema.parse({
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    const items = managedPollVoters.filter((voter) => voter.pollId === poll.id);
    const cursorIndex = query.cursor ? items.findIndex((voter) => voter.id === query.cursor) : -1;
    const page = items.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
    const lastItem = page.at(-1);
    const lastIndex = lastItem ? items.findIndex((voter) => voter.id === lastItem.id) : -1;
    return managedPollVotersResponseSchema.parse({
      items: page,
      nextCursor: lastItem && lastIndex < items.length - 1 ? lastItem.id : null,
    });
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const poll = managedPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (poll.status !== 'DRAFT' || poll.publicationPending) {
      throw new Error('Опубликовать можно только свободный черновик.');
    }
    const published = managedPollDetailsSchema.parse({
      ...poll,
      status: 'ACTIVE',
      publicationPending: false,
      publicationNeedsReview: false,
      renderRepairNeeded: false,
      publicationUrl:
        pollEntityType === 'channel'
          ? 'https://max.ru/channels/yuzhnoe-news'
          : 'https://max.ru/chats/preview-chat',
      publicationMessageId: `poll-preview-message-${readPreviewClock(state.clock).getTime()}`,
      publishedAt: readPreviewClock(state.clock).toISOString(),
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    updateManagedPolls(managedPolls.map((item) => (item.id === published.id ? published : item)));
    return cloneJson(published);
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'close' && method === 'POST') {
    const poll = managedPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (poll.status === 'DRAFT') {
      throw new Error('Черновик ещё не опубликован.');
    }
    const closed = managedPollDetailsSchema.parse({
      ...poll,
      status: 'CLOSED',
      renderRepairNeeded: false,
      lastRenderError: null,
      closedAt: readPreviewClock(state.clock).toISOString(),
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    updateManagedPolls(managedPolls.map((item) => (item.id === closed.id ? closed : item)));
    return cloneJson(closed);
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'refresh' && method === 'POST') {
    const poll = managedPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (poll.status === 'DRAFT') {
      throw new Error('Черновик ещё не опубликован.');
    }
    const refreshed = managedPollDetailsSchema.parse({
      ...poll,
      renderRepairNeeded: false,
      lastRenderError: null,
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    updateManagedPolls(managedPolls.map((item) => (item.id === refreshed.id ? refreshed : item)));
    return cloneJson(refreshed);
  }

  if (tail[0] === 'polls' && tail[1] && tail[2] === 'reset-publication' && method === 'POST') {
    const poll = managedPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }
    if (!poll.publicationNeedsReview) {
      throw new Error('Публикация не требует сброса.');
    }
    const reset = managedPollDetailsSchema.parse({
      ...poll,
      publicationPending: false,
      publicationNeedsReview: false,
      lastError: null,
      updatedAt: readPreviewClock(state.clock).toISOString(),
    });
    updateManagedPolls(managedPolls.map((item) => (item.id === reset.id ? reset : item)));
    return cloneJson(reset);
  }

  if (tail[0] === 'polls' && tail[1] && tail.length === 2) {
    const poll = managedPolls.find((item) => item.id === tail[1]);
    if (!poll) {
      throw new Error(`Preview poll not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(poll);
    }

    if (method === 'PUT') {
      if (poll.status !== 'DRAFT' || poll.publicationPending) {
        throw new Error('Опубликованный опрос нельзя изменить.');
      }
      const payload = updateManagedPollRequestSchema.parse(parseJsonBody(init));
      const questionFormat = payload.questionFormat ?? poll.questionFormat;
      const images = payload.images ?? poll.images;
      const optionIds = new Set(poll.options.map((option) => option.id));
      if (payload.options.some((option) => option.id && !optionIds.has(option.id))) {
        throw new Error('Вариант ответа больше не существует.');
      }
      const updated = managedPollDetailsSchema.parse({
        ...poll,
        question: payload.question,
        questionFormat,
        images,
        imageCount: images.length,
        visibility: payload.visibility,
        options: payload.options.map((option, index) => ({
          id: option.id ?? `${poll.id}-option-${index + 1}`,
          position: index,
          text: option.text,
          votes: 0,
          percent: 0,
        })),
        totalVotes: 0,
        updatedAt: readPreviewClock(state.clock).toISOString(),
      });
      updateManagedPolls(managedPolls.map((item) => (item.id === updated.id ? updated : item)));
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      if (poll.status !== 'DRAFT') {
        throw new Error('Удалить можно только черновик.');
      }
      updateManagedPolls(managedPolls.filter((item) => item.id !== poll.id));
      return null;
    }
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

export const handleSettingsPreviewRequest: PreviewRequestHandler = (context) => {
  const entity = resolvePreviewEntityRequest(context);
  if (!entity) {
    return PREVIEW_NOT_HANDLED;
  }
  if (entity.entityType === 'chat' && entity.tail[0] === 'polls') {
    return handleChannelRequest(
      context.state,
      entity.entityId,
      entity.tail,
      context.url,
      context.method,
      context.init,
      'chat',
    );
  }
  return entity.entityType === 'chat'
    ? handleChatRequest(
        context.state,
        entity.entityId,
        entity.tail,
        context.url,
        context.method,
        context.init,
      )
    : handleChannelRequest(
        context.state,
        entity.entityId,
        entity.tail,
        context.url,
        context.method,
        context.init,
      );
};
