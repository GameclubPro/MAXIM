import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  broadcastHandoffStateSchema,
  formatDeleteBotMessagesDelayLabel,
  managedGiveawayHandoffRequestSchema,
  profileMentionHandoffRequestSchema,
  stepDeleteBotMessagesDelayMinutes,
  type BroadcastTextFormat,
  type BroadcastHandoffState,
  type BroadcastHandoffResponse,
  type BroadcastScheduleMode,
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
  type SendBroadcastResult,
  type UpdateManagedGiveawayRequest,
} from '@maxim/contracts';
import { AdminService } from '../admin/admin.service';
import { ManagedGiveawayService } from '../admin/managed-giveaway.service';
import {
  containsSupportedMarkdownSyntax,
  renderSupportedMarkdownAsHtml,
} from '../common/max-markdown.util';
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
  | { kind: 'broadcast_content' }
  | { kind: 'broadcast_text' }
  | { kind: 'broadcast_button_url' }
  | { kind: 'broadcast_button_text' }
  | { kind: 'broadcast_send_at' }
  | { kind: 'broadcast_cycle_every_hours' }
  | { kind: 'broadcast_cycle_count' }
  | { kind: 'broadcast_photo' }
  | { kind: 'rules_text' }
  | { kind: 'rules_photo' }
  | { kind: 'channel_suggestion'; chatId: string; token: string }
  | { kind: 'giveaway_title' }
  | { kind: 'giveaway_content' }
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
  textFormat: BroadcastTextFormat;
  applyToAllChats: boolean;
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
  scheduleMode: BroadcastScheduleMode;
  scheduleTimezone: string;
  scheduledSlots: string[];
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
  | 'rules'
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
  lastPrivateChatId: string | null;
  lastGiveawayHandoffDeliveredChatId: string | null;
  lastGiveawayHandoffDeliveredAt: number | null;
  lastProfileMentionHandoffDeliveredChatId: string | null;
  lastProfileMentionHandoffDeliveredAt: number | null;
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

type IncomingMessageMarkup = {
  from: number;
  length: number;
  type:
    | 'emphasized'
    | 'heading'
    | 'link'
    | 'monospaced'
    | 'strikethrough'
    | 'strong'
    | 'underline'
    | 'user_mention';
  url: string | null;
  userLink: string | null;
};

type PrivateView = {
  text: string;
  options?: MaxSendMessageOptions;
};

type CallbackAction = {
  action: string;
  args: string[];
};

type GiveawayHandoffStartPayload = {
  v: 1;
  k: 'giveaway-handoff';
  c: string;
  e: ManagedEntityType;
  g: string | null;
};

type ProfileMentionStartPayload = {
  v: 1;
  k: 'profile-mention';
  c: string;
  e: ManagedEntityType;
  u: string;
  n: string;
};

type ParsedImageAttachment = {
  url: string;
  token: string | null;
  photoId: string | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  mediaType: string | null;
  payloadKeys: string[];
};

type ParsedImageFileAttachment = {
  url: string;
  token: string | null;
  fileId: string | null;
  fileName: string | null;
  size: number | null;
  mimeType: string | null;
  mediaType: string | null;
  payloadKeys: string[];
};

type ParsedImageSourceAttachment =
  | {
      kind: 'image';
      attachment: ParsedImageAttachment;
    }
  | {
      kind: 'file';
      attachment: ParsedImageFileAttachment;
    };

type ParsedFileAttachment = {
  url: string | null;
  token: string | null;
  fileId: string | null;
  fileName: string | null;
  size: number | null;
  mimeType: string | null;
  mediaType: string | null;
  payloadKeys: string[];
};

type DownloadedImageAsset = {
  base64: string;
  mimeType: string;
  fileName: string;
};

type ForwardedModerationCommand = {
  action: 'BAN';
};

type ForwardedModerationTarget = {
  chatId: string;
  chatTitle: string | null;
  userId: string;
  senderName: string | null;
};

const SESSION_TTL_SEC = 45 * 60;
const SESSION_KEY_PREFIX = 'private-ui:v2';
const GIVEAWAY_HANDOFF_DEDUP_WINDOW_MS = 20_000;
const PROFILE_MENTION_HANDOFF_DEDUP_WINDOW_MS = 20_000;
const BROADCAST_HANDOFF_START_PAYLOAD = 'broadcast_handoff';
const RULES_HANDOFF_START_PAYLOAD = 'rules_handoff';
const GIVEAWAY_HANDOFF_START_PAYLOAD = 'giveaway_handoff';
const GIVEAWAY_HANDOFF_START_PREFIX = 'ggh-';
const PROFILE_MENTION_START_PREFIX = 'pmh-';
const PAGE_SIZE_CHATS = 8;
const PAGE_SIZE_DOMAINS = 8;
const PAGE_SIZE_EVENTS = 10;
const PAGE_SIZE_MANUAL_USERS = 8;
const SEARCH_RESULT_LIMIT = 8;
const BUTTON_TEXT_MAX_SINGLE_COLUMN = 36;
const BUTTON_TEXT_MAX_TWO_COLUMNS = 14;
const SUPPORT_CHAT_URL = 'https://max.ru/join/qX7U_Hj-L-xMJG8V7wlF6dD-6a6cXIzTBGRtU2mRMzk';
const MINIAPP_ROUTE_START_PARAM_PREFIX = 'mr-';
const MAX_CALLBACK_PREFIX = 'pc2';
const LEGACY_CALLBACK_PREFIX = 'pc';
const CALLBACK_REFRESH_NOTIFICATION = 'Меню обновлено';
const CALLBACK_STALE_NOTIFICATION = 'Кнопки устарели, обновляю экран';
const MAX_FORWARDED_COMMAND_SCAN_DEPTH = 8;
const MINIAPP_SETTINGS_ONLY_CALLBACK_ACTIONS = new Set<string>([
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
  'open_channel_section',
  'toggle_channel',
  'set_channel_input',
  'publish_channel_engagement',
]);
const MINIAPP_ACTIVITY_ONLY_CALLBACK_ACTIONS = new Set<string>([
  'open_events',
  'events_page',
  'open_logs',
  'logs_range',
  'open_manual_users',
  'manual_users_page',
  'manual_select_user',
  'manual_action',
]);

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
  'open_rules',
  'rules_input_prompt',
  'rules_clear_photo',
  'rules_toggle_attach',
  'rules_publish',
  'rules_reset_publication',
  'search_jump',
  'apply_section_preview',
  'open_domains',
  'domains_page',
  'domain_add_prompt',
  'domain_remove',
  'domain_schedule_prompt',
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
    {
      key: 'greetingDeleteBotMessageEnabled',
      label: 'Удалять приветствие',
      type: 'boolean',
    },
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
    { key: 'messageCountLimitEnabled', label: 'Лимит сообщений', type: 'boolean' },
    {
      key: 'messageCountLimitMessages',
      label: 'Сообщений за окно',
      type: 'number',
      min: 1,
      max: 10,
      step: 1,
      presets: [1, 3, 5],
    },
    {
      key: 'messageCountLimitWindowHours',
      label: 'Окно лимита (часы)',
      type: 'number',
      min: 1,
      max: 24,
      step: 1,
      presets: [1, 6, 24],
    },
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
    { key: 'messageLimitsBlockedWords', label: 'Стоп-слова', type: 'text' },
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
    { key: 'nightModeForceCloseEnabled', label: 'Закрыть группу вручную', type: 'boolean' },
    { key: 'nightModeForceCloseForever', label: 'Держать закрытой бессрочно', type: 'boolean' },
    { key: 'nightModeForceCloseHours', label: 'Часы ручного закрытия', type: 'number' },
    { key: 'nightModeForceCloseDays', label: 'Дни ручного закрытия', type: 'number' },
  ],
  extra: [
    { key: 'deleteSpammersEnabled', label: 'Удалять спаммеров', type: 'boolean' },
    { key: 'deleteBotMessagesEnabled', label: 'Удалять сообщения бота', type: 'boolean' },
    {
      key: 'deleteBotMessagesDelayMinutes',
      label: 'Задержка удаления',
      type: 'number',
      min: 0.5,
      max: 60,
      step: 1,
      presets: [0.5, 1, 5],
    },
    { key: 'removeBotsFromGroupEnabled', label: 'Удалять ботов из чата', type: 'boolean' },
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
    basic: ['greetingEnabled', 'greetingBotMessageEnabled', 'greetingDeleteBotMessageEnabled'],
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
      'messageCountLimitEnabled',
      'messageCountLimitMessages',
      'messageCountLimitWindowHours',
      'maxMessageLengthEnabled',
      'maxMessageLength',
      'videoMessagesEnabled',
      'fileMessagesEnabled',
      'voiceMessagesEnabled',
      'messageLimitsBlockedWords',
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
      'nightModeForceCloseEnabled',
      'nightModeForceCloseForever',
      'nightModeForceCloseHours',
      'nightModeForceCloseDays',
    ],
  },
  extra: {
    basic: [
      'deleteSpammersEnabled',
      'deleteBotMessagesEnabled',
      'deleteBotMessagesDelayMinutes',
      'removeBotsFromGroupEnabled',
    ],
    advanced: [],
  },
};

const DEFAULT_BROADCAST_DRAFT: PrivateBroadcastDraft = {
  text: '',
  textFormat: 'plain',
  applyToAllChats: false,
  buttonEnabled: false,
  buttonUrl: '',
  buttonText: 'Открыть',
  imageEnabled: false,
  imageBase64: '',
  imageMimeType: '',
  imageFileName: '',
  scheduleMode: 'legacy',
  scheduleTimezone: 'Europe/Moscow',
  scheduledSlots: [],
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

    const callback = context.callbackPayload
      ? this.parseCallbackAction(context.callbackPayload)
      : null;

    try {
      if (context.callbackPayload) {
        await this.processCallback(context);
        return;
      }

      await this.processTextMessage(context);
    } catch (error: unknown) {
      const badRequestDetails = this.extractBadRequestDetails(error);
      const userMessage =
        typeof badRequestDetails === 'string' && badRequestDetails.trim().length > 0
          ? badRequestDetails
          : error instanceof BadRequestException &&
              typeof error.message === 'string' &&
              error.message.trim().length > 0
            ? error.message
          : 'Что-то пошло не так. Попробуйте ещё раз через несколько секунд.';
      const session = await this.loadSessionForDiagnostics(context.actor.userId);
      const badRequestResponse = error instanceof BadRequestException ? error.getResponse() : null;

      this.logger.warn(
        {
          chatId: context.chatId,
          userId: context.actor.userId,
          err: error instanceof Error ? error.message : String(error),
          badRequestDetails,
          ...(badRequestResponse ? { badRequestResponse } : {}),
          callbackAction: callback?.action ?? null,
          callbackArgs: callback?.args ?? [],
          callbackPayload: context.callbackPayload,
          selectedChatId: session?.selectedChatId ?? null,
          selectedEntityType: session?.selectedEntityType ?? null,
          screen: session?.screen ?? null,
          pendingInput: session?.pendingInput?.kind ?? null,
          pendingMassAction: session?.pendingMassAction?.kind ?? null,
        },
        'Private control flow failed',
      );

      await this.sendImmediate(context.chatId, userMessage);
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

    const profileMentionPayload = this.parseProfileMentionStartPayload(startPayload);
    if (profileMentionPayload) {
      const session = await this.loadSession(context.actor.userId);
      this.rememberPrivateChatId(session, context.chatId);

      if (this.wasProfileMentionHandoffAlreadyDelivered(session, context.chatId)) {
        this.clearDeliveredProfileMentionHandoff(session);
        await this.saveSession(context.actor.userId, session);
        return;
      }

      await this.saveSession(context.actor.userId, session);
      await this.sendProfileMentionToPrivateChat(
        context.chatId,
        profileMentionPayload.displayName,
        profileMentionPayload.userId,
      );
      return;
    }

    const session = await this.loadSession(context.actor.userId);
    this.rememberPrivateChatId(session, context.chatId);
    if (!startPayload && this.wasProfileMentionHandoffAlreadyDelivered(session, context.chatId)) {
      this.clearDeliveredProfileMentionHandoff(session);
      await this.saveSession(context.actor.userId, session);
      return;
    }
    const channelSuggestionPayload =
      this.adminService.parseChannelSuggestionStartPayload(startPayload);
    if (channelSuggestionPayload) {
      session.pendingInput = {
        kind: 'channel_suggestion',
        chatId: channelSuggestionPayload.chatId,
        token: channelSuggestionPayload.token,
      };
      session.pendingMassAction = null;
      session.managedGiveawayId = null;
      session.section = null;
      session.channelSection = null;
      session.searchQuery = null;
      session.lastScreenStack = [];
      const view = this.renderChannelSuggestionIntroView();
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }
    const handoffPayload = this.parseGiveawayHandoffStartPayload(startPayload);
    if (handoffPayload) {
      session.selectedChatId = handoffPayload.chatId;
      session.selectedEntityType = handoffPayload.entityType;
      session.managedGiveawayId = handoffPayload.giveawayId;
      session.entityTab = handoffPayload.entityType;
      session.uiMode = 'modern';
      session.screen = 'giveaway';
      session.section = null;
      session.channelSection = null;
      session.searchQuery = null;
      session.pendingInput = { kind: 'giveaway_content' };
      session.pendingMassAction = null;
      session.lastScreenStack = [];
    }
    session.screen =
      session.selectedChatId === null
        ? 'chat_select'
        : session.screen === 'chat_select'
          ? this.resolvePrimaryScreen(session)
          : session.screen;
    if (
      session.pendingInput?.kind !== 'channel_suggestion' &&
      session.pendingInput?.kind !== 'broadcast_content' &&
      session.pendingInput?.kind !== 'giveaway_content'
    ) {
      session.pendingInput = null;
    }
    session.pendingMassAction = null;

    if (handoffPayload && this.wasGiveawayHandoffAlreadyDelivered(session, context.chatId)) {
      this.clearDeliveredGiveawayHandoff(session);
      await this.saveSession(context.actor.userId, session);
      return;
    }

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
    const scheduleMode: BroadcastScheduleMode =
      parsed.data.scheduleMode === 'calendar' ? 'calendar' : 'legacy';
    session.broadcastDraft = {
      ...DEFAULT_BROADCAST_DRAFT,
      applyToAllChats: entityType === 'channel' ? false : parsed.data.applyToAllChats,
      buttonEnabled: parsed.data.buttonEnabled,
      buttonUrl: parsed.data.buttonEnabled ? parsed.data.buttonUrl.trim() : '',
      buttonText: parsed.data.buttonEnabled
        ? parsed.data.buttonText.trim() || 'Открыть'
        : DEFAULT_BROADCAST_DRAFT.buttonText,
      scheduleMode,
      scheduleTimezone:
        parsed.data.scheduleTimezone.trim() || DEFAULT_BROADCAST_DRAFT.scheduleTimezone,
      scheduledSlots:
        scheduleMode === 'calendar'
          ? Array.from(
              new Set(parsed.data.scheduledSlots.map((slot) => slot.trim()).filter(Boolean)),
            ).sort((left, right) => left.localeCompare(right))
          : [],
      sendAt: scheduleMode === 'calendar' ? null : parsed.data.sendAt,
      cycleEnabled: scheduleMode === 'calendar' ? false : parsed.data.cycleEnabled,
      cycleEveryHours:
        scheduleMode === 'calendar'
          ? DEFAULT_BROADCAST_DRAFT.cycleEveryHours
          : !parsed.data.cycleEnabled
            ? 24
            : parsed.data.cycleEveryHours,
      cycleCount:
        scheduleMode === 'calendar'
          ? Math.max(1, parsed.data.scheduledSlots.length)
          : !parsed.data.cycleEnabled
            ? 1
            : parsed.data.cycleCount,
    };

    await this.saveSession(user.userId, session);

    const botUrl = this.buildBotStartUrl(BROADCAST_HANDOFF_START_PAYLOAD);
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  async getBroadcastHandoffState(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffState> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
    } else {
      await this.adminService.getSettings(sourceChatId, user);
    }

    const session = await this.loadSession(user.userId);
    const hasMatchingDraft =
      session.selectedChatId === sourceChatId && session.selectedEntityType === entityType;
    const draft = hasMatchingDraft ? session.broadcastDraft : DEFAULT_BROADCAST_DRAFT;

    return broadcastHandoffStateSchema.parse({
      applyToAllChats: entityType === 'channel' ? false : draft.applyToAllChats,
      buttonEnabled: draft.buttonEnabled,
      buttonUrl: draft.buttonUrl,
      buttonText: draft.buttonText,
      scheduleMode: draft.scheduleMode,
      scheduleTimezone: draft.scheduleTimezone,
      scheduledSlots: draft.scheduledSlots,
      sendAt: draft.sendAt,
      cycleEnabled: draft.cycleEnabled,
      cycleEveryHours: draft.cycleEveryHours,
      cycleCount: draft.cycleCount,
      hasContent: Boolean(draft.text.trim() || draft.imageEnabled),
    });
  }

  async handoffRulesFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
  ): Promise<BroadcastHandoffResponse> {
    await this.adminService.getRules(sourceChatId, user);

    const session = await this.loadSession(user.userId);
    session.selectedChatId = sourceChatId;
    session.selectedEntityType = 'chat';
    session.managedGiveawayId = null;
    session.entityTab = 'chat';
    session.uiMode = 'modern';
    session.screen = 'rules';
    session.section = null;
    session.channelSection = null;
    session.searchQuery = null;
    session.pendingMassAction = null;
    session.pendingInput = null;
    session.lastScreenStack = [];

    await this.saveSession(user.userId, session);

    const botUrl = this.buildBotStartUrl(RULES_HANDOFF_START_PAYLOAD);
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  async openChannelSuggestionFromCallback(params: {
    userId: string;
    chatId: string;
    token: string;
  }): Promise<boolean> {
    const session = await this.loadSession(params.userId);
    session.pendingInput = {
      kind: 'channel_suggestion',
      chatId: params.chatId,
      token: params.token,
    };
    session.pendingMassAction = null;
    session.managedGiveawayId = null;
    session.section = null;
    session.channelSection = null;
    session.searchQuery = null;
    session.lastScreenStack = [];

    await this.saveSession(params.userId, session);

    const view = this.renderChannelSuggestionIntroView();
    const text = this.limitMessageText(view.text);
    const compactOptions = this.compactButtonLayout(view.options);
    const inferredTextFormat =
      compactOptions?.textFormat ?? (this.shouldUseMarkdown(text) ? 'markdown' : undefined);
    const optionsWithFormat = inferredTextFormat
      ? { ...(compactOptions ?? {}), textFormat: inferredTextFormat }
      : compactOptions;
    const options = this.withDebugContext(optionsWithFormat, session, 'suggest_callback_handoff');

    try {
      await this.maxClient.sendMessageImmediateToUser(params.userId, text, options);
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId: params.userId,
          chatId: params.chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to open channel suggestion in private bot chat',
      );
      return false;
    }
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
    session.pendingInput = { kind: 'giveaway_content' };
    session.lastScreenStack = [];

    await this.saveSession(user.userId, session);
    await this.deliverGiveawayHandoffToKnownPrivateChat(user, session);

    const botUrl = this.buildBotStartUrl(
      this.buildGiveawayHandoffStartPayload({
        chatId: sourceChatId,
        entityType,
        giveawayId: parsed.data.giveawayId,
      }),
    );
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  async handoffProfileMentionFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    targetUserId: string,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    const parsed = profileMentionHandoffRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalizedTargetUserId = targetUserId.trim();
    if (!normalizedTargetUserId) {
      throw new BadRequestException('Не указан пользователь для открытия профиля.');
    }

    if (entityType === 'channel') {
      await this.adminService.getChannelHeader(sourceChatId, user);
    } else {
      await this.adminService.getChatHeader(sourceChatId, user);
    }

    let resolvedDisplayName = parsed.data.displayName;
    try {
      const profiles = await this.maxClient.getChatMemberProfiles(sourceChatId, [
        normalizedTargetUserId,
      ]);
      const profile = profiles.get(normalizedTargetUserId);
      const displayName = this.readString(profile?.displayName);
      if (displayName) {
        resolvedDisplayName = displayName;
      }
    } catch (error) {
      this.logger.warn(
        {
          chatId: sourceChatId,
          entityType,
          targetUserId: normalizedTargetUserId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve profile handoff display name from MAX',
      );
    }

    const botUrl = this.buildBotStartUrl(
      this.buildProfileMentionStartPayload({
        chatId: sourceChatId,
        entityType,
        userId: normalizedTargetUserId,
        displayName: resolvedDisplayName,
      }),
    );
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    const session = await this.loadSession(user.userId);
    await this.deliverProfileMentionHandoffToKnownPrivateChat(user, session, {
      displayName: resolvedDisplayName,
      userId: normalizedTargetUserId,
    });

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  private async processTextMessage(context: PrivateContext): Promise<void> {
    const session = await this.loadSession(context.actor.userId);
    this.rememberPrivateChatId(session, context.chatId);
    const directText = this.extractDirectIncomingText(context.update);
    const forwardedModerationCommand = this.parseForwardedModerationCommand(directText);
    if (forwardedModerationCommand) {
      const forwardedTargets = this.extractForwardedModerationTargets(context.update);
      if (forwardedTargets.length > 0) {
        await this.handleForwardedModerationCommand(context, session, forwardedTargets);
        return;
      }
    }

    const imageSourceAttachment = this.extractFirstImageSourceAttachment(context.update);
    const fileAttachment = this.extractFirstFileAttachment(context.update);
    const hasVideoAttachment = this.hasVideoAttachment(context.update);

    if (session.pendingInput) {
      await this.processPendingInput(context, session);
      return;
    }

    if (
      session.screen === 'broadcast' &&
      session.selectedChatId &&
      (context.text.trim().length > 0 || imageSourceAttachment !== null || hasVideoAttachment)
    ) {
      await this.captureBroadcastContent(context, session, context.text);
      const view = await this.renderBroadcastScreen(context, session, 'Контент сохранён.');
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (
      session.screen === 'giveaway' &&
      session.selectedChatId &&
      session.selectedEntityType &&
      !context.text.trim().startsWith('/') &&
      (context.text.trim().length > 0 ||
        imageSourceAttachment !== null ||
        hasVideoAttachment ||
        fileAttachment !== null)
    ) {
      const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
      if (giveaway?.status === 'DRAFT') {
        const notice = await this.captureGiveawayContent(context, session, context.text);
        const view = await this.renderGiveawayContentFollowUp(context, session, notice);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }
    }

    if (
      session.screen === 'rules' &&
      session.selectedChatId &&
      session.selectedEntityType !== 'channel' &&
      !context.text.trim().startsWith('/') &&
      (context.text.trim().length > 0 ||
        imageSourceAttachment !== null ||
        hasVideoAttachment ||
        fileAttachment !== null)
    ) {
      const view = await this.renderRulesScreen(
        context,
        session,
        'Сначала нажмите «Изменить текст» или «Добавить фото».',
      );
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (context.text.trim().startsWith('/')) {
      const view = session.selectedChatId
        ? await this.renderPrimaryScreen(context, session)
        : await this.renderChatSelection(context, session);

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

  private async handleForwardedModerationCommand(
    context: PrivateContext,
    session: PrivateSession,
    targets: ForwardedModerationTarget[],
  ): Promise<void> {
    const uniqueTargets = this.dedupeForwardedModerationTargets(targets);
    if (uniqueTargets.length !== 1) {
      throw new BadRequestException(
        'Перешлите одно сообщение из нужной группы одним сообщением и добавьте слово «бан».',
      );
    }

    const target = uniqueTargets[0];
    const result = await this.adminService.applyManualSystemBan(
      target.chatId,
      target.userId,
      context.actor,
      'private_command',
    );

    await this.saveSession(context.actor.userId, session);

    const targetLabel = target.senderName
      ? `${target.senderName} (${target.userId})`
      : target.userId;
    const chatLabel = target.chatTitle ? target.chatTitle : target.chatId;
    const lines = [result.message, `Чат: ${chatLabel}`, `Пользователь: ${targetLabel}`];
    await this.sendImmediate(context.chatId, lines.join('\n'));
  }

  private parseForwardedModerationCommand(text: string): ForwardedModerationCommand | null {
    const normalized = this.readLowerString(text);
    if (!normalized) {
      return null;
    }

    if (
      normalized === 'бан' ||
      normalized === 'ban' ||
      normalized === 'бан!' ||
      normalized === 'ban!'
    ) {
      return {
        action: 'BAN',
      };
    }

    if (
      /^(?:бан|ban)\s+\d{1,3}(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?[.!]?$/u.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        'Команда «бан» теперь делает только постоянный системный бан. Используйте просто «бан».',
      );
    }

    if (!/^(?:бан|ban)[.!]?$/u.test(normalized)) {
      return null;
    }

    return {
      action: 'BAN',
    };
  }

  private extractDirectIncomingText(update: MaxUpdate): string {
    const messageNode = this.extractIncomingMessageNode(update);
    if (!messageNode) {
      return '';
    }

    const body = this.asRecord(messageNode.body);
    const content = this.asRecord(messageNode.content);
    const payload = this.asRecord(messageNode.payload);
    const nestedMessage = this.asRecord(messageNode.message);
    const candidates = [
      messageNode.text,
      messageNode.caption,
      messageNode.message_text,
      messageNode.messageText,
      body?.text,
      body?.plain,
      content?.text,
      content?.caption,
      payload?.text,
      nestedMessage?.text,
    ];

    for (const candidate of candidates) {
      const value = this.readString(candidate);
      if (value) {
        return value;
      }
    }

    return '';
  }

  private extractForwardedModerationTargets(update: MaxUpdate): ForwardedModerationTarget[] {
    const messageNode = this.extractIncomingMessageNode(update);
    if (!messageNode) {
      return [];
    }

    const body = this.asRecord(messageNode.body);
    const content = this.asRecord(messageNode.content);
    const payload = this.asRecord(messageNode.payload);
    const nestedMessage = this.asRecord(messageNode.message);
    const candidates = [
      messageNode.link,
      messageNode.forward,
      messageNode.forwarded_message,
      messageNode.forwardedMessage,
      body?.link,
      body?.forward,
      body?.forwarded_message,
      body?.forwardedMessage,
      content?.link,
      content?.forward,
      content?.forwarded_message,
      content?.forwardedMessage,
      payload?.link,
      payload?.forward,
      payload?.forwarded_message,
      payload?.forwardedMessage,
      nestedMessage?.link,
      nestedMessage?.forward,
      nestedMessage?.forwarded_message,
      nestedMessage?.forwardedMessage,
    ];

    const targets: ForwardedModerationTarget[] = [];
    for (const candidate of candidates) {
      this.collectForwardedModerationTargets(candidate, targets);
    }

    return this.dedupeForwardedModerationTargets(targets);
  }

  private collectForwardedModerationTargets(
    node: unknown,
    acc: ForwardedModerationTarget[],
    depth = 0,
  ): void {
    if (depth > MAX_FORWARDED_COMMAND_SCAN_DEPTH || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectForwardedModerationTargets(item, acc, depth + 1);
      }
      return;
    }

    const row = this.asRecord(node);
    if (!row) {
      return;
    }

    const target = this.parseForwardedModerationTarget(row);
    if (target) {
      acc.push(target);
    }

    for (const value of Object.values(row)) {
      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectForwardedModerationTargets(value, acc, depth + 1);
      }
    }
  }

  private parseForwardedModerationTarget(
    row: Record<string, unknown>,
  ): ForwardedModerationTarget | null {
    const chatId = this.extractChatIdFromNode(row);
    const userId = this.extractUserIdFromNode(row);
    if (!chatId || !userId || this.isPrivateDirectChat(chatId)) {
      return null;
    }

    return {
      chatId,
      chatTitle: this.extractChatTitleFromNode(row),
      userId,
      senderName: this.extractSenderNameFromNode(row),
    };
  }

  private dedupeForwardedModerationTargets(
    targets: ForwardedModerationTarget[],
  ): ForwardedModerationTarget[] {
    const unique = new Map<string, ForwardedModerationTarget>();
    for (const target of targets) {
      const key = `${target.chatId}:${target.userId}`;
      if (!unique.has(key)) {
        unique.set(key, target);
      }
    }

    return [...unique.values()];
  }

  private extractChatIdFromNode(node: Record<string, unknown>): string | null {
    const chat = this.asRecord(node.chat);
    const recipient = this.asRecord(node.recipient);
    const conversation = this.asRecord(node.conversation);
    const payloadChat = this.asRecord(this.asRecord(node.payload)?.chat);
    const candidates = [
      node.chatId,
      node.chat_id,
      chat?.chatId,
      chat?.chat_id,
      chat?.id,
      recipient?.chatId,
      recipient?.chat_id,
      recipient?.id,
      conversation?.chat_id,
      conversation?.chatId,
      conversation?.id,
      payloadChat?.chat_id,
      payloadChat?.chatId,
      payloadChat?.id,
    ];

    for (const candidate of candidates) {
      const value = this.normalizeEntityId(candidate);
      if (value) {
        return value;
      }
    }

    return null;
  }

  private extractUserIdFromNode(node: Record<string, unknown>): string | null {
    const sender = this.asRecord(node.sender);
    const from = this.asRecord(node.from);
    const user = this.asRecord(node.user);
    const actor = this.asRecord(node.actor);
    const payloadSender = this.asRecord(this.asRecord(node.payload)?.sender);
    const candidates = [
      node.senderId,
      node.sender_id,
      sender?.id,
      sender?.user_id,
      sender?.userId,
      from?.id,
      from?.user_id,
      from?.userId,
      user?.id,
      user?.user_id,
      user?.userId,
      actor?.id,
      actor?.user_id,
      actor?.userId,
      payloadSender?.id,
      payloadSender?.user_id,
      payloadSender?.userId,
    ];

    for (const candidate of candidates) {
      const value = this.normalizeEntityId(candidate);
      if (value) {
        return value;
      }
    }

    return null;
  }

  private extractSenderNameFromNode(node: Record<string, unknown>): string | null {
    const sender = this.asRecord(node.sender);
    const from = this.asRecord(node.from);
    const user = this.asRecord(node.user);
    const actor = this.asRecord(node.actor);
    const payloadSender = this.asRecord(this.asRecord(node.payload)?.sender);
    const directCandidates = [
      node.sender_name,
      node.senderName,
      node.display_name,
      node.displayName,
      sender?.display_name,
      sender?.displayName,
      sender?.name,
      sender?.full_name,
      sender?.fullName,
      sender?.nickname,
      from?.display_name,
      from?.displayName,
      from?.name,
      from?.full_name,
      from?.fullName,
      user?.display_name,
      user?.displayName,
      user?.name,
      user?.full_name,
      user?.fullName,
      actor?.display_name,
      actor?.displayName,
      actor?.name,
      actor?.full_name,
      actor?.fullName,
      payloadSender?.display_name,
      payloadSender?.displayName,
      payloadSender?.name,
      payloadSender?.full_name,
      payloadSender?.fullName,
    ];

    for (const candidate of directCandidates) {
      const value = this.readString(candidate);
      if (value) {
        return value;
      }
    }

    const nameNodes = [sender, from, user, actor, payloadSender].filter(
      (item): item is Record<string, unknown> => Boolean(item),
    );
    for (const value of nameNodes) {
      const firstName = this.readString(
        value.first_name ?? value.firstName ?? value.given_name ?? value.givenName,
      );
      const lastName = this.readString(
        value.last_name ?? value.lastName ?? value.family_name ?? value.familyName,
      );
      const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
      if (fullName) {
        return fullName;
      }
    }

    return null;
  }

  private extractChatTitleFromNode(node: Record<string, unknown>): string | null {
    const chat = this.asRecord(node.chat);
    const recipient = this.asRecord(node.recipient);
    const candidates = [
      node.chatTitle,
      node.chat_title,
      node.chatName,
      node.chat_name,
      chat?.title,
      chat?.name,
      recipient?.title,
      recipient?.chat_title,
      recipient?.chatTitle,
      recipient?.name,
      recipient?.display_name,
    ];

    for (const candidate of candidates) {
      const value = this.readString(candidate);
      if (value) {
        return value;
      }
    }

    return null;
  }

  private normalizeEntityId(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private async processCallback(context: PrivateContext): Promise<void> {
    const callback = this.parseCallbackAction(context.callbackPayload);
    const session = await this.loadSession(context.actor.userId);
    this.rememberPrivateChatId(session, context.chatId);

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
        throw new BadRequestException('Не удалось определить подтверждение приза.');
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
          notification: 'Экран обновлён',
        });
        return;
      }

      const view = this.renderGiveawayClaimView(currentClaim, 'Подтверждение больше не требуется.');
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Подтверждение больше не нужно',
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
      session.pendingInput.kind !== 'giveaway_content' &&
      !(session.pendingInput.kind === 'channel_suggestion' && callback.action === 'suggest_help') &&
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

    if (MINIAPP_SETTINGS_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.assertChatSelected(session);
      this.resetSessionToPrimaryScreen(session);
      const view = await this.renderEntitySettingsMovedToMiniappScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Настройки перенесены в mini app',
      });
      return;
    }

    if (MINIAPP_ACTIVITY_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.assertChatSelected(session);
      this.resetSessionToPrimaryScreen(session);
      const view = await this.renderEntityActivityMovedToMiniappScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Открывайте активность в mini app',
      });
      return;
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

      case 'suggest_help': {
        if (session.pendingInput?.kind !== 'channel_suggestion') {
          throw new BadRequestException('Подсказка доступна только внутри предложки.');
        }

        const view = this.renderChannelSuggestionHelpView();
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Подсказка открыта',
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

      case 'chat_refresh': {
        session.chatPage = 1;
        session.screen = 'chat_select';
        const view = await this.renderChatSelection(context, session, { refresh: true });
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification:
            session.entityTab === 'channel' ? 'Список каналов обновлён' : 'Список чатов обновлён',
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
        const view = await this.renderChatSelection(context, session, { refresh: true });
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

      case 'open_rules': {
        this.assertSelectedEntityType(session, 'chat');
        this.pushHistory(session);
        session.screen = 'rules';
        session.pendingInput = null;
        session.pendingMassAction = null;
        const view = await this.renderRulesScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Правила чата',
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
        const nextValue = !(current[key] as boolean);
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
          settings.autoPostButtonsMode === 'COMMENTS' ||
          settings.autoPostButtonsMode === 'BOTH' ||
          (settings.autoPostButtonsMode === 'OFF' && settings.commentsEnabled);
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
        const nextValue = !(current[key] as boolean);
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

        const nextValue = Number(rawValue);
        if (!Number.isFinite(nextValue) || Number.isNaN(nextValue)) {
          throw new BadRequestException('Preset is invalid');
        }
        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, nextValue);

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${this.formatNumberPreset(config, nextValue)}`,
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

        const delta = Number(rawDelta);
        if (!Number.isFinite(delta) || Number.isNaN(delta)) {
          throw new BadRequestException('Delta is invalid');
        }

        const current = await this.adminService.getSettings(session.selectedChatId!, context.actor);
        const currentValue = Number(current[key] ?? 0);
        const bounded =
          key === 'deleteBotMessagesDelayMinutes'
            ? stepDeleteBotMessagesDelayMinutes(currentValue, delta)
            : Math.max(
                config.min ?? Number.MIN_SAFE_INTEGER,
                Math.min(config.max ?? Number.MAX_SAFE_INTEGER, currentValue + delta),
              );
        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, bounded);

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${this.formatNumberPreset(config, bounded)}`,
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
          await this.respondToSuccessfulBroadcast(context, session, sendResult);
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

      case 'rules_input_prompt': {
        this.assertSelectedEntityType(session, 'chat');
        const mode = callback.args[0] ?? '';
        if (mode === 'text') {
          session.pendingInput = { kind: 'rules_text' };
        } else if (mode === 'photo') {
          session.pendingInput = { kind: 'rules_photo' };
        } else {
          throw new BadRequestException('Неизвестный режим редактирования правил.');
        }

        session.screen = 'rules';
        const view = await this.renderRulesScreen(
          context,
          session,
          mode === 'photo'
            ? 'Жду новое фото одним сообщением.'
            : 'Жду новый текст одним сообщением.',
        );
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: mode === 'photo' ? 'Жду фото правил' : 'Жду текст правил',
        });
        return;
      }

      case 'rules_clear_photo': {
        this.assertSelectedEntityType(session, 'chat');
        const rules = await this.adminService.getRules(session.selectedChatId!, context.actor);
        await this.adminService.updateRules(
          session.selectedChatId!,
          context.actor,
          {
            text: rules.text,
            imageBase64: '',
            imageMimeType: '',
            imageFileName: '',
            autoTextEnabled: false,
          },
          'private_bot',
        );
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, 'Фото правил убрано.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Фото убрано',
        });
        return;
      }

      case 'rules_toggle_attach': {
        this.assertSelectedEntityType(session, 'chat');
        const current = await this.adminService.getSettings(session.selectedChatId!, context.actor);
        const nextSettings: ChatSettings = {
          ...current,
          rulesAttachViolationsEnabled: !current.rulesAttachViolationsEnabled,
        };
        await this.adminService.updateSettings(
          session.selectedChatId!,
          context.actor,
          nextSettings,
          'private_bot',
        );
        session.screen = 'rules';
        const view = await this.renderRulesScreen(
          context,
          session,
          nextSettings.rulesAttachViolationsEnabled
            ? 'Кнопка «Правила» включена.'
            : 'Кнопка «Правила» выключена.',
        );
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: nextSettings.rulesAttachViolationsEnabled
            ? 'Кнопка включена'
            : 'Кнопка выключена',
        });
        return;
      }

      case 'rules_publish': {
        this.assertSelectedEntityType(session, 'chat');
        await this.adminService.publishRules(session.selectedChatId!, context.actor, 'private_bot');
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, '✅ Правила опубликованы.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: '✅ Правила опубликованы',
        });
        return;
      }

      case 'rules_reset_publication': {
        this.assertSelectedEntityType(session, 'chat');
        await this.adminService.resetPublishedRules(
          session.selectedChatId!,
          context.actor,
          'private_bot',
        );
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, 'Публикация правил сброшена.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Публикация сброшена',
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
        } else if (field === 'content') {
          session.pendingInput = { kind: 'giveaway_content' };
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

        const view =
          session.pendingInput.kind === 'giveaway_content'
            ? await this.renderGiveawayContentPrompt(context, session)
            : this.renderInputPrompt(session.pendingInput);
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
          throw new BadRequestException(
            `Можно добавить не больше ${MANAGED_GIVEAWAY_MAX_PRIZES} мест.`,
          );
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
        session.pendingInput = null;
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
        const view =
          pendingInput.kind === 'broadcast_content'
            ? await this.renderBroadcastScreen(context, session)
            : this.renderInputPrompt(pendingInput);
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
        await this.respondToSuccessfulBroadcast(context, session, result);
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
        const canceledInput = session.pendingInput;
        session.pendingInput = null;
        if (canceledInput?.kind === 'channel_suggestion') {
          const view = this.renderChannelSuggestionCancelledView();
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Предложка закрыта',
          });
          return;
        }

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

        if (session.screen === 'rules') {
          const view = await this.renderRulesScreen(context, session);
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

    const pendingInput = session.pendingInput;
    const rawText = context.text.trim();
    if (rawText.toLowerCase() === 'отмена') {
      session.pendingInput = null;

      if (pendingInput.kind === 'channel_suggestion') {
        const view = this.renderChannelSuggestionCancelledView();
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

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

      if (session.screen === 'rules') {
        const view = await this.renderRulesScreen(context, session);
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

      case 'rules_text': {
        const notice = await this.captureRulesContent(context, session, rawText, {
          requireText: true,
          textOnly: true,
        });
        session.pendingInput = null;
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, notice);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'rules_photo': {
        const notice = await this.captureRulesContent(context, session, rawText, {
          requireImage: true,
          imageOnly: true,
        });
        session.pendingInput = null;
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, notice);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'channel_suggestion': {
        const imageSourceAttachment = this.extractFirstImageSourceAttachment(context.update);
        const fileAttachment = this.extractFirstFileAttachment(context.update);
        const hasVideoAttachment = this.hasVideoAttachment(context.update);

        if (hasVideoAttachment || (fileAttachment && !imageSourceAttachment)) {
          throw new BadRequestException(
            'Сейчас через предложку можно отправить текст, фото или фото с подписью. Видео и произвольные файлы не поддерживаются.',
          );
        }

        if (!rawText && !imageSourceAttachment) {
          throw new BadRequestException('Пришлите текст поста, фото или фото с подписью.');
        }

        const downloadedImage = imageSourceAttachment
          ? await this.downloadImageSourceAttachment(imageSourceAttachment, 'channel-suggestion')
          : null;
        const result = await this.adminService.createChannelSuggestionFromBot(
          pendingInput.chatId,
          context.actor,
          {
            token: pendingInput.token,
            text: rawText,
            ...(downloadedImage
              ? {
                  imageBase64: downloadedImage.base64,
                  imageMimeType: downloadedImage.mimeType,
                  imageFileName: downloadedImage.fileName,
                }
              : {}),
          },
        );

        const view = result.delivered
          ? this.renderChannelSuggestionSubmittedView()
          : this.renderChannelSuggestionQueuedView();
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

      case 'giveaway_content': {
        const notice = await this.captureGiveawayContent(context, session, rawText);
        const view = await this.renderGiveawayContentFollowUp(context, session, notice);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_text': {
        const formattedText = this.extractIncomingFormattedText(context.update, rawText);
        session.broadcastDraft.text = formattedText;
        session.broadcastDraft.textFormat = this.shouldUseMarkdown(formattedText)
          ? 'markdown'
          : 'plain';
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
        const parsedCount = this.parseIntInput(rawText, 1, 100);
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
        const imageSourceAttachment = this.extractFirstImageSourceAttachment(context.update);
        if (!imageSourceAttachment) {
          throw new BadRequestException(
            'Отправьте фото или PNG/WebP/JPG файлом отдельным сообщением.',
          );
        }

        const downloaded = await this.downloadImageSourceAttachment(imageSourceAttachment);
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
        const view = await this.renderGiveawayScreen(
          context,
          session,
          'Текст публикации обновлён.',
        );
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
        const view = await this.renderGiveawayScreen(
          context,
          session,
          'Срок подтверждения обновлён.',
        );
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_photo': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const imageSourceAttachment = this.extractFirstImageSourceAttachment(context.update);
        if (!imageSourceAttachment) {
          throw new BadRequestException(
            'Отправьте фото или PNG/WebP/JPG файлом отдельным сообщением.',
          );
        }

        const downloaded = await this.downloadImageSourceAttachment(
          imageSourceAttachment,
          'private-giveaway',
        );
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

  private async captureRulesContent(
    context: PrivateContext,
    session: PrivateSession,
    rawText: string,
    options: {
      requireText?: boolean;
      requireImage?: boolean;
      textOnly?: boolean;
      imageOnly?: boolean;
    } = {},
  ): Promise<string> {
    this.assertSelectedEntityType(session, 'chat');

    const formattedText = this.extractIncomingFormattedText(context.update, rawText);
    const normalizedText = formattedText.trim();
    const imageSourceAttachment = this.extractFirstImageSourceAttachment(context.update);
    const fileAttachment = this.extractFirstFileAttachment(context.update);
    const hasVideoAttachment = this.hasVideoAttachment(context.update);

    if (hasVideoAttachment) {
      throw new BadRequestException(
        'Видео в правилах не поддерживается. Отправьте текст или изображение.',
      );
    }

    if (fileAttachment && !imageSourceAttachment) {
      throw new BadRequestException('Поддерживаются только фото или PNG/WebP/JPG файлом.');
    }

    if (options.textOnly && imageSourceAttachment) {
      throw new BadRequestException('Для текста правил отправьте только текст без вложений.');
    }

    if (options.imageOnly && normalizedText) {
      throw new BadRequestException('Для фото правил отправьте только изображение без текста.');
    }

    if (!normalizedText && !imageSourceAttachment) {
      throw new BadRequestException('Отправьте текст, фото или PNG/WebP/JPG файлом.');
    }

    if (options.requireText && !normalizedText) {
      throw new BadRequestException('Отправьте текст правил следующим сообщением.');
    }

    if (options.requireImage && !imageSourceAttachment) {
      if (hasVideoAttachment) {
        throw new BadRequestException('Нужно изображение, не видео.');
      }
      if (fileAttachment) {
        throw new BadRequestException('Нужен PNG/WebP/JPG файлом или обычное фото.');
      }
      throw new BadRequestException('Отправьте фото или PNG/WebP/JPG файлом.');
    }

    const currentRules = await this.adminService.getRules(session.selectedChatId!, context.actor);
    const requiresRepublish = Boolean(currentRules.publishedMessageId || currentRules.publishedUrl);
    let imageBase64 = currentRules.imageBase64;
    let imageMimeType = currentRules.imageMimeType;
    let imageFileName = currentRules.imageFileName;

    if (imageSourceAttachment) {
      const downloaded = await this.downloadImageSourceAttachment(
        imageSourceAttachment,
        'private-rules',
      );
      imageBase64 = downloaded.base64;
      imageMimeType = downloaded.mimeType;
      imageFileName = downloaded.fileName;
    }

    const nextText = normalizedText ? formattedText : currentRules.text;

    await this.adminService.updateRules(
      session.selectedChatId!,
      context.actor,
      {
        text: nextText,
        imageBase64,
        imageMimeType,
        imageFileName,
        autoTextEnabled: false,
      },
      'private_bot',
    );

    session.pendingInput = null;
    session.screen = 'rules';

    const republishHint = requiresRepublish ? ' Переопубликуйте правила здесь или в mini app.' : '';
    if (normalizedText && imageSourceAttachment) {
      return `Текст и фото правил обновлены.${republishHint}`;
    }
    if (imageSourceAttachment) {
      return `Фото правил обновлено.${republishHint}`;
    }
    return `Текст правил обновлён.${republishHint}`;
  }

  private async captureBroadcastContent(
    context: PrivateContext,
    session: PrivateSession,
    rawText: string,
  ): Promise<void> {
    const formattedText = this.extractIncomingFormattedText(context.update, rawText);
    const normalizedText = formattedText.trim();
    const imageSourceAttachment = this.extractFirstImageSourceAttachment(context.update);

    if (!normalizedText && !imageSourceAttachment) {
      if (this.hasVideoAttachment(context.update)) {
        throw new BadRequestException(
          'Видео в рассылке пока не поддерживается. Отправьте текст или изображение.',
        );
      }
      throw new BadRequestException('Отправьте текст или изображение отдельным сообщением.');
    }

    if (normalizedText) {
      session.broadcastDraft.text = formattedText;
      session.broadcastDraft.textFormat = this.shouldUseMarkdown(formattedText)
        ? 'markdown'
        : 'plain';
    }

    if (imageSourceAttachment) {
      const downloaded = await this.downloadImageSourceAttachment(imageSourceAttachment);
      session.broadcastDraft.imageEnabled = true;
      session.broadcastDraft.imageBase64 = downloaded.base64;
      session.broadcastDraft.imageMimeType = downloaded.mimeType;
      session.broadcastDraft.imageFileName = downloaded.fileName;
    }

    session.pendingInput = null;
    session.screen = 'broadcast';
  }

  private async captureGiveawayContent(
    context: PrivateContext,
    session: PrivateSession,
    rawText: string,
  ): Promise<string> {
    this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');

    const formattedText = this.extractIncomingFormattedText(context.update, rawText);
    const normalizedText = formattedText.trim();
    const clearText = normalizedText === '-';
    const hasTextUpdate = clearText || normalizedText.length > 0;
    const imageSourceAttachment = this.extractFirstImageSourceAttachment(context.update);

    if (!hasTextUpdate && !imageSourceAttachment) {
      if (this.hasVideoAttachment(context.update)) {
        throw new BadRequestException(
          'Видео для публикации розыгрыша пока не поддерживается. Отправьте текст или изображение.',
        );
      }
      throw new BadRequestException(
        'Отправьте текст, фото или PNG/WebP/JPG файлом отдельным сообщением.',
      );
    }

    const downloaded = imageSourceAttachment
      ? await this.downloadImageSourceAttachment(imageSourceAttachment, 'private-giveaway')
      : null;
    const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
    const nextHasText = hasTextUpdate ? !clearText : draft.description.trim().length > 0;
    const nextHasImage = downloaded ? true : draft.imageEnabled;
    const saved = await this.updateManagedGiveawayDraftForSession(
      session.selectedChatId,
      context.actor,
      session.selectedEntityType,
      draft.id,
      (nextDraft) => {
        if (hasTextUpdate) {
          nextDraft.description = clearText ? '' : formattedText;
        }

        if (downloaded) {
          nextDraft.imageEnabled = true;
          nextDraft.imageBase64 = downloaded.base64;
          nextDraft.imageMimeType = downloaded.mimeType;
          nextDraft.imageFileName = downloaded.fileName;
        }
      },
    );

    session.managedGiveawayId = saved.id;
    session.pendingInput = nextHasText ? null : { kind: 'giveaway_content' };
    session.screen = 'giveaway';

    if (hasTextUpdate && downloaded) {
      return clearText
        ? 'Текст очищен, фото обновлено. Пришлите новый текст публикации.'
        : 'Текст и фото публикации обновлены.';
    }

    if (downloaded) {
      return nextHasText
        ? 'Фото публикации обновлено.'
        : 'Фото публикации обновлено. Теперь пришлите текст публикации.';
    }

    return clearText
      ? 'Текст очищен. Пришлите новый текст публикации.'
      : nextHasImage
        ? 'Текст публикации обновлён.'
        : 'Текст публикации обновлён. Фото можно добавить позже.';
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

  private async respondToSuccessfulBroadcast(
    context: PrivateContext,
    session: PrivateSession,
    result: SendBroadcastResult,
  ): Promise<void> {
    const view = await this.renderBroadcastScreen(
      context,
      session,
      this.buildBroadcastCompletionNotice(result),
    );
    await this.respond(context, session, view, {
      callbackId: context.callbackId,
      notification: 'Рассылка отправлена',
    });

    if (result.failedChats > 0) {
      return;
    }

    await this.sendImmediate(context.chatId, this.buildBroadcastSuccessMessage(result));
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
      requiredChannelIds: [],
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
      requiredChannelIds: giveaway.requiredChannelIds,
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
    options: { refresh?: boolean } = {},
  ): Promise<PrivateView> {
    const entityType = session.entityTab;
    const entities = await this.adminService.listManagedEntities(context.actor, entityType, {
      refresh: options.refresh === true,
    });
    const singleEntityWord = entityType === 'channel' ? 'канал' : 'чат';
    const pluralEntityWord = entityType === 'channel' ? 'каналы' : 'чаты';

    if (entities.length === 0) {
      return {
        text: [
          this.markdownTitle(entityType === 'channel' ? 'Каналы не найдены' : 'Чаты не найдены'),
          '',
          'Добавьте бота админом и обновите экран.',
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
            [this.callbackButton('Обновить', this.cb('chat_refresh'), 'positive')],
            ...this.buildFooterButtons(),
          ],
        },
      };
    }

    const pageInfo = this.paginate(entities, session.chatPage, PAGE_SIZE_CHATS);
    session.chatPage = pageInfo.page;

    const lines = [
      this.markdownTitle(`Выбор: ${singleEntityWord}`),
      '',
      `${pageInfo.start + 1}-${pageInfo.end} из ${entities.length} (${pluralEntityWord})`,
      `Нажмите на нужный ${singleEntityWord}.`,
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
      this.callbackButton('Обновить', this.cb('chat_refresh'), 'positive'),
    ]);
    rows.push(this.paginationButtons(pageInfo.page, pageInfo.pages, 'chat_page'));
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
    if (
      session.screen === 'settings_hub' ||
      session.screen === 'section' ||
      session.screen === 'channel_section' ||
      session.screen === 'domains' ||
      session.screen === 'search'
    ) {
      this.resetSessionToPrimaryScreen(session);
      return this.renderEntitySettingsMovedToMiniappScreen(context, session);
    }
    if (session.screen === 'rules') {
      return this.renderRulesScreen(context, session);
    }
    if (session.screen === 'broadcast') {
      return this.renderBroadcastScreen(context, session);
    }
    if (session.screen === 'poll') {
      return this.renderPollScreen(context, session);
    }
    if (session.screen === 'giveaway') {
      if (session.pendingInput?.kind === 'giveaway_content') {
        return this.renderGiveawayContentPrompt(context, session);
      }
      return this.renderGiveawayScreen(context, session);
    }
    if (
      session.screen === 'events' ||
      session.screen === 'logs' ||
      session.screen === 'manual_users' ||
      session.screen === 'manual_actions'
    ) {
      this.resetSessionToPrimaryScreen(session);
      return this.renderEntityActivityMovedToMiniappScreen(context, session);
    }

    return this.renderPrimaryScreen(context, session);
  }

  private async renderGiveawayContentPrompt(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      return this.renderInputPrompt({ kind: 'giveaway_content' });
    }

    const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
    const giveawaySettingsMiniappUrl = this.buildGiveawaySettingsMiniappUrl(
      session.selectedChatId,
      session.selectedEntityType,
    );
    const giveawaySettingsMiniappRoute = this.buildGiveawaySettingsMiniappRoute(
      session.selectedChatId,
      session.selectedEntityType,
    );
    const hasSavedContent = Boolean(giveaway?.description.trim() || giveaway?.imageEnabled);
    const previewText = hasSavedContent && giveaway ? this.buildGiveawayPreviewText(giveaway) : '';
    const usesMarkdown = this.shouldUseMarkdown(previewText);
    const entityLead = await this.buildSelectedEntityLeadLine(context.actor, session, usesMarkdown);
    const imagePayload = giveaway
      ? await this.buildContentPreviewImagePayload(giveaway, 'private-giveaway-preview')
      : undefined;
    const rows: MaxMessageButton[][] = [];

    if (hasSavedContent) {
      rows.push([this.callbackButton('Опубликовать', this.cb('giveaway_publish'), 'positive')]);
    }

    rows.push([
      this.buildMiniappLaunchButton(
        'В приложение',
        giveawaySettingsMiniappRoute,
        giveawaySettingsMiniappUrl,
      ),
    ]);

    const textPayload =
      previewText.length > 0 && usesMarkdown
        ? this.buildHtmlPreviewText({
            entityLead,
            contentText: previewText,
            promptText: 'Пришлите новый текст или фото.',
            notice,
          })
        : this.buildPlainPreviewText({
            entityLead,
            contentText: previewText.length > 0 ? previewText : null,
            promptText:
              previewText.length > 0
                ? 'Пришлите новый текст или фото.'
                : 'Пришлите текст или фото.',
            notice,
          });

    return {
      text: textPayload.text,
      options: {
        buttons: rows,
        ...(imagePayload ? { imagePayload } : {}),
        ...(textPayload.textFormat ? { textFormat: textPayload.textFormat } : {}),
      },
    };
  }

  private async renderGiveawayContentFollowUp(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (session.pendingInput?.kind === 'giveaway_content') {
      return this.renderGiveawayContentPrompt(context, session, notice);
    }

    return this.renderGiveawayDraftPreview(context, session, notice);
  }

  private async renderGiveawayDraftPreview(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
    if (!giveaway || giveaway.status !== 'DRAFT') {
      return this.renderGiveawayScreen(context, session);
    }

    if (!giveaway.description.trim()) {
      return this.renderGiveawayContentPrompt(context, session, notice);
    }

    const giveawaySettingsMiniappUrl = this.buildGiveawaySettingsMiniappUrl(
      session.selectedChatId!,
      session.selectedEntityType!,
    );
    const giveawaySettingsMiniappRoute = this.buildGiveawaySettingsMiniappRoute(
      session.selectedChatId!,
      session.selectedEntityType!,
    );
    const imagePayload = await this.buildContentPreviewImagePayload(
      giveaway,
      'private-giveaway-preview',
    );
    const previewText = this.buildGiveawayPreviewText(giveaway);
    const previewTextFormat = this.buildGiveawayPreviewTextFormat(previewText);
    const usesMarkdown = previewTextFormat === 'markdown';
    const entityLead = await this.buildSelectedEntityLeadLine(context.actor, session, usesMarkdown);
    const textPayload = usesMarkdown
      ? this.buildHtmlPreviewText({
          entityLead,
          contentText: previewText,
          promptText: null,
          notice,
        })
      : this.buildPlainPreviewText({
          entityLead,
          contentText: previewText,
          promptText: null,
          notice,
        });

    return {
      text: textPayload.text,
      options: {
        buttons: this.buildGiveawayDraftActionRows(
          giveawaySettingsMiniappRoute,
          giveawaySettingsMiniappUrl,
        ),
        ...(imagePayload ? { imagePayload } : {}),
        ...(textPayload.textFormat ? { textFormat: textPayload.textFormat } : {}),
      },
    };
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
    const settingsMiniappUrl = this.buildEntitySettingsMiniappUrl(selectedChannel.id, 'channel');
    const settingsMiniappRoute = this.buildEntitySettingsMiniappRoute(
      selectedChannel.id,
      'channel',
    );
    const activityMiniappUrl = this.buildEntityActivityMiniappUrl(selectedChannel.id, 'channel');
    const activityMiniappRoute = this.buildEntityActivityMiniappRoute(
      selectedChannel.id,
      'channel',
    );

    const lines: string[] = [
      this.markdownTitle('Панель канала'),
      '',
      `Канал: ${this.escapeMarkdown(selectedChannel.title)}`,
      `Статус: предложка ${settings.postSuggestionsEnabled ? 'вкл' : 'выкл'} • обсуждение ${settings.commentsEnabled ? 'вкл' : 'выкл'}`,
      '',
      'В боте оставлены только базовые действия: принять контент и подтвердить публикацию.',
      'Настройки канала, обсуждение, предложка, розыгрыши и аналитика перенесены в mini app.',
    ];

    const rows: MaxMessageButton[][] = [
      [
        this.buildMiniappLaunchButton(
          'Открыть управление',
          settingsMiniappRoute,
          settingsMiniappUrl,
        ),
      ],
      [this.callbackButton('Опубликовать контент', this.cb('open_broadcast'), 'positive')],
      [
        this.buildMiniappLaunchButton(
          'Статистика канала',
          activityMiniappRoute,
          activityMiniappUrl,
        ),
      ],
      [this.callbackButton('Сменить канал', this.cb('change_chat'))],
      ...this.buildFooterButtons({ includeMiniapp: false }),
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
    const lines: string[] = [
      this.markdownTitle(CHANNEL_SECTION_LABELS[section]),
      '',
      ...this.buildChannelSectionSummary(section, settings),
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
    const settingsMiniappUrl = this.buildEntitySettingsMiniappUrl(selectedChat.id, 'chat');
    const settingsMiniappRoute = this.buildEntitySettingsMiniappRoute(selectedChat.id, 'chat');
    const activityMiniappUrl = this.buildEntityActivityMiniappUrl(selectedChat.id, 'chat');
    const activityMiniappRoute = this.buildEntityActivityMiniappRoute(selectedChat.id, 'chat');

    const lines: string[] = [
      this.markdownTitle('Панель чата'),
      '',
      `Чат: ${this.escapeMarkdown(selectedChat.title)}`,
      `Статус: ссылки ${this.describeLinkPolicy(settings.linkPolicy)} • приветствие ${settings.greetingEnabled ? 'вкл' : 'выкл'}`,
      '',
      'В боте оставлены только базовые действия: принять контент и подтвердить публикацию.',
      'Настройки, правила, события и ручная модерация перенесены в mini app.',
    ];

    const rows: MaxMessageButton[][] = [
      [
        this.buildMiniappLaunchButton(
          'Открыть управление',
          settingsMiniappRoute,
          settingsMiniappUrl,
        ),
      ],
      [this.callbackButton('Опубликовать контент', this.cb('open_broadcast'), 'positive')],
      [
        this.buildMiniappLaunchButton(
          'Активность и модерация',
          activityMiniappRoute,
          activityMiniappUrl,
        ),
      ],
      [this.callbackButton('Сменить чат', this.cb('change_chat'))],
      ...this.buildFooterButtons({ includeMiniapp: false }),
    ];

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

    const chatTitle = await this.resolveManagedEntityTitle(
      context.actor,
      'chat',
      session.selectedChatId,
    );
    const lines: string[] = [
      this.markdownTitle('Разделы настроек'),
      '',
      `Чат: ${this.escapeMarkdown(chatTitle)}`,
      'Выберите раздел.',
    ];

    const rows: MaxMessageButton[][] = SECTION_ORDER.map((section) => [
      this.callbackButton(SECTION_LABELS[section], this.cb('open_section', section)),
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
      this.markdownTitle(SECTION_LABELS[section]),
      '',
      `Режим: ${session.sectionView === 'basic' ? 'Основное' : 'Ещё параметры'}`,
      '',
      ...this.buildSectionSummaryLines(section, settings, session.sectionView),
    ];

    const rows = this.buildSectionActionRows(section, settings, session.sectionView);

    if (section === 'links' && session.sectionView === 'advanced') {
      rows.push([this.callbackButton('Разрешённые домены', this.cb('open_domains'))]);
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
      'Для нового интерфейса нажмите «Новый вид».',
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
        this.callbackButton('Правила', this.cb('open_rules')),
      ],
      [
        this.callbackButton('Рассылка', this.cb('open_broadcast')),
        this.callbackButton('Опрос', this.cb('open_poll')),
      ],
      [
        this.callbackButton('Розыгрыш', this.cb('open_giveaway')),
        this.callbackButton('Нарушения', this.cb('open_events')),
      ],
      [this.callbackButton('Статистика', this.cb('open_logs'))],
      [this.callbackButton('Ручной бан', this.cb('open_manual_users'))],
      [this.callbackButton('Другой чат', this.cb('change_chat'))],
      [this.callbackButton('Новый вид', this.cb('home'))],
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
            `${settings[field.key] ? '✅' : '⬜'} ${field.label}`,
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

  private async renderRulesScreen(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    if (session.selectedEntityType === 'channel') {
      return this.renderChannelHomeScreen(context, session);
    }

    const [rules, chatTitle] = await Promise.all([
      this.adminService.getRules(session.selectedChatId, context.actor),
      this.resolveManagedEntityTitle(context.actor, 'chat', session.selectedChatId),
    ]);

    const hasText = rules.text.trim().length > 0;
    const hasImage = rules.imageBase64.trim().length > 0;
    const hasPublishedPost = Boolean(rules.publishedMessageId || rules.publishedUrl);
    const rulesSettingsMiniappUrl = this.buildRulesSettingsMiniappUrl(session.selectedChatId);
    const rulesSettingsMiniappRoute = this.buildRulesSettingsMiniappRoute(session.selectedChatId);
    const waitingHint =
      session.pendingInput?.kind === 'rules_text'
        ? 'Жду новый текст одним сообщением.'
        : session.pendingInput?.kind === 'rules_photo'
          ? 'Жду новое фото одним сообщением.'
          : null;

    const lines: string[] = [
      this.markdownTitle('Правила'),
      '',
      `Чат: ${this.escapeMarkdown(chatTitle)}`,
      `Статус: ${
        hasPublishedPost ? 'опубликованы' : hasText || hasImage ? 'черновик' : 'не настроены'
      }`,
      `Текст: ${hasText ? `${rules.text.trim().length} симв.` : 'нет'}`,
      `Фото: ${hasImage ? 'добавлено' : 'нет'}`,
    ];

    if (rules.publishedAt) {
      lines.push(`Опубликовано: ${this.formatIsoDate(rules.publishedAt)}`);
    }

    if (rules.publishedUrl) {
      lines.push(`Ссылка: ${rules.publishedUrl}`);
    }

    if (waitingHint) {
      lines.push(`Жду: ${this.escapeMarkdown(waitingHint)}`);
    } else {
      lines.push(
        'Действия: «Изменить текст», «Добавить фото» или «Опубликовать». Кнопка «Правила» остаётся в mini app.',
      );
    }

    if (notice) {
      lines.push('', `Статус: ${this.escapeMarkdown(notice)}`);
    }

    lines.push('', 'Текст правил:');
    lines.push(hasText ? rules.text : 'не задан');

    const rows: MaxMessageButton[][] = [
      [this.callbackButton('Изменить текст', this.cb('rules_input_prompt', 'text'))],
      [
        this.callbackButton(
          hasImage ? 'Обновить фото' : 'Добавить фото',
          this.cb('rules_input_prompt', 'photo'),
        ),
      ],
    ];

    if (hasImage) {
      rows.push([this.callbackButton('Убрать фото', this.cb('rules_clear_photo'), 'negative')]);
    }

    rows.push([this.callbackButton('Опубликовать', this.cb('rules_publish'), 'positive')]);

    if (hasPublishedPost) {
      const publicationRow: MaxMessageButton[] = [];
      if (rules.publishedUrl) {
        publicationRow.push({
          type: 'link',
          text: 'Открыть пост',
          url: rules.publishedUrl,
        });
      }
      publicationRow.push(
        this.callbackButton('Сбросить публикацию', this.cb('rules_reset_publication'), 'negative'),
      );
      rows.push(publicationRow);
    }

    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(
      ...this.buildFooterButtons({
        miniappRoute: rulesSettingsMiniappRoute,
        miniappUrl: rulesSettingsMiniappUrl,
      }),
    );

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
        textFormat: 'markdown',
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
    const entityType = session.selectedEntityType ?? 'chat';
    const waitingForContent = session.pendingInput?.kind === 'broadcast_content';
    const plannerUrl = this.buildBroadcastSettingsMiniappUrl(session.selectedChatId, entityType);
    const plannerRoute = this.buildBroadcastSettingsMiniappRoute(
      session.selectedChatId,
      entityType,
    );
    const hasText = draft.text.trim().length > 0;
    const hasContent = hasText || draft.imageEnabled;
    const usesMarkdown = hasText && draft.textFormat === 'markdown';
    const entityLead = await this.buildSelectedEntityLeadLine(context.actor, session, usesMarkdown);
    const imagePayload = hasContent
      ? await this.buildContentPreviewImagePayload(
          {
            imageEnabled: draft.imageEnabled,
            imageBase64: draft.imageBase64,
            imageMimeType: draft.imageMimeType,
            imageFileName: draft.imageFileName,
          },
          'private-broadcast-preview',
        )
      : undefined;
    const promptText =
      waitingForContent || !hasContent
        ? 'Пришлите текст или фото.'
        : 'Пришлите новый текст или фото.';
    const textPayload = usesMarkdown
      ? this.buildHtmlPreviewText({
          entityLead,
          contentText: hasText ? draft.text : null,
          promptText,
          notice,
        })
      : this.buildPlainPreviewText({
          entityLead,
          contentText: hasText ? draft.text : null,
          promptText,
          notice,
        });
    const rows: MaxMessageButton[][] = [];

    if (hasContent) {
      rows.push([this.callbackButton('Опубликовать', this.cb('broadcast_send'), 'positive')]);
    }

    rows.push([this.buildMiniappLaunchButton('В приложение', plannerRoute, plannerUrl)]);

    return {
      text: textPayload.text,
      options: {
        buttons: rows,
        ...(imagePayload ? { imagePayload } : {}),
        ...(textPayload.textFormat ? { textFormat: textPayload.textFormat } : {}),
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
    const entityTitle = await this.resolveManagedEntityTitle(
      context.actor,
      session.selectedEntityType,
      session.selectedChatId,
    );
    const statusLabel =
      poll.status === 'ACTIVE' ? 'Активен' : poll.status === 'CLOSED' ? 'Закрыт' : 'Черновик';
    const totalVotes = poll.totalVotes;

    const lines: string[] = [
      this.markdownTitle('Опрос'),
      '',
      `${entityLabel}: ${this.escapeMarkdown(entityTitle)}`,
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
    if (giveaway?.status === 'DRAFT') {
      if (session.pendingInput?.kind === 'giveaway_content' || !giveaway.description.trim()) {
        return this.renderGiveawayContentPrompt(context, session, notice);
      }

      return this.renderGiveawayDraftPreview(context, session, notice);
    }

    const entityLabel = session.selectedEntityType === 'channel' ? 'Канал' : 'Чат';
    const entityTitle = await this.resolveManagedEntityTitle(
      context.actor,
      session.selectedEntityType,
      session.selectedChatId,
    );
    const rows: MaxMessageButton[][] = [];
    const lines: string[] = [
      this.markdownTitle('Розыгрыш'),
      '',
      `${entityLabel}: ${this.escapeMarkdown(entityTitle)}`,
    ];

    if (!giveaway) {
      lines.push('', 'Черновик не создан.');
      rows.push([this.callbackButton('Создать черновик', this.cb('giveaway_create'), 'positive')]);
    } else {
      lines.push(
        `Название: ${this.escapeMarkdown(giveaway.title)}`,
        '',
        'Контент публикации:',
        giveaway.description.trim() || 'не задан',
        ...(giveaway.imageEnabled
          ? ['', 'Медиа: фото будет отправлено вместе с публикацией.']
          : []),
        '',
        `Мест: ${giveaway.prizes.length}`,
        ...(giveaway.endsAt ? [`Финиш: ${this.formatDateTimeLabel(giveaway.endsAt)}`] : []),
        ...(giveaway.status === 'ACTIVE' ||
        giveaway.status === 'SCHEDULED' ||
        giveaway.status === 'COMPLETED'
          ? [`Участники: ${giveaway.entriesCount}`, `Победители: ${giveaway.winnersCount}`]
          : []),
        'Остальные настройки редактируются в приложении.',
      );

      if (giveaway.status === 'ACTIVE' || giveaway.status === 'SCHEDULED') {
        rows.push([
          this.callbackButton('Завершить розыгрыш', this.cb('giveaway_close'), 'positive'),
        ]);
        rows.push([
          this.callbackButton('Отменить розыгрыш', this.cb('giveaway_cancel'), 'negative'),
        ]);
      }

      const winnerActionRows = giveaway.winners.flatMap((winner) => {
        const actionRow: MaxMessageButton[] = [];

        if (
          giveaway.status === 'COMPLETED' &&
          (winner.status === 'SELECTED' ||
            winner.status === 'CLAIMED' ||
            winner.status === 'EXPIRED')
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
      lines.push('', `Результат: ${this.escapeMarkdown(notice)}`);
    }

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
        textFormat: 'markdown',
      },
    };
  }

  private buildGiveawayDraftActionRows(
    giveawaySettingsMiniappRoute: string,
    giveawaySettingsMiniappUrl: string | null,
  ): MaxMessageButton[][] {
    return [
      [this.callbackButton('Опубликовать', this.cb('giveaway_publish'), 'positive')],
      [
        this.buildMiniappLaunchButton(
          'В приложение',
          giveawaySettingsMiniappRoute,
          giveawaySettingsMiniappUrl,
        ),
      ],
    ];
  }

  private buildGiveawayPreviewText(
    giveaway: Pick<ManagedGiveawayDetails, 'description' | 'title'>,
  ): string {
    const description = giveaway.description.trim();
    if (description) {
      return description;
    }

    const title = giveaway.title.trim();
    return title || 'Розыгрыш';
  }

  private buildGiveawayPreviewTextFormat(
    previewText: string,
  ): MaxSendMessageOptions['textFormat'] | undefined {
    return this.shouldUseMarkdown(previewText) ? 'markdown' : undefined;
  }

  private buildPlainPreviewText(payload: {
    entityLead: string | null;
    contentText: string | null;
    promptText: string | null;
    notice: string | null;
  }): { text: string; textFormat?: MaxSendMessageOptions['textFormat'] } {
    const lines: string[] = [];

    if (payload.entityLead) {
      lines.push(payload.entityLead);
    }

    if (payload.contentText) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(payload.contentText);
    }

    if (payload.promptText) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(payload.promptText);
    }

    if (payload.notice) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(payload.notice);
    }

    return { text: lines.join('\n') };
  }

  private buildHtmlPreviewText(payload: {
    entityLead: string | null;
    contentText: string | null;
    promptText: string | null;
    notice: string | null;
  }): { text: string; textFormat: MaxSendMessageOptions['textFormat'] } {
    const blocks: string[] = [];

    if (payload.entityLead) {
      blocks.push(`<p>${this.escapeHtml(payload.entityLead)}</p>`);
    }

    if (payload.contentText) {
      blocks.push(
        renderSupportedMarkdownAsHtml(payload.contentText, {
          linkMode: 'underline',
        }),
      );
    }

    if (payload.promptText) {
      blocks.push(`<p>${this.escapeHtml(payload.promptText)}</p>`);
    }

    if (payload.notice) {
      blocks.push(`<p>${this.escapeHtml(payload.notice)}</p>`);
    }

    return {
      text: blocks.join(''),
      textFormat: 'html',
    };
  }

  private async buildContentPreviewImagePayload(
    content: Pick<
      ManagedGiveawayDetails,
      'imageEnabled' | 'imageBase64' | 'imageMimeType' | 'imageFileName'
    >,
    filePrefix: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (!content.imageEnabled || !content.imageBase64.trim()) {
      return undefined;
    }

    const mimeType = content.imageMimeType.trim() || 'image/jpeg';

    try {
      const imageBuffer = Buffer.from(content.imageBase64, 'base64');
      if (imageBuffer.length === 0) {
        return undefined;
      }

      return await this.maxClient.uploadImage(
        imageBuffer,
        this.buildDownloadedFileName(filePrefix, content.imageFileName, null, mimeType),
        mimeType,
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to upload private preview image',
      );
      return undefined;
    }
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

  private async resolveManagedEntityTitle(
    actor: AuthUser,
    entityType: ManagedEntityType,
    entityId: string,
  ): Promise<string> {
    const entities = await this.adminService.listManagedEntities(actor, entityType);
    const selected = entities.find((entity) => entity.id === entityId);
    const normalizedTitle = selected?.title?.trim() ?? '';
    return normalizedTitle.length > 0 ? normalizedTitle : entityId;
  }

  private async buildSelectedEntityLeadLine(
    actor: AuthUser,
    session: Pick<PrivateSession, 'selectedChatId' | 'selectedEntityType'>,
    markdown: boolean,
  ): Promise<string | null> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      return null;
    }

    const entityLabel = session.selectedEntityType === 'channel' ? 'Канал' : 'Чат';
    const entityTitle = await this.resolveManagedEntityTitle(
      actor,
      session.selectedEntityType,
      session.selectedChatId,
    );

    return markdown
      ? `${entityLabel}: ${this.escapeMarkdown(entityTitle)}`
      : `${entityLabel}: ${entityTitle}`;
  }

  private buildBroadcastCompletionNotice(result: SendBroadcastResult): string {
    if (result.sentChats === 0 && result.nextSendAt) {
      return `Будет опубликовано: ${this.formatDateTimeLabel(
        result.nextSendAt,
        result.scheduleTimezone,
      )}.`;
    }

    if (result.failedChats > 0) {
      return `Отправлено: ${result.sentChats}/${result.targetChats}, ошибок: ${result.failedChats}.`;
    }

    if (result.nextSendAt && result.scheduledOccurrences > 0) {
      return `Опубликовано. Следующий слот: ${this.formatDateTimeLabel(
        result.nextSendAt,
        result.scheduleTimezone,
      )}.`;
    }

    return 'Опубликовано без ошибок.';
  }

  private buildBroadcastSuccessMessage(result: SendBroadcastResult): string {
    if (result.sentChats === 0 && result.nextSendAt) {
      return `✅ Всё успешно. Рассылка запланирована на ${this.formatDateTimeLabel(
        result.nextSendAt,
        result.scheduleTimezone,
      )}.`;
    }

    if (result.nextSendAt && result.scheduledOccurrences > 0) {
      return `✅ Всё успешно. Первый слот отправлен, следующий: ${this.formatDateTimeLabel(
        result.nextSendAt,
        result.scheduleTimezone,
      )}.`;
    }

    return '✅ Всё успешно. Рассылка отправлена без ошибок.';
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
      winner.status === 'DELIVERED'
        ? 'Приз выдан'
        : winner.status === 'EXPIRED'
          ? 'Место ждёт реролл'
          : 'Победитель зафиксирован';
    const lines = [
      this.markdownTitle('Розыгрыш'),
      '',
      this.escapeMarkdown(giveaway.title),
      `${winner.prizePosition}. ${this.escapeMarkdown(winner.prizeTitle)}`,
      `Статус: ${statusLabel}`,
      `Победитель: ${this.escapeMarkdown(winner.displayName ?? winner.userId)}`,
      ...(notice ? ['', `Статус: ${this.escapeMarkdown(notice)}`] : []),
    ];

    const rows: MaxMessageButton[][] = [];
    const linkRow: MaxMessageButton[] = [];
    if (giveaway.publicationUrl) {
      linkRow.push({
        type: 'link',
        text: 'Открыть пост',
        url: giveaway.publicationUrl,
      });
    }
    if (giveaway.resultsUrl) {
      linkRow.push({
        type: 'link',
        text: 'Итоги',
        url: giveaway.resultsUrl,
      });
    }
    if (linkRow.length > 0) {
      rows.push(linkRow);
    }
    rows.push([this.callbackButton('Главный экран', this.cb('home'))]);

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private renderUnavailableGiveawayClaimView(): PrivateView {
    return {
      text: [
        this.markdownTitle('Розыгрыш'),
        '',
        'Итоги уже зафиксированы. Подтверждение победителя больше не требуется.',
      ].join('\n'),
      options: {
        buttons: [[this.callbackButton('Главный экран', this.cb('home'))]],
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
          `Сообщение: ${this.describeBooleanCompact(settings.greetingBotMessageEnabled)} • автоудаление ${this.describeBooleanCompact(settings.greetingDeleteBotMessageEnabled)} • кнопка ${this.describeBooleanCompact(settings.greetingBotButtonEnabled)}`,
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
          `Лимит сообщений: ${settings.messageCountLimitEnabled ? `${settings.messageCountLimitMessages} за ${settings.messageCountLimitWindowHours}ч` : 'выкл'}`,
          `Медиа: видео ${this.describeBooleanCompact(settings.videoMessagesEnabled)} • файлы ${this.describeBooleanCompact(settings.fileMessagesEnabled)} • голосовые ${this.describeBooleanCompact(settings.voiceMessagesEnabled)}`,
          `Стоп-слова: ${settings.messageLimitsBlockedWords.length > 0 ? settings.messageLimitsBlockedWords.length : 'выкл'}`,
          `Сообщение: ${this.describeBooleanCompact(settings.messageLimitsBotMessageEnabled)} • кнопка ${this.describeBooleanCompact(settings.messageLimitsBotButtonEnabled)}`,
        ];
      case 'night':
        return [
          `Ночной режим: ${this.describeBooleanCompact(settings.nightModeEnabled)}`,
          `Окно: ${this.formatTime(settings.nightModeStartTimeMinutes)}-${this.formatTime(settings.nightModeEndTimeMinutes)} • ${settings.nightModeTimezone || 'не задан'}`,
          `Сообщение: ${this.describeBooleanCompact(settings.nightModeBotMessageEnabled)} • кнопка ${this.describeBooleanCompact(settings.nightModeBotButtonEnabled)}`,
          `Ручное закрытие: ${this.describeBooleanCompact(settings.nightModeForceCloseEnabled)}${settings.nightModeForceCloseEnabled ? ` • ${settings.nightModeForceCloseForever ? 'бессрочно' : `${settings.nightModeForceCloseDays}д ${settings.nightModeForceCloseHours}ч`}` : ''}`,
        ];
      case 'extra':
        return [
          `Удаление спаммеров: ${this.describeBooleanCompact(settings.deleteSpammersEnabled)}`,
          `Сообщения бота: ${this.describeBooleanCompact(settings.deleteBotMessagesEnabled)} • задержка ${formatDeleteBotMessagesDelayLabel(settings.deleteBotMessagesDelayMinutes)}`,
          `Удаление ботов: ${this.describeBooleanCompact(settings.removeBotsFromGroupEnabled)}`,
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
            `${currentValue ? '✅' : '⬜'} ${field.label}`,
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
            `${field.label}: ${this.compactText(this.formatNumberPreset(field, numericValue), 12)}`,
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
            `${settings[field.key] ? '✅' : '⬜'} ${field.label}`,
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
        if (settings.messageLimitsBlockedWords.length > 0) {
          return `${settings.messageLimitsBlockedWords.length} стоп-слов`;
        }
        if (settings.messageCountLimitEnabled) {
          return `${settings.messageCountLimitMessages} сообщ. за ${settings.messageCountLimitWindowHours}ч`;
        }
        return settings.antiSpamEnabled ? 'антиспам включен' : 'выключено';
      case 'night':
        return settings.nightModeEnabled
          ? `${this.formatTime(settings.nightModeStartTimeMinutes)}-${this.formatTime(settings.nightModeEndTimeMinutes)}`
          : 'выключено';
      case 'extra':
        return settings.deleteSpammersEnabled ? 'автоудаление спаммеров активно' : 'доп. опции';
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
    if (key === 'deletebotmessagesdelayminutes') {
      return formatDeleteBotMessagesDelayLabel(value);
    }
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
      ...(prefix ? [this.escapeMarkdown(prefix), ''] : []),
      this.markdownTitle('Быстрый старт'),
      '',
      'Управление через кнопки.',
      'Выберите чат и действие.',
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
        this.markdownTitle(`Введите: ${prompt.title}`),
        '',
        this.escapeMarkdown(prompt.description),
      ].join('\n'),
      options: {
        buttons: [
          [this.callbackButton('Отмена', this.cb('input_cancel'))],
          ...this.buildFooterButtons(),
        ],
      },
    };
  }

  private renderChannelSuggestionIntroView(): PrivateView {
    return {
      text: [
        this.markdownTitle('Контент для поста'),
        '',
        'Пришлите следующим сообщением текст, фото или фото с подписью.',
        'После этого бот сразу отправит материал админу канала на проверку.',
        'Если нужен ориентир, нажмите «Что отправить».',
      ].join('\n'),
      options: {
        buttons: this.buildChannelSuggestionButtons(),
      },
    };
  }

  private renderChannelSuggestionSubmittedView(): PrivateView {
    return {
      text: [
        this.markdownTitle('Материал отправлен'),
        '',
        'Бот переслал его админу канала на проверку.',
        'Если материал подойдёт, его опубликуют в канале.',
        '',
        'Можете сразу прислать ещё один вариант.',
      ].join('\n'),
      options: {
        buttons: this.buildChannelSuggestionButtons(),
      },
    };
  }

  private renderChannelSuggestionQueuedView(): PrivateView {
    return {
      text: [
        this.markdownTitle('Материал сохранён'),
        '',
        'Материал записал, но сейчас не удалось сразу доставить его админу канала.',
        'Он всё равно останется в очереди на проверку.',
        '',
        'Можно сразу отправить ещё один вариант.',
      ].join('\n'),
      options: {
        buttons: this.buildChannelSuggestionButtons(),
      },
    };
  }

  private renderChannelSuggestionHelpView(): PrivateView {
    return {
      text: [
        this.markdownTitle('Что лучше прислать'),
        '',
        '1. Готовый текст поста или короткий черновик.',
        '2. Фото, если оно важно для публикации.',
        '3. Ссылку и 1-2 строки контекста, если нужен источник.',
        '',
        'Фото без текста тоже подойдёт.',
      ].join('\n'),
      options: {
        buttons: this.buildChannelSuggestionButtons(),
      },
    };
  }

  private renderChannelSuggestionCancelledView(): PrivateView {
    return {
      text: [
        this.markdownTitle('Предложка закрыта'),
        '',
        'Если захотите отправить материал позже, снова нажмите кнопку под постом.',
      ].join('\n'),
    };
  }

  private buildChannelSuggestionButtons(): MaxMessageButton[][] {
    return [
      [
        this.callbackButton('Что отправить', this.cb('suggest_help')),
        this.callbackButton('Отмена', this.cb('input_cancel'), 'negative'),
      ],
    ];
  }

  private renderMassActionConfirmation(pendingMassAction: PendingMassAction): PrivateView {
    const text =
      pendingMassAction.kind === 'apply_section'
        ? [
            this.markdownTitle('Подтвердите применение для всех чатов'),
            '',
            `Раздел: ${SECTION_LABELS[pendingMassAction.section]}`,
            `Количество чатов: ${pendingMassAction.targetChats}`,
            '',
            'Применить эти настройки во всех доступных чатах?',
          ].join('\n')
        : [
            this.markdownTitle('Подтвердите массовую рассылку'),
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
      case 'broadcast_text':
        return {
          title: 'Текст рассылки',
          description: 'Введите текст рассылки (до 2000 символов).',
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
          description: 'Введите число от 1 до 100.',
        };
      case 'broadcast_photo':
        return {
          title: 'Фото для рассылки',
          description: 'Отправьте фото следующим сообщением. Бот добавит его в черновик.',
        };
      case 'rules_text':
        return {
          title: 'Текст правил',
          description: 'Отправьте только текст правил следующим сообщением.',
        };
      case 'rules_photo':
        return {
          title: 'Фото правил',
          description: 'Отправьте только фото или PNG/WebP/JPG файлом следующим сообщением.',
        };
      case 'channel_suggestion':
        return {
          title: 'Контент для поста',
          description:
            'Пришлите следующим сообщением текст, фото или фото с подписью. После этого бот отправит материал админу канала. Для деталей нажмите «Что отправить», для выхода используйте `Отмена`.',
        };
      case 'giveaway_title':
        return {
          title: 'Служебное название',
          description: 'Введите короткое название для админки.',
        };
      case 'giveaway_content':
        return {
          title: 'Контент розыгрыша',
          description:
            'Пришлите текст публикации. Фото можно добавить сразу подписью к фото или отдельным сообщением. `-` очищает текст.',
        };
      case 'giveaway_description':
        return {
          title: 'Текст публикации',
          description: 'Введите полный текст. Бот отправит его без дописок. `-` очищает поле.',
        };
      case 'giveaway_start_at':
        return {
          title: 'Время старта',
          description: 'Введите дату/время или `-` для старта сразу.',
        };
      case 'giveaway_end_at':
        return {
          title: 'Время завершения',
          description: 'Введите дату и время завершения.',
        };
      case 'giveaway_claim_hours':
        return {
          title: 'Срок подтверждения приза',
          description: 'Введите часы (1-336).',
        };
      case 'giveaway_photo':
        return {
          title: 'Фото публикации',
          description: 'Отправьте фото (опционально).',
        };
      case 'giveaway_prize':
        return {
          title: `Приз ${input.index + 1}`,
          description: 'Введите название приза.',
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
    const compactOptions = this.compactButtonLayout(view.options);
    const inferredTextFormat =
      compactOptions?.textFormat ?? (this.shouldUseMarkdown(text) ? 'markdown' : undefined);
    const optionsWithFormat = inferredTextFormat
      ? { ...(compactOptions ?? {}), textFormat: inferredTextFormat }
      : compactOptions;
    const options = this.withDebugContext(optionsWithFormat, session, callback.notification);

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

  private rememberPrivateChatId(session: PrivateSession, chatId: string): void {
    session.lastPrivateChatId = this.isPrivateDirectChat(chatId)
      ? chatId
      : session.lastPrivateChatId;
  }

  private wasGiveawayHandoffAlreadyDelivered(session: PrivateSession, chatId: string): boolean {
    if (
      !session.lastGiveawayHandoffDeliveredChatId ||
      session.lastGiveawayHandoffDeliveredChatId !== chatId
    ) {
      return false;
    }

    if (typeof session.lastGiveawayHandoffDeliveredAt !== 'number') {
      return false;
    }

    return Date.now() - session.lastGiveawayHandoffDeliveredAt < GIVEAWAY_HANDOFF_DEDUP_WINDOW_MS;
  }

  private clearDeliveredGiveawayHandoff(session: PrivateSession): void {
    session.lastGiveawayHandoffDeliveredChatId = null;
    session.lastGiveawayHandoffDeliveredAt = null;
  }

  private wasProfileMentionHandoffAlreadyDelivered(
    session: PrivateSession,
    chatId: string,
  ): boolean {
    if (
      !session.lastProfileMentionHandoffDeliveredChatId ||
      session.lastProfileMentionHandoffDeliveredChatId !== chatId
    ) {
      return false;
    }

    if (typeof session.lastProfileMentionHandoffDeliveredAt !== 'number') {
      return false;
    }

    return (
      Date.now() - session.lastProfileMentionHandoffDeliveredAt <
      PROFILE_MENTION_HANDOFF_DEDUP_WINDOW_MS
    );
  }

  private clearDeliveredProfileMentionHandoff(session: PrivateSession): void {
    session.lastProfileMentionHandoffDeliveredChatId = null;
    session.lastProfileMentionHandoffDeliveredAt = null;
  }

  private createSyntheticPrivateContext(user: AuthUser, privateChatId: string): PrivateContext {
    return {
      update: {
        updateId: 'miniapp-handoff',
        type: 'message_created',
        message: {
          messageId: 'miniapp-handoff',
          chatId: privateChatId,
          senderId: user.userId,
          senderName: user.displayName ?? user.username ?? user.userId,
          text: '',
          createdAt: new Date().toISOString(),
        },
      } as MaxUpdate,
      chatId: privateChatId,
      actor: {
        ...user,
        chatId: privateChatId,
      },
      text: '',
      callbackId: null,
      callbackPayload: null,
    };
  }

  private async deliverGiveawayHandoffToKnownPrivateChat(
    user: AuthUser,
    session: PrivateSession,
  ): Promise<void> {
    if (!session.lastPrivateChatId) {
      this.clearDeliveredGiveawayHandoff(session);
      return;
    }

    try {
      const context = this.createSyntheticPrivateContext(user, session.lastPrivateChatId);
      const view = await this.renderByCurrentScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      session.lastGiveawayHandoffDeliveredChatId = session.lastPrivateChatId;
      session.lastGiveawayHandoffDeliveredAt = Date.now();
      await this.saveSession(user.userId, session);
    } catch (error: unknown) {
      this.clearDeliveredGiveawayHandoff(session);
      this.logger.warn(
        {
          userId: user.userId,
          chatId: session.lastPrivateChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to proactively deliver giveaway handoff to private chat',
      );
    }
  }

  private async sendProfileMentionToPrivateChat(
    privateChatId: string,
    displayName: string,
    userId: string,
  ): Promise<void> {
    const mentionText = `[${this.escapeMarkdown(displayName)}](max://user/${encodeURIComponent(userId)})`;
    await this.sendImmediate(
      privateChatId,
      [this.markdownTitle('Профиль пользователя'), '', mentionText].join('\n'),
      {
        textFormat: 'markdown',
      },
    );
  }

  private async deliverProfileMentionHandoffToKnownPrivateChat(
    user: AuthUser,
    session: PrivateSession,
    payload: { displayName: string; userId: string },
  ): Promise<void> {
    if (!session.lastPrivateChatId) {
      this.clearDeliveredProfileMentionHandoff(session);
      return;
    }

    try {
      await this.sendProfileMentionToPrivateChat(
        session.lastPrivateChatId,
        payload.displayName,
        payload.userId,
      );
      session.lastProfileMentionHandoffDeliveredChatId = session.lastPrivateChatId;
      session.lastProfileMentionHandoffDeliveredAt = Date.now();
      await this.saveSession(user.userId, session);
    } catch (error: unknown) {
      this.clearDeliveredProfileMentionHandoff(session);
      this.logger.warn(
        {
          userId: user.userId,
          chatId: session.lastPrivateChatId,
          targetUserId: payload.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to proactively deliver profile mention handoff to private chat',
      );
    }
  }

  private compactButtonLayout(
    options: MaxSendMessageOptions | undefined,
  ): MaxSendMessageOptions | undefined {
    if (!options) {
      return undefined;
    }

    const compactSingleButton = options.button
      ? {
          ...options.button,
          text: this.compactText(options.button.text, BUTTON_TEXT_MAX_SINGLE_COLUMN),
        }
      : undefined;

    const compactGrid = options.buttons?.map((row) => {
      const maxLength =
        row.length >= 2 ? BUTTON_TEXT_MAX_TWO_COLUMNS : BUTTON_TEXT_MAX_SINGLE_COLUMN;
      return row.map((button) => ({
        ...button,
        text: this.compactText(button.text, maxLength),
      }));
    });

    return {
      ...options,
      ...(compactSingleButton ? { button: compactSingleButton } : {}),
      ...(compactGrid ? { buttons: compactGrid } : {}),
    };
  }

  private shouldUseMarkdown(text: string): boolean {
    return containsSupportedMarkdownSyntax(text);
  }

  private extractIncomingFormattedText(update: MaxUpdate, fallbackText: string): string {
    const messageNode = this.extractIncomingMessageNode(update);
    const body = this.asRecord(messageNode?.body);
    const sourceText = this.readString(body?.text ?? messageNode?.text) || fallbackText;
    if (!sourceText) {
      return fallbackText;
    }

    const markup = this.extractIncomingMessageMarkup(messageNode);
    const rendered = this.renderIncomingMarkupAsMarkdown(sourceText, markup);
    return rendered || sourceText;
  }

  private extractIncomingMessageNode(update: MaxUpdate): Record<string, unknown> | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    return (
      this.asRecord(raw.message) ??
      (data ? this.asRecord(data.message) : null) ??
      (event ? this.asRecord(event.message) : null) ??
      null
    );
  }

  private extractIncomingMessageMarkup(
    messageNode: Record<string, unknown> | null,
  ): IncomingMessageMarkup[] {
    const body = this.asRecord(messageNode?.body);
    const rawMarkup = Array.isArray(body?.markup)
      ? body.markup
      : Array.isArray(messageNode?.markup)
        ? messageNode.markup
        : [];

    return rawMarkup
      .map((item) => this.normalizeIncomingMessageMarkup(item))
      .filter((item): item is IncomingMessageMarkup => item !== null);
  }

  private normalizeIncomingMessageMarkup(value: unknown): IncomingMessageMarkup | null {
    const row = this.asRecord(value);
    if (!row) {
      return null;
    }

    const type = this.readLowerString(row.type);
    const from = this.readOptionalInteger(row.from);
    const length = this.readOptionalInteger(row.length);
    if (
      !type ||
      from === null ||
      length === null ||
      from < 0 ||
      length <= 0 ||
      ![
        'emphasized',
        'heading',
        'link',
        'monospaced',
        'strikethrough',
        'strong',
        'underline',
        'user_mention',
      ].includes(type)
    ) {
      return null;
    }

    return {
      from,
      length,
      type: type as IncomingMessageMarkup['type'],
      url: this.readString(row.url) || null,
      userLink: this.readString(row.user_link ?? row.userLink) || null,
    };
  }

  private renderIncomingMarkupAsMarkdown(
    text: string,
    markup: IncomingMessageMarkup[],
  ): string | null {
    if (markup.length === 0) {
      return null;
    }

    const chars = Array.from(text);
    const openTags = new Map<
      number,
      Array<{ open: string; close: string; end: number; priority: number }>
    >();
    const closeTags = new Map<
      number,
      Array<{ close: string; start: number; end: number; priority: number }>
    >();

    for (const item of markup) {
      const start = item.from;
      const end = item.from + item.length;
      if (start < 0 || end <= start || end > chars.length) {
        continue;
      }

      const delimiters = this.resolveIncomingMarkupMarkdownDelimiters(
        item,
        chars.slice(start, end).join(''),
      );
      if (!delimiters) {
        continue;
      }

      const openBucket = openTags.get(start) ?? [];
      openBucket.push({
        open: delimiters.open,
        close: delimiters.close,
        end,
        priority: delimiters.priority,
      });
      openTags.set(start, openBucket);

      const closeBucket = closeTags.get(end) ?? [];
      closeBucket.push({
        close: delimiters.close,
        start,
        end,
        priority: delimiters.priority,
      });
      closeTags.set(end, closeBucket);
    }

    if (openTags.size === 0 && closeTags.size === 0) {
      return null;
    }

    let markdown = '';
    for (let index = 0; index < chars.length; index += 1) {
      const closing = closeTags.get(index);
      if (closing) {
        closing
          .slice()
          .sort(
            (left, right) =>
              right.start - left.start || left.end - right.end || right.priority - left.priority,
          )
          .forEach((tag) => {
            markdown += tag.close;
          });
      }

      const opening = openTags.get(index);
      if (opening) {
        opening
          .slice()
          .sort((left, right) => right.end - left.end || left.priority - right.priority)
          .forEach((tag) => {
            markdown += tag.open;
          });
      }

      markdown += this.escapeMarkdownText(chars[index] ?? '');
    }

    const trailing = closeTags.get(chars.length);
    if (trailing) {
      trailing
        .slice()
        .sort(
          (left, right) =>
            right.start - left.start || left.end - right.end || right.priority - left.priority,
        )
        .forEach((tag) => {
          markdown += tag.close;
        });
    }

    return markdown;
  }

  private resolveIncomingMarkupMarkdownDelimiters(
    markup: IncomingMessageMarkup,
    visibleText: string,
  ): { open: string; close: string; priority: number } | null {
    switch (markup.type) {
      case 'strong':
        return { open: '**', close: '**', priority: 20 };
      case 'heading':
        return { open: '# ', close: '', priority: 5 };
      case 'emphasized':
        return { open: '_', close: '_', priority: 30 };
      case 'underline':
        return { open: '++', close: '++', priority: 40 };
      case 'strikethrough':
        return { open: '~~', close: '~~', priority: 50 };
      case 'monospaced':
        return visibleText.includes('\n') ? null : { open: '`', close: '`', priority: 60 };
      case 'link':
        return markup.url
          ? {
              open: '[',
              close: `](${markup.url})`,
              priority: 10,
            }
          : null;
      case 'user_mention': {
        const mentionTarget = markup.userLink
          ? markup.userLink.startsWith('max://')
            ? markup.userLink
            : `https://max.ru/${markup.userLink}`
          : null;
        return mentionTarget
          ? {
              open: '[',
              close: `](${mentionTarget})`,
              priority: 10,
            }
          : null;
      }
      default:
        return null;
    }
  }

  private escapeMarkdownText(value: string): string {
    return value.replace(/([\\`*_[\]()~+])/g, '\\$1');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  private buildFooterButtons(config?: {
    includeMiniapp?: boolean;
    includeSupport?: boolean;
    miniappText?: string;
    miniappRoute?: string | null;
    miniappUrl?: string | null;
  }): MaxMessageButton[][] {
    const row: MaxMessageButton[] = [];
    const includeMiniapp = config?.includeMiniapp !== false;
    const includeSupport = config?.includeSupport !== false;
    const miniappRoute = config?.miniappRoute?.trim() || '/';
    const miniappUrl = config?.miniappUrl ?? this.resolveMiniappUrl();
    const miniappText = config?.miniappText?.trim() || 'Мини-апп';
    const miniappLaunchUrl = this.buildMiniappRouteLaunchUrl(miniappRoute);

    if (includeMiniapp && (miniappLaunchUrl || miniappUrl)) {
      row.push(this.buildMiniappLaunchButton(miniappText, miniappRoute, miniappUrl));
    }

    if (includeSupport) {
      row.push({
        type: 'link',
        text: 'Поддержка',
        url: SUPPORT_CHAT_URL,
      });
    }

    return row.length > 0 ? [row] : [];
  }

  private buildMiniappLaunchButton(
    text: string,
    route: string,
    fallbackWebAppUrl: string | null,
  ): MaxMessageButton {
    const launchUrl = this.buildMiniappRouteLaunchUrl(route);
    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    if (fallbackWebAppUrl) {
      return this.buildMiniappOpenButton(text, fallbackWebAppUrl);
    }

    return {
      type: 'link',
      text,
      url: 'https://maxim.play-team.ru/app/',
    };
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

  private buildEntitySettingsMiniappUrl(
    chatId: string,
    entityType: ManagedEntityType,
    focus?: string | null,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app${this.buildEntitySettingsMiniappRoute(chatId, entityType, focus)}`;
  }

  private buildEntitySettingsMiniappRoute(
    chatId: string,
    entityType: ManagedEntityType,
    focus?: string | null,
  ): string {
    const encodedChatId = encodeURIComponent(chatId);
    const baseRoute =
      entityType === 'channel'
        ? `/channel/${encodedChatId}/settings`
        : `/chat/${encodedChatId}/settings`;
    const normalizedFocus = focus?.trim();
    return normalizedFocus
      ? `${baseRoute}?focus=${encodeURIComponent(normalizedFocus)}`
      : baseRoute;
  }

  private buildEntityActivityMiniappUrl(
    chatId: string,
    entityType: ManagedEntityType,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app${this.buildEntityActivityMiniappRoute(chatId, entityType)}`;
  }

  private buildEntityActivityMiniappRoute(chatId: string, entityType: ManagedEntityType): string {
    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `/channel/${encodedChatId}/stats`
      : `/chat/${encodedChatId}/events`;
  }

  private buildBroadcastSettingsMiniappUrl(
    chatId: string,
    entityType: ManagedEntityType,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `${this.appBaseUrl}/app/channel/${encodedChatId}/settings?focus=broadcast&handoff=1`
      : `${this.appBaseUrl}/app/chat/${encodedChatId}/settings?focus=broadcast&handoff=1`;
  }

  private buildBroadcastSettingsMiniappRoute(
    chatId: string,
    entityType: ManagedEntityType,
  ): string {
    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `/channel/${encodedChatId}/settings?focus=broadcast&handoff=1`
      : `/chat/${encodedChatId}/settings?focus=broadcast&handoff=1`;
  }

  private buildRulesSettingsMiniappUrl(chatId: string): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const encodedChatId = encodeURIComponent(chatId);
    return `${this.appBaseUrl}/app/chat/${encodedChatId}/settings?focus=rules&handoff=1`;
  }

  private buildRulesSettingsMiniappRoute(chatId: string): string {
    return `/chat/${encodeURIComponent(chatId)}/settings?focus=rules&handoff=1`;
  }

  private resetSessionToPrimaryScreen(session: PrivateSession): void {
    session.screen = this.resolvePrimaryScreen(session);
    session.section = null;
    session.channelSection = null;
    session.pendingInput = null;
    session.pendingMassAction = null;
    session.searchQuery = null;
    session.manualTargetUserId = null;
  }

  private async renderMiniappMovedScreen(
    context: PrivateContext,
    session: PrivateSession,
    config: {
      title: string;
      description: string;
      buttonText: string;
      miniappRoute: string;
      miniappUrl: string | null;
    },
  ): Promise<PrivateView> {
    const entityType = session.selectedEntityType ?? 'chat';
    const entityLabel = entityType === 'channel' ? 'Канал' : 'Чат';
    const entityTitle = session.selectedChatId
      ? await this.resolveManagedEntityTitle(context.actor, entityType, session.selectedChatId)
      : null;
    const lines = [
      this.markdownTitle(config.title),
      '',
      ...(entityTitle ? [`${entityLabel}: ${this.escapeMarkdown(entityTitle)}`] : []),
      config.description,
      'В боте оставлены только базовые действия: принять текст/фото и подтвердить публикацию.',
    ];

    return {
      text: lines.join('\n'),
      options: {
        buttons: [
          [
            this.buildMiniappLaunchButton(
              config.buttonText,
              config.miniappRoute,
              config.miniappUrl,
            ),
          ],
          [
            this.callbackButton('Главный экран', this.cb('home')),
            this.callbackButton(
              entityType === 'channel' ? 'Сменить канал' : 'Сменить чат',
              this.cb('change_chat'),
            ),
          ],
          ...this.buildFooterButtons({ includeMiniapp: false }),
        ],
        textFormat: 'markdown',
      },
    };
  }

  private async renderEntitySettingsMovedToMiniappScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    const entityType = session.selectedEntityType ?? 'chat';
    const chatId = session.selectedChatId ?? context.chatId;
    return this.renderMiniappMovedScreen(context, session, {
      title: 'Настройки перенесены в mini app',
      description:
        'Основные настройки и rich-сценарии больше не управляются inline-кнопками в боте.',
      buttonText: 'Открыть управление',
      miniappRoute: this.buildEntitySettingsMiniappRoute(chatId, entityType),
      miniappUrl: this.buildEntitySettingsMiniappUrl(chatId, entityType),
    });
  }

  private async renderEntityActivityMovedToMiniappScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    const entityType = session.selectedEntityType ?? 'chat';
    const chatId = session.selectedChatId ?? context.chatId;
    return this.renderMiniappMovedScreen(context, session, {
      title: 'Активность открывается в mini app',
      description: 'События, логи и ручная модерация теперь доступны в экране активности mini app.',
      buttonText: entityType === 'channel' ? 'Открыть статистику' : 'Открыть активность',
      miniappRoute: this.buildEntityActivityMiniappRoute(chatId, entityType),
      miniappUrl: this.buildEntityActivityMiniappUrl(chatId, entityType),
    });
  }

  private buildGiveawaySettingsMiniappUrl(
    chatId: string,
    entityType: ManagedEntityType,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `${this.appBaseUrl}/app/channel/${encodedChatId}/settings?focus=giveaway&handoff=1`
      : `${this.appBaseUrl}/app/chat/${encodedChatId}/settings?focus=giveaway&handoff=1`;
  }

  private buildGiveawaySettingsMiniappRoute(chatId: string, entityType: ManagedEntityType): string {
    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `/channel/${encodedChatId}/settings?focus=giveaway&handoff=1`
      : `/chat/${encodedChatId}/settings?focus=giveaway&handoff=1`;
  }

  private buildMiniappRouteLaunchUrl(route: string): string | null {
    return this.buildMiniappStartUrl(this.buildMiniappRouteStartParam(route));
  }

  private buildMiniappRouteStartParam(route: string): string {
    const payload = JSON.stringify({
      v: 1,
      k: 'route',
      r: route,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${MINIAPP_ROUTE_START_PARAM_PREFIX}${encoded}`;
  }

  private buildMiniappStartUrl(startParam: string): string | null {
    if (!this.botDeepLinkId) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.botDeepLinkId)}?startapp=${encodeURIComponent(startParam)}`;
  }

  private buildBotStartUrl(startPayload: string): string | null {
    if (!this.botDeepLinkId) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.botDeepLinkId)}?start=${encodeURIComponent(startPayload)}`;
  }

  private buildGiveawayHandoffStartPayload(params: {
    chatId: string;
    entityType: ManagedEntityType;
    giveawayId: string | null;
  }): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'giveaway-handoff',
        c: params.chatId,
        e: params.entityType,
        g: params.giveawayId,
      } satisfies GiveawayHandoffStartPayload),
      'utf8',
    ).toString('base64url');

    return `${GIVEAWAY_HANDOFF_START_PREFIX}${payload}`;
  }

  private buildProfileMentionStartPayload(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    displayName: string;
  }): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'profile-mention',
        c: params.chatId,
        e: params.entityType,
        u: params.userId,
        n: params.displayName.trim() || 'Пользователь',
      } satisfies ProfileMentionStartPayload),
      'utf8',
    ).toString('base64url');

    return `${PROFILE_MENTION_START_PREFIX}${payload}`;
  }

  private parseGiveawayHandoffStartPayload(
    startPayload: string | null,
  ): { chatId: string; entityType: ManagedEntityType; giveawayId: string | null } | null {
    if (!startPayload || startPayload === GIVEAWAY_HANDOFF_START_PAYLOAD) {
      return null;
    }

    if (!startPayload.startsWith(GIVEAWAY_HANDOFF_START_PREFIX)) {
      return null;
    }

    const encodedPayload = startPayload.slice(GIVEAWAY_HANDOFF_START_PREFIX.length);
    if (!encodedPayload) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<GiveawayHandoffStartPayload>;
      const chatId = typeof parsed.c === 'string' ? parsed.c.trim() : '';
      const entityType = parsed.e === 'channel' ? 'channel' : parsed.e === 'chat' ? 'chat' : null;
      const giveawayId =
        typeof parsed.g === 'string' && parsed.g.trim().length > 0 ? parsed.g.trim() : null;

      if (parsed.v !== 1 || parsed.k !== 'giveaway-handoff' || !chatId || !entityType) {
        return null;
      }

      return {
        chatId,
        entityType,
        giveawayId,
      };
    } catch {
      return null;
    }
  }

  private parseProfileMentionStartPayload(
    startPayload: string | null,
  ): { chatId: string; entityType: ManagedEntityType; userId: string; displayName: string } | null {
    if (!startPayload || !startPayload.startsWith(PROFILE_MENTION_START_PREFIX)) {
      return null;
    }

    const encodedPayload = startPayload.slice(PROFILE_MENTION_START_PREFIX.length);
    if (!encodedPayload) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<ProfileMentionStartPayload>;
      const chatId = typeof parsed.c === 'string' ? parsed.c.trim() : '';
      const entityType = parsed.e === 'channel' ? 'channel' : parsed.e === 'chat' ? 'chat' : null;
      const userId = typeof parsed.u === 'string' ? parsed.u.trim() : '';
      const displayName = typeof parsed.n === 'string' ? parsed.n.trim() : '';

      if (parsed.v !== 1 || parsed.k !== 'profile-mention' || !chatId || !entityType || !userId) {
        return null;
      }

      return {
        chatId,
        entityType,
        userId,
        displayName: displayName || 'Пользователь',
      };
    } catch {
      return null;
    }
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
        candidate.start_payload ?? candidate.startPayload ?? candidate.payload ?? candidate.start;

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

  private collectMessageAttachments(update: MaxUpdate): Record<string, unknown>[] {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return [];
    }

    const messageCandidates = [
      this.asRecord(raw.message),
      this.asRecord(this.asRecord(raw.data)?.message),
      this.asRecord(this.asRecord(raw.event)?.message),
    ].filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));

    const attachments: Record<string, unknown>[] = [];

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

          attachments.push(attachment as Record<string, unknown>);
        }
      }
    }

    return attachments;
  }

  private extractFirstImageSourceAttachment(update: MaxUpdate): ParsedImageSourceAttachment | null {
    const imageAttachment = this.extractFirstImageAttachment(update);
    if (imageAttachment) {
      return {
        kind: 'image',
        attachment: imageAttachment,
      };
    }

    const imageFileAttachment = this.extractFirstImageFileAttachment(update);
    if (!imageFileAttachment) {
      return null;
    }

    return {
      kind: 'file',
      attachment: imageFileAttachment,
    };
  }

  private extractFirstImageAttachment(update: MaxUpdate): ParsedImageAttachment | null {
    for (const row of this.collectMessageAttachments(update)) {
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
        width: this.readOptionalInteger(payload.width ?? payload.w),
        height: this.readOptionalInteger(payload.height ?? payload.h),
        mimeType: this.readLowerString(payload.mime_type ?? payload.mimeType),
        mediaType: this.readLowerString(payload.media_type ?? payload.mediaType),
        payloadKeys: Object.keys(payload).sort(),
      };
    }

    return null;
  }

  private extractFirstFileAttachment(update: MaxUpdate): ParsedFileAttachment | null {
    for (const row of this.collectMessageAttachments(update)) {
      const parsed = this.parseFileAttachment(row);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  private extractFirstImageFileAttachment(update: MaxUpdate): ParsedImageFileAttachment | null {
    for (const row of this.collectMessageAttachments(update)) {
      const parsed = this.parseFileAttachment(row);
      if (!parsed?.url) {
        continue;
      }

      const resolvedMimeType = this.resolveImageMimeType(
        parsed.mimeType,
        parsed.fileName,
        parsed.url,
      );
      if (!resolvedMimeType) {
        continue;
      }

      return {
        url: parsed.url,
        token: parsed.token,
        fileId: parsed.fileId,
        fileName: parsed.fileName,
        size: parsed.size,
        mimeType: resolvedMimeType,
        mediaType: parsed.mediaType,
        payloadKeys: parsed.payloadKeys,
      };
    }

    return null;
  }

  private parseAttachmentUrlMetadata(url: string | null): {
    host: string | null;
    path: string | null;
  } {
    if (!url) {
      return {
        host: null,
        path: null,
      };
    }

    try {
      const parsed = new URL(url);
      return {
        host: parsed.host || null,
        path: parsed.pathname || null,
      };
    } catch {
      return {
        host: null,
        path: null,
      };
    }
  }

  private hasVideoAttachment(update: MaxUpdate): boolean {
    for (const row of this.collectMessageAttachments(update)) {
      const type = this.readLowerString(row.type);
      const payload = this.asRecord(row.payload);
      const mimeType = this.readLowerString(payload?.mime_type ?? payload?.mimeType);

      if (type === 'video' || mimeType?.startsWith('video/')) {
        return true;
      }
    }

    return false;
  }

  private async downloadImageAttachment(
    imageAttachment: ParsedImageAttachment,
    filePrefix = 'private-broadcast',
  ): Promise<DownloadedImageAsset> {
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
        : (imageAttachment.mimeType ?? 'image/jpeg');

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

  private async downloadImageSourceAttachment(
    imageSourceAttachment: ParsedImageSourceAttachment,
    filePrefix = 'private-broadcast',
  ): Promise<DownloadedImageAsset> {
    if (imageSourceAttachment.kind === 'image') {
      return this.downloadImageAttachment(imageSourceAttachment.attachment, filePrefix);
    }

    return this.downloadImageFileAttachment(imageSourceAttachment.attachment, filePrefix);
  }

  private async downloadImageFileAttachment(
    imageFileAttachment: ParsedImageFileAttachment,
    filePrefix = 'private-broadcast',
  ): Promise<DownloadedImageAsset> {
    const timeout = setTimeout(() => {
      controller.abort();
    }, 10_000);
    const controller = new AbortController();

    try {
      const response = await fetch(imageFileAttachment.url, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new BadRequestException(`Не удалось загрузить файл (${response.status}).`);
      }

      const mimeTypeHeader = response.headers.get('content-type') ?? '';
      const mimeType = this.resolveImageMimeType(
        mimeTypeHeader.toLowerCase().startsWith('image/')
          ? mimeTypeHeader.split(';')[0].trim().toLowerCase()
          : imageFileAttachment.mimeType,
        imageFileAttachment.fileName,
        imageFileAttachment.url,
      );
      if (!mimeType) {
        throw new BadRequestException('Файл должен быть изображением.');
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) {
        throw new BadRequestException('Файл оказался пустым.');
      }

      const fileName = this.buildDownloadedFileName(
        filePrefix,
        imageFileAttachment.fileName ?? this.fileNameFromUrl(imageFileAttachment.url),
        imageFileAttachment.fileId,
        mimeType,
      );

      return {
        base64: buffer.toString('base64'),
        mimeType,
        fileName,
      };
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('Не удалось загрузить изображение из файла.');
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

  private parseFileAttachment(row: Record<string, unknown>): ParsedFileAttachment | null {
    const type = this.readLowerString(row.type);
    if (type !== 'file') {
      return null;
    }

    const payload = this.asRecord(row.payload);
    if (!payload) {
      return null;
    }

    return {
      url: this.readString(payload.url) ?? null,
      token: this.readString(payload.token) ?? null,
      fileId: this.readString(payload.file_id ?? payload.fileId) ?? null,
      fileName:
        this.readString(
          payload.file_name ??
            payload.fileName ??
            row.file_name ??
            row.fileName ??
            row.filename ??
            row.name,
        ) ?? null,
      size: this.readOptionalInteger(payload.size ?? row.size),
      mimeType: this.readLowerString(payload.mime_type ?? payload.mimeType ?? row.mime_type),
      mediaType: this.readLowerString(payload.media_type ?? payload.mediaType ?? row.media_type),
      payloadKeys: Object.keys(payload).sort(),
    };
  }

  private resolveImageMimeType(
    mimeType: string | null,
    fileName: string | null,
    url: string | null,
  ): string | null {
    if (mimeType?.startsWith('image/')) {
      return mimeType;
    }

    return (
      this.inferImageMimeTypeFromFileName(fileName) ??
      this.inferImageMimeTypeFromFileName(this.fileNameFromUrl(url))
    );
  }

  private inferImageMimeTypeFromFileName(fileName: string | null): string | null {
    if (!fileName) {
      return null;
    }

    const normalized = fileName.trim().toLowerCase();
    if (normalized.endsWith('.png')) {
      return 'image/png';
    }
    if (normalized.endsWith('.webp')) {
      return 'image/webp';
    }
    if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (normalized.endsWith('.gif')) {
      return 'image/gif';
    }
    if (normalized.endsWith('.heic')) {
      return 'image/heic';
    }

    return null;
  }

  private fileNameFromUrl(url: string | null): string | null {
    if (!url) {
      return null;
    }

    try {
      const parsed = new URL(url);
      const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
      if (!lastSegment) {
        return null;
      }

      const decoded = decodeURIComponent(lastSegment).trim();
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }

  private buildDownloadedFileName(
    filePrefix: string,
    preferredFileName: string | null,
    fallbackId: string | null,
    mimeType: string,
  ): string {
    const normalizedFileName = this.normalizeDownloadedFileName(preferredFileName);
    if (normalizedFileName) {
      return normalizedFileName;
    }

    const extension = this.extensionFromMimeType(mimeType);
    return `${filePrefix}-${fallbackId ?? Date.now()}.${extension}`;
  }

  private normalizeDownloadedFileName(fileName: string | null): string | null {
    if (!fileName) {
      return null;
    }

    const sanitized = fileName
      .trim()
      .replace(/[/\\?%*:|"<>]/gu, '-')
      .replace(/\s+/gu, ' ');

    return sanitized.length > 0 ? sanitized : null;
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

  private async loadSessionForDiagnostics(userId: string): Promise<PrivateSession | null> {
    try {
      return await this.loadSession(userId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load private control session for diagnostics',
      );
      return null;
    }
  }

  private extractBadRequestDetails(error: unknown): string | null {
    if (error instanceof BadRequestException) {
      return this.normalizeBadRequestResponse(error.getResponse());
    }

    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }

    return null;
  }

  private normalizeBadRequestResponse(response: unknown): string | null {
    const messages = this.collectBadRequestMessages(response);
    if (messages.length > 0) {
      return Array.from(new Set(messages)).join('; ');
    }

    if (
      response &&
      typeof response === 'object' &&
      typeof (response as Record<string, unknown>).error === 'string'
    ) {
      const errorLabel = ((response as Record<string, unknown>).error as string).trim();
      if (errorLabel.length > 0) {
        return errorLabel;
      }
    }

    try {
      return JSON.stringify(response);
    } catch {
      return null;
    }
  }

  private collectBadRequestMessages(response: unknown): string[] {
    if (typeof response === 'string') {
      const normalized = response.trim();
      return normalized.length > 0 ? [normalized] : [];
    }

    if (Array.isArray(response)) {
      return response.flatMap((item) => this.collectBadRequestMessages(item));
    }

    if (!response || typeof response !== 'object') {
      return [];
    }

    const row = response as Record<string, unknown>;
    const messages: string[] = [];
    const directMessage = row.message;

    if (typeof directMessage === 'string' && directMessage.trim().length > 0) {
      messages.push(directMessage.trim());
    } else if (Array.isArray(directMessage)) {
      messages.push(...directMessage.flatMap((item) => this.collectBadRequestMessages(item)));
    }

    const zodErrors = row._errors;
    if (Array.isArray(zodErrors)) {
      messages.push(
        ...zodErrors
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean),
      );
    }

    for (const [key, value] of Object.entries(row)) {
      if (key === 'message' || key === 'error' || key === '_errors') {
        continue;
      }
      if (!value || (typeof value !== 'object' && !Array.isArray(value))) {
        continue;
      }
      messages.push(...this.collectBadRequestMessages(value));
    }

    return messages;
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
      lastPrivateChatId: null,
      lastGiveawayHandoffDeliveredChatId: null,
      lastGiveawayHandoffDeliveredAt: null,
      lastProfileMentionHandoffDeliveredChatId: null,
      lastProfileMentionHandoffDeliveredAt: null,
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
      lastPrivateChatId:
        typeof row.lastPrivateChatId === 'string' && row.lastPrivateChatId.trim().length > 0
          ? row.lastPrivateChatId.trim()
          : null,
      lastGiveawayHandoffDeliveredChatId:
        typeof row.lastGiveawayHandoffDeliveredChatId === 'string' &&
        row.lastGiveawayHandoffDeliveredChatId.trim().length > 0
          ? row.lastGiveawayHandoffDeliveredChatId.trim()
          : null,
      lastGiveawayHandoffDeliveredAt:
        typeof row.lastGiveawayHandoffDeliveredAt === 'number' &&
        Number.isFinite(row.lastGiveawayHandoffDeliveredAt)
          ? row.lastGiveawayHandoffDeliveredAt
          : null,
      lastProfileMentionHandoffDeliveredChatId:
        typeof row.lastProfileMentionHandoffDeliveredChatId === 'string' &&
        row.lastProfileMentionHandoffDeliveredChatId.trim().length > 0
          ? row.lastProfileMentionHandoffDeliveredChatId.trim()
          : null,
      lastProfileMentionHandoffDeliveredAt:
        typeof row.lastProfileMentionHandoffDeliveredAt === 'number' &&
        Number.isFinite(row.lastProfileMentionHandoffDeliveredAt)
          ? row.lastProfileMentionHandoffDeliveredAt
          : null,
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

    if (kind === 'channel_suggestion') {
      if (typeof row.chatId !== 'string' || !row.chatId.trim()) {
        return null;
      }
      if (typeof row.token !== 'string' || !row.token.trim()) {
        return null;
      }
      return {
        kind,
        chatId: row.chatId.trim(),
        token: row.token.trim(),
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
      'broadcast_content',
      'broadcast_text',
      'broadcast_button_url',
      'broadcast_button_text',
      'broadcast_send_at',
      'broadcast_cycle_every_hours',
      'broadcast_cycle_count',
      'broadcast_photo',
      'rules_text',
      'rules_photo',
      'channel_suggestion',
      'giveaway_title',
      'giveaway_content',
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
      textFormat: row.textFormat === 'markdown' ? 'markdown' : 'plain',
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
      scheduleMode: row.scheduleMode === 'calendar' ? 'calendar' : 'legacy',
      scheduleTimezone:
        typeof row.scheduleTimezone === 'string' && row.scheduleTimezone.trim().length > 0
          ? row.scheduleTimezone.trim()
          : DEFAULT_BROADCAST_DRAFT.scheduleTimezone,
      scheduledSlots: Array.isArray(row.scheduledSlots)
        ? Array.from(
            new Set(
              row.scheduledSlots
                .filter(
                  (item): item is string => typeof item === 'string' && item.trim().length > 0,
                )
                .map((item) => item.trim()),
            ),
          ).sort((left, right) => left.localeCompare(right))
        : [],
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
      value === 'rules' ||
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

  private parseUiMode(_value: unknown): PrivateUiMode {
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

  private markdownTitle(title: string): string {
    return `**${this.escapeMarkdown(title)}**`;
  }

  private escapeMarkdown(value: string): string {
    return value.replace(/([\\_*[\]()`])/g, '\\$1');
  }

  private formatIsoDate(iso: string, timeZone?: string | null): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }

    const formatterOptions: Intl.DateTimeFormatOptions = {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(timeZone?.trim() ? { timeZone: timeZone.trim() } : {}),
    };

    try {
      return new Intl.DateTimeFormat('ru-RU', formatterOptions).format(date);
    } catch {
      return new Intl.DateTimeFormat('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
    }
  }

  private formatDateTimeLabel(iso: string | null, timeZone?: string | null): string {
    if (!iso) {
      return 'не задано';
    }

    return this.formatIsoDate(iso, timeZone);
  }

  private formatBroadcastCalendarSummary(slots: string[], timeZone?: string | null): string {
    if (slots.length === 0) {
      return 'не настроен';
    }

    const preview = slots
      .slice(0, 3)
      .map((slot) => this.formatIsoDate(slot, timeZone))
      .join(' • ');
    const extraCount = slots.length - 3;
    return extraCount > 0 ? `${preview} • +${extraCount}` : preview;
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

  private readOptionalInteger(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return null;
  }
}
