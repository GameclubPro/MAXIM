import {
  applySectionToAllResponseSchema,
  broadcastHandoffStateSchema,
  channelDialogMessageSchema,
  channelDialogResponseSchema,
  channelDialogTypeSchema,
  channelSettingsSchema,
  channelSettingsScreenResponseSchema,
  channelStatsResponseSchema,
  chatRulesSchema,
  chatSettingsSchema,
  chatSettingsScreenResponseSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  domainAllowlistEntrySchema,
  logsDashboardResponseSchema,
  managedBroadcastDetailsSchema,
  managedGiveawayDetailsSchema,
  managedPollSchema,
  manualModerationActionResultSchema,
  membershipActivityPageSchema,
  publishChannelEngagementResultSchema,
  publishChatRulesResultSchema,
  type BroadcastHandoffResponse,
  type BroadcastHandoffState,
  type ChannelDialogMessage,
  type ChannelDialogResponse,
  type ChannelDialogType,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
  type ChannelStatsRange,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type ChatSummary,
  type DomainAllowlistEntry,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManagedBroadcastDetails,
  type ManagedGiveawayDetails,
  type ManagedGiveawaySummary,
  type ManagedPoll,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
  type Me,
  type MembershipActivityFilter,
  type MembershipActivityItem,
  type MembershipActivityPage,
  type MembershipActivityRange,
  type PublishChannelEngagementResult,
  type PublishChatRulesResult,
} from '@maxim/contracts';
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHANNEL_TITLE,
  PREVIEW_CHAT_ID,
  PREVIEW_CHAT_TITLE,
} from '../design-preview';
import type { ApiTransport } from './transport';

type PreviewState = {
  me: Me;
  chats: ChatSummary[];
  channels: ChatSummary[];
  chatDialogs: Record<ChannelDialogType, PreviewDialogBucket>;
  channelDialogs: Record<ChannelDialogType, PreviewDialogBucket>;
  chatHeaderParticipantsCount: number;
  chatSettings: ChatSettings;
  chatRules: ChatRules;
  chatDomains: DomainAllowlistEntry[];
  chatPoll: ManagedPoll;
  chatBroadcasts: ManagedBroadcastDetails[];
  channelBroadcasts: ManagedBroadcastDetails[];
  chatGiveaways: ManagedGiveawayDetails[];
  chatActivity: MembershipActivityItem[];
  chatViolations: LogsDashboardResponse['violations'];
  channelHeaderParticipantsCount: number;
  channelSettings: ChannelSettings;
  channelPoll: ManagedPoll;
  channelGiveaways: ManagedGiveawayDetails[];
  channelActivity: MembershipActivityItem[];
};

type PreviewDialogBucket = {
  introText: string;
  messages: ChannelDialogMessage[];
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 60 * 60 * 1_000);
}

function addDays(value: Date, days: number): Date {
  return addHours(value, days * 24);
}

function resolveRangeWindow(range: MembershipActivityRange, now: Date) {
  const to = new Date(now);
  const from = new Date(now);

  if (range === '24h') {
    from.setHours(from.getHours() - 24);
  } else if (range === '7d') {
    from.setDate(from.getDate() - 7);
  } else {
    from.setDate(from.getDate() - 30);
  }

  return { from, to };
}

function isWithinRange(createdAt: string, range: MembershipActivityRange, now: Date): boolean {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const { from, to } = resolveRangeWindow(range, now);
  return timestamp >= from.getTime() && timestamp <= to.getTime();
}

function filterActivityItems(
  items: MembershipActivityItem[],
  range: MembershipActivityRange,
  filter: MembershipActivityFilter,
  now: Date,
): MembershipActivityItem[] {
  return items.filter((item) => {
    if (!isWithinRange(item.createdAt, range, now)) {
      return false;
    }

    if (filter !== 'all' && item.type !== filter) {
      return false;
    }

    return true;
  });
}

function buildActivityPage(
  items: MembershipActivityItem[],
  {
    range,
    filter = 'all',
    limit = 50,
    cursor,
  }: {
    range: MembershipActivityRange;
    filter?: MembershipActivityFilter;
    limit?: number;
    cursor?: string | null;
  },
  now: Date,
): MembershipActivityPage {
  const filtered = filterActivityItems(items, range, filter, now);
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const pageItems = filtered.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageItems.length;

  return membershipActivityPageSchema.parse({
    items: pageItems,
    hasMore: nextOffset < filtered.length,
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
  });
}

function buildBroadcastSummary(details: ManagedBroadcastDetails) {
  return {
    id: details.id,
    status: details.status,
    textPreview: details.text.trim().slice(0, 120) || 'Пустая рассылка',
    textLength: details.text.length,
    applyToAllChats: details.applyToAllChats,
    targetChats: details.targetChatIds.length || 1,
    hasImage: details.imageEnabled,
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
    canRetry: details.canRetry,
    remainingCount: details.remainingCount,
    createdAt: details.createdAt,
    updatedAt: details.updatedAt,
    lastError: details.lastError,
  };
}

function buildBroadcastHandoffState(details: ManagedBroadcastDetails): BroadcastHandoffState {
  return broadcastHandoffStateSchema.parse({
    applyToAllChats: details.applyToAllChats,
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
    hasContent: Boolean(details.text.trim() || details.imageEnabled),
  });
}

function buildGiveawaySummary(details: ManagedGiveawayDetails): ManagedGiveawaySummary {
  return {
    id: details.id,
    title: details.title,
    status: details.status,
    hasImage: details.hasImage,
    entriesCount: details.entriesCount,
    verifiedEntriesCount: details.verifiedEntriesCount,
    pendingEntriesCount: details.pendingEntriesCount,
    winnersCount: details.winnersCount,
    startsAt: details.startsAt,
    endsAt: details.endsAt,
    publishedAt: details.publishedAt,
    completedAt: details.completedAt,
    publicationUrl: details.publicationUrl,
    resultsUrl: details.resultsUrl,
    createdAt: details.createdAt,
    updatedAt: details.updatedAt,
  };
}

function resolveChatTitle(chatId: string, state: PreviewState): string {
  return state.chats.find((item) => item.id === chatId)?.title ?? PREVIEW_CHAT_TITLE;
}

function resolveChannelTitle(channelId: string, state: PreviewState): string {
  return state.channels.find((item) => item.id === channelId)?.title ?? PREVIEW_CHANNEL_TITLE;
}

function buildPreviewDialogMessage(payload: {
  id: string;
  type: ChannelDialogType;
  text: string;
  authorUserId: string;
  authorDisplayName: string | null;
  createdAt: string;
  delivered?: boolean;
  deliveredToUserId?: string | null;
}): ChannelDialogMessage {
  return channelDialogMessageSchema.parse({
    id: payload.id,
    type: payload.type,
    text: payload.text,
    authorUserId: payload.authorUserId,
    authorDisplayName: payload.authorDisplayName,
    createdAt: payload.createdAt,
    ...(payload.delivered !== undefined ? { delivered: payload.delivered } : {}),
    ...(payload.deliveredToUserId !== undefined
      ? { deliveredToUserId: payload.deliveredToUserId }
      : {}),
  });
}

function buildPreviewDialogResponse(
  chatId: string,
  dialogType: ChannelDialogType,
  bucket: PreviewDialogBucket,
): ChannelDialogResponse {
  return channelDialogResponseSchema.parse({
    chatId,
    type: dialogType,
    introText: bucket.introText,
    messages: bucket.messages,
  });
}

function createActivityItems(
  prefix: string,
  names: string[],
  now: Date,
  offsetsHours: number[],
): MembershipActivityItem[] {
  return offsetsHours
    .map((offsetHours, index) => ({
      id: `${prefix}-${index + 1}`,
      type: (index % 3 === 1 ? 'left' : 'joined') as MembershipActivityItem['type'],
      userId: `${prefix}-user-${index + 1}`,
      userDisplayName: names[index % names.length] ?? `Участник ${index + 1}`,
      createdAt: addHours(now, -offsetHours).toISOString(),
    }))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function createChatViolations(now: Date): LogsDashboardResponse['violations'] {
  const base = [
    {
      id: 'violation-1',
      action: 'BAN' as const,
      ruleCode: 'COMMERCIAL_AD',
      userId: 'preview-spammer-1',
      userDisplayName: 'Сергей Маркет',
      createdAt: addHours(now, -1.5).toISOString(),
      maskedExcerpt: 'Переходите по ссылке и получайте скидку ***',
      metadata: { banDurationHours: 24, unbanScheduledAt: addHours(now, 22.5).toISOString() },
    },
    {
      id: 'violation-2',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'LINK_BLOCKED',
      userId: 'preview-spammer-2',
      userDisplayName: 'Мария Ссылкина',
      createdAt: addHours(now, -3.2).toISOString(),
      maskedExcerpt: 'Подписывайтесь на мой канал ***',
      metadata: null,
    },
    {
      id: 'violation-3',
      action: 'WARN' as const,
      ruleCode: 'PROFANITY',
      userId: 'preview-user-3',
      userDisplayName: 'Антон',
      createdAt: addHours(now, -6.8).toISOString(),
      maskedExcerpt: 'Это было очень ***',
      metadata: null,
    },
    {
      id: 'violation-4',
      action: 'KICK' as const,
      ruleCode: 'GLOBAL_CROSS_CHAT_SPAM',
      userId: 'preview-user-4',
      userDisplayName: 'Инфо Буст',
      createdAt: addHours(now, -14.1).toISOString(),
      maskedExcerpt: 'Повторный оффер с внешней ссылкой ***',
      metadata: null,
    },
    {
      id: 'violation-5',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'MESSAGE_TOO_LONG',
      userId: 'preview-user-5',
      userDisplayName: 'Юлия',
      createdAt: addHours(now, -27).toISOString(),
      maskedExcerpt: 'Очень длинное сообщение ***',
      metadata: null,
    },
    {
      id: 'violation-6',
      action: 'BAN' as const,
      ruleCode: 'DUPLICATE_BAN',
      userId: 'preview-user-6',
      userDisplayName: 'Олег Повтор',
      createdAt: addHours(now, -42).toISOString(),
      maskedExcerpt: 'Одинаковый текст ***',
      metadata: { banDurationHours: 12, unbanScheduledAt: addHours(now, -30).toISOString() },
    },
    {
      id: 'violation-7',
      action: 'DELETE_MESSAGE' as const,
      ruleCode: 'NIGHT_MODE_DELETE',
      userId: 'preview-user-7',
      userDisplayName: 'Ночной гость',
      createdAt: addHours(now, -73).toISOString(),
      maskedExcerpt: 'Сообщение ночью ***',
      metadata: null,
    },
    {
      id: 'violation-8',
      action: 'WARN' as const,
      ruleCode: 'THEMATIC_FILTER',
      userId: 'preview-user-8',
      userDisplayName: 'Павел',
      createdAt: addHours(now, -110).toISOString(),
      maskedExcerpt: 'Не по теме ***',
      metadata: null,
    },
    {
      id: 'violation-9',
      action: 'NONE' as const,
      ruleCode: 'MANUAL_UNBAN',
      userId: 'preview-user-9',
      userDisplayName: 'Ольга',
      createdAt: addHours(now, -180).toISOString(),
      maskedExcerpt: null,
      metadata: null,
    },
    {
      id: 'violation-10',
      action: 'KICK' as const,
      ruleCode: 'MANUAL_KICK',
      userId: 'preview-user-10',
      userDisplayName: 'Андрей',
      createdAt: addHours(now, -220).toISOString(),
      maskedExcerpt: null,
      metadata: null,
    },
  ];

  return base.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function createInitialState(): PreviewState {
  const now = new Date();
  const chatSettings = chatSettingsSchema.parse({
    greetingEnabled: true,
    greetingBotMessageEnabled: true,
    greetingBotMessageText: 'Добро пожаловать в чат. Ознакомьтесь с правилами и пишите по делу.',
    linkPolicy: 'ALLOWLIST_ONLY',
    antiSpamEnabled: true,
    deleteSpammersEnabled: true,
    russianProfanityFilterEnabled: true,
    commercialAdsFilterEnabled: true,
    commercialAdsSensitivity: 'BALANCED',
    profanityWarnEnabled: true,
    textFiltersWarnEnabled: true,
    duplicateWarnEnabled: true,
    duplicateKickEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    nightModeEnabled: true,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: 'Ночью чат закрыт. Напишите утром.',
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: [PREVIEW_CHANNEL_ID, 'preview-channel-2'],
    requiredSubscriptionBotMessageEnabled: true,
    requiredSubscriptionBotMessageText:
      'Для сообщений в этом чате нужна подписка на {channels}. Подпишитесь и отправьте сообщение ещё раз. Статус: {message_status}.',
    requiredSubscriptionWarnEnabled: true,
    requiredSubscriptionBanEnabled: true,
    requiredSubscriptionKickEnabled: true,
    commentsEnabled: true,
    commentsAdminsEnabled: true,
    commentsAllEnabled: false,
    commentsChatBroadcastsEnabled: true,
    banDurationHours: 12,
    warnThreshold: 2,
  });
  const chatRules = chatRulesSchema.parse({
    text: '1. Без рекламы.\n2. Без токсичности.\n3. Без повторов.\n4. Уважайте соседей.',
    autoTextEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    publishedMessageId: 'rules-preview-1',
    publishedUrl: 'https://max.ru/community/rules-preview',
    publishedAt: addHours(now, -26).toISOString(),
  });
  const chatDomains = [
    domainAllowlistEntrySchema.parse({
      domain: 'https://maxim.play-team.ru',
      removeAfterAt: null,
    }),
    domainAllowlistEntrySchema.parse({
      domain: 'https://docs.max.ru',
      removeAfterAt: addDays(now, 2).toISOString(),
    }),
  ];
  const chatPoll = managedPollSchema.parse({
    question: 'Нужен ли тихий режим после 22:00?',
    options: ['Да', 'Нет', 'Тест на неделю'],
    status: 'ACTIVE',
    activeVersion: 2,
    publishedMessageId: 'poll-preview-1',
    publishedUrl: 'https://max.ru/poll/preview-1',
    publishedAt: addHours(now, -8).toISOString(),
    closedAt: null,
    totalVotes: 94,
    optionResults: [
      { option: 'Да', votes: 52, percent: 55 },
      { option: 'Нет', votes: 21, percent: 22 },
      { option: 'Тест на неделю', votes: 21, percent: 22 },
    ],
  });
  const chatBroadcasts = [
    managedBroadcastDetailsSchema.parse({
      id: 'broadcast-preview-1',
      status: 'ACTIVE',
      text: 'Напоминаем: в субботу уборка двора в 11:00. Приходите с перчатками.',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: [PREVIEW_CHAT_ID],
      buttonEnabled: true,
      buttonUrl: 'https://maxim.play-team.ru/help',
      buttonText: 'Подробности',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        addHours(now, 18).toISOString(),
        addDays(now, 1).toISOString(),
        addDays(now, 2).toISOString(),
      ],
      nextSendAt: addHours(now, 18).toISOString(),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 3,
      sentCount: 1,
      currentOccurrence: 2,
      deliveredChats: 1,
      failedChats: 0,
      pendingChats: 0,
      canRetry: false,
      remainingCount: 2,
      createdAt: addHours(now, -36).toISOString(),
      updatedAt: addHours(now, -3).toISOString(),
      lastError: null,
    }),
  ];
  const chatGiveaways = [
    managedGiveawayDetailsSchema.parse({
      id: 'giveaway-chat-1',
      title: 'Субботний розыгрыш',
      status: 'ACTIVE',
      hasImage: false,
      entriesCount: 142,
      verifiedEntriesCount: 129,
      pendingEntriesCount: 13,
      winnersCount: 2,
      startsAt: addHours(now, -18).toISOString(),
      endsAt: addHours(now, 30).toISOString(),
      publishedAt: addHours(now, -17.5).toISOString(),
      completedAt: null,
      publicationUrl: 'https://max.ru/giveaway/chat-preview',
      resultsUrl: null,
      createdAt: addDays(now, -4).toISOString(),
      updatedAt: addHours(now, -2).toISOString(),
      sourceChatId: PREVIEW_CHAT_ID,
      entityType: 'chat',
      description: 'Среди активных участников разыгрываем набор садовых перчаток.',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      claimHours: 48,
      requiredChannelIds: [PREVIEW_CHANNEL_ID],
      publicationMessageId: 'giveaway-msg-1',
      resultsMessageId: null,
      prizes: [
        { id: 'prize-chat-1', position: 1, title: 'Набор перчаток' },
        { id: 'prize-chat-2', position: 2, title: 'Секатор' },
      ],
      winners: [],
    }),
  ];
  const channelSettings = channelSettingsSchema.parse({
    commentsEnabled: true,
    commentsModerationEnabled: true,
    commentsBlockLinksEnabled: true,
    commentsAntiSpamEnabled: true,
    commentsLimitTwoInRowEnabled: true,
    postSuggestionsEnabled: true,
    postSuggestionsText: 'Пришлите идею поста или важную новость для соседей.',
    postSuggestionsButtonEnabled: true,
    postSuggestionsButtonText: 'Предложить пост',
    postSuggestionsButtonUrl: 'https://maxim.play-team.ru/suggest',
    engagementMessageText: 'Есть идея или обратная связь? Выберите действие ниже.',
    autoPostButtonsMode: 'BOTH',
  });
  const channelPoll = managedPollSchema.parse({
    question: 'Какой формат постов удобнее?',
    options: ['Короткие', 'Подробные', 'Микс'],
    status: 'DRAFT',
    activeVersion: 1,
    publishedMessageId: null,
    publishedUrl: null,
    publishedAt: null,
    closedAt: null,
    totalVotes: 0,
    optionResults: [],
  });
  const channelGiveaways = [
    managedGiveawayDetailsSchema.parse({
      id: 'giveaway-channel-1',
      title: 'Розыгрыш мерча',
      status: 'SCHEDULED',
      hasImage: false,
      entriesCount: 0,
      verifiedEntriesCount: 0,
      pendingEntriesCount: 0,
      winnersCount: 1,
      startsAt: addHours(now, 12).toISOString(),
      endsAt: addDays(now, 4).toISOString(),
      publishedAt: null,
      completedAt: null,
      publicationUrl: null,
      resultsUrl: null,
      createdAt: addDays(now, -2).toISOString(),
      updatedAt: addHours(now, -4).toISOString(),
      sourceChatId: PREVIEW_CHANNEL_ID,
      entityType: 'channel',
      description: 'Тестовый розыгрыш среди подписчиков канала.',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      claimHours: 24,
      requiredChannelIds: [PREVIEW_CHANNEL_ID],
      publicationMessageId: null,
      resultsMessageId: null,
      prizes: [{ id: 'prize-channel-1', position: 1, title: 'Фирменная кружка' }],
      winners: [],
    }),
  ];
  const channelBroadcasts = [
    managedBroadcastDetailsSchema.parse({
      id: 'broadcast-channel-1',
      status: 'ACTIVE',
      text: 'Сегодня публикуем подборку событий района. Проверьте расписание и переходите в канал.',
      textFormat: 'markdown',
      applyToAllChats: false,
      targetChatIds: [PREVIEW_CHANNEL_ID],
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/channels/yuzhnoe-news',
      buttonText: 'Открыть канал',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        addHours(now, 10).toISOString(),
        addHours(now, 14).toISOString(),
        addHours(now, 19).toISOString(),
        addDays(now, 1).toISOString(),
      ],
      nextSendAt: addHours(now, 10).toISOString(),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 4,
      sentCount: 0,
      currentOccurrence: 1,
      deliveredChats: 0,
      failedChats: 0,
      pendingChats: 1,
      canRetry: false,
      remainingCount: 4,
      createdAt: addHours(now, -20).toISOString(),
      updatedAt: addHours(now, -1).toISOString(),
      lastError: null,
    }),
  ];
  const chatDialogs: Record<ChannelDialogType, PreviewDialogBucket> = {
    comments: {
      introText:
        'Тихий тред к сообщению админа: короткие ответы, без флуда, ссылки режет модерация.',
      messages: [
        buildPreviewDialogMessage({
          id: 'chat-comments-1',
          type: 'comments',
          text: 'Сделал компактную парковку для самокатов у 3-го подъезда. Проверьте, не мешает ли проходу.',
          authorUserId: 'preview-admin-2',
          authorDisplayName: 'Александр',
          createdAt: addHours(now, -5.2).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-2',
          type: 'comments',
          text: 'Смотрится аккуратно. Если добавить отражатель со стороны дорожки, вечером будет безопаснее.',
          authorUserId: 'preview-user-8',
          authorDisplayName: 'Марина Орлова',
          createdAt: addHours(now, -4.8).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-3',
          type: 'comments',
          text: 'Поддерживаю. Утром с коляской стало свободнее, раньше самокаты лежали прямо у перил.',
          authorUserId: 'preview-user-4',
          authorDisplayName: 'Наталья',
          createdAt: addHours(now, -4.5).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-4',
          type: 'comments',
          text: 'Добавлю светоотражающую ленту и перенесу стойку на полметра ближе к клумбе.',
          authorUserId: 'preview-admin-2',
          authorDisplayName: 'Александр',
          createdAt: addHours(now, -4.1).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-5',
          type: 'comments',
          text: 'Отлично. Тогда оставим тестом на неделю и посмотрим, как поведёт себя поток вечером.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          createdAt: addHours(now, -3.9).toISOString(),
        }),
      ],
    },
    suggest: {
      introText: 'Идеи для постов приходят тихо: участник пишет, админы получают сообщение в очередь.',
      messages: [
        buildPreviewDialogMessage({
          id: 'chat-suggest-1',
          type: 'suggest',
          text: 'Можно сделать короткий пост про новые контейнеры для батареек у офиса управляющей компании.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          createdAt: addHours(now, -7.2).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
        }),
      ],
    },
  };
  const channelDialogs: Record<ChannelDialogType, PreviewDialogBucket> = {
    comments: {
      introText:
        'Комментарии к посту канала идут отдельным потоком, чтобы лента канала оставалась чистой.',
      messages: [
        buildPreviewDialogMessage({
          id: 'channel-comments-1',
          type: 'comments',
          text: 'Спасибо за карту отключений. Наконец-то видно точный интервал по улице Сиреневой.',
          authorUserId: 'preview-user-11',
          authorDisplayName: 'Татьяна',
          createdAt: addHours(now, -10.5).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'channel-comments-2',
          type: 'comments',
          text: 'Если добавите следующий апдейт про развоз воды, закрепите его в начале треда.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          createdAt: addHours(now, -9.8).toISOString(),
        }),
      ],
    },
    suggest: {
      introText: 'Предложение поста сразу уходит редактору канала и не шумит в основном чате.',
      messages: [
        buildPreviewDialogMessage({
          id: 'channel-suggest-1',
          type: 'suggest',
          text: 'Подборка ярмарок выходного дня отлично зайдёт на воскресенье утром.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          createdAt: addHours(now, -6.4).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
        }),
      ],
    },
  };

  return {
    me: {
      userId: 'preview-admin',
      username: 'designer',
      displayName: 'Алексей',
    },
    chats: [
      {
        id: PREVIEW_CHAT_ID,
        title: PREVIEW_CHAT_TITLE,
        createdAt: addDays(now, -280).toISOString(),
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
      {
        id: 'preview-chat-2',
        title: 'Клуб соседей',
        createdAt: addDays(now, -120).toISOString(),
        entityType: 'chat',
        link: null,
        channelOverview: null,
      },
    ],
    channels: [
      {
        id: PREVIEW_CHANNEL_ID,
        title: PREVIEW_CHANNEL_TITLE,
        createdAt: addDays(now, -250).toISOString(),
        entityType: 'channel',
        link: 'https://max.ru/channels/yuzhnoe-news',
        channelOverview: {
          enabledScenariosCount: 2,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
        },
      },
      {
        id: 'preview-channel-2',
        title: 'Афиша района',
        createdAt: addDays(now, -90).toISOString(),
        entityType: 'channel',
        link: 'https://max.ru/channels/afisha',
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ],
    chatHeaderParticipantsCount: 1_584,
    chatDialogs,
    chatSettings,
    chatRules,
    chatDomains,
    chatPoll,
    chatBroadcasts,
    chatGiveaways,
    chatActivity: createActivityItems(
      'chat-activity',
      ['Ольга Бойко', 'Юлия', 'Андрей Фёдоров', 'Марина', 'Александр', 'Наталья'],
      now,
      [
        0.3, 1.2, 2.8, 4.1, 6.7, 8.9, 10.5, 12.4, 14.3, 18.8, 23.5, 26.2, 31.7, 36.1, 44.2, 55.6,
        63.4, 78.5, 92.1, 110.4, 136.2, 158.7, 175.9, 212.8, 250.3, 310.1, 420.6, 560.8,
      ],
    ),
    chatViolations: createChatViolations(now),
    channelHeaderParticipantsCount: 9_240,
    channelDialogs,
    channelSettings,
    channelPoll,
    channelBroadcasts,
    channelGiveaways,
    channelActivity: createActivityItems(
      'channel-activity',
      ['Владимир', 'Татьяна', 'Ирина', 'Дмитрий', 'Елена', 'Максим'],
      addHours(now, -1),
      [
        0.6, 1.4, 2.2, 3.8, 5.6, 7.3, 9.1, 11.8, 13.4, 17.7, 21.2, 26.5, 33.9, 40.2, 47.8, 58.1,
        70.3, 88.4, 112.6, 138.8, 166.2, 199.1, 240.5, 296.2, 352.7, 490.4,
      ],
    ),
  };
}

function buildChatSettingsScreen(state: PreviewState, chatId: string): ChatSettingsScreenResponse {
  return chatSettingsScreenResponseSchema.parse({
    settings: state.chatSettings,
    rules: state.chatRules,
    header: {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      entityType: 'chat',
      link: null,
      participantsCount: state.chatHeaderParticipantsCount,
    },
    domains: state.chatDomains,
    managedBroadcasts: state.chatBroadcasts.map(buildBroadcastSummary),
  });
}

function buildChannelSettingsScreen(
  state: PreviewState,
  channelId: string,
): ChannelSettingsScreenResponse {
  return channelSettingsScreenResponseSchema.parse({
    settings: state.channelSettings,
    header: {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      entityType: 'channel',
      link: 'https://max.ru/channels/yuzhnoe-news',
      participantsCount: state.channelHeaderParticipantsCount,
    },
    managedBroadcasts: state.channelBroadcasts.map(buildBroadcastSummary),
  });
}

function buildLogsDashboard(
  state: PreviewState,
  chatId: string,
  range: LogsDashboardRange,
): LogsDashboardResponse {
  const now = new Date();
  const violations = state.chatViolations.filter((item) =>
    isWithinRange(item.createdAt, range, now),
  );
  const membershipItems = filterActivityItems(state.chatActivity, range, 'all', now);
  const joinedUsers = membershipItems.filter((item) => item.type === 'joined').length;
  const leftUsers = membershipItems.filter((item) => item.type === 'left').length;
  const summary = violations.reduce(
    (accumulator, item) => {
      if (item.ruleCode === 'MANUAL_UNBAN') {
        accumulator.unban += 1;
      } else if (item.action === 'WARN') {
        accumulator.warn += 1;
      } else if (item.action === 'DELETE_MESSAGE') {
        accumulator.deleteMessage += 1;
      } else if (item.action === 'KICK') {
        accumulator.kick += 1;
      } else if (item.action === 'BAN') {
        accumulator.ban += 1;
      }

      accumulator.users.add(item.userId);
      return accumulator;
    },
    {
      warn: 0,
      deleteMessage: 0,
      kick: 0,
      ban: 0,
      unban: 0,
      users: new Set<string>(),
    },
  );
  const { from, to } = resolveRangeWindow(range, now);

  return logsDashboardResponseSchema.parse({
    chat: {
      id: chatId,
      title: resolveChatTitle(chatId, state),
    },
    period: {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    membership: {
      joinedUsers,
      leftUsers,
      netUsers: joinedUsers - leftUsers,
    },
    violationsSummary: {
      warn: summary.warn,
      deleteMessage: summary.deleteMessage,
      kick: summary.kick,
      ban: summary.ban,
      unban: summary.unban,
      affectedUsers: summary.users.size,
      total: violations.length,
    },
    violations,
    activityFeed: buildActivityPage(state.chatActivity, { range, limit: 50 }, now),
  });
}

function buildChannelStats(state: PreviewState, channelId: string, range: ChannelStatsRange) {
  const now = new Date();
  const activityItems = filterActivityItems(state.channelActivity, range, 'all', now);
  const joined = activityItems.filter((item) => item.type === 'joined').length;
  const left = activityItems.filter((item) => item.type === 'left').length;
  const { from, to } = resolveRangeWindow(range, now);
  const points = range === '24h' ? 12 : range === '7d' ? 8 : 10;
  const stepMs = Math.max(1, (to.getTime() - from.getTime()) / Math.max(1, points - 1));

  function distributeTotal(total: number, weights: number[]): number[] {
    if (total <= 0) {
      return Array.from({ length: weights.length }, () => 0);
    }

    const safeWeights = weights.map((weight) => Math.max(0, weight));
    const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
    if (totalWeight <= 0) {
      const fallback = Array.from({ length: weights.length }, () => 0);
      for (let index = 0; index < total; index += 1) {
        fallback[index % fallback.length] += 1;
      }
      return fallback;
    }

    const raw = safeWeights.map((weight) => (weight / totalWeight) * total);
    const distributed = raw.map((value) => Math.floor(value));
    let remainder = total - distributed.reduce((sum, value) => sum + value, 0);
    const fractions = raw
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((leftItem, rightItem) => rightItem.fraction - leftItem.fraction);

    for (let index = 0; index < fractions.length && remainder > 0; index += 1) {
      distributed[fractions[index]!.index] += 1;
      remainder -= 1;
    }

    return distributed;
  }

  const joinedWeights = Array.from({ length: points }, (_, index) => {
    const progress = points > 1 ? index / (points - 1) : 0;
    return 1 + progress * (range === '24h' ? 0.45 : 0.9);
  });
  const leftWeights = Array.from({ length: points }, (_, index) => {
    if (index % 4 === 0) {
      return range === '24h' ? 0.2 : 0.25;
    }

    const progress = points > 1 ? index / (points - 1) : 0;
    return 0.75 + (1 - progress) * 0.45;
  });
  const joinedDistribution = distributeTotal(joined, joinedWeights);
  const leftDistribution = distributeTotal(left, leftWeights);
  const baseParticipants =
    state.channelHeaderParticipantsCount -
    joinedDistribution.reduce((sum, value) => sum + value, 0) +
    leftDistribution.reduce((sum, value) => sum + value, 0);

  let runningParticipants = baseParticipants;
  const membershipSeries = Array.from({ length: points }, (_, index) => {
    const at = new Date(from.getTime() + stepMs * index);
    const joinedValue = joinedDistribution[index] ?? 0;
    const leftValue = leftDistribution[index] ?? 0;
    return {
      at: at.toISOString(),
      joined: joinedValue,
      left: leftValue,
    };
  });
  const participantsSeries = membershipSeries.map((item) => {
    runningParticipants = Math.max(0, runningParticipants + item.joined - item.left);
    return {
      at: item.at,
      participantsCount: runningParticipants,
    };
  });
  const viewsSeries = Array.from({ length: points }, (_, index) => {
    const at = new Date(from.getTime() + stepMs * index);
    return {
      at: at.toISOString(),
      views: Math.round(3_200 + index * 540 + (range === '30d' ? 1_800 : 0)),
    };
  });
  const posts = range === '24h' ? 3 : range === '7d' ? 14 : 42;
  const views = viewsSeries.reduce((sum, item) => sum + item.views, 0);
  const reactions = Math.round(views * 0.06);

  return channelStatsResponseSchema.parse({
    channel: {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      participantsCount: state.channelHeaderParticipantsCount,
      status: 'Публичный канал',
      isPublic: true,
      link: 'https://max.ru/channels/yuzhnoe-news',
      lastEventAt: state.channelActivity[0]?.createdAt ?? null,
    },
    period: {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: range === '24h' ? 'hour' : 'day',
    },
    official: {
      audience: {
        joined,
        left,
        net: joined - left,
      },
      content: {
        posts,
        views,
        reactions,
        topReactions: [
          { emoji: '🔥', count: 182 },
          { emoji: '👍', count: 133 },
          { emoji: '❤️', count: 97 },
        ],
        lastPublishedAt: addHours(now, -3).toISOString(),
      },
      series: {
        participants: participantsSeries,
        membership: membershipSeries,
        views: viewsSeries,
      },
    },
    secondary: {
      postsWithButtons: range === '24h' ? 1 : range === '7d' ? 5 : 12,
      comments: range === '24h' ? 46 : range === '7d' ? 281 : 970,
      suggestions: range === '24h' ? 5 : range === '7d' ? 17 : 63,
      commentAuthors: range === '24h' ? 31 : range === '7d' ? 118 : 366,
      suggestionAuthors: range === '24h' ? 4 : range === '7d' ? 13 : 44,
      suggestionsDelivered: range === '24h' ? 5 : range === '7d' ? 16 : 61,
      suggestionsFailed: range === '24h' ? 0 : range === '7d' ? 1 : 2,
      lastBotActivityAt: addHours(now, -1.8).toISOString(),
    },
    meta: {
      maxSnapshotAvailable: true,
      viewsAvailable: true,
      churnAvailable: true,
      officialCoverageFrom: addDays(now, -30).toISOString(),
      missingOfficialMetrics: [],
    },
    activityFeed: buildActivityPage(state.channelActivity, { range, limit: 50 }, now),
  });
}

function parseJsonBody(init?: RequestInit): unknown {
  if (!init?.body || typeof init.body !== 'string') {
    return null;
  }

  return JSON.parse(init.body);
}

function createBroadcastHandoffResponse(): BroadcastHandoffResponse {
  return {
    botUrl: 'https://max.ru/maxim-bot',
  };
}

function createPublishRulesResult(chatId: string): PublishChatRulesResult {
  return publishChatRulesResultSchema.parse({
    chatId,
    messageId: `rules-${Date.now()}`,
    url: 'https://max.ru/community/rules-preview',
    publishedAt: new Date().toISOString(),
  });
}

function createPublishEngagementResult(chatId: string): PublishChannelEngagementResult {
  return publishChannelEngagementResultSchema.parse({
    chatId,
    sent: true,
    messageId: `engagement-${Date.now()}`,
    updatedExisting: true,
    publishedAt: new Date().toISOString(),
  });
}

function findBroadcast(
  broadcasts: ManagedBroadcastDetails[],
  broadcastId: string,
): ManagedBroadcastDetails | null {
  return broadcasts.find((item) => item.id === broadcastId) ?? null;
}

function findGiveaway(
  giveaways: ManagedGiveawayDetails[],
  giveawayId: string,
): ManagedGiveawayDetails | null {
  return giveaways.find((item) => item.id === giveawayId) ?? null;
}

function upsertGiveaway(
  giveaways: ManagedGiveawayDetails[],
  giveaway: ManagedGiveawayDetails,
): ManagedGiveawayDetails[] {
  const index = giveaways.findIndex((item) => item.id === giveaway.id);
  if (index === -1) {
    return [giveaway, ...giveaways];
  }

  const next = giveaways.slice();
  next[index] = giveaway;
  return next;
}

function createDraftGiveaway(
  entityType: 'chat' | 'channel',
  entityId: string,
): ManagedGiveawayDetails {
  const now = new Date();

  return managedGiveawayDetailsSchema.parse({
    id: `giveaway-${entityType}-${Date.now()}`,
    title: entityType === 'chat' ? 'Новый розыгрыш в чате' : 'Новый розыгрыш в канале',
    status: 'DRAFT',
    hasImage: false,
    entriesCount: 0,
    verifiedEntriesCount: 0,
    pendingEntriesCount: 0,
    winnersCount: 1,
    startsAt: null,
    endsAt: addDays(now, 2).toISOString(),
    publishedAt: null,
    completedAt: null,
    publicationUrl: null,
    resultsUrl: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sourceChatId: entityId,
    entityType,
    description: '',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    claimHours: 24,
    requiredChannelIds: entityType === 'chat' ? [PREVIEW_CHANNEL_ID] : [entityId],
    publicationMessageId: null,
    resultsMessageId: null,
    prizes: [{ id: `prize-${Date.now()}`, position: 1, title: 'Приз 1' }],
    winners: [],
  });
}

function buildModerationMessage(payload: ManualModerationActionRequest): string {
  if (payload.action === 'KICK') {
    return 'Участник удален из чата в preview-режиме.';
  }
  if (payload.action === 'UNBAN') {
    return 'Участник разбанен в preview-режиме.';
  }
  return `Участник забанен на ${payload.banDurationHours ?? 24}ч в preview-режиме.`;
}

function createModerationResult(
  userId: string,
  payload: ManualModerationActionRequest,
): ManualModerationActionResult {
  const now = new Date();
  return manualModerationActionResultSchema.parse({
    ok: true,
    action: payload.action,
    userId,
    banDurationHours: payload.action === 'BAN' ? (payload.banDurationHours ?? 24) : null,
    unbanScheduledAt:
      payload.action === 'BAN' ? addHours(now, payload.banDurationHours ?? 24).toISOString() : null,
    message: buildModerationMessage(payload),
  });
}

function createManualViolation(
  userId: string,
  displayName: string,
  payload: ManualModerationActionRequest,
): LogsDashboardResponse['violations'][number] {
  const now = new Date();

  if (payload.action === 'UNBAN') {
    return {
      id: `manual-unban-${Date.now()}`,
      action: 'NONE',
      ruleCode: 'MANUAL_UNBAN',
      userId,
      userDisplayName: displayName,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: null,
    };
  }

  if (payload.action === 'KICK') {
    return {
      id: `manual-kick-${Date.now()}`,
      action: 'KICK',
      ruleCode: 'MANUAL_KICK',
      userId,
      userDisplayName: displayName,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: null,
    };
  }

  return {
    id: `manual-ban-${Date.now()}`,
    action: 'BAN',
    ruleCode: 'MANUAL_BAN',
    userId,
    userDisplayName: displayName,
    createdAt: now.toISOString(),
    maskedExcerpt: null,
    metadata: {
      banDurationHours: payload.banDurationHours ?? 24,
      unbanScheduledAt: addHours(now, payload.banDurationHours ?? 24).toISOString(),
    },
  };
}

function resolveDisplayName(state: PreviewState, userId: string): string {
  const fromActivity =
    state.chatActivity.find((item) => item.userId === userId)?.userDisplayName ??
    state.chatViolations.find((item) => item.userId === userId)?.userDisplayName;

  return fromActivity?.trim() || 'Участник';
}

async function handleChatRequest(
  state: PreviewState,
  chatId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): Promise<unknown> {
  if (tail[0] === 'header' && method === 'GET') {
    return {
      id: chatId,
      title: resolveChatTitle(chatId, state),
      entityType: 'chat',
      link: null,
      participantsCount: state.chatHeaderParticipantsCount,
    };
  }

  if (tail[0] === 'settings-screen' && method === 'GET') {
    return cloneJson(buildChatSettingsScreen(state, chatId));
  }

  if (tail[0] === 'dialog' && tail[1]) {
    const dialogType = channelDialogTypeSchema.parse(tail[1]);

    if (tail.length === 2 && method === 'GET') {
      return cloneJson(buildPreviewDialogResponse(chatId, dialogType, state.chatDialogs[dialogType]));
    }

    if (tail[2] === 'messages' && method === 'POST') {
      const payload = createChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const message = buildPreviewDialogMessage({
        id: `chat-${dialogType}-${Date.now()}`,
        type: dialogType,
        text: payload.text,
        authorUserId: state.me.userId,
        authorDisplayName: state.me.displayName ?? state.me.username ?? null,
        createdAt: new Date().toISOString(),
        ...(dialogType === 'suggest'
          ? {
              delivered: true,
              deliveredToUserId: 'preview-admin-2',
            }
          : {}),
      });
      state.chatDialogs[dialogType].messages.push(message);
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message,
      });
    }
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
    const payload = parseJsonBody(init) as { section?: string } | null;
    return applySectionToAllResponseSchema.parse({
      section: payload?.section ?? 'links',
      sourceChatId: chatId,
      updatedChats: state.chats.length,
      appliedChatIds: state.chats.map((item) => item.id),
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
      const published = createPublishRulesResult(chatId);
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

  if (tail[0] === 'poll' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatPoll);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as { question?: string; options?: string[] } | null;
      state.chatPoll = managedPollSchema.parse({
        ...state.chatPoll,
        question: payload?.question ?? state.chatPoll.question,
        options: payload?.options ?? state.chatPoll.options,
        optionResults: [],
        totalVotes: 0,
      });
      return cloneJson(state.chatPoll);
    }
  }

  if (tail[0] === 'poll' && tail[1] === 'publish' && method === 'POST') {
    state.chatPoll = managedPollSchema.parse({
      ...state.chatPoll,
      status: 'ACTIVE',
      publishedMessageId: `poll-${Date.now()}`,
      publishedUrl: 'https://max.ru/poll/preview-active',
      publishedAt: new Date().toISOString(),
      totalVotes: state.chatPoll.totalVotes || 18,
      optionResults:
        state.chatPoll.optionResults.length > 0
          ? state.chatPoll.optionResults
          : state.chatPoll.options.map((option, index) => ({
              option,
              votes: index === 0 ? 9 : 4 + index,
              percent: index === 0 ? 50 : 25,
            })),
    });
    return cloneJson(state.chatPoll);
  }

  if (tail[0] === 'poll' && tail[1] === 'close' && method === 'POST') {
    state.chatPoll = managedPollSchema.parse({
      ...state.chatPoll,
      status: 'CLOSED',
      closedAt: new Date().toISOString(),
    });
    return cloneJson(state.chatPoll);
  }

  if (tail[0] === 'broadcast' && tail[1] === 'handoff') {
    if (method === 'GET') {
      return buildBroadcastHandoffState(state.chatBroadcasts[0] ?? state.channelBroadcasts[0]);
    }

    if (method === 'POST') {
      return createBroadcastHandoffResponse();
    }
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
        updatedAt: new Date().toISOString(),
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
        updatedAt: new Date().toISOString(),
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
      updatedAt: new Date().toISOString(),
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
    const payload = parseJsonBody(init) as { domain?: string } | null;
    const domain = payload?.domain?.trim();
    if (!domain) {
      throw new Error('Preview domain is required');
    }

    if (!state.chatDomains.some((item) => item.domain === domain)) {
      state.chatDomains = [
        domainAllowlistEntrySchema.parse({ domain, removeAfterAt: null }),
        ...state.chatDomains,
      ];
    }
    return null;
  }

  if (tail[0] === 'domain-allowlist' && tail[1] && tail.length === 2 && method === 'DELETE') {
    const domain = decodeURIComponent(tail[1]);
    state.chatDomains = state.chatDomains.filter((item) => item.domain !== domain);
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
      item.domain === domain
        ? domainAllowlistEntrySchema.parse({
            ...item,
            removeAfterAt: payload?.removeAfterAt ?? null,
          })
        : item,
    );
    return null;
  }

  if (tail[0] === 'giveaways' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.chatGiveaways.map(buildGiveawaySummary));
    }

    if (method === 'POST') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const draft = createDraftGiveaway('chat', chatId);
      const created = managedGiveawayDetailsSchema.parse({
        ...draft,
        ...(payload ?? {}),
        sourceChatId: chatId,
        updatedAt: new Date().toISOString(),
      });
      state.chatGiveaways = upsertGiveaway(state.chatGiveaways, created);
      return cloneJson(created);
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail.length === 2) {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedGiveawayDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        sourceChatId: chatId,
        updatedAt: new Date().toISOString(),
      });
      state.chatGiveaways = upsertGiveaway(state.chatGiveaways, updated);
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      state.chatGiveaways = state.chatGiveaways.filter((item) => item.id !== details.id);
      return null;
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const published = managedGiveawayDetailsSchema.parse({
      ...details,
      status: details.startsAt ? 'SCHEDULED' : 'ACTIVE',
      publishedAt: new Date().toISOString(),
      publicationMessageId: `giveaway-${Date.now()}`,
      publicationUrl: 'https://max.ru/giveaway/published-preview',
      updatedAt: new Date().toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, published);
    return cloneJson(published);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'cancel' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const canceled = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'CANCELED',
      updatedAt: new Date().toISOString(),
    });
    state.chatGiveaways = upsertGiveaway(state.chatGiveaways, canceled);
    return cloneJson(canceled);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'reroll' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'deliver' && method === 'POST') {
    const details = findGiveaway(state.chatGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaway' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  if (tail[0] === 'logs-dashboard' && method === 'GET') {
    const range = (url.searchParams.get('range') as LogsDashboardRange | null) ?? '7d';
    return cloneJson(buildLogsDashboard(state, chatId, range));
  }

  if (tail[0] === 'activity-feed' && method === 'GET') {
    return cloneJson(
      buildActivityPage(
        state.chatActivity,
        {
          range: (url.searchParams.get('range') as MembershipActivityRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as MembershipActivityFilter | null) ?? 'all',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        new Date(),
      ),
    );
  }

  if (tail[0] === 'members' && tail[1] && tail[2] === 'moderation-action' && method === 'POST') {
    const userId = decodeURIComponent(tail[1]);
    const payload = parseJsonBody(init) as ManualModerationActionRequest;
    const displayName = resolveDisplayName(state, userId);
    state.chatViolations = [
      createManualViolation(userId, displayName, payload),
      ...state.chatViolations,
    ];
    return createModerationResult(userId, payload);
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

async function handleChannelRequest(
  state: PreviewState,
  channelId: string,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): Promise<unknown> {
  if (tail[0] === 'header' && method === 'GET') {
    return {
      id: channelId,
      title: resolveChannelTitle(channelId, state),
      entityType: 'channel',
      link: 'https://max.ru/channels/yuzhnoe-news',
      participantsCount: state.channelHeaderParticipantsCount,
    };
  }

  if (tail[0] === 'settings-screen' && method === 'GET') {
    return cloneJson(buildChannelSettingsScreen(state, channelId));
  }

  if (tail[0] === 'dialog' && tail[1]) {
    const dialogType = channelDialogTypeSchema.parse(tail[1]);

    if (tail.length === 2 && method === 'GET') {
      return cloneJson(
        buildPreviewDialogResponse(channelId, dialogType, state.channelDialogs[dialogType]),
      );
    }

    if (tail[2] === 'messages' && method === 'POST') {
      const payload = createChannelDialogMessageRequestSchema.parse(parseJsonBody(init));
      const message = buildPreviewDialogMessage({
        id: `channel-${dialogType}-${Date.now()}`,
        type: dialogType,
        text: payload.text,
        authorUserId: state.me.userId,
        authorDisplayName: state.me.displayName ?? state.me.username ?? null,
        createdAt: new Date().toISOString(),
        ...(dialogType === 'suggest'
          ? {
              delivered: true,
              deliveredToUserId: 'preview-admin-2',
            }
          : {}),
      });
      state.channelDialogs[dialogType].messages.push(message);
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message,
      });
    }
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

  if (tail[0] === 'poll' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelPoll);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as { question?: string; options?: string[] } | null;
      state.channelPoll = managedPollSchema.parse({
        ...state.channelPoll,
        question: payload?.question ?? state.channelPoll.question,
        options: payload?.options ?? state.channelPoll.options,
        optionResults: [],
        totalVotes: 0,
      });
      return cloneJson(state.channelPoll);
    }
  }

  if (tail[0] === 'poll' && tail[1] === 'publish' && method === 'POST') {
    state.channelPoll = managedPollSchema.parse({
      ...state.channelPoll,
      status: 'ACTIVE',
      publishedMessageId: `channel-poll-${Date.now()}`,
      publishedUrl: 'https://max.ru/poll/channel-preview',
      publishedAt: new Date().toISOString(),
      totalVotes: 61,
      optionResults: state.channelPoll.options.map((option, index) => ({
        option,
        votes: index === 0 ? 30 : index === 1 ? 17 : 14,
        percent: index === 0 ? 49 : index === 1 ? 28 : 23,
      })),
    });
    return cloneJson(state.channelPoll);
  }

  if (tail[0] === 'poll' && tail[1] === 'close' && method === 'POST') {
    state.channelPoll = managedPollSchema.parse({
      ...state.channelPoll,
      status: 'CLOSED',
      closedAt: new Date().toISOString(),
    });
    return cloneJson(state.channelPoll);
  }

  if (tail[0] === 'broadcast' && tail[1] === 'handoff') {
    if (method === 'GET') {
      return buildBroadcastHandoffState(state.channelBroadcasts[0] ?? state.chatBroadcasts[0]);
    }

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
        updatedAt: new Date().toISOString(),
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
        updatedAt: new Date().toISOString(),
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
      updatedAt: new Date().toISOString(),
    });
    state.channelBroadcasts = state.channelBroadcasts.map((item) =>
      item.id === details.id ? retried : item,
    );
    return cloneJson(retried);
  }

  if (tail[0] === 'engagement-publish' && method === 'POST') {
    return createPublishEngagementResult(channelId);
  }

  if (tail[0] === 'giveaways' && tail.length === 1) {
    if (method === 'GET') {
      return cloneJson(state.channelGiveaways.map(buildGiveawaySummary));
    }

    if (method === 'POST') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const draft = createDraftGiveaway('channel', channelId);
      const created = managedGiveawayDetailsSchema.parse({
        ...draft,
        ...(payload ?? {}),
        sourceChatId: channelId,
        entityType: 'channel',
        updatedAt: new Date().toISOString(),
      });
      state.channelGiveaways = upsertGiveaway(state.channelGiveaways, created);
      return cloneJson(created);
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail.length === 2) {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    if (method === 'GET') {
      return cloneJson(details);
    }

    if (method === 'PUT') {
      const payload = parseJsonBody(init) as Record<string, unknown> | null;
      const updated = managedGiveawayDetailsSchema.parse({
        ...details,
        ...(payload ?? {}),
        sourceChatId: channelId,
        entityType: 'channel',
        updatedAt: new Date().toISOString(),
      });
      state.channelGiveaways = upsertGiveaway(state.channelGiveaways, updated);
      return cloneJson(updated);
    }

    if (method === 'DELETE') {
      state.channelGiveaways = state.channelGiveaways.filter((item) => item.id !== details.id);
      return null;
    }
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'publish' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const published = managedGiveawayDetailsSchema.parse({
      ...details,
      status: details.startsAt ? 'SCHEDULED' : 'ACTIVE',
      publishedAt: new Date().toISOString(),
      publicationMessageId: `giveaway-channel-${Date.now()}`,
      publicationUrl: 'https://max.ru/giveaway/channel-preview',
      updatedAt: new Date().toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, published);
    return cloneJson(published);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'cancel' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }

    const canceled = managedGiveawayDetailsSchema.parse({
      ...details,
      status: 'CANCELED',
      updatedAt: new Date().toISOString(),
    });
    state.channelGiveaways = upsertGiveaway(state.channelGiveaways, canceled);
    return cloneJson(canceled);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'reroll' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaways' && tail[1] && tail[2] === 'deliver' && method === 'POST') {
    const details = findGiveaway(state.channelGiveaways, tail[1]);
    if (!details) {
      throw new Error(`Preview giveaway not found: ${tail[1]}`);
    }
    return cloneJson(details);
  }

  if (tail[0] === 'giveaway' && tail[1] === 'handoff' && method === 'POST') {
    return createBroadcastHandoffResponse();
  }

  if (tail[0] === 'stats' && method === 'GET') {
    const range = (url.searchParams.get('range') as ChannelStatsRange | null) ?? '7d';
    return cloneJson(buildChannelStats(state, channelId, range));
  }

  if (tail[0] === 'activity-feed' && method === 'GET') {
    return cloneJson(
      buildActivityPage(
        state.channelActivity,
        {
          range: (url.searchParams.get('range') as MembershipActivityRange | null) ?? '7d',
          filter: (url.searchParams.get('filter') as MembershipActivityFilter | null) ?? 'all',
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          cursor: url.searchParams.get('cursor'),
        },
        new Date(),
      ),
    );
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}

export function createPreviewApiTransport(): ApiTransport {
  const state = createInitialState();

  return {
    async request(path: string, init: RequestInit = {}) {
      const url = new URL(path, 'https://preview.local');
      const method = (init.method ?? 'GET').toUpperCase();

      if (url.pathname === '/me' && method === 'GET') {
        return cloneJson(state.me);
      }

      if (url.pathname === '/chats' && method === 'GET') {
        return cloneJson(state.chats);
      }

      if (url.pathname === '/channels' && method === 'GET') {
        return cloneJson(state.channels);
      }

      const segments = url.pathname.split('/').filter(Boolean);
      if (segments[0] === 'chats' && segments[1]) {
        return handleChatRequest(state, segments[1], segments.slice(2), url, method, init);
      }

      if (segments[0] === 'channels' && segments[1]) {
        return handleChannelRequest(state, segments[1], segments.slice(2), url, method, init);
      }

      throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
    },
  };
}
