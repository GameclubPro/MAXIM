import {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  BOT_SPEECH_STYLE_METADATA,
  BOT_SPEECH_STYLE_OPTIONS,
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  applyBotSpeechStylePreset,
  chatRulesSchema,
  chatSettingsSchema,
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  hasBotSpeechEditableOverrides,
  normalizeAllowlistLink,
  type BotSpeechEditableFieldKey,
  type BotSpeechStyle,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type DomainAllowlistEntry,
  type ManagedBroadcastDetails,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import botSpeechRobotImage from '../../../../bot.webp';
import botSpeechFriendlyImage from '../../../../frendly.webp';
import botSpeechIronicImage from '../../../../joker.webp';
import botSpeechPoliceImage from '../../../../police.webp';
import {
  BroadcastSchedulePlanner,
  type BroadcastSchedulePlannerSelectionState,
} from '../components/broadcast-schedule-planner';
import { MaxMarkdownEditor } from '../components/max-markdown-editor';
import { ManagedGiveawayCard } from '../components/managed-giveaway-card';
import { ManagedPollCard } from '../components/managed-poll-card';
import { CompactStickyHeader } from '../components/ui/compact-sticky-header';
import { GlassCard } from '../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../components/ui/settings-section-toggle';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  addDomain,
  applySettingsSectionToAll,
  cancelManagedBroadcast,
  getDomainAllowlistDetails,
  getBroadcastHandoffState,
  getManagedBroadcast,
  getRules,
  getSettingsScreen,
  handoffBroadcast,
  publishRules,
  removeDomain,
  resetPublishedRules,
  retryManagedBroadcast,
  scheduleDomainRemoval,
  updateManagedBroadcast,
  updateRules,
  updateSettings,
} from '../lib/api/chat-settings-client';
import { getChannels, getChats, getMe } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import type {
  BroadcastHandoffPayload,
  SendBroadcastPayload,
  UpdateChatRulesPayload,
} from '../lib/api/shared-types';
import {
  countBroadcastScheduleDays,
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
} from '../lib/broadcast-schedule';
import { cn } from '../lib/cn';
import { maxNotify, openMaxBotLink, setMaxClosingConfirmation } from '../lib/max-bridge';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';

type FieldErrors = Partial<Record<keyof ChatSettings, string>>;

const AUTO_SAVE_DELAY_MS = 650;
const BAN_DURATION_MIN_HOURS = 1;
const BAN_DURATION_MAX_HOURS = 36;
const DUPLICATE_COUNT_MIN = 2;
const DUPLICATE_COUNT_MAX = 20;
const MESSAGE_COUNT_LIMIT_MIN = 1;
const MESSAGE_COUNT_LIMIT_MAX = 10;
const MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS = 1;
const MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS = 24;
const MESSAGE_LENGTH_MIN = 50;
const MESSAGE_LENGTH_MAX = 1500;
const MESSAGE_LENGTH_STEP = 10;
const PHOTO_COOLDOWN_MIN_HOURS = 1;
const PHOTO_COOLDOWN_MAX_HOURS = 24;
const STICKER_COOLDOWN_MIN_MINUTES = 1;
const STICKER_COOLDOWN_MAX_MINUTES = 60;
const NIGHT_FORCE_CLOSE_MIN_HOURS = 0;
const NIGHT_FORCE_CLOSE_MAX_HOURS = 23;
const NIGHT_FORCE_CLOSE_MIN_DAYS = 0;
const NIGHT_FORCE_CLOSE_MAX_DAYS = 30;
const COMMERCIAL_SENSITIVITY_MIN = 0;
const COMMERCIAL_SENSITIVITY_MAX = 100;
const COMMERCIAL_BALANCED_MAX = 69;
const BOT_MESSAGES_DELETE_DELAY_MIN = 1;
const BOT_MESSAGES_DELETE_DELAY_MAX = 60;
const DOMAIN_REMOVAL_MIN_FUTURE_MS = 30_000;
const MAX_BROADCAST_TEXT_LENGTH = 1_000;
const MAX_BROADCAST_SCHEDULE_DAYS = 14;
const MIN_BROADCAST_CYCLE_HOURS = 1;
const MAX_BROADCAST_CYCLE_HOURS = 14 * 24;
const MAX_BROADCAST_CYCLE_COUNT = 100;
const THEMATIC_FILTERS_OWNER_USER_ID = '98315271';
const MAX_RULES_IMAGE_SIZE_BYTES = 1_000_000;
const MAX_CHAT_RULES_TEXT_LENGTH = 2_000;
const BROADCAST_HOUR_MS = 60 * 60 * 1_000;
const BROADCAST_DAY_MS = 24 * 60 * 60 * 1_000;

type MaxMessageLengthSliderProps = {
  value: ChatSettings['maxMessageLength'];
  min: number;
  max: number;
  step: number;
  onCommit: (value: ChatSettings['maxMessageLength']) => void;
};

function MaxMessageLengthSlider({ value, min, max, step, onCommit }: MaxMessageLengthSliderProps) {
  const [localValue, setLocalValue] = useState(value);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (!isDraggingRef.current) {
      setLocalValue(value);
    }
  }, [value]);

  function normalizeValue(rawValue: string): ChatSettings['maxMessageLength'] {
    const parsedValue = Number(rawValue);
    const safeValue = Number.isFinite(parsedValue) ? parsedValue : value;
    return Math.min(max, Math.max(min, safeValue)) as ChatSettings['maxMessageLength'];
  }

  function commitValue(nextValue: ChatSettings['maxMessageLength']) {
    isDraggingRef.current = false;
    setIsDragging(false);
    setLocalValue(nextValue);
    if (nextValue !== value) {
      onCommit(nextValue);
    }
  }

  return (
    <>
      <div className="settings-native-toggle__row">
        <span className="settings-native-toggle__title settings-native-toggle__title--sub">
          Максимум
        </span>
        <output className="settings-length-limit__value" aria-live="polite">
          {localValue} симв.
        </output>
      </div>

      <input
        className="settings-length-limit__slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={localValue}
        onPointerDown={() => {
          isDraggingRef.current = true;
          setIsDragging(true);
        }}
        onChange={(event) => {
          const nextValue = normalizeValue(event.target.value);
          setLocalValue(nextValue);
          if (!isDraggingRef.current) {
            onCommit(nextValue);
          }
        }}
        onPointerUp={(event) => {
          commitValue(normalizeValue(event.currentTarget.value));
        }}
        onPointerCancel={(event) => {
          commitValue(normalizeValue(event.currentTarget.value));
        }}
        onBlur={(event) => {
          if (!isDragging && !isDraggingRef.current) {
            commitValue(normalizeValue(event.currentTarget.value));
          }
        }}
        aria-label="Лимит длины сообщения"
      />

      <div className="settings-length-limit__labels" aria-hidden>
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </>
  );
}

type DuplicateEnabledKey = 'duplicateWarnEnabled' | 'duplicateKickEnabled' | 'duplicateBanEnabled';
type DuplicateWindowKey =
  | 'duplicateWarnWindowSec'
  | 'duplicateKickWindowSec'
  | 'duplicateBanWindowSec';
type DuplicateMaxCountKey =
  | 'duplicateWarnMaxCount'
  | 'duplicateKickMaxCount'
  | 'duplicateBanMaxCount';
type HintKey =
  | 'antiSpam'
  | 'deleteSpammers'
  | 'linkBotMessage'
  | 'linkWarnMessage'
  | 'linkBotButton'
  | 'greetingEnabled'
  | 'greetingBotMessage'
  | 'greetingBotButton'
  | 'textFiltersProfanity'
  | 'textFiltersCommercial'
  | 'commercialSensitivity'
  | 'textFiltersBotMessage'
  | 'textFiltersWarnMessage'
  | 'textFiltersBotButton'
  | 'duplicateBotMessage'
  | 'duplicateBotButton'
  | 'banDuration'
  | 'maxMessageLength'
  | 'messageCountLimit'
  | 'photoCooldown'
  | 'stickerCooldown'
  | 'messageLimitsBotMessage'
  | 'messageLimitsBotButton'
  | 'nightModeEnabled'
  | 'nightForceClose'
  | 'nightBotMessage'
  | 'nightOpenMessage'
  | 'nightBotButton'
  | 'requiredSubscriptionEnabled'
  | 'requiredSubscriptionChannels'
  | 'requiredSubscriptionBotMessage'
  | 'deleteBotMessages'
  | 'removeBotsFromGroup'
  | 'mailingText'
  | 'mailingTargets'
  | 'mailingImage'
  | 'mailingButton'
  | 'mailingSchedule'
  | 'mailingCycle';
type BotMessageEditorKey =
  | 'link'
  | 'greeting'
  | 'requiredSubscription'
  | 'textFilters'
  | 'duplicate'
  | 'messageLimits'
  | 'night'
  | 'nightOpen';
type WarnMessageEditorKey = 'linkWarn' | 'textFiltersWarn';
type SettingsSectionKey =
  | 'links'
  | 'rules'
  | 'poll'
  | 'giveaway'
  | 'greeting'
  | 'profanityFilter'
  | 'commercialFilter'
  | 'thematicFilters'
  | 'duplicates'
  | 'limits'
  | 'night'
  | 'requiredSubscription'
  | 'mailing'
  | 'extra';
type ApplySectionKey = Exclude<SettingsSectionKey, 'mailing' | 'rules' | 'poll' | 'giveaway'>;

const INITIAL_EXPANDED_SECTIONS: Record<SettingsSectionKey, boolean> = {
  links: false,
  rules: false,
  poll: false,
  giveaway: false,
  greeting: false,
  profanityFilter: false,
  commercialFilter: false,
  thematicFilters: false,
  duplicates: false,
  limits: false,
  night: false,
  requiredSubscription: false,
  mailing: false,
  extra: false,
};

const SECTION_LABELS: Record<ApplySectionKey, string> = {
  links: 'Ссылки',
  greeting: 'Приветствие',
  profanityFilter: 'Мат и грубость',
  commercialFilter: 'Коммерция',
  thematicFilters: 'Объявления по теме',
  duplicates: 'Повторы',
  limits: 'Ограничения',
  night: 'Ночной режим',
  requiredSubscription: 'Обязательная подписка',
  extra: 'Сервисные',
};

const SECTION_SETTING_KEYS: Record<ApplySectionKey, readonly (keyof ChatSettings)[]> = {
  links: [
    'linkPolicy',
    'linkBotMessageEnabled',
    'linkBotMessageText',
    'linkWarnEnabled',
    'linkWarnMessageText',
    'linkBanEnabled',
    'linkKickEnabled',
    'linkBotButtonEnabled',
    'linkBotButtonUrl',
    'linkBotButtonText',
  ],
  greeting: [
    'greetingEnabled',
    'greetingBotMessageEnabled',
    'greetingBotMessageText',
    'greetingBotButtonEnabled',
    'greetingBotButtonUrl',
    'greetingBotButtonText',
  ],
  profanityFilter: [
    'russianProfanityFilterEnabled',
    'profanityBotMessageEnabled',
    'profanityWarnEnabled',
    'profanityBanEnabled',
    'profanityKickEnabled',
  ],
  commercialFilter: [
    'commercialAdsFilterEnabled',
    'commercialAdsSensitivity',
    'commercialAdsWarnThreshold',
    'commercialAdsDeleteThreshold',
    'textFiltersBotMessageEnabled',
    'textFiltersBotMessageText',
    'textFiltersWarnEnabled',
    'textFiltersWarnMessageText',
    'textFiltersBanEnabled',
    'textFiltersKickEnabled',
    'textFiltersBotButtonEnabled',
    'textFiltersBotButtonUrl',
    'textFiltersBotButtonText',
  ],
  thematicFilters: [
    'thematicCodewordEnabled',
    'thematicCodeword',
    'thematicFiltersBotMessageEnabled',
    'thematicFiltersWarnEnabled',
    'thematicFiltersBanEnabled',
    'thematicFiltersKickEnabled',
    'thematicFiltersBotButtonEnabled',
    'thematicFiltersBotButtonUrl',
    'thematicFiltersBotButtonText',
  ],
  duplicates: [
    'antiDuplicateEnabled',
    'duplicateWarnEnabled',
    'duplicateKickEnabled',
    'duplicateBanEnabled',
    'duplicateWarnWindowSec',
    'duplicateWarnMaxCount',
    'duplicateKickWindowSec',
    'duplicateKickMaxCount',
    'duplicateBanWindowSec',
    'duplicateBanMaxCount',
    'duplicateBotMessageEnabled',
    'duplicateBotMessageText',
    'duplicateBotButtonEnabled',
    'duplicateBotButtonUrl',
    'duplicateBotButtonText',
    'banDurationHours',
  ],
  limits: [
    'antiSpamEnabled',
    'messageCountLimitEnabled',
    'messageCountLimitMessages',
    'messageCountLimitWindowHours',
    'maxMessageLengthEnabled',
    'maxMessageLength',
    'photoMessageCooldownEnabled',
    'photoMessageCooldownHours',
    'stickerMessageCooldownEnabled',
    'stickerMessageCooldownMinutes',
    'videoMessagesEnabled',
    'fileMessagesEnabled',
    'voiceMessagesEnabled',
    'messageLimitsBotMessageEnabled',
    'messageLimitsBotMessageText',
    'messageLimitsWarnEnabled',
    'messageLimitsBanEnabled',
    'messageLimitsKickEnabled',
    'messageLimitsBotButtonEnabled',
    'messageLimitsBotButtonUrl',
    'messageLimitsBotButtonText',
    'banDurationHours',
  ],
  night: [
    'nightModeEnabled',
    'nightModeStartTimeMinutes',
    'nightModeEndTimeMinutes',
    'nightModeTimezone',
    'nightModeBotMessageEnabled',
    'nightModeBotMessageText',
    'nightModeOpenMessageEnabled',
    'nightModeOpenMessageText',
    'nightModeBotButtonEnabled',
    'nightModeBotButtonUrl',
    'nightModeBotButtonText',
    'nightModeForceCloseEnabled',
    'nightModeForceCloseForever',
    'nightModeForceCloseHours',
    'nightModeForceCloseDays',
    'nightModeForceCloseUntil',
  ],
  requiredSubscription: [
    'requiredSubscriptionEnabled',
    'requiredSubscriptionChannelIds',
    'requiredSubscriptionBotMessageText',
  ],
  extra: [
    'deleteSpammersEnabled',
    'deleteBotMessagesEnabled',
    'deleteBotMessagesDelayMinutes',
    'removeBotsFromGroupEnabled',
  ],
};

const DUPLICATE_STAGE_OPTIONS: Array<{
  id: 'WARN' | 'KICK' | 'BAN';
  label: string;
  enabledKey: DuplicateEnabledKey;
  windowKey: DuplicateWindowKey;
  maxCountKey: DuplicateMaxCountKey;
}> = [
  {
    id: 'WARN',
    label: 'Предупреждение',
    enabledKey: 'duplicateWarnEnabled',
    windowKey: 'duplicateWarnWindowSec',
    maxCountKey: 'duplicateWarnMaxCount',
  },
  {
    id: 'BAN',
    label: 'Бан',
    enabledKey: 'duplicateBanEnabled',
    windowKey: 'duplicateBanWindowSec',
    maxCountKey: 'duplicateBanMaxCount',
  },
  {
    id: 'KICK',
    label: 'Удаление участника',
    enabledKey: 'duplicateKickEnabled',
    windowKey: 'duplicateKickWindowSec',
    maxCountKey: 'duplicateKickMaxCount',
  },
];

const LINK_POLICY_OPTIONS: Array<{
  value: ChatSettings['linkPolicy'];
  label: string;
  description: string;
}> = [
  {
    value: 'ALERT_ONLY',
    label: 'Не удалять ссылки',
    description: 'Ссылки остаются в чате, блок санкций скрыт.',
  },
  {
    value: 'ALLOWLIST_ONLY',
    label: 'Удалять кроме...',
    description: 'Разрешите нужные ссылки в нижней панели.',
  },
  {
    value: 'BLOCKLIST_ONLY',
    label: 'Удалять все ссылки',
    description: 'Любая ссылка удаляется сразу.',
  },
];

const RUSSIAN_TIMEZONE_OPTIONS = [
  { value: 'Europe/Kaliningrad', label: 'Калининград (UTC+2)' },
  { value: 'Europe/Moscow', label: 'Москва (UTC+3)' },
  { value: 'Europe/Samara', label: 'Самара (UTC+4)' },
  { value: 'Asia/Yekaterinburg', label: 'Екатеринбург (UTC+5)' },
  { value: 'Asia/Omsk', label: 'Омск (UTC+6)' },
  { value: 'Asia/Krasnoyarsk', label: 'Красноярск (UTC+7)' },
  { value: 'Asia/Irkutsk', label: 'Иркутск (UTC+8)' },
  { value: 'Asia/Yakutsk', label: 'Якутск (UTC+9)' },
  { value: 'Asia/Vladivostok', label: 'Владивосток (UTC+10)' },
  { value: 'Asia/Magadan', label: 'Магадан (UTC+11)' },
  { value: 'Asia/Kamchatka', label: 'Камчатка (UTC+12)' },
] as const;

const BOT_MESSAGE_EDITOR_FIELD_KEYS: Record<BotMessageEditorKey, BotSpeechEditableFieldKey> = {
  link: 'linkBotMessageText',
  greeting: 'greetingBotMessageText',
  requiredSubscription: 'requiredSubscriptionBotMessageText',
  textFilters: 'textFiltersBotMessageText',
  duplicate: 'duplicateBotMessageText',
  messageLimits: 'messageLimitsBotMessageText',
  night: 'nightModeBotMessageText',
  nightOpen: 'nightModeOpenMessageText',
};

const WARN_MESSAGE_EDITOR_FIELD_KEYS: Record<WarnMessageEditorKey, BotSpeechEditableFieldKey> = {
  linkWarn: 'linkWarnMessageText',
  textFiltersWarn: 'textFiltersWarnMessageText',
};

const BOT_SPEECH_SYNC_SETTING_KEYS = [
  'botSpeechStyle',
  ...BOT_SPEECH_EDITABLE_FIELD_KEYS,
] as const satisfies ReadonlyArray<keyof ChatSettings>;

const BOT_SPEECH_STYLE_ICON_ASSETS = {
  robot: botSpeechRobotImage,
  friendly: botSpeechFriendlyImage,
  police: botSpeechPoliceImage,
  ironic: botSpeechIronicImage,
} as const;

const BOT_SPEECH_STYLE_SELECTOR_LABELS: Record<BotSpeechStyle, string> = {
  ROBOT: 'Робот',
  FRIENDLY: 'Друг',
  POLICE: 'Коп',
  IRONIC: 'Шут',
};

const BOT_MESSAGE_TEMPLATE_HINTS: Record<BotMessageEditorKey, string> = {
  link: 'Плейсхолдеры: {user}, {message_status}, {reason}. Поддерживается Markdown MAX.',
  greeting: 'Плейсхолдеры: {user}, {greeting}. Поддерживается Markdown MAX.',
  requiredSubscription:
    'Плейсхолдеры: {user}, {channels}, {message_status}. Поддерживается Markdown MAX.',
  textFilters: 'Плейсхолдеры: {user}, {message_status}, {reason}. Поддерживается Markdown MAX.',
  duplicate:
    'Плейсхолдеры: {user}, {duplicate_context}, {sanction}, {ban_duration}. Поддерживается Markdown MAX.',
  messageLimits:
    'Плейсхолдеры: {user}, {message_status}, {reason}, {actual_length}, {max_length}, {photo_cooldown_hours}, {message_limit_count}, {message_limit_window_hours}. Поддерживается Markdown MAX.',
  night:
    'Плейсхолдеры: {user}, {night_window}, {night_timezone}, {night_status}. Поддерживается Markdown MAX.',
  nightOpen:
    'Плейсхолдеры: {night_window}, {night_timezone}, {opening_status}. Поддерживается Markdown MAX.',
};

const WARN_MESSAGE_TEMPLATE_HINTS: Record<WarnMessageEditorKey, string> = {
  linkWarn: 'Плейсхолдеры: {user}, {warning}, {reason}. Поддерживается Markdown MAX.',
  textFiltersWarn: 'Плейсхолдеры: {user}, {warning}, {reason}. Поддерживается Markdown MAX.',
};

const AUTO_RULES_FALLBACK_TEXT =
  'Пожалуйста, уважайте участников чата и соблюдайте порядок в обсуждении.';

function serializeRulesDraftPayload(
  value:
    | Pick<ChatRules, 'text' | 'imageBase64' | 'imageMimeType' | 'imageFileName'>
    | Pick<UpdateChatRulesPayload, 'text' | 'imageBase64' | 'imageMimeType' | 'imageFileName'>,
): string {
  return JSON.stringify({
    text: value.text,
    imageBase64: value.imageBase64,
    imageMimeType: value.imageMimeType,
    imageFileName: value.imageFileName,
  });
}

function buildAutoRulesText(settings: ChatSettings): string {
  const lines: string[] = [];

  if (settings.linkPolicy !== 'ALERT_ONLY') {
    lines.push('В этом чате ссылки запрещены.');
  }

  if (settings.russianProfanityFilterEnabled) {
    lines.push('Пожалуйста, без мата и оскорблений.');
  }

  if (settings.commercialAdsFilterEnabled) {
    lines.push('Реклама и коммерческие объявления запрещены.');
  }

  const codeword = settings.thematicCodeword.trim();
  if (settings.thematicCodewordEnabled && codeword) {
    lines.push(`Объявления начинайте с кодового слова «${codeword}».`);
  }

  if (settings.antiDuplicateEnabled) {
    const duplicateWarnHours = Math.max(1, Math.round(settings.duplicateWarnWindowSec / 3_600));
    const duplicateIntervalLabel =
      duplicateWarnHours >= 24 ? 'в сутки' : `в ${duplicateWarnHours} ч.`;
    lines.push(`Не отправляйте повторные сообщения чаще 1 раза ${duplicateIntervalLabel}.`);
  }

  if (settings.maxMessageLengthEnabled) {
    lines.push(`Сообщения должны быть не длиннее ${settings.maxMessageLength} символов.`);
  }

  if (settings.photoMessageCooldownEnabled) {
    lines.push(
      `Фото отправляйте одним сообщением. Если фото несколько — выберите все сразу и отправьте один раз (не чаще 1 раза в ${settings.photoMessageCooldownHours} ч.).`,
    );
  }

  if (!settings.videoMessagesEnabled) {
    lines.push('Видео в этом чате отключены.');
  }

  if (!settings.fileMessagesEnabled) {
    lines.push('Файлы в этом чате отключены.');
  }

  if (!settings.voiceMessagesEnabled) {
    lines.push('Голосовые сообщения в этом чате отключены.');
  }

  if (lines.length === 0) {
    return AUTO_RULES_FALLBACK_TEXT;
  }

  return ['Пожалуйста, соблюдайте правила чата:', ...lines.map((line) => `• ${line}`)].join('\n');
}

function getSpeechTemplateFallback(
  style: ChatSettings['botSpeechStyle'],
  fieldKey: BotSpeechEditableFieldKey,
): string {
  return getBotSpeechEditableTemplate(style, fieldKey);
}

function getSpeechSystemTemplateFallback(
  style: ChatSettings['botSpeechStyle'],
  templateKey: Parameters<typeof getBotSpeechSystemTemplate>[1],
): string {
  return getBotSpeechSystemTemplate(style, templateKey);
}

function resolveBotMessageTemplate(customValue: string, fallbackTemplate: string): string {
  return customValue.trim().length > 0 ? customValue : fallbackTemplate;
}

function renderBotMessageTemplatePreview(
  templateText: string,
  replacements: Record<string, string>,
): string {
  let rendered = templateText;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.split(`{${key}}`).join(value);
  }

  return rendered.trim();
}

function mergeBotSpeechStyleSettings(target: ChatSettings, source: ChatSettings): ChatSettings {
  const nextSettings: ChatSettings = {
    ...target,
  };

  for (const key of BOT_SPEECH_SYNC_SETTING_KEYS) {
    nextSettings[key] = source[key] as never;
  }

  return nextSettings;
}

function buildSpeechStylePreviewSamples(style: BotSpeechStyle): {
  greeting: string;
  explanation: string;
  warning: string;
  ban: string;
  kick: string;
} {
  return {
    greeting: renderBotMessageTemplatePreview(
      getSpeechTemplateFallback(style, 'greetingBotMessageText'),
      {
        user: 'Алексей',
        greeting: 'добро пожаловать в чат',
      },
    ),
    explanation: renderBotMessageTemplatePreview(
      getSpeechTemplateFallback(style, 'linkBotMessageText'),
      {
        user: 'Алексей',
        message_status: 'снято с линии',
        reason: 'в этом чате ссылки не проходят, без ссылок',
      },
    ),
    warning: renderBotMessageTemplatePreview(
      getSpeechTemplateFallback(style, 'textFiltersWarnMessageText'),
      {
        user: 'Алексей',
        warning: 'вынесено предупреждение за грубую лексику',
        reason: 'грубая лексика запрещена правилами чата',
      },
    ),
    ban: renderBotMessageTemplatePreview(getSpeechSystemTemplateFallback(style, 'banNotice'), {
      user: 'Алексей',
      ban_duration: '24 часа',
    }),
    kick: renderBotMessageTemplatePreview(getSpeechSystemTemplateFallback(style, 'linkKick'), {
      user: 'Алексей',
    }),
  };
}

function formatApiError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : '';
  const normalized = rawMessage.toLowerCase();
  const trimmedMessage = rawMessage.trim();

  const statusMatch = rawMessage.match(/api request failed:\s*(\d+)/i);
  const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : null;

  if (statusCode === 413) {
    return 'Файл слишком большой для сервера. Уменьшите фото.';
  }

  const payloadMessageMatch = rawMessage.match(/"message":"([^"]+)"/i);
  if (payloadMessageMatch?.[1]) {
    return payloadMessageMatch[1];
  }

  if (
    normalized.includes('internal server error') ||
    normalized.includes('statuscode":500') ||
    normalized.includes('api request failed: 500')
  ) {
    return 'Ошибка сервера. Повторите позже.';
  }

  if (
    normalized.includes('failed to fetch') ||
    normalized.includes('load failed') ||
    normalized.includes('networkerror') ||
    normalized.includes('network error')
  ) {
    return 'Нет соединения с сервером.';
  }

  if (
    normalized.includes('aborterror') ||
    normalized.includes('aborted') ||
    normalized.includes('signal is aborted') ||
    normalized.includes('cancelled')
  ) {
    return 'Запрос был прерван. Повторите попытку.';
  }

  if (trimmedMessage && !normalized.startsWith('api request failed:')) {
    return trimmedMessage;
  }

  return trimmedMessage ? 'Не удалось выполнить запрос.' : 'Неизвестная ошибка.';
}

function isValidHttpUrl(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const payload = result.includes(',') ? result.split(',')[1] : '';
      if (!payload) {
        reject(new Error('Не удалось прочитать файл.'));
        return;
      }
      resolve(payload);
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

function buildBroadcastScheduleIso(days: number, time: string): string | null {
  if (!Number.isInteger(days) || days < 0 || days > MAX_BROADCAST_SCHEDULE_DAYS) {
    return null;
  }

  const [hoursRaw, minutesRaw] = time.split(':');
  const hours = Number.parseInt(hoursRaw ?? '', 10);
  const minutes = Number.parseInt(minutesRaw ?? '', 10);
  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  const scheduledAt = new Date();
  scheduledAt.setDate(scheduledAt.getDate() + days);
  scheduledAt.setHours(hours, minutes, 0, 0);
  return scheduledAt.toISOString();
}

function decomposeBroadcastScheduleIso(value: string | null): { days: number; time: string } {
  const fallback = new Date(Date.now() + BROADCAST_HOUR_MS);
  if (!value) {
    return {
      days: 0,
      time: toLocalTimeInputValue(fallback),
    };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return {
      days: 0,
      time: toLocalTimeInputValue(fallback),
    };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDay = new Date(parsed);
  targetDay.setHours(0, 0, 0, 0);
  const days = Math.max(
    0,
    Math.min(
      MAX_BROADCAST_SCHEDULE_DAYS,
      Math.round((targetDay.getTime() - today.getTime()) / BROADCAST_DAY_MS),
    ),
  );

  return {
    days,
    time: toLocalTimeInputValue(parsed),
  };
}

function clampBroadcastCycleHours(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_BROADCAST_CYCLE_HOURS;
  }

  return Math.max(
    MIN_BROADCAST_CYCLE_HOURS,
    Math.min(MAX_BROADCAST_CYCLE_HOURS, Math.round(value)),
  );
}

function normalizeDayMinutes(value: number, fallback = 0): number {
  if (!Number.isInteger(value) || value < 0 || value > 1_439) {
    return fallback;
  }

  return value;
}

function minutesToTimeInput(value: number): string {
  const safe = normalizeDayMinutes(value);
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function timeInputToMinutes(value: string, fallback: number): number {
  const [hoursRaw, minutesRaw] = value.split(':');
  const hours = Number.parseInt(hoursRaw ?? '', 10);
  const minutes = Number.parseInt(minutesRaw ?? '', 10);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return fallback;
  }

  return hours * 60 + minutes;
}

function toLocalDateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toLocalTimeInputValue(value: Date): string {
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function parseIsoToLocalDateTime(value: string | null): { date: string; time: string } {
  if (!value) {
    const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);
    return {
      date: toLocalDateInputValue(oneHourLater),
      time: toLocalTimeInputValue(oneHourLater),
    };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const fallback = new Date(Date.now() + 60 * 60 * 1000);
    return {
      date: toLocalDateInputValue(fallback),
      time: toLocalTimeInputValue(fallback),
    };
  }

  return {
    date: toLocalDateInputValue(parsed),
    time: toLocalTimeInputValue(parsed),
  };
}

function formatRemovalDateTime(value: string | null): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function formatNightForceCloseDuration(days: number, hours: number): string {
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}д`);
  }
  if (hours > 0 || parts.length === 0) {
    parts.push(`${hours}ч`);
  }
  return parts.join(' ');
}

function clampCommercialSlider(value: number): number {
  return Math.max(COMMERCIAL_SENSITIVITY_MIN, Math.min(COMMERCIAL_SENSITIVITY_MAX, value));
}

function getCommercialSensitivityLabel(value: number): string {
  const safe = clampCommercialSlider(value);
  if (safe < 25) {
    return 'Мягко';
  }
  if (safe < 70) {
    return 'Баланс';
  }
  return 'Строго';
}

function inferCommercialSensitivitySliderValue(settings: ChatSettings): number {
  const warn = Math.max(10, Math.min(90, settings.commercialAdsWarnThreshold));

  if (settings.commercialAdsSensitivity === 'STRICT') {
    const strictProgress = Math.max(0, Math.min(1, (44 - warn) / 6));
    return Math.round(70 + strictProgress * 30);
  }

  const balancedProgress = Math.max(0, Math.min(1, (58 - warn) / 13));
  return Math.round(balancedProgress * COMMERCIAL_BALANCED_MAX);
}

function mergeSectionSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
  section: ApplySectionKey,
): ChatSettings {
  const nextSettings = { ...targetSettings } as ChatSettings;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of SECTION_SETTING_KEYS[section]) {
    nextRecord[key] = sourceRecord[key];
  }

  return nextSettings;
}

function formatRequiredSubscriptionCount(count: number): string {
  const safeCount = Math.max(0, Math.trunc(count));
  const mod10 = safeCount % 10;
  const mod100 = safeCount % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${safeCount} канал`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${safeCount} канала`;
  }
  return `${safeCount} каналов`;
}

function getRouteChatTitle(state: unknown): string {
  if (
    typeof state === 'object' &&
    state &&
    'chatTitle' in state &&
    typeof state.chatTitle === 'string'
  ) {
    return state.chatTitle.trim();
  }

  return '';
}

function SectionChevron({ isOpen }: { isOpen: boolean }) {
  return (
    <span className={cn('settings-section__chevron', isOpen && 'is-open')} aria-hidden>
      <svg
        className="settings-section__chevron-icon"
        viewBox="0 0 20 20"
        fill="none"
        focusable="false"
      >
        <path
          d="M5.5 7.75L10 12.25L14.5 7.75"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M13.78 4.47L15.53 6.22M5.5 14.5L7.9 13.98C8.2 13.91 8.48 13.76 8.69 13.55L14.96 7.28C15.37 6.87 15.37 6.2 14.96 5.79L14.21 5.04C13.8 4.63 13.13 4.63 12.72 5.04L6.45 11.31C6.24 11.52 6.09 11.8 6.02 12.1L5.5 14.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M6 3.75V5.25M14 3.75V5.25M3.75 7.25H16.25M5.75 10H8M10 10H12.25M5.75 13H8M10 13H12.25M6 5H14C15.38 5 16.5 6.12 16.5 7.5V14.5C16.5 15.88 15.38 17 14 17H6C4.62 17 3.5 15.88 3.5 14.5V7.5C3.5 6.12 4.62 5 6 5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M7.25 3.75H12.75M4.75 6H15.25M8 8.5V13.25M12 8.5V13.25M6.5 6L6.96 14.26C7 15 7.61 15.58 8.35 15.58H11.65C12.39 15.58 13 15 13.04 14.26L13.5 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BotSpeechStyleIcon({
  iconKey,
}: {
  iconKey: (typeof BOT_SPEECH_STYLE_OPTIONS)[number]['iconKey'];
}) {
  return <img src={BOT_SPEECH_STYLE_ICON_ASSETS[iconKey]} alt="" loading="lazy" />;
}

function StyleSelectedIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M5.5 10.4L8.3 13.2L14.6 6.9"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type EditToggleButtonProps = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  isOpen?: boolean;
};

function EditToggleButton({ label, onClick, disabled, isOpen }: EditToggleButtonProps) {
  return (
    <button
      type="button"
      className={cn('settings-edit-button', isOpen && 'is-open')}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <EditIcon />
    </button>
  );
}

function SettingsHintAnchor({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
  children,
}: {
  hintKey: HintKey;
  openHintKey: HintKey | null;
  onToggleHint: (key: HintKey) => void;
  label: string;
  children: string;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <span className="channel-settings-hint-anchor">
      <button
        type="button"
        className={cn('settings-info-button', isOpen && 'is-open')}
        aria-label={label}
        aria-controls={`settings-hint-${hintKey}`}
        aria-expanded={isOpen}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleHint(hintKey);
        }}
      >
        <span aria-hidden>i</span>
      </button>
      {isOpen ? (
        <p
          id={`settings-hint-${hintKey}`}
          className="channel-settings-hint-popover"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {children}
        </p>
      ) : null}
    </span>
  );
}

type BotMessageEditorProps = {
  editorKey: BotMessageEditorKey;
  botSpeechStyle: ChatSettings['botSpeechStyle'];
  value: string;
  onChange: (value: string) => void;
  onReset: () => void;
};

function BotMessageEditor({
  editorKey,
  botSpeechStyle,
  value,
  onChange,
  onReset,
}: BotMessageEditorProps) {
  const defaultTemplate = getSpeechTemplateFallback(
    botSpeechStyle,
    BOT_MESSAGE_EDITOR_FIELD_KEYS[editorKey],
  );
  const templateHint = BOT_MESSAGE_TEMPLATE_HINTS[editorKey];
  const isDefaultTemplate = value.trim().length === 0;
  const editorValue = resolveBotMessageTemplate(value, defaultTemplate);

  return (
    <div className="bot-message-editor">
      <label className="field bot-message-editor__field">
        <span className="field__label">Текст сообщения</span>
        <textarea
          value={editorValue}
          maxLength={1000}
          onChange={(event) => onChange(event.target.value)}
          placeholder={defaultTemplate}
          rows={4}
        />
      </label>

      <div className="bot-message-editor__meta">
        <span className="chip">{isDefaultTemplate ? 'По умолчанию' : 'Кастомный'}</span>
        <button
          type="button"
          className="button button--ghost bot-message-editor__reset"
          onClick={onReset}
          disabled={isDefaultTemplate}
        >
          Сбросить
        </button>
      </div>

      <p className="field__hint bot-message-editor__hint">{templateHint}</p>
    </div>
  );
}

type WarnMessageEditorProps = {
  editorKey: WarnMessageEditorKey;
  botSpeechStyle: ChatSettings['botSpeechStyle'];
  value: string;
  onChange: (value: string) => void;
  onReset: () => void;
};

const EMPTY_BROADCAST_PLANNER_STATE: BroadcastSchedulePlannerSelectionState = {
  pickedDayCount: 0,
  selectedDayCount: 0,
  slotCount: 0,
  futureSlotCount: 0,
  isDaySheetOpen: false,
  isConfirmed: false,
};

function WarnMessageEditor({
  editorKey,
  botSpeechStyle,
  value,
  onChange,
  onReset,
}: WarnMessageEditorProps) {
  const defaultTemplate = getSpeechTemplateFallback(
    botSpeechStyle,
    WARN_MESSAGE_EDITOR_FIELD_KEYS[editorKey],
  );
  const templateHint = WARN_MESSAGE_TEMPLATE_HINTS[editorKey];
  const isDefaultTemplate = value.trim().length === 0;
  const editorValue = resolveBotMessageTemplate(value, defaultTemplate);

  return (
    <div className="bot-message-editor">
      <label className="field bot-message-editor__field">
        <span className="field__label">Текст предупреждения</span>
        <textarea
          value={editorValue}
          maxLength={1000}
          onChange={(event) => onChange(event.target.value)}
          placeholder={defaultTemplate}
          rows={3}
        />
      </label>

      <div className="bot-message-editor__meta">
        <span className="chip">{isDefaultTemplate ? 'По умолчанию' : 'Кастомный'}</span>
        <button
          type="button"
          className="button button--ghost bot-message-editor__reset"
          onClick={onReset}
          disabled={isDefaultTemplate}
        >
          Сбросить
        </button>
      </div>

      <p className="field__hint bot-message-editor__hint">{templateHint}</p>
    </div>
  );
}

export function SettingsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isCompact: isHeaderCompact, isHidden: isHeaderHidden } = useAutoHideHeader();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draft, setDraft] = useState<ChatSettings | null>(null);
  const [rulesDraft, setRulesDraft] = useState<ChatRules | null>(null);
  const [rulesAutoFillEnabled, setRulesAutoFillEnabled] = useState(false);
  const [rulesAutoFillSeedText, setRulesAutoFillSeedText] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [rulesTextError, setRulesTextError] = useState('');
  const [rulesImageError, setRulesImageError] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [domainInputError, setDomainInputError] = useState('');
  const [scheduleDomain, setScheduleDomain] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [mailingText, setMailingText] = useState('');
  const [mailingApplyToAllChats, setMailingApplyToAllChats] = useState(false);
  const [mailingButtonEnabled, setMailingButtonEnabled] = useState(false);
  const [mailingButtonUrl, setMailingButtonUrl] = useState('');
  const [mailingButtonText, setMailingButtonText] = useState('Открыть');
  const [mailingImageEnabled, setMailingImageEnabled] = useState(false);
  const [mailingImageBase64, setMailingImageBase64] = useState('');
  const [mailingImageMimeType, setMailingImageMimeType] = useState('');
  const [mailingImageFileName, setMailingImageFileName] = useState('');
  const [mailingScheduledSlots, setMailingScheduledSlots] = useState<string[]>([]);
  const [mailingBotHasContent, setMailingBotHasContent] = useState(false);
  const [mailingScheduleEnabled, setMailingScheduleEnabled] = useState(false);
  const [mailingScheduleDays, setMailingScheduleDays] = useState(0);
  const [mailingScheduleTime, setMailingScheduleTime] = useState(() =>
    toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)),
  );
  const [mailingCycleEnabled, setMailingCycleEnabled] = useState(false);
  const [mailingCycleEveryHours, setMailingCycleEveryHours] = useState(MIN_BROADCAST_CYCLE_HOURS);
  const [mailingCycleCount, setMailingCycleCount] = useState(2);
  const [mailingTextError, setMailingTextError] = useState('');
  const [mailingButtonUrlError, setMailingButtonUrlError] = useState('');
  const [mailingButtonTextError, setMailingButtonTextError] = useState('');
  const [mailingImageError, setMailingImageError] = useState('');
  const [mailingScheduleError, setMailingScheduleError] = useState('');
  const [mailingCycleError, setMailingCycleError] = useState('');
  const [mailingPlannerResetKey, setMailingPlannerResetKey] = useState(0);
  const [mailingPlannerState, setMailingPlannerState] =
    useState<BroadcastSchedulePlannerSelectionState>(EMPTY_BROADCAST_PLANNER_STATE);
  const [editingManagedBroadcast, setEditingManagedBroadcast] =
    useState<ManagedBroadcastDetails | null>(null);
  const [expandedManagedBroadcastId, setExpandedManagedBroadcastId] = useState<string | null>(null);
  const [duplicateWindowInputValues, setDuplicateWindowInputValues] = useState<
    Partial<Record<DuplicateWindowKey, string>>
  >({});
  const [rulesFailedSnapshot, setRulesFailedSnapshot] = useState('');
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const [openBotEditorKey, setOpenBotEditorKey] = useState<BotMessageEditorKey | null>(null);
  const [openWarnEditorKey, setOpenWarnEditorKey] = useState<WarnMessageEditorKey | null>(null);
  const [pendingSpeechStyle, setPendingSpeechStyle] = useState<BotSpeechStyle | null>(null);
  const [expandedSections, setExpandedSections] =
    useState<Record<SettingsSectionKey, boolean>>(INITIAL_EXPANDED_SECTIONS);
  const appliedBroadcastHandoffSignatureRef = useRef<string | null>(null);

  const routeChatTitle = getRouteChatTitle(location.state);
  const searchParams = new URLSearchParams(location.search);
  const focusSection = searchParams.get('focus');
  const handoffRequested = searchParams.get('handoff') === '1';

  useEffect(() => {
    if (
      focusSection !== 'giveaway' &&
      focusSection !== 'broadcast' &&
      focusSection !== 'requiredSubscription'
    ) {
      return;
    }

    setExpandedSections({
      ...INITIAL_EXPANDED_SECTIONS,
      ...(focusSection === 'giveaway'
        ? { giveaway: true }
        : focusSection === 'requiredSubscription'
          ? { requiredSubscription: true }
          : { mailing: true }),
    });
  }, [focusSection]);

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('chat', chatId);
    }
  }, [chatId]);

  useEffect(() => {
    setRulesDraft(null);
    setRulesAutoFillEnabled(false);
    setRulesAutoFillSeedText(null);
    setRulesTextError('');
    setRulesImageError('');
    setRulesFailedSnapshot('');
    setMailingApplyToAllChats(false);
    setMailingText('');
    setMailingButtonEnabled(false);
    setMailingButtonUrl('');
    setMailingButtonText('Открыть');
    setMailingImageEnabled(false);
    setMailingImageBase64('');
    setMailingImageMimeType('');
    setMailingImageFileName('');
    setMailingScheduledSlots([]);
    setMailingBotHasContent(false);
    setMailingScheduleEnabled(false);
    setMailingScheduleDays(0);
    setMailingScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setMailingCycleEnabled(false);
    setMailingCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setMailingCycleCount(2);
    setMailingTextError('');
    setMailingButtonUrlError('');
    setMailingButtonTextError('');
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
    resetMailingPlanner();
    setEditingManagedBroadcast(null);
    setExpandedManagedBroadcastId(null);
    setDuplicateWindowInputValues({});
    setPendingSpeechStyle(null);
  }, [chatId]);

  const settingsScreenQuery = useQuery({
    queryKey: ['settings-screen', chatId],
    queryFn: () => getSettingsScreen(api, chatId ?? ''),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });
  const broadcastHandoffStateQuery = useQuery({
    queryKey: ['broadcast-handoff-state', chatId],
    queryFn: () => getBroadcastHandoffState(api, chatId ?? ''),
    enabled: Boolean(chatId) && focusSection === 'broadcast' && handoffRequested,
    refetchOnWindowFocus: false,
  });
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => getMe(api),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const chatsQuery = useQuery({
    queryKey: ['chats'],
    queryFn: () => getChats(api),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const channelsQuery = useQuery({
    queryKey: ['channels'],
    queryFn: () => getChannels(api),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const settingsQuery = {
    data: settingsScreenQuery.data?.settings,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
    refetch: settingsScreenQuery.refetch,
  };
  const rulesQuery = {
    data: settingsScreenQuery.data?.rules,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
  };
  const managedBroadcastsQuery = {
    data: settingsScreenQuery.data?.managedBroadcasts,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
  };
  const chatHeaderQuery = {
    data: settingsScreenQuery.data?.header,
  };
  const domainsQuery = {
    data: settingsScreenQuery.data?.domains,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
  };
  const availableRequiredSubscriptionChannels = useMemo(
    () =>
      (channelsQuery.data ?? []).filter(
        (channel) => channel.entityType === 'channel' && Boolean(channel.link?.trim()),
      ),
    [channelsQuery.data],
  );
  const availableRequiredSubscriptionChannelById = useMemo(() => {
    const map = new Map<string, (typeof availableRequiredSubscriptionChannels)[number]>();
    for (const channel of availableRequiredSubscriptionChannels) {
      map.set(channel.id, channel);
    }
    return map;
  }, [availableRequiredSubscriptionChannels]);
  const selectedRequiredSubscriptionChannels = useMemo(() => {
    const selectedIds = draft?.requiredSubscriptionChannelIds ?? [];
    return selectedIds
      .map((channelId) => {
        const channel = availableRequiredSubscriptionChannelById.get(channelId);
        return channel
          ? {
              id: channel.id,
              title: channel.title,
              link: channel.link?.trim() ?? '',
            }
          : null;
      })
      .filter(
        (
          channel,
        ): channel is {
          id: string;
          title: string;
          link: string;
        } => channel !== null,
      );
  }, [availableRequiredSubscriptionChannelById, draft?.requiredSubscriptionChannelIds]);
  const staleRequiredSubscriptionChannelIds = useMemo(() => {
    if (!channelsQuery.isSuccess) {
      return [];
    }

    return (draft?.requiredSubscriptionChannelIds ?? []).filter(
      (channelId) => !availableRequiredSubscriptionChannelById.has(channelId),
    );
  }, [
    availableRequiredSubscriptionChannelById,
    channelsQuery.isSuccess,
    draft?.requiredSubscriptionChannelIds,
  ]);
  const availableRequiredSubscriptionChannelChoices = useMemo(() => {
    const selectedIds = new Set(draft?.requiredSubscriptionChannelIds ?? []);
    return availableRequiredSubscriptionChannels.filter((channel) => !selectedIds.has(channel.id));
  }, [availableRequiredSubscriptionChannels, draft?.requiredSubscriptionChannelIds]);

  const chatTitle = useMemo(() => {
    if (!chatId) {
      return '';
    }

    const fromHeader = chatHeaderQuery.data?.title?.trim();
    if (fromHeader) {
      return fromHeader;
    }

    const fromList = chatsQuery.data?.find((chat) => chat.id === chatId)?.title?.trim();
    if (fromList) {
      return fromList;
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [chatHeaderQuery.data?.title, chatId, chatsQuery.data, routeChatTitle]);

  useEffect(() => {
    if (!chatId || !chatTitle) {
      return;
    }

    saveChatTitle(chatId, chatTitle);
  }, [chatId, chatTitle]);

  useEffect(() => {
    if (!chatTitle || routeChatTitle === chatTitle) {
      return;
    }

    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: { chatTitle },
    });
  }, [chatTitle, location.pathname, location.search, navigate, routeChatTitle]);

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    setDraft(settingsQuery.data);
    setFieldErrors({});
    setDuplicateWindowInputValues({});
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!broadcastHandoffStateQuery.data) {
      return;
    }

    const signature = JSON.stringify(broadcastHandoffStateQuery.data);
    if (appliedBroadcastHandoffSignatureRef.current === signature) {
      return;
    }

    appliedBroadcastHandoffSignatureRef.current = signature;
    setEditingManagedBroadcast(null);
    setMailingApplyToAllChats(broadcastHandoffStateQuery.data.applyToAllChats);
    setMailingButtonEnabled(broadcastHandoffStateQuery.data.buttonEnabled);
    setMailingButtonUrl(broadcastHandoffStateQuery.data.buttonUrl);
    setMailingButtonText(broadcastHandoffStateQuery.data.buttonText || 'Открыть');
    setMailingScheduledSlots(
      sortAndUniqueBroadcastSlots(broadcastHandoffStateQuery.data.scheduledSlots),
    );
    setMailingBotHasContent(broadcastHandoffStateQuery.data.hasContent);
    setMailingText('');
    setMailingImageEnabled(false);
    setMailingImageBase64('');
    setMailingImageMimeType('');
    setMailingImageFileName('');
    setMailingScheduleError('');
    setMailingCycleError('');
    resetMailingPlanner();
    setExpandedSections((current) => ({ ...current, mailing: true }));
    if (broadcastHandoffStateQuery.data.hasContent) {
      pushToast({
        title: 'Контент сохранён в боте',
        description: 'Календарь восстановлен из личного чата бота.',
        tone: 'success',
      });
    }
  }, [broadcastHandoffStateQuery.data, pushToast]);

  const autoRulesText = useMemo(() => {
    const sourceSettings = draft ?? settingsQuery.data;
    return sourceSettings ? buildAutoRulesText(sourceSettings) : '';
  }, [draft, settingsQuery.data]);

  useEffect(() => {
    if (!rulesQuery.data || rulesDraft) {
      return;
    }

    setRulesDraft(
      chatRulesSchema.parse({
        ...rulesQuery.data,
        autoTextEnabled: false,
        text: rulesQuery.data.autoTextEnabled ? '' : rulesQuery.data.text,
      }),
    );
    setRulesAutoFillEnabled(false);
    setRulesAutoFillSeedText(null);
    setRulesTextError('');
    setRulesImageError('');
  }, [rulesDraft, rulesQuery.data]);

  useEffect(() => {
    if (!scheduleDomain) {
      return;
    }

    const exists = (domainsQuery.data ?? []).some((item) => item.domain === scheduleDomain);
    if (!exists) {
      setScheduleDomain(null);
      setScheduleError('');
    }
  }, [domainsQuery.data, scheduleDomain]);

  const draftSnapshot = useMemo(() => (draft ? JSON.stringify(draft) : ''), [draft]);
  const rulesDraftSnapshot = useMemo(
    () => (rulesDraft ? serializeRulesDraftPayload(rulesDraft) : ''),
    [rulesDraft],
  );

  const serverSnapshot = useMemo(
    () => (settingsQuery.data ? JSON.stringify(settingsQuery.data) : ''),
    [settingsQuery.data],
  );
  const rulesServerSnapshot = useMemo(
    () => (rulesQuery.data ? serializeRulesDraftPayload(rulesQuery.data) : ''),
    [rulesQuery.data],
  );

  const hasChanges = Boolean(draft && settingsQuery.data && draftSnapshot !== serverSnapshot);
  const hasRulesChanges = Boolean(
    rulesDraft && rulesQuery.data && rulesDraftSnapshot !== rulesServerSnapshot,
  );
  const rulesPublishedMessageId =
    rulesDraft?.publishedMessageId ?? rulesQuery.data?.publishedMessageId ?? null;
  const rulesPublishedUrl = rulesDraft?.publishedUrl ?? rulesQuery.data?.publishedUrl ?? null;
  const hasPublishedRules = Boolean(rulesPublishedMessageId || rulesPublishedUrl);
  const isPendingAutoFillOnly = Boolean(
    rulesDraft &&
    rulesAutoFillSeedText !== null &&
    rulesDraft.text === rulesAutoFillSeedText &&
    rulesDraft.imageBase64 === (rulesQuery.data?.imageBase64 ?? '') &&
    rulesDraft.imageMimeType === (rulesQuery.data?.imageMimeType ?? '') &&
    rulesDraft.imageFileName === (rulesQuery.data?.imageFileName ?? ''),
  );

  const saveSectionMutation = useMutation({
    mutationFn: ({ payload }: { section: ApplySectionKey; payload: ChatSettings }) =>
      updateSettings(api, chatId ?? '', payload),
    onSuccess: (saved, variables) => {
      syncSavedSectionSettings(variables.section, saved);
      pushToast({
        tone: 'success',
        title: `Блок «${SECTION_LABELS[variables.section]}» сохранен`,
      });
      maxNotify('success');
    },
    onError: (error, variables) => {
      pushToast({
        tone: 'danger',
        title: `Не удалось сохранить блок «${SECTION_LABELS[variables.section]}»`,
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingSettings = saveSectionMutation.isPending;
  const savingSection = saveSectionMutation.variables?.section ?? null;
  const mutateSettingsAsync = saveSectionMutation.mutateAsync;

  const saveSpeechStyleMutation = useMutation({
    mutationFn: ({ style, payload }: { style: BotSpeechStyle; payload: ChatSettings }) =>
      updateSettings(api, chatId ?? '', payload),
    onSuccess: (saved, variables) => {
      syncSavedBotSpeechStyle(saved);
      setPendingSpeechStyle(null);
      pushToast({
        tone: 'success',
        title: `Стиль «${BOT_SPEECH_STYLE_METADATA[variables.style].label}» применен`,
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить стиль речи',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingSpeechStyle = saveSpeechStyleMutation.isPending;

  const saveRulesMutation = useMutation({
    mutationFn: (payload: UpdateChatRulesPayload) => updateRules(api, chatId ?? '', payload),
    onSuccess: (saved, payload) => {
      const payloadSnapshot = serializeRulesDraftPayload(payload);
      setRulesDraft((current) => {
        if (!current) {
          return saved;
        }
        const currentSnapshot = serializeRulesDraftPayload(current);
        return currentSnapshot === payloadSnapshot ? saved : current;
      });
      setRulesAutoFillSeedText(null);
      setRulesTextError('');
      setRulesImageError('');
      setRulesFailedSnapshot('');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
    },
    onError: (error, payload) => {
      setRulesFailedSnapshot(JSON.stringify(payload));
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить черновик правил',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingRules = saveRulesMutation.isPending;
  const mutateRules = saveRulesMutation.mutate;
  const mutateRulesAsync = saveRulesMutation.mutateAsync;
  const isHeaderSaving = isSavingSettings || isSavingRules || isSavingSpeechStyle;
  const hasPendingHeaderChanges = hasChanges || hasRulesChanges;
  const showHeaderStatus = isHeaderSaving || hasPendingHeaderChanges;
  const compactHeaderStatusLabel = isHeaderSaving ? 'Сохр.' : 'Черн.';
  const canSeeThematicFilters = meQuery.data?.userId === THEMATIC_FILTERS_OWNER_USER_ID;
  const activeSpeechStyle = useMemo(() => {
    if (!draft?.botSpeechStyle || hasBotSpeechEditableOverrides(draft)) {
      return null;
    }

    return draft.botSpeechStyle;
  }, [draft]);
  const hasSpeechOverrides = draft ? hasBotSpeechEditableOverrides(draft) : false;
  const pendingSpeechStyleMeta = pendingSpeechStyle
    ? BOT_SPEECH_STYLE_METADATA[pendingSpeechStyle]
    : null;
  const pendingSpeechStyleSamples = pendingSpeechStyle
    ? buildSpeechStylePreviewSamples(pendingSpeechStyle)
    : null;

  const publishRulesMutation = useMutation({
    mutationFn: () => publishRules(api, chatId ?? ''),
    onSuccess: (result) => {
      const updated = chatRulesSchema.parse({
        ...(rulesDraft ?? rulesQuery.data ?? {}),
        publishedMessageId: result.messageId,
        publishedUrl: result.url,
        publishedAt: result.publishedAt,
      });
      setRulesDraft(updated);
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: 'success',
        title: 'Правила опубликованы',
        description: 'Пост опубликован.',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать правила',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isPublishingRules = publishRulesMutation.isPending;

  const resetPublishedRulesMutation = useMutation({
    mutationFn: () => resetPublishedRules(api, chatId ?? ''),
    onSuccess: (updated) => {
      const nextDraft = chatRulesSchema.parse({
        ...(rulesDraft ?? updated),
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      });
      setRulesDraft(nextDraft);
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: 'success',
        title: 'Публикация правил сброшена',
        description: 'Ранее опубликованный пост удален, статус очищен.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сбросить публикацию',
        description: formatApiError(error),
      });
    },
  });
  const isResettingPublishedRules = resetPublishedRulesMutation.isPending;

  const applySectionToAllMutation = useMutation({
    mutationFn: async ({
      section,
      sourceSettings,
    }: {
      section: ApplySectionKey;
      sourceSettings: ChatSettings;
    }) => {
      if (!chatId) {
        throw new Error('Чат не выбран');
      }

      const savedSourceSettings = await updateSettings(api, chatId, sourceSettings);
      const result = await applySettingsSectionToAll(api, chatId, section);
      return {
        ...result,
        sourceSettings: savedSourceSettings,
      };
    },
    onSuccess: (result) => {
      syncSavedSectionSettings(result.section, result.sourceSettings);
      pushToast({
        tone: 'success',
        title: `Блок «${SECTION_LABELS[result.section]}» применен`,
        description: `Обновлено чатов: ${result.updatedChats}.`,
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить блок ко всем чатам',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isApplyingSectionToAll = applySectionToAllMutation.isPending;
  const applyingSection = applySectionToAllMutation.variables?.section ?? null;

  useEffect(() => {
    const shouldBlockClose = hasPendingHeaderChanges || isHeaderSaving || isApplyingSectionToAll;
    setMaxClosingConfirmation(shouldBlockClose);
    return () => {
      setMaxClosingConfirmation(false);
    };
  }, [hasPendingHeaderChanges, isApplyingSectionToAll, isHeaderSaving]);

  const addDomainMutation = useMutation({
    mutationFn: (domain: string) => addDomain(api, chatId ?? '', domain),
    onSuccess: () => {
      setDomainInput('');
      setDomainInputError('');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({ tone: 'success', title: 'Ссылка добавлена в разрешенные' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось добавить ссылку',
        description: formatApiError(error),
      });
    },
  });

  const removeDomainMutation = useMutation({
    mutationFn: (domain: string) => removeDomain(api, chatId ?? '', domain),
    onSuccess: () => {
      setScheduleDomain(null);
      setScheduleError('');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({ tone: 'success', title: 'Ссылка удалена из разрешенных' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить ссылку',
        description: formatApiError(error),
      });
    },
  });

  const scheduleDomainRemovalMutation = useMutation({
    mutationFn: (payload: { domain: string; removeAfterAt: string | null }) =>
      scheduleDomainRemoval(api, chatId ?? '', payload.domain, payload.removeAfterAt),
    onSuccess: (_, payload) => {
      setScheduleError('');
      setScheduleDomain(null);
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      if (payload.removeAfterAt) {
        pushToast({
          tone: 'success',
          title: 'Удаление ссылки запланировано',
          description: `Ссылка будет удалена ${formatRemovalDateTime(payload.removeAfterAt)}.`,
        });
        return;
      }

      pushToast({ tone: 'success', title: 'Отложенное удаление отменено' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить расписание удаления',
        description: formatApiError(error),
      });
    },
  });

  const handoffBroadcastMutation = useMutation({
    mutationFn: (payload: BroadcastHandoffPayload) => handoffBroadcast(api, chatId ?? '', payload),
    onSuccess: (result) => {
      pushToast({
        tone: 'info',
        title: 'Открываем личный чат бота',
        description: 'Отправьте там текст или фото, затем подтвердите рассылку.',
      });
      openMaxBotLink(result.botUrl);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть сбор контента',
        description: formatApiError(error),
      });
    },
  });

  const loadManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) => getManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      applyManagedBroadcastToComposer(broadcast);
      setExpandedSections((current) => ({ ...current, mailing: true }));
      setExpandedManagedBroadcastId(broadcast.id);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть рассылку',
        description: formatApiError(error),
      });
    },
  });

  const updateManagedBroadcastMutation = useMutation({
    mutationFn: ({
      broadcastId,
      payload,
    }: {
      broadcastId: string;
      payload: SendBroadcastPayload;
    }) => updateManagedBroadcast(api, chatId ?? '', broadcastId, payload),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      resetMailingComposer();
      pushToast({
        tone: broadcast.status === 'FAILED' ? 'info' : 'success',
        title: 'Рассылка обновлена',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatRemovalDateTime(broadcast.nextSendAt)}.`
          : 'Изменения сохранены.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить рассылку',
        description: formatApiError(error),
      });
    },
  });

  const cancelManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) => cancelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      if (editingManagedBroadcast?.id === broadcast.id) {
        resetMailingComposer();
      }
      pushToast({
        tone: 'info',
        title: 'Рассылка остановлена',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось остановить рассылку',
        description: formatApiError(error),
      });
    },
  });

  const retryManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) => retryManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL' ? 'info' : 'success',
        title:
          broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL'
            ? 'Часть чатов все еще с ошибкой'
            : 'Повтор выполнен',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatRemovalDateTime(broadcast.nextSendAt)}.`
          : 'Ошибка закрыта.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось повторить рассылку',
        description: formatApiError(error),
      });
    },
  });

  function clearFieldError(key: keyof ChatSettings) {
    setFieldErrors((current) => {
      if (!current[key]) {
        return current;
      }

      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function setFieldValue<K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    clearFieldError(key);
  }

  function addRequiredSubscriptionChannel(channelId: string) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      if (current.requiredSubscriptionChannelIds.includes(channelId)) {
        return current;
      }

      if (current.requiredSubscriptionChannelIds.length >= REQUIRED_SUBSCRIPTION_MAX_CHANNELS) {
        return current;
      }

      return {
        ...current,
        requiredSubscriptionChannelIds: [...current.requiredSubscriptionChannelIds, channelId],
      };
    });
    clearFieldError('requiredSubscriptionChannelIds');
  }

  function removeRequiredSubscriptionChannel(channelId: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            requiredSubscriptionChannelIds: current.requiredSubscriptionChannelIds.filter(
              (item) => item !== channelId,
            ),
          }
        : current,
    );
    clearFieldError('requiredSubscriptionChannelIds');
  }

  function clearSectionErrors(section: ApplySectionKey) {
    setFieldErrors((current) => {
      let changed = false;
      const next = { ...current };

      for (const key of SECTION_SETTING_KEYS[section]) {
        if (!next[key]) {
          continue;
        }

        delete next[key];
        changed = true;
      }

      return changed ? next : current;
    });
  }

  function clearBotSpeechErrors() {
    setFieldErrors((current) => {
      let changed = false;
      const next = { ...current };

      for (const key of BOT_SPEECH_SYNC_SETTING_KEYS) {
        if (!next[key]) {
          continue;
        }

        delete next[key];
        changed = true;
      }

      return changed ? next : current;
    });
  }

  function syncSavedSectionSettings(section: ApplySectionKey, saved: ChatSettings) {
    setDraft((current) => (current ? mergeSectionSettings(current, saved, section) : saved));
    clearSectionErrors(section);
    queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
      ['settings-screen', chatId],
      (current) =>
        current
          ? {
              ...current,
              settings: mergeSectionSettings(current.settings, saved, section),
            }
          : current,
    );
  }

  function syncSavedBotSpeechStyle(saved: ChatSettings) {
    setDraft((current) => (current ? mergeBotSpeechStyleSettings(current, saved) : saved));
    clearBotSpeechErrors();
    queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
      ['settings-screen', chatId],
      (current) =>
        current
          ? {
              ...current,
              settings: mergeBotSpeechStyleSettings(current.settings, saved),
            }
          : current,
    );
  }

  function setRulesFieldValue<K extends keyof UpdateChatRulesPayload>(
    key: K,
    value: UpdateChatRulesPayload[K],
  ) {
    if (key === 'text') {
      const nextText = String(value);
      if (rulesAutoFillSeedText !== null && rulesAutoFillSeedText !== nextText) {
        setRulesAutoFillSeedText(null);
        setRulesAutoFillEnabled(false);
      }
    }

    setRulesDraft((current) => {
      if (!current) {
        return current;
      }

      return chatRulesSchema.parse({
        ...current,
        [key]: value,
      });
    });

    if (key === 'text' && rulesTextError) {
      setRulesTextError('');
    }
    if (
      (key === 'imageBase64' || key === 'imageMimeType' || key === 'imageFileName') &&
      rulesImageError
    ) {
      setRulesImageError('');
    }
  }

  function handleRulesAutoTextToggle(enabled: boolean) {
    setRulesAutoFillEnabled(enabled);

    if (!enabled || !autoRulesText) {
      return;
    }

    setRulesAutoFillSeedText(autoRulesText);

    setRulesDraft((current) => {
      if (!current) {
        return current;
      }

      return chatRulesSchema.parse({
        ...current,
        autoTextEnabled: false,
        text: autoRulesText,
      });
    });
    setRulesTextError('');
  }

  function clearRulesImage() {
    setRulesDraft((current) => {
      if (!current) {
        return current;
      }

      return chatRulesSchema.parse({
        ...current,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
      });
    });
    setRulesImageError('');
  }

  function validateDraft(value: ChatSettings): ChatSettings | null {
    const parsed = chatSettingsSchema.safeParse(value);

    if (parsed.success) {
      const nextErrors: FieldErrors = {};

      if (
        parsed.data.requiredSubscriptionEnabled &&
        staleRequiredSubscriptionChannelIds.length > 0
      ) {
        nextErrors.requiredSubscriptionChannelIds =
          'Удалите недоступные каналы без рабочей ссылки и выберите каналы заново.';
      }

      if (Object.keys(nextErrors).length === 0) {
        setFieldErrors({});
        return parsed.data;
      }

      setFieldErrors(nextErrors);
      return null;
    }

    const nextErrors: FieldErrors = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof ChatSettings | undefined;
      if (!key || nextErrors[key]) {
        continue;
      }
      nextErrors[key] = issue.message;
    }

    setFieldErrors(nextErrors);
    return null;
  }

  function validateRulesDraft(value: ChatRules): UpdateChatRulesPayload | null {
    const normalizedText = value.text;
    if (normalizedText.length > MAX_CHAT_RULES_TEXT_LENGTH) {
      setRulesTextError(`Максимум ${MAX_CHAT_RULES_TEXT_LENGTH} символов.`);
      return null;
    }
    setRulesTextError('');

    if (value.imageBase64) {
      if (!value.imageMimeType.toLowerCase().startsWith('image/')) {
        setRulesImageError('Поддерживаются только изображения.');
        return null;
      }
      setRulesImageError('');
    } else {
      setRulesImageError('');
    }

    return {
      autoTextEnabled: false,
      text: value.text,
      imageBase64: value.imageBase64,
      imageMimeType: value.imageMimeType,
      imageFileName: value.imageFileName,
    };
  }

  async function saveRulesDraftNow(): Promise<ChatRules | null> {
    if (!rulesDraft) {
      return null;
    }

    const payload = validateRulesDraft(rulesDraft);
    if (!payload) {
      return null;
    }

    return mutateRulesAsync(payload);
  }

  function secondsToHours(value: number): number {
    return Math.max(1, Math.round(value / 3600));
  }

  function handleDuplicateWindowHoursChange(key: DuplicateWindowKey, rawValue: string) {
    setDuplicateWindowInputValues((current) => ({ ...current, [key]: rawValue }));

    const normalized = rawValue.trim();
    if (normalized.length === 0) {
      return;
    }

    const hours = Number.parseInt(normalized, 10);
    if (Number.isNaN(hours)) {
      return;
    }

    const safeHours = Math.min(168, Math.max(1, hours));
    setFieldValue(key, (safeHours * 3600) as ChatSettings[DuplicateWindowKey]);
  }

  function handleDuplicateWindowHoursBlur(key: DuplicateWindowKey) {
    const rawValue = duplicateWindowInputValues[key];
    if (rawValue === undefined) {
      return;
    }

    const normalized = rawValue.trim();
    const parsed = Number.parseInt(normalized, 10);

    const fallbackHours = draft ? secondsToHours(Number(draft[key])) : 1;
    const safeHours = Number.isNaN(parsed) ? fallbackHours : Math.min(168, Math.max(1, parsed));
    setFieldValue(key, (safeHours * 3600) as ChatSettings[DuplicateWindowKey]);

    setDuplicateWindowInputValues((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function adjustBanDuration(deltaHours: number) {
    if (!draft) {
      return;
    }

    const next = Math.min(
      BAN_DURATION_MAX_HOURS,
      Math.max(BAN_DURATION_MIN_HOURS, Number(draft.banDurationHours) + deltaHours),
    );

    setFieldValue('banDurationHours', next as ChatSettings['banDurationHours']);
  }

  function adjustDeleteBotMessagesDelay(deltaMinutes: number) {
    if (!draft) {
      return;
    }

    const next = Math.min(
      BOT_MESSAGES_DELETE_DELAY_MAX,
      Math.max(
        BOT_MESSAGES_DELETE_DELAY_MIN,
        Number(draft.deleteBotMessagesDelayMinutes) + deltaMinutes,
      ),
    );

    setFieldValue(
      'deleteBotMessagesDelayMinutes',
      next as ChatSettings['deleteBotMessagesDelayMinutes'],
    );
  }

  function adjustStickerMessageCooldown(deltaMinutes: number) {
    if (!draft) {
      return;
    }

    const next = Math.min(
      STICKER_COOLDOWN_MAX_MINUTES,
      Math.max(
        STICKER_COOLDOWN_MIN_MINUTES,
        Number(draft.stickerMessageCooldownMinutes) + deltaMinutes,
      ),
    );

    setFieldValue(
      'stickerMessageCooldownMinutes',
      next as ChatSettings['stickerMessageCooldownMinutes'],
    );
  }

  function adjustDuplicateMaxCount(key: DuplicateMaxCountKey, currentValue: number, delta: number) {
    const next = Math.min(
      DUPLICATE_COUNT_MAX,
      Math.max(DUPLICATE_COUNT_MIN, Number(currentValue) + delta),
    );
    setFieldValue(key, next as ChatSettings[DuplicateMaxCountKey]);
  }

  useEffect(() => {
    if (!rulesFailedSnapshot || rulesFailedSnapshot === rulesDraftSnapshot) {
      return;
    }

    setRulesFailedSnapshot('');
  }, [rulesDraftSnapshot, rulesFailedSnapshot]);

  useEffect(() => {
    if (
      !chatId ||
      !rulesDraft ||
      !hasRulesChanges ||
      isSavingRules ||
      isPublishingRules ||
      isPendingAutoFillOnly
    ) {
      return;
    }

    if (rulesFailedSnapshot && rulesFailedSnapshot === rulesDraftSnapshot) {
      return;
    }

    const parsed = validateRulesDraft(rulesDraft);
    if (!parsed) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      mutateRules(parsed);
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    chatId,
    hasRulesChanges,
    isPublishingRules,
    isSavingRules,
    isPendingAutoFillOnly,
    mutateRules,
    rulesDraft,
    rulesDraftSnapshot,
    rulesFailedSnapshot,
  ]);

  function handleAddDomain() {
    if (!chatId) {
      return;
    }

    const normalized = normalizeAllowlistLink(domainInput);
    if (!normalized) {
      setDomainInputError('Введите корректную ссылку (http/https).');
      return;
    }

    const alreadyExists = (domainsQuery.data ?? []).some((item) => item.domain === normalized);
    if (alreadyExists) {
      setDomainInputError('');
      setDomainInput('');
      pushToast({ title: 'Ссылка уже есть в списке' });
      return;
    }

    setDomainInputError('');
    addDomainMutation.mutate(normalized);
  }

  function toggleDomainScheduleEditor(entry: DomainAllowlistEntry) {
    if (scheduleDomain === entry.domain) {
      setScheduleDomain(null);
      setScheduleError('');
      return;
    }

    const initial = parseIsoToLocalDateTime(entry.removeAfterAt);
    setScheduleDate(initial.date);
    setScheduleTime(initial.time);
    setScheduleError('');
    setScheduleDomain(entry.domain);
  }

  function submitDomainSchedule(domain: string) {
    if (!chatId) {
      return;
    }

    if (!scheduleDate) {
      setScheduleError('Сначала выберите день удаления.');
      return;
    }

    if (!scheduleTime) {
      setScheduleError('Сначала выберите время удаления.');
      return;
    }

    const scheduledAt = new Date(`${scheduleDate}T${scheduleTime}:00`);
    if (Number.isNaN(scheduledAt.getTime())) {
      setScheduleError('Не удалось распознать дату и время.');
      return;
    }

    if (scheduledAt.getTime() <= Date.now() + DOMAIN_REMOVAL_MIN_FUTURE_MS) {
      setScheduleError('Укажите время в будущем.');
      return;
    }

    setScheduleError('');
    scheduleDomainRemovalMutation.mutate({
      domain,
      removeAfterAt: scheduledAt.toISOString(),
    });
  }

  function clearDomainSchedule(domain: string) {
    if (!chatId) {
      return;
    }

    setScheduleError('');
    scheduleDomainRemovalMutation.mutate({
      domain,
      removeAfterAt: null,
    });
  }

  async function handleRulesImageChange(file: File | null) {
    if (!file) {
      return;
    }

    if (file.size > MAX_RULES_IMAGE_SIZE_BYTES) {
      setRulesImageError('Фото правил слишком большое. Максимум 1 MB.');
      return;
    }

    if (!file.type.toLowerCase().startsWith('image/')) {
      setRulesImageError('Поддерживаются только изображения.');
      return;
    }

    try {
      const imageBase64 = await fileToBase64(file);
      setRulesFieldValue('imageBase64', imageBase64);
      setRulesFieldValue('imageMimeType', file.type);
      setRulesFieldValue('imageFileName', file.name);
    } catch (error) {
      setRulesImageError(error instanceof Error ? error.message : 'Не удалось прочитать фото.');
    }
  }

  async function handlePublishRules() {
    if (!chatId || !rulesDraft) {
      return;
    }

    if (!rulesDraft.text.trim()) {
      setRulesTextError('Введите текст правил перед публикацией.');
      return;
    }

    if (rulesDraft.text.length > MAX_CHAT_RULES_TEXT_LENGTH) {
      setRulesTextError(`Максимум ${MAX_CHAT_RULES_TEXT_LENGTH} символов.`);
      return;
    }

    const saved = hasRulesChanges ? await saveRulesDraftNow() : rulesDraft;
    if (!saved) {
      return;
    }

    publishRulesMutation.mutate();
  }

  function handleResetPublishedRules() {
    if (!chatId || !hasPublishedRules || isResettingPublishedRules) {
      return;
    }

    if (
      typeof window !== 'undefined' &&
      !window.confirm('Удалить опубликованный пост правил и снять статус публикации?')
    ) {
      return;
    }

    resetPublishedRulesMutation.mutate();
  }

  function resetMailingComposer() {
    setEditingManagedBroadcast(null);
    setMailingApplyToAllChats(false);
    setMailingText('');
    setMailingBotHasContent(false);
    setMailingButtonEnabled(false);
    setMailingButtonUrl('');
    setMailingButtonText('Открыть');
    setMailingImageEnabled(false);
    setMailingImageBase64('');
    setMailingImageMimeType('');
    setMailingImageFileName('');
    setMailingScheduledSlots([]);
    setMailingScheduleEnabled(false);
    setMailingScheduleDays(0);
    setMailingScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setMailingCycleEnabled(false);
    setMailingCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setMailingCycleCount(2);
    setMailingTextError('');
    setMailingButtonUrlError('');
    setMailingButtonTextError('');
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
    resetMailingPlanner();
  }

  function applyManagedBroadcastToComposer(broadcast: ManagedBroadcastDetails) {
    setEditingManagedBroadcast(broadcast);
    setMailingApplyToAllChats(broadcast.applyToAllChats);
    setMailingBotHasContent(false);
    setMailingText(broadcast.text);
    setMailingButtonEnabled(broadcast.buttonEnabled);
    setMailingButtonUrl(broadcast.buttonUrl);
    setMailingButtonText(broadcast.buttonText || 'Открыть');
    setMailingImageEnabled(broadcast.imageEnabled);
    setMailingImageBase64(broadcast.imageBase64);
    setMailingImageMimeType(broadcast.imageMimeType);
    setMailingImageFileName(broadcast.imageFileName);
    setMailingScheduledSlots(sortAndUniqueBroadcastSlots(broadcast.scheduledSlots));
    setMailingScheduleEnabled(false);
    setMailingScheduleDays(0);
    setMailingScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setMailingCycleEnabled(false);
    setMailingCycleEveryHours(clampBroadcastCycleHours(broadcast.cycleEveryHours));
    setMailingCycleCount(Math.max(2, broadcast.cycleCount));
    setMailingTextError('');
    setMailingButtonUrlError('');
    setMailingButtonTextError('');
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
    resetMailingPlanner();
  }

  function handleEditManagedBroadcast(broadcastId: string) {
    if (!chatId || loadManagedBroadcastMutation.isPending) {
      return;
    }

    loadManagedBroadcastMutation.mutate(broadcastId);
  }

  function handleCancelMailingEdit() {
    resetMailingComposer();
  }

  function handleSendBroadcast() {
    if (!chatId) {
      return;
    }

    const normalizedText = mailingText.trim();
    const normalizedButtonUrl = mailingButtonUrl.trim();
    const normalizedButtonText = mailingButtonText.trim();
    const scheduledSlots = sortAndUniqueBroadcastSlots(mailingScheduledSlots);
    const scheduleTimezone = resolveBroadcastScheduleTimezone();

    let hasError = false;
    if (editingManagedBroadcast) {
      if (!normalizedText && !mailingImageEnabled) {
        setMailingTextError('В сохранённой рассылке нет текста или фото.');
        hasError = true;
      } else if (normalizedText.length > MAX_BROADCAST_TEXT_LENGTH) {
        setMailingTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
        hasError = true;
      } else {
        setMailingTextError('');
      }

      if (mailingImageEnabled) {
        if (!mailingImageBase64 || !mailingImageMimeType.toLowerCase().startsWith('image/')) {
          setMailingImageError('В сохранённой рассылке отсутствует фото.');
          hasError = true;
        } else {
          setMailingImageError('');
        }
      } else {
        setMailingImageError('');
      }
    } else {
      setMailingTextError('');
      setMailingImageError('');
    }

    if (mailingButtonEnabled) {
      if (!isValidHttpUrl(normalizedButtonUrl)) {
        setMailingButtonUrlError('Укажите корректную ссылку (http/https).');
        hasError = true;
      } else {
        setMailingButtonUrlError('');
      }

      if (!normalizedButtonText || normalizedButtonText.length > 32) {
        setMailingButtonTextError('Введите название кнопки до 32 символов.');
        hasError = true;
      } else {
        setMailingButtonTextError('');
      }
    } else {
      setMailingButtonUrlError('');
      setMailingButtonTextError('');
    }

    if (scheduledSlots.length === 0) {
      setMailingScheduleError('Добавьте хотя бы один слот публикации.');
      hasError = true;
    } else if (mailingPlannerState.futureSlotCount === 0) {
      setMailingScheduleError('Добавьте хотя бы один будущий слот публикации.');
      hasError = true;
    } else {
      setMailingScheduleError('');
    }
    setMailingCycleError('');

    if (hasError) {
      return;
    }

    const handoffPayload: BroadcastHandoffPayload = {
      applyToAllChats: mailingApplyToAllChats && canApplyToAllChats,
      buttonEnabled: mailingButtonEnabled,
      buttonUrl: normalizedButtonUrl,
      buttonText: normalizedButtonText || 'Открыть',
      scheduleMode: 'calendar',
      scheduleTimezone,
      scheduledSlots,
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: scheduledSlots.length,
    };

    if (editingManagedBroadcast) {
      const payload: SendBroadcastPayload = {
        text: normalizedText,
        textFormat: 'markdown',
        ...handoffPayload,
        imageEnabled: mailingImageEnabled,
        imageBase64: mailingImageEnabled ? mailingImageBase64 : '',
        imageMimeType: mailingImageEnabled ? mailingImageMimeType : '',
        imageFileName: mailingImageEnabled ? mailingImageFileName : '',
      };
      updateManagedBroadcastMutation.mutate({
        broadcastId: editingManagedBroadcast.id,
        payload,
      });
      return;
    }

    handoffBroadcastMutation.mutate(handoffPayload);
  }

  function handleCommercialSensitivitySliderChange(rawValue: number) {
    if (!draft) {
      return;
    }

    const safeValue = clampCommercialSlider(rawValue);
    if (safeValue >= 70) {
      const strictProgress = (safeValue - 70) / 30;
      const warnThreshold = Math.round(44 - strictProgress * 6);
      const deleteThreshold = Math.max(warnThreshold + 8, Math.round(62 - strictProgress * 8));
      setFieldValue('commercialAdsSensitivity', 'STRICT');
      setFieldValue('commercialAdsWarnThreshold', warnThreshold);
      setFieldValue('commercialAdsDeleteThreshold', deleteThreshold);
      return;
    }

    const balancedProgress = safeValue / COMMERCIAL_BALANCED_MAX;
    const warnThreshold = Math.round(58 - balancedProgress * 13);
    const deleteThreshold = Math.max(warnThreshold + 10, Math.round(78 - balancedProgress * 13));
    setFieldValue('commercialAdsSensitivity', 'BALANCED');
    setFieldValue('commercialAdsWarnThreshold', warnThreshold);
    setFieldValue('commercialAdsDeleteThreshold', deleteThreshold);
  }

  function toggleHint(key: HintKey) {
    setOpenHintKey((current) => (current === key ? null : key));
  }

  function toggleBotMessageEditor(key: BotMessageEditorKey) {
    setOpenBotEditorKey((current) => (current === key ? null : key));
  }

  function toggleWarnMessageEditor(key: WarnMessageEditorKey) {
    setOpenWarnEditorKey((current) => (current === key ? null : key));
  }

  function closeSection(section: SettingsSectionKey) {
    if (
      (section === 'mailing' && focusSection === 'broadcast') ||
      (section === 'giveaway' && focusSection === 'giveaway') ||
      (section === 'requiredSubscription' && focusSection === 'requiredSubscription')
    ) {
      const nextSearchParams = new URLSearchParams(location.search);
      nextSearchParams.delete('focus');
      nextSearchParams.delete('handoff');
      navigate(
        {
          pathname: location.pathname,
          search: nextSearchParams.toString() ? `?${nextSearchParams.toString()}` : '',
        },
        { replace: true, state: location.state },
      );
    }

    setExpandedSections((current) => (current[section] ? INITIAL_EXPANDED_SECTIONS : current));
  }

  function toggleSection(section: SettingsSectionKey) {
    if (expandedSections[section]) {
      closeSection(section);
      return;
    }

    startTransition(() => {
      setExpandedSections({ ...INITIAL_EXPANDED_SECTIONS, [section]: true });
    });
  }

  if (!chatId) {
    return (
      <GlassCard>
        <StatusState
          tone="warning"
          title="Чат не выбран"
          description="Откройте экран настроек из карточки чата."
          action={
            <Link to={buildManagedEntitiesRoute('chat')} className="button button--accent">
              К списку чатов
            </Link>
          }
        />
      </GlassCard>
    );
  }

  const linkPolicyError = fieldErrors.linkPolicy;
  const requiredSubscriptionChannelsError = fieldErrors.requiredSubscriptionChannelIds;
  const allowlistEntries: DomainAllowlistEntry[] = domainsQuery.data ?? [];
  const allowlistDomains = allowlistEntries.map((entry) => entry.domain);
  const isDomainMutationPending =
    addDomainMutation.isPending ||
    removeDomainMutation.isPending ||
    scheduleDomainRemovalMutation.isPending;
  const isAllowlistMode = draft?.linkPolicy === 'ALLOWLIST_ONLY';
  const shouldShowLinkStages = draft?.linkPolicy !== 'ALERT_ONLY';
  const showLinkBotButtonErrors = Boolean(
    draft?.linkBotMessageEnabled && draft?.linkBotButtonEnabled,
  );
  const linkBotButtonUrlError = showLinkBotButtonErrors ? fieldErrors.linkBotButtonUrl : undefined;
  const linkBotButtonTextError = showLinkBotButtonErrors
    ? fieldErrors.linkBotButtonText
    : undefined;
  const hasLinkBotButtonError = Boolean(linkBotButtonUrlError || linkBotButtonTextError);
  const showGreetingBotButtonErrors = Boolean(
    draft?.greetingEnabled && draft?.greetingBotMessageEnabled && draft?.greetingBotButtonEnabled,
  );
  const greetingBotButtonUrlError = showGreetingBotButtonErrors
    ? fieldErrors.greetingBotButtonUrl
    : undefined;
  const greetingBotButtonTextError = showGreetingBotButtonErrors
    ? fieldErrors.greetingBotButtonText
    : undefined;
  const hasGreetingBotButtonError = Boolean(
    greetingBotButtonUrlError || greetingBotButtonTextError,
  );
  const showDuplicateBotButtonErrors = Boolean(
    draft?.duplicateBotMessageEnabled && draft?.duplicateBotButtonEnabled,
  );
  const duplicateBotButtonUrlError = showDuplicateBotButtonErrors
    ? fieldErrors.duplicateBotButtonUrl
    : undefined;
  const duplicateBotButtonTextError = showDuplicateBotButtonErrors
    ? fieldErrors.duplicateBotButtonText
    : undefined;
  const hasDuplicateBotButtonError = Boolean(
    duplicateBotButtonUrlError || duplicateBotButtonTextError,
  );
  const showMessageLimitsBotButtonErrors = Boolean(
    draft?.messageLimitsBotMessageEnabled && draft?.messageLimitsBotButtonEnabled,
  );
  const messageLimitsBotButtonUrlError = showMessageLimitsBotButtonErrors
    ? fieldErrors.messageLimitsBotButtonUrl
    : undefined;
  const messageLimitsBotButtonTextError = showMessageLimitsBotButtonErrors
    ? fieldErrors.messageLimitsBotButtonText
    : undefined;
  const hasMessageLimitsBotButtonError = Boolean(
    messageLimitsBotButtonUrlError || messageLimitsBotButtonTextError,
  );
  const showTextFiltersBotButtonErrors = Boolean(
    draft?.textFiltersBotMessageEnabled && draft?.textFiltersBotButtonEnabled,
  );
  const textFiltersBotButtonUrlError = showTextFiltersBotButtonErrors
    ? fieldErrors.textFiltersBotButtonUrl
    : undefined;
  const textFiltersBotButtonTextError = showTextFiltersBotButtonErrors
    ? fieldErrors.textFiltersBotButtonText
    : undefined;
  const hasTextFiltersBotButtonError = Boolean(
    textFiltersBotButtonUrlError || textFiltersBotButtonTextError,
  );
  const showThematicBotButtonErrors = Boolean(
    draft?.thematicFiltersBotMessageEnabled && draft?.thematicFiltersBotButtonEnabled,
  );
  const thematicBotButtonUrlError = showThematicBotButtonErrors
    ? fieldErrors.thematicFiltersBotButtonUrl
    : undefined;
  const thematicBotButtonTextError = showThematicBotButtonErrors
    ? fieldErrors.thematicFiltersBotButtonText
    : undefined;
  const hasThematicBotButtonError = Boolean(
    thematicBotButtonUrlError || thematicBotButtonTextError,
  );
  const thematicCodewordError = draft?.thematicCodewordEnabled
    ? fieldErrors.thematicCodeword
    : undefined;
  const showNightBotButtonErrors = Boolean(
    draft?.nightModeBotMessageEnabled && draft?.nightModeBotButtonEnabled,
  );
  const nightBotButtonUrlError = showNightBotButtonErrors
    ? fieldErrors.nightModeBotButtonUrl
    : undefined;
  const nightBotButtonTextError = showNightBotButtonErrors
    ? fieldErrors.nightModeBotButtonText
    : undefined;
  const hasNightBotButtonError = Boolean(nightBotButtonUrlError || nightBotButtonTextError);
  const nightTimezoneError = fieldErrors.nightModeTimezone;
  const showNightForceCloseDurationErrors = Boolean(
    draft?.nightModeForceCloseEnabled && !draft?.nightModeForceCloseForever,
  );
  const nightForceCloseHoursError = showNightForceCloseDurationErrors
    ? fieldErrors.nightModeForceCloseHours
    : undefined;
  const nightForceCloseDaysError = showNightForceCloseDurationErrors
    ? fieldErrors.nightModeForceCloseDays
    : undefined;
  const hasNightForceCloseDurationError = Boolean(
    nightForceCloseHoursError || nightForceCloseDaysError,
  );
  const linkStagesEnabledCount = [
    draft?.linkBotMessageEnabled,
    draft?.linkWarnEnabled,
    draft?.linkBanEnabled,
    draft?.linkKickEnabled,
  ].filter(Boolean).length;
  const linksHeaderSummary =
    draft?.linkPolicy === 'ALERT_ONLY'
      ? 'Ссылки не удаляются'
      : draft?.linkPolicy === 'ALLOWLIST_ONLY'
        ? `Разрешено: ${allowlistDomains.length}`
        : `${linkStagesEnabledCount}/4 ступени включено`;
  const linksCardStatus =
    draft?.linkPolicy === 'ALERT_ONLY'
      ? 'Мягко'
      : draft?.linkPolicy === 'ALLOWLIST_ONLY'
        ? 'Список'
        : 'Блок';
  const rulesPublishedAtLabel = formatRemovalDateTime(
    rulesDraft?.publishedAt ?? rulesQuery.data?.publishedAt ?? null,
  );
  const rulesHeaderSummary = hasPublishedRules
    ? rulesPublishedAtLabel
      ? `Опубликовано · ${rulesPublishedAtLabel}`
      : 'Опубликовано'
    : rulesDraft?.text.trim()
      ? `Черновик · ${rulesDraft.text.trim().length}/${MAX_CHAT_RULES_TEXT_LENGTH}`
      : 'Не настроено';
  const rulesCardStatus = hasPublishedRules
    ? 'Пост'
    : rulesDraft?.text.trim()
      ? 'Черновик'
      : 'Пусто';
  const greetingHeaderSummary = draft?.greetingEnabled
    ? draft?.greetingBotMessageEnabled
      ? draft?.greetingBotButtonEnabled
        ? 'Сообщение + кнопка'
        : 'Только сообщение'
      : 'Сообщение выключено'
    : 'Выключено';
  const greetingCardStatus = draft?.greetingEnabled ? 'Вкл' : 'Выкл';
  const duplicateStagesEnabledCount = [
    draft?.duplicateWarnEnabled,
    draft?.duplicateBanEnabled,
    draft?.duplicateKickEnabled,
  ].filter(Boolean).length;
  const duplicatesHeaderSummary = draft?.antiDuplicateEnabled
    ? `${duplicateStagesEnabledCount}/3 ступени включено`
    : 'Выключено';
  const duplicatesCardStatus = draft?.antiDuplicateEnabled
    ? `${duplicateStagesEnabledCount}/3`
    : 'Выкл';
  const profanityStagesEnabledCount = draft?.russianProfanityFilterEnabled
    ? [
        draft?.profanityBotMessageEnabled,
        draft?.profanityWarnEnabled,
        draft?.profanityBanEnabled,
        draft?.profanityKickEnabled,
      ].filter(Boolean).length
    : 0;
  const textFiltersStagesEnabledCount = draft?.commercialAdsFilterEnabled
    ? [
        draft?.textFiltersBotMessageEnabled,
        draft?.textFiltersWarnEnabled,
        draft?.textFiltersBanEnabled,
        draft?.textFiltersKickEnabled,
      ].filter(Boolean).length
    : 0;
  const thematicFiltersEnabledCount = draft?.thematicCodewordEnabled ? 1 : 0;
  const thematicFiltersStagesEnabledCount = thematicFiltersEnabledCount
    ? [
        draft?.thematicFiltersBotMessageEnabled,
        draft?.thematicFiltersWarnEnabled,
        draft?.thematicFiltersBanEnabled,
        draft?.thematicFiltersKickEnabled,
      ].filter(Boolean).length
    : 0;
  const commercialSensitivitySliderValue = draft
    ? inferCommercialSensitivitySliderValue(draft)
    : 50;
  const commercialSensitivityLabel = getCommercialSensitivityLabel(
    commercialSensitivitySliderValue,
  );
  const limitsRulesEnabledCount = [
    draft?.antiSpamEnabled,
    draft?.messageCountLimitEnabled,
    draft?.maxMessageLengthEnabled,
    draft?.photoMessageCooldownEnabled,
    draft?.stickerMessageCooldownEnabled,
    draft ? !draft.videoMessagesEnabled : false,
    draft ? !draft.fileMessagesEnabled : false,
    draft ? !draft.voiceMessagesEnabled : false,
  ].filter(Boolean).length;
  const nightTimezoneLabel =
    RUSSIAN_TIMEZONE_OPTIONS.find((option) => option.value === draft?.nightModeTimezone)?.label ??
    'Москва (UTC+3)';
  const nightWindowLabel = draft
    ? `${minutesToTimeInput(draft.nightModeStartTimeMinutes)}-${minutesToTimeInput(
        draft.nightModeEndTimeMinutes,
      )}`
    : '23:00-08:00';
  const nightForceCloseSummary = draft?.nightModeForceCloseEnabled
    ? draft.nightModeForceCloseForever
      ? 'Группа закрыта вручную бессрочно'
      : `Группа закрыта вручную на ${formatNightForceCloseDuration(
          draft.nightModeForceCloseDays,
          draft.nightModeForceCloseHours,
        )}`
    : null;
  const nightHeaderSummary = nightForceCloseSummary
    ? nightForceCloseSummary
    : draft?.nightModeEnabled
      ? `${nightWindowLabel} • ${nightTimezoneLabel}`
      : 'Выключено';
  const requiredSubscriptionSelectedCount = draft?.requiredSubscriptionChannelIds.length ?? 0;
  const requiredSubscriptionStaleCount = staleRequiredSubscriptionChannelIds.length;
  const requiredSubscriptionHeaderSummary = draft?.requiredSubscriptionEnabled
    ? requiredSubscriptionStaleCount > 0
      ? `Нужно исправить: ${requiredSubscriptionStaleCount} недоступен`
      : `${formatRequiredSubscriptionCount(requiredSubscriptionSelectedCount)} · сообщения без подписки удаляются`
    : 'Выключено';
  const requiredSubscriptionCardStatus = draft?.requiredSubscriptionEnabled
    ? requiredSubscriptionStaleCount > 0
      ? 'Ошибка'
      : formatRequiredSubscriptionCount(requiredSubscriptionSelectedCount)
    : 'Выкл';
  const profanityFilterHeaderSummary = draft?.russianProfanityFilterEnabled
    ? `${profanityStagesEnabledCount}/4 ступени включено`
    : 'Выключено';
  const profanityCardStatus = draft?.russianProfanityFilterEnabled
    ? `${profanityStagesEnabledCount}/4`
    : 'Выкл';
  const commercialFilterHeaderSummary = draft?.commercialAdsFilterEnabled
    ? `${textFiltersStagesEnabledCount}/4 ступени · ${commercialSensitivityLabel.toLowerCase()}`
    : 'Выключено';
  const commercialCardStatus = draft?.commercialAdsFilterEnabled
    ? commercialSensitivityLabel
    : 'Выкл';
  const thematicFiltersHeaderSummary = thematicFiltersEnabledCount
    ? `код: ${draft?.thematicCodeword?.trim() || 'не задан'} · ${thematicFiltersStagesEnabledCount}/4 ступени`
    : 'Выключено';
  const thematicFiltersCardStatus = thematicFiltersEnabledCount
    ? `${thematicFiltersStagesEnabledCount}/4`
    : 'Выкл';
  const extraEnabledCount = [
    draft?.deleteSpammersEnabled,
    draft?.deleteBotMessagesEnabled,
    draft?.removeBotsFromGroupEnabled,
  ].filter(Boolean).length;
  const extraHeaderSummary =
    extraEnabledCount > 0 ? `${extraEnabledCount} опции включено` : 'Выключено';
  const extraCardStatus = extraEnabledCount > 0 ? `${extraEnabledCount}` : 'Выкл';
  const limitsCardStatus = limitsRulesEnabledCount > 0 ? `${limitsRulesEnabledCount}` : 'Выкл';
  const nightCardStatus = draft?.nightModeForceCloseEnabled
    ? 'Закрыто'
    : draft?.nightModeEnabled
      ? 'Ночь'
      : 'Выкл';
  const chatsCount = chatsQuery.data?.length ?? 0;
  const canApplyToAllChats = chatsCount > 1;
  const managedBroadcasts = managedBroadcastsQuery.data ?? [];
  const mailingOccupiedSlots = managedBroadcasts
    .filter((broadcast) => broadcast.id !== editingManagedBroadcast?.id)
    .flatMap((broadcast) => broadcast.scheduledSlots);
  const isUpdatingManagedBroadcast = updateManagedBroadcastMutation.isPending;
  const isMailingBusy =
    handoffBroadcastMutation.isPending ||
    isUpdatingManagedBroadcast ||
    cancelManagedBroadcastMutation.isPending ||
    retryManagedBroadcastMutation.isPending;
  const mailingTargetLabel =
    mailingApplyToAllChats && canApplyToAllChats
      ? `Во все чаты (${chatsCount})`
      : 'Только текущий чат';
  const mailingDayCount = countBroadcastScheduleDays(mailingScheduledSlots);
  const mailingContentLabel = editingManagedBroadcast
    ? mailingImageEnabled && mailingImageBase64
      ? 'контент сохранён'
      : mailingText.trim()
        ? 'контент сохранён'
        : 'без контента'
    : mailingBotHasContent
      ? 'контент уже в боте'
      : 'контент в боте';
  const mailingHeaderSummary = `${mailingTargetLabel} · ${mailingContentLabel} · ${mailingDayCount} дн. · ${mailingScheduledSlots.length} слота`;
  const mailingCardStatus = editingManagedBroadcast
    ? 'План'
    : mailingScheduledSlots.length > 0
      ? 'Календ'
      : mailingApplyToAllChats && canApplyToAllChats
        ? 'Все'
        : 'Бот';
  const normalizedMailingButtonUrl = mailingButtonUrl.trim();
  const normalizedMailingButtonText = mailingButtonText.trim();
  const mailingButtonDraftValid =
    !mailingButtonEnabled ||
    (isValidHttpUrl(normalizedMailingButtonUrl) &&
      normalizedMailingButtonText.length > 0 &&
      normalizedMailingButtonText.length <= 32);
  const mailingPlannerPending =
    mailingPlannerState.pickedDayCount > 0 || mailingPlannerState.isDaySheetOpen;
  const mailingScheduleReady = mailingScheduledSlots.length > 0 && !mailingPlannerPending;
  const mailingHasFutureSlots = mailingPlannerState.futureSlotCount > 0;
  const showMailingPrimaryAction =
    isMailingBusy ||
    (mailingScheduleReady &&
      mailingButtonDraftValid &&
      mailingPlannerState.isConfirmed &&
      mailingHasFutureSlots);
  const showMailingInlineReset =
    editingManagedBroadcast !== null ||
    mailingScheduledSlots.length > 0 ||
    mailingText.trim().length > 0 ||
    mailingImageEnabled ||
    mailingButtonEnabled;
  const mailingSendDisabled = isMailingBusy;
  const mailingDrilldownFooter = (
    <>
      <p className="settings-drilldown__footer-note">
        {editingManagedBroadcast
          ? 'Сохраним обновлённый календарь и CTA прямо здесь.'
          : 'В боте останется только подтверждение отправки.'}
      </p>
      <div className="settings-drilldown__footer-actions is-single-action">
        <button
          type="button"
          className="button button--accent"
          onClick={handleSendBroadcast}
          disabled={mailingSendDisabled}
        >
          {isUpdatingManagedBroadcast
            ? 'Сохраняем...'
            : handoffBroadcastMutation.isPending
              ? 'Передаём в бота...'
              : editingManagedBroadcast
                ? 'Сохранить рассылку'
                : 'Передать в бота'}
        </button>
      </div>
    </>
  );

  useHintPopoverAutoPosition(openHintKey !== null);

  function resetMailingPlanner() {
    setMailingPlannerState(EMPTY_BROADCAST_PLANNER_STATE);
    setMailingPlannerResetKey((current) => current + 1);
  }

  function isSectionDirty(section: ApplySectionKey) {
    if (!draft || !settingsQuery.data) {
      return false;
    }

    const savedSettings = settingsQuery.data;
    return SECTION_SETTING_KEYS[section].some((key) => draft[key] !== savedSettings[key]);
  }

  function buildSectionPayload(section: ApplySectionKey) {
    if (!draft || !settingsQuery.data) {
      return null;
    }

    return validateDraft(mergeSectionSettings(settingsQuery.data, draft, section));
  }

  function buildBotSpeechStylePayload(style: BotSpeechStyle) {
    if (!settingsQuery.data) {
      return null;
    }

    return validateDraft(applyBotSpeechStylePreset(settingsQuery.data, style));
  }

  async function handleSaveSection(section: ApplySectionKey) {
    if (!chatId) {
      return;
    }

    if (!isSectionDirty(section)) {
      closeSection(section);
      return;
    }

    const payload = buildSectionPayload(section);
    if (!payload) {
      pushToast({
        tone: 'danger',
        title: `Исправьте блок «${SECTION_LABELS[section]}»`,
        description: 'В блоке есть ошибки, их нужно исправить перед сохранением.',
      });
      return;
    }

    try {
      await mutateSettingsAsync({ section, payload });
      closeSection(section);
    } catch {
      // Errors are handled by the mutation.
    }
  }

  async function handleSaveSectionToAllChats(section: ApplySectionKey) {
    if (!chatId || !draft) {
      return;
    }

    if (!canApplyToAllChats) {
      pushToast({
        title: 'Нет других чатов для применения',
        description: 'Откройте миниапп в другом чате, чтобы добавить его в список.',
      });
      return;
    }

    const payload = buildSectionPayload(section);
    if (!payload) {
      pushToast({
        tone: 'danger',
        title: `Исправьте блок «${SECTION_LABELS[section]}»`,
        description: 'В блоке есть ошибки, их нужно исправить перед сохранением.',
      });
      return;
    }

    try {
      await applySectionToAllMutation.mutateAsync({
        section,
        sourceSettings: payload,
      });
      closeSection(section);
    } catch {
      // Errors are handled by the mutation.
    }
  }

  async function handleApplyBotSpeechStyle(style: BotSpeechStyle) {
    if (!chatId) {
      return;
    }

    const payload = buildBotSpeechStylePayload(style);
    if (!payload) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить стиль речи',
        description: 'Проверьте настройки и повторите попытку.',
      });
      return;
    }

    try {
      await saveSpeechStyleMutation.mutateAsync({ style, payload });
    } catch {
      // Errors are handled by the mutation.
    }
  }

  function renderSectionSaveFooter(
    section: ApplySectionKey,
    options?: {
      note?: string;
      saveLabel?: string;
      applyToAllLabel?: string;
      emphasize?: 'save' | 'apply';
    },
  ) {
    const isCurrentSectionSaving = isSavingSettings && savingSection === section;
    const isCurrentSectionApplying = isApplyingSectionToAll && applyingSection === section;
    const emphasize = options?.emphasize ?? 'apply';
    const saveButtonClassName =
      emphasize === 'save' ? 'button button--accent' : 'button button--ghost';
    const applyToAllButtonClassName =
      emphasize === 'save' ? 'button button--ghost' : 'button button--accent';
    const footerNote =
      options?.note ??
      (canApplyToAllChats
        ? 'Сохраняется только текущий блок. При необходимости его можно сразу применить во все чаты.'
        : 'Пока доступен только текущий чат. Для массового применения нужен хотя бы ещё один чат.');

    return (
      <>
        <p className="settings-drilldown__footer-note">{footerNote}</p>
        <div className="settings-drilldown__footer-actions">
          <button
            type="button"
            className={saveButtonClassName}
            onClick={() => void handleSaveSection(section)}
            disabled={
              isCurrentSectionSaving || isCurrentSectionApplying || !isSectionDirty(section)
            }
          >
            {isCurrentSectionSaving ? 'Сохраняем...' : (options?.saveLabel ?? 'Сохранить')}
          </button>
          <button
            type="button"
            className={applyToAllButtonClassName}
            onClick={() => void handleSaveSectionToAllChats(section)}
            disabled={isCurrentSectionSaving || isCurrentSectionApplying || !canApplyToAllChats}
          >
            {isCurrentSectionApplying
              ? 'Сохраняем...'
              : (options?.applyToAllLabel ?? 'Сохранить во всех чатах')}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="page-stack page-enter">
      {settingsQuery.isLoading ? (
        <section className="settings-sections" aria-label="Загрузка настроек">
          <GlassCard className="settings-section">
            <SkeletonCard lines={5} />
          </GlassCard>
        </section>
      ) : null}

      {settingsQuery.error ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Ошибка загрузки настроек"
            description={formatApiError(settingsQuery.error)}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => void settingsQuery.refetch()}
              >
                Повторить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {!settingsQuery.isLoading && !settingsQuery.error && draft ? (
        <section className="settings-sections" aria-label="Настройки модерации">
          <CompactStickyHeader
            backTo={buildManagedEntitiesRoute('chat')}
            backLabel="Назад к чатам"
            title={chatTitle || chatId || 'Настройки'}
            compact={isHeaderCompact}
            hidden={isHeaderHidden}
            className="settings-sections__sticky-header stagger-in"
            aside={
              showHeaderStatus ? (
                <span
                  className={cn(
                    'compact-page-header__status',
                    isHeaderSaving
                      ? 'compact-page-header__status--saving'
                      : 'compact-page-header__status--draft',
                  )}
                  aria-label={
                    isHeaderSaving ? 'Сохраняем изменения' : 'Есть несохранённые изменения'
                  }
                  title={isHeaderSaving ? 'Сохраняем изменения' : 'Есть несохранённые изменения'}
                >
                  {compactHeaderStatusLabel}
                </span>
              ) : null
            }
          />

          <GlassCard className="settings-speech-style-card stagger-in">
            <div className="settings-speech-style-card__head">
              <h3 className="settings-speech-style-card__title">Стиль речи</h3>
            </div>

            <div className="settings-speech-style-grid" role="group" aria-label="Стили речи бота">
              {BOT_SPEECH_STYLE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    'settings-speech-style-option',
                    activeSpeechStyle === option.value && 'is-active',
                  )}
                  onClick={() => setPendingSpeechStyle(option.value)}
                  disabled={isSavingSpeechStyle}
                  aria-label={option.label}
                >
                  {activeSpeechStyle === option.value ? (
                    <span className="settings-speech-style-option__badge" aria-hidden>
                      <StyleSelectedIcon />
                    </span>
                  ) : null}
                  <span className="settings-speech-style-option__icon" aria-hidden>
                    <BotSpeechStyleIcon iconKey={option.iconKey} />
                  </span>
                  <span className="settings-speech-style-option__label">
                    {BOT_SPEECH_STYLE_SELECTOR_LABELS[option.value]}
                  </span>
                </button>
              ))}
            </div>

            {!activeSpeechStyle ? (
              <div className="settings-speech-style-card__status">
                <span className="chip">
                  {hasSpeechOverrides ? 'Свои тексты' : 'Стиль не выбран'}
                </span>
              </div>
            ) : null}
          </GlassCard>

          <SettingsDrilldownPanel
            id="settings-bot-speech-style"
            open={pendingSpeechStyle !== null}
            title={pendingSpeechStyleMeta?.label ?? 'Стиль речи'}
            onClose={() => {
              if (!isSavingSpeechStyle) {
                setPendingSpeechStyle(null);
              }
            }}
            footer={
              pendingSpeechStyle ? (
                <div className="settings-drilldown__footer-actions">
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setPendingSpeechStyle(null)}
                    disabled={isSavingSpeechStyle}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="button button--accent"
                    onClick={() => void handleApplyBotSpeechStyle(pendingSpeechStyle)}
                    disabled={isSavingSpeechStyle}
                  >
                    {isSavingSpeechStyle ? 'Применяем...' : 'Применить стиль'}
                  </button>
                </div>
              ) : null
            }
          >
            {pendingSpeechStyleMeta && pendingSpeechStyleSamples ? (
              <div className="settings-speech-preview">
                <div
                  className="settings-subsection-divider"
                  role="separator"
                  aria-label="Приветствие"
                >
                  <span>Приветствие</span>
                </div>

                <div className="settings-native-toggle">
                  <div className="settings-native-toggle__row">
                    <span className="settings-native-toggle__title">Новые участники</span>
                  </div>
                  <p className="settings-native-toggle__hint">
                    {pendingSpeechStyleSamples.greeting}
                  </p>
                </div>

                <div
                  className="settings-subsection-divider"
                  role="separator"
                  aria-label="Стандартные действия бота"
                >
                  <span>Стандартные действия бота</span>
                </div>

                <div className="settings-native-toggle">
                  <div className="settings-native-toggle__row">
                    <span className="settings-native-toggle__title">1. Объяснение</span>
                  </div>
                  <p className="settings-native-toggle__hint">
                    {pendingSpeechStyleSamples.explanation}
                  </p>
                </div>

                <div className="settings-native-toggle settings-native-toggle--nested">
                  <div className="settings-native-toggle__row">
                    <span className="settings-native-toggle__title">2. Предупреждение</span>
                  </div>
                  <p className="settings-native-toggle__hint">
                    {pendingSpeechStyleSamples.warning}
                  </p>
                </div>

                <div className="settings-native-toggle settings-native-toggle--nested">
                  <div className="settings-native-toggle__row">
                    <span className="settings-native-toggle__title">3. Бан на 24ч</span>
                  </div>
                  <p className="settings-native-toggle__hint">{pendingSpeechStyleSamples.ban}</p>
                </div>

                <div className="settings-native-toggle settings-native-toggle--nested">
                  <div className="settings-native-toggle__row">
                    <span className="settings-native-toggle__title">4. Удаление из группы</span>
                  </div>
                  <p className="settings-native-toggle__hint">{pendingSpeechStyleSamples.kick}</p>
                </div>
              </div>
            ) : null}
          </SettingsDrilldownPanel>

          <div className="settings-sections-shell">
            <GlassCard className="settings-section stagger-in">
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Ссылки"
                  summary={linksHeaderSummary}
                  status={linksCardStatus}
                  icon="links"
                  tone="sky"
                  open={expandedSections.links}
                  controls="settings-links-content"
                  onClick={() => toggleSection('links')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-links-content"
                open={expandedSections.links}
                title="Ссылки"
                summary={linksHeaderSummary}
                onClose={() => toggleSection('links')}
                footer={renderSectionSaveFooter('links')}
              >
                <div
                  id="settings-links-content"
                  className={cn('settings-section__collapse', expandedSections.links && 'is-open')}
                >
                  {expandedSections.links ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-grid settings-grid--single">
                        <div className={cn('settings-policy', linkPolicyError && 'field--error')}>
                          <span className="field__label">Режим</span>
                          <div
                            className={cn('policy-grid', linkPolicyError && 'policy-grid--error')}
                            role="radiogroup"
                            aria-label="Режим модерации ссылок"
                          >
                            {LINK_POLICY_OPTIONS.map((option) => {
                              const isActive = draft.linkPolicy === option.value;

                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  role="radio"
                                  aria-checked={isActive}
                                  className={cn(
                                    'policy-card',
                                    option.value === 'ALERT_ONLY' && 'policy-card--alert',
                                    option.value === 'ALLOWLIST_ONLY' && 'policy-card--allowlist',
                                    option.value === 'BLOCKLIST_ONLY' && 'policy-card--blocklist',
                                    isActive && 'is-active',
                                  )}
                                  onClick={() => setFieldValue('linkPolicy', option.value)}
                                >
                                  <span className="policy-card__title-row">
                                    <span className="policy-card__marker" aria-hidden />
                                    <span>{option.label}</span>
                                  </span>
                                  <small>{option.description}</small>
                                </button>
                              );
                            })}
                          </div>
                          {linkPolicyError ? (
                            <small className="field__hint">{linkPolicyError}</small>
                          ) : null}
                        </div>

                        {isAllowlistMode ? (
                          <div className="allowlist-drawer">
                            <div className="allowlist-drawer__inner">
                              <div
                                className={cn(
                                  'field',
                                  'allowlist-panel',
                                  domainInputError && 'allowlist-panel--error',
                                )}
                              >
                                <div className="allowlist-panel__handle" aria-hidden />

                                <div className="allowlist-panel__head">
                                  <span className="field__label">Разрешенные ссылки</span>
                                  <span className="chip">{allowlistDomains.length}</span>
                                </div>

                                <p className="allowlist-panel__subtitle">
                                  Добавьте точную ссылку. Разрешается только полное совпадение.
                                </p>

                                <div className="allowlist-add-row">
                                  <input
                                    type="text"
                                    inputMode="url"
                                    value={domainInput}
                                    onChange={(event) => {
                                      setDomainInput(event.target.value);
                                      setDomainInputError('');
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault();
                                        handleAddDomain();
                                      }
                                    }}
                                    placeholder="https://example.com/path"
                                  />
                                  <button
                                    type="button"
                                    className="button button--accent allowlist-add-row__button"
                                    onClick={handleAddDomain}
                                    disabled={isDomainMutationPending}
                                  >
                                    {addDomainMutation.isPending ? 'Добавляем...' : 'Добавить'}
                                  </button>
                                </div>

                                {domainInputError ? (
                                  <small className="field__hint">{domainInputError}</small>
                                ) : null}

                                {domainsQuery.isLoading ? (
                                  <p className="allowlist-empty">Загрузка списка...</p>
                                ) : null}

                                {domainsQuery.error ? (
                                  <p className="allowlist-empty allowlist-empty--error">
                                    Ошибка: {formatApiError(domainsQuery.error)}
                                  </p>
                                ) : null}

                                {!domainsQuery.isLoading && !domainsQuery.error ? (
                                  allowlistEntries.length > 0 ? (
                                    <ul className="allowlist-list" aria-label="Разрешенные ссылки">
                                      {allowlistEntries.map((entry) => {
                                        const isScheduleOpen = scheduleDomain === entry.domain;
                                        const scheduledAtLabel = formatRemovalDateTime(
                                          entry.removeAfterAt,
                                        );
                                        const entryIdSuffix = encodeURIComponent(entry.domain);

                                        return (
                                          <li
                                            key={entry.domain}
                                            className={cn(
                                              'allowlist-item',
                                              'allowlist-item--domain',
                                            )}
                                          >
                                            <div className="allowlist-item__stack">
                                              <div className="allowlist-item__top-row">
                                                <div className="allowlist-item__title-wrap">
                                                  <span
                                                    className="allowlist-item__domain"
                                                    title={entry.domain}
                                                  >
                                                    {entry.domain}
                                                  </span>
                                                  {scheduledAtLabel ? (
                                                    <small className="allowlist-item__meta">
                                                      Удаление: {scheduledAtLabel}
                                                    </small>
                                                  ) : null}
                                                </div>

                                                <div className="allowlist-item__actions">
                                                  <button
                                                    type="button"
                                                    className="allowlist-item__remove"
                                                    onClick={() =>
                                                      removeDomainMutation.mutate(entry.domain)
                                                    }
                                                    disabled={isDomainMutationPending}
                                                    aria-label={`Удалить ${entry.domain} из разрешенных ссылок`}
                                                    title="Удалить ссылку"
                                                  >
                                                    <TrashIcon />
                                                    <span>Удалить</span>
                                                  </button>
                                                  <button
                                                    type="button"
                                                    className={cn(
                                                      'allowlist-item__schedule',
                                                      isScheduleOpen && 'is-open',
                                                    )}
                                                    aria-label={`Запланировать удаление ${entry.domain}`}
                                                    title="Запланировать удаление"
                                                    onClick={() =>
                                                      toggleDomainScheduleEditor(entry)
                                                    }
                                                    disabled={isDomainMutationPending}
                                                  >
                                                    <CalendarIcon />
                                                  </button>
                                                </div>
                                              </div>

                                              {isScheduleOpen ? (
                                                <div
                                                  className="allowlist-item__schedule-editor"
                                                  role="group"
                                                  aria-label={`План удаления ${entry.domain}`}
                                                >
                                                  <div className="allowlist-item__schedule-fields">
                                                    <label
                                                      className="field allowlist-item__schedule-field"
                                                      htmlFor={`domain-schedule-date-${entryIdSuffix}`}
                                                    >
                                                      <span className="field__label">
                                                        День удаления
                                                      </span>
                                                      <input
                                                        id={`domain-schedule-date-${entryIdSuffix}`}
                                                        type="date"
                                                        value={scheduleDate}
                                                        min={toLocalDateInputValue(new Date())}
                                                        onChange={(event) => {
                                                          setScheduleDate(event.target.value);
                                                          setScheduleError('');
                                                        }}
                                                      />
                                                    </label>
                                                    <label
                                                      className="field allowlist-item__schedule-field"
                                                      htmlFor={`domain-schedule-time-${entryIdSuffix}`}
                                                    >
                                                      <span className="field__label">
                                                        Время удаления
                                                      </span>
                                                      <input
                                                        id={`domain-schedule-time-${entryIdSuffix}`}
                                                        type="time"
                                                        value={scheduleTime}
                                                        onChange={(event) => {
                                                          setScheduleTime(event.target.value);
                                                          setScheduleError('');
                                                        }}
                                                      />
                                                    </label>
                                                  </div>

                                                  {scheduleError ? (
                                                    <small className="field__hint">
                                                      {scheduleError}
                                                    </small>
                                                  ) : null}

                                                  <div className="allowlist-item__schedule-actions">
                                                    <button
                                                      type="button"
                                                      className="button button--accent"
                                                      onClick={() =>
                                                        submitDomainSchedule(entry.domain)
                                                      }
                                                      disabled={isDomainMutationPending}
                                                    >
                                                      {scheduleDomainRemovalMutation.isPending
                                                        ? 'Сохраняем...'
                                                        : 'Сохранить'}
                                                    </button>
                                                    {entry.removeAfterAt ? (
                                                      <button
                                                        type="button"
                                                        className="button button--ghost"
                                                        onClick={() =>
                                                          clearDomainSchedule(entry.domain)
                                                        }
                                                        disabled={isDomainMutationPending}
                                                      >
                                                        Убрать таймер
                                                      </button>
                                                    ) : null}
                                                  </div>
                                                </div>
                                              ) : null}
                                            </div>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  ) : (
                                    <p className="allowlist-empty">Список пуст</p>
                                  )
                                ) : null}
                              </div>
                            </div>
                          </div>
                        ) : null}

                        {shouldShowLinkStages ? (
                          <>
                            <div
                              className="settings-subsection-divider"
                              role="separator"
                              aria-label="Блок действий бота"
                            >
                              <span>Действия бота</span>
                            </div>

                            <div className="settings-native-toggle">
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    1. Объяснение
                                  </span>
                                  <div className="settings-native-toggle__title-actions">
                                    <EditToggleButton
                                      label="Редактировать текст сообщения о ссылках"
                                      onClick={() => toggleBotMessageEditor('link')}
                                      disabled={!draft.linkBotMessageEnabled}
                                      isOpen={openBotEditorKey === 'link'}
                                    />
                                    <button
                                      type="button"
                                      className={cn(
                                        'settings-info-button',
                                        openHintKey === 'linkBotMessage' && 'is-open',
                                      )}
                                      aria-label="Пояснение для тумблера сообщений о ссылках"
                                      aria-controls="link-bot-message-hint"
                                      aria-expanded={openHintKey === 'linkBotMessage'}
                                      onClick={() => toggleHint('linkBotMessage')}
                                    >
                                      <span aria-hidden>i</span>
                                    </button>
                                  </div>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить объяснение для модерации ссылок"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.linkBotMessageEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('linkBotMessageEnabled', enabled);
                                      if (!enabled) {
                                        setFieldValue('linkBotButtonEnabled', false);
                                        clearFieldError('linkBotButtonUrl');
                                        clearFieldError('linkBotButtonText');
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {openHintKey === 'linkBotMessage' ? (
                                <p
                                  id="link-bot-message-hint"
                                  className="settings-native-toggle__hint"
                                >
                                  Санкции усиливаются по ступеням, если пользователь повторно
                                  отправляет ссылки в течение 24 часов: сначала объяснение, затем
                                  предупреждение, потом бан на 6 часов и далее удаление из группы.
                                </p>
                              ) : null}

                              {draft.linkBotMessageEnabled && openBotEditorKey === 'link' ? (
                                <BotMessageEditor
                                  editorKey="link"
                                  botSpeechStyle={draft.botSpeechStyle}
                                  value={draft.linkBotMessageText}
                                  onChange={(nextValue) =>
                                    setFieldValue(
                                      'linkBotMessageText',
                                      nextValue as ChatSettings['linkBotMessageText'],
                                    )
                                  }
                                  onReset={() => setFieldValue('linkBotMessageText', '')}
                                />
                              ) : null}
                            </div>

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    2. Предупреждение
                                  </span>
                                  <div className="settings-native-toggle__title-actions">
                                    <EditToggleButton
                                      label="Редактировать текст предупреждения за ссылки"
                                      onClick={() => toggleWarnMessageEditor('linkWarn')}
                                      isOpen={openWarnEditorKey === 'linkWarn'}
                                    />
                                    <button
                                      type="button"
                                      className={cn(
                                        'settings-info-button',
                                        openHintKey === 'linkWarnMessage' && 'is-open',
                                      )}
                                      aria-label="Пояснение для предупреждения за ссылки"
                                      aria-controls="link-warn-message-hint"
                                      aria-expanded={openHintKey === 'linkWarnMessage'}
                                      onClick={() => toggleHint('linkWarnMessage')}
                                    >
                                      <span aria-hidden>i</span>
                                    </button>
                                  </div>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить предупреждение за вторую ссылку в 24 часа"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.linkWarnEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('linkWarnEnabled', enabled);
                                      if (enabled) {
                                        setFieldValue('linkBotMessageEnabled', true);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {openHintKey === 'linkWarnMessage' ? (
                                <p
                                  id="link-warn-message-hint"
                                  className="settings-native-toggle__hint"
                                >
                                  Текст отправляется при 2-й ссылке за 24 часа, если ступень
                                  включена.
                                </p>
                              ) : null}

                              {openWarnEditorKey === 'linkWarn' ? (
                                <WarnMessageEditor
                                  editorKey="linkWarn"
                                  botSpeechStyle={draft.botSpeechStyle}
                                  value={draft.linkWarnMessageText}
                                  onChange={(nextValue) =>
                                    setFieldValue(
                                      'linkWarnMessageText',
                                      nextValue as ChatSettings['linkWarnMessageText'],
                                    )
                                  }
                                  onReset={() => setFieldValue('linkWarnMessageText', '')}
                                />
                              ) : null}
                            </div>

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">3. Бан на 6ч</span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить бан на шесть часов за третью ссылку в 24 часа"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.linkBanEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('linkBanEnabled', enabled);
                                      if (enabled) {
                                        setFieldValue('linkWarnEnabled', true);
                                        setFieldValue('linkBotMessageEnabled', true);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">
                                  4. Удаление из группы
                                </span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить удаление из группы за четвертую ссылку в 24 часа"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.linkKickEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('linkKickEnabled', enabled);
                                      if (enabled) {
                                        setFieldValue('linkWarnEnabled', true);
                                        setFieldValue('linkBotMessageEnabled', true);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>

                            {draft.linkBotMessageEnabled ? (
                              <div
                                className={cn(
                                  'settings-native-toggle',
                                  'settings-native-toggle--nested',
                                  hasLinkBotButtonError && 'field--error',
                                )}
                              >
                                <div className="settings-native-toggle__row">
                                  <div className="settings-native-toggle__title-wrap">
                                    <span className="settings-native-toggle__title">
                                      Добавить кнопку
                                    </span>
                                    <button
                                      type="button"
                                      className={cn(
                                        'settings-info-button',
                                        openHintKey === 'linkBotButton' && 'is-open',
                                      )}
                                      aria-label="Пояснение для кнопки в сообщении о ссылках"
                                      aria-controls="link-bot-button-hint"
                                      aria-expanded={openHintKey === 'linkBotButton'}
                                      onClick={() => toggleHint('linkBotButton')}
                                    >
                                      <span aria-hidden>i</span>
                                    </button>
                                  </div>

                                  <label
                                    className="settings-native-switch"
                                    aria-label="Добавить кнопку в сообщение бота для модерации ссылок"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={draft.linkBotButtonEnabled}
                                      onChange={(event) => {
                                        const enabled = event.target.checked;
                                        setFieldValue('linkBotButtonEnabled', enabled);
                                        if (!enabled) {
                                          clearFieldError('linkBotButtonUrl');
                                          clearFieldError('linkBotButtonText');
                                        }
                                      }}
                                    />
                                    <span className="toggle-switch" aria-hidden>
                                      <span className="toggle-switch__thumb" />
                                    </span>
                                  </label>
                                </div>

                                {draft.linkBotButtonEnabled ? (
                                  <div className="settings-button-fields">
                                    <label
                                      className={cn(
                                        'field settings-url-field',
                                        linkBotButtonUrlError && 'field--error',
                                      )}
                                    >
                                      <span className="field__label">Ссылка кнопки</span>
                                      <input
                                        type="url"
                                        inputMode="url"
                                        value={draft.linkBotButtonUrl}
                                        onChange={(event) =>
                                          setFieldValue('linkBotButtonUrl', event.target.value)
                                        }
                                        placeholder="https://max.ru/channel/..."
                                      />
                                      {linkBotButtonUrlError ? (
                                        <small className="field__hint">
                                          {linkBotButtonUrlError}
                                        </small>
                                      ) : null}
                                    </label>

                                    <label
                                      className={cn(
                                        'field settings-text-field',
                                        linkBotButtonTextError && 'field--error',
                                      )}
                                    >
                                      <span className="field__label">Название кнопки</span>
                                      <input
                                        type="text"
                                        maxLength={32}
                                        value={draft.linkBotButtonText}
                                        onChange={(event) =>
                                          setFieldValue('linkBotButtonText', event.target.value)
                                        }
                                        placeholder="Открыть"
                                      />
                                      {linkBotButtonTextError ? (
                                        <small className="field__hint">
                                          {linkBotButtonTextError}
                                        </small>
                                      ) : null}
                                    </label>
                                  </div>
                                ) : null}

                                {!hasLinkBotButtonError && openHintKey === 'linkBotButton' ? (
                                  <p
                                    id="link-bot-button-hint"
                                    className="settings-native-toggle__hint"
                                  >
                                    Добавляет кнопку в сообщение бота. Подходит для ссылки на чат,
                                    канал или профиль.
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="policy-mode-hint" role="note">
                            Режим без удаления включен: тумблеры санкций скрыты.
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '45ms' }}
              aria-label="Правила"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Правила"
                  summary={rulesHeaderSummary}
                  status={rulesCardStatus}
                  icon="rules"
                  tone="ink"
                  open={expandedSections.rules}
                  controls="settings-rules-content"
                  onClick={() => toggleSection('rules')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-rules-content"
                open={expandedSections.rules}
                title="Правила"
                summary={rulesHeaderSummary}
                onClose={() => toggleSection('rules')}
              >
                <div
                  id="settings-rules-content"
                  className={cn('settings-section__collapse', expandedSections.rules && 'is-open')}
                >
                  {expandedSections.rules ? (
                    <div className="settings-section__collapse-inner">
                      <div className="rules-panel">
                        {rulesQuery.isLoading ? (
                          <p className="allowlist-empty">Загрузка правил...</p>
                        ) : null}

                        {rulesQuery.error ? (
                          <p className="allowlist-empty allowlist-empty--error">
                            Ошибка: {formatApiError(rulesQuery.error)}
                          </p>
                        ) : null}

                        {!rulesQuery.isLoading && !rulesQuery.error && rulesDraft ? (
                          <>
                            <div className="rules-panel__header">
                              <div className="rules-panel__title-wrap">
                                <h4>Пост с правилами</h4>
                              </div>
                              <span
                                className={cn(
                                  'chip',
                                  hasPublishedRules
                                    ? 'chip--success'
                                    : rulesDraft.text.trim()
                                      ? 'chip--warning'
                                      : undefined,
                                )}
                              >
                                {hasPublishedRules
                                  ? 'Опубликовано'
                                  : rulesDraft.text.trim()
                                    ? 'Черновик'
                                    : 'Пусто'}
                              </span>
                            </div>

                            <div className="rules-link-row">
                              <span>
                                {hasPublishedRules
                                  ? rulesPublishedAtLabel
                                    ? `Опубликовано · ${rulesPublishedAtLabel}`
                                    : 'Опубликовано'
                                  : 'Черновик не опубликован'}
                              </span>
                              <div className="rules-link-row__actions">
                                {rulesPublishedUrl ? (
                                  <a
                                    href={rulesPublishedUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="rules-published-link"
                                  >
                                    Открыть пост
                                  </a>
                                ) : null}
                                {hasPublishedRules ? (
                                  <button
                                    type="button"
                                    className="button button--ghost rules-link-row__reset"
                                    onClick={handleResetPublishedRules}
                                    disabled={isResettingPublishedRules}
                                  >
                                    {isResettingPublishedRules ? 'Сбрасываем...' : 'Сбросить'}
                                  </button>
                                ) : null}
                              </div>
                            </div>

                            {draft ? (
                              <div className="settings-native-toggle">
                                <div className="settings-native-toggle__row">
                                  <span className="settings-native-toggle__title">
                                    Показывать кнопку «Правила» в сообщениях о нарушениях
                                  </span>

                                  <label
                                    className="settings-native-switch"
                                    aria-label="Показывать кнопку Правила в сообщениях о нарушениях"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={draft.rulesAttachViolationsEnabled}
                                      onChange={(event) =>
                                        setFieldValue(
                                          'rulesAttachViolationsEnabled',
                                          event.target.checked,
                                        )
                                      }
                                    />
                                    <span className="toggle-switch" aria-hidden>
                                      <span className="toggle-switch__thumb" />
                                    </span>
                                  </label>
                                </div>
                                {!hasPublishedRules ? (
                                  <p className="settings-native-toggle__hint">
                                    Кнопка начнет показываться после публикации правил.
                                  </p>
                                ) : null}
                              </div>
                            ) : null}

                            <div
                              className={cn(
                                'field settings-text-field mailing-message-field',
                                'rules-editor-field',
                                rulesTextError && 'field--error',
                              )}
                            >
                              <div className="mailing-message-field__meta rules-editor-field__meta">
                                <span className="rules-editor-field__title-group">
                                  <label className="field__label" htmlFor="rules-text">
                                    Текст правил
                                  </label>
                                  <span className="chip">
                                    {rulesDraft.text.length}/{MAX_CHAT_RULES_TEXT_LENGTH}
                                  </span>
                                </span>
                                <div className="rules-editor-field__meta-actions">
                                  <label className="rules-inline-toggle">
                                    <span className="rules-inline-toggle__label">
                                      Заполнить по настройкам
                                    </span>
                                    <span
                                      className="settings-native-switch"
                                      aria-label="Заполнить текст правил по настройкам"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={rulesAutoFillEnabled}
                                        onChange={(event) =>
                                          handleRulesAutoTextToggle(event.target.checked)
                                        }
                                      />
                                      <span className="toggle-switch" aria-hidden>
                                        <span className="toggle-switch__thumb" />
                                      </span>
                                    </span>
                                  </label>
                                </div>
                              </div>
                              <textarea
                                id="rules-text"
                                rows={7}
                                value={rulesDraft.text}
                                onChange={(event) => setRulesFieldValue('text', event.target.value)}
                                placeholder="Правила чата"
                              />
                              {rulesTextError ? (
                                <small className="field__hint">{rulesTextError}</small>
                              ) : rulesAutoFillEnabled ? (
                                <small className="field__hint rules-editor-field__hint">
                                  Текст уже подставлен по текущим настройкам. Дальше его можно
                                  редактировать вручную.
                                </small>
                              ) : null}
                            </div>

                            <div
                              className={cn(
                                'rules-media-card',
                                Boolean(rulesDraft.imageBase64) && 'is-enabled',
                                rulesImageError && 'field--error',
                              )}
                            >
                              <div className="rules-media-card__head">
                                <div className="rules-media-card__title-wrap">
                                  <span className="rules-media-card__title">Картинка</span>
                                  <small className="rules-media-card__subtitle">
                                    Одна картинка до 1 MB. Необязательно.
                                  </small>
                                </div>

                                <div className="rules-media-card__actions">
                                  <label className="rules-upload-button">
                                    <input
                                      type="file"
                                      accept="image/*"
                                      onChange={(event) => {
                                        void handleRulesImageChange(
                                          event.target.files?.[0] ?? null,
                                        );
                                        event.currentTarget.value = '';
                                      }}
                                    />
                                    {rulesDraft.imageBase64 ? 'Заменить' : 'Добавить'}
                                  </label>
                                  {rulesDraft.imageBase64 ? (
                                    <button
                                      type="button"
                                      className="rules-remove-button"
                                      onClick={clearRulesImage}
                                    >
                                      Убрать
                                    </button>
                                  ) : null}
                                </div>
                              </div>

                              {rulesImageError ? (
                                <small className="field__hint">{rulesImageError}</small>
                              ) : rulesDraft.imageFileName ? (
                                <small className="field__hint">{rulesDraft.imageFileName}</small>
                              ) : null}
                            </div>

                            <div className="rules-action-panel">
                              <div className="rules-action-panel__content">
                                {hasRulesChanges ? (
                                  <div className="rules-action-panel__draft-chip">
                                    <span className="chip chip--warning">
                                      {isSavingRules
                                        ? 'Сохраняем черновик...'
                                        : 'Черновик обновлён'}
                                    </span>
                                  </div>
                                ) : null}
                              </div>

                              <button
                                type="button"
                                className="button button--accent rules-action-panel__publish"
                                onClick={() => void handlePublishRules()}
                                disabled={
                                  !rulesDraft.text.trim() ||
                                  isPublishingRules ||
                                  isResettingPublishedRules ||
                                  rulesQuery.isLoading ||
                                  Boolean(rulesQuery.error)
                                }
                              >
                                {isPublishingRules
                                  ? 'Публикуем...'
                                  : isSavingRules && hasRulesChanges
                                    ? 'Сохраняем черновик...'
                                    : 'Опубликовать правила'}
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            {chatId ? (
              <GlassCard
                className="settings-section stagger-in"
                style={{ animationDelay: '52ms' }}
                aria-label="Опрос чата"
              >
                <div
                  className={cn('settings-section__head', 'settings-section__head--interactive')}
                >
                  <SettingsSectionToggle
                    title="Опросы"
                    summary=""
                    status="Пост"
                    icon="poll"
                    tone="ink"
                    open={expandedSections.poll}
                    controls="settings-poll-content"
                    onClick={() => toggleSection('poll')}
                  />
                </div>

                <SettingsDrilldownPanel
                  id="settings-poll-content"
                  open={expandedSections.poll}
                  title="Опросы"
                  summary="Голосование в отдельном посте"
                  onClose={() => toggleSection('poll')}
                >
                  <div
                    id="settings-poll-content"
                    className={cn('settings-section__collapse', expandedSections.poll && 'is-open')}
                  >
                    {expandedSections.poll ? (
                      <div className="settings-section__collapse-inner">
                        <ManagedPollCard api={api} entityType="chat" entityId={chatId} />
                      </div>
                    ) : null}
                  </div>
                </SettingsDrilldownPanel>
              </GlassCard>
            ) : null}

            {chatId ? (
              <GlassCard
                className="settings-section stagger-in"
                style={{ animationDelay: '56ms' }}
                aria-label="Розыгрыши"
              >
                <div
                  className={cn('settings-section__head', 'settings-section__head--interactive')}
                >
                  <SettingsSectionToggle
                    title="Розыгрыши"
                    summary=""
                    status="Бот"
                    icon="gift"
                    tone="amber"
                    open={expandedSections.giveaway}
                    controls="settings-giveaway-content"
                    onClick={() => toggleSection('giveaway')}
                  />
                </div>

                <SettingsDrilldownPanel
                  id="settings-giveaway-content"
                  open={expandedSections.giveaway}
                  title="Розыгрыши"
                  summary="Создание и управление в личке бота"
                  onClose={() => toggleSection('giveaway')}
                >
                  <div
                    id="settings-giveaway-content"
                    className={cn(
                      'settings-section__collapse',
                      expandedSections.giveaway && 'is-open',
                    )}
                  >
                    {expandedSections.giveaway ? (
                      <div className="settings-section__collapse-inner">
                        <ManagedGiveawayCard api={api} entityType="chat" entityId={chatId} />
                      </div>
                    ) : null}
                  </div>
                </SettingsDrilldownPanel>
              </GlassCard>
            ) : null}

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '60ms' }}
              aria-label="Приветствие новых участников"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Приветствие"
                  summary=""
                  status={greetingCardStatus}
                  icon="greeting"
                  tone="mint"
                  open={expandedSections.greeting}
                  controls="settings-greeting-content"
                  onClick={() => toggleSection('greeting')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-greeting-content"
                open={expandedSections.greeting}
                title="Приветствие"
                summary={greetingHeaderSummary}
                onClose={() => toggleSection('greeting')}
                footer={renderSectionSaveFooter('greeting')}
              >
                <div
                  id="settings-greeting-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.greeting && 'is-open',
                  )}
                >
                  {expandedSections.greeting ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Включить приветствие
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'greetingEnabled' && 'is-open',
                              )}
                              aria-label="Пояснение для приветствия новых участников"
                              aria-controls="greeting-enabled-hint"
                              aria-expanded={openHintKey === 'greetingEnabled'}
                              onClick={() => toggleHint('greetingEnabled')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить приветствие новых участников"
                          >
                            <input
                              type="checkbox"
                              checked={draft.greetingEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('greetingEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('greetingBotMessageEnabled', true);
                                }
                                if (!enabled) {
                                  setFieldValue('greetingBotButtonEnabled', false);
                                  clearFieldError('greetingBotButtonUrl');
                                  clearFieldError('greetingBotButtonText');
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'greetingEnabled' ? (
                          <p id="greeting-enabled-hint" className="settings-native-toggle__hint">
                            Бот отправит приветствие, когда в чат добавляют нового участника.
                          </p>
                        ) : null}
                      </div>

                      {draft.greetingEnabled ? (
                        <>
                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Сообщение от бота
                                </span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст приветствия"
                                    onClick={() => toggleBotMessageEditor('greeting')}
                                    disabled={!draft.greetingBotMessageEnabled}
                                    isOpen={openBotEditorKey === 'greeting'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'greetingBotMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для сообщения приветствия"
                                    aria-controls="greeting-bot-message-hint"
                                    aria-expanded={openHintKey === 'greetingBotMessage'}
                                    onClick={() => toggleHint('greetingBotMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить сообщение от бота для приветствия"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.greetingBotMessageEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('greetingBotMessageEnabled', enabled);
                                    if (!enabled) {
                                      setFieldValue('greetingBotButtonEnabled', false);
                                      clearFieldError('greetingBotButtonUrl');
                                      clearFieldError('greetingBotButtonText');
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'greetingBotMessage' ? (
                              <p
                                id="greeting-bot-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                Текст приветствия отправляется только для обычных пользователей,
                                боты исключаются.
                              </p>
                            ) : null}

                            {draft.greetingBotMessageEnabled && openBotEditorKey === 'greeting' ? (
                              <BotMessageEditor
                                editorKey="greeting"
                                botSpeechStyle={draft.botSpeechStyle}
                                value={draft.greetingBotMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'greetingBotMessageText',
                                    nextValue as ChatSettings['greetingBotMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('greetingBotMessageText', '')}
                              />
                            ) : null}
                          </div>

                          {draft.greetingBotMessageEnabled ? (
                            <div
                              className={cn(
                                'settings-native-toggle',
                                'settings-native-toggle--nested',
                                hasGreetingBotButtonError && 'field--error',
                              )}
                            >
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    Добавить кнопку
                                  </span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'greetingBotButton' && 'is-open',
                                    )}
                                    aria-label="Пояснение для кнопки в приветствии"
                                    aria-controls="greeting-bot-button-hint"
                                    aria-expanded={openHintKey === 'greetingBotButton'}
                                    onClick={() => toggleHint('greetingBotButton')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Добавить кнопку в приветственное сообщение"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.greetingBotButtonEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('greetingBotButtonEnabled', enabled);
                                      if (!enabled) {
                                        clearFieldError('greetingBotButtonUrl');
                                        clearFieldError('greetingBotButtonText');
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {draft.greetingBotButtonEnabled ? (
                                <div className="settings-button-fields">
                                  <label
                                    className={cn(
                                      'field settings-url-field',
                                      greetingBotButtonUrlError && 'field--error',
                                    )}
                                  >
                                    <span className="field__label">Ссылка кнопки</span>
                                    <input
                                      type="url"
                                      inputMode="url"
                                      value={draft.greetingBotButtonUrl}
                                      onChange={(event) =>
                                        setFieldValue('greetingBotButtonUrl', event.target.value)
                                      }
                                      placeholder="https://max.ru/channel/rules"
                                    />
                                    {greetingBotButtonUrlError ? (
                                      <small className="field__hint">
                                        {greetingBotButtonUrlError}
                                      </small>
                                    ) : null}
                                  </label>

                                  <label
                                    className={cn(
                                      'field settings-text-field',
                                      greetingBotButtonTextError && 'field--error',
                                    )}
                                  >
                                    <span className="field__label">Название кнопки</span>
                                    <input
                                      type="text"
                                      maxLength={32}
                                      value={draft.greetingBotButtonText}
                                      onChange={(event) =>
                                        setFieldValue('greetingBotButtonText', event.target.value)
                                      }
                                      placeholder="Открыть"
                                    />
                                    {greetingBotButtonTextError ? (
                                      <small className="field__hint">
                                        {greetingBotButtonTextError}
                                      </small>
                                    ) : null}
                                  </label>
                                </div>
                              ) : null}

                              {!hasGreetingBotButtonError && openHintKey === 'greetingBotButton' ? (
                                <p
                                  id="greeting-bot-button-hint"
                                  className="settings-native-toggle__hint"
                                >
                                  Добавляет кнопку в приветствие, например на чат или канал.
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '90ms' }}
              aria-label="Мат и грубость"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Мат и грубость"
                  summary=""
                  status={profanityCardStatus}
                  icon="warning"
                  tone="rose"
                  open={expandedSections.profanityFilter}
                  controls="settings-profanity-filter-content"
                  onClick={() => toggleSection('profanityFilter')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-profanity-filter-content"
                open={expandedSections.profanityFilter}
                title="Мат и грубость"
                summary={profanityFilterHeaderSummary}
                onClose={() => toggleSection('profanityFilter')}
                footer={renderSectionSaveFooter('profanityFilter')}
              >
                <div
                  id="settings-profanity-filter-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.profanityFilter && 'is-open',
                  )}
                >
                  {expandedSections.profanityFilter ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle text-filter-card">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Нецензурная лексика (RU)
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'textFiltersProfanity' && 'is-open',
                              )}
                              aria-label='Пояснение для "Нецензурная лексика (RU)"'
                              aria-controls="russian-profanity-filter-enabled-hint"
                              aria-expanded={openHintKey === 'textFiltersProfanity'}
                              onClick={() => toggleHint('textFiltersProfanity')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Нецензурная лексика (RU)"
                          >
                            <input
                              type="checkbox"
                              checked={draft.russianProfanityFilterEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('russianProfanityFilterEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('profanityBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'textFiltersProfanity' ? (
                          <p
                            id="russian-profanity-filter-enabled-hint"
                            className="settings-native-toggle__hint"
                          >
                            Удаляет сообщения с матом и грубой лексикой на русском.
                          </p>
                        ) : null}
                      </div>

                      {draft.russianProfanityFilterEnabled ? (
                        <>
                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Действия бота для нецензурной лексики"
                          >
                            <span>Действия бота · Нецензурная лексика</span>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">1. Объяснение</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить объяснение для нецензурной лексики"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.profanityBotMessageEnabled}
                                  onChange={(event) =>
                                    setFieldValue(
                                      'profanityBotMessageEnabled',
                                      event.target.checked,
                                    )
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">
                                2. Предупреждение
                              </span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить предупреждение за нецензурную лексику"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.profanityWarnEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('profanityWarnEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('profanityBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">3. Бан на 6ч</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить бан за нецензурную лексику"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.profanityBanEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('profanityBanEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('profanityWarnEnabled', true);
                                      setFieldValue('profanityBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">
                                4. Удаление из группы
                              </span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить удаление из группы за нецензурную лексику"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.profanityKickEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('profanityKickEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('profanityWarnEnabled', true);
                                      setFieldValue('profanityBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '135ms' }}
              aria-label="Коммерция"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Коммерция"
                  summary=""
                  status={commercialCardStatus}
                  icon="ads"
                  tone="amber"
                  open={expandedSections.commercialFilter}
                  controls="settings-commercial-filter-content"
                  onClick={() => toggleSection('commercialFilter')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-commercial-filter-content"
                open={expandedSections.commercialFilter}
                title="Коммерция"
                summary={commercialFilterHeaderSummary}
                onClose={() => toggleSection('commercialFilter')}
                footer={renderSectionSaveFooter('commercialFilter')}
              >
                <div
                  id="settings-commercial-filter-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.commercialFilter && 'is-open',
                  )}
                >
                  {expandedSections.commercialFilter ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle text-filter-card">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Коммерческие объявления (RU)
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'textFiltersCommercial' && 'is-open',
                              )}
                              aria-label='Пояснение для "Коммерческие объявления (RU)"'
                              aria-controls="commercial-ads-filter-enabled-hint"
                              aria-expanded={openHintKey === 'textFiltersCommercial'}
                              onClick={() => toggleHint('textFiltersCommercial')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Коммерческие объявления (RU)"
                          >
                            <input
                              type="checkbox"
                              checked={draft.commercialAdsFilterEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('commercialAdsFilterEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('textFiltersBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'textFiltersCommercial' ? (
                          <p
                            id="commercial-ads-filter-enabled-hint"
                            className="settings-native-toggle__hint"
                          >
                            Удаляет рекламные и торговые объявления в чате.
                          </p>
                        ) : null}
                      </div>

                      {draft.commercialAdsFilterEnabled ? (
                        <>
                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Параметры коммерческого фильтра"
                          >
                            <span>Коммерция</span>
                          </div>

                          <div className="settings-native-toggle commercial-settings-panel">
                            <div className="commercial-sensitivity-slider">
                              <div className="commercial-sensitivity-slider__head">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="field__label">Чувствительность</span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'commercialSensitivity' && 'is-open',
                                    )}
                                    aria-label="Пояснение по чувствительности коммерческого фильтра"
                                    aria-controls="commercial-sensitivity-hint"
                                    aria-expanded={openHintKey === 'commercialSensitivity'}
                                    onClick={() => toggleHint('commercialSensitivity')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                                <span className="chip chip--warning">
                                  {commercialSensitivityLabel}
                                </span>
                              </div>

                              <input
                                type="range"
                                min={COMMERCIAL_SENSITIVITY_MIN}
                                max={COMMERCIAL_SENSITIVITY_MAX}
                                step={1}
                                value={commercialSensitivitySliderValue}
                                onChange={(event) =>
                                  handleCommercialSensitivitySliderChange(
                                    Number(event.target.value),
                                  )
                                }
                                aria-label="Ползунок чувствительности коммерческого фильтра"
                              />

                              <div className="commercial-sensitivity-slider__labels" aria-hidden>
                                <span>Мягко</span>
                                <span>Баланс</span>
                                <span>Строго</span>
                              </div>
                            </div>

                            {openHintKey === 'commercialSensitivity' ? (
                              <p
                                id="commercial-sensitivity-hint"
                                className="settings-native-toggle__hint"
                              >
                                Ползунок меняет строгость фильтра и автоматически подбирает
                                внутренние пороги.
                              </p>
                            ) : null}
                          </div>

                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Действия бота для коммерческих объявлений"
                          >
                            <span>Действия бота · Коммерческие объявления</span>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">1. Объяснение</span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст сообщения о коммерции"
                                    onClick={() => toggleBotMessageEditor('textFilters')}
                                    disabled={!draft.textFiltersBotMessageEnabled}
                                    isOpen={openBotEditorKey === 'textFilters'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'textFiltersBotMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для тумблера сообщений о коммерческих объявлениях"
                                    aria-controls="text-filters-bot-message-hint"
                                    aria-expanded={openHintKey === 'textFiltersBotMessage'}
                                    onClick={() => toggleHint('textFiltersBotMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить сообщение от бота для коммерческих объявлений"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.textFiltersBotMessageEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('textFiltersBotMessageEnabled', enabled);
                                    if (!enabled) {
                                      setFieldValue('textFiltersBotButtonEnabled', false);
                                      clearFieldError('textFiltersBotButtonUrl');
                                      clearFieldError('textFiltersBotButtonText');
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'textFiltersBotMessage' ? (
                              <p
                                id="text-filters-bot-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                Санкции усиливаются по ступеням, если пользователь повторно нарушает
                                коммерческий фильтр в течение 24 часов.
                              </p>
                            ) : null}

                            {draft.textFiltersBotMessageEnabled &&
                            openBotEditorKey === 'textFilters' ? (
                              <BotMessageEditor
                                editorKey="textFilters"
                                botSpeechStyle={draft.botSpeechStyle}
                                value={draft.textFiltersBotMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'textFiltersBotMessageText',
                                    nextValue as ChatSettings['textFiltersBotMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('textFiltersBotMessageText', '')}
                              />
                            ) : null}
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  2. Предупреждение
                                </span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст предупреждения о коммерции"
                                    onClick={() => toggleWarnMessageEditor('textFiltersWarn')}
                                    isOpen={openWarnEditorKey === 'textFiltersWarn'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'textFiltersWarnMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для предупреждения о коммерческих объявлениях"
                                    aria-controls="text-filters-warn-message-hint"
                                    aria-expanded={openHintKey === 'textFiltersWarnMessage'}
                                    onClick={() => toggleHint('textFiltersWarnMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить предупреждение за второе нарушение коммерческого фильтра"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.textFiltersWarnEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('textFiltersWarnEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('textFiltersBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'textFiltersWarnMessage' ? (
                              <p
                                id="text-filters-warn-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                Текст отправляется при 2-м нарушении коммерческого фильтра за 24
                                часа.
                              </p>
                            ) : null}

                            {openWarnEditorKey === 'textFiltersWarn' ? (
                              <WarnMessageEditor
                                editorKey="textFiltersWarn"
                                botSpeechStyle={draft.botSpeechStyle}
                                value={draft.textFiltersWarnMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'textFiltersWarnMessageText',
                                    nextValue as ChatSettings['textFiltersWarnMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('textFiltersWarnMessageText', '')}
                              />
                            ) : null}
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">3. Бан на 6ч</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить бан на шесть часов за третье нарушение коммерческого фильтра"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.textFiltersBanEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('textFiltersBanEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('textFiltersWarnEnabled', true);
                                      setFieldValue('textFiltersBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">
                                4. Удаление из группы
                              </span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить удаление из группы за четвертое нарушение коммерческого фильтра"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.textFiltersKickEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('textFiltersKickEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('textFiltersWarnEnabled', true);
                                      setFieldValue('textFiltersBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          {draft.textFiltersBotMessageEnabled ? (
                            <div
                              className={cn(
                                'settings-native-toggle',
                                'settings-native-toggle--nested',
                                hasTextFiltersBotButtonError && 'field--error',
                              )}
                            >
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    Добавить кнопку
                                  </span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'textFiltersBotButton' && 'is-open',
                                    )}
                                    aria-label="Пояснение для кнопки в сообщении о коммерции"
                                    aria-controls="text-filters-bot-button-hint"
                                    aria-expanded={openHintKey === 'textFiltersBotButton'}
                                    onClick={() => toggleHint('textFiltersBotButton')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Добавить кнопку в сообщение бота о коммерческих объявлениях"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.textFiltersBotButtonEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('textFiltersBotButtonEnabled', enabled);
                                      if (!enabled) {
                                        clearFieldError('textFiltersBotButtonUrl');
                                        clearFieldError('textFiltersBotButtonText');
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {draft.textFiltersBotButtonEnabled ? (
                                <div className="settings-button-fields">
                                  <label
                                    className={cn(
                                      'field settings-url-field',
                                      textFiltersBotButtonUrlError && 'field--error',
                                    )}
                                  >
                                    <span className="field__label">Ссылка кнопки</span>
                                    <input
                                      type="url"
                                      inputMode="url"
                                      value={draft.textFiltersBotButtonUrl}
                                      onChange={(event) =>
                                        setFieldValue('textFiltersBotButtonUrl', event.target.value)
                                      }
                                      placeholder="https://max.ru/channel/rules"
                                    />
                                    {textFiltersBotButtonUrlError ? (
                                      <small className="field__hint">
                                        {textFiltersBotButtonUrlError}
                                      </small>
                                    ) : null}
                                  </label>

                                  <label
                                    className={cn(
                                      'field settings-text-field',
                                      textFiltersBotButtonTextError && 'field--error',
                                    )}
                                  >
                                    <span className="field__label">Название кнопки</span>
                                    <input
                                      type="text"
                                      maxLength={32}
                                      value={draft.textFiltersBotButtonText}
                                      onChange={(event) =>
                                        setFieldValue(
                                          'textFiltersBotButtonText',
                                          event.target.value,
                                        )
                                      }
                                      placeholder="Правила чата"
                                    />
                                    {textFiltersBotButtonTextError ? (
                                      <small className="field__hint">
                                        {textFiltersBotButtonTextError}
                                      </small>
                                    ) : null}
                                  </label>
                                </div>
                              ) : null}

                              {!hasTextFiltersBotButtonError &&
                              openHintKey === 'textFiltersBotButton' ? (
                                <p
                                  id="text-filters-bot-button-hint"
                                  className="settings-native-toggle__hint"
                                >
                                  Добавляет кнопку в сообщение бота о коммерческом нарушении.
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            {canSeeThematicFilters ? (
              <GlassCard
                className="settings-section stagger-in"
                style={{ animationDelay: '157ms' }}
                aria-label="Объявления по теме"
              >
                <div
                  className={cn('settings-section__head', 'settings-section__head--interactive')}
                >
                  <SettingsSectionToggle
                    title="Объявления по теме"
                    summary=""
                    status={thematicFiltersCardStatus}
                    icon="topic"
                    tone="sky"
                    open={expandedSections.thematicFilters}
                    controls="settings-thematic-filters-content"
                    onClick={() => toggleSection('thematicFilters')}
                  />
                </div>

                <SettingsDrilldownPanel
                  id="settings-thematic-filters-content"
                  open={expandedSections.thematicFilters}
                  title="Объявления по теме"
                  summary={thematicFiltersHeaderSummary}
                  onClose={() => toggleSection('thematicFilters')}
                  footer={renderSectionSaveFooter('thematicFilters')}
                >
                  <div
                    id="settings-thematic-filters-content"
                    className={cn(
                      'settings-section__collapse',
                      expandedSections.thematicFilters && 'is-open',
                    )}
                  >
                    {expandedSections.thematicFilters ? (
                      <div className="settings-section__collapse-inner">
                        <p className="settings-native-toggle__hint">
                          Бот проверяет первое слово объявления длиной от 90 символов. Если оно не
                          совпадает с кодовым словом, объявление удаляется и дальше работают ступени
                          санкций.
                        </p>

                        <div className="settings-native-toggle text-filter-card">
                          <div className="settings-native-toggle__row">
                            <span className="settings-native-toggle__title">
                              Фильтр по кодовому слову
                            </span>

                            <label
                              className="settings-native-switch"
                              aria-label="Включить фильтр по кодовому слову"
                            >
                              <input
                                type="checkbox"
                                checked={draft.thematicCodewordEnabled}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  setFieldValue('thematicCodewordEnabled', enabled);
                                  if (enabled) {
                                    setFieldValue('thematicFiltersBotMessageEnabled', true);
                                  } else {
                                    clearFieldError('thematicCodeword');
                                  }
                                }}
                              />
                              <span className="toggle-switch" aria-hidden>
                                <span className="toggle-switch__thumb" />
                              </span>
                            </label>
                          </div>
                          <p className="settings-native-toggle__hint">
                            Пример: <code>недвижимость продам квартиру...</code> или{' '}
                            <code>#недвижимость: продам квартиру...</code>
                          </p>
                        </div>

                        {draft.thematicCodewordEnabled ? (
                          <>
                            <label
                              className={cn(
                                'field settings-text-field',
                                thematicCodewordError && 'field--error',
                              )}
                            >
                              <span className="field__label">Кодовое слово</span>
                              <input
                                type="text"
                                value={draft.thematicCodeword}
                                onChange={(event) =>
                                  setFieldValue('thematicCodeword', event.target.value)
                                }
                                placeholder="недвижимость"
                                maxLength={32}
                                autoCapitalize="none"
                                autoCorrect="off"
                              />
                              {thematicCodewordError ? (
                                <small className="field__hint">{thematicCodewordError}</small>
                              ) : (
                                <small className="field__hint">
                                  Одно слово без пробелов. Регистр, # и двоеточие не важны. Короткие
                                  сообщения до 89 символов не проверяются.
                                </small>
                              )}
                            </label>

                            <div
                              className="settings-subsection-divider"
                              role="separator"
                              aria-label="Ступени тематического фильтра"
                            >
                              <span>Ступени санкций</span>
                            </div>

                            <div className="settings-native-toggle">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">1. Объяснение</span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить объяснение для тематического фильтра"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.thematicFiltersBotMessageEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('thematicFiltersBotMessageEnabled', enabled);
                                      if (!enabled) {
                                        setFieldValue('thematicFiltersBotButtonEnabled', false);
                                        clearFieldError('thematicFiltersBotButtonUrl');
                                        clearFieldError('thematicFiltersBotButtonText');
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">
                                  Кнопка в сообщении бота
                                </span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Добавить кнопку в сообщение бота для тематического фильтра"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.thematicFiltersBotButtonEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('thematicFiltersBotButtonEnabled', enabled);
                                      if (enabled) {
                                        setFieldValue('thematicFiltersBotMessageEnabled', true);
                                      }
                                      if (!enabled) {
                                        clearFieldError('thematicFiltersBotButtonUrl');
                                        clearFieldError('thematicFiltersBotButtonText');
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>

                            {draft.thematicFiltersBotButtonEnabled ? (
                              <div className="settings-button-fields">
                                <label
                                  className={cn(
                                    'field settings-url-field',
                                    thematicBotButtonUrlError && 'field--error',
                                  )}
                                >
                                  <span className="field__label">Ссылка кнопки</span>
                                  <input
                                    type="url"
                                    inputMode="url"
                                    value={draft.thematicFiltersBotButtonUrl}
                                    onChange={(event) =>
                                      setFieldValue(
                                        'thematicFiltersBotButtonUrl',
                                        event.target.value,
                                      )
                                    }
                                    placeholder="https://max.ru/channel/..."
                                  />
                                  {thematicBotButtonUrlError ? (
                                    <small className="field__hint">
                                      {thematicBotButtonUrlError}
                                    </small>
                                  ) : null}
                                </label>

                                <label
                                  className={cn(
                                    'field settings-text-field',
                                    thematicBotButtonTextError && 'field--error',
                                  )}
                                >
                                  <span className="field__label">Название кнопки</span>
                                  <input
                                    type="text"
                                    value={draft.thematicFiltersBotButtonText}
                                    onChange={(event) =>
                                      setFieldValue(
                                        'thematicFiltersBotButtonText',
                                        event.target.value,
                                      )
                                    }
                                    placeholder="Открыть"
                                    maxLength={32}
                                  />
                                  {thematicBotButtonTextError ? (
                                    <small className="field__hint">
                                      {thematicBotButtonTextError}
                                    </small>
                                  ) : hasThematicBotButtonError ? null : (
                                    <small className="field__hint">До 32 символов.</small>
                                  )}
                                </label>
                              </div>
                            ) : null}

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">
                                  2. Предупреждение
                                </span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить предупреждение для тематического фильтра"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.thematicFiltersWarnEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('thematicFiltersWarnEnabled', enabled);
                                      if (enabled) {
                                        setFieldValue('thematicFiltersBotMessageEnabled', true);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">3. Бан на 6ч</span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить бан для тематического фильтра"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.thematicFiltersBanEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('thematicFiltersBanEnabled', enabled);
                                      if (enabled) {
                                        setFieldValue('thematicFiltersWarnEnabled', true);
                                        setFieldValue('thematicFiltersBotMessageEnabled', true);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">
                                  4. Удаление из группы
                                </span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить удаление из группы для тематического фильтра"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.thematicFiltersKickEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('thematicFiltersKickEnabled', enabled);
                                      if (enabled) {
                                        setFieldValue('thematicFiltersWarnEnabled', true);
                                        setFieldValue('thematicFiltersBotMessageEnabled', true);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </SettingsDrilldownPanel>
              </GlassCard>
            ) : null}

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '180ms' }}
              aria-label="Повторы"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Повторы"
                  summary=""
                  status={duplicatesCardStatus}
                  icon="repeat"
                  tone="rose"
                  open={expandedSections.duplicates}
                  controls="settings-duplicates-content"
                  onClick={() => toggleSection('duplicates')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-duplicates-content"
                open={expandedSections.duplicates}
                title="Повторы"
                summary={duplicatesHeaderSummary}
                onClose={() => toggleSection('duplicates')}
                footer={renderSectionSaveFooter('duplicates')}
              >
                <div
                  id="settings-duplicates-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.duplicates && 'is-open',
                  )}
                >
                  {expandedSections.duplicates ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">Анти дубль</span>
                          <label
                            className="settings-native-switch"
                            aria-label="Включить анти дубль"
                          >
                            <input
                              type="checkbox"
                              checked={draft.antiDuplicateEnabled}
                              onChange={(event) => {
                                setFieldValue('antiDuplicateEnabled', event.target.checked);
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      {draft.antiDuplicateEnabled && draft.duplicateBanEnabled ? (
                        <div
                          className={cn(
                            'settings-native-toggle',
                            fieldErrors.banDurationHours && 'field--error',
                          )}
                        >
                          <div className="settings-native-toggle__row">
                            <div className="settings-native-toggle__title-wrap">
                              <span className="settings-native-toggle__title">
                                Длительность бана
                              </span>
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'banDuration' && 'is-open',
                                )}
                                aria-label="Пояснение для длительности бана"
                                aria-controls="ban-duration-hint"
                                aria-expanded={openHintKey === 'banDuration'}
                                onClick={() => toggleHint('banDuration')}
                              >
                                <span aria-hidden>i</span>
                              </button>
                            </div>

                            <div
                              className="ban-duration-stepper"
                              role="group"
                              aria-label="Длительность бана в часах"
                            >
                              <button
                                type="button"
                                className="ban-duration-stepper__button"
                                onClick={() => adjustBanDuration(-1)}
                                disabled={draft.banDurationHours <= BAN_DURATION_MIN_HOURS}
                                aria-label="Уменьшить длительность бана"
                              >
                                -
                              </button>

                              <output className="ban-duration-stepper__value" aria-live="polite">
                                {draft.banDurationHours}ч
                              </output>

                              <button
                                type="button"
                                className="ban-duration-stepper__button"
                                onClick={() => adjustBanDuration(1)}
                                disabled={draft.banDurationHours >= BAN_DURATION_MAX_HOURS}
                                aria-label="Увеличить длительность бана"
                              >
                                +
                              </button>
                            </div>
                          </div>

                          {openHintKey === 'banDuration' ? (
                            <p id="ban-duration-hint" className="settings-native-toggle__hint">
                              После выдачи бана сообщения пользователя удаляются автоматически в
                              течение этого времени.
                            </p>
                          ) : null}

                          {fieldErrors.banDurationHours ? (
                            <small className="field__hint">{fieldErrors.banDurationHours}</small>
                          ) : null}
                        </div>
                      ) : null}

                      {draft.antiDuplicateEnabled ? (
                        <div className="duplicate-stage-list">
                          {DUPLICATE_STAGE_OPTIONS.map((stage) => {
                            const enabled = draft[stage.enabledKey];
                            const windowSec = draft[stage.windowKey];
                            const maxCount = draft[stage.maxCountKey];
                            const windowError = fieldErrors[stage.windowKey];
                            const maxCountError = fieldErrors[stage.maxCountKey];

                            return (
                              <article
                                key={stage.id}
                                className={cn('duplicate-stage', !enabled && 'is-disabled')}
                              >
                                <div className="duplicate-stage__top">
                                  <label className="duplicate-stage__toggle">
                                    <input
                                      type="checkbox"
                                      checked={enabled}
                                      onChange={(event) => {
                                        const stageEnabled = event.target.checked;
                                        setFieldValue(
                                          stage.enabledKey,
                                          stageEnabled as ChatSettings[DuplicateEnabledKey],
                                        );
                                        if (stageEnabled) {
                                          setFieldValue('duplicateBotMessageEnabled', true);
                                        }
                                      }}
                                    />
                                    <span className="toggle-switch" aria-hidden>
                                      <span className="toggle-switch__thumb" />
                                    </span>
                                    <span className="duplicate-stage__title">{stage.label}</span>
                                  </label>
                                </div>

                                <div className="duplicate-stage__controls">
                                  <label
                                    className={cn(
                                      'duplicate-stage__field',
                                      windowError && 'field--error',
                                    )}
                                  >
                                    <span className="duplicate-stage__field-label">Интервал</span>
                                    <div className="duplicate-stage__input-wrap">
                                      <input
                                        type="number"
                                        min={1}
                                        max={168}
                                        step={1}
                                        value={
                                          duplicateWindowInputValues[stage.windowKey] ??
                                          String(secondsToHours(Number(windowSec)))
                                        }
                                        onChange={(event) =>
                                          handleDuplicateWindowHoursChange(
                                            stage.windowKey,
                                            event.target.value,
                                          )
                                        }
                                        onBlur={() =>
                                          handleDuplicateWindowHoursBlur(stage.windowKey)
                                        }
                                        disabled={!enabled}
                                        aria-label={`Интервал для ступени ${stage.label} в часах`}
                                      />
                                      <span className="duplicate-stage__suffix" aria-hidden>
                                        часы
                                      </span>
                                    </div>
                                  </label>

                                  <div
                                    className={cn(
                                      'duplicate-stage__field',
                                      maxCountError && 'field--error',
                                    )}
                                  >
                                    <span className="duplicate-stage__field-label">
                                      Количество дублей
                                    </span>
                                    <div
                                      className="duplicate-count-stepper"
                                      role="group"
                                      aria-label={`Количество дублей для ступени ${stage.label}`}
                                    >
                                      <button
                                        type="button"
                                        className="duplicate-count-stepper__button"
                                        onClick={() =>
                                          adjustDuplicateMaxCount(
                                            stage.maxCountKey,
                                            Number(maxCount),
                                            -1,
                                          )
                                        }
                                        disabled={
                                          !enabled || Number(maxCount) <= DUPLICATE_COUNT_MIN
                                        }
                                        aria-label={`Уменьшить количество дублей для ${stage.label}`}
                                      >
                                        -
                                      </button>

                                      <output
                                        className="duplicate-count-stepper__value"
                                        aria-live="polite"
                                      >
                                        {Number(maxCount)}
                                      </output>

                                      <button
                                        type="button"
                                        className="duplicate-count-stepper__button"
                                        onClick={() =>
                                          adjustDuplicateMaxCount(
                                            stage.maxCountKey,
                                            Number(maxCount),
                                            1,
                                          )
                                        }
                                        disabled={
                                          !enabled || Number(maxCount) >= DUPLICATE_COUNT_MAX
                                        }
                                        aria-label={`Увеличить количество дублей для ${stage.label}`}
                                      >
                                        +
                                      </button>
                                    </div>
                                  </div>
                                </div>

                                {windowError || maxCountError ? (
                                  <div className="duplicate-stage__errors">
                                    {windowError ? (
                                      <small className="field__hint">{windowError}</small>
                                    ) : null}
                                    {maxCountError ? (
                                      <small className="field__hint">{maxCountError}</small>
                                    ) : null}
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      ) : null}

                      {draft.antiDuplicateEnabled ? (
                        <div
                          className="settings-subsection-divider"
                          role="separator"
                          aria-label="Блок действий бота"
                        >
                          <span>Действия бота</span>
                        </div>
                      ) : null}

                      {draft.antiDuplicateEnabled ? (
                        <div className="settings-native-toggle">
                          <div className="settings-native-toggle__row">
                            <div className="settings-native-toggle__title-wrap">
                              <span className="settings-native-toggle__title">
                                Сообщение от бота
                              </span>
                              <div className="settings-native-toggle__title-actions">
                                <EditToggleButton
                                  label="Редактировать текст сообщения о дублях"
                                  onClick={() => toggleBotMessageEditor('duplicate')}
                                  disabled={!draft.duplicateBotMessageEnabled}
                                  isOpen={openBotEditorKey === 'duplicate'}
                                />
                                <button
                                  type="button"
                                  className={cn(
                                    'settings-info-button',
                                    openHintKey === 'duplicateBotMessage' && 'is-open',
                                  )}
                                  aria-label="Пояснение для тумблера сообщений о дублях"
                                  aria-controls="duplicate-bot-message-hint"
                                  aria-expanded={openHintKey === 'duplicateBotMessage'}
                                  onClick={() => toggleHint('duplicateBotMessage')}
                                >
                                  <span aria-hidden>i</span>
                                </button>
                              </div>
                            </div>

                            <label
                              className="settings-native-switch"
                              aria-label="Включить сообщение от бота для дублей сообщений"
                            >
                              <input
                                type="checkbox"
                                checked={draft.duplicateBotMessageEnabled}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  setFieldValue('duplicateBotMessageEnabled', enabled);
                                  if (!enabled) {
                                    setFieldValue('duplicateBotButtonEnabled', false);
                                    clearFieldError('duplicateBotButtonUrl');
                                    clearFieldError('duplicateBotButtonText');
                                  }
                                }}
                              />
                              <span className="toggle-switch" aria-hidden>
                                <span className="toggle-switch__thumb" />
                              </span>
                            </label>
                          </div>

                          {openHintKey === 'duplicateBotMessage' ? (
                            <p
                              id="duplicate-bot-message-hint"
                              className="settings-native-toggle__hint"
                            >
                              При срабатывании правила дублей бот публикует поясняющее сообщение.
                            </p>
                          ) : null}

                          {draft.duplicateBotMessageEnabled && openBotEditorKey === 'duplicate' ? (
                            <BotMessageEditor
                              editorKey="duplicate"
                              botSpeechStyle={draft.botSpeechStyle}
                              value={draft.duplicateBotMessageText}
                              onChange={(nextValue) =>
                                setFieldValue(
                                  'duplicateBotMessageText',
                                  nextValue as ChatSettings['duplicateBotMessageText'],
                                )
                              }
                              onReset={() => setFieldValue('duplicateBotMessageText', '')}
                            />
                          ) : null}
                        </div>
                      ) : null}

                      {draft.antiDuplicateEnabled && draft.duplicateBotMessageEnabled ? (
                        <div
                          className={cn(
                            'settings-native-toggle',
                            'settings-native-toggle--nested',
                            hasDuplicateBotButtonError && 'field--error',
                          )}
                        >
                          <div className="settings-native-toggle__row">
                            <div className="settings-native-toggle__title-wrap">
                              <span className="settings-native-toggle__title">Добавить кнопку</span>
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'duplicateBotButton' && 'is-open',
                                )}
                                aria-label="Пояснение для кнопки в сообщении о дублях"
                                aria-controls="duplicate-bot-button-hint"
                                aria-expanded={openHintKey === 'duplicateBotButton'}
                                onClick={() => toggleHint('duplicateBotButton')}
                              >
                                <span aria-hidden>i</span>
                              </button>
                            </div>

                            <label
                              className="settings-native-switch"
                              aria-label="Добавить кнопку в сообщение бота для дублей сообщений"
                            >
                              <input
                                type="checkbox"
                                checked={draft.duplicateBotButtonEnabled}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  setFieldValue('duplicateBotButtonEnabled', enabled);
                                  if (!enabled) {
                                    clearFieldError('duplicateBotButtonUrl');
                                    clearFieldError('duplicateBotButtonText');
                                  }
                                }}
                              />
                              <span className="toggle-switch" aria-hidden>
                                <span className="toggle-switch__thumb" />
                              </span>
                            </label>
                          </div>

                          {draft.duplicateBotButtonEnabled ? (
                            <div className="settings-button-fields">
                              <label
                                className={cn(
                                  'field settings-url-field',
                                  duplicateBotButtonUrlError && 'field--error',
                                )}
                              >
                                <span className="field__label">Ссылка кнопки</span>
                                <input
                                  type="url"
                                  inputMode="url"
                                  value={draft.duplicateBotButtonUrl}
                                  onChange={(event) =>
                                    setFieldValue('duplicateBotButtonUrl', event.target.value)
                                  }
                                  placeholder="https://max.ru/profile/..."
                                />
                                {duplicateBotButtonUrlError ? (
                                  <small className="field__hint">
                                    {duplicateBotButtonUrlError}
                                  </small>
                                ) : null}
                              </label>

                              <label
                                className={cn(
                                  'field settings-text-field',
                                  duplicateBotButtonTextError && 'field--error',
                                )}
                              >
                                <span className="field__label">Название кнопки</span>
                                <input
                                  type="text"
                                  maxLength={32}
                                  value={draft.duplicateBotButtonText}
                                  onChange={(event) =>
                                    setFieldValue('duplicateBotButtonText', event.target.value)
                                  }
                                  placeholder="Открыть"
                                />
                                {duplicateBotButtonTextError ? (
                                  <small className="field__hint">
                                    {duplicateBotButtonTextError}
                                  </small>
                                ) : null}
                              </label>
                            </div>
                          ) : null}

                          {!hasDuplicateBotButtonError && openHintKey === 'duplicateBotButton' ? (
                            <p
                              id="duplicate-bot-button-hint"
                              className="settings-native-toggle__hint"
                            >
                              Добавляет кнопку в сообщение бота. Можно отправить пользователя в
                              нужный чат, канал или профиль.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '225ms' }}
              aria-label="Ограничения"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Ограничения"
                  summary={`${limitsRulesEnabledCount} ограничений активно`}
                  status={limitsCardStatus}
                  icon="shield"
                  tone="ink"
                  open={expandedSections.limits}
                  controls="settings-limits-content"
                  onClick={() => toggleSection('limits')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-limits-content"
                open={expandedSections.limits}
                title="Ограничения"
                summary={`${limitsRulesEnabledCount} ограничений активно`}
                onClose={() => toggleSection('limits')}
                footer={renderSectionSaveFooter('limits')}
              >
                <div
                  id="settings-limits-content"
                  className={cn('settings-section__collapse', expandedSections.limits && 'is-open')}
                >
                  {expandedSections.limits ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Анти-спам</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'antiSpam' && 'is-open',
                              )}
                              aria-label="Пояснение для анти-спама"
                              aria-controls="anti-spam-hint"
                              aria-expanded={openHintKey === 'antiSpam'}
                              onClick={() => toggleHint('antiSpam')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label className="settings-native-switch" aria-label="Включить анти-спам">
                            <input
                              type="checkbox"
                              checked={draft.antiSpamEnabled}
                              onChange={(event) =>
                                setFieldValue('antiSpamEnabled', event.target.checked)
                              }
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'antiSpam' ? (
                          <p id="anti-spam-hint" className="settings-native-toggle__hint">
                            Базовые параметры: не более 5 сообщений за 10 секунд от одного
                            пользователя. Изменение порогов через UI отключено.
                          </p>
                        ) : null}
                      </div>

                      <div
                        className={cn(
                          'settings-native-toggle',
                          (fieldErrors.messageCountLimitMessages ||
                            fieldErrors.messageCountLimitWindowHours) &&
                            'field--error',
                        )}
                      >
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Лимит сообщений</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'messageCountLimit' && 'is-open',
                              )}
                              aria-label="Пояснение для лимита сообщений"
                              aria-controls="message-count-limit-hint"
                              aria-expanded={openHintKey === 'messageCountLimit'}
                              onClick={() => toggleHint('messageCountLimit')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить лимит сообщений"
                          >
                            <input
                              type="checkbox"
                              checked={draft.messageCountLimitEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('messageCountLimitEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {draft.messageCountLimitEnabled ? (
                          <>
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                Сообщений
                              </span>
                              <output className="settings-length-limit__value" aria-live="polite">
                                {draft.messageCountLimitMessages}
                              </output>
                            </div>
                            <input
                              className="settings-length-limit__slider"
                              type="range"
                              min={MESSAGE_COUNT_LIMIT_MIN}
                              max={MESSAGE_COUNT_LIMIT_MAX}
                              step={1}
                              value={draft.messageCountLimitMessages}
                              onChange={(event) =>
                                setFieldValue(
                                  'messageCountLimitMessages',
                                  Number(
                                    event.target.value,
                                  ) as ChatSettings['messageCountLimitMessages'],
                                )
                              }
                              aria-label="Лимит сообщений за выбранный период"
                            />
                            <div className="settings-length-limit__labels" aria-hidden>
                              <span>{MESSAGE_COUNT_LIMIT_MIN}</span>
                              <span>{MESSAGE_COUNT_LIMIT_MAX}</span>
                            </div>

                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                Период
                              </span>
                              <output className="settings-length-limit__value" aria-live="polite">
                                {draft.messageCountLimitWindowHours}ч
                              </output>
                            </div>
                            <input
                              className="settings-length-limit__slider"
                              type="range"
                              min={MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS}
                              max={MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS}
                              step={1}
                              value={draft.messageCountLimitWindowHours}
                              onChange={(event) =>
                                setFieldValue(
                                  'messageCountLimitWindowHours',
                                  Number(
                                    event.target.value,
                                  ) as ChatSettings['messageCountLimitWindowHours'],
                                )
                              }
                              aria-label="Период лимита сообщений в часах"
                            />
                            <div className="settings-length-limit__labels" aria-hidden>
                              <span>{MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS}ч</span>
                              <span>{MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS}ч</span>
                            </div>
                          </>
                        ) : null}

                        {fieldErrors.messageCountLimitMessages ? (
                          <small className="field__hint">
                            {fieldErrors.messageCountLimitMessages}
                          </small>
                        ) : fieldErrors.messageCountLimitWindowHours ? (
                          <small className="field__hint">
                            {fieldErrors.messageCountLimitWindowHours}
                          </small>
                        ) : openHintKey === 'messageCountLimit' ? (
                          <p id="message-count-limit-hint" className="settings-native-toggle__hint">
                            Ограничивает количество сообщений от одного пользователя в выбранное
                            окно времени. Срабатывает после превышения лимита.
                          </p>
                        ) : null}
                      </div>

                      <div
                        className={cn(
                          'settings-native-toggle',
                          fieldErrors.maxMessageLength && 'field--error',
                        )}
                      >
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Лимит длины сообщения
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'maxMessageLength' && 'is-open',
                              )}
                              aria-label="Пояснение для лимита длины сообщения"
                              aria-controls="max-message-length-hint"
                              aria-expanded={openHintKey === 'maxMessageLength'}
                              onClick={() => toggleHint('maxMessageLength')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить ограничение длины сообщения"
                          >
                            <input
                              type="checkbox"
                              checked={draft.maxMessageLengthEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('maxMessageLengthEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {draft.maxMessageLengthEnabled ? (
                          <MaxMessageLengthSlider
                            value={draft.maxMessageLength}
                            min={MESSAGE_LENGTH_MIN}
                            max={MESSAGE_LENGTH_MAX}
                            step={MESSAGE_LENGTH_STEP}
                            onCommit={(value) =>
                              setFieldValue(
                                'maxMessageLength',
                                value as ChatSettings['maxMessageLength'],
                              )
                            }
                          />
                        ) : null}

                        {openHintKey === 'maxMessageLength' ? (
                          <p id="max-message-length-hint" className="settings-native-toggle__hint">
                            Учитывается длина обычного текста и пересланных сообщений.
                          </p>
                        ) : null}

                        {fieldErrors.maxMessageLength ? (
                          <small className="field__hint">{fieldErrors.maxMessageLength}</small>
                        ) : null}
                      </div>

                      <div
                        className={cn(
                          'settings-native-toggle',
                          fieldErrors.photoMessageCooldownHours && 'field--error',
                        )}
                      >
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Фото: не чаще 1 раза
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'photoCooldown' && 'is-open',
                              )}
                              aria-label="Пояснение для ограничения частоты фото"
                              aria-controls="photo-cooldown-hint"
                              aria-expanded={openHintKey === 'photoCooldown'}
                              onClick={() => toggleHint('photoCooldown')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Ограничить отправку фото по времени"
                          >
                            <input
                              type="checkbox"
                              checked={draft.photoMessageCooldownEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('photoMessageCooldownEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {draft.photoMessageCooldownEnabled ? (
                          <>
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                Интервал
                              </span>
                              <output className="settings-length-limit__value" aria-live="polite">
                                {draft.photoMessageCooldownHours}ч
                              </output>
                            </div>
                            <input
                              className="settings-length-limit__slider"
                              type="range"
                              min={PHOTO_COOLDOWN_MIN_HOURS}
                              max={PHOTO_COOLDOWN_MAX_HOURS}
                              step={1}
                              value={draft.photoMessageCooldownHours}
                              onChange={(event) =>
                                setFieldValue(
                                  'photoMessageCooldownHours',
                                  Number(
                                    event.target.value,
                                  ) as ChatSettings['photoMessageCooldownHours'],
                                )
                              }
                              aria-label="Интервал отправки фото в часах"
                            />
                            <div className="settings-length-limit__labels" aria-hidden>
                              <span>{PHOTO_COOLDOWN_MIN_HOURS}ч</span>
                              <span>{PHOTO_COOLDOWN_MAX_HOURS}ч</span>
                            </div>
                          </>
                        ) : null}

                        {fieldErrors.photoMessageCooldownHours ? (
                          <small className="field__hint">
                            {fieldErrors.photoMessageCooldownHours}
                          </small>
                        ) : openHintKey === 'photoCooldown' ? (
                          <p id="photo-cooldown-hint" className="settings-native-toggle__hint">
                            При включении пользователь может отправить только одно сообщение с
                            фотографиями за выбранный интервал.
                          </p>
                        ) : null}
                      </div>

                      <div
                        className={cn(
                          'settings-native-toggle',
                          fieldErrors.stickerMessageCooldownMinutes && 'field--error',
                        )}
                      >
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Стикеры: не чаще 1 раза
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'stickerCooldown' && 'is-open',
                              )}
                              aria-label="Пояснение для ограничения частоты стикеров"
                              aria-controls="sticker-cooldown-hint"
                              aria-expanded={openHintKey === 'stickerCooldown'}
                              onClick={() => toggleHint('stickerCooldown')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Ограничить отправку стикеров по времени"
                          >
                            <input
                              type="checkbox"
                              checked={draft.stickerMessageCooldownEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('stickerMessageCooldownEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {draft.stickerMessageCooldownEnabled ? (
                          <div className="settings-native-toggle__row">
                            <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                              Интервал
                            </span>
                            <div
                              className="ban-duration-stepper"
                              role="group"
                              aria-label="Интервал отправки стикеров в минутах"
                            >
                              <button
                                type="button"
                                className="ban-duration-stepper__button"
                                onClick={() => adjustStickerMessageCooldown(-1)}
                                disabled={
                                  draft.stickerMessageCooldownMinutes <=
                                  STICKER_COOLDOWN_MIN_MINUTES
                                }
                                aria-label="Уменьшить интервал отправки стикеров"
                              >
                                -
                              </button>
                              <output className="ban-duration-stepper__value" aria-live="polite">
                                {draft.stickerMessageCooldownMinutes} мин
                              </output>
                              <button
                                type="button"
                                className="ban-duration-stepper__button"
                                onClick={() => adjustStickerMessageCooldown(1)}
                                disabled={
                                  draft.stickerMessageCooldownMinutes >=
                                  STICKER_COOLDOWN_MAX_MINUTES
                                }
                                aria-label="Увеличить интервал отправки стикеров"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {fieldErrors.stickerMessageCooldownMinutes ? (
                          <small className="field__hint">
                            {fieldErrors.stickerMessageCooldownMinutes}
                          </small>
                        ) : openHintKey === 'stickerCooldown' ? (
                          <p id="sticker-cooldown-hint" className="settings-native-toggle__hint">
                            Стикеры считаются отдельно и не попадают в лимит фото.
                          </p>
                        ) : null}
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">Разрешить видео</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Разрешить отправку видео"
                          >
                            <input
                              type="checkbox"
                              checked={draft.videoMessagesEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('videoMessagesEnabled', enabled);
                                if (!enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">Разрешить файлы</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Разрешить отправку файлов"
                          >
                            <input
                              type="checkbox"
                              checked={draft.fileMessagesEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('fileMessagesEnabled', enabled);
                                if (!enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">Разрешить голосовые</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Разрешить отправку голосовых"
                          >
                            <input
                              type="checkbox"
                              checked={draft.voiceMessagesEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('voiceMessagesEnabled', enabled);
                                if (!enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div
                        className="settings-subsection-divider"
                        role="separator"
                        aria-label="Блок действий бота"
                      >
                        <span>Действия бота</span>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Сообщение от бота</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать текст сообщения об ограничениях"
                                onClick={() => toggleBotMessageEditor('messageLimits')}
                                disabled={!draft.messageLimitsBotMessageEnabled}
                                isOpen={openBotEditorKey === 'messageLimits'}
                              />
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'messageLimitsBotMessage' && 'is-open',
                                )}
                                aria-label="Пояснение для тумблера сообщений в блоке ограничений"
                                aria-controls="message-limits-bot-message-hint"
                                aria-expanded={openHintKey === 'messageLimitsBotMessage'}
                                onClick={() => toggleHint('messageLimitsBotMessage')}
                              >
                                <span aria-hidden>i</span>
                              </button>
                            </div>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить сообщение от бота для ограничений сообщений"
                          >
                            <input
                              type="checkbox"
                              checked={draft.messageLimitsBotMessageEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('messageLimitsBotMessageEnabled', enabled);
                                if (!enabled) {
                                  setFieldValue('messageLimitsBotButtonEnabled', false);
                                  clearFieldError('messageLimitsBotButtonUrl');
                                  clearFieldError('messageLimitsBotButtonText');
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'messageLimitsBotMessage' ? (
                          <p
                            id="message-limits-bot-message-hint"
                            className="settings-native-toggle__hint"
                          >
                            Бот отправляет пояснение при удалении сообщения по правилам этого блока.
                            Текст можно настроить вручную или вернуть к выбранному стилю.
                          </p>
                        ) : null}

                        {draft.messageLimitsBotMessageEnabled &&
                        openBotEditorKey === 'messageLimits' ? (
                          <BotMessageEditor
                            editorKey="messageLimits"
                            botSpeechStyle={draft.botSpeechStyle}
                            value={draft.messageLimitsBotMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'messageLimitsBotMessageText',
                                nextValue as ChatSettings['messageLimitsBotMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('messageLimitsBotMessageText', '')}
                          />
                        ) : null}
                      </div>

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">2. Предупреждение</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить предупреждение за второе нарушение ограничений сообщений за 12 часов"
                          >
                            <input
                              type="checkbox"
                              checked={draft.messageLimitsWarnEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('messageLimitsWarnEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">
                            3. Бан на {draft.banDurationHours}ч
                          </span>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить бан за третье нарушение ограничений сообщений за 12 часов"
                          >
                            <input
                              type="checkbox"
                              checked={draft.messageLimitsBanEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('messageLimitsBanEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsWarnEnabled', true);
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">
                            4. Удаление из группы
                          </span>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить удаление из группы за четвертое нарушение ограничений сообщений за 12 часов"
                          >
                            <input
                              type="checkbox"
                              checked={draft.messageLimitsKickEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('messageLimitsKickEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsWarnEnabled', true);
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      {draft.messageLimitsBotMessageEnabled ? (
                        <div
                          className={cn(
                            'settings-native-toggle',
                            'settings-native-toggle--nested',
                            hasMessageLimitsBotButtonError && 'field--error',
                          )}
                        >
                          <div className="settings-native-toggle__row">
                            <div className="settings-native-toggle__title-wrap">
                              <span className="settings-native-toggle__title">Добавить кнопку</span>
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'messageLimitsBotButton' && 'is-open',
                                )}
                                aria-label="Пояснение для кнопки в сообщении ограничений"
                                aria-controls="message-limits-bot-button-hint"
                                aria-expanded={openHintKey === 'messageLimitsBotButton'}
                                onClick={() => toggleHint('messageLimitsBotButton')}
                              >
                                <span aria-hidden>i</span>
                              </button>
                            </div>

                            <label
                              className="settings-native-switch"
                              aria-label="Добавить кнопку в сообщение бота для ограничений сообщений"
                            >
                              <input
                                type="checkbox"
                                checked={draft.messageLimitsBotButtonEnabled}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  setFieldValue('messageLimitsBotButtonEnabled', enabled);
                                  if (!enabled) {
                                    clearFieldError('messageLimitsBotButtonUrl');
                                    clearFieldError('messageLimitsBotButtonText');
                                  }
                                }}
                              />
                              <span className="toggle-switch" aria-hidden>
                                <span className="toggle-switch__thumb" />
                              </span>
                            </label>
                          </div>

                          {draft.messageLimitsBotButtonEnabled ? (
                            <div className="settings-button-fields">
                              <label
                                className={cn(
                                  'field settings-url-field',
                                  messageLimitsBotButtonUrlError && 'field--error',
                                )}
                              >
                                <span className="field__label">Ссылка кнопки</span>
                                <input
                                  type="url"
                                  inputMode="url"
                                  value={draft.messageLimitsBotButtonUrl}
                                  onChange={(event) =>
                                    setFieldValue('messageLimitsBotButtonUrl', event.target.value)
                                  }
                                  placeholder="https://max.ru/channel/..."
                                />
                                {messageLimitsBotButtonUrlError ? (
                                  <small className="field__hint">
                                    {messageLimitsBotButtonUrlError}
                                  </small>
                                ) : null}
                              </label>

                              <label
                                className={cn(
                                  'field settings-text-field',
                                  messageLimitsBotButtonTextError && 'field--error',
                                )}
                              >
                                <span className="field__label">Название кнопки</span>
                                <input
                                  type="text"
                                  maxLength={32}
                                  value={draft.messageLimitsBotButtonText}
                                  onChange={(event) =>
                                    setFieldValue('messageLimitsBotButtonText', event.target.value)
                                  }
                                  placeholder="Открыть"
                                />
                                {messageLimitsBotButtonTextError ? (
                                  <small className="field__hint">
                                    {messageLimitsBotButtonTextError}
                                  </small>
                                ) : null}
                              </label>
                            </div>
                          ) : null}

                          {!hasMessageLimitsBotButtonError &&
                          openHintKey === 'messageLimitsBotButton' ? (
                            <p
                              id="message-limits-bot-button-hint"
                              className="settings-native-toggle__hint"
                            >
                              Добавляет кнопку в сообщение бота с переходом на чат, канал или
                              профиль.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '270ms' }}
              aria-label="Ночной режим"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Ночной режим"
                  summary=""
                  status={nightCardStatus}
                  icon="moon"
                  tone="ink"
                  open={expandedSections.night}
                  controls="settings-night-content"
                  onClick={() => toggleSection('night')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-night-content"
                open={expandedSections.night}
                title="Ночной режим"
                summary={nightHeaderSummary}
                onClose={() => toggleSection('night')}
                footer={renderSectionSaveFooter('night')}
              >
                <div
                  id="settings-night-content"
                  className={cn('settings-section__collapse', expandedSections.night && 'is-open')}
                >
                  {expandedSections.night ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Включить режим</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'nightModeEnabled' && 'is-open',
                              )}
                              aria-label="Пояснение для ночного режима"
                              aria-controls="night-mode-enabled-hint"
                              aria-expanded={openHintKey === 'nightModeEnabled'}
                              onClick={() => toggleHint('nightModeEnabled')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить закрытие чата на ночь"
                          >
                            <input
                              type="checkbox"
                              checked={draft.nightModeEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('nightModeEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('nightModeBotMessageEnabled', true);
                                } else {
                                  setFieldValue('nightModeBotMessageEnabled', false);
                                  setFieldValue('nightModeBotButtonEnabled', false);
                                  setFieldValue('nightModeRulesButtonEnabled', false);
                                  clearFieldError('nightModeBotButtonUrl');
                                  clearFieldError('nightModeBotButtonText');
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'nightModeEnabled' ? (
                          <p id="night-mode-enabled-hint" className="settings-native-toggle__hint">
                            Во время закрытия сообщения не-админов удаляются автоматически.
                          </p>
                        ) : null}
                      </div>

                      {draft.nightModeEnabled ? (
                        <div
                          className={cn(
                            'settings-native-toggle',
                            nightTimezoneError && 'field--error',
                          )}
                        >
                          <div className="night-window-grid">
                            <label className="field night-window-grid__field">
                              <span className="field__label">Закрывать с</span>
                              <input
                                type="time"
                                step={60}
                                value={minutesToTimeInput(draft.nightModeStartTimeMinutes)}
                                onChange={(event) =>
                                  setFieldValue(
                                    'nightModeStartTimeMinutes',
                                    timeInputToMinutes(
                                      event.target.value,
                                      normalizeDayMinutes(draft.nightModeStartTimeMinutes, 23 * 60),
                                    ),
                                  )
                                }
                              />
                            </label>

                            <label className="field night-window-grid__field">
                              <span className="field__label">Открывать в</span>
                              <input
                                type="time"
                                step={60}
                                value={minutesToTimeInput(draft.nightModeEndTimeMinutes)}
                                onChange={(event) =>
                                  setFieldValue(
                                    'nightModeEndTimeMinutes',
                                    timeInputToMinutes(
                                      event.target.value,
                                      normalizeDayMinutes(draft.nightModeEndTimeMinutes, 8 * 60),
                                    ),
                                  )
                                }
                              />
                            </label>
                          </div>

                          <label className={cn('field', nightTimezoneError && 'field--error')}>
                            <span className="field__label">Часовой пояс России</span>
                            <select
                              value={draft.nightModeTimezone}
                              onChange={(event) =>
                                setFieldValue('nightModeTimezone', event.target.value)
                              }
                            >
                              {RUSSIAN_TIMEZONE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            {nightTimezoneError ? (
                              <small className="field__hint">{nightTimezoneError}</small>
                            ) : (
                              <small className="field__hint">
                                По умолчанию используется Москва (UTC+3).
                              </small>
                            )}
                          </label>
                        </div>
                      ) : null}

                      {draft.nightModeEnabled ? (
                        <>
                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Блок действий бота для ночного режима"
                          >
                            <span>Действия бота</span>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Сообщение от бота
                                </span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст сообщения ночного режима"
                                    onClick={() => toggleBotMessageEditor('night')}
                                    disabled={!draft.nightModeBotMessageEnabled}
                                    isOpen={openBotEditorKey === 'night'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'nightBotMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для тумблера сообщений ночного режима"
                                    aria-controls="night-bot-message-hint"
                                    aria-expanded={openHintKey === 'nightBotMessage'}
                                    onClick={() => toggleHint('nightBotMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить сообщение от бота для ночного режима"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.nightModeBotMessageEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('nightModeBotMessageEnabled', enabled);
                                    if (!enabled) {
                                      setFieldValue('nightModeBotButtonEnabled', false);
                                      setFieldValue('nightModeRulesButtonEnabled', false);
                                      clearFieldError('nightModeBotButtonUrl');
                                      clearFieldError('nightModeBotButtonText');
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'nightBotMessage' ? (
                              <p
                                id="night-bot-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                Бот пишет, что чат закрыт на ночь, и поясняет удаление сообщения.
                              </p>
                            ) : null}

                            {draft.nightModeBotMessageEnabled && openBotEditorKey === 'night' ? (
                              <BotMessageEditor
                                editorKey="night"
                                botSpeechStyle={draft.botSpeechStyle}
                                value={draft.nightModeBotMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'nightModeBotMessageText',
                                    nextValue as ChatSettings['nightModeBotMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('nightModeBotMessageText', '')}
                              />
                            ) : null}
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Сообщение об открытии
                                </span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст сообщения об открытии группы"
                                    onClick={() => toggleBotMessageEditor('nightOpen')}
                                    disabled={!draft.nightModeOpenMessageEnabled}
                                    isOpen={openBotEditorKey === 'nightOpen'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'nightOpenMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для сообщения об открытии группы"
                                    aria-controls="night-open-message-hint"
                                    aria-expanded={openHintKey === 'nightOpenMessage'}
                                    onClick={() => toggleHint('nightOpenMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить сообщение об открытии группы после ночного режима"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.nightModeOpenMessageEnabled}
                                  onChange={(event) =>
                                    setFieldValue(
                                      'nightModeOpenMessageEnabled',
                                      event.target.checked,
                                    )
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'nightOpenMessage' ? (
                              <p
                                id="night-open-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                После окончания ночного режима бот пишет, что группа снова открыта,
                                и удаляет предыдущее ночное сообщение.
                              </p>
                            ) : null}

                            {draft.nightModeOpenMessageEnabled &&
                            openBotEditorKey === 'nightOpen' ? (
                              <BotMessageEditor
                                editorKey="nightOpen"
                                botSpeechStyle={draft.botSpeechStyle}
                                value={draft.nightModeOpenMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'nightModeOpenMessageText',
                                    nextValue as ChatSettings['nightModeOpenMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('nightModeOpenMessageText', '')}
                              />
                            ) : null}
                          </div>

                          {draft.nightModeBotMessageEnabled ? (
                            <div
                              className={cn(
                                'settings-native-toggle',
                                'settings-native-toggle--nested',
                                hasNightBotButtonError && 'field--error',
                              )}
                            >
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    Добавить кнопку
                                  </span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'nightBotButton' && 'is-open',
                                    )}
                                    aria-label="Пояснение для кнопки в сообщении ночного режима"
                                    aria-controls="night-bot-button-hint"
                                    aria-expanded={openHintKey === 'nightBotButton'}
                                    onClick={() => toggleHint('nightBotButton')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Добавить кнопку в сообщение бота для ночного режима"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.nightModeBotButtonEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('nightModeBotButtonEnabled', enabled);
                                      if (!enabled) {
                                        clearFieldError('nightModeBotButtonUrl');
                                        clearFieldError('nightModeBotButtonText');
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {draft.nightModeBotButtonEnabled ? (
                                <div className="settings-button-fields">
                                  <label
                                    className={cn(
                                      'field settings-url-field',
                                      nightBotButtonUrlError && 'field--error',
                                    )}
                                  >
                                    <span className="field__label">Ссылка кнопки</span>
                                    <input
                                      type="url"
                                      inputMode="url"
                                      value={draft.nightModeBotButtonUrl}
                                      onChange={(event) =>
                                        setFieldValue('nightModeBotButtonUrl', event.target.value)
                                      }
                                      placeholder="https://max.ru/channel/..."
                                    />
                                    {nightBotButtonUrlError ? (
                                      <small className="field__hint">
                                        {nightBotButtonUrlError}
                                      </small>
                                    ) : null}
                                  </label>

                                  <label
                                    className={cn(
                                      'field settings-text-field',
                                      nightBotButtonTextError && 'field--error',
                                    )}
                                  >
                                    <span className="field__label">Название кнопки</span>
                                    <input
                                      type="text"
                                      maxLength={32}
                                      value={draft.nightModeBotButtonText}
                                      onChange={(event) =>
                                        setFieldValue('nightModeBotButtonText', event.target.value)
                                      }
                                      placeholder="Правила чата"
                                    />
                                    {nightBotButtonTextError ? (
                                      <small className="field__hint">
                                        {nightBotButtonTextError}
                                      </small>
                                    ) : null}
                                  </label>
                                </div>
                              ) : null}

                              {!hasNightBotButtonError && openHintKey === 'nightBotButton' ? (
                                <p
                                  id="night-bot-button-hint"
                                  className="settings-native-toggle__hint"
                                >
                                  Добавляет кнопку в сообщение о закрытии чата на ночь.
                                </p>
                              ) : null}
                            </div>
                          ) : null}

                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Блок ручного закрытия группы"
                          >
                            <span>Ручное закрытие</span>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Закрыть группу
                                </span>
                                <button
                                  type="button"
                                  className={cn(
                                    'settings-info-button',
                                    openHintKey === 'nightForceClose' && 'is-open',
                                  )}
                                  aria-label="Пояснение для ручного закрытия группы"
                                  aria-controls="night-force-close-hint"
                                  aria-expanded={openHintKey === 'nightForceClose'}
                                  onClick={() => toggleHint('nightForceClose')}
                                >
                                  <span aria-hidden>i</span>
                                </button>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить ручное закрытие группы"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.nightModeForceCloseEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('nightModeForceCloseEnabled', enabled);
                                    setFieldValue('nightModeForceCloseUntil', '');
                                    clearFieldError('nightModeForceCloseHours');
                                    clearFieldError('nightModeForceCloseDays');
                                    if (
                                      enabled &&
                                      !draft.nightModeForceCloseForever &&
                                      draft.nightModeForceCloseDays === 0 &&
                                      draft.nightModeForceCloseHours === 0
                                    ) {
                                      setFieldValue('nightModeForceCloseHours', 8);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'nightForceClose' ? (
                              <p
                                id="night-force-close-hint"
                                className="settings-native-toggle__hint"
                              >
                                Пока ручное закрытие активно, бот молча удаляет сообщения не-админов
                                без дополнительного текста.
                              </p>
                            ) : null}
                          </div>

                          {draft.nightModeForceCloseEnabled ? (
                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">
                                  Включить бессрочно
                                </span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить бессрочное ручное закрытие группы"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.nightModeForceCloseForever}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('nightModeForceCloseForever', enabled);
                                      setFieldValue('nightModeForceCloseUntil', '');
                                      clearFieldError('nightModeForceCloseHours');
                                      clearFieldError('nightModeForceCloseDays');
                                      if (
                                        !enabled &&
                                        draft.nightModeForceCloseDays === 0 &&
                                        draft.nightModeForceCloseHours === 0
                                      ) {
                                        setFieldValue('nightModeForceCloseHours', 8);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>
                          ) : null}

                          {draft.nightModeForceCloseEnabled && !draft.nightModeForceCloseForever ? (
                            <div
                              className={cn(
                                'settings-native-toggle',
                                'settings-native-toggle--nested',
                                hasNightForceCloseDurationError && 'field--error',
                              )}
                            >
                              <div className="settings-duration-stack">
                                <div className="settings-duration-stack__item">
                                  <div className="settings-native-toggle__row">
                                    <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                      Часы
                                    </span>
                                    <output
                                      className="settings-length-limit__value"
                                      aria-live="polite"
                                    >
                                      {draft.nightModeForceCloseHours}ч
                                    </output>
                                  </div>
                                  <input
                                    className="settings-length-limit__slider"
                                    type="range"
                                    min={NIGHT_FORCE_CLOSE_MIN_HOURS}
                                    max={NIGHT_FORCE_CLOSE_MAX_HOURS}
                                    step={1}
                                    value={draft.nightModeForceCloseHours}
                                    onChange={(event) => {
                                      setFieldValue(
                                        'nightModeForceCloseHours',
                                        Number(
                                          event.target.value,
                                        ) as ChatSettings['nightModeForceCloseHours'],
                                      );
                                      setFieldValue('nightModeForceCloseUntil', '');
                                      clearFieldError('nightModeForceCloseDays');
                                    }}
                                    aria-label="Сколько часов держать группу закрытой"
                                  />
                                  <div className="settings-length-limit__labels" aria-hidden>
                                    <span>{NIGHT_FORCE_CLOSE_MIN_HOURS}ч</span>
                                    <span>{NIGHT_FORCE_CLOSE_MAX_HOURS}ч</span>
                                  </div>
                                </div>

                                <div className="settings-duration-stack__item">
                                  <div className="settings-native-toggle__row">
                                    <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                      Дни
                                    </span>
                                    <output
                                      className="settings-length-limit__value"
                                      aria-live="polite"
                                    >
                                      {draft.nightModeForceCloseDays}д
                                    </output>
                                  </div>
                                  <input
                                    className="settings-length-limit__slider"
                                    type="range"
                                    min={NIGHT_FORCE_CLOSE_MIN_DAYS}
                                    max={NIGHT_FORCE_CLOSE_MAX_DAYS}
                                    step={1}
                                    value={draft.nightModeForceCloseDays}
                                    onChange={(event) => {
                                      setFieldValue(
                                        'nightModeForceCloseDays',
                                        Number(
                                          event.target.value,
                                        ) as ChatSettings['nightModeForceCloseDays'],
                                      );
                                      setFieldValue('nightModeForceCloseUntil', '');
                                      clearFieldError('nightModeForceCloseHours');
                                    }}
                                    aria-label="Сколько дней держать группу закрытой"
                                  />
                                  <div className="settings-length-limit__labels" aria-hidden>
                                    <span>{NIGHT_FORCE_CLOSE_MIN_DAYS}д</span>
                                    <span>{NIGHT_FORCE_CLOSE_MAX_DAYS}д</span>
                                  </div>
                                </div>
                              </div>

                              {nightForceCloseHoursError || nightForceCloseDaysError ? (
                                <small className="field__hint">
                                  {nightForceCloseHoursError ?? nightForceCloseDaysError}
                                </small>
                              ) : (
                                <p className="settings-native-toggle__hint">
                                  Бот будет молча удалять новые сообщения весь выбранный срок.
                                </p>
                              )}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '315ms' }}
              aria-label="Рассылки"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Рассылки"
                  summary={mailingHeaderSummary}
                  status={mailingCardStatus}
                  icon="send"
                  tone="sky"
                  open={expandedSections.mailing}
                  controls="settings-mailing-content"
                  onClick={() => toggleSection('mailing')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-mailing-content"
                open={expandedSections.mailing}
                title="Рассылки"
                summary={mailingHeaderSummary}
                onClose={() => toggleSection('mailing')}
                footer={showMailingPrimaryAction ? mailingDrilldownFooter : undefined}
              >
                <div
                  id="settings-mailing-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.mailing && 'is-open',
                  )}
                >
                  {expandedSections.mailing ? (
                    <div className="settings-section__collapse-inner settings-mailing">
                      {editingManagedBroadcast ? (
                        <div className="managed-broadcast-editor-note">
                          <strong>Редактирование текущей рассылки</strong>
                          <small>
                            {editingManagedBroadcast.sentCount > 0
                              ? `Уже отправлено: ${editingManagedBroadcast.sentCount} из ${editingManagedBroadcast.cycleCount}.`
                              : 'Контент уже сохранён. Здесь вы меняете календарь, охват и CTA.'}
                          </small>
                        </div>
                      ) : null}

                      {showMailingInlineReset ? (
                        <div className="mailing-inline-tools">
                          <button
                            type="button"
                            className="mailing-inline-tools__link"
                            onClick={
                              editingManagedBroadcast
                                ? handleCancelMailingEdit
                                : resetMailingComposer
                            }
                            disabled={isMailingBusy}
                          >
                            {editingManagedBroadcast
                              ? 'Отменить редактирование'
                              : 'Очистить рассылку'}
                          </button>
                        </div>
                      ) : null}

                      <div className="mailing-options-grid mailing-options-grid--timing">
                        <BroadcastSchedulePlanner
                          resetKey={mailingPlannerResetKey}
                          value={mailingScheduledSlots}
                          occupiedSlots={mailingOccupiedSlots}
                          error={mailingScheduleError}
                          disabled={isMailingBusy}
                          onSelectionStateChange={setMailingPlannerState}
                          onChange={(nextValue) => {
                            setMailingScheduledSlots(nextValue);
                            if (mailingScheduleError) {
                              setMailingScheduleError('');
                            }
                          }}
                        />
                      </div>

                      <div
                        className={cn(
                          'mailing-target-card',
                          !canApplyToAllChats && 'is-single-chat',
                        )}
                      >
                        <div className="mailing-target-card__row">
                          <div className="mailing-target-card__title-wrap">
                            <div className="mailing-card-title-row">
                              <span className="mailing-target-card__title">
                                Применить во всех чатах
                              </span>
                              <SettingsHintAnchor
                                hintKey="mailingTargets"
                                openHintKey={openHintKey}
                                onToggleHint={toggleHint}
                                label="Пояснение для массовой рассылки"
                              >
                                {canApplyToAllChats
                                  ? `Отправим в ${chatsCount} чатах, где у вас и у бота есть админ-права.`
                                  : 'Пока доступен только текущий чат.'}
                              </SettingsHintAnchor>
                            </div>
                            <small className="mailing-target-card__meta">
                              {mailingApplyToAllChats && canApplyToAllChats
                                ? `Выбрано чатов: ${chatsCount}`
                                : 'Отправка в текущий чат'}
                            </small>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Применить рассылку во всех чатах"
                          >
                            <input
                              type="checkbox"
                              checked={mailingApplyToAllChats && canApplyToAllChats}
                              onChange={(event) => setMailingApplyToAllChats(event.target.checked)}
                              disabled={!canApplyToAllChats || isMailingBusy}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="mailing-options-grid">
                        <div
                          className={cn(
                            'mailing-option-card',
                            mailingButtonEnabled && 'is-enabled',
                            (mailingButtonUrlError || mailingButtonTextError) && 'field--error',
                          )}
                        >
                          <div className="mailing-option-card__head">
                            <div className="mailing-option-card__title-wrap">
                              <div className="mailing-card-title-row">
                                <span className="mailing-option-card__title">Кнопка действия</span>
                                <SettingsHintAnchor
                                  hintKey="mailingButton"
                                  openHintKey={openHintKey}
                                  onToggleHint={toggleHint}
                                  label="Пояснение для кнопки рассылки"
                                >
                                  Кнопка ведёт на канал, пост или внешнюю форму. Ссылка должна быть
                                  `http/https`, подпись кнопки до 32 символов.
                                </SettingsHintAnchor>
                              </div>
                            </div>

                            <label
                              className="settings-native-switch"
                              aria-label="Добавить кнопку в рассылку"
                            >
                              <input
                                type="checkbox"
                                checked={mailingButtonEnabled}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  setMailingButtonEnabled(enabled);
                                  if (!enabled) {
                                    setMailingButtonUrlError('');
                                    setMailingButtonTextError('');
                                  }
                                }}
                                disabled={isMailingBusy}
                              />
                              <span className="toggle-switch" aria-hidden>
                                <span className="toggle-switch__thumb" />
                              </span>
                            </label>
                          </div>

                          {mailingButtonEnabled ? (
                            <div className="mailing-option-card__body">
                              <label
                                className={cn(
                                  'field settings-url-field',
                                  mailingButtonUrlError && 'field--error',
                                )}
                              >
                                <span className="field__label">Ссылка кнопки</span>
                                <input
                                  type="url"
                                  inputMode="url"
                                  value={mailingButtonUrl}
                                  onChange={(event) => {
                                    setMailingButtonUrl(event.target.value);
                                    if (mailingButtonUrlError) {
                                      setMailingButtonUrlError('');
                                    }
                                  }}
                                  placeholder="https://max.ru/channel/..."
                                  disabled={isMailingBusy}
                                />
                                {mailingButtonUrlError ? (
                                  <small className="field__hint">{mailingButtonUrlError}</small>
                                ) : null}
                              </label>

                              <label
                                className={cn(
                                  'field settings-text-field',
                                  mailingButtonTextError && 'field--error',
                                )}
                              >
                                <span className="field__label">Название кнопки</span>
                                <input
                                  type="text"
                                  maxLength={32}
                                  value={mailingButtonText}
                                  onChange={(event) => {
                                    setMailingButtonText(event.target.value);
                                    if (mailingButtonTextError) {
                                      setMailingButtonTextError('');
                                    }
                                  }}
                                  placeholder="Открыть"
                                  disabled={isMailingBusy}
                                />
                                {mailingButtonTextError ? (
                                  <small className="field__hint">{mailingButtonTextError}</small>
                                ) : null}
                              </label>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="managed-broadcasts-list">
                        <div className="managed-broadcasts-list__head">
                          <span className="managed-broadcasts-list__title">Текущие рассылки</span>
                          <small className="managed-broadcasts-list__meta">
                            {managedBroadcastsQuery.isLoading
                              ? 'Загрузка...'
                              : managedBroadcasts.length > 0
                                ? `${managedBroadcasts.length} в работе`
                                : 'Нет активных рассылок'}
                          </small>
                        </div>

                        {managedBroadcasts.map((broadcast) => {
                          const isOpen = expandedManagedBroadcastId === broadcast.id;
                          const progressLabel =
                            broadcast.scheduleMode === 'calendar'
                              ? `${broadcast.scheduledSlots.length} слота`
                              : `${broadcast.sentCount}/${broadcast.cycleCount}`;
                          const nextLabel = broadcast.nextSendAt
                            ? formatRemovalDateTime(broadcast.nextSendAt)
                            : 'ожидает правки';
                          const deliveryLabel =
                            broadcast.failedChats > 0
                              ? `${broadcast.deliveredChats}/${broadcast.targetChats} доставлено · ошибок ${broadcast.failedChats}`
                              : `${broadcast.deliveredChats}/${broadcast.targetChats} доставлено`;

                          return (
                            <div
                              key={broadcast.id}
                              className={cn(
                                'managed-broadcast-card',
                                isOpen && 'is-open',
                                (broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL') &&
                                  'is-failed',
                              )}
                            >
                              <button
                                type="button"
                                className="managed-broadcast-card__toggle"
                                aria-expanded={isOpen}
                                aria-controls={`managed-broadcast-${broadcast.id}`}
                                onClick={() =>
                                  setExpandedManagedBroadcastId((current) =>
                                    current === broadcast.id ? null : broadcast.id,
                                  )
                                }
                              >
                                <span className="managed-broadcast-card__main">
                                  <strong>
                                    {broadcast.status === 'PARTIAL'
                                      ? `Частично доставлено · повторить ${broadcast.failedChats}`
                                      : broadcast.status === 'FAILED'
                                        ? `Не доставлено · ошибок ${broadcast.failedChats}`
                                        : `Следующая: ${nextLabel}`}
                                  </strong>
                                  <small>{broadcast.textPreview}</small>
                                </span>
                                <span className="managed-broadcast-card__aside">
                                  <small>
                                    {broadcast.scheduleMode === 'calendar'
                                      ? `Календарь ${progressLabel}`
                                      : `Цикл ${progressLabel}`}
                                  </small>
                                  <SectionChevron isOpen={isOpen} />
                                </span>
                              </button>

                              <div
                                id={`managed-broadcast-${broadcast.id}`}
                                className={cn('managed-broadcast-card__body', isOpen && 'is-open')}
                              >
                                {isOpen ? (
                                  <>
                                    <div className="managed-broadcast-card__facts">
                                      <span>
                                        {broadcast.applyToAllChats
                                          ? 'Во все чаты'
                                          : 'Только этот чат'}
                                      </span>
                                      <span>{`Чатов: ${broadcast.targetChats}`}</span>
                                      <span>{broadcast.hasImage ? 'С фото' : 'Без фото'}</span>
                                      <span>
                                        {broadcast.buttonEnabled ? 'С кнопкой' : 'Без кнопки'}
                                      </span>
                                      <span>
                                        {broadcast.scheduleMode === 'calendar'
                                          ? `${broadcast.scheduledSlots.length} слотов`
                                          : broadcast.cycleEnabled
                                            ? `Каждые ${broadcast.cycleEveryHours}ч`
                                            : 'Одна отправка'}
                                      </span>
                                      <span>{deliveryLabel}</span>
                                      {broadcast.pendingChats > 0 ? (
                                        <span>{`Ожидают: ${broadcast.pendingChats}`}</span>
                                      ) : null}
                                    </div>
                                    {broadcast.lastError ? (
                                      <small className="field__hint">{broadcast.lastError}</small>
                                    ) : null}
                                    <div className="managed-broadcast-card__actions">
                                      {broadcast.canRetry ? (
                                        <button
                                          type="button"
                                          className="button button--accent"
                                          onClick={() =>
                                            retryManagedBroadcastMutation.mutate(broadcast.id)
                                          }
                                          disabled={isMailingBusy}
                                        >
                                          Повторить ошибки
                                        </button>
                                      ) : null}
                                      <button
                                        type="button"
                                        className="button button--ghost"
                                        onClick={() => handleEditManagedBroadcast(broadcast.id)}
                                        disabled={
                                          isMailingBusy ||
                                          loadManagedBroadcastMutation.isPending ||
                                          broadcast.canRetry
                                        }
                                      >
                                        {loadManagedBroadcastMutation.isPending &&
                                        expandedManagedBroadcastId === broadcast.id
                                          ? 'Открываем...'
                                          : 'Редактировать'}
                                      </button>
                                      <button
                                        type="button"
                                        className="button button--ghost"
                                        onClick={() =>
                                          cancelManagedBroadcastMutation.mutate(broadcast.id)
                                        }
                                        disabled={isMailingBusy}
                                      >
                                        Остановить
                                      </button>
                                    </div>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '360ms' }}
              aria-label="Обязательная подписка"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Обязательная подписка"
                  summary={requiredSubscriptionHeaderSummary}
                  status={requiredSubscriptionCardStatus}
                  icon="shield"
                  tone="sky"
                  open={expandedSections.requiredSubscription}
                  controls="settings-required-subscription-content"
                  onClick={() => toggleSection('requiredSubscription')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-required-subscription-content"
                open={expandedSections.requiredSubscription}
                title="Обязательная подписка"
                summary={requiredSubscriptionHeaderSummary}
                onClose={() => toggleSection('requiredSubscription')}
                footer={renderSectionSaveFooter('requiredSubscription', {
                  note: canApplyToAllChats
                    ? 'Сначала сохраните в этом чате.'
                    : 'Сначала сохраните здесь.',
                  applyToAllLabel: 'Применить во всех чатах',
                  emphasize: 'save',
                })}
              >
                <div
                  id="settings-required-subscription-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.requiredSubscription && 'is-open',
                  )}
                >
                  {expandedSections.requiredSubscription ? (
                    <div className="settings-section__collapse-inner managed-giveaway">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Требовать подписку перед сообщением
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'requiredSubscriptionEnabled' && 'is-open',
                              )}
                              aria-label="Пояснение для обязательной подписки"
                              aria-controls="required-subscription-enabled-hint"
                              aria-expanded={openHintKey === 'requiredSubscriptionEnabled'}
                              onClick={() => toggleHint('requiredSubscriptionEnabled')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить обязательную подписку перед отправкой сообщений"
                          >
                            <input
                              type="checkbox"
                              checked={draft.requiredSubscriptionEnabled}
                              onChange={(event) => {
                                setFieldValue('requiredSubscriptionEnabled', event.target.checked);
                                if (!event.target.checked) {
                                  clearFieldError('requiredSubscriptionChannelIds');
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'requiredSubscriptionEnabled' ? (
                          <p
                            id="required-subscription-enabled-hint"
                            className="settings-native-toggle__hint"
                          >
                            Без подписки сообщение удаляется.
                          </p>
                        ) : null}
                      </div>

                      <div className="managed-giveaway__section">
                        <div className="managed-giveaway__section-head">
                          <div className="managed-giveaway__section-copy">
                            <strong>Каналы для проверки</strong>
                            <small>
                              {requiredSubscriptionSelectedCount}/
                              {REQUIRED_SUBSCRIPTION_MAX_CHANNELS} выбрано
                            </small>
                          </div>

                          <SettingsHintAnchor
                            hintKey="requiredSubscriptionChannels"
                            openHintKey={openHintKey}
                            onToggleHint={toggleHint}
                            label="Пояснение для списка обязательных каналов"
                          >
                            Только ваши каналы с рабочей ссылкой.
                          </SettingsHintAnchor>
                        </div>

                        {requiredSubscriptionStaleCount > 0 ? (
                          <p
                            className={cn(
                              'settings-native-toggle__hint',
                              'settings-native-toggle__hint--danger',
                            )}
                          >
                            Есть недоступные каналы. Удалите их.
                          </p>
                        ) : null}

                        {selectedRequiredSubscriptionChannels.length > 0 ? (
                          <div className="managed-giveaway__prize-editor-list">
                            {selectedRequiredSubscriptionChannels.map((channel, index) => (
                              <div
                                key={`required-subscription-channel-${channel.id}`}
                                className="managed-giveaway__prize-editor-row"
                              >
                                <span className="managed-giveaway__prize-position">
                                  {index + 1}
                                </span>
                                <span
                                  className="managed-giveaway__selected-channel"
                                  title={channel.link}
                                >
                                  {channel.title}
                                </span>
                                <button
                                  type="button"
                                  className="managed-giveaway__prize-remove"
                                  onClick={() => removeRequiredSubscriptionChannel(channel.id)}
                                  aria-label={`Удалить канал ${channel.title}`}
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {staleRequiredSubscriptionChannelIds.length > 0 ? (
                          <div className="managed-giveaway__prize-editor-list">
                            {staleRequiredSubscriptionChannelIds.map((channelId, index) => (
                              <div
                                key={`required-subscription-stale-${channelId}`}
                                className="managed-giveaway__prize-editor-row"
                              >
                                <span className="managed-giveaway__prize-position">
                                  {selectedRequiredSubscriptionChannels.length + index + 1}
                                </span>
                                <span
                                  className="managed-giveaway__selected-channel"
                                  title={channelId}
                                >
                                  Канал недоступен для проверки · {channelId}
                                </span>
                                <button
                                  type="button"
                                  className="managed-giveaway__prize-remove"
                                  onClick={() => removeRequiredSubscriptionChannel(channelId)}
                                  aria-label={`Удалить недоступный канал ${channelId}`}
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {requiredSubscriptionChannelsError ? (
                          <small className="field__hint">{requiredSubscriptionChannelsError}</small>
                        ) : null}

                        <div className="managed-giveaway__channel-picker">
                          {channelsQuery.isLoading ? <span>Загружаем ваши каналы...</span> : null}
                          {channelsQuery.error ? (
                            <span>
                              Ошибка загрузки каналов: {formatApiError(channelsQuery.error)}
                            </span>
                          ) : null}
                          {!channelsQuery.isLoading &&
                          !channelsQuery.error &&
                          availableRequiredSubscriptionChannelChoices.length === 0 ? (
                            <span>
                              {requiredSubscriptionSelectedCount >=
                              REQUIRED_SUBSCRIPTION_MAX_CHANNELS
                                ? 'Достигнут лимит выбранных каналов.'
                                : 'Нет доступных каналов с рабочей ссылкой для добавления.'}
                            </span>
                          ) : null}
                          {!channelsQuery.isLoading && !channelsQuery.error
                            ? availableRequiredSubscriptionChannelChoices.map((channel) => (
                                <button
                                  key={`required-subscription-choice-${channel.id}`}
                                  type="button"
                                  className="managed-giveaway__channel-picker-item"
                                  onClick={() => addRequiredSubscriptionChannel(channel.id)}
                                  disabled={
                                    requiredSubscriptionSelectedCount >=
                                    REQUIRED_SUBSCRIPTION_MAX_CHANNELS
                                  }
                                >
                                  {channel.title}
                                </button>
                              ))
                            : null}
                        </div>
                      </div>

                      <div
                        className="settings-subsection-divider"
                        role="separator"
                        aria-label="Действия бота для обязательной подписки"
                      >
                        <span>Действия бота</span>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">1. Объяснение</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать объяснение об обязательной подписке"
                                onClick={() => toggleBotMessageEditor('requiredSubscription')}
                                disabled={!draft.requiredSubscriptionEnabled}
                                isOpen={openBotEditorKey === 'requiredSubscription'}
                              />
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'requiredSubscriptionBotMessage' && 'is-open',
                                )}
                                aria-label="Пояснение для объяснения об обязательной подписке"
                                aria-controls="required-subscription-bot-message-hint"
                                aria-expanded={openHintKey === 'requiredSubscriptionBotMessage'}
                                onClick={() => toggleHint('requiredSubscriptionBotMessage')}
                              >
                                <span aria-hidden>i</span>
                              </button>
                            </div>
                          </div>
                        </div>

                        {openHintKey === 'requiredSubscriptionBotMessage' ? (
                          <p
                            id="required-subscription-bot-message-hint"
                            className="settings-native-toggle__hint"
                          >
                            Берётся из текущего стиля речи. Можно заменить своим текстом.
                          </p>
                        ) : null}

                        {openBotEditorKey === 'requiredSubscription' ? (
                          <BotMessageEditor
                            editorKey="requiredSubscription"
                            botSpeechStyle={draft.botSpeechStyle}
                            value={draft.requiredSubscriptionBotMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'requiredSubscriptionBotMessageText',
                                nextValue as ChatSettings['requiredSubscriptionBotMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('requiredSubscriptionBotMessageText', '')}
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '372ms' }}
              aria-label="Сервисные настройки"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Сервисные"
                  summary=""
                  status={extraCardStatus}
                  icon="tools"
                  tone="amber"
                  open={expandedSections.extra}
                  controls="settings-extra-content"
                  onClick={() => toggleSection('extra')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-extra-content"
                open={expandedSections.extra}
                title="Сервисные"
                summary={extraHeaderSummary}
                onClose={() => toggleSection('extra')}
                footer={renderSectionSaveFooter('extra')}
              >
                <div
                  id="settings-extra-content"
                  className={cn('settings-section__collapse', expandedSections.extra && 'is-open')}
                >
                  {expandedSections.extra ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Удалять свои сообщения
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'deleteBotMessages' && 'is-open',
                              )}
                              aria-label="Пояснение для удаления своих сообщений ботом"
                              aria-controls="delete-bot-messages-hint"
                              aria-expanded={openHintKey === 'deleteBotMessages'}
                              onClick={() => toggleHint('deleteBotMessages')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить удаление собственных сообщений бота"
                          >
                            <input
                              type="checkbox"
                              checked={draft.deleteBotMessagesEnabled}
                              onChange={(event) =>
                                setFieldValue('deleteBotMessagesEnabled', event.target.checked)
                              }
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'deleteBotMessages' ? (
                          <p id="delete-bot-messages-hint" className="settings-native-toggle__hint">
                            Бот будет автоматически удалять собственные сообщения через выбранное
                            время.
                          </p>
                        ) : null}
                      </div>

                      {draft.deleteBotMessagesEnabled ? (
                        <div
                          className={cn(
                            'settings-native-toggle',
                            'settings-native-toggle--nested',
                            fieldErrors.deleteBotMessagesDelayMinutes && 'field--error',
                          )}
                        >
                          <div className="settings-native-toggle__row">
                            <span className="settings-native-toggle__title">
                              Через сколько удалять
                            </span>

                            <div
                              className="ban-duration-stepper"
                              role="group"
                              aria-label="Задержка удаления сообщений бота в минутах"
                            >
                              <button
                                type="button"
                                className="ban-duration-stepper__button"
                                onClick={() => adjustDeleteBotMessagesDelay(-1)}
                                disabled={
                                  draft.deleteBotMessagesDelayMinutes <=
                                  BOT_MESSAGES_DELETE_DELAY_MIN
                                }
                                aria-label="Уменьшить задержку удаления сообщений бота"
                              >
                                -
                              </button>

                              <output className="ban-duration-stepper__value" aria-live="polite">
                                {draft.deleteBotMessagesDelayMinutes} мин
                              </output>

                              <button
                                type="button"
                                className="ban-duration-stepper__button"
                                onClick={() => adjustDeleteBotMessagesDelay(1)}
                                disabled={
                                  draft.deleteBotMessagesDelayMinutes >=
                                  BOT_MESSAGES_DELETE_DELAY_MAX
                                }
                                aria-label="Увеличить задержку удаления сообщений бота"
                              >
                                +
                              </button>
                            </div>
                          </div>

                          {fieldErrors.deleteBotMessagesDelayMinutes ? (
                            <small className="field__hint">
                              {fieldErrors.deleteBotMessagesDelayMinutes}
                            </small>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Удалять спаммеров</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'deleteSpammers' && 'is-open',
                              )}
                              aria-label="Пояснение для удаления спаммеров"
                              aria-controls="delete-spammers-hint"
                              aria-expanded={openHintKey === 'deleteSpammers'}
                              onClick={() => toggleHint('deleteSpammers')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить удаление спаммеров"
                          >
                            <input
                              type="checkbox"
                              checked={draft.deleteSpammersEnabled}
                              onChange={(event) =>
                                setFieldValue('deleteSpammersEnabled', event.target.checked)
                              }
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'deleteSpammers' ? (
                          <p id="delete-spammers-hint" className="settings-native-toggle__hint">
                            База спаммеров ведется глобально. Когда тумблер включен, бот удаляет
                            сообщение спаммера и удаляет участника из текущего чата.
                          </p>
                        ) : null}
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Удалять ботов из группы
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'removeBotsFromGroup' && 'is-open',
                              )}
                              aria-label="Пояснение для удаления ботов из группы"
                              aria-controls="remove-bots-hint"
                              aria-expanded={openHintKey === 'removeBotsFromGroup'}
                              onClick={() => toggleHint('removeBotsFromGroup')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить удаление ботов из группы"
                          >
                            <input
                              type="checkbox"
                              checked={draft.removeBotsFromGroupEnabled}
                              onChange={(event) =>
                                setFieldValue('removeBotsFromGroupEnabled', event.target.checked)
                              }
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'removeBotsFromGroup' ? (
                          <p id="remove-bots-hint" className="settings-native-toggle__hint">
                            Если включено, бот-аккаунты будут автоматически удаляться из группы.
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>
          </div>
        </section>
      ) : null}

      {!settingsQuery.isLoading && !settingsQuery.error && !draft ? (
        <GlassCard>
          <StatusState
            tone="warning"
            title="Настройки не найдены"
            description="Повторите загрузку страницы."
          />
        </GlassCard>
      ) : null}
    </div>
  );
}
