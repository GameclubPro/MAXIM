import { DEFAULT_BROADCAST_BUTTON_TEXT, type ChatSettings } from '@maxim/contracts';
import type { PrivateBroadcastDraft } from './private-control.types';

export const CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES = [400, 404] as const;
export const PRIVATE_DIALOG_TERMINAL_FAILURE_METRIC_STATUSES = [403, 404] as const;
export const LAUNCHER_INTRO_MARKER_TTL_SEC = 365 * 24 * 60 * 60;
export const DEFAULT_PRIVATE_CALLBACK_INLINE_BUDGET_MS = 2_500;
export const DEFAULT_PRIVATE_CALLBACK_ACK_TIMEOUT_MS = 800;
export const DEFAULT_PRIVATE_CALLBACK_EDIT_TIMEOUT_MS = 1_500;
export const DEFAULT_PRIVATE_DIALOG_SEND_TIMEOUT_MS = 2_500;
export const DEFERRED_PRIVATE_CALLBACK_NOTIFICATION = 'Обрабатываю команду...';

export const SESSION_TTL_SEC = 45 * 60;
export const SESSION_KEY_PREFIX = 'private-ui:v2';
export const BROADCAST_COMPOSER_CLIENT_RESET_KEY_PREFIX = 'miniapp:broadcast-composer-reset:v1';
export const BROADCAST_COMPOSER_CLIENT_RESET_TTL_SEC = 7 * 24 * 60 * 60;
export const BROADCAST_HANDOFF_DEDUP_WINDOW_MS = 20_000;
export const GIVEAWAY_HANDOFF_DEDUP_WINDOW_MS = 20_000;
export const RULES_HANDOFF_DEDUP_WINDOW_MS = 20_000;
export const PROFILE_MENTION_HANDOFF_DEDUP_WINDOW_MS = 20_000;
export const BROADCAST_PUBLISH_DEDUP_WINDOW_MS = 15_000;
export const BROADCAST_HANDOFF_START_PAYLOAD = 'broadcast_handoff';
export const RULES_HANDOFF_START_PAYLOAD = 'rules_handoff';
export const GIVEAWAY_HANDOFF_START_PAYLOAD = 'giveaway_handoff';
export const GIVEAWAY_HANDOFF_START_PREFIX = 'ggh-';
export const PROFILE_MENTION_START_PREFIX = 'pmh-';
export const KARAVAN_ALLOWLIST_START_PREFIX = 'ka2-';
export const KARAVAN_ALLOWLIST_CALLBACK_ACTION = 'karavan_allowlist_duration';
export const KARAVAN_ALLOWLIST_CANCEL_CALLBACK_ACTION = 'karavan_allowlist_cancel';
export const KARAVAN_ALLOWLIST_FLOW_TTL_MS = 10 * 60_000;
export const PAGE_SIZE_DOMAINS = 8;
export const PAGE_SIZE_EVENTS = 10;
export const PAGE_SIZE_MANUAL_USERS = 8;
export const SEARCH_RESULT_LIMIT = 8;
export const BUTTON_TEXT_MAX_SINGLE_COLUMN = 36;
export const BUTTON_TEXT_MAX_TWO_COLUMNS = 14;
export const FORWARDED_MUTE_DURATION_HOURS_DEFAULT = 6;
export const FORWARDED_MUTE_DURATION_HOURS_MAX = 336;
export const PERMANENT_MUTE_COMMAND_DURATION_HOURS = 88;
export const SUPPORT_CHAT_URL = 'https://max.ru/join/qX7U_Hj-L-xMJG8V7wlF6dD-6a6cXIzTBGRtU2mRMzk';
export const DUPLICATE_ALLOWED_COUNT_MIN = 0;
export const DUPLICATE_ALLOWED_COUNT_MAX = 16;
export const DUPLICATE_THRESHOLD_MAX = 20;
export const DUPLICATE_FLOW_SETTING_KEYS = [
  'duplicateBotMessageEnabled',
  'duplicateWarnEnabled',
  'duplicateMuteEnabled',
  'duplicateBanEnabled',
  'duplicateWarnWindowSec',
  'duplicateWarnMaxCount',
  'duplicateMuteWindowSec',
  'duplicateMuteMaxCount',
  'duplicateBanWindowSec',
  'duplicateBanMaxCount',
] as const satisfies readonly (keyof ChatSettings)[];
export const MINIAPP_ROUTE_START_PARAM_PREFIX = 'mr-';
export const MAX_CALLBACK_PREFIX = 'pc2';
export const LEGACY_CALLBACK_PREFIX = 'pc';
export const CALLBACK_REFRESH_NOTIFICATION = 'Меню обновлено';
export const CALLBACK_STALE_NOTIFICATION = 'Кнопки устарели, обновляю экран';
export const MAX_FORWARDED_COMMAND_SCAN_DEPTH = 8;
export const MINIAPP_SETTINGS_ONLY_CALLBACK_ACTIONS = new Set<string>([
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
]);
export const MINIAPP_ACTIVITY_ONLY_CALLBACK_ACTIONS = new Set<string>([
  'open_events',
  'events_page',
  'open_logs',
  'logs_range',
  'open_manual_users',
  'manual_users_page',
  'manual_select_user',
  'manual_action',
]);
export const MINIAPP_CHANNEL_SETTINGS_CALLBACK_ACTIONS = new Set<string>([
  'open_channel_section',
  'toggle_channel',
  'set_channel_input',
  'publish_channel_engagement',
]);
export const MINIAPP_GIVEAWAY_ONLY_CALLBACK_ACTIONS = new Set<string>([
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
]);
export const MINIAPP_RULES_ONLY_CALLBACK_ACTIONS = new Set<string>(['rules_toggle_attach']);
export const MINIAPP_BROADCAST_SETTINGS_CALLBACK_ACTIONS = new Set<string>([
  'broadcast_view',
  'broadcast_toggle',
  'broadcast_clear_timer',
]);
export const CHAT_ONLY_CALLBACK_ACTIONS = new Set<string>([
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
  'rules_autofill',
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
export const CHANNEL_ONLY_CALLBACK_ACTIONS = new Set<string>([
  'open_channel_section',
  'toggle_channel',
  'set_channel_input',
  'publish_channel_engagement',
]);
export const ENTITY_CALLBACK_ACTIONS = new Set<string>([
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
  'broadcast_clear_content',
  'broadcast_clear_timer',
  'broadcast_clear_photo',
  'broadcast_send',
]);

export const DEFAULT_BROADCAST_DRAFT: PrivateBroadcastDraft = {
  text: '',
  textFormat: 'plain',
  targetMode: 'current',
  targetChatIds: [],
  applyToAllChats: false,
  buttons: [],
  buttonEnabled: false,
  buttonUrl: '',
  buttonText: DEFAULT_BROADCAST_BUTTON_TEXT,
  imageEnabled: false,
  imageBase64: '',
  imageMimeType: '',
  imageFileName: '',
  mediaType: null,
  mediaPayload: null,
  mediaMimeType: '',
  mediaFileName: '',
  scheduleMode: 'legacy',
  scheduleTimezone: 'Europe/Moscow',
  scheduledSlots: [],
  sendAt: null,
  cycleEnabled: false,
  cycleEveryHours: 24,
  cycleCount: 1,
};
