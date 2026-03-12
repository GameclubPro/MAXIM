import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  managedGiveawayHandoffRequestSchema,
  type BroadcastHandoffResponse,
  type ChannelSettings,
  type ChatSettings,
  type LogsDashboardRange,
  type ManagedGiveawayDetails,
  type ManagedGiveawayWinner,
  MANAGED_GIVEAWAY_MAX_PRIZES,
  MANAGED_POLL_MAX_OPTIONS,
  MANAGED_POLL_MIN_OPTIONS,
  type ManagedEntityType,
  type ManagedPoll,
  type MaxUpdate,
  type UpdateManagedGiveawayRequest,
} from '@maxim/contracts';
import { AdminService } from '../admin/admin.service';
import { ManagedGiveawayService } from '../admin/managed-giveaway.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  MaxClientService,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { RedisCounterService } from './redis-counter.service';

type PrivateSectionKey =
  | 'links'
  | 'greeting'
  | 'profanityFilter'
  | 'commercialFilter'
  | 'thematicFilters'
  | 'duplicates'
  | 'limits'
  | 'night'
  | 'extra';

type ChannelSectionKey = 'post_suggestions' | 'comments';

type SettingFieldType = 'boolean' | 'number' | 'text' | 'url' | 'enum' | 'time' | 'timezone';

type SettingFieldConfig = {
  key: keyof ChatSettings;
  label: string;
  type: SettingFieldType;
  min?: number;
  max?: number;
  step?: number;
  presets?: readonly number[];
  enumValues?: readonly string[];
};

type PendingInput =
  | {
      kind: 'set_field';
      section: PrivateSectionKey;
      key: keyof ChatSettings;
      type: SettingFieldType;
      min?: number;
      max?: number;
    }
  | {
      kind: 'set_channel_field';
      section: ChannelSectionKey;
      key: keyof ChannelSettings;
      type: SettingFieldType;
      min?: number;
      max?: number;
    }
  | { kind: 'search_settings' }
  | { kind: 'add_domain' }
  | { kind: 'schedule_domain'; domain: string }
  | { kind: 'add_blacklist_user' }
  | { kind: 'remove_blacklist_user' }
  | { kind: 'broadcast_content' }
  | { kind: 'broadcast_text' }
  | { kind: 'broadcast_button_url' }
  | { kind: 'broadcast_button_text' }
  | { kind: 'broadcast_send_at' }
  | { kind: 'broadcast_cycle_every_hours' }
  | { kind: 'broadcast_cycle_count' }
  | { kind: 'broadcast_photo' }
  | { kind: 'giveaway_title' }
  | { kind: 'giveaway_description' }
  | { kind: 'giveaway_start_at' }
  | { kind: 'giveaway_end_at' }
  | { kind: 'giveaway_claim_hours' }
  | { kind: 'giveaway_photo' }
  | { kind: 'giveaway_prize'; index: number }
  | { kind: 'poll_question' }
  | { kind: 'poll_option'; index: number }
  | { kind: 'manual_ban_duration'; targetUserId: string };

type PendingMassAction =
  | {
      kind: 'apply_section';
      section: PrivateSectionKey;
      targetChats: number;
    }
  | {
      kind: 'broadcast';
      targetChats: number;
    };

type PrivateBroadcastDraft = {
  text: string;
  applyToAllChats: boolean;
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
  sendAt: string | null;
  cycleEnabled: boolean;
  cycleEveryHours: number;
  cycleCount: number;
};

type PrivatePollDraft = {
  question: string;
  options: string[];
};

type PrivateScreen =
  | 'chat_select'
  | 'home'
  | 'settings_hub'
  | 'section'
  | 'channel_section'
  | 'domains'
  | 'global_blacklist'
  | 'broadcast'
  | 'poll'
  | 'giveaway'
  | 'events'
  | 'logs'
  | 'search'
  | 'manual_users'
  | 'manual_actions';

type PrivateUiMode = 'modern' | 'legacy';
type PrivateHomeTab = 'quick' | 'all';
type PrivateSectionView = 'basic' | 'advanced';
type PrivateBroadcastView = 'basic' | 'advanced';

type PrivateSession = {
  version: 3;
  selectedChatId: string | null;
  selectedEntityType: ManagedEntityType | null;
  managedGiveawayId: string | null;
  entityTab: ManagedEntityType;
  uiMode: PrivateUiMode;
  screen: PrivateScreen;
  homeTab: PrivateHomeTab;
  sectionView: PrivateSectionView;
  searchQuery: string | null;
  lastScreenStack: string[];
  broadcastView: PrivateBroadcastView;
  section: PrivateSectionKey | null;
  channelSection: ChannelSectionKey | null;
  chatPage: number;
  domainPage: number;
  eventsPage: number;
  manualPage: number;
  logsRange: LogsDashboardRange;
  manualTargetUserId: string | null;
  pendingInput: PendingInput | null;
  pendingMassAction: PendingMassAction | null;
  broadcastDraft: PrivateBroadcastDraft;
  pollDraft: PrivatePollDraft;
};

type PrivateContext = {
  update: MaxUpdate;
  chatId: string;
  actor: AuthUser;
  text: string;
  callbackId: string | null;
  callbackPayload: string | null;
};

type PrivateView = {
  text: string;
  options?: MaxSendMessageOptions;
};

type CallbackAction = {
  action: string;
  args: string[];
};

type ParsedImageAttachment = {
  url: string;
  token: string | null;
  photoId: string | null;
};

const SESSION_TTL_SEC = 45 * 60;
const SESSION_KEY_PREFIX = 'private-ui:v2';
const BROADCAST_HANDOFF_START_PAYLOAD = 'broadcast_handoff';
const GIVEAWAY_HANDOFF_START_PAYLOAD = 'giveaway_handoff';
const PAGE_SIZE_CHATS = 8;
const PAGE_SIZE_DOMAINS = 8;
const PAGE_SIZE_EVENTS = 10;
const PAGE_SIZE_MANUAL_USERS = 8;
const SEARCH_RESULT_LIMIT = 8;
const SUPPORT_CHAT_URL = 'https://max.ru/join/qX7U_Hj-L-xMJG8V7wlF6dD-6a6cXIzTBGRtU2mRMzk';
const MAX_CALLBACK_PREFIX = 'pc2';
const LEGACY_CALLBACK_PREFIX = 'pc';
const CALLBACK_REFRESH_NOTIFICATION = 'Меню обновлено';
const CALLBACK_STALE_NOTIFICATION = 'Кнопки устарели, обновляю экран';

const CHAT_ONLY_CALLBACK_ACTIONS = new Set<string>([
  'open_settings_hub',
  'open_section',
  'toggle',
  'set_enum',
  'set_number_preset',
  'step_number',
  'set_input',
  'section_view',
  'open_search',
  'search_jump',
  'apply_section_preview',
  'open_domains',
  'domains_page',
  'domain_add_prompt',
  'domain_remove',
  'domain_schedule_prompt',
  'open_blacklist',
  'blacklist_add_prompt',
  'blacklist_remove_prompt',
  'blacklist_remove',
  'open_events',
  'events_page',
  'open_logs',
  'logs_range',
  'open_manual_users',
  'manual_users_page',
  'manual_select_user',
  'manual_action',
]);

const CHANNEL_ONLY_CALLBACK_ACTIONS = new Set<string>([
  'open_channel_section',
  'toggle_channel',
  'set_channel_input',
  'publish_channel_engagement',
]);

const ENTITY_CALLBACK_ACTIONS = new Set<string>([
  'open_broadcast',
  'open_giveaway',
  'refresh_giveaway',
  'giveaway_create',
  'giveaway_input_prompt',
  'giveaway_clear_start',
  'giveaway_clear_photo',
  'giveaway_add_prize',
  'giveaway_remove_last_prize',
  'giveaway_publish',
  'giveaway_close',
  'giveaway_cancel',
  'giveaway_reroll',
  'giveaway_deliver',
  'broadcast_view',
  'broadcast_toggle',
  'broadcast_input_prompt',
  'broadcast_clear_timer',
  'broadcast_clear_photo',
  'broadcast_send',
]);

const SECTION_LABELS: Record<PrivateSectionKey, string> = {
  links: 'Модерация ссылок',
  greeting: 'Приветствие',
  profanityFilter: 'Фильтр нецензурной лексики',
  commercialFilter: 'Фильтр коммерции',
  thematicFilters: 'Тематические фильтры',
  duplicates: 'Дубли сообщений',
  limits: 'Ограничения сообщений',
  night: 'Ночной режим',
  extra: 'Дополнительно',
};

const CHANNEL_SECTION_LABELS: Record<ChannelSectionKey, string> = {
  post_suggestions: 'Предложка',
  comments: 'Обсуждение и реакции',
};

const CHANNEL_SECTION_FIELDS: Record<
  ChannelSectionKey,
  Array<{
    key: keyof ChannelSettings;
    label: string;
    type: SettingFieldType;
    min?: number;
    max?: number;
  }>
> = {
  post_suggestions: [
    { key: 'postSuggestionsEnabled', label: 'Подсказка «Предложить пост»', type: 'boolean' },
    { key: 'engagementMessageText', label: 'Текст публикации', type: 'text' },
    { key: 'postSuggestionsText', label: 'Текст для участников', type: 'text' },
    { key: 'postSuggestionsButtonEnabled', label: 'Показывать кнопку перехода', type: 'boolean' },
    { key: 'postSuggestionsButtonText', label: 'Название кнопки', type: 'text' },
    { key: 'postSuggestionsButtonUrl', label: 'Ссылка кнопки (из MAX)', type: 'url' },
  ],
  comments: [
    { key: 'commentsEnabled', label: 'Сценарий обсуждения через бота/чат', type: 'boolean' },
    { key: 'commentsModerationEnabled', label: 'Модерация обсуждений ботом', type: 'boolean' },
    { key: 'commentsMessageText', label: 'Текст-подсказка для участников', type: 'text' },
  ],
};

const SECTION_FIELDS: Record<PrivateSectionKey, SettingFieldConfig[]> = {
  links: [
    {
      key: 'linkPolicy',
      label: 'Режим проверки ссылок',
      type: 'enum',
      enumValues: ['ALERT_ONLY', 'ALLOWLIST_ONLY', 'BLOCKLIST_ONLY'],
    },
    { key: 'linkBotMessageEnabled', label: 'Показывать сообщение бота', type: 'boolean' },
    { key: 'linkBotMessageText', label: 'Текст сообщения бота', type: 'text' },
    { key: 'linkWarnEnabled', label: 'Выдавать предупреждение', type: 'boolean' },
    { key: 'linkWarnMessageText', label: 'Текст предупреждения', type: 'text' },
    { key: 'linkBanEnabled', label: 'Банить нарушителя', type: 'boolean' },
    { key: 'linkKickEnabled', label: 'Кикать из чата', type: 'boolean' },
    { key: 'linkBotButtonEnabled', label: 'Показывать кнопку', type: 'boolean' },
    { key: 'linkBotButtonUrl', label: 'Ссылка кнопки', type: 'url' },
    { key: 'linkBotButtonText', label: 'Текст кнопки', type: 'text' },
  ],
  greeting: [
    { key: 'greetingEnabled', label: 'Включить приветствие', type: 'boolean' },
    { key: 'greetingBotMessageEnabled', label: 'Отправлять приветствие', type: 'boolean' },
    { key: 'greetingBotMessageText', label: 'Текст приветствия', type: 'text' },
    { key: 'greetingBotButtonEnabled', label: 'Показывать кнопку', type: 'boolean' },
    { key: 'greetingBotButtonUrl', label: 'Ссылка кнопки', type: 'url' },
    { key: 'greetingBotButtonText', label: 'Текст кнопки', type: 'text' },
  ],
  profanityFilter: [
    { key: 'russianProfanityFilterEnabled', label: 'Включить фильтр', type: 'boolean' },
    { key: 'profanityBotMessageEnabled', label: 'Показывать сообщение бота', type: 'boolean' },
    { key: 'profanityWarnEnabled', label: 'Выдавать предупреждение', type: 'boolean' },
    { key: 'profanityKickEnabled', label: 'Кикать из чата', type: 'boolean' },
    { key: 'profanityBanEnabled', label: 'Банить нарушителя', type: 'boolean' },
  ],
  commercialFilter: [
    { key: 'commercialAdsFilterEnabled', label: 'Включить фильтр', type: 'boolean' },
    {
      key: 'commercialAdsSensitivity',
      label: 'Уровень строгости',
      type: 'enum',
      enumValues: ['BALANCED', 'STRICT'],
    },
    {
      key: 'commercialAdsWarnThreshold',
      label: 'Порог предупреждения',
      type: 'number',
      min: 1,
      max: 100,
      step: 5,
      presets: [20, 40, 60],
    },
    {
      key: 'commercialAdsDeleteThreshold',
      label: 'Порог удаления',
      type: 'number',
      min: 1,
      max: 100,
      step: 5,
      presets: [40, 60, 80],
    },
    { key: 'textFiltersBotMessageEnabled', label: 'Показывать сообщение бота', type: 'boolean' },
    { key: 'textFiltersBotMessageText', label: 'Текст сообщения бота', type: 'text' },
    { key: 'textFiltersWarnEnabled', label: 'Выдавать предупреждение', type: 'boolean' },
    { key: 'textFiltersWarnMessageText', label: 'Текст предупреждения', type: 'text' },
    { key: 'textFiltersKickEnabled', label: 'Кикать из чата', type: 'boolean' },
    { key: 'textFiltersBanEnabled', label: 'Банить нарушителя', type: 'boolean' },
    { key: 'textFiltersBotButtonEnabled', label: 'Показывать кнопку', type: 'boolean' },
    { key: 'textFiltersBotButtonUrl', label: 'Ссылка кнопки', type: 'url' },
    { key: 'textFiltersBotButtonText', label: 'Текст кнопки', type: 'text' },
  ],
  thematicFilters: [
    {
      key: 'thematicCodewordEnabled',
      label: 'Фильтр по кодовому слову',
      type: 'boolean',
    },
    {
      key: 'thematicCodeword',
      label: 'Кодовое слово',
      type: 'text',
    },
    {
      key: 'thematicFiltersBotMessageEnabled',
      label: 'Шаг 1: объяснение',
      type: 'boolean',
    },
    {
      key: 'thematicFiltersWarnEnabled',
      label: 'Шаг 2: предупреждение',
      type: 'boolean',
    },
    {
      key: 'thematicFiltersBanEnabled',
      label: 'Шаг 3: бан',
      type: 'boolean',
    },
    {
      key: 'thematicFiltersKickEnabled',
      label: 'Шаг 4: кик',
      type: 'boolean',
    },
    {
      key: 'thematicFiltersBotButtonEnabled',
      label: 'Показывать кнопку',
      type: 'boolean',
    },
    {
      key: 'thematicFiltersBotButtonUrl',
      label: 'Ссылка кнопки',
      type: 'url',
    },
    {
      key: 'thematicFiltersBotButtonText',
      label: 'Текст кнопки',
      type: 'text',
    },
  ],
  duplicates: [
    { key: 'antiDuplicateEnabled', label: 'Включить антидубли', type: 'boolean' },
    { key: 'duplicateWarnEnabled', label: 'Штраф: предупреждение', type: 'boolean' },
    {
      key: 'duplicateWarnWindowSec',
      label: 'Период для WARN (сек)',
      type: 'number',
      min: 60,
      max: 604800,
      step: 300,
      presets: [300, 600, 1800],
    },
    {
      key: 'duplicateWarnMaxCount',
      label: 'Лимит повторов для WARN',
      type: 'number',
      min: 1,
      max: 100,
      step: 1,
      presets: [2, 3, 5],
    },
    { key: 'duplicateKickEnabled', label: 'Штраф: кик', type: 'boolean' },
    {
      key: 'duplicateKickWindowSec',
      label: 'Период для KICK (сек)',
      type: 'number',
      min: 60,
      max: 604800,
      step: 600,
      presets: [600, 1800, 3600],
    },
    {
      key: 'duplicateKickMaxCount',
      label: 'Лимит повторов для KICK',
      type: 'number',
      min: 1,
      max: 100,
      step: 1,
      presets: [3, 5, 7],
    },
    { key: 'duplicateBanEnabled', label: 'Штраф: бан', type: 'boolean' },
    {
      key: 'duplicateBanWindowSec',
      label: 'Период для BAN (сек)',
      type: 'number',
      min: 60,
      max: 1209600,
      step: 3600,
      presets: [3600, 21600, 86400],
    },
    {
      key: 'duplicateBanMaxCount',
      label: 'Лимит повторов для BAN',
      type: 'number',
      min: 1,
      max: 100,
      step: 1,
      presets: [4, 6, 8],
    },
    { key: 'duplicateBotMessageEnabled', label: 'Показывать сообщение бота', type: 'boolean' },
    { key: 'duplicateBotMessageText', label: 'Текст сообщения бота', type: 'text' },
    { key: 'duplicateBotButtonEnabled', label: 'Показывать кнопку', type: 'boolean' },
    { key: 'duplicateBotButtonUrl', label: 'Ссылка кнопки', type: 'url' },
    { key: 'duplicateBotButtonText', label: 'Текст кнопки', type: 'text' },
    {
      key: 'banDurationHours',
      label: 'Длительность бана (часы)',
      type: 'number',
      min: 1,
      max: 336,
      step: 1,
      presets: [1, 6, 24],
    },
  ],
  limits: [
    { key: 'antiSpamEnabled', label: 'Включить антиспам', type: 'boolean' },
    { key: 'maxMessageLengthEnabled', label: 'Ограничить длину сообщений', type: 'boolean' },
    {
      key: 'maxMessageLength',
      label: 'Макс. длина сообщения',
      type: 'number',
      min: 50,
      max: 10000,
      step: 50,
      presets: [300, 800, 1500],
    },
    { key: 'photoMessageCooldownEnabled', label: 'Ограничить частые фото', type: 'boolean' },
    {
      key: 'photoMessageCooldownHours',
      label: 'Интервал между фото (часы)',
      type: 'number',
      min: 1,
      max: 336,
      step: 1,
      presets: [1, 6, 24],
    },
    { key: 'stickerMessageCooldownEnabled', label: 'Ограничить частые стикеры', type: 'boolean' },
    {
      key: 'stickerMessageCooldownMinutes',
      label: 'Интервал между стикерами (мин)',
      type: 'number',
      min: 1,
      max: 1440,
      step: 5,
      presets: [5, 15, 60],
    },
    { key: 'videoMessagesEnabled', label: 'Разрешить видео', type: 'boolean' },
    { key: 'fileMessagesEnabled', label: 'Разрешить файлы', type: 'boolean' },
    { key: 'voiceMessagesEnabled', label: 'Разрешить голосовые', type: 'boolean' },
    { key: 'messageLimitsBotMessageEnabled', label: 'Показывать сообщение бота', type: 'boolean' },
    { key: 'messageLimitsBotMessageText', label: 'Текст сообщения бота', type: 'text' },
    { key: 'messageLimitsWarnEnabled', label: 'Штраф: предупреждение', type: 'boolean' },
    { key: 'messageLimitsKickEnabled', label: 'Штраф: кик', type: 'boolean' },
    { key: 'messageLimitsBanEnabled', label: 'Штраф: бан', type: 'boolean' },
    { key: 'messageLimitsBotButtonEnabled', label: 'Показывать кнопку', type: 'boolean' },
    { key: 'messageLimitsBotButtonUrl', label: 'Ссылка кнопки', type: 'url' },
    { key: 'messageLimitsBotButtonText', label: 'Текст кнопки', type: 'text' },
    {
      key: 'banDurationHours',
      label: 'Длительность бана (часы)',
      type: 'number',
      min: 1,
      max: 336,
      step: 1,
      presets: [1, 6, 24],
    },
  ],
  night: [
    { key: 'nightModeEnabled', label: 'Включить ночной режим', type: 'boolean' },
    { key: 'nightModeStartTimeMinutes', label: 'Начало (HH:MM)', type: 'time' },
    { key: 'nightModeEndTimeMinutes', label: 'Конец (HH:MM)', type: 'time' },
    { key: 'nightModeTimezone', label: 'Часовой пояс', type: 'timezone' },
    { key: 'nightModeBotMessageEnabled', label: 'Показывать сообщение бота', type: 'boolean' },
    { key: 'nightModeBotMessageText', label: 'Текст сообщения бота', type: 'text' },
    { key: 'nightModeBotButtonEnabled', label: 'Показывать кнопку', type: 'boolean' },
    { key: 'nightModeBotButtonUrl', label: 'Ссылка кнопки', type: 'url' },
    { key: 'nightModeBotButtonText', label: 'Текст кнопки', type: 'text' },
  ],
  extra: [
    {
      key: 'globalCrossChatSpamEnabled',
      label: 'Глобальный антиспам между чатами',
      type: 'boolean',
    },
    { key: 'deleteBotMessagesEnabled', label: 'Удалять сообщения бота', type: 'boolean' },
    {
      key: 'deleteBotMessagesDelayMinutes',
      label: 'Задержка удаления (мин)',
      type: 'number',
      min: 1,
      max: 60,
      step: 1,
      presets: [1, 5, 15],
    },
    { key: 'removeBotsFromGroupEnabled', label: 'Удалять ботов из чата', type: 'boolean' },
    {
      key: 'globalUserBlacklistEnabled',
      label: 'Включить глобальный чёрный список',
      type: 'boolean',
    },
  ],
};

const SECTION_SETTING_KEYS: Record<PrivateSectionKey, readonly (keyof ChatSettings)[]> = {
  links: SECTION_FIELDS.links.map((field) => field.key),
  greeting: SECTION_FIELDS.greeting.map((field) => field.key),
  profanityFilter: SECTION_FIELDS.profanityFilter.map((field) => field.key),
  commercialFilter: SECTION_FIELDS.commercialFilter.map((field) => field.key),
  thematicFilters: SECTION_FIELDS.thematicFilters.map((field) => field.key),
  duplicates: SECTION_FIELDS.duplicates.map((field) => field.key),
  limits: SECTION_FIELDS.limits.map((field) => field.key),
  night: SECTION_FIELDS.night.map((field) => field.key),
  extra: SECTION_FIELDS.extra.map((field) => field.key),
};

const SECTION_ORDER: PrivateSectionKey[] = [
  'links',
  'greeting',
  'profanityFilter',
  'commercialFilter',
  'thematicFilters',
  'duplicates',
  'limits',
  'night',
  'extra',
];

const SECTION_CARD_FIELDS: Record<
  PrivateSectionKey,
  { basic: readonly (keyof ChatSettings)[]; advanced: readonly (keyof ChatSettings)[] }
> = {
  links: {
    basic: [
      'linkPolicy',
      'linkWarnEnabled',
      'linkKickEnabled',
      'linkBanEnabled',
      'linkBotMessageEnabled',
    ],
    advanced: [
      'linkBotMessageText',
      'linkWarnMessageText',
      'linkBotButtonEnabled',
      'linkBotButtonText',
      'linkBotButtonUrl',
    ],
  },
  greeting: {
    basic: ['greetingEnabled', 'greetingBotMessageEnabled'],
    advanced: [
      'greetingBotMessageText',
      'greetingBotButtonEnabled',
      'greetingBotButtonText',
      'greetingBotButtonUrl',
    ],
  },
  profanityFilter: {
    basic: [
      'russianProfanityFilterEnabled',
      'profanityWarnEnabled',
      'profanityKickEnabled',
      'profanityBanEnabled',
    ],
    advanced: ['profanityBotMessageEnabled'],
  },
  commercialFilter: {
    basic: [
      'commercialAdsFilterEnabled',
      'commercialAdsSensitivity',
      'commercialAdsWarnThreshold',
      'commercialAdsDeleteThreshold',
    ],
    advanced: [
      'textFiltersBotMessageEnabled',
      'textFiltersBotMessageText',
      'textFiltersWarnEnabled',
      'textFiltersWarnMessageText',
      'textFiltersKickEnabled',
      'textFiltersBanEnabled',
      'textFiltersBotButtonEnabled',
      'textFiltersBotButtonText',
      'textFiltersBotButtonUrl',
    ],
  },
  thematicFilters: {
    basic: [
      'thematicCodewordEnabled',
      'thematicCodeword',
      'thematicFiltersBotMessageEnabled',
      'thematicFiltersWarnEnabled',
      'thematicFiltersBanEnabled',
      'thematicFiltersKickEnabled',
    ],
    advanced: [
      'thematicFiltersBotButtonEnabled',
      'thematicFiltersBotButtonText',
      'thematicFiltersBotButtonUrl',
    ],
  },
  duplicates: {
    basic: [
      'antiDuplicateEnabled',
      'duplicateWarnEnabled',
      'duplicateKickEnabled',
      'duplicateBanEnabled',
      'banDurationHours',
    ],
    advanced: [
      'duplicateWarnWindowSec',
      'duplicateWarnMaxCount',
      'duplicateKickWindowSec',
      'duplicateKickMaxCount',
      'duplicateBanWindowSec',
      'duplicateBanMaxCount',
      'duplicateBotMessageEnabled',
      'duplicateBotMessageText',
      'duplicateBotButtonEnabled',
      'duplicateBotButtonText',
      'duplicateBotButtonUrl',
    ],
  },
  limits: {
    basic: [
      'antiSpamEnabled',
      'maxMessageLengthEnabled',
      'maxMessageLength',
      'videoMessagesEnabled',
      'fileMessagesEnabled',
      'voiceMessagesEnabled',
    ],
    advanced: [
      'photoMessageCooldownEnabled',
      'photoMessageCooldownHours',
      'stickerMessageCooldownEnabled',
      'stickerMessageCooldownMinutes',
      'messageLimitsBotMessageEnabled',
      'messageLimitsBotMessageText',
      'messageLimitsWarnEnabled',
      'messageLimitsKickEnabled',
      'messageLimitsBanEnabled',
      'messageLimitsBotButtonEnabled',
      'messageLimitsBotButtonText',
      'messageLimitsBotButtonUrl',
      'banDurationHours',
    ],
  },
  night: {
    basic: [
      'nightModeEnabled',
      'nightModeStartTimeMinutes',
      'nightModeEndTimeMinutes',
      'nightModeTimezone',
    ],
    advanced: [
      'nightModeBotMessageEnabled',
      'nightModeBotMessageText',
      'nightModeBotButtonEnabled',
      'nightModeBotButtonText',
      'nightModeBotButtonUrl',
    ],
  },
  extra: {
    basic: [
      'globalCrossChatSpamEnabled',
      'deleteBotMessagesEnabled',
      'deleteBotMessagesDelayMinutes',
      'removeBotsFromGroupEnabled',
      'globalUserBlacklistEnabled',
    ],
    advanced: [],
  },
};

const DEFAULT_BROADCAST_DRAFT: PrivateBroadcastDraft = {
  text: '',
  applyToAllChats: false,
  buttonEnabled: false,
  buttonUrl: '',
  buttonText: 'Открыть',
  imageEnabled: false,
  imageBase64: '',
  imageMimeType: '',
  imageFileName: '',
  sendAt: null,
  cycleEnabled: false,
  cycleEveryHours: 24,
  cycleCount: 1,
};

const DEFAULT_POLL_DRAFT: PrivatePollDraft = {
  question: '',
  options: Array.from({ length: MANAGED_POLL_MIN_OPTIONS }, () => ''),
};

@Injectable()
export class PrivateControlService {
  private readonly logger = new Logger(PrivateControlService.name);
  private readonly appBaseUrl: string | null;
  private readonly botDeepLinkId: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly ownBotUserIdVariants: Set<string>;
  private readonly memorySession = new Map<
    string,
    { expiresAt: number; session: PrivateSession }
  >();

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly adminService: AdminService,
    private readonly managedGiveawayService: ManagedGiveawayService,
    @Optional() private readonly redisCounter?: RedisCounterService,
    @Optional() configService?: ConfigService,
  ) {
    this.appBaseUrl = this.normalizeAppBaseUrl(configService?.get<string>('APP_BASE_URL'));
    this.botDeepLinkId = this.normalizeBotDeepLinkId(configService?.get<string>('MAX_BOT_ID'));
    this.explicitBotContactId = this.normalizeBotContactId(
      configService?.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.ownBotUserId = this.normalizeOwnBotUserId(configService?.get<string>('MAX_BOT_ID'));
    this.ownBotUserIdVariants = this.buildBotIdVariants(this.ownBotUserId);
  }

  async handleUpdate(update: MaxUpdate): Promise<void> {
    const context = this.resolveContext(update);
    if (!context) {
      return;
    }

    try {
      if (context.callbackPayload) {
        await this.processCallback(context);
        return;
      }

      await this.processTextMessage(context);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: context.chatId,
          userId: context.actor.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Private control flow failed',
      );

      await this.sendImmediate(
        context.chatId,
        'Что-то пошло не так. Попробуйте ещё раз через несколько секунд.',
      );
    }
  }

  async handleBotStarted(update: MaxUpdate): Promise<void> {
    const context = this.resolveContext(update);
    if (!context) {
      return;
    }

    const startPayload = this.extractBotStartedStartPayload(update);
    const claimPayload = this.managedGiveawayService.parseClaimStartPayload(startPayload);
    if (claimPayload) {
      const claimContext = await this.managedGiveawayService.getGiveawayClaimContext(
        claimPayload.giveawayId,
        claimPayload.winnerId,
        context.actor.userId,
      );
      const view = claimContext
        ? this.renderGiveawayClaimView(claimContext)
        : this.renderUnavailableGiveawayClaimView();
      const session = await this.loadSession(context.actor.userId);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    const session = await this.loadSession(context.actor.userId);
    session.screen =
      session.selectedChatId === null
        ? 'chat_select'
        : session.screen === 'chat_select'
          ? this.resolvePrimaryScreen(session)
          : session.screen;
    if (session.pendingInput?.kind !== 'broadcast_content') {
      session.pendingInput = null;
    }
    session.pendingMassAction = null;

    const view = await this.renderByCurrentScreen(context, session);

    await this.respond(context, session, view, {
      callbackId: null,
      notification: null,
    });
  }

  async handoffBroadcastFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
    } else {
      await this.adminService.getSettings(sourceChatId, user);
    }

    const parsed = broadcastHandoffRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const session = await this.loadSession(user.userId);
    session.selectedChatId = sourceChatId;
    session.selectedEntityType = entityType;
    session.managedGiveawayId = null;
    session.entityTab = entityType;
    session.uiMode = 'modern';
    session.screen = 'broadcast';
    session.section = null;
    session.channelSection = null;
    session.searchQuery = null;
    session.broadcastView = 'advanced';
    session.pendingMassAction = null;
    session.pendingInput = { kind: 'broadcast_content' };
    session.broadcastDraft = {
      ...DEFAULT_BROADCAST_DRAFT,
      applyToAllChats: entityType === 'channel' ? false : parsed.data.applyToAllChats,
      buttonEnabled: parsed.data.buttonEnabled,
      buttonUrl: parsed.data.buttonEnabled ? parsed.data.buttonUrl.trim() : '',
      buttonText: parsed.data.buttonEnabled
        ? parsed.data.buttonText.trim() || 'Открыть'
        : DEFAULT_BROADCAST_DRAFT.buttonText,
      sendAt: entityType === 'channel' ? null : parsed.data.sendAt,
      cycleEnabled: entityType === 'channel' ? false : parsed.data.cycleEnabled,
      cycleEveryHours:
        entityType === 'channel' || !parsed.data.cycleEnabled ? 24 : parsed.data.cycleEveryHours,
      cycleCount: entityType === 'channel' || !parsed.data.cycleEnabled ? 1 : parsed.data.cycleCount,
    };

    await this.saveSession(user.userId, session);

    const botUrl = this.buildBotStartUrl(BROADCAST_HANDOFF_START_PAYLOAD);
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  async handoffGiveawayFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
    } else {
      await this.adminService.getSettings(sourceChatId, user);
    }

    const parsed = managedGiveawayHandoffRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    if (parsed.data.giveawayId) {
      await this.managedGiveawayService.getManagedGiveaway(
        sourceChatId,
        parsed.data.giveawayId,
        user,
        entityType,
      );
    }

    const session = await this.loadSession(user.userId);
    session.selectedChatId = sourceChatId;
    session.selectedEntityType = entityType;
    session.managedGiveawayId = parsed.data.giveawayId;
    session.entityTab = entityType;
    session.uiMode = 'modern';
    session.screen = 'giveaway';
    session.section = null;
    session.channelSection = null;
    session.searchQuery = null;
    session.pendingMassAction = null;
    session.pendingInput = null;
    session.lastScreenStack = [];

    await this.saveSession(user.userId, session);

    const botUrl = this.buildBotStartUrl(GIVEAWAY_HANDOFF_START_PAYLOAD);
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  private async processTextMessage(context: PrivateContext): Promise<void> {
    const session = await this.loadSession(context.actor.userId);
    const normalizedCommand = this.normalizeCommand(context.text);

    if (normalizedCommand === '/reset') {
      const resetSession = this.createDefaultSession();
      const view = await this.renderChatSelection(context, resetSession);
      await this.respond(context, resetSession, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (session.pendingInput) {
      await this.processPendingInput(context, session);
      return;
    }

    if (normalizedCommand === '/help') {
      const view = this.renderHelpView();
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (normalizedCommand === '/legacy') {
      session.uiMode = 'modern';
      session.screen = session.selectedChatId ? this.resolvePrimaryScreen(session) : 'chat_select';
      session.section = null;
      session.channelSection = null;
      session.pendingInput = null;
      session.pendingMassAction = null;
      session.lastScreenStack = [];
      const view = session.selectedChatId
        ? await this.renderPrimaryScreen(context, session)
        : await this.renderChatSelection(context, session);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (normalizedCommand === '/modern') {
      session.uiMode = 'modern';
      session.screen = session.selectedChatId ? this.resolvePrimaryScreen(session) : 'chat_select';
      session.section = null;
      session.channelSection = null;
      session.pendingInput = null;
      session.pendingMassAction = null;
      session.lastScreenStack = [];
      const view = session.selectedChatId
        ? await this.renderPrimaryScreen(context, session)
        : await this.renderChatSelection(context, session);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (normalizedCommand === '/chats') {
      session.entityTab = 'chat';
      session.screen = 'chat_select';
      session.chatPage = 1;
      session.pendingInput = null;
      session.pendingMassAction = null;
      const view = await this.renderChatSelection(context, session);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (normalizedCommand === '/channels') {
      session.entityTab = 'channel';
      session.screen = 'chat_select';
      session.chatPage = 1;
      session.pendingInput = null;
      session.pendingMassAction = null;
      const view = await this.renderChatSelection(context, session);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (normalizedCommand === '/menu' || normalizedCommand === '/start') {
      const view = session.selectedChatId
        ? await this.renderPrimaryScreen(context, session)
        : await this.renderChatSelection(context, session);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (context.text.trim().startsWith('/')) {
      const view = this.renderHelpView('Не понял команду. Нажмите кнопку ниже.');
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (
      session.screen === 'broadcast' &&
      session.selectedChatId &&
      (context.text.trim().length > 0 ||
        this.extractFirstImageAttachment(context.update) !== null ||
        this.hasVideoAttachment(context.update))
    ) {
      await this.captureBroadcastContent(context, session, context.text);
      const view = await this.renderBroadcastScreen(context, session, 'Контент сохранён.');
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    const view = session.selectedChatId
      ? await this.renderPrimaryScreen(context, session)
      : await this.renderChatSelection(context, session);

    await this.respond(context, session, view, {
      callbackId: null,
      notification: null,
    });
  }

  private async processCallback(context: PrivateContext): Promise<void> {
    const callback = this.parseCallbackAction(context.callbackPayload);
    const session = await this.loadSession(context.actor.userId);

    if (!callback) {
      const view = session.selectedChatId
        ? await this.renderPrimaryScreen(context, session)
        : await this.renderChatSelection(context, session);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: this.isStaleLegacyCallbackPayload(context.callbackPayload)
          ? CALLBACK_STALE_NOTIFICATION
          : CALLBACK_REFRESH_NOTIFICATION,
      });
      return;
    }

    if (callback.action === 'giveaway_claim_confirm') {
      const giveawayId = callback.args[0] ?? '';
      const winnerId = callback.args[1] ?? '';
      if (!giveawayId || !winnerId) {
        throw new BadRequestException('Не удалось определить claim.');
      }

      const currentClaim = await this.managedGiveawayService.getGiveawayClaimContext(
        giveawayId,
        winnerId,
        context.actor.userId,
      );
      if (!currentClaim) {
        const view = this.renderUnavailableGiveawayClaimView();
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Claim уже недоступен',
        });
        return;
      }

      await this.managedGiveawayService.claimGiveaway(giveawayId, context.actor, 'private_claim');
      const refreshedClaim =
        (await this.managedGiveawayService.getGiveawayClaimContext(
          giveawayId,
          winnerId,
          context.actor.userId,
        )) ?? currentClaim;
      const view = this.renderGiveawayClaimView(refreshedClaim, 'Приз подтверждён.');
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Claim подтверждён',
      });
      return;
    }

    if (
      session.pendingMassAction &&
      !['mass_cancel', 'mass_confirm', 'main', 'home', 'help'].includes(callback.action)
    ) {
      const view = this.renderMassActionConfirmation(session.pendingMassAction);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Сначала подтвердите или отмените действие',
      });
      return;
    }

    if (
      session.pendingInput &&
      session.pendingInput.kind !== 'broadcast_content' &&
      callback.action !== 'input_cancel'
    ) {
      const view = this.renderInputPrompt(session.pendingInput);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Сначала завершите ввод или нажмите «Отмена»',
      });
      return;
    }

    if (CHAT_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.assertSelectedEntityType(session, 'chat');
    }

    if (CHANNEL_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.assertSelectedEntityType(session, 'channel');
    }

    if (ENTITY_CALLBACK_ACTIONS.has(callback.action) && !session.selectedChatId) {
      throw new BadRequestException('Сначала выберите чат или канал.');
    }

    switch (callback.action) {
      case 'home': {
        session.uiMode = 'modern';
        session.pendingInput = null;
        session.pendingMassAction = null;
        session.managedGiveawayId = null;
        session.section = null;
        session.channelSection = null;
        session.searchQuery = null;
        session.lastScreenStack = [];
        session.screen = this.resolvePrimaryScreen(session);
        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Главный экран',
        });
        return;
      }

      case 'home_tab': {
        const tab = callback.args[0] === 'all' ? 'all' : 'quick';
        const view =
          tab === 'all'
            ? await this.renderSettingsHubScreen(context, {
                ...session,
                screen: 'settings_hub',
              })
            : await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: tab === 'all' ? 'Разделы настроек' : 'Главный экран',
        });
        return;
      }

      case 'back': {
        const restored = this.restoreFromHistory(session);
        const view = restored
          ? await this.renderByCurrentScreen(context, session)
          : await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Назад',
        });
        return;
      }

      case 'help': {
        const view = this.renderHelpView();
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю помощь',
        });
        return;
      }

      case 'chat_page': {
        const requestedPage = this.toPositiveInt(callback.args[0], 1);
        session.chatPage = requestedPage;
        session.screen = 'chat_select';
        const view = await this.renderChatSelection(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification:
            session.entityTab === 'channel' ? 'Показываю список каналов' : 'Показываю список чатов',
        });
        return;
      }

      case 'entity_tab': {
        const requestedTab = callback.args[0] === 'channel' ? 'channel' : 'chat';
        session.entityTab = requestedTab;
        session.chatPage = 1;
        session.screen = 'chat_select';
        const view = await this.renderChatSelection(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: requestedTab === 'channel' ? 'Показываю каналы' : 'Показываю чаты',
        });
        return;
      }

      case 'chat_select': {
        const hasExplicitType = callback.args.length >= 2;
        const selectedEntityType: ManagedEntityType =
          hasExplicitType && callback.args[0] === 'channel' ? 'channel' : 'chat';
        const chatId = hasExplicitType ? (callback.args[1] ?? '') : (callback.args[0] ?? '');
        if (!chatId) {
          throw new BadRequestException('chatId is required');
        }

        session.selectedChatId = chatId;
        session.selectedEntityType = selectedEntityType;
        session.managedGiveawayId = null;
        session.entityTab = selectedEntityType;
        session.screen = this.resolvePrimaryScreen(session);
        session.section = null;
        session.channelSection = null;
        session.pendingInput = null;
        session.pendingMassAction = null;
        session.searchQuery = null;
        session.homeTab = 'quick';
        session.sectionView = 'basic';
        session.lastScreenStack = [];
        session.eventsPage = 1;
        session.domainPage = 1;
        session.manualPage = 1;
        session.manualTargetUserId = null;
        session.pollDraft = {
          ...DEFAULT_POLL_DRAFT,
          options: [...DEFAULT_POLL_DRAFT.options],
        };

        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: selectedEntityType === 'channel' ? 'Канал выбран' : 'Чат выбран',
        });
        return;
      }

      case 'change_chat': {
        session.screen = 'chat_select';
        session.managedGiveawayId = null;
        session.chatPage = 1;
        session.pendingInput = null;
        session.pendingMassAction = null;
        session.searchQuery = null;
        session.channelSection = null;
        session.lastScreenStack = [];
        session.pollDraft = {
          ...DEFAULT_POLL_DRAFT,
          options: [...DEFAULT_POLL_DRAFT.options],
        };
        const view = await this.renderChatSelection(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: session.entityTab === 'channel' ? 'Выберите канал' : 'Выберите чат',
        });
        return;
      }

      case 'main': {
        session.screen = this.resolvePrimaryScreen(session);
        session.section = null;
        session.channelSection = null;
        session.pendingInput = null;
        session.pendingMassAction = null;
        session.sectionView = 'basic';
        session.searchQuery = null;
        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Главный экран',
        });
        return;
      }

      case 'open_settings_hub': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'settings_hub';
        session.section = null;
        session.channelSection = null;
        session.pendingInput = null;
        session.pendingMassAction = null;
        const view = await this.renderSettingsHubScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Разделы настроек',
        });
        return;
      }

      case 'open_channel_section': {
        const section = this.parseChannelSection(callback.args[0]);
        if (!section) {
          throw new BadRequestException('Unknown channel section');
        }

        this.assertSelectedEntityType(session, 'channel');
        this.pushHistory(session);
        session.screen = 'channel_section';
        session.channelSection = section;
        session.section = null;
        session.pendingInput = null;
        session.pendingMassAction = null;

        const view = await this.renderChannelSectionScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: CHANNEL_SECTION_LABELS[section],
        });
        return;
      }

      case 'toggle_channel': {
        const section = this.parseChannelSection(callback.args[0]);
        const key = callback.args[1] as keyof ChannelSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Unknown channel setting toggle');
        }

        this.assertSelectedEntityType(session, 'channel');
        const config = this.findChannelFieldConfig(section, key);
        if (!config || config.type !== 'boolean') {
          throw new BadRequestException('Setting is not toggle');
        }

        const current = await this.adminService.getChannelSettings(
          session.selectedChatId!,
          context.actor,
        );
        const nextValue = !Boolean(current[key] as boolean);
        await this.updateSingleChannelSetting(
          session.selectedChatId!,
          context.actor,
          key,
          nextValue,
        );

        const view = await this.renderChannelSectionScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${nextValue ? 'включено' : 'выключено'}`,
        });
        return;
      }

      case 'set_channel_input': {
        const section = this.parseChannelSection(callback.args[0]);
        const key = callback.args[1] as keyof ChannelSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Input payload is invalid');
        }

        this.assertSelectedEntityType(session, 'channel');
        const config = this.findChannelFieldConfig(section, key);
        if (!config || config.type === 'boolean' || config.type === 'enum') {
          throw new BadRequestException('Setting does not support text input');
        }

        session.pendingInput = {
          kind: 'set_channel_field',
          section,
          key,
          type: config.type,
          min: config.min,
          max: config.max,
        };

        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `Жду значение: ${config.label}`,
        });
        return;
      }

      case 'publish_channel_engagement': {
        this.assertSelectedEntityType(session, 'channel');
        const chatId = session.selectedChatId;
        if (!chatId) {
          throw new BadRequestException('Channel is not selected');
        }
        const settings = await this.adminService.getChannelSettings(chatId, context.actor);
        const includeCommentsButton =
          settings.autoPostButtonsMode === 'COMMENTS' || settings.autoPostButtonsMode === 'BOTH'
            ? true
            : settings.autoPostButtonsMode === 'OFF'
              ? settings.commentsEnabled
              : false;
        const includeSuggestButton = true;

        await this.adminService.publishChannelEngagementMessage(chatId, context.actor, {
          text:
            settings.engagementMessageText.trim() ||
            'Есть идея или обратная связь? Нажмите кнопку ниже.',
          commentsButtonText: '💬 Комментарии',
          suggestButtonText: settings.postSuggestionsButtonText.trim() || '📰 Предложить пост',
          includeCommentsButton,
          includeSuggestButton,
        });

        const view = await this.renderChannelHomeScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Пост с кнопками опубликован',
        });
        return;
      }

      case 'open_section': {
        const section = this.parseSection(callback.args[0]);
        if (!section) {
          throw new BadRequestException('Unknown section');
        }

        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'section';
        session.section = section;
        session.channelSection = null;
        session.sectionView = 'basic';
        session.pendingInput = null;
        session.pendingMassAction = null;

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: SECTION_LABELS[section],
        });
        return;
      }

      case 'toggle': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Unknown setting toggle');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (!config || config.type !== 'boolean') {
          throw new BadRequestException('Setting is not toggle');
        }

        const current = await this.adminService.getSettings(session.selectedChatId!, context.actor);
        const nextValue = !Boolean(current[key] as boolean);
        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, nextValue);

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${nextValue ? 'включено' : 'выключено'}`,
        });
        return;
      }

      case 'set_enum': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        const value = callback.args[2] ?? '';
        if (!section || !key || !value) {
          throw new BadRequestException('Enum payload is invalid');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (!config || config.type !== 'enum' || !config.enumValues?.includes(value)) {
          throw new BadRequestException('Unknown enum value');
        }

        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, value);
        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${value}`,
        });
        return;
      }

      case 'set_number_preset': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        const rawValue = callback.args[2] ?? '';
        if (!section || !key) {
          throw new BadRequestException('Number preset payload is invalid');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (!config || config.type !== 'number') {
          throw new BadRequestException('Setting does not support presets');
        }

        const nextValue = this.parseIntInput(rawValue, config.min ?? 0, config.max ?? 1_000_000);
        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, nextValue);

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${nextValue}`,
        });
        return;
      }

      case 'step_number': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        const rawDelta = callback.args[2] ?? '';
        if (!section || !key) {
          throw new BadRequestException('Number step payload is invalid');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (!config || config.type !== 'number') {
          throw new BadRequestException('Setting does not support stepper');
        }

        const delta = Number.parseInt(rawDelta, 10);
        if (!Number.isFinite(delta) || Number.isNaN(delta)) {
          throw new BadRequestException('Delta is invalid');
        }

        const current = await this.adminService.getSettings(session.selectedChatId!, context.actor);
        const currentValue = Number(current[key] ?? 0);
        const bounded = Math.max(
          config.min ?? Number.MIN_SAFE_INTEGER,
          Math.min(config.max ?? Number.MAX_SAFE_INTEGER, currentValue + delta),
        );
        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, bounded);

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${bounded}`,
        });
        return;
      }

      case 'set_input': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Input payload is invalid');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (
          !config ||
          config.type === 'boolean' ||
          config.type === 'enum' ||
          config.type === 'number'
        ) {
          throw new BadRequestException('Setting does not support text input');
        }

        session.pendingInput = {
          kind: 'set_field',
          section,
          key,
          type: config.type,
          min: config.min,
          max: config.max,
        };

        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `Жду значение: ${config.label}`,
        });
        return;
      }

      case 'section_view': {
        const section = this.parseSection(callback.args[0]);
        const requestedView = callback.args[1] === 'advanced' ? 'advanced' : 'basic';
        if (!section) {
          throw new BadRequestException('Section is required');
        }

        this.assertChatSelected(session);
        session.section = section;
        session.screen = 'section';
        session.sectionView = requestedView;
        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: requestedView === 'advanced' ? 'Ещё параметры' : 'Основное',
        });
        return;
      }

      case 'open_search': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.pendingInput = { kind: 'search_settings' };
        session.screen = 'search';
        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Найти настройку',
        });
        return;
      }

      case 'search_jump': {
        this.assertChatSelected(session);
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Jump payload is invalid');
        }

        this.pushHistory(session);
        session.section = section;
        session.screen = 'section';
        session.sectionView = this.resolveSectionViewForField(section, key);
        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открыт параметр',
        });
        return;
      }

      case 'apply_section_preview': {
        const section = this.parseSection(callback.args[0]);
        if (!section) {
          throw new BadRequestException('Section is required');
        }

        this.assertChatSelected(session);
        const availableChats = await this.adminService.listChats(context.actor);
        const targetChats = Array.from(
          new Set([session.selectedChatId!, ...availableChats.map((chat) => chat.id)]),
        ).length;

        session.pendingMassAction = {
          kind: 'apply_section',
          section,
          targetChats,
        };

        const view = this.renderMassActionConfirmation(session.pendingMassAction);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Показываю подтверждение',
        });
        return;
      }

      case 'mass_cancel': {
        const pendingMassAction = session.pendingMassAction;
        session.pendingMassAction = null;

        if (session.section) {
          const view = await this.renderSectionCardScreen(context, session, session.section);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Массовое действие отменено',
          });
          return;
        }

        if (pendingMassAction?.kind === 'broadcast') {
          const view = await this.renderBroadcastScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Рассылка отменена',
          });
          return;
        }

        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Отменено',
        });
        return;
      }

      case 'mass_confirm': {
        this.assertChatSelected(session);

        if (!session.pendingMassAction) {
          const view = await this.renderPrimaryScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: CALLBACK_REFRESH_NOTIFICATION,
          });
          return;
        }

        if (session.pendingMassAction.kind === 'apply_section') {
          const section = session.pendingMassAction.section;
          const settings = await this.adminService.getSettings(
            session.selectedChatId!,
            context.actor,
          );
          const result = await this.adminService.applySettingsToAllChats(
            session.selectedChatId!,
            context.actor,
            settings,
            'private_bot',
            SECTION_SETTING_KEYS[section],
          );

          session.pendingMassAction = null;
          const view = await this.renderSectionCardScreen(context, session, section);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: `Готово: применено в ${result.updatedChats} чатах`,
          });
          return;
        }

        if (session.pendingMassAction.kind === 'broadcast') {
          const sendResult = await this.sendBroadcastFromSession(context, session);
          session.pendingMassAction = null;
          const view = await this.renderBroadcastScreen(
            context,
            session,
            `Рассылка: отправлено ${sendResult.sentChats}/${sendResult.targetChats}, ошибок: ${sendResult.failedChats}.`,
          );
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Рассылка отправлена',
          });
          return;
        }

        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: CALLBACK_REFRESH_NOTIFICATION,
        });
        return;
      }

      case 'open_domains': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'domains';
        session.domainPage = 1;
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Разрешённые домены',
        });
        return;
      }

      case 'domains_page': {
        this.assertChatSelected(session);
        session.screen = 'domains';
        session.domainPage = this.toPositiveInt(callback.args[0], 1);
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Страница доменов',
        });
        return;
      }

      case 'domain_add_prompt': {
        this.assertChatSelected(session);
        session.pendingInput = { kind: 'add_domain' };
        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду ссылку или домен',
        });
        return;
      }

      case 'domain_remove': {
        this.assertChatSelected(session);
        const index = this.toPositiveInt(callback.args[0], 1) - 1;
        const domains = await this.adminService.getDomainAllowlistDetails(
          session.selectedChatId!,
          context.actor,
        );
        if (!domains[index]) {
          throw new BadRequestException('Домен не найден в списке');
        }

        await this.adminService.removeDomain(
          session.selectedChatId!,
          context.actor,
          domains[index].domain,
          'private_bot',
        );

        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `Удалён домен: ${domains[index].domain}`,
        });
        return;
      }

      case 'domain_schedule_prompt': {
        this.assertChatSelected(session);
        const index = this.toPositiveInt(callback.args[0], 1) - 1;
        const domains = await this.adminService.getDomainAllowlistDetails(
          session.selectedChatId!,
          context.actor,
        );
        if (!domains[index]) {
          throw new BadRequestException('Домен не найден в списке');
        }

        session.pendingInput = {
          kind: 'schedule_domain',
          domain: domains[index].domain,
        };

        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду дату удаления',
        });
        return;
      }

      case 'open_blacklist': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'global_blacklist';
        const view = await this.renderGlobalBlacklistScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Глобальный чёрный список',
        });
        return;
      }

      case 'blacklist_add_prompt': {
        this.assertChatSelected(session);
        session.pendingInput = { kind: 'add_blacklist_user' };
        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду user_id',
        });
        return;
      }

      case 'blacklist_remove_prompt': {
        this.assertChatSelected(session);
        session.pendingInput = { kind: 'remove_blacklist_user' };
        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду user_id',
        });
        return;
      }

      case 'blacklist_remove': {
        this.assertChatSelected(session);
        const index = this.toPositiveInt(callback.args[0], 1) - 1;
        const entries = await this.adminService.getGlobalUserBlacklist(
          session.selectedChatId!,
          context.actor,
        );
        if (!entries[index]) {
          throw new BadRequestException('Пользователь не найден в списке');
        }

        await this.adminService.removeGlobalUserBlacklistUser(
          session.selectedChatId!,
          context.actor,
          entries[index].userId,
          'private_bot',
        );

        const view = await this.renderGlobalBlacklistScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `Удалён из ЧС: ${entries[index].userId}`,
        });
        return;
      }

      case 'open_broadcast': {
        if (!session.selectedChatId) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }
        this.pushHistory(session);
        session.screen = 'broadcast';
        session.broadcastView = 'basic';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю рассылку',
        });
        return;
      }

      case 'open_giveaway': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        this.pushHistory(session);
        session.screen = 'giveaway';
        session.managedGiveawayId = null;
        const view = await this.renderGiveawayScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю розыгрыши',
        });
        return;
      }

      case 'refresh_giveaway': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Экран обновлён',
        });
        return;
      }

      case 'giveaway_create': {
        this.assertSelectedEntityType(
          session,
          (session.selectedEntityType ?? 'chat') as ManagedEntityType,
        );

        const existing = await this.managedGiveawayService.getCurrentManagedGiveawayForEntity(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
        );
        const created =
          existing ??
          (await this.createManagedGiveawayDraftForSession(
            session.selectedChatId,
            context.actor,
            session.selectedEntityType,
          ));
        session.screen = 'giveaway';
        session.managedGiveawayId = created.id;
        const view = await this.renderGiveawayScreen(
          context,
          session,
          existing ? 'Открыт текущий черновик.' : 'Черновик создан.',
        );
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: existing ? 'Открываю черновик' : 'Черновик создан',
        });
        return;
      }

      case 'giveaway_input_prompt': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        session.managedGiveawayId = draft.id;

        const field = callback.args[0] ?? '';
        if (field === 'title') {
          session.pendingInput = { kind: 'giveaway_title' };
        } else if (field === 'description') {
          session.pendingInput = { kind: 'giveaway_description' };
        } else if (field === 'start_at') {
          session.pendingInput = { kind: 'giveaway_start_at' };
        } else if (field === 'end_at') {
          session.pendingInput = { kind: 'giveaway_end_at' };
        } else if (field === 'claim_hours') {
          session.pendingInput = { kind: 'giveaway_claim_hours' };
        } else if (field === 'photo') {
          session.pendingInput = { kind: 'giveaway_photo' };
        } else if (field === 'prize') {
          const position = Number.parseInt(callback.args[1] ?? '', 10);
          if (!Number.isInteger(position) || position < 1 || position > draft.prizes.length) {
            throw new BadRequestException('Не удалось определить призовое место.');
          }
          session.pendingInput = { kind: 'giveaway_prize', index: position - 1 };
        } else {
          throw new BadRequestException('Не удалось определить поле розыгрыша.');
        }

        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду ввод',
        });
        return;
      }

      case 'giveaway_clear_start': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.startsAt = null;
          },
        );
        session.managedGiveawayId = saved.id;
        const view = await this.renderGiveawayScreen(context, session, 'Старт убран.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Старт очищен',
        });
        return;
      }

      case 'giveaway_clear_photo': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.imageEnabled = false;
            nextDraft.imageBase64 = '';
            nextDraft.imageMimeType = '';
            nextDraft.imageFileName = '';
          },
        );
        session.managedGiveawayId = saved.id;
        const view = await this.renderGiveawayScreen(context, session, 'Фото убрано.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Фото удалено',
        });
        return;
      }

      case 'giveaway_add_prize': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        if (draft.prizes.length >= MANAGED_GIVEAWAY_MAX_PRIZES) {
          throw new BadRequestException(`Можно добавить не больше ${MANAGED_GIVEAWAY_MAX_PRIZES} мест.`);
        }

        session.managedGiveawayId = draft.id;
        session.pendingInput = { kind: 'giveaway_prize', index: draft.prizes.length };
        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Введите название приза',
        });
        return;
      }

      case 'giveaway_remove_last_prize': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        if (draft.prizes.length <= 1) {
          throw new BadRequestException('Нужно оставить хотя бы одно призовое место.');
        }

        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.prizes = nextDraft.prizes
              .slice(0, -1)
              .map((prize, index) => ({ ...prize, position: index + 1 }));
          },
        );
        session.managedGiveawayId = saved.id;
        const view = await this.renderGiveawayScreen(context, session, 'Последнее место удалено.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Место удалено',
        });
        return;
      }

      case 'giveaway_publish': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (!giveaway || giveaway.status !== 'DRAFT') {
          throw new BadRequestException('Черновик розыгрыша не найден.');
        }

        await this.managedGiveawayService.publishManagedGiveaway(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        const view = await this.renderGiveawayScreen(context, session, 'Розыгрыш опубликован.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Опубликовано',
        });
        return;
      }

      case 'giveaway_close': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (!giveaway || (giveaway.status !== 'ACTIVE' && giveaway.status !== 'SCHEDULED')) {
          throw new BadRequestException('Нет активного розыгрыша для завершения.');
        }

        await this.managedGiveawayService.closeManagedGiveaway(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        const view = await this.renderGiveawayScreen(context, session, 'Итоги опубликованы.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Розыгрыш завершён',
        });
        return;
      }

      case 'giveaway_cancel': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (
          !giveaway ||
          (giveaway.status !== 'DRAFT' &&
            giveaway.status !== 'ACTIVE' &&
            giveaway.status !== 'SCHEDULED')
        ) {
          throw new BadRequestException('Нет розыгрыша, который можно отменить.');
        }

        await this.managedGiveawayService.cancelManagedGiveaway(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        const view = await this.renderGiveawayScreen(context, session, 'Розыгрыш отменён.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Розыгрыш отменён',
        });
        return;
      }

      case 'giveaway_reroll': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const winnerId = callback.args[0]?.trim();
        if (!winnerId) {
          throw new BadRequestException('Не удалось определить победителя для реролла.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (!giveaway) {
          throw new BadRequestException('Розыгрыш не найден.');
        }

        await this.managedGiveawayService.rerollManagedGiveawayWinner(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          { winnerId },
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        const view = await this.renderGiveawayScreen(context, session, 'Победитель перевыбран.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Реролл выполнен',
        });
        return;
      }

      case 'giveaway_deliver': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const winnerId = callback.args[0]?.trim();
        if (!winnerId) {
          throw new BadRequestException('Не удалось определить победителя для выдачи.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (!giveaway) {
          throw new BadRequestException('Розыгрыш не найден.');
        }

        await this.managedGiveawayService.markManagedGiveawayWinnerDelivered(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          { winnerId },
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        const view = await this.renderGiveawayScreen(context, session, 'Выдача подтверждена.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Статус обновлён',
        });
        return;
      }

      case 'broadcast_view': {
        this.assertChatSelected(session);
        session.broadcastView = callback.args[0] === 'advanced' ? 'advanced' : 'basic';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: session.broadcastView === 'advanced' ? 'Ещё параметры' : 'Основное',
        });
        return;
      }

      case 'broadcast_toggle': {
        this.assertChatSelected(session);
        this.toggleBroadcastFlag(session, callback.args[0] ?? '');
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Настройка обновлена',
        });
        return;
      }

      case 'broadcast_input_prompt': {
        this.assertChatSelected(session);
        const pendingInput = this.buildBroadcastPendingInput(callback.args[0] ?? '');
        if (!pendingInput) {
          throw new BadRequestException('Неизвестный шаг настройки');
        }

        session.pendingInput = pendingInput;
        const view = this.renderInputPrompt(pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду ввод',
        });
        return;
      }

      case 'broadcast_clear_timer': {
        this.assertChatSelected(session);
        session.broadcastDraft.sendAt = null;
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Таймер выключен',
        });
        return;
      }

      case 'broadcast_clear_photo': {
        this.assertChatSelected(session);
        session.broadcastDraft.imageEnabled = false;
        session.broadcastDraft.imageBase64 = '';
        session.broadcastDraft.imageMimeType = '';
        session.broadcastDraft.imageFileName = '';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Фото удалено',
        });
        return;
      }

      case 'broadcast_send': {
        this.assertChatSelected(session);
        const hasContent =
          session.broadcastDraft.text.trim().length > 0 || session.broadcastDraft.imageEnabled;
        if (!hasContent) {
          session.pendingInput = { kind: 'broadcast_content' };
          const view = this.renderInputPrompt(session.pendingInput);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Сначала пришлите контент',
          });
          return;
        }

        if (session.selectedEntityType !== 'channel' && session.broadcastDraft.applyToAllChats) {
          const availableChats = await this.adminService.listChats(context.actor);
          const targetChats = Array.from(
            new Set([session.selectedChatId!, ...availableChats.map((chat) => chat.id)]),
          ).length;
          session.pendingMassAction = {
            kind: 'broadcast',
            targetChats,
          };
          const view = this.renderMassActionConfirmation(session.pendingMassAction);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Нужно подтверждение',
          });
          return;
        }

        const result = await this.sendBroadcastFromSession(context, session);
        const view = await this.renderBroadcastScreen(
          context,
          session,
          `Рассылка: отправлено ${result.sentChats}/${result.targetChats}, ошибок: ${result.failedChats}.`,
        );
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Рассылка отправлена',
        });
        return;
      }

      case 'open_poll': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        this.pushHistory(session);
        const poll = await this.getManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
        );
        session.pollDraft = this.toPrivatePollDraft(poll);
        session.screen = 'poll';
        session.pendingInput = null;
        session.pendingMassAction = null;
        const view = await this.renderPollScreen(context, session, null, poll);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю опрос',
        });
        return;
      }

      case 'poll_input_prompt': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const poll = await this.getManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
        );
        session.pollDraft = this.toPrivatePollDraft(poll);
        if (poll.status === 'ACTIVE') {
          const view = await this.renderPollScreen(context, session, null, poll);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Сначала закройте активный опрос',
          });
          return;
        }

        const field = callback.args[0] ?? '';
        if (field === 'question') {
          session.pendingInput = { kind: 'poll_question' };
        } else if (field === 'option') {
          const index = this.toPositiveInt(callback.args[1], 1) - 1;
          if (index < 0 || index >= session.pollDraft.options.length) {
            throw new BadRequestException('Вариант не найден.');
          }
          session.pendingInput = { kind: 'poll_option', index };
        } else {
          throw new BadRequestException('Неизвестное поле опроса.');
        }

        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду ввод',
        });
        return;
      }

      case 'poll_add_option': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const poll = await this.getManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
        );
        session.pollDraft = this.toPrivatePollDraft(poll);
        if (poll.status === 'ACTIVE') {
          const view = await this.renderPollScreen(context, session, null, poll);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Сначала закройте активный опрос',
          });
          return;
        }

        if (session.pollDraft.options.length >= MANAGED_POLL_MAX_OPTIONS) {
          const view = await this.renderPollScreen(context, session, null, poll);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: `Максимум ${MANAGED_POLL_MAX_OPTIONS} вариантов`,
          });
          return;
        }

        const saved = await this.updateManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          {
            question: session.pollDraft.question,
            options: [...session.pollDraft.options, ''],
          },
        );
        session.pollDraft = this.toPrivatePollDraft(saved);
        session.screen = 'poll';
        const view = await this.renderPollScreen(context, session, null, saved);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Вариант добавлен',
        });
        return;
      }

      case 'poll_remove_option': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const poll = await this.getManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
        );
        session.pollDraft = this.toPrivatePollDraft(poll);
        if (poll.status === 'ACTIVE') {
          const view = await this.renderPollScreen(context, session, null, poll);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Сначала закройте активный опрос',
          });
          return;
        }

        if (session.pollDraft.options.length <= MANAGED_POLL_MIN_OPTIONS) {
          const view = await this.renderPollScreen(context, session, null, poll);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: `Минимум ${MANAGED_POLL_MIN_OPTIONS} варианта`,
          });
          return;
        }

        const index = this.toPositiveInt(callback.args[0], 1) - 1;
        if (index < 0 || index >= session.pollDraft.options.length) {
          throw new BadRequestException('Вариант не найден.');
        }

        const nextOptions = session.pollDraft.options.filter((_, itemIndex) => itemIndex !== index);
        const saved = await this.updateManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          {
            question: session.pollDraft.question,
            options: nextOptions,
          },
        );
        session.pollDraft = this.toPrivatePollDraft(saved);
        session.screen = 'poll';
        const view = await this.renderPollScreen(context, session, null, saved);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Вариант удалён',
        });
        return;
      }

      case 'poll_publish': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const savedDraft = await this.updateManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          {
            question: session.pollDraft.question,
            options: session.pollDraft.options,
          },
        );
        const published = await this.publishManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
        );
        session.pollDraft = this.toPrivatePollDraft(published);
        session.screen = 'poll';
        const view = await this.renderPollScreen(context, session, null, published);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: savedDraft.status === 'ACTIVE' ? 'Опрос уже активен' : 'Опрос опубликован',
        });
        return;
      }

      case 'poll_close': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const closed = await this.closeManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
        );
        session.pollDraft = this.toPrivatePollDraft(closed);
        session.screen = 'poll';
        const view = await this.renderPollScreen(context, session, null, closed);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Опрос закрыт',
        });
        return;
      }

      case 'open_events': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'events';
        session.eventsPage = 1;
        const view = await this.renderEventsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю события',
        });
        return;
      }

      case 'events_page': {
        this.assertChatSelected(session);
        session.screen = 'events';
        session.eventsPage = this.toPositiveInt(callback.args[0], 1);
        const view = await this.renderEventsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Страница событий',
        });
        return;
      }

      case 'open_logs': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'logs';
        const view = await this.renderLogsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю логи',
        });
        return;
      }

      case 'logs_range': {
        this.assertChatSelected(session);
        const range = this.parseLogsRange(callback.args[0]);
        session.screen = 'logs';
        session.logsRange = range;
        const view = await this.renderLogsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `Диапазон: ${range}`,
        });
        return;
      }

      case 'open_manual_users': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'manual_users';
        session.manualPage = 1;
        session.manualTargetUserId = null;
        const view = await this.renderManualUsersScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю ручную модерацию',
        });
        return;
      }

      case 'manual_users_page': {
        this.assertChatSelected(session);
        session.screen = 'manual_users';
        session.manualPage = this.toPositiveInt(callback.args[0], 1);
        const view = await this.renderManualUsersScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Показываю пользователей',
        });
        return;
      }

      case 'manual_select_user': {
        this.assertChatSelected(session);
        const targetUserId = callback.args[0] ?? '';
        if (!targetUserId) {
          throw new BadRequestException('Нужен user_id');
        }

        session.screen = 'manual_actions';
        session.manualTargetUserId = targetUserId;
        const view = this.renderManualActionsScreen(session.manualTargetUserId);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Пользователь выбран',
        });
        return;
      }

      case 'manual_action': {
        this.assertChatSelected(session);
        const action = (callback.args[0] ?? '').toUpperCase();
        const targetUserId = session.manualTargetUserId;
        if (!targetUserId) {
          throw new BadRequestException('Сначала выберите пользователя из списка');
        }

        if (action === 'BAN') {
          session.pendingInput = {
            kind: 'manual_ban_duration',
            targetUserId,
          };
          const view = this.renderInputPrompt(session.pendingInput);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Жду длительность бана',
          });
          return;
        }

        if (action !== 'KICK' && action !== 'UNBAN') {
          throw new BadRequestException('Неизвестное действие');
        }

        const result = await this.adminService.applyManualModerationAction(
          session.selectedChatId!,
          targetUserId,
          context.actor,
          {
            action,
          },
          'private_bot',
        );

        const view = this.renderManualActionsScreen(session.manualTargetUserId, result.message);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Готово',
        });
        return;
      }

      case 'input_cancel': {
        session.pendingInput = null;
        if (session.screen === 'channel_section' && session.channelSection) {
          const view = await this.renderChannelSectionScreen(
            context,
            session,
            session.channelSection,
          );
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'section' && session.section) {
          const view = await this.renderSectionCardScreen(context, session, session.section);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'broadcast') {
          const view = await this.renderBroadcastScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'poll') {
          const view = await this.renderPollScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'giveaway') {
          const view = await this.renderGiveawayScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'domains') {
          const view = await this.renderDomainsScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'global_blacklist') {
          const view = await this.renderGlobalBlacklistScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'manual_actions') {
          const view = this.renderManualActionsScreen(session.manualTargetUserId);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'search') {
          session.searchQuery = null;
          const restored = this.restoreFromHistory(session);
          const view = restored
            ? await this.renderByCurrentScreen(context, session)
            : await this.renderPrimaryScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Отменено',
        });
        return;
      }

      default: {
        const view = session.selectedChatId
          ? await this.renderPrimaryScreen(context, session)
          : await this.renderChatSelection(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: CALLBACK_REFRESH_NOTIFICATION,
        });
      }
    }
  }

  private async processPendingInput(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<void> {
    if (!session.pendingInput) {
      return;
    }

    const rawText = context.text.trim();
    if (rawText.toLowerCase() === '/cancel' || rawText.toLowerCase() === 'отмена') {
      session.pendingInput = null;

      if (session.screen === 'channel_section' && session.channelSection) {
        const view = await this.renderChannelSectionScreen(
          context,
          session,
          session.channelSection,
        );
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'section' && session.section) {
        const view = await this.renderSectionCardScreen(context, session, session.section);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'broadcast') {
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'poll') {
        const view = await this.renderPollScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'giveaway') {
        const view = await this.renderGiveawayScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'domains') {
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'global_blacklist') {
        const view = await this.renderGlobalBlacklistScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'manual_actions') {
        const view = this.renderManualActionsScreen(session.manualTargetUserId);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'search') {
        session.searchQuery = null;
        const restored = this.restoreFromHistory(session);
        const view = restored
          ? await this.renderByCurrentScreen(context, session)
          : await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      const view = await this.renderPrimaryScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    const pendingInput = session.pendingInput;

    switch (pendingInput.kind) {
      case 'search_settings': {
        this.assertSelectedEntityType(session, 'chat');
        const query = rawText.trim();
        if (query.length < 2) {
          throw new BadRequestException('Введите минимум 2 символа для поиска.');
        }

        session.pendingInput = null;
        session.searchQuery = query;
        session.screen = 'search';
        const view = this.renderSearchResultsScreen(query);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'set_field': {
        this.assertSelectedEntityType(session, 'chat');

        const parsedValue = this.parseInputValueByType(
          pendingInput.type,
          pendingInput.min,
          pendingInput.max,
          rawText,
        );
        await this.updateSingleSetting(
          session.selectedChatId!,
          context.actor,
          pendingInput.key,
          parsedValue,
        );

        session.pendingInput = null;
        session.screen = 'section';
        session.section = pendingInput.section;

        const view = await this.renderSectionCardScreen(context, session, pendingInput.section);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'set_channel_field': {
        this.assertSelectedEntityType(session, 'channel');

        const parsedValue = this.parseInputValueByType(
          pendingInput.type,
          pendingInput.min,
          pendingInput.max,
          rawText,
        );
        await this.updateSingleChannelSetting(
          session.selectedChatId!,
          context.actor,
          pendingInput.key,
          parsedValue as ChannelSettings[keyof ChannelSettings],
        );

        session.pendingInput = null;
        session.screen = 'channel_section';
        session.channelSection = pendingInput.section;

        const view = await this.renderChannelSectionScreen(context, session, pendingInput.section);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'add_domain': {
        this.assertChatSelected(session);
        if (!rawText) {
          throw new BadRequestException('Напишите ссылку или домен.');
        }

        await this.adminService.addDomain(
          session.selectedChatId!,
          context.actor,
          {
            domain: rawText,
          },
          'private_bot',
        );

        session.pendingInput = null;
        session.screen = 'domains';
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'schedule_domain': {
        this.assertChatSelected(session);
        const removeAfterAt = this.parseRemovalDateInput(rawText);

        await this.adminService.scheduleDomainRemoval(
          session.selectedChatId!,
          context.actor,
          pendingInput.domain,
          {
            removeAfterAt,
          },
          'private_bot',
        );

        session.pendingInput = null;
        session.screen = 'domains';
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'add_blacklist_user': {
        this.assertChatSelected(session);
        if (!rawText) {
          throw new BadRequestException('Напишите user_id.');
        }

        await this.adminService.addGlobalUserBlacklistUser(
          session.selectedChatId!,
          context.actor,
          {
            userId: rawText,
          },
          'private_bot',
        );

        session.pendingInput = null;
        session.screen = 'global_blacklist';
        const view = await this.renderGlobalBlacklistScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'remove_blacklist_user': {
        this.assertChatSelected(session);
        if (!rawText) {
          throw new BadRequestException('Напишите user_id.');
        }

        await this.adminService.removeGlobalUserBlacklistUser(
          session.selectedChatId!,
          context.actor,
          rawText,
          'private_bot',
        );

        session.pendingInput = null;
        session.screen = 'global_blacklist';
        const view = await this.renderGlobalBlacklistScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_content': {
        await this.captureBroadcastContent(context, session, rawText);
        const view = await this.renderBroadcastScreen(context, session, 'Контент сохранён.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_text': {
        session.broadcastDraft.text = rawText;
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_button_url': {
        session.broadcastDraft.buttonUrl = rawText === '-' ? '' : rawText;
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_button_text': {
        session.broadcastDraft.buttonText = rawText === '-' ? '' : rawText;
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_send_at': {
        session.broadcastDraft.sendAt = this.parseBroadcastSendAt(rawText);
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_cycle_every_hours': {
        const parsedHours = this.parseIntInput(rawText, 1, 14 * 24);
        session.broadcastDraft.cycleEveryHours = parsedHours;
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_cycle_count': {
        const parsedCount = this.parseIntInput(rawText, 1, 14);
        session.broadcastDraft.cycleCount = parsedCount;
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_photo': {
        const imageAttachment = this.extractFirstImageAttachment(context.update);
        if (!imageAttachment) {
          throw new BadRequestException('Отправьте фото отдельным сообщением.');
        }

        const downloaded = await this.downloadImageAttachment(imageAttachment);
        session.broadcastDraft.imageEnabled = true;
        session.broadcastDraft.imageBase64 = downloaded.base64;
        session.broadcastDraft.imageMimeType = downloaded.mimeType;
        session.broadcastDraft.imageFileName = downloaded.fileName;

        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(
          context,
          session,
          'Фото добавлено в черновик.',
        );
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_title': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.title = rawText;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Название обновлено.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_description': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.description = rawText === '-' ? '' : rawText;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Описание обновлено.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_start_at': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const startsAt = rawText === '-' ? null : this.parseDateInput(rawText).toISOString();
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.startsAt = startsAt;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(
          context,
          session,
          startsAt ? 'Старт обновлён.' : 'Старт убран.',
        );
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_end_at': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const endsAt = this.parseDateInput(rawText).toISOString();
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.endsAt = endsAt;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Финиш обновлён.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_claim_hours': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const claimHours = this.parseIntInput(rawText, 1, 336);
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.claimHours = claimHours;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Claim-окно обновлено.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_photo': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const imageAttachment = this.extractFirstImageAttachment(context.update);
        if (!imageAttachment) {
          throw new BadRequestException('Отправьте фото отдельным сообщением.');
        }

        const downloaded = await this.downloadImageAttachment(imageAttachment, 'private-giveaway');
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.imageEnabled = true;
            nextDraft.imageBase64 = downloaded.base64;
            nextDraft.imageMimeType = downloaded.mimeType;
            nextDraft.imageFileName = downloaded.fileName;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Фото обновлено.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_prize': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            if (pendingInput.index < 0 || pendingInput.index > nextDraft.prizes.length) {
              throw new BadRequestException('Призовое место не найдено.');
            }

            if (pendingInput.index === nextDraft.prizes.length) {
              nextDraft.prizes = [
                ...nextDraft.prizes,
                {
                  position: nextDraft.prizes.length + 1,
                  title: rawText,
                },
              ];
              return;
            }

            nextDraft.prizes = nextDraft.prizes.map((prize, index) =>
              index === pendingInput.index ? { ...prize, title: rawText } : prize,
            );
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Приз обновлён.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'poll_question': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const saved = await this.updateManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          {
            question: rawText,
            options: session.pollDraft.options,
          },
        );
        session.pollDraft = this.toPrivatePollDraft(saved);
        session.pendingInput = null;
        session.screen = 'poll';
        const view = await this.renderPollScreen(context, session, null, saved);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'poll_option': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        if (pendingInput.index < 0 || pendingInput.index >= session.pollDraft.options.length) {
          throw new BadRequestException('Вариант не найден.');
        }

        const nextOptions = [...session.pollDraft.options];
        nextOptions[pendingInput.index] = rawText;
        const saved = await this.updateManagedPollForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          {
            question: session.pollDraft.question,
            options: nextOptions,
          },
        );
        session.pollDraft = this.toPrivatePollDraft(saved);
        session.pendingInput = null;
        session.screen = 'poll';
        const view = await this.renderPollScreen(context, session, null, saved);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'manual_ban_duration': {
        this.assertChatSelected(session);
        const banDurationHours = this.parseIntInput(rawText, 1, 336);
        const result = await this.adminService.applyManualModerationAction(
          session.selectedChatId!,
          pendingInput.targetUserId,
          context.actor,
          {
            action: 'BAN',
            banDurationHours,
          },
          'private_bot',
        );

        session.pendingInput = null;
        session.screen = 'manual_actions';
        session.manualTargetUserId = pendingInput.targetUserId;
        const view = this.renderManualActionsScreen(session.manualTargetUserId, result.message);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }
    }
  }

  private async updateSingleSetting(
    chatId: string,
    actor: AuthUser,
    key: keyof ChatSettings,
    value: ChatSettings[keyof ChatSettings],
  ): Promise<void> {
    const current = await this.adminService.getSettings(chatId, actor);
    const nextSettings: ChatSettings = {
      ...current,
      [key]: value,
    };

    await this.adminService.updateSettings(chatId, actor, nextSettings, 'private_bot');
  }

  private async updateSingleChannelSetting(
    chatId: string,
    actor: AuthUser,
    key: keyof ChannelSettings,
    value: ChannelSettings[keyof ChannelSettings],
  ): Promise<void> {
    const current = await this.adminService.getChannelSettings(chatId, actor);
    const nextSettings: ChannelSettings = {
      ...current,
      [key]: value,
    };

    await this.adminService.updateChannelSettings(chatId, actor, nextSettings, 'private_bot');
  }

  private async captureBroadcastContent(
    context: PrivateContext,
    session: PrivateSession,
    rawText: string,
  ): Promise<void> {
    const normalizedText = rawText.trim();
    const imageAttachment = this.extractFirstImageAttachment(context.update);

    if (!normalizedText && !imageAttachment) {
      if (this.hasVideoAttachment(context.update)) {
        throw new BadRequestException(
          'Видео в рассылке пока не поддерживается. Отправьте текст или фото.',
        );
      }
      throw new BadRequestException('Отправьте текст или фото отдельным сообщением.');
    }

    if (normalizedText) {
      session.broadcastDraft.text = rawText;
    }

    if (imageAttachment) {
      const downloaded = await this.downloadImageAttachment(imageAttachment);
      session.broadcastDraft.imageEnabled = true;
      session.broadcastDraft.imageBase64 = downloaded.base64;
      session.broadcastDraft.imageMimeType = downloaded.mimeType;
      session.broadcastDraft.imageFileName = downloaded.fileName;
    }

    session.pendingInput = null;
    session.screen = 'broadcast';
  }

  private async sendBroadcastFromSession(context: PrivateContext, session: PrivateSession) {
    const payload: PrivateBroadcastDraft = {
      ...session.broadcastDraft,
      applyToAllChats:
        session.selectedEntityType === 'channel' ? false : session.broadcastDraft.applyToAllChats,
    };

    const result =
      session.selectedEntityType === 'channel'
        ? await this.adminService.sendChannelBroadcast(
            session.selectedChatId!,
            context.actor,
            payload,
            'private_bot',
          )
        : await this.adminService.sendBroadcast(
            session.selectedChatId!,
            context.actor,
            payload,
            'private_bot',
          );

    return result;
  }

  private createDefaultGiveawayDraft(): UpdateManagedGiveawayRequest {
    return {
      title: 'Новый розыгрыш',
      description: '',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      startsAt: null,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      claimHours: 24,
      prizes: [
        {
          position: 1,
          title: 'Приз 1',
        },
      ],
    };
  }

  private toGiveawayUpdatePayload(giveaway: ManagedGiveawayDetails): UpdateManagedGiveawayRequest {
    return {
      title: giveaway.title,
      description: giveaway.description,
      imageEnabled: giveaway.imageEnabled,
      imageBase64: giveaway.imageBase64,
      imageMimeType: giveaway.imageMimeType,
      imageFileName: giveaway.imageFileName,
      startsAt: giveaway.startsAt,
      endsAt: giveaway.endsAt,
      claimHours: giveaway.claimHours,
      prizes: giveaway.prizes.map((prize) => ({
        position: prize.position,
        title: prize.title,
      })),
    };
  }

  private formatGiveawayStatusLabel(status: ManagedGiveawayDetails['status']): string {
    if (status === 'ACTIVE') {
      return 'Активен';
    }
    if (status === 'SCHEDULED') {
      return 'По таймеру';
    }
    if (status === 'COMPLETED') {
      return 'Завершён';
    }
    if (status === 'DRAWING') {
      return 'Подводим итоги';
    }
    if (status === 'CANCELED') {
      return 'Отменён';
    }
    return 'Черновик';
  }

  private async createManagedGiveawayDraftForSession(
    chatId: string,
    actor: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedGiveawayDetails> {
    return this.managedGiveawayService.createManagedGiveaway(
      chatId,
      actor,
      this.createDefaultGiveawayDraft(),
      entityType,
      'private_bot',
    );
  }

  private async updateManagedGiveawayDraftForSession(
    chatId: string,
    actor: AuthUser,
    entityType: ManagedEntityType,
    giveawayId: string,
    updater: (draft: UpdateManagedGiveawayRequest) => void,
  ): Promise<ManagedGiveawayDetails> {
    const giveaway = await this.managedGiveawayService.getManagedGiveaway(
      chatId,
      giveawayId,
      actor,
      entityType,
    );
    if (giveaway.status !== 'DRAFT') {
      throw new BadRequestException('Изменять можно только черновик розыгрыша.');
    }

    const nextDraft = this.toGiveawayUpdatePayload(giveaway);
    updater(nextDraft);

    return this.managedGiveawayService.updateManagedGiveaway(
      chatId,
      giveawayId,
      actor,
      nextDraft,
      entityType,
      'private_bot',
    );
  }

  private async getManagedGiveawayDraftForSession(
    actor: AuthUser,
    session: PrivateSession,
  ): Promise<ManagedGiveawayDetails> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      throw new BadRequestException('Сначала выберите чат или канал.');
    }

    const giveaway = await this.getManagedGiveawayForSession(actor, session);
    if (!giveaway || giveaway.status !== 'DRAFT') {
      throw new BadRequestException('Черновик розыгрыша не найден.');
    }

    return giveaway;
  }

  private async getManagedPollForSession(
    chatId: string,
    actor: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedPoll> {
    return entityType === 'channel'
      ? this.adminService.getChannelPoll(chatId, actor)
      : this.adminService.getChatPoll(chatId, actor);
  }

  private async updateManagedPollForSession(
    chatId: string,
    actor: AuthUser,
    entityType: ManagedEntityType,
    draft: PrivatePollDraft,
  ): Promise<ManagedPoll> {
    return entityType === 'channel'
      ? this.adminService.updateChannelPoll(chatId, actor, draft, 'private_bot')
      : this.adminService.updateChatPoll(chatId, actor, draft, 'private_bot');
  }

  private async publishManagedPollForSession(
    chatId: string,
    actor: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedPoll> {
    return entityType === 'channel'
      ? this.adminService.publishChannelPoll(chatId, actor, 'private_bot')
      : this.adminService.publishChatPoll(chatId, actor, 'private_bot');
  }

  private async closeManagedPollForSession(
    chatId: string,
    actor: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedPoll> {
    return entityType === 'channel'
      ? this.adminService.closeChannelPoll(chatId, actor, 'private_bot')
      : this.adminService.closeChatPoll(chatId, actor, 'private_bot');
  }

  private toPrivatePollDraft(poll: ManagedPoll): PrivatePollDraft {
    const options = poll.options.slice(0, MANAGED_POLL_MAX_OPTIONS);

    while (options.length < MANAGED_POLL_MIN_OPTIONS) {
      options.push('');
    }

    return {
      question: poll.question,
      options,
    };
  }

  private async renderChatSelection(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    const entityType = session.entityTab;
    const entities = await this.adminService.listManagedEntities(context.actor, entityType);
    const singleEntityWord = entityType === 'channel' ? 'канал' : 'чат';
    const pluralEntityWord = entityType === 'channel' ? 'каналы' : 'чаты';

    if (entities.length === 0) {
      return {
        text: [
          'Центр управления MAX',
          '',
          entityType === 'channel'
            ? 'Пока не вижу доступных каналов.'
            : 'Пока не вижу доступных чатов.',
          '',
          'Проверьте, пожалуйста:',
          entityType === 'channel' ? '- бот добавлен в канал;' : '- бот добавлен в чат;',
          '- у бота есть права администратора;',
          '- у вас есть права администратора.',
          '',
          'Когда доступ появится, вернитесь сюда и выберите нужную сущность.',
        ].join('\n'),
        options: {
          buttons: [
            [
              this.callbackButton(
                `${session.entityTab === 'chat' ? '✅' : '◻️'} Чаты`,
                this.cb('entity_tab', 'chat'),
              ),
              this.callbackButton(
                `${session.entityTab === 'channel' ? '✅' : '◻️'} Каналы`,
                this.cb('entity_tab', 'channel'),
              ),
            ],
            [this.callbackButton('Помощь', this.cb('help'))],
            ...this.buildFooterButtons(),
          ],
        },
      };
    }

    const pageInfo = this.paginate(entities, session.chatPage, PAGE_SIZE_CHATS);
    session.chatPage = pageInfo.page;

    const lines = [
      'Центр управления MAX',
      '',
      `Выберите ${singleEntityWord} (${pageInfo.start + 1}-${pageInfo.end} из ${entities.length}):`,
      `Текущая вкладка: ${pluralEntityWord}.`,
      ...pageInfo.items.map((chat, index) => `${pageInfo.start + index + 1}. ${chat.title}`),
      '',
      `После выбора все действия будут применяться к этому ${singleEntityWord}у.`,
    ];

    const rows: MaxMessageButton[][] = pageInfo.items.map((chat, index) => [
      this.callbackButton(
        `${pageInfo.start + index + 1}. ${this.compactText(chat.title, 34)}`,
        this.cb('chat_select', entityType, chat.id),
      ),
    ]);

    rows.push([
      this.callbackButton(
        `${session.entityTab === 'chat' ? '✅' : '◻️'} Чаты`,
        this.cb('entity_tab', 'chat'),
      ),
      this.callbackButton(
        `${session.entityTab === 'channel' ? '✅' : '◻️'} Каналы`,
        this.cb('entity_tab', 'channel'),
      ),
    ]);
    rows.push(this.paginationButtons(pageInfo.page, pageInfo.pages, 'chat_page'));
    rows.push([this.callbackButton('Помощь', this.cb('help'))]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderPrimaryScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    if (session.selectedEntityType === 'channel') {
      return this.renderChannelHomeScreen(context, session);
    }

    return this.renderHomeScreen(context, session);
  }

  private async renderByCurrentScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    if (session.screen === 'chat_select') {
      return this.renderChatSelection(context, session);
    }
    if (session.screen === 'home') {
      return this.renderHomeScreen(context, session);
    }
    if (session.screen === 'settings_hub') {
      return this.renderSettingsHubScreen(context, session);
    }
    if (session.screen === 'section' && session.section) {
      return this.renderSectionCardScreen(context, session, session.section);
    }
    if (session.screen === 'channel_section' && session.channelSection) {
      return this.renderChannelSectionScreen(context, session, session.channelSection);
    }
    if (session.screen === 'domains') {
      return this.renderDomainsScreen(context, session);
    }
    if (session.screen === 'global_blacklist') {
      return this.renderGlobalBlacklistScreen(context, session);
    }
    if (session.screen === 'broadcast') {
      return this.renderBroadcastScreen(context, session);
    }
    if (session.screen === 'poll') {
      return this.renderPollScreen(context, session);
    }
    if (session.screen === 'giveaway') {
      return this.renderGiveawayScreen(context, session);
    }
    if (session.screen === 'events') {
      return this.renderEventsScreen(context, session);
    }
    if (session.screen === 'logs') {
      return this.renderLogsScreen(context, session);
    }
    if (session.screen === 'search' && session.searchQuery) {
      return this.renderSearchResultsScreen(session.searchQuery);
    }
    if (session.screen === 'manual_users') {
      return this.renderManualUsersScreen(context, session);
    }
    if (session.screen === 'manual_actions') {
      return this.renderManualActionsScreen(session.manualTargetUserId);
    }

    return this.renderPrimaryScreen(context, session);
  }

  private async renderChannelHomeScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const channels = await this.adminService.listManagedEntities(context.actor, 'channel');
    const selectedChannel = channels.find((chat) => chat.id === session.selectedChatId) ?? null;
    if (!selectedChannel) {
      session.selectedChatId = null;
      session.selectedEntityType = null;
      session.screen = 'chat_select';
      session.entityTab = 'channel';
      return this.renderChatSelection(context, session);
    }
    session.selectedEntityType = 'channel';
    const settings = await this.adminService.getChannelSettings(selectedChannel.id, context.actor);

    const lines: string[] = [
      'Центр управления каналом',
      '',
      `Канал: ${selectedChannel.title}`,
      `ID: ${selectedChannel.id}`,
      '',
      `Статус: предложка ${settings.postSuggestionsEnabled ? 'включена' : 'выключена'} • обсуждения ${settings.commentsEnabled ? 'включены' : 'выключены'}`,
      'MAX не даёт нативные комментарии в канале: обсуждения и реакции ведём через бота/чат.',
      '',
      'Выберите действие.',
    ];

    const rows: MaxMessageButton[][] = [
      [
        this.callbackButton('Обсуждение и реакции', this.cb('open_channel_section', 'comments')),
        this.callbackButton('Предложка', this.cb('open_channel_section', 'post_suggestions')),
      ],
      [
        this.callbackButton('Рассылка', this.cb('open_broadcast')),
        this.callbackButton('Опрос', this.cb('open_poll')),
      ],
      [
        this.callbackButton('Розыгрыш', this.cb('open_giveaway')),
        this.callbackButton('Пост с кнопками', this.cb('publish_channel_engagement')),
      ],
      [this.callbackButton('Сменить канал', this.cb('change_chat'))],
      [this.callbackButton('Помощь', this.cb('help'))],
      ...this.buildFooterButtons(),
    ];

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderChannelSectionScreen(
    context: PrivateContext,
    session: PrivateSession,
    section: ChannelSectionKey,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const settings = await this.adminService.getChannelSettings(
      session.selectedChatId,
      context.actor,
    );
    const sectionHint =
      section === 'post_suggestions'
        ? 'Совет: ссылку для кнопки копируйте в MAX: канал → Поделиться → Скопировать ссылку.'
        : 'Комментариев в канале MAX нет: включайте реакции в MAX и направляйте обсуждение в бота/чат.';

    const lines: string[] = [
      `${CHANNEL_SECTION_LABELS[section]}`,
      '',
      sectionHint,
      '',
      ...this.buildChannelSectionSummary(section, settings),
      '',
      'Сначала тумблеры и основные действия, затем тексты и ссылки.',
    ];

    const rows = this.buildChannelSectionRows(section, settings);

    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderHomeScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    if (session.selectedEntityType === 'channel') {
      return this.renderChannelHomeScreen(context, session);
    }

    const chats = await this.adminService.listChats(context.actor);
    const selectedChat = chats.find((chat) => chat.id === session.selectedChatId) ?? null;
    if (!selectedChat) {
      session.selectedChatId = null;
      session.selectedEntityType = null;
      session.screen = 'chat_select';
      return this.renderChatSelection(context, session);
    }
    session.selectedEntityType = 'chat';
    const settings = await this.adminService.getSettings(selectedChat.id, context.actor);

    const lines: string[] = [
      'Центр управления чатом',
      '',
      `Чат: ${selectedChat.title}`,
      `ID: ${selectedChat.id}`,
      '',
      `Статус: ссылки ${this.describeLinkPolicy(settings.linkPolicy)} • приветствие ${settings.greetingEnabled ? 'вкл' : 'выкл'} • ночь ${settings.nightModeEnabled ? 'вкл' : 'выкл'}`,
      'Выберите действие.',
    ];

    const rows: MaxMessageButton[][] = [
      [
        this.callbackButton('Настройки', this.cb('open_settings_hub')),
        this.callbackButton('Рассылка', this.cb('open_broadcast')),
      ],
      [
        this.callbackButton('Опрос', this.cb('open_poll')),
        this.callbackButton('Розыгрыш', this.cb('open_giveaway')),
      ],
      [
        this.callbackButton('События', this.cb('open_events')),
        this.callbackButton('Статистика', this.cb('open_logs')),
      ],
      [
        this.callbackButton('Поиск', this.cb('open_search')),
        this.callbackButton('Ручные действия', this.cb('open_manual_users')),
      ],
      [this.callbackButton('Сменить чат', this.cb('change_chat'))],
    ];

    rows.push([this.callbackButton('Помощь', this.cb('help'))]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderSettingsHubScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const settings = await this.adminService.getSettings(session.selectedChatId, context.actor);
    const lines: string[] = [
      'Разделы настроек',
      '',
      ...SECTION_ORDER.map(
        (section, index) =>
          `${index + 1}. ${SECTION_LABELS[section]} — ${this.describeSectionShortSummary(section, settings)}`,
      ),
      '',
      'Rich-редактор правил и расширенные сценарии всегда доступны через приложение.',
    ];

    const rows: MaxMessageButton[][] = SECTION_ORDER.map((section) => [
      this.callbackButton(
        `${SECTION_LABELS[section]} • ${this.compactText(this.describeSectionShortSummary(section, settings), 20)}`,
        this.cb('open_section', section),
      ),
    ]);

    rows.push([
      this.callbackButton('Поиск', this.cb('open_search')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderSectionCardScreen(
    context: PrivateContext,
    session: PrivateSession,
    section: PrivateSectionKey,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const settings = await this.adminService.getSettings(session.selectedChatId, context.actor);
    const lines: string[] = [
      `${SECTION_LABELS[section]} • ${session.sectionView === 'basic' ? 'Основное' : 'Ещё параметры'}`,
      '',
      ...this.buildSectionSummaryLines(section, settings, session.sectionView),
      '',
      'Сначала основные тумблеры и санкции, затем тексты, кнопки и детальные параметры.',
    ];

    const rows = this.buildSectionActionRows(section, settings, session.sectionView);

    if (section === 'links' && session.sectionView === 'advanced') {
      rows.push([this.callbackButton('Разрешённые домены', this.cb('open_domains'))]);
    }

    if (section === 'extra' && session.sectionView === 'advanced') {
      rows.push([this.callbackButton('Глобальный чёрный список', this.cb('open_blacklist'))]);
    }

    const hasAdvanced = SECTION_CARD_FIELDS[section].advanced.length > 0;
    if (hasAdvanced) {
      if (session.sectionView === 'basic') {
        rows.push([
          this.callbackButton('⚙️ Ещё параметры', this.cb('section_view', section, 'advanced')),
        ]);
      } else {
        rows.push([this.callbackButton('⬅️ Основное', this.cb('section_view', section, 'basic'))]);
      }
    }

    rows.push([
      this.callbackButton(
        'Применить раздел ко всем чатам',
        this.cb('apply_section_preview', section),
        'positive',
      ),
    ]);
    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Разделы', this.cb('open_settings_hub')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderMainMenu(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    if (session.selectedEntityType === 'channel') {
      return this.renderChannelHomeScreen(context, session);
    }

    const chats = await this.adminService.listChats(context.actor);
    const selectedChat = chats.find((chat) => chat.id === session.selectedChatId) ?? null;
    if (!selectedChat) {
      session.selectedChatId = null;
      session.selectedEntityType = null;
      session.screen = 'chat_select';
      return this.renderChatSelection(context, session);
    }
    session.selectedEntityType = 'chat';

    const text = [
      'Панель управления (классический вид)',
      '',
      `Текущий чат: ${selectedChat.title}`,
      `ID: ${selectedChat.id}`,
      '',
      'Классический режим. Для нового интерфейса нажмите «Новый вид».',
    ].join('\n');

    const rows: MaxMessageButton[][] = [
      [
        this.callbackButton('Ссылки', this.cb('open_section', 'links')),
        this.callbackButton('Новички', this.cb('open_section', 'greeting')),
      ],
      [
        this.callbackButton('Нецензура', this.cb('open_section', 'profanityFilter')),
        this.callbackButton('Реклама', this.cb('open_section', 'commercialFilter')),
      ],
      [
        this.callbackButton('Темы', this.cb('open_section', 'thematicFilters')),
        this.callbackButton('Дубли', this.cb('open_section', 'duplicates')),
      ],
      [
        this.callbackButton('Лимиты', this.cb('open_section', 'limits')),
        this.callbackButton('Тихие часы', this.cb('open_section', 'night')),
      ],
      [
        this.callbackButton('Ещё', this.cb('open_section', 'extra')),
        this.callbackButton('Рассылка', this.cb('open_broadcast')),
      ],
      [
        this.callbackButton('Опрос', this.cb('open_poll')),
        this.callbackButton('Розыгрыш', this.cb('open_giveaway')),
      ],
      [
        this.callbackButton('Нарушения', this.cb('open_events')),
        this.callbackButton('Статистика', this.cb('open_logs')),
      ],
      [this.callbackButton('Ручной бан', this.cb('open_manual_users'))],
      [this.callbackButton('Другой чат', this.cb('change_chat'))],
      [this.callbackButton('Новый вид', this.cb('home'))],
      [this.callbackButton('Помощь', this.cb('help'))],
      ...this.buildFooterButtons(),
    ];

    return {
      text,
      options: {
        buttons: rows,
      },
    };
  }

  private async renderSection(
    context: PrivateContext,
    session: PrivateSession,
    section: PrivateSectionKey,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const settings = await this.adminService.getSettings(session.selectedChatId, context.actor);
    const fieldConfigs = SECTION_FIELDS[section];

    const lines: string[] = [
      `${SECTION_LABELS[section]}`,
      '',
      ...fieldConfigs.map(
        (field) => `- ${field.label}: ${this.formatSettingValue(settings[field.key], field.type)}`,
      ),
      '',
      'Нажмите на параметр, чтобы изменить его.',
      'Чтобы очистить текст или ссылку, отправьте `-` во время ввода.',
    ];

    const rows: MaxMessageButton[][] = [];
    for (const field of fieldConfigs) {
      if (field.type === 'boolean') {
        rows.push([
          this.callbackButton(
            `${Boolean(settings[field.key]) ? '✅' : '⬜'} ${field.label}`,
            this.cb('toggle', section, String(field.key)),
          ),
        ]);
        continue;
      }

      if (field.type === 'enum') {
        rows.push([this.callbackButton(`🎛 ${field.label}`, this.cb('noop'))]);
        for (const enumValue of field.enumValues ?? []) {
          rows.push([
            this.callbackButton(
              `${settings[field.key] === enumValue ? '✅' : '◻️'} ${this.formatEnumValue(enumValue)}`,
              this.cb('set_enum', section, String(field.key), enumValue),
            ),
          ]);
        }
        continue;
      }

      rows.push([
        this.callbackButton(`✏️ ${field.label}`, this.cb('set_input', section, String(field.key))),
      ]);
    }

    if (section === 'links') {
      rows.push([this.callbackButton('Разрешённые домены', this.cb('open_domains'))]);
    }

    if (section === 'extra') {
      rows.push([this.callbackButton('Глобальный чёрный список', this.cb('open_blacklist'))]);
    }

    rows.push([
      this.callbackButton(
        'Применить раздел ко всем чатам',
        this.cb('apply_section_preview', section),
        'positive',
      ),
    ]);
    rows.push([this.callbackButton('⬅️ Главное меню', this.cb('main'))]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderDomainsScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const domains = await this.adminService.getDomainAllowlistDetails(
      session.selectedChatId,
      context.actor,
    );
    const pageInfo = this.paginate(domains, session.domainPage, PAGE_SIZE_DOMAINS);
    session.domainPage = pageInfo.page;

    const lines: string[] = ['Разрешённые домены', ''];

    if (domains.length === 0) {
      lines.push('Список пока пуст.');
    } else {
      lines.push(`Всего доменов: ${domains.length}`);
      lines.push('');
      lines.push(
        ...pageInfo.items.map((entry, index) => {
          const idx = pageInfo.start + index + 1;
          const schedule = entry.removeAfterAt
            ? `удалить: ${this.formatIsoDate(entry.removeAfterAt)}`
            : 'без автоудаления';
          return `${idx}. ${entry.domain} (${schedule})`;
        }),
      );
    }

    lines.push('');
    lines.push('Чтобы добавить домен, отправьте URL или домен.');
    lines.push('Чтобы задать автоудаление, введите ISO или `ДД.ММ.ГГГГ ЧЧ:ММ`.');

    const rows: MaxMessageButton[][] = [
      [this.callbackButton('Добавить домен', this.cb('domain_add_prompt'), 'positive')],
    ];

    for (const [index, entry] of pageInfo.items.entries()) {
      const globalIndex = pageInfo.start + index + 1;
      rows.push([
        this.callbackButton(
          `❌ ${this.compactText(entry.domain, 20)}`,
          this.cb('domain_remove', String(globalIndex)),
        ),
        this.callbackButton(
          `🕒 ${globalIndex}`,
          this.cb('domain_schedule_prompt', String(globalIndex)),
        ),
      ]);
    }

    rows.push(this.paginationButtons(pageInfo.page, pageInfo.pages, 'domains_page'));
    if (session.uiMode === 'modern') {
      rows.push([
        this.callbackButton('⬅️ Назад', this.cb('back')),
        this.callbackButton('Главный экран', this.cb('home')),
      ]);
    } else {
      rows.push([this.callbackButton('⬅️ К разделу «Ссылки»', this.cb('open_section', 'links'))]);
    }
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderGlobalBlacklistScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const entries = await this.adminService.getGlobalUserBlacklist(
      session.selectedChatId,
      context.actor,
    );
    const preview = entries.slice(0, 12);

    const lines: string[] = [
      'Глобальный чёрный список (на все чаты)',
      '',
      `Всего пользователей: ${entries.length}`,
      '',
      ...preview.map(
        (entry, index) => `${index + 1}. ${entry.userId} (${this.formatIsoDate(entry.createdAt)})`,
      ),
      ...(entries.length > preview.length
        ? ['', `... и ещё ${entries.length - preview.length}.`]
        : []),
      '',
      'Можно добавить или удалить пользователя по user_id.',
    ];

    const rows: MaxMessageButton[][] = [
      [
        this.callbackButton('Добавить user_id', this.cb('blacklist_add_prompt'), 'positive'),
        this.callbackButton('Удалить user_id', this.cb('blacklist_remove_prompt')),
      ],
    ];

    for (const [index, entry] of preview.entries()) {
      rows.push([
        this.callbackButton(
          `❌ ${this.compactText(entry.userId, 22)}`,
          this.cb('blacklist_remove', String(index + 1)),
        ),
      ]);
    }

    if (session.uiMode === 'modern') {
      rows.push([
        this.callbackButton('⬅️ Назад', this.cb('back')),
        this.callbackButton('Главный экран', this.cb('home')),
      ]);
    } else {
      rows.push([
        this.callbackButton('⬅️ К разделу «Дополнительно»', this.cb('open_section', 'extra')),
      ]);
    }
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderBroadcastScreen(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const draft = session.broadcastDraft;
    const isChannel = session.selectedEntityType === 'channel';
    const channelSettings = isChannel
      ? await this.adminService.getChannelSettings(session.selectedChatId, context.actor)
      : null;
    const applyToAllEnabled = !isChannel && draft.applyToAllChats;
    const timingSummary = isChannel ? 'недоступен' : draft.sendAt ? this.formatIsoDate(draft.sendAt) : 'нет';
    const cycleSummary = draft.cycleEnabled
      ? `каждые ${draft.cycleEveryHours} ч., ${draft.cycleCount} раз`
      : 'нет';
    const waitingForContent = session.pendingInput?.kind === 'broadcast_content';

    const lines: string[] = [
      isChannel ? 'Рассылка в канал' : 'Рассылка',
      '',
      `Контент: ${
        waitingForContent
          ? 'жду следующее сообщение'
          : draft.text.trim() || draft.imageEnabled
            ? 'готов'
            : 'не добавлен'
      }`,
      `Текст: ${draft.text.trim() ? this.compactText(draft.text, 80) : 'не указан'}`,
      ...(channelSettings
        ? [`Комментарии: ${this.describeBooleanCompact(channelSettings.commentsEnabled)}`]
        : []),
      ...(!isChannel ? [`Во все чаты: ${applyToAllEnabled ? 'Да' : 'Нет'}`] : []),
      `Кнопка рассылки: ${draft.buttonEnabled ? 'Да' : 'Нет'}`,
      `Фото: ${draft.imageEnabled ? 'Да' : 'Нет'}`,
      ...(!isChannel ? [`Таймер: ${timingSummary}`, `Цикл: ${cycleSummary}`] : []),
      `Режим: ${session.broadcastView === 'basic' ? 'Основное' : 'Ещё параметры'}`,
      ...(notice ? ['', `Статус: ${notice}`] : []),
      '',
      waitingForContent
        ? 'Пришлите текст или фото следующим сообщением, затем нажмите «Отправить».'
        : 'Настройте параметры и нажмите «Отправить».',
    ];

    const rows: MaxMessageButton[][] = [];
    if (session.broadcastView === 'basic') {
      rows.push([
        this.callbackButton('🧾 Контент сообщением', this.cb('broadcast_input_prompt', 'content')),
      ]);
      if (!isChannel) {
        rows.push([
          this.callbackButton(
            `${applyToAllEnabled ? '✅' : '⬜'} Во все чаты`,
            this.cb('broadcast_toggle', 'apply_to_all'),
          ),
        ]);
      }
      rows.push([this.callbackButton('🚀 Отправить', this.cb('broadcast_send'), 'positive')]);
      rows.push([this.callbackButton('⚙️ Ещё параметры', this.cb('broadcast_view', 'advanced'))]);
    } else {
      rows.push([
        this.callbackButton('🧾 Контент сообщением', this.cb('broadcast_input_prompt', 'content')),
      ]);
      if (!isChannel) {
        rows.push([
          this.callbackButton(
            `${applyToAllEnabled ? '✅' : '⬜'} Во все чаты`,
            this.cb('broadcast_toggle', 'apply_to_all'),
          ),
        ]);
      }
      rows.push([
        this.callbackButton(
          `${draft.buttonEnabled ? '✅' : '⬜'} Кнопка`,
          this.cb('broadcast_toggle', 'button_enabled'),
        ),
      ]);

      if (draft.buttonEnabled) {
        rows.push([
          this.callbackButton('🔗 Ссылка кнопки', this.cb('broadcast_input_prompt', 'button_url')),
        ]);
        rows.push([
          this.callbackButton('📝 Текст кнопки', this.cb('broadcast_input_prompt', 'button_text')),
        ]);
      }

      if (draft.imageEnabled) {
        rows.push([
          this.callbackButton('🗑 Удалить фото', this.cb('broadcast_clear_photo')),
        ]);
      }

      if (!isChannel) {
        rows.push([
          this.callbackButton('🕒 Время отправки', this.cb('broadcast_input_prompt', 'send_at')),
          this.callbackButton('🧹 Убрать таймер', this.cb('broadcast_clear_timer')),
        ]);

        rows.push([
          this.callbackButton(
            `${draft.cycleEnabled ? '✅' : '⬜'} Цикл`,
            this.cb('broadcast_toggle', 'cycle_enabled'),
          ),
        ]);

        if (draft.cycleEnabled) {
          rows.push([
            this.callbackButton(
              '🔁 Шаг цикла (часы)',
              this.cb('broadcast_input_prompt', 'cycle_hours'),
            ),
          ]);
          rows.push([
            this.callbackButton('🔢 Повторов', this.cb('broadcast_input_prompt', 'cycle_count')),
          ]);
        }
      }

      rows.push([this.callbackButton('⬅️ Основное', this.cb('broadcast_view', 'basic'))]);

      rows.push([this.callbackButton('🚀 Отправить', this.cb('broadcast_send'), 'positive')]);
    }

    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderPollScreen(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
    pollOverride?: ManagedPoll,
  ): Promise<PrivateView> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      return this.renderChatSelection(context, session);
    }

    const poll =
      pollOverride ??
      (await this.getManagedPollForSession(
        session.selectedChatId,
        context.actor,
        session.selectedEntityType,
      ));
    session.pollDraft = this.toPrivatePollDraft(poll);

    const entityLabel = session.selectedEntityType === 'channel' ? 'Канал' : 'Чат';
    const statusLabel =
      poll.status === 'ACTIVE' ? 'Активен' : poll.status === 'CLOSED' ? 'Закрыт' : 'Черновик';
    const totalVotes = poll.totalVotes;

    const lines: string[] = [
      'Опрос',
      '',
      `${entityLabel}: ${session.selectedChatId}`,
      `Статус: ${statusLabel}`,
      `Всего голосов: ${totalVotes}`,
      `Пост: ${poll.publishedMessageId ? 'опубликован' : 'ещё нет'}`,
    ];

    if (poll.publishedUrl) {
      lines.push(`Ссылка: ${poll.publishedUrl}`);
    }

    lines.push('');
    lines.push(`Вопрос: ${poll.question.trim() || 'не задан'}`);
    lines.push('');
    lines.push('Варианты:');
    lines.push(
      ...poll.options.map((option, index) => {
        const result = poll.optionResults[index];
        const suffix =
          result && (poll.status === 'ACTIVE' || poll.status === 'CLOSED')
            ? ` - ${result.votes} (${result.percent}%)`
            : '';
        return `${index + 1}. ${option || 'Без текста'}${suffix}`;
      }),
    );

    if (notice) {
      lines.push('', `Статус: ${notice}`);
    }

    lines.push(
      '',
      poll.status === 'ACTIVE'
        ? 'Опрос опубликован. Можно открыть пост или закрыть голосование.'
        : 'Соберите вопрос и варианты, затем опубликуйте опрос.',
    );

    const rows: MaxMessageButton[][] = [];

    if (poll.status !== 'ACTIVE') {
      rows.push([this.callbackButton('✏️ Вопрос', this.cb('poll_input_prompt', 'question'))]);

      for (const [index] of session.pollDraft.options.entries()) {
        rows.push([
          this.callbackButton(
            `✏️ Вариант ${index + 1}`,
            this.cb('poll_input_prompt', 'option', String(index + 1)),
          ),
        ]);
      }

      if (session.pollDraft.options.length < MANAGED_POLL_MAX_OPTIONS) {
        rows.push([this.callbackButton('➕ Добавить вариант', this.cb('poll_add_option'))]);
      }

      if (session.pollDraft.options.length > MANAGED_POLL_MIN_OPTIONS) {
        rows.push(
          ...session.pollDraft.options.map((_, index) => [
            this.callbackButton(
              `🗑 Удалить вариант ${index + 1}`,
              this.cb('poll_remove_option', String(index + 1)),
              'negative',
            ),
          ]),
        );
      }

      rows.push([this.callbackButton('Опубликовать опрос', this.cb('poll_publish'), 'positive')]);
    } else {
      if (poll.publishedUrl) {
        rows.push([
          {
            type: 'link',
            text: 'Открыть пост',
            url: poll.publishedUrl,
          },
        ]);
      }
      rows.push([this.callbackButton('Закрыть опрос', this.cb('poll_close'), 'negative')]);
    }

    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderGiveawayScreen(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      return this.renderChatSelection(context, session);
    }

    const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
    const entityLabel = session.selectedEntityType === 'channel' ? 'Канал' : 'Чат';
    const miniappUrl = this.managedGiveawayService.getGiveawaySettingsMiniappUrl(
      session.selectedChatId,
      session.selectedEntityType,
    );
    const rows: MaxMessageButton[][] = [];
    const lines: string[] = ['Розыгрыш', '', `${entityLabel}: ${session.selectedChatId}`];
    const waitingLabel = session.pendingInput ? this.describeInputPrompt(session.pendingInput).title : null;

    if (!giveaway) {
      lines.push(
        '',
        'Состояние: пусто',
        'Создание, фото, текст и публикация теперь ведутся прямо здесь, в боте.',
        'Нажмите «Создать черновик», чтобы собрать карточку без miniapp-формы.',
      );
      rows.push([this.callbackButton('Создать черновик', this.cb('giveaway_create'), 'positive')]);
    } else {
      const statusLabel = this.formatGiveawayStatusLabel(giveaway.status);
      lines.push(
        '',
        'Текущий слот',
        `Название: ${giveaway.title}`,
        `Статус: ${statusLabel}`,
        `Фото: ${giveaway.imageEnabled ? 'добавлено' : 'нет'}`,
        `Период: ${
          giveaway.startsAt
            ? `${this.formatDateTimeLabel(giveaway.startsAt)} -> ${this.formatDateTimeLabel(giveaway.endsAt)}`
            : `сейчас -> ${this.formatDateTimeLabel(giveaway.endsAt)}`
        }`,
        `Claim: ${giveaway.claimHours} ч`,
        `Заявки: ${giveaway.entriesCount} / verified ${giveaway.verifiedEntriesCount} / pending ${giveaway.pendingEntriesCount}`,
        `Победители: ${giveaway.winnersCount}`,
      );

      if (giveaway.description.trim()) {
        lines.push('', `Описание: ${this.compactText(giveaway.description, 400)}`);
      }

      const linkLines: string[] = [];
      if (giveaway.publicationUrl) {
        linkLines.push(`Пост: ${giveaway.publicationUrl}`);
      }
      if (giveaway.resultsUrl) {
        linkLines.push(`Итоги: ${giveaway.resultsUrl}`);
      }
      if (linkLines.length > 0) {
        lines.push('', 'Ссылки', ...linkLines);
      }

      lines.push('', 'Призы');
      lines.push(...giveaway.prizes.map((prize) => `${prize.position}. ${prize.title}`));

      if (giveaway.status === 'DRAFT') {
        lines.push(
          '',
          waitingLabel
            ? `Жду ввод: ${waitingLabel}`
            : 'Редактируйте поля кнопками ниже и публикуйте, когда карточка готова.',
        );
      }

      if (giveaway.winners.length > 0) {
        lines.push('', 'Победители');
        lines.push(
          ...giveaway.winners.flatMap((winner) => [
            `${winner.prizePosition}. ${winner.prizeTitle}`,
            `Участник: ${winner.displayName ?? winner.userId}`,
            `Статус: ${this.formatGiveawayWinnerStatusLabel(winner.status)}`,
            ...(winner.claimDeadlineAt
              ? [`Claim до: ${this.formatDateTimeLabel(winner.claimDeadlineAt)}`]
              : []),
          ]),
        );
      }

      if (giveaway.status === 'DRAFT') {
        rows.push([
          this.callbackButton('✏️ Название', this.cb('giveaway_input_prompt', 'title')),
          this.callbackButton('📝 Описание', this.cb('giveaway_input_prompt', 'description')),
        ]);
        rows.push([
          this.callbackButton('🖼 Фото', this.cb('giveaway_input_prompt', 'photo')),
          giveaway.imageEnabled
            ? this.callbackButton('🗑 Убрать фото', this.cb('giveaway_clear_photo'))
            : this.callbackButton('⬜ Без фото', this.cb('noop')),
        ]);
        rows.push([
          this.callbackButton('🕒 Старт', this.cb('giveaway_input_prompt', 'start_at')),
          giveaway.startsAt
            ? this.callbackButton('🧹 Убрать старт', this.cb('giveaway_clear_start'))
            : this.callbackButton('⏱ Финиш', this.cb('giveaway_input_prompt', 'end_at')),
        ]);
        if (giveaway.startsAt) {
          rows.push([this.callbackButton('⏱ Финиш', this.cb('giveaway_input_prompt', 'end_at'))]);
        }
        rows.push([
          this.callbackButton('⌛ Claim', this.cb('giveaway_input_prompt', 'claim_hours')),
          this.callbackButton('➕ Добавить место', this.cb('giveaway_add_prize')),
        ]);
        if (giveaway.prizes.length > 1) {
          rows.push([
            this.callbackButton(
              `🗑 Удалить место ${giveaway.prizes.length}`,
              this.cb('giveaway_remove_last_prize'),
            ),
          ]);
        }
        rows.push(
          ...giveaway.prizes.map((prize) => [
            this.callbackButton(
              `🏆 ${prize.position}. ${this.compactText(prize.title, 24)}`,
              this.cb('giveaway_input_prompt', 'prize', String(prize.position)),
            ),
          ]),
        );
        rows.push([this.callbackButton('Опубликовать', this.cb('giveaway_publish'), 'positive')]);
        rows.push([this.callbackButton('Отменить черновик', this.cb('giveaway_cancel'), 'negative')]);
      }

      if (giveaway.status === 'ACTIVE' || giveaway.status === 'SCHEDULED') {
        rows.push([this.callbackButton('Завершить розыгрыш', this.cb('giveaway_close'), 'positive')]);
        rows.push([this.callbackButton('Отменить розыгрыш', this.cb('giveaway_cancel'), 'negative')]);
      }

      const winnerActionRows = giveaway.winners.flatMap((winner) => {
        const actionRow: MaxMessageButton[] = [];

        if (
          giveaway.status === 'COMPLETED' &&
          (winner.status === 'SELECTED' || winner.status === 'EXPIRED')
        ) {
          actionRow.push(
            this.callbackButton(
              `Реролл ${winner.prizePosition}`,
              this.cb('giveaway_reroll', winner.id),
            ),
          );
        }

        if (winner.status === 'SELECTED' || winner.status === 'CLAIMED') {
          actionRow.push(
            this.callbackButton(
              `Выдано ${winner.prizePosition}`,
              this.cb('giveaway_deliver', winner.id),
              'positive',
            ),
          );
        }

        return actionRow.length > 0 ? [actionRow] : [];
      });
      rows.push(...winnerActionRows);
    }

    if (notice) {
      lines.push('', `Статус: ${notice}`);
    }

    if (miniappUrl) {
      rows.push([this.buildMiniappOpenButton('Открыть dashboard', miniappUrl)]);
    }

    rows.push([
      this.callbackButton('Обновить', this.cb('refresh_giveaway')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async getManagedGiveawayForSession(
    user: AuthUser,
    session: PrivateSession,
  ): Promise<ManagedGiveawayDetails | null> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      return null;
    }

    if (session.managedGiveawayId) {
      return this.managedGiveawayService.getManagedGiveaway(
        session.selectedChatId,
        session.managedGiveawayId,
        user,
        session.selectedEntityType,
      );
    }

    return this.managedGiveawayService.getCurrentManagedGiveawayForEntity(
      session.selectedChatId,
      user,
      session.selectedEntityType,
    );
  }

  private formatGiveawayWinnerStatusLabel(status: ManagedGiveawayWinner['status']): string {
    switch (status) {
      case 'CLAIMED':
        return 'claim подтверждён';
      case 'DELIVERED':
        return 'приз выдан';
      case 'EXPIRED':
        return 'claim истёк';
      case 'REROLLED':
        return 'перевыбран';
      default:
        return 'ждёт claim';
    }
  }

  private renderGiveawayClaimView(
    claimContext: {
      giveaway: ManagedGiveawayDetails;
      winner: ManagedGiveawayWinner;
    },
    notice: string | null = null,
  ): PrivateView {
    const { giveaway, winner } = claimContext;
    const statusLabel =
      winner.status === 'CLAIMED'
        ? 'Приз подтверждён'
        : winner.status === 'DELIVERED'
          ? 'Приз выдан'
          : winner.status === 'EXPIRED'
            ? 'Claim истёк'
            : 'Ждёт подтверждения';
    const lines = [
      'Розыгрыш',
      '',
      `Название: ${giveaway.title}`,
      `Приз: ${winner.prizePosition}. ${winner.prizeTitle}`,
      `Статус: ${statusLabel}`,
      `Пользователь: ${winner.displayName ?? winner.userId}`,
      ...(winner.claimDeadlineAt ? [`Подтвердить до: ${this.formatDateTimeLabel(winner.claimDeadlineAt)}`] : []),
      ...(notice ? ['', `Статус: ${notice}`] : []),
    ];

    const rows: MaxMessageButton[][] = [];
    if (winner.status === 'SELECTED') {
      rows.push([
        this.callbackButton(
          'Подтвердить приз',
          this.cb('giveaway_claim_confirm', giveaway.id, winner.id),
          'positive',
        ),
      ]);
    }
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private renderUnavailableGiveawayClaimView(): PrivateView {
    return {
      text: ['Розыгрыш', '', 'Этот claim больше недоступен или победитель уже был перевыбран.'].join(
        '\n',
      ),
      options: {
        buttons: this.buildFooterButtons(),
      },
    };
  }

  private async renderEventsScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const events = await this.adminService.getEvents(session.selectedChatId, context.actor, {
      limit: PAGE_SIZE_EVENTS,
      page: session.eventsPage,
    });

    const hasFullPage = events.length === PAGE_SIZE_EVENTS;

    const lines: string[] = [`События модерации (страница ${session.eventsPage})`, ''];

    if (events.length === 0) {
      lines.push('Событий пока нет.');
    } else {
      lines.push(
        ...events.map((event, index) => {
          const lineIndex = (session.eventsPage - 1) * PAGE_SIZE_EVENTS + index + 1;
          return `${lineIndex}. [${event.action}] ${event.ruleCode} • user ${event.userId} • ${this.formatIsoDate(event.createdAt)}`;
        }),
      );
    }

    const rows: MaxMessageButton[][] = [
      [
        this.callbackButton(
          '⬅️ Назад',
          this.cb('events_page', String(Math.max(1, session.eventsPage - 1))),
        ),
        this.callbackButton('➡️ Вперёд', this.cb('events_page', String(session.eventsPage + 1))),
      ],
      [
        this.callbackButton('⬅️ Назад', this.cb('back')),
        this.callbackButton('Главный экран', this.cb('home')),
      ],
      ...this.buildFooterButtons(),
    ];

    if (!hasFullPage && session.eventsPage > 1) {
      rows[0][1] = this.callbackButton('🚫 Конец списка', this.cb('noop'));
    }

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderLogsScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const dashboard = await this.adminService.getLogsDashboard(
      session.selectedChatId,
      context.actor,
      {
        range: session.logsRange,
      },
    );

    const lines: string[] = [
      `Сводка и логи (${session.logsRange})`,
      '',
      `Новые участники: ${dashboard.membership.joinedUsers}`,
      `Покинули чат: ${dashboard.membership.leftUsers}`,
      `WARN: ${dashboard.violationsSummary.warn}`,
      `DELETE: ${dashboard.violationsSummary.deleteMessage}`,
      `KICK: ${dashboard.violationsSummary.kick}`,
      `BAN: ${dashboard.violationsSummary.ban}`,
      `Всего: ${dashboard.violationsSummary.total}`,
      '',
      'Последние нарушения:',
      ...dashboard.violations
        .slice(0, 10)
        .map(
          (violation, index) =>
            `${index + 1}. [${violation.action}] ${violation.ruleCode} • ${violation.userDisplayName ?? violation.userId}`,
        ),
    ];

    const rows: MaxMessageButton[][] = [
      [
        this.callbackButton(
          `${session.logsRange === '24h' ? '✅' : '◻️'} 24h`,
          this.cb('logs_range', '24h'),
        ),
        this.callbackButton(
          `${session.logsRange === '7d' ? '✅' : '◻️'} 7d`,
          this.cb('logs_range', '7d'),
        ),
        this.callbackButton(
          `${session.logsRange === '30d' ? '✅' : '◻️'} 30d`,
          this.cb('logs_range', '30d'),
        ),
      ],
      [
        this.callbackButton('⬅️ Назад', this.cb('back')),
        this.callbackButton('Главный экран', this.cb('home')),
      ],
      ...this.buildFooterButtons(),
    ];

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderManualUsersScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const dashboard = await this.adminService.getLogsDashboard(
      session.selectedChatId,
      context.actor,
      {
        range: session.logsRange,
      },
    );

    const users = dashboard.violations
      .map((violation) => ({
        userId: violation.userId,
        userDisplayName: violation.userDisplayName,
      }))
      .filter(
        (item, index, arr) =>
          arr.findIndex((candidate) => candidate.userId === item.userId) === index,
      );

    const pageInfo = this.paginate(users, session.manualPage, PAGE_SIZE_MANUAL_USERS);
    session.manualPage = pageInfo.page;

    const lines: string[] = [
      `Действия с участником (страница ${pageInfo.page}/${pageInfo.pages})`,
      '',
    ];

    if (users.length === 0) {
      lines.push('За выбранный период нет пользователей для действий.');
    } else {
      lines.push(
        ...pageInfo.items.map(
          (entry, index) =>
            `${pageInfo.start + index + 1}. ${entry.userDisplayName ?? 'Без имени'} (${entry.userId})`,
        ),
      );
    }

    const rows: MaxMessageButton[][] = pageInfo.items.map((entry) => [
      this.callbackButton(
        `${this.compactText(entry.userDisplayName ?? entry.userId, 20)} (${this.compactText(entry.userId, 10)})`,
        this.cb('manual_select_user', entry.userId),
      ),
    ]);

    rows.push(this.paginationButtons(pageInfo.page, pageInfo.pages, 'manual_users_page'));
    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private renderManualActionsScreen(
    targetUserId: string | null,
    notice: string | null = null,
  ): PrivateView {
    if (!targetUserId) {
      return {
        text: 'Сначала выберите пользователя из списка.',
        options: {
          buttons: [
            [this.callbackButton('К списку пользователей', this.cb('open_manual_users'))],
            ...this.buildFooterButtons(),
          ],
        },
      };
    }

    const lines = [
      'Действия с участником',
      '',
      `Пользователь: ${targetUserId}`,
      ...(notice ? ['', `Статус: ${notice}`] : []),
    ];

    return {
      text: lines.join('\n'),
      options: {
        buttons: [
          [
            this.callbackButton('Кик', this.cb('manual_action', 'KICK'), 'negative'),
            this.callbackButton('Бан', this.cb('manual_action', 'BAN'), 'negative'),
          ],
          [this.callbackButton('Разбан', this.cb('manual_action', 'UNBAN'), 'positive')],
          [
            this.callbackButton('⬅️ Назад', this.cb('back')),
            this.callbackButton('Главный экран', this.cb('home')),
          ],
          ...this.buildFooterButtons(),
        ],
      },
    };
  }

  private renderSearchResultsScreen(query: string): PrivateView {
    const matches = this.findSettingMatches(query);
    const lines: string[] = [`Результаты поиска: «${this.compactText(query, 60)}»`, ''];

    if (matches.length === 0) {
      lines.push('Ничего не нашёл. Попробуйте другое слово.');
    } else {
      lines.push(
        ...matches.map((item, index) => `${index + 1}. ${item.sectionLabel} • ${item.label}`),
      );
    }

    const rows: MaxMessageButton[][] = matches.map((item) => [
      this.callbackButton(
        `${item.sectionLabel} • ${this.compactText(item.label, 26)}`,
        this.cb('search_jump', item.section, String(item.key)),
      ),
    ]);

    rows.push([this.callbackButton('🔎 Новый поиск', this.cb('open_search'))]);
    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private findSettingMatches(query: string): Array<{
    section: PrivateSectionKey;
    key: keyof ChatSettings;
    label: string;
    sectionLabel: string;
  }> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const results: Array<{
      section: PrivateSectionKey;
      key: keyof ChatSettings;
      label: string;
      sectionLabel: string;
    }> = [];
    for (const section of SECTION_ORDER) {
      for (const field of SECTION_FIELDS[section]) {
        const fieldKey = String(field.key);
        const aliases = this.buildFieldAliases(section, fieldKey, field.label);
        if (!aliases.some((item) => item.includes(normalized))) {
          continue;
        }

        results.push({
          section,
          key: field.key,
          label: field.label,
          sectionLabel: SECTION_LABELS[section],
        });
      }
    }

    return results.slice(0, SEARCH_RESULT_LIMIT);
  }

  private buildFieldAliases(section: PrivateSectionKey, key: string, label: string): string[] {
    const aliasMap: Record<string, string[]> = {
      link: ['ссылка', 'домен', 'allowlist', 'blocklist'],
      greeting: ['приветствие', 'новичок'],
      profanity: ['мат', 'оскорб'],
      commercial: ['реклама', 'коммерция'],
      thematic: ['тема', 'тематика', 'кодовое слово', 'кодслово', 'слово'],
      duplicate: ['дубль', 'повтор'],
      spam: ['спам'],
      night: ['ночной', 'тишина'],
      blacklist: ['черный список', 'чс'],
      broadcast: ['рассылка'],
      button: ['кнопка', 'url'],
      message: ['сообщение', 'текст'],
      ban: ['бан'],
      kick: ['кик'],
      warn: ['предупреждение'],
      timezone: ['часовой пояс', 'timezone'],
    };

    const loweredKey = key.toLowerCase();
    const normalized: string[] = [
      label.toLowerCase(),
      loweredKey,
      SECTION_LABELS[section].toLowerCase(),
      ...loweredKey
        .split(/_|(?=[A-Z])/)
        .map((part) => part.toLowerCase())
        .filter(Boolean),
    ];

    for (const [needle, aliases] of Object.entries(aliasMap)) {
      if (loweredKey.includes(needle)) {
        normalized.push(...aliases.map((value) => value.toLowerCase()));
      }
    }

    return Array.from(new Set(normalized));
  }

  private buildSectionFieldConfigs(
    section: PrivateSectionKey,
    view: PrivateSectionView,
  ): SettingFieldConfig[] {
    const allowed = new Set(SECTION_CARD_FIELDS[section][view]);
    return SECTION_FIELDS[section].filter((field) => allowed.has(field.key));
  }

  private buildSectionSummaryLines(
    section: PrivateSectionKey,
    settings: ChatSettings,
    view: PrivateSectionView,
  ): string[] {
    switch (section) {
      case 'links':
        return [
          `Политика: ${this.describeLinkPolicy(settings.linkPolicy)}`,
          `Санкции: WARN ${this.describeBooleanCompact(settings.linkWarnEnabled)} • KICK ${this.describeBooleanCompact(settings.linkKickEnabled)} • BAN ${this.describeBooleanCompact(settings.linkBanEnabled)}`,
          `Сообщение бота: ${this.describeBooleanCompact(settings.linkBotMessageEnabled)} • кнопка ${this.describeBooleanCompact(settings.linkBotButtonEnabled)}`,
          ...(view === 'advanced'
            ? ['Allowlist и тексты предупреждений доступны в расширенном режиме ниже.']
            : []),
        ];
      case 'greeting':
        return [
          `Приветствие: ${this.describeBooleanCompact(settings.greetingEnabled)}`,
          `Сообщение: ${this.describeBooleanCompact(settings.greetingBotMessageEnabled)} • кнопка ${this.describeBooleanCompact(settings.greetingBotButtonEnabled)}`,
        ];
      case 'profanityFilter':
        return [
          `Фильтр: ${this.describeBooleanCompact(settings.russianProfanityFilterEnabled)}`,
          `Санкции: WARN ${this.describeBooleanCompact(settings.profanityWarnEnabled)} • KICK ${this.describeBooleanCompact(settings.profanityKickEnabled)} • BAN ${this.describeBooleanCompact(settings.profanityBanEnabled)}`,
          `Сообщение бота: ${this.describeBooleanCompact(settings.profanityBotMessageEnabled)}`,
        ];
      case 'commercialFilter':
        return [
          `Фильтр: ${this.describeBooleanCompact(settings.commercialAdsFilterEnabled)} • строгость ${this.formatEnumValue(settings.commercialAdsSensitivity)}`,
          `Пороги: WARN ${settings.commercialAdsWarnThreshold} • DELETE ${settings.commercialAdsDeleteThreshold}`,
          `Сообщение: ${this.describeBooleanCompact(settings.textFiltersBotMessageEnabled)} • WARN ${this.describeBooleanCompact(settings.textFiltersWarnEnabled)} • кнопка ${this.describeBooleanCompact(settings.textFiltersBotButtonEnabled)}`,
        ];
      case 'thematicFilters':
        return [
          `Кодовое слово: ${settings.thematicCodewordEnabled ? settings.thematicCodeword || 'не задано' : 'выключено'}`,
          `Санкции: объяснение ${this.describeBooleanCompact(settings.thematicFiltersBotMessageEnabled)} • WARN ${this.describeBooleanCompact(settings.thematicFiltersWarnEnabled)} • BAN ${this.describeBooleanCompact(settings.thematicFiltersBanEnabled)} • KICK ${this.describeBooleanCompact(settings.thematicFiltersKickEnabled)}`,
          `Кнопка: ${this.describeBooleanCompact(settings.thematicFiltersBotButtonEnabled)}`,
        ];
      case 'duplicates':
        return [
          `Антидубли: ${this.describeBooleanCompact(settings.antiDuplicateEnabled)} • бан ${settings.banDurationHours}ч`,
          `WARN: ${this.describeBooleanCompact(settings.duplicateWarnEnabled)} / ${settings.duplicateWarnMaxCount} повт. за ${settings.duplicateWarnWindowSec}с`,
          `KICK: ${this.describeBooleanCompact(settings.duplicateKickEnabled)} / ${settings.duplicateKickMaxCount} повт. за ${settings.duplicateKickWindowSec}с`,
          `BAN: ${this.describeBooleanCompact(settings.duplicateBanEnabled)} / ${settings.duplicateBanMaxCount} повт. за ${settings.duplicateBanWindowSec}с`,
        ];
      case 'limits':
        return [
          `Антиспам: ${this.describeBooleanCompact(settings.antiSpamEnabled)} • макс. длина ${settings.maxMessageLengthEnabled ? settings.maxMessageLength : 'выкл'}`,
          `Медиа: видео ${this.describeBooleanCompact(settings.videoMessagesEnabled)} • файлы ${this.describeBooleanCompact(settings.fileMessagesEnabled)} • голосовые ${this.describeBooleanCompact(settings.voiceMessagesEnabled)}`,
          `Сообщение: ${this.describeBooleanCompact(settings.messageLimitsBotMessageEnabled)} • кнопка ${this.describeBooleanCompact(settings.messageLimitsBotButtonEnabled)}`,
        ];
      case 'night':
        return [
          `Ночной режим: ${this.describeBooleanCompact(settings.nightModeEnabled)}`,
          `Окно: ${this.formatTime(settings.nightModeStartTimeMinutes)}-${this.formatTime(settings.nightModeEndTimeMinutes)} • ${settings.nightModeTimezone || 'не задан'}`,
          `Сообщение: ${this.describeBooleanCompact(settings.nightModeBotMessageEnabled)} • кнопка ${this.describeBooleanCompact(settings.nightModeBotButtonEnabled)}`,
        ];
      case 'extra':
        return [
          `Межчатовый спам: ${this.describeBooleanCompact(settings.globalCrossChatSpamEnabled)}`,
          `Сообщения бота: ${this.describeBooleanCompact(settings.deleteBotMessagesEnabled)} • задержка ${settings.deleteBotMessagesDelayMinutes}м`,
          `Удаление ботов: ${this.describeBooleanCompact(settings.removeBotsFromGroupEnabled)} • глобальный ЧС ${this.describeBooleanCompact(settings.globalUserBlacklistEnabled)}`,
        ];
    }
  }

  private buildSectionActionRows(
    section: PrivateSectionKey,
    settings: ChatSettings,
    view: PrivateSectionView,
  ): MaxMessageButton[][] {
    const fieldConfigs = this.buildSectionFieldConfigs(section, view);
    const rows: MaxMessageButton[][] = [];

    for (const field of fieldConfigs) {
      const currentValue = settings[field.key];
      if (field.type === 'boolean') {
        rows.push([
          this.callbackButton(
            `${Boolean(currentValue) ? '✅' : '⬜'} ${field.label}`,
            this.cb('toggle', section, String(field.key)),
          ),
        ]);
        continue;
      }

      if (field.type === 'enum') {
        rows.push([
          this.callbackButton(
            `🎚 ${field.label}: ${this.compactText(this.formatSettingValue(currentValue, field.type), 20)}`,
            this.cb('noop'),
          ),
        ]);
        rows.push(
          ...(field.enumValues ?? []).map((enumValue) => [
            this.callbackButton(
              `${currentValue === enumValue ? '✅' : '◻️'} ${this.formatEnumValue(enumValue)}`,
              this.cb('set_enum', section, String(field.key), enumValue),
            ),
          ]),
        );
        continue;
      }

      if (field.type === 'number') {
        const numericValue =
          typeof currentValue === 'number' && Number.isFinite(currentValue)
            ? currentValue
            : (field.min ?? 0);
        const step = field.step ?? 1;

        rows.push([
          this.callbackButton(
            '➖',
            this.cb('step_number', section, String(field.key), String(-step)),
          ),
          this.callbackButton(
            `${field.label}: ${this.compactText(String(numericValue), 12)}`,
            this.cb('noop'),
          ),
          this.callbackButton(
            '➕',
            this.cb('step_number', section, String(field.key), String(step)),
          ),
        ]);

        if (field.presets?.length) {
          rows.push(
            field.presets
              .slice(0, 3)
              .map((preset) =>
                this.callbackButton(
                  `${numericValue === preset ? '✅' : '◻️'} ${this.formatNumberPreset(field, preset)}`,
                  this.cb('set_number_preset', section, String(field.key), String(preset)),
                ),
              ),
          );
        }
        continue;
      }

      if (field.type === 'timezone') {
        rows.push([
          this.callbackButton(
            `✏️ ${field.label}`,
            this.cb('set_input', section, String(field.key)),
          ),
        ]);
        continue;
      }

      rows.push([
        this.callbackButton(
          `✏️ ${field.label}: ${this.compactText(this.formatSettingValue(currentValue, field.type), 20)}`,
          this.cb('set_input', section, String(field.key)),
        ),
      ]);
    }

    return rows;
  }

  private buildChannelSectionSummary(
    section: ChannelSectionKey,
    settings: ChannelSettings,
  ): string[] {
    if (section === 'post_suggestions') {
      return [
        `Предложка: ${this.describeBooleanCompact(settings.postSuggestionsEnabled)}`,
        `Кнопка: ${this.describeBooleanCompact(settings.postSuggestionsButtonEnabled)}`,
        `Текст для участников: ${settings.postSuggestionsText.trim() ? 'задан' : 'по умолчанию'}`,
      ];
    }

    return [
      `Обсуждения: ${this.describeBooleanCompact(settings.commentsEnabled)}`,
      `Модерация обсуждений: ${this.describeBooleanCompact(settings.commentsModerationEnabled)}`,
      `Текст-подсказка: ${settings.commentsMessageText.trim() ? 'задан' : 'по умолчанию'}`,
    ];
  }

  private buildChannelSectionRows(
    section: ChannelSectionKey,
    settings: ChannelSettings,
  ): MaxMessageButton[][] {
    const rows: MaxMessageButton[][] = [];
    for (const field of CHANNEL_SECTION_FIELDS[section]) {
      if (field.type === 'boolean') {
        rows.push([
          this.callbackButton(
            `${Boolean(settings[field.key]) ? '✅' : '⬜'} ${field.label}`,
            this.cb('toggle_channel', section, String(field.key)),
          ),
        ]);
        continue;
      }

      rows.push([
        this.callbackButton(
          `✏️ ${field.label}: ${this.compactText(this.formatSettingValue(settings[field.key], field.type), 18)}`,
          this.cb('set_channel_input', section, String(field.key)),
        ),
      ]);
    }

    return rows;
  }

  private describeSectionShortSummary(section: PrivateSectionKey, settings: ChatSettings): string {
    switch (section) {
      case 'links':
        return this.describeLinkPolicy(settings.linkPolicy);
      case 'greeting':
        return settings.greetingEnabled ? 'включено' : 'выключено';
      case 'profanityFilter':
        return settings.russianProfanityFilterEnabled ? 'включено' : 'выключено';
      case 'commercialFilter':
        return settings.commercialAdsFilterEnabled
          ? `активен, ${this.formatEnumValue(settings.commercialAdsSensitivity).toLowerCase()}`
          : 'выключено';
      case 'thematicFilters':
        return settings.thematicCodewordEnabled
          ? settings.thematicCodeword || 'кодовое слово не задано'
          : 'выключено';
      case 'duplicates':
        return settings.antiDuplicateEnabled ? 'активны штрафы за повторы' : 'выключено';
      case 'limits':
        return settings.antiSpamEnabled ? 'антиспам включен' : 'выключено';
      case 'night':
        return settings.nightModeEnabled
          ? `${this.formatTime(settings.nightModeStartTimeMinutes)}-${this.formatTime(settings.nightModeEndTimeMinutes)}`
          : 'выключено';
      case 'extra':
        return settings.globalUserBlacklistEnabled ? 'глобальный ЧС активен' : 'доп. опции';
    }
  }

  private describeLinkPolicy(value: ChatSettings['linkPolicy']): string {
    if (value === 'BLOCKLIST_ONLY') {
      return 'удалять все ссылки';
    }
    if (value === 'ALLOWLIST_ONLY') {
      return 'удалять кроме allowlist';
    }
    return 'только предупреждать';
  }

  private describeBooleanCompact(value: boolean): string {
    return value ? 'вкл' : 'выкл';
  }

  private formatNumberPreset(field: SettingFieldConfig, value: number): string {
    const key = String(field.key).toLowerCase();
    if (key.includes('windowsec')) {
      return value % 3600 === 0 ? `${value / 3600}ч` : `${Math.round(value / 60)}м`;
    }
    if (key.includes('durationhours') || key.includes('cooldownhours')) {
      return `${value}ч`;
    }
    if (key.includes('minutes') || key.includes('cooldownminutes')) {
      return `${value}м`;
    }
    if (key.includes('maxlength')) {
      return `${value} симв.`;
    }
    return String(value);
  }

  private resolveSectionViewForField(
    section: PrivateSectionKey,
    key: keyof ChatSettings,
  ): PrivateSectionView {
    return SECTION_CARD_FIELDS[section].advanced.includes(key) ? 'advanced' : 'basic';
  }

  private pushHistory(session: PrivateSession): void {
    const snapshot = JSON.stringify({
      screen: session.screen,
      section: session.section,
      channelSection: session.channelSection,
      sectionView: session.sectionView,
      homeTab: session.homeTab,
      selectedEntityType: session.selectedEntityType,
      managedGiveawayId: session.managedGiveawayId,
      entityTab: session.entityTab,
      domainPage: session.domainPage,
      eventsPage: session.eventsPage,
      manualPage: session.manualPage,
      logsRange: session.logsRange,
      manualTargetUserId: session.manualTargetUserId,
      searchQuery: session.searchQuery,
      broadcastView: session.broadcastView,
    });

    const stack = session.lastScreenStack.slice(-19);
    stack.push(snapshot);
    session.lastScreenStack = stack;
  }

  private restoreFromHistory(session: PrivateSession): boolean {
    if (session.lastScreenStack.length === 0) {
      return false;
    }

    const raw = session.lastScreenStack.pop();
    if (!raw) {
      return false;
    }

    try {
      const row = JSON.parse(raw) as Record<string, unknown>;
      session.screen = this.parseScreen(row.screen);
      session.section = typeof row.section === 'string' ? this.parseSection(row.section) : null;
      session.channelSection =
        typeof row.channelSection === 'string'
          ? this.parseChannelSection(row.channelSection)
          : null;
      session.sectionView = this.parseSectionView(row.sectionView);
      session.homeTab = this.parseHomeTab(row.homeTab);
      session.selectedEntityType = this.parseEntityType(row.selectedEntityType);
      session.managedGiveawayId =
        typeof row.managedGiveawayId === 'string' && row.managedGiveawayId.trim().length > 0
          ? row.managedGiveawayId.trim()
          : null;
      session.entityTab = this.parseEntityType(row.entityTab) ?? session.entityTab;
      session.domainPage = this.toPositiveInt(row.domainPage, 1);
      session.eventsPage = this.toPositiveInt(row.eventsPage, 1);
      session.manualPage = this.toPositiveInt(row.manualPage, 1);
      session.logsRange = this.parseLogsRange(
        typeof row.logsRange === 'string' ? row.logsRange : undefined,
      );
      session.manualTargetUserId =
        typeof row.manualTargetUserId === 'string' && row.manualTargetUserId.trim().length > 0
          ? row.manualTargetUserId.trim()
          : null;
      session.searchQuery =
        typeof row.searchQuery === 'string' && row.searchQuery.trim().length > 0
          ? row.searchQuery.trim()
          : null;
      session.broadcastView = this.parseBroadcastView(row.broadcastView);
      return true;
    } catch {
      return false;
    }
  }

  private renderHelpView(prefix: string | null = null): PrivateView {
    const lines = [
      ...(prefix ? [prefix, ''] : []),
      'Полезные команды:',
      '- /menu — открыть главное меню',
      '- /chats — выбрать или сменить чат',
      '- /channels — выбрать или сменить канал',
      '- /help — подсказка по управлению',
      '- /reset — сбросить текущую сессию',
      '- /legacy и /modern — совместимые алиасы, оба открывают актуальный интерфейс',
      '',
      'Если бот ждёт ввод, отправьте /cancel для отмены.',
    ];

    return {
      text: lines.join('\n'),
      options: {
        buttons: [
          [this.callbackButton('Главный экран', this.cb('home'))],
          [this.callbackButton('Сменить чат', this.cb('change_chat'))],
          ...this.buildFooterButtons(),
        ],
      },
    };
  }

  private renderInputPrompt(input: PendingInput): PrivateView {
    const prompt = this.describeInputPrompt(input);

    return {
      text: [
        `Что нужно ввести: ${prompt.title}`,
        '',
        prompt.description,
        '',
        'Чтобы отменить, нажмите кнопку ниже или отправьте /cancel.',
      ].join('\n'),
      options: {
        buttons: [
          [this.callbackButton('Отмена', this.cb('input_cancel'))],
          ...this.buildFooterButtons(),
        ],
      },
    };
  }

  private renderMassActionConfirmation(pendingMassAction: PendingMassAction): PrivateView {
    const text =
      pendingMassAction.kind === 'apply_section'
        ? [
            'Подтвердите применение для всех чатов',
            '',
            `Раздел: ${SECTION_LABELS[pendingMassAction.section]}`,
            `Количество чатов: ${pendingMassAction.targetChats}`,
            '',
            'Применить эти настройки во всех доступных чатах?',
          ].join('\n')
        : [
            'Подтвердите массовую рассылку',
            '',
            `Количество чатов: ${pendingMassAction.targetChats}`,
            '',
            'Отправить рассылку во все эти чаты?',
          ].join('\n');

    return {
      text,
      options: {
        buttons: [
          [
            this.callbackButton('Да, подтвердить', this.cb('mass_confirm'), 'positive'),
            this.callbackButton('Отмена', this.cb('mass_cancel'), 'negative'),
          ],
          ...this.buildFooterButtons(),
        ],
      },
    };
  }

  private describeInputPrompt(input: PendingInput): { title: string; description: string } {
    if (input.kind === 'set_field' || input.kind === 'set_channel_field') {
      const fieldConfig =
        input.kind === 'set_field'
          ? this.findFieldConfig(input.section, input.key)
          : this.findChannelFieldConfig(input.section, input.key);
      const label = fieldConfig?.label ?? String(input.key);

      if (input.type === 'number') {
        return {
          title: label,
          description: `Введите число${input.min !== undefined ? ` от ${input.min}` : ''}${input.max !== undefined ? ` до ${input.max}` : ''}.`,
        };
      }

      if (input.type === 'time') {
        return {
          title: label,
          description: 'Введите время в формате HH:MM (например 23:00).',
        };
      }

      if (input.type === 'timezone') {
        return {
          title: label,
          description: 'Введите часовой пояс в формате IANA (например Europe/Moscow).',
        };
      }

      if (input.type === 'url') {
        return {
          title: label,
          description: 'Введите ссылку (http/https). Чтобы очистить значение, отправьте `-`.',
        };
      }

      return {
        title: label,
        description: 'Введите новый текст. Чтобы очистить значение, отправьте `-`.',
      };
    }

    switch (input.kind) {
      case 'broadcast_content':
        return {
          title: 'Контент рассылки',
          description:
            'Отправьте следующим сообщением текст, фото или подпись с фото. Бот добавит это в черновик.',
        };
      case 'search_settings':
        return {
          title: 'Найти настройку',
          description: 'Введите слово или часть названия параметра (минимум 2 символа).',
        };
      case 'add_domain':
        return {
          title: 'Добавить домен в разрешённые',
          description: 'Введите ссылку или домен (например https://example.com или example.com).',
        };
      case 'schedule_domain':
        return {
          title: `Дата удаления для ${input.domain}`,
          description:
            'Введите дату: ISO (2026-03-09T18:30:00+03:00) или ДД.ММ.ГГГГ ЧЧ:ММ. Чтобы убрать дату, отправьте `-`.',
        };
      case 'add_blacklist_user':
        return {
          title: 'Добавить пользователя в глобальный ЧС',
          description: 'Введите user_id.',
        };
      case 'remove_blacklist_user':
        return {
          title: 'Удалить пользователя из глобального ЧС',
          description: 'Введите user_id.',
        };
      case 'broadcast_text':
        return {
          title: 'Текст рассылки',
          description: 'Введите текст рассылки (до 1000 символов).',
        };
      case 'broadcast_button_url':
        return {
          title: 'Ссылка кнопки рассылки',
          description: 'Введите URL кнопки. Чтобы очистить, отправьте `-`.',
        };
      case 'broadcast_button_text':
        return {
          title: 'Текст кнопки рассылки',
          description: 'Введите текст кнопки. Чтобы очистить, отправьте `-`.',
        };
      case 'broadcast_send_at':
        return {
          title: 'Время рассылки',
          description:
            'Введите ISO (2026-03-09T18:30:00+03:00) или ДД.ММ.ГГГГ ЧЧ:ММ. Чтобы отключить таймер, отправьте `-`.',
        };
      case 'broadcast_cycle_every_hours':
        return {
          title: 'Шаг цикла (часы)',
          description: 'Введите число от 1 до 336.',
        };
      case 'broadcast_cycle_count':
        return {
          title: 'Количество повторов цикла',
          description: 'Введите число от 1 до 14.',
        };
      case 'broadcast_photo':
        return {
          title: 'Фото для рассылки',
          description: 'Отправьте фото следующим сообщением. Бот добавит его в черновик.',
        };
      case 'giveaway_title':
        return {
          title: 'Название розыгрыша',
          description: 'Введите короткое название для поста и экрана розыгрыша.',
        };
      case 'giveaway_description':
        return {
          title: 'Описание розыгрыша',
          description: 'Введите описание. Чтобы очистить, отправьте `-`.',
        };
      case 'giveaway_start_at':
        return {
          title: 'Время старта',
          description:
            'Введите ISO (2026-03-09T18:30:00+03:00) или ДД.ММ.ГГГГ ЧЧ:ММ. Чтобы старт был сразу после публикации, отправьте `-`.',
        };
      case 'giveaway_end_at':
        return {
          title: 'Время завершения',
          description:
            'Введите ISO (2026-03-09T18:30:00+03:00) или ДД.ММ.ГГГГ ЧЧ:ММ. Это обязательное поле.',
        };
      case 'giveaway_claim_hours':
        return {
          title: 'Claim-окно',
          description: 'Введите число часов от 1 до 336.',
        };
      case 'giveaway_photo':
        return {
          title: 'Фото розыгрыша',
          description: 'Отправьте фото следующим сообщением. Бот добавит его в черновик.',
        };
      case 'giveaway_prize':
        return {
          title: `Приз ${input.index + 1}`,
          description:
            'Введите название приза для этого места. Если место новое, оно будет добавлено после сообщения.',
        };
      case 'poll_question':
        return {
          title: 'Вопрос опроса',
          description: 'Введите вопрос для опроса.',
        };
      case 'poll_option':
        return {
          title: `Вариант ${input.index + 1}`,
          description: 'Введите текст варианта ответа.',
        };
      case 'manual_ban_duration':
        return {
          title: `Длительность бана для ${input.targetUserId}`,
          description: 'Введите длительность в часах (от 1 до 336).',
        };
    }
  }

  private parseInputValueByType(
    type: SettingFieldType,
    min: number | undefined,
    max: number | undefined,
    rawText: string,
  ): ChatSettings[keyof ChatSettings] | ChannelSettings[keyof ChannelSettings] {
    if (type === 'number') {
      return this.parseIntInput(rawText, min ?? 0, max ?? 1_000_000);
    }

    if (type === 'time') {
      return this.parseTimeToMinutes(rawText);
    }

    if (type === 'timezone') {
      return rawText === '-' ? '' : rawText;
    }

    if (type === 'url' || type === 'text') {
      return rawText === '-' ? '' : rawText;
    }

    throw new BadRequestException('Unsupported field type for input');
  }

  private parseRemovalDateInput(rawText: string): string | null {
    if (!rawText || rawText === '-') {
      return null;
    }

    const parsed = this.parseDateInput(rawText);
    return parsed.toISOString();
  }

  private parseBroadcastSendAt(rawText: string): string | null {
    if (!rawText || rawText === '-') {
      return null;
    }

    const parsed = this.parseDateInput(rawText);
    return parsed.toISOString();
  }

  private parseDateInput(rawText: string): Date {
    const trimmed = rawText.trim();

    const dotDateMatch = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(trimmed);
    if (dotDateMatch) {
      const [, dd, mm, yyyy, hh, min] = dotDateMatch;
      const parsed = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00+03:00`);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    const iso = new Date(trimmed);
    if (Number.isNaN(iso.getTime())) {
      throw new BadRequestException('Не удалось распознать дату и время.');
    }

    return iso;
  }

  private parseIntInput(rawText: string, min: number, max: number): number {
    const parsed = Number.parseInt(rawText, 10);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
      throw new BadRequestException('Введите целое число.');
    }

    if (parsed < min || parsed > max) {
      throw new BadRequestException(`Число должно быть от ${min} до ${max}.`);
    }

    return parsed;
  }

  private parseTimeToMinutes(rawText: string): number {
    const normalized = rawText.trim();
    const match = /^(\d{1,2}):(\d{2})$/.exec(normalized);
    if (!match) {
      throw new BadRequestException('Введите время в формате HH:MM.');
    }

    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    if (
      !Number.isInteger(hours) ||
      !Number.isInteger(minutes) ||
      hours < 0 ||
      hours > 23 ||
      minutes < 0 ||
      minutes > 59
    ) {
      throw new BadRequestException('Время вне допустимого диапазона.');
    }

    return hours * 60 + minutes;
  }

  private formatTime(minutes: number): string {
    const normalized = Math.max(0, Math.min(1439, Math.trunc(minutes)));
    const hours = Math.floor(normalized / 60)
      .toString()
      .padStart(2, '0');
    const mins = (normalized % 60).toString().padStart(2, '0');
    return `${hours}:${mins}`;
  }

  private formatSettingValue(value: unknown, type: SettingFieldType): string {
    if (type === 'boolean') {
      return value ? 'Включено' : 'Выключено';
    }

    if (type === 'time' && typeof value === 'number') {
      return this.formatTime(value);
    }

    if (type === 'enum' && typeof value === 'string') {
      return this.formatEnumValue(value);
    }

    if (value === null || value === undefined) {
      return '—';
    }

    if (typeof value === 'string') {
      return value.trim() ? this.compactText(value, 64) : '—';
    }

    return String(value);
  }

  private formatEnumValue(value: string): string {
    if (value === 'ALLOWLIST_ONLY') {
      return 'Разрешать только домены из списка разрешённых';
    }
    if (value === 'BLOCKLIST_ONLY') {
      return 'Удалять домены из списка запрещённых';
    }
    if (value === 'ALERT_ONLY') {
      return 'Только предупреждать';
    }
    if (value === 'BALANCED') {
      return 'Сбалансированный';
    }
    if (value === 'STRICT') {
      return 'Строгий';
    }
    return value;
  }

  private parseSection(value: string | undefined): PrivateSectionKey | null {
    if (!value) {
      return null;
    }

    return SECTION_ORDER.includes(value as PrivateSectionKey) ? (value as PrivateSectionKey) : null;
  }

  private parseChannelSection(value: string | undefined): ChannelSectionKey | null {
    if (value === 'post_suggestions' || value === 'comments') {
      return value;
    }

    return null;
  }

  private parseLogsRange(value: string | undefined): LogsDashboardRange {
    if (value === '24h' || value === '7d' || value === '30d') {
      return value;
    }

    return '7d';
  }

  private findFieldConfig(
    section: PrivateSectionKey,
    key: keyof ChatSettings,
  ): SettingFieldConfig | null {
    const fields = SECTION_FIELDS[section];
    return fields.find((field) => field.key === key) ?? null;
  }

  private findChannelFieldConfig(
    section: ChannelSectionKey,
    key: keyof ChannelSettings,
  ): {
    key: keyof ChannelSettings;
    label: string;
    type: SettingFieldType;
    min?: number;
    max?: number;
  } | null {
    const fields = CHANNEL_SECTION_FIELDS[section];
    return fields.find((field) => field.key === key) ?? null;
  }

  private toggleBroadcastFlag(session: PrivateSession, flag: string): void {
    if (flag === 'apply_to_all') {
      if (session.selectedEntityType === 'channel') {
        session.broadcastDraft.applyToAllChats = false;
        return;
      }
      session.broadcastDraft.applyToAllChats = !session.broadcastDraft.applyToAllChats;
      return;
    }

    if (flag === 'button_enabled') {
      const next = !session.broadcastDraft.buttonEnabled;
      session.broadcastDraft.buttonEnabled = next;
      if (!next) {
        session.broadcastDraft.buttonUrl = '';
        session.broadcastDraft.buttonText = '';
      }
      return;
    }

    if (flag === 'image_enabled') {
      const next = !session.broadcastDraft.imageEnabled;
      session.broadcastDraft.imageEnabled = next;
      if (!next) {
        session.broadcastDraft.imageBase64 = '';
        session.broadcastDraft.imageMimeType = '';
        session.broadcastDraft.imageFileName = '';
      }
      return;
    }

    if (flag === 'cycle_enabled') {
      const next = !session.broadcastDraft.cycleEnabled;
      session.broadcastDraft.cycleEnabled = next;
      if (!next) {
        session.broadcastDraft.cycleEveryHours = 24;
        session.broadcastDraft.cycleCount = 1;
      }
    }
  }

  private buildBroadcastPendingInput(flag: string): PendingInput | null {
    if (flag === 'content') {
      return { kind: 'broadcast_content' };
    }

    if (flag === 'text') {
      return { kind: 'broadcast_text' };
    }

    if (flag === 'button_url') {
      return { kind: 'broadcast_button_url' };
    }

    if (flag === 'button_text') {
      return { kind: 'broadcast_button_text' };
    }

    if (flag === 'send_at') {
      return { kind: 'broadcast_send_at' };
    }

    if (flag === 'cycle_hours') {
      return { kind: 'broadcast_cycle_every_hours' };
    }

    if (flag === 'cycle_count') {
      return { kind: 'broadcast_cycle_count' };
    }

    if (flag === 'photo') {
      return { kind: 'broadcast_photo' };
    }

    return null;
  }

  private async respond(
    context: PrivateContext,
    session: PrivateSession,
    view: PrivateView,
    callback: { callbackId: string | null; notification: string | null },
  ): Promise<void> {
    await this.saveSession(context.actor.userId, session);

    const text = this.limitMessageText(view.text);
    const options = this.withDebugContext(view.options, session, callback.notification);

    if (callback.callbackId) {
      const edited = await this.tryAnswerWithEdit(
        callback.callbackId,
        callback.notification ?? 'Готово',
        text,
        options,
      );
      if (edited) {
        return;
      }

      await this.answerCallbackQuiet(callback.callbackId, callback.notification ?? 'Готово');
    }

    await this.sendImmediate(context.chatId, text, options);
  }

  private async sendImmediate(
    chatId: string,
    text: string,
    options?: MaxSendMessageOptions,
  ): Promise<void> {
    await this.maxClient.sendMessage(chatId, text, options, { immediate: true });
  }

  private withDebugContext(
    options: MaxSendMessageOptions | undefined,
    session: PrivateSession,
    action: string | null,
  ): MaxSendMessageOptions | undefined {
    if (!options) {
      return undefined;
    }

    return {
      ...options,
      debugContext: {
        ...(options.debugContext ?? {}),
        screen: session.screen,
        ...(action ? { action: action.slice(0, 64) } : {}),
      },
    };
  }

  private async tryAnswerWithEdit(
    callbackId: string,
    notification: string,
    text: string,
    options?: MaxSendMessageOptions,
  ): Promise<boolean> {
    try {
      await this.maxClient.answerCallback(callbackId, notification, {
        text,
        options,
      });
      return true;
    } catch (error: unknown) {
      this.logger.debug(
        {
          callbackId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Callback edit failed, fallback to sendMessage',
      );
      return false;
    }
  }

  private async answerCallbackQuiet(callbackId: string, notification: string): Promise<void> {
    try {
      await this.maxClient.answerCallback(callbackId, notification);
    } catch (error: unknown) {
      this.logger.debug(
        {
          callbackId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Callback answer failed',
      );
    }
  }

  private callbackButton(
    text: string,
    payload: string,
    intent: 'default' | 'positive' | 'negative' = 'default',
  ): MaxMessageButton {
    return {
      type: 'callback',
      text: this.compactText(text, 48),
      payload,
      intent,
    };
  }

  private buildFooterButtons(): MaxMessageButton[][] {
    const row: MaxMessageButton[] = [];
    const miniappUrl = this.resolveMiniappUrl();
    const botContactId = this.resolveBotContactId();

    if (miniappUrl && botContactId) {
      row.push({
        type: 'open_app',
        text: 'Открыть приложение',
        webApp: miniappUrl,
        contactId: botContactId,
      });
    } else if (miniappUrl) {
      row.push({
        type: 'link',
        text: 'Открыть приложение',
        url: miniappUrl,
      });
    }

    row.push({
      type: 'link',
      text: 'Поддержка',
      url: SUPPORT_CHAT_URL,
    });

    return [row];
  }

  private buildMiniappOpenButton(text: string, webAppUrl: string): MaxMessageButton {
    const botContactId = this.resolveBotContactId();
    if (botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    return {
      type: 'link',
      text,
      url: webAppUrl,
    };
  }

  private paginationButtons(page: number, pages: number, action: string): MaxMessageButton[] {
    return [
      this.callbackButton('⬅️', this.cb(action, String(Math.max(1, page - 1)))),
      this.callbackButton(`${page}/${pages}`, this.cb('noop')),
      this.callbackButton('➡️', this.cb(action, String(Math.min(pages, page + 1)))),
    ];
  }

  private cb(action: string, ...args: string[]): string {
    const filtered = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
    return [MAX_CALLBACK_PREFIX, action, ...filtered].join('|');
  }

  private resolveMiniappUrl(): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app/`;
  }

  private buildBotStartUrl(startPayload: string): string | null {
    if (!this.botDeepLinkId) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.botDeepLinkId)}?start=${encodeURIComponent(startPayload)}`;
  }

  private resolveBotContactId(): string | null {
    if (this.explicitBotContactId) {
      return this.explicitBotContactId;
    }

    if (!this.ownBotUserId) {
      return null;
    }

    const [candidate] = this.ownBotUserId.split('_');
    return /^\d+$/.test(candidate) ? candidate : null;
  }

  private normalizeBotContactId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized || !/^\d+$/.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private normalizeBotDeepLinkId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private parseCallbackAction(payload: string | null): CallbackAction | null {
    if (!payload) {
      return null;
    }

    const parts = payload.split('|');
    if (parts.length < 2) {
      return null;
    }

    if (parts[0] !== MAX_CALLBACK_PREFIX && parts[0] !== LEGACY_CALLBACK_PREFIX) {
      return null;
    }

    return {
      action: parts[1],
      args: parts.slice(2),
    };
  }

  private isStaleLegacyCallbackPayload(payload: string | null): boolean {
    if (!payload) {
      return false;
    }

    const normalized = payload.trim().toLowerCase();
    return normalized.startsWith('private_menu:');
  }

  private extractBotStartedStartPayload(update: MaxUpdate): string | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const candidates = [
      raw,
      this.asRecord(raw.bot_started),
      data,
      data ? this.asRecord(data.bot_started) : null,
      event,
      event ? this.asRecord(event.bot_started) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const value =
        candidate.start_payload ??
        candidate.startPayload ??
        candidate.payload ??
        candidate.start;

      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return null;
  }

  private resolveContext(update: MaxUpdate): PrivateContext | null {
    const message = update.message;
    if (!message) {
      return null;
    }

    if (!this.isPrivateDirectChat(message.chatId)) {
      return null;
    }

    const callbackId = this.extractCallbackId(update);
    const callbackPayload = this.extractCallbackPayload(update);
    const actorFromCallback = this.extractCallbackUser(update);

    const actorUserId = actorFromCallback.userId ?? this.normalizeUserId(message.senderId);
    if (!actorUserId) {
      return null;
    }

    if (this.isOwnBotSender(actorUserId)) {
      return null;
    }

    const actor: AuthUser = {
      userId: actorUserId,
      username: null,
      displayName: actorFromCallback.displayName ?? message.senderName ?? null,
      chatId: message.chatId,
      chatTitle: message.chatTitle ?? null,
    };

    return {
      update,
      chatId: message.chatId,
      actor,
      text: typeof message.text === 'string' ? message.text : '',
      callbackId,
      callbackPayload,
    };
  }

  private extractCallbackUser(update: MaxUpdate): {
    userId: string | null;
    displayName: string | null;
  } {
    const callback = this.extractCallbackNode(update);
    if (!callback) {
      return {
        userId: null,
        displayName: null,
      };
    }

    const user = this.asRecord(callback.user);
    if (!user) {
      return {
        userId: null,
        displayName: null,
      };
    }

    const userId = this.normalizeUserId(user.user_id ?? user.userId ?? user.id);
    const displayName = this.readString(
      user.display_name ??
        user.displayName ??
        user.name ??
        user.full_name ??
        user.fullName ??
        user.nickname,
    );

    if (displayName) {
      return {
        userId,
        displayName,
      };
    }

    const firstName = this.readString(
      user.first_name ?? user.firstName ?? user.given_name ?? user.givenName,
    );
    const lastName = this.readString(
      user.last_name ?? user.lastName ?? user.family_name ?? user.familyName,
    );

    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

    return {
      userId,
      displayName: fullName || null,
    };
  }

  private extractCallbackNode(update: MaxUpdate): Record<string, unknown> | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const candidates = [
      this.asRecord(raw.callback),
      this.asRecord(raw.message_callback),
      data ? this.asRecord(data.callback) : null,
      data ? this.asRecord(data.message_callback) : null,
      event ? this.asRecord(event.callback) : null,
      event ? this.asRecord(event.message_callback) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const nested = this.asRecord(candidate.callback);
      if (nested) {
        return nested;
      }

      if (
        candidate.callback_id !== undefined ||
        candidate.callbackId !== undefined ||
        candidate.payload !== undefined
      ) {
        return candidate;
      }
    }

    return null;
  }

  private extractCallbackId(update: MaxUpdate): string | null {
    const callback = this.extractCallbackNode(update);
    if (!callback) {
      return null;
    }

    const value = callback.callback_id ?? callback.callbackId ?? callback.id;
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private extractCallbackPayload(update: MaxUpdate): string | null {
    const callback = this.extractCallbackNode(update);
    if (!callback) {
      return null;
    }

    const value = callback.payload ?? callback.data;
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private extractFirstImageAttachment(update: MaxUpdate): ParsedImageAttachment | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const messageCandidates = [
      this.asRecord(raw.message),
      this.asRecord(this.asRecord(raw.data)?.message),
      this.asRecord(this.asRecord(raw.event)?.message),
    ].filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));

    for (const message of messageCandidates) {
      const body = this.asRecord(message.body);
      const candidates = [
        message.attachments,
        body?.attachments,
        this.asRecord(message.data)?.attachments,
        this.asRecord(message.payload)?.attachments,
      ];

      for (const node of candidates) {
        if (!Array.isArray(node)) {
          continue;
        }

        for (const attachment of node) {
          if (!attachment || typeof attachment !== 'object') {
            continue;
          }

          const row = attachment as Record<string, unknown>;
          const type = this.readLowerString(row.type);
          if (type !== 'image') {
            continue;
          }

          const payload = this.asRecord(row.payload);
          if (!payload) {
            continue;
          }

          const url = this.readString(payload.url);
          if (!url) {
            continue;
          }

          return {
            url,
            token: this.readString(payload.token) ?? null,
            photoId: this.normalizeUserId(payload.photo_id ?? payload.photoId) ?? null,
          };
        }
      }
    }

    return null;
  }

  private hasVideoAttachment(update: MaxUpdate): boolean {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return false;
    }

    const messageCandidates = [
      this.asRecord(raw.message),
      this.asRecord(this.asRecord(raw.data)?.message),
      this.asRecord(this.asRecord(raw.event)?.message),
    ].filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));

    for (const message of messageCandidates) {
      const body = this.asRecord(message.body);
      const candidates = [
        message.attachments,
        body?.attachments,
        this.asRecord(message.data)?.attachments,
        this.asRecord(message.payload)?.attachments,
      ];

      for (const node of candidates) {
        if (!Array.isArray(node)) {
          continue;
        }

        for (const attachment of node) {
          if (!attachment || typeof attachment !== 'object') {
            continue;
          }

          const row = attachment as Record<string, unknown>;
          const type = this.readLowerString(row.type);
          const payload = this.asRecord(row.payload);
          const mimeType = this.readLowerString(payload?.mime_type ?? payload?.mimeType);

          if (type === 'video' || mimeType?.startsWith('video/')) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private async downloadImageAttachment(
    imageAttachment: ParsedImageAttachment,
    filePrefix = 'private-broadcast',
  ): Promise<{ base64: string; mimeType: string; fileName: string }> {
    const timeout = setTimeout(() => {
      controller.abort();
    }, 10_000);
    const controller = new AbortController();

    try {
      const response = await fetch(imageAttachment.url, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new BadRequestException(`Не удалось загрузить фото (${response.status}).`);
      }

      const mimeTypeHeader = response.headers.get('content-type') ?? '';
      const mimeType = mimeTypeHeader.toLowerCase().startsWith('image/')
        ? mimeTypeHeader.split(';')[0].trim().toLowerCase()
        : 'image/jpeg';

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) {
        throw new BadRequestException('Фото оказалось пустым.');
      }

      const extension = this.extensionFromMimeType(mimeType);
      const fileName = imageAttachment.photoId
        ? `${filePrefix}-${imageAttachment.photoId}.${extension}`
        : `${filePrefix}-${Date.now()}.${extension}`;

      return {
        base64: buffer.toString('base64'),
        mimeType,
        fileName,
      };
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('Не удалось загрузить фото из сообщения.');
    } finally {
      clearTimeout(timeout);
    }
  }

  private extensionFromMimeType(mimeType: string): string {
    if (mimeType === 'image/png') {
      return 'png';
    }
    if (mimeType === 'image/webp') {
      return 'webp';
    }
    if (mimeType === 'image/gif') {
      return 'gif';
    }
    if (mimeType === 'image/heic') {
      return 'heic';
    }

    return 'jpg';
  }

  private resolvePrimaryScreen(session: PrivateSession): PrivateScreen {
    return session.selectedChatId ? 'home' : 'chat_select';
  }

  private assertChatSelected(
    session: PrivateSession,
  ): asserts session is PrivateSession & { selectedChatId: string } {
    if (!session.selectedChatId) {
      throw new BadRequestException('Сначала выберите чат.');
    }
  }

  private assertSelectedEntityType(
    session: PrivateSession,
    entityType: ManagedEntityType,
  ): asserts session is PrivateSession & {
    selectedChatId: string;
    selectedEntityType: ManagedEntityType;
  } {
    if (!session.selectedChatId) {
      throw new BadRequestException(
        entityType === 'channel' ? 'Сначала выберите канал.' : 'Сначала выберите чат.',
      );
    }

    const selectedEntityType = session.selectedEntityType ?? 'chat';
    if (selectedEntityType !== entityType) {
      throw new BadRequestException(
        entityType === 'channel'
          ? 'Этот раздел доступен только для каналов.'
          : 'Этот раздел доступен только для чатов.',
      );
    }
  }

  private normalizeCommand(text: string): string | null {
    if (typeof text !== 'string') {
      return null;
    }

    const normalized = text.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private isPrivateDirectChat(chatId: string): boolean {
    const numericChatId = this.parseChatIdAsBigInt(chatId);
    return numericChatId !== null && numericChatId > 0n;
  }

  private parseChatIdAsBigInt(chatId: string): bigint | null {
    if (typeof chatId !== 'string') {
      return null;
    }

    const normalized = chatId.trim();
    if (!/^-?\d+$/.test(normalized)) {
      return null;
    }

    try {
      return BigInt(normalized);
    } catch {
      return null;
    }
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (!value || typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = trimmed.replace(/^id/i, '').replace(/_bot$/i, '').trim();
    return normalized.length > 0 ? normalized : null;
  }

  private buildBotIdVariants(normalizedBotId: string | null): Set<string> {
    const variants = new Set<string>();
    if (!normalizedBotId) {
      return variants;
    }

    variants.add(normalizedBotId);
    variants.add(`id${normalizedBotId}`);
    variants.add(`id${normalizedBotId}_bot`);
    variants.add(`${normalizedBotId}_bot`);

    return variants;
  }

  private normalizeUserId(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private isOwnBotSender(userId: string): boolean {
    if (!userId) {
      return false;
    }

    const normalized = userId.trim();
    if (!normalized) {
      return false;
    }

    if (this.ownBotUserIdVariants.has(normalized)) {
      return true;
    }

    const collapsed = normalized.replace(/^id/i, '').replace(/_bot$/i, '').trim();
    if (!collapsed) {
      return false;
    }

    return this.ownBotUserIdVariants.has(collapsed);
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.replace(/\/+$/, '');
  }

  private async loadSession(userId: string): Promise<PrivateSession> {
    const sessionKey = this.sessionKey(userId);
    if (this.redisCounter) {
      const raw = await this.redisCounter.getString(sessionKey);
      if (raw) {
        try {
          return this.normalizeSession(JSON.parse(raw));
        } catch (error: unknown) {
          this.logger.warn(
            {
              userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to parse private control session from redis',
          );
        }
      }
    }

    const memory = this.memorySession.get(sessionKey);
    if (memory && memory.expiresAt > Date.now()) {
      return this.normalizeSession(memory.session);
    }

    return this.createDefaultSession();
  }

  private async saveSession(userId: string, session: PrivateSession): Promise<void> {
    const normalized = this.normalizeSession(session);
    const sessionKey = this.sessionKey(userId);

    if (this.redisCounter) {
      await this.redisCounter.setStringWithTtl(
        sessionKey,
        JSON.stringify(normalized),
        SESSION_TTL_SEC,
      );
      return;
    }

    this.memorySession.set(sessionKey, {
      expiresAt: Date.now() + SESSION_TTL_SEC * 1_000,
      session: normalized,
    });
  }

  private createDefaultSession(): PrivateSession {
    return {
      version: 3,
      selectedChatId: null,
      selectedEntityType: null,
      managedGiveawayId: null,
      entityTab: 'chat',
      uiMode: 'modern',
      screen: 'chat_select',
      homeTab: 'quick',
      sectionView: 'basic',
      searchQuery: null,
      lastScreenStack: [],
      broadcastView: 'basic',
      section: null,
      channelSection: null,
      chatPage: 1,
      domainPage: 1,
      eventsPage: 1,
      manualPage: 1,
      logsRange: '7d',
      manualTargetUserId: null,
      pendingInput: null,
      pendingMassAction: null,
      broadcastDraft: {
        ...DEFAULT_BROADCAST_DRAFT,
      },
      pollDraft: {
        ...DEFAULT_POLL_DRAFT,
        options: [...DEFAULT_POLL_DRAFT.options],
      },
    };
  }

  private normalizeSession(raw: unknown): PrivateSession {
    const fallback = this.createDefaultSession();
    if (!raw || typeof raw !== 'object') {
      return fallback;
    }

    const row = raw as Partial<PrivateSession>;
    const selectedChatId =
      typeof row.selectedChatId === 'string' && row.selectedChatId.trim().length > 0
        ? row.selectedChatId.trim()
        : null;
    const parsedSelectedEntityType = this.parseEntityType(row.selectedEntityType);

    return {
      version: 3,
      selectedChatId,
      selectedEntityType: parsedSelectedEntityType ?? (selectedChatId ? 'chat' : null),
      managedGiveawayId:
        typeof row.managedGiveawayId === 'string' && row.managedGiveawayId.trim().length > 0
          ? row.managedGiveawayId.trim()
          : null,
      entityTab: this.parseEntityType(row.entityTab) ?? parsedSelectedEntityType ?? 'chat',
      uiMode: this.parseUiMode(row.uiMode),
      screen: this.parseScreen(row.screen),
      homeTab: this.parseHomeTab(row.homeTab),
      sectionView: this.parseSectionView(row.sectionView),
      searchQuery:
        typeof row.searchQuery === 'string' && row.searchQuery.trim().length > 0
          ? row.searchQuery.trim()
          : null,
      lastScreenStack: Array.isArray(row.lastScreenStack)
        ? row.lastScreenStack
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .slice(-20)
        : [],
      broadcastView: this.parseBroadcastView(row.broadcastView),
      section: this.parseSection(typeof row.section === 'string' ? row.section : undefined),
      channelSection: this.parseChannelSection(
        typeof row.channelSection === 'string' ? row.channelSection : undefined,
      ),
      chatPage: this.toPositiveInt(row.chatPage, 1),
      domainPage: this.toPositiveInt(row.domainPage, 1),
      eventsPage: this.toPositiveInt(row.eventsPage, 1),
      manualPage: this.toPositiveInt(row.manualPage, 1),
      logsRange: this.parseLogsRange(typeof row.logsRange === 'string' ? row.logsRange : undefined),
      manualTargetUserId:
        typeof row.manualTargetUserId === 'string' && row.manualTargetUserId.trim().length > 0
          ? row.manualTargetUserId.trim()
          : null,
      pendingInput: this.normalizePendingInput(row.pendingInput),
      pendingMassAction: this.normalizePendingMassAction(row.pendingMassAction),
      broadcastDraft: this.normalizeBroadcastDraft(row.broadcastDraft),
      pollDraft: this.normalizePollDraft(row.pollDraft),
    };
  }

  private normalizePendingInput(raw: unknown): PendingInput | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const row = raw as Partial<PendingInput> & Record<string, unknown>;
    const kind = typeof row.kind === 'string' ? row.kind : null;
    if (!kind) {
      return null;
    }

    if (kind === 'set_field') {
      const section = this.parseSection(typeof row.section === 'string' ? row.section : undefined);
      const key = typeof row.key === 'string' ? (row.key as keyof ChatSettings) : null;
      const type = this.parseSettingFieldType(typeof row.type === 'string' ? row.type : undefined);
      if (!section || !key || !type) {
        return null;
      }

      return {
        kind,
        section,
        key,
        type,
        min: typeof row.min === 'number' ? row.min : undefined,
        max: typeof row.max === 'number' ? row.max : undefined,
      };
    }

    if (kind === 'set_channel_field') {
      const section = this.parseChannelSection(
        typeof row.section === 'string' ? row.section : undefined,
      );
      const key = typeof row.key === 'string' ? (row.key as keyof ChannelSettings) : null;
      const type = this.parseSettingFieldType(typeof row.type === 'string' ? row.type : undefined);
      if (!section || !key || !type) {
        return null;
      }

      return {
        kind,
        section,
        key,
        type,
        min: typeof row.min === 'number' ? row.min : undefined,
        max: typeof row.max === 'number' ? row.max : undefined,
      };
    }

    if (kind === 'schedule_domain') {
      if (typeof row.domain !== 'string' || !row.domain.trim()) {
        return null;
      }
      return {
        kind,
        domain: row.domain.trim(),
      };
    }

    if (kind === 'manual_ban_duration') {
      if (typeof row.targetUserId !== 'string' || !row.targetUserId.trim()) {
        return null;
      }
      return {
        kind,
        targetUserId: row.targetUserId.trim(),
      };
    }

    if (kind === 'giveaway_prize') {
      const index = this.toPositiveInt(row.index, 1) - 1;
      return {
        kind,
        index: Math.max(0, index),
      };
    }

    if (kind === 'poll_option') {
      const index = this.toPositiveInt(row.index, 1) - 1;
      return {
        kind,
        index: Math.max(0, index),
      };
    }

    const allowedKinds: PendingInput['kind'][] = [
      'search_settings',
      'add_domain',
      'add_blacklist_user',
      'remove_blacklist_user',
      'broadcast_content',
      'broadcast_text',
      'broadcast_button_url',
      'broadcast_button_text',
      'broadcast_send_at',
      'broadcast_cycle_every_hours',
      'broadcast_cycle_count',
      'broadcast_photo',
      'giveaway_title',
      'giveaway_description',
      'giveaway_start_at',
      'giveaway_end_at',
      'giveaway_claim_hours',
      'giveaway_photo',
      'poll_question',
    ];

    if (allowedKinds.includes(kind as PendingInput['kind'])) {
      return {
        kind: kind as PendingInput['kind'],
      } as PendingInput;
    }

    return null;
  }

  private parseSettingFieldType(value: string | undefined): SettingFieldType | null {
    if (
      value === 'boolean' ||
      value === 'number' ||
      value === 'text' ||
      value === 'url' ||
      value === 'enum' ||
      value === 'time' ||
      value === 'timezone'
    ) {
      return value;
    }

    return null;
  }

  private normalizePendingMassAction(raw: unknown): PendingMassAction | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const row = raw as Partial<PendingMassAction> & Record<string, unknown>;
    if (row.kind === 'apply_section') {
      const section = this.parseSection(typeof row.section === 'string' ? row.section : undefined);
      if (!section) {
        return null;
      }

      return {
        kind: 'apply_section',
        section,
        targetChats: this.toPositiveInt(row.targetChats, 1),
      };
    }

    if (row.kind === 'broadcast') {
      return {
        kind: 'broadcast',
        targetChats: this.toPositiveInt(row.targetChats, 1),
      };
    }

    return null;
  }

  private normalizeBroadcastDraft(raw: unknown): PrivateBroadcastDraft {
    if (!raw || typeof raw !== 'object') {
      return {
        ...DEFAULT_BROADCAST_DRAFT,
      };
    }

    const row = raw as Partial<PrivateBroadcastDraft>;

    return {
      text: typeof row.text === 'string' ? row.text : '',
      applyToAllChats: row.applyToAllChats === true,
      buttonEnabled: row.buttonEnabled === true,
      buttonUrl: typeof row.buttonUrl === 'string' ? row.buttonUrl : '',
      buttonText:
        typeof row.buttonText === 'string' && row.buttonText.trim().length > 0
          ? row.buttonText
          : 'Открыть',
      imageEnabled: row.imageEnabled === true,
      imageBase64: typeof row.imageBase64 === 'string' ? row.imageBase64 : '',
      imageMimeType: typeof row.imageMimeType === 'string' ? row.imageMimeType : '',
      imageFileName: typeof row.imageFileName === 'string' ? row.imageFileName : '',
      sendAt: typeof row.sendAt === 'string' ? row.sendAt : null,
      cycleEnabled: row.cycleEnabled === true,
      cycleEveryHours: this.toPositiveInt(
        (row as Partial<PrivateBroadcastDraft> & { cycleEveryDays?: unknown }).cycleEveryHours ??
          (typeof (row as { cycleEveryDays?: unknown }).cycleEveryDays === 'number'
            ? Number((row as { cycleEveryDays?: unknown }).cycleEveryDays) * 24
            : undefined),
        24,
      ),
      cycleCount: this.toPositiveInt(row.cycleCount, 1),
    };
  }

  private normalizePollDraft(raw: unknown): PrivatePollDraft {
    if (!raw || typeof raw !== 'object') {
      return {
        ...DEFAULT_POLL_DRAFT,
        options: [...DEFAULT_POLL_DRAFT.options],
      };
    }

    const row = raw as Partial<PrivatePollDraft>;
    const question = typeof row.question === 'string' ? row.question : '';
    const rawOptions = Array.isArray(row.options)
      ? row.options.filter((item): item is string => typeof item === 'string')
      : [];
    const safeOptions = rawOptions.slice(0, MANAGED_POLL_MAX_OPTIONS);

    while (safeOptions.length < MANAGED_POLL_MIN_OPTIONS) {
      safeOptions.push('');
    }

    return {
      question,
      options: safeOptions,
    };
  }

  private parseScreen(value: unknown): PrivateScreen {
    if (
      value === 'chat_select' ||
      value === 'home' ||
      value === 'settings_hub' ||
      value === 'section' ||
      value === 'channel_section' ||
      value === 'domains' ||
      value === 'global_blacklist' ||
      value === 'broadcast' ||
      value === 'poll' ||
      value === 'giveaway' ||
      value === 'events' ||
      value === 'logs' ||
      value === 'search' ||
      value === 'manual_users' ||
      value === 'manual_actions'
    ) {
      return value;
    }

    if (value === 'main') {
      return 'home';
    }

    return 'chat_select';
  }

  private parseEntityType(value: unknown): ManagedEntityType | null {
    if (value === 'chat' || value === 'channel') {
      return value;
    }

    return null;
  }

  private parseUiMode(value: unknown): PrivateUiMode {
    return 'modern';
  }

  private parseHomeTab(value: unknown): PrivateHomeTab {
    return value === 'all' ? 'all' : 'quick';
  }

  private parseSectionView(value: unknown): PrivateSectionView {
    return value === 'advanced' ? 'advanced' : 'basic';
  }

  private parseBroadcastView(value: unknown): PrivateBroadcastView {
    return value === 'advanced' ? 'advanced' : 'basic';
  }

  private sessionKey(userId: string): string {
    return `${SESSION_KEY_PREFIX}:${userId}`;
  }

  private toPositiveInt(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const rounded = Math.trunc(value);
      return rounded > 0 ? rounded : fallback;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return fallback;
  }

  private paginate<T>(items: T[], rawPage: number, pageSize: number) {
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.max(1, Math.min(pages, rawPage));
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, items.length);

    return {
      items: items.slice(start, end),
      page,
      pages,
      start,
      end,
    };
  }

  private limitMessageText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) {
      return ' ';
    }

    if (trimmed.length <= 4000) {
      return trimmed;
    }

    const hardLimit = 3990;
    const chunk = trimmed.slice(0, hardLimit);
    const newlineIndex = chunk.lastIndexOf('\n');
    if (newlineIndex > 120) {
      return `${chunk.slice(0, newlineIndex).trimEnd()}\n...`;
    }

    return `${chunk.trimEnd()}...`;
  }

  private compactText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
  }

  private formatIsoDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }

    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  private formatDateTimeLabel(iso: string | null): string {
    if (!iso) {
      return 'не задано';
    }

    return this.formatIsoDate(iso);
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private readLowerString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }
}
