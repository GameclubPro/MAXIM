import {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  BOT_SPEECH_STYLE_METADATA,
  BOT_SPEECH_STYLE_OPTIONS,
  DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES,
  MESSAGE_LIMITS_BLOCKED_WORDS_MAX,
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  applyBotSpeechStylePreset,
  chatRulesSchema,
  chatSettingsSchema,
  formatDeleteBotMessagesDelayLabel,
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  hasBotSpeechEditableOverrides,
  normalizeAllowlistDomain,
  normalizeAllowlistLink,
  normalizeStoredAllowlistEntry,
  normalizeMessageLimitsBlockedWordCandidate,
  stepDeleteBotMessagesDelayMinutes,
  type AllowlistMatchType,
  type BotSpeechEditableFieldKey,
  type BotSpeechStyle,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type DomainAllowlistEntry,
  type ManagedBroadcastDetails,
  type ManagedEntityHeader,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import botSpeechRobotImage from '../../../../bot.webp';
import botSpeechFriendlyImage from '../../../../frendly.webp';
import botSpeechIronicImage from '../../../../joker.webp';
import botSpeechPoliceImage from '../../../../police.webp';
import {
  BroadcastSchedulePlanner,
  type BroadcastSchedulePlannerSelectionState,
} from '../components/broadcast-schedule-planner';
import { ManagedGiveawayCard } from '../components/managed-giveaway-card';
import type { ManagedLinkButtonFieldsProps } from '../components/managed-link-button-fields';
import { ManagedPollCard } from '../components/managed-poll-card';
import type { PublishedRulesButtonToggleProps } from '../components/published-rules-button-toggle';
import { CompactStickyHeader } from '../components/ui/compact-sticky-header';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../components/ui/settings-section-toggle';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  addDomain,
  applySettingsSectionToAll,
  cancelManagedBroadcast,
  getBroadcastHandoffState,
  getManagedBroadcast,
  getSettingsScreen,
  handoffBroadcast,
  handoffRules,
  publishRules,
  removeDomain,
  resolveRequiredSubscriptionChannel,
  resetPublishedRules,
  retryManagedBroadcast,
  scheduleDomainRemoval,
  updateManagedBroadcast,
  updateRules,
  updateSettings,
} from '../lib/api/chat-settings-client';
import { getMe } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import type {
  BroadcastHandoffPayload,
  SendBroadcastPayload,
  UpdateChatRulesPayload,
} from '../lib/api/shared-types';
import { useKeyboardOpen } from '../lib/use-keyboard-open';
import {
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
} from '../lib/broadcast-schedule';
import { cn } from '../lib/cn';
import { maxNotify, openMaxBotLink, setMaxClosingConfirmation } from '../lib/max-bridge';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';
import { useManagedEntitiesSync } from '../lib/use-managed-entities-sync';
import {
  NIGHT_SECTION_SETTING_KEYS,
  applyNightModeBotMessageEnabledChange,
  applyNightModeEnabledChange,
  mergeNightSectionSettings,
} from './settings-page-state';

type FieldErrors = Partial<Record<keyof ChatSettings, string>>;
type ManagedBroadcastListItem = ChatSettingsScreenResponse['managedBroadcasts'][number];
type BroadcastCountdownPresentation = {
  label: string;
  value: string;
  caption: string;
};
type ManagedBroadcastCardTone = 'active' | 'warning' | 'danger' | 'muted';
type MailingWorkspaceView = 'compose' | 'active';
type DeleteDelayStepperProps = {
  title: string;
  value: number;
  fieldError?: string;
  groupAriaLabel: string;
  decreaseAriaLabel: string;
  increaseAriaLabel: string;
  onAdjust: (direction: number) => void;
};

const LazyManagedLinkButtonFields = lazy(() => import('../components/managed-link-button-fields'));
const LazyMessageLimitsBlockedWordPresets = lazy(
  () => import('../components/message-limits-blocked-word-presets'),
);
const LazyPublishedRulesButtonToggle = lazy(
  () => import('../components/published-rules-button-toggle'),
);

const AUTO_SAVE_DELAY_MS = 650;
const AUTO_MUTE_DURATION_MIN_HOURS = 1;
const AUTO_MUTE_DURATION_MAX_HOURS = 168;
const AUTO_MUTE_DURATION_PRESET_HOURS = [1, 6, 24, 168] as const;
const DUPLICATE_ALLOWED_COUNT_MIN = 0;
const DUPLICATE_ALLOWED_COUNT_MAX = 16;
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
const COMMERCIAL_SOFT_MAX = 24;
const COMMERCIAL_BALANCED_MAX = 69;
const BOT_MESSAGES_DELETE_DELAY_OPTIONS = DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES;
const DOMAIN_REMOVAL_MIN_FUTURE_MS = 30_000;
const MAX_BROADCAST_TEXT_LENGTH = 2_000;
const MIN_BROADCAST_CYCLE_HOURS = 1;
const THEMATIC_FILTERS_OWNER_USER_ID = '98315271';
const MAX_CHAT_RULES_TEXT_LENGTH = 2_000;
const MESSAGE_LIMITS_BLOCKED_WORDS_PREVIEW_COUNT = 9;
const DEFAULT_RULES_POST_BUTTON_TEXT = 'Открыть';
const BROADCAST_HOUR_MS = 60 * 60 * 1_000;
const DESKTOP_TOGGLE_ROW_BLOCKERS = [
  'a',
  'button',
  'input',
  'label',
  'select',
  'summary',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '.channel-settings-hint-anchor',
  '.channel-settings-hint-popover',
  '.settings-native-toggle__hint',
].join(', ');

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

function DeleteDelayStepper({
  title,
  value,
  fieldError,
  groupAriaLabel,
  decreaseAriaLabel,
  increaseAriaLabel,
  onAdjust,
}: DeleteDelayStepperProps) {
  return (
    <div
      className={cn(
        'settings-native-toggle',
        'settings-native-toggle--nested',
        fieldError && 'field--error',
      )}
    >
      <div className="settings-native-toggle__row">
        <span className="settings-native-toggle__title">{title}</span>

        <div className="ban-duration-stepper" role="group" aria-label={groupAriaLabel}>
          <button
            type="button"
            className="ban-duration-stepper__button"
            onClick={() => onAdjust(-1)}
            disabled={value <= BOT_MESSAGES_DELETE_DELAY_OPTIONS[0]}
            aria-label={decreaseAriaLabel}
          >
            -
          </button>

          <output className="ban-duration-stepper__value" aria-live="polite">
            {formatDeleteBotMessagesDelayLabel(value)}
          </output>

          <button
            type="button"
            className="ban-duration-stepper__button"
            onClick={() => onAdjust(1)}
            disabled={
              value >=
              BOT_MESSAGES_DELETE_DELAY_OPTIONS[BOT_MESSAGES_DELETE_DELAY_OPTIONS.length - 1]
            }
            aria-label={increaseAriaLabel}
          >
            +
          </button>
        </div>
      </div>

      {fieldError ? <small className="field__hint">{fieldError}</small> : null}
    </div>
  );
}

function ManagedLinkButtonFieldsSlot(props: ManagedLinkButtonFieldsProps) {
  return (
    <Suspense fallback={null}>
      <LazyManagedLinkButtonFields {...props} />
    </Suspense>
  );
}

function PublishedRulesButtonToggleSlot(props: PublishedRulesButtonToggleProps) {
  return (
    <Suspense fallback={null}>
      <LazyPublishedRulesButtonToggle {...props} />
    </Suspense>
  );
}

function splitMessageLimitsBlockedWordsInput(value: string): string[] {
  return value
    .split(/[\s,;\n]+/u)
    .map((item) => normalizeMessageLimitsBlockedWordCandidate(item))
    .filter((item): item is string => Boolean(item));
}

type AutoMuteDurationKey =
  | 'duplicateMuteDurationHours'
  | 'linkMuteDurationHours'
  | 'messageLimitsMuteDurationHours'
  | 'profanityMuteDurationHours'
  | 'requiredSubscriptionMuteDurationHours'
  | 'textFiltersMuteDurationHours'
  | 'thematicFiltersMuteDurationHours';
type AutoMuteEnabledKey =
  | 'duplicateMuteEnabled'
  | 'linkMuteEnabled'
  | 'messageLimitsMuteEnabled'
  | 'profanityMuteEnabled'
  | 'requiredSubscriptionMuteEnabled'
  | 'textFiltersMuteEnabled'
  | 'thematicFiltersMuteEnabled';
type HintKey =
  | 'antiSpam'
  | 'deleteSpammers'
  | 'commentsEnabled'
  | 'commentsAdmins'
  | 'commentsChatBroadcasts'
  | 'linkAllowlistScope'
  | 'linkAllowlistMode'
  | 'linkBotMessage'
  | 'linkWarnMessage'
  | 'linkBotButton'
  | 'greetingEnabled'
  | 'greetingBotMessage'
  | 'greetingDeleteBotMessages'
  | 'greetingBotButton'
  | 'textFiltersProfanity'
  | 'textFiltersCommercial'
  | 'commercialSensitivity'
  | 'textFiltersBotMessage'
  | 'textFiltersWarnMessage'
  | 'textFiltersBotButton'
  | 'duplicateBotMessage'
  | 'duplicateBotButton'
  | 'maxMessageLength'
  | 'messageCountLimit'
  | 'photoCooldown'
  | 'stickerCooldown'
  | 'messageLimitsBotMessage'
  | 'messageLimitsBotButton'
  | 'nightModeEnabled'
  | 'nightForceClose'
  | 'nightBotMessage'
  | 'nightComments'
  | 'nightOpenMessage'
  | 'nightBotButton'
  | 'requiredSubscriptionEnabled'
  | 'requiredSubscriptionChannels'
  | 'requiredSubscriptionBotMessage'
  | 'requiredSubscriptionWarnMessage'
  | 'deleteBotMessages'
  | 'removeBotsFromGroup'
  | 'mailingStudio'
  | 'mailingText'
  | 'mailingTargets'
  | 'mailingImage'
  | 'mailingButton'
  | 'mailingSchedule'
  | 'mailingCycle'
  | 'mailingSend';
type BotMessageEditorKey =
  | 'link'
  | 'greeting'
  | 'requiredSubscription'
  | 'textFilters'
  | 'duplicate'
  | 'messageLimits'
  | 'night'
  | 'nightOpen';
type WarnMessageEditorKey = 'linkWarn' | 'requiredSubscriptionWarn' | 'textFiltersWarn';
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
  | 'comments'
  | 'mailing'
  | 'extra';
type ApplySectionKey = Exclude<
  SettingsSectionKey,
  'comments' | 'mailing' | 'rules' | 'poll' | 'giveaway'
>;

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
  comments: false,
  mailing: false,
  extra: false,
};

const SECTION_LABELS: Record<ApplySectionKey, string> = {
  links: 'Ссылки',
  greeting: 'Приветствие',
  profanityFilter: 'Мат и оскорбления',
  commercialFilter: 'Коммерческая реклама',
  thematicFilters: 'Кодовые слова',
  duplicates: 'Повторы',
  limits: 'Ограничения',
  night: 'Ночной режим',
  requiredSubscription: 'Подписка на канал',
  extra: 'Сервис',
};

const SECTION_SETTING_KEYS: Record<ApplySectionKey, readonly (keyof ChatSettings)[]> = {
  links: [
    'linkPolicy',
    'linkBotMessageEnabled',
    'linkBotMessageText',
    'linkWarnEnabled',
    'linkWarnMessageText',
    'linkMuteEnabled',
    'linkMuteDurationHours',
    'linkBanEnabled',
    'linkBotButtonEnabled',
    'linkBotButtonUrl',
    'linkBotButtonText',
  ],
  greeting: [
    'greetingEnabled',
    'greetingBotMessageEnabled',
    'greetingDeleteBotMessageEnabled',
    'greetingDeleteBotMessageDelayMinutes',
    'greetingBotMessageText',
    'greetingBotButtonEnabled',
    'greetingBotButtonUrl',
    'greetingBotButtonText',
    'greetingRulesButtonEnabled',
  ],
  profanityFilter: [
    'russianProfanityFilterEnabled',
    'profanityBotMessageEnabled',
    'profanityWarnEnabled',
    'profanityMuteEnabled',
    'profanityMuteDurationHours',
    'profanityBanEnabled',
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
    'textFiltersMuteEnabled',
    'textFiltersMuteDurationHours',
    'textFiltersBanEnabled',
    'textFiltersBotButtonEnabled',
    'textFiltersBotButtonUrl',
    'textFiltersBotButtonText',
  ],
  thematicFilters: [
    'thematicCodewordEnabled',
    'thematicCodeword',
    'thematicFiltersBotMessageEnabled',
    'thematicFiltersWarnEnabled',
    'thematicFiltersMuteEnabled',
    'thematicFiltersMuteDurationHours',
    'thematicFiltersBanEnabled',
    'thematicFiltersBotButtonEnabled',
    'thematicFiltersBotButtonUrl',
    'thematicFiltersBotButtonText',
  ],
  duplicates: [
    'antiDuplicateEnabled',
    'duplicateWarnEnabled',
    'duplicateMuteEnabled',
    'duplicateBanEnabled',
    'duplicateWarnWindowSec',
    'duplicateWarnMaxCount',
    'duplicateMuteWindowSec',
    'duplicateMuteMaxCount',
    'duplicateMuteDurationHours',
    'duplicateBanWindowSec',
    'duplicateBanMaxCount',
    'duplicateBotMessageEnabled',
    'duplicateBotMessageText',
    'duplicateBotButtonEnabled',
    'duplicateBotButtonUrl',
    'duplicateBotButtonText',
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
    'messageLimitsBlockedWords',
    'messageLimitsBotMessageEnabled',
    'messageLimitsBotMessageText',
    'messageLimitsWarnEnabled',
    'messageLimitsBanEnabled',
    'messageLimitsMuteEnabled',
    'messageLimitsMuteDurationHours',
    'messageLimitsBotButtonEnabled',
    'messageLimitsBotButtonUrl',
    'messageLimitsBotButtonText',
  ],
  night: [...NIGHT_SECTION_SETTING_KEYS],
  requiredSubscription: [
    'requiredSubscriptionEnabled',
    'requiredSubscriptionChannelIds',
    'requiredSubscriptionBotMessageEnabled',
    'requiredSubscriptionBotMessageText',
    'requiredSubscriptionWarnEnabled',
    'requiredSubscriptionWarnMessageText',
    'requiredSubscriptionMuteEnabled',
    'requiredSubscriptionMuteDurationHours',
    'requiredSubscriptionBanEnabled',
  ],
  extra: [
    'deleteSpammersEnabled',
    'deleteBotMessagesEnabled',
    'deleteBotMessagesDelayMinutes',
    'removeBotsFromGroupEnabled',
  ],
};

const COMMENTS_SETTING_KEYS = [
  'commentsEnabled',
  'commentsAdminsEnabled',
  'commentsChatBroadcastsEnabled',
] as const satisfies ReadonlyArray<keyof ChatSettings>;

function resolveDuplicateSharedWindowSec(
  settings: Pick<
    ChatSettings,
    | 'duplicateWarnEnabled'
    | 'duplicateMuteEnabled'
    | 'duplicateBanEnabled'
    | 'duplicateWarnWindowSec'
    | 'duplicateMuteWindowSec'
    | 'duplicateBanWindowSec'
  >,
): number {
  if (settings.duplicateWarnEnabled) {
    return settings.duplicateWarnWindowSec;
  }

  if (settings.duplicateMuteEnabled) {
    return settings.duplicateMuteWindowSec;
  }

  if (settings.duplicateBanEnabled) {
    return settings.duplicateBanWindowSec;
  }

  return settings.duplicateWarnWindowSec;
}

function resolveDuplicateFirstThreshold(
  settings: Pick<
    ChatSettings,
    | 'duplicateWarnEnabled'
    | 'duplicateMuteEnabled'
    | 'duplicateBanEnabled'
    | 'duplicateWarnMaxCount'
    | 'duplicateMuteMaxCount'
    | 'duplicateBanMaxCount'
  >,
): number {
  if (settings.duplicateWarnEnabled) {
    return settings.duplicateWarnMaxCount;
  }

  if (settings.duplicateMuteEnabled) {
    return settings.duplicateMuteMaxCount;
  }

  if (settings.duplicateBanEnabled) {
    return settings.duplicateBanMaxCount;
  }

  return settings.duplicateWarnMaxCount;
}

function resolveDuplicateAllowedCount(
  settings: Pick<
    ChatSettings,
    | 'duplicateBotMessageEnabled'
    | 'duplicateWarnEnabled'
    | 'duplicateMuteEnabled'
    | 'duplicateBanEnabled'
    | 'duplicateWarnMaxCount'
    | 'duplicateMuteMaxCount'
    | 'duplicateBanMaxCount'
  >,
): number {
  return Math.max(
    DUPLICATE_ALLOWED_COUNT_MIN,
    Math.min(
      DUPLICATE_ALLOWED_COUNT_MAX,
      resolveDuplicateFirstThreshold(settings) - (settings.duplicateBotMessageEnabled ? 2 : 1),
    ),
  );
}

function buildDuplicateFlowSettings(
  settings: Pick<
    ChatSettings,
    | 'duplicateBotMessageEnabled'
    | 'duplicateWarnEnabled'
    | 'duplicateMuteEnabled'
    | 'duplicateBanEnabled'
  > & {
    allowedCount: number;
    windowSec: number;
  },
): Pick<
  ChatSettings,
  | 'duplicateWarnWindowSec'
  | 'duplicateMuteWindowSec'
  | 'duplicateBanWindowSec'
  | 'duplicateWarnMaxCount'
  | 'duplicateMuteMaxCount'
  | 'duplicateBanMaxCount'
> {
  const allowedCount = Math.max(
    DUPLICATE_ALLOWED_COUNT_MIN,
    Math.min(DUPLICATE_ALLOWED_COUNT_MAX, Math.round(settings.allowedCount)),
  );
  const windowSec = Math.max(3_600, Math.min(604_800, Math.round(settings.windowSec)));
  const warnThreshold = allowedCount + (settings.duplicateBotMessageEnabled ? 2 : 1);
  const muteThreshold = warnThreshold + (settings.duplicateWarnEnabled ? 1 : 0);
  const banThreshold = muteThreshold + (settings.duplicateMuteEnabled ? 1 : 0);

  return {
    duplicateWarnWindowSec: windowSec,
    duplicateMuteWindowSec: windowSec,
    duplicateBanWindowSec: windowSec,
    duplicateWarnMaxCount: warnThreshold,
    duplicateMuteMaxCount: muteThreshold,
    duplicateBanMaxCount: banThreshold,
  };
}

function normalizeDuplicateFlowSettings(settings: ChatSettings): ChatSettings {
  return {
    ...settings,
    ...buildDuplicateFlowSettings({
      duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
      duplicateWarnEnabled: settings.duplicateWarnEnabled,
      duplicateMuteEnabled: settings.duplicateMuteEnabled,
      duplicateBanEnabled: settings.duplicateBanEnabled,
      allowedCount: resolveDuplicateAllowedCount(settings),
      windowSec: resolveDuplicateSharedWindowSec(settings),
    }),
  };
}

function formatDuplicateAllowanceLabel(count: number): string {
  if (count === 0) {
    return 'с первого дубля';
  }

  if (count === 1) {
    return 'после 1 дубля';
  }

  return `после ${count} дублей`;
}

const LINK_POLICY_OPTIONS: Array<{
  value: ChatSettings['linkPolicy'];
  eyebrow: string;
  label: string;
  description: string;
}> = [
  {
    value: 'ALERT_ONLY',
    eyebrow: 'Наблюдение',
    label: 'Не удалять ссылки',
    description: 'Ссылки остаются в чате, а блок санкций скрыт.',
  },
  {
    value: 'BLOCKLIST_ONLY',
    eyebrow: 'Жёсткий режим',
    label: 'Удалять все ссылки',
    description: 'Любая ссылка удаляется сразу.',
  },
  {
    value: 'ALLOWLIST_ONLY',
    eyebrow: 'Разрешённые',
    label: 'Удалять кроме...',
    description: 'Ниже можно добавить точные ссылки и целые домены.',
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
  requiredSubscriptionWarn: 'requiredSubscriptionWarnMessageText',
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
    'Плейсхолдеры: {user}, {duplicate_context}, {sanction}, {mute_duration}. Старый {ban_duration} тоже поддерживается. Поддерживается Markdown MAX.',
  messageLimits:
    'Плейсхолдеры: {user}, {message_status}, {reason}, {actual_length}, {max_length}, {photo_cooldown_hours}, {message_limit_count}, {message_limit_window_hours}. Поддерживается Markdown MAX.',
  night:
    'Плейсхолдеры: {user}, {night_window}, {night_timezone}, {night_status}. Поддерживается Markdown MAX.',
  nightOpen:
    'Плейсхолдеры: {night_window}, {night_timezone}, {opening_status}. Поддерживается Markdown MAX.',
};

const WARN_MESSAGE_TEMPLATE_HINTS: Record<WarnMessageEditorKey, string> = {
  linkWarn: 'Плейсхолдеры: {user}, {warning}, {reason}. Поддерживается Markdown MAX.',
  requiredSubscriptionWarn:
    'Плейсхолдеры: {user}, {warning}, {reason}, {channels}. Поддерживается Markdown MAX.',
  textFiltersWarn: 'Плейсхолдеры: {user}, {warning}, {reason}. Поддерживается Markdown MAX.',
};

function serializeRulesDraftPayload(
  value:
    | Pick<
        ChatRules,
        | 'text'
        | 'imageBase64'
        | 'imageMimeType'
        | 'imageFileName'
        | 'autoTextEnabled'
        | 'buttonEnabled'
        | 'buttonUrl'
        | 'buttonText'
      >
    | Pick<
        UpdateChatRulesPayload,
        | 'text'
        | 'imageBase64'
        | 'imageMimeType'
        | 'imageFileName'
        | 'autoTextEnabled'
        | 'buttonEnabled'
        | 'buttonUrl'
        | 'buttonText'
      >,
): string {
  return JSON.stringify({
    text: value.text,
    imageBase64: value.imageBase64,
    imageMimeType: value.imageMimeType,
    imageFileName: value.imageFileName,
    autoTextEnabled: value.autoTextEnabled,
    buttonEnabled: value.buttonEnabled,
    buttonUrl: value.buttonUrl,
    buttonText: value.buttonText,
  });
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
  mute: string;
  ban: string;
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
    mute: renderBotMessageTemplatePreview(getSpeechSystemTemplateFallback(style, 'muteNotice'), {
      user: 'Алексей',
      mute_duration: '24 часа',
      ban_duration: '24 часа',
    }),
    ban: renderBotMessageTemplatePreview(getSpeechSystemTemplateFallback(style, 'topicBan'), {
      user: 'Алексей',
      reason: 'повторные нарушения правил чата',
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

function formatDateTimeInTimeZone(
  value: string | null,
  options: Intl.DateTimeFormatOptions,
  timeZone?: string | null,
): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  const formatterOptions: Intl.DateTimeFormatOptions = {
    ...options,
    ...(timeZone?.trim() ? { timeZone: timeZone.trim() } : {}),
  };

  try {
    return new Intl.DateTimeFormat('ru-RU', formatterOptions).format(parsed);
  } catch {
    return new Intl.DateTimeFormat('ru-RU', options).format(parsed);
  }
}

function formatRemovalDateTime(value: string | null, timeZone?: string | null): string {
  return formatDateTimeInTimeZone(
    value,
    {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
    timeZone,
  );
}

function formatAllowlistModeLabel(matchType: AllowlistMatchType): string {
  return matchType === 'DOMAIN' ? 'Весь домен' : 'Точная ссылка';
}

function formatAllowlistMetaLabel(entry: DomainAllowlistEntry, scheduledAtLabel: string): string {
  const targetLabel =
    entry.matchType === 'DOMAIN'
      ? 'Домен разрешен без срока удаления.'
      : 'Ссылка разрешена без срока удаления.';

  if (!scheduledAtLabel) {
    return targetLabel;
  }

  return `Удаление: ${scheduledAtLabel}`;
}

const ALLOWLIST_MATCH_OPTIONS: Array<{ value: AllowlistMatchType; label: string }> = [
  { value: 'EXACT', label: 'Точная ссылка' },
  { value: 'DOMAIN', label: 'Весь домен' },
];

function formatCompactBroadcastDateTime(value: string | null, timeZone?: string | null): string {
  return formatDateTimeInTimeZone(
    value,
    {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
    timeZone,
  );
}

function formatRussianCountLabel(
  count: number,
  singular: string,
  few: string,
  plural: string,
): string {
  const safeCount = Math.max(0, Math.trunc(count));
  const remainder100 = safeCount % 100;
  const remainder10 = safeCount % 10;

  if (remainder100 >= 11 && remainder100 <= 19) {
    return `${safeCount} ${plural}`;
  }

  if (remainder10 === 1) {
    return `${safeCount} ${singular}`;
  }

  if (remainder10 >= 2 && remainder10 <= 4) {
    return `${safeCount} ${few}`;
  }

  return `${safeCount} ${plural}`;
}

function formatBroadcastCountdownValue(remainingMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}д ${String(hours).padStart(2, '0')}ч`;
  }

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}ч ${String(minutes).padStart(2, '0')}м`;
  }

  if (minutes > 0) {
    return `${minutes}м`;
  }

  return '<1м';
}

function resolveBroadcastCountdown(
  nextSendAt: string | null,
  nowMs: number,
  scheduleTimezone?: string | null,
): BroadcastCountdownPresentation | null {
  if (!nextSendAt) {
    return null;
  }

  const targetMs = new Date(nextSendAt).getTime();
  if (!Number.isFinite(targetMs) || targetMs <= nowMs) {
    return null;
  }

  return {
    label: 'До отправки',
    value: formatBroadcastCountdownValue(targetMs - nowMs),
    caption: formatCompactBroadcastDateTime(nextSendAt, scheduleTimezone),
  };
}

function resolveManagedBroadcastCardTone(
  broadcast: ManagedBroadcastListItem,
): ManagedBroadcastCardTone {
  if (broadcast.status === 'FAILED') {
    return 'danger';
  }
  if (broadcast.status === 'PARTIAL') {
    return 'warning';
  }
  if (broadcast.status === 'COMPLETED' || broadcast.status === 'CANCELED') {
    return 'muted';
  }
  return 'active';
}

function resolveManagedBroadcastCardBadge(broadcast: ManagedBroadcastListItem): string {
  if (broadcast.status === 'PARTIAL') {
    return 'Нужно действие';
  }
  if (broadcast.status === 'FAILED') {
    return 'Пауза';
  }
  if (broadcast.status === 'COMPLETED') {
    return 'Завершена';
  }
  if (broadcast.status === 'CANCELED') {
    return 'Остановлена';
  }
  return 'В работе';
}

function resolveManagedBroadcastCardTitle(broadcast: ManagedBroadcastListItem): string {
  if (broadcast.status === 'PARTIAL') {
    return 'Есть ошибки доставки';
  }
  if (broadcast.status === 'FAILED') {
    return 'Нужно повторить отправку';
  }
  if (broadcast.status === 'COMPLETED') {
    return 'Рассылка завершена';
  }
  if (broadcast.status === 'CANCELED') {
    return 'Рассылка остановлена';
  }
  return broadcast.nextSendAt ? 'Следующая отправка' : 'Активная рассылка';
}

function resolveManagedBroadcastMetric(
  broadcast: ManagedBroadcastListItem,
  nowMs: number,
): BroadcastCountdownPresentation & { tone: ManagedBroadcastCardTone } {
  const countdown = resolveBroadcastCountdown(
    broadcast.nextSendAt,
    nowMs,
    broadcast.scheduleTimezone,
  );
  if (countdown && (broadcast.status === 'ACTIVE' || broadcast.status === 'PARTIAL')) {
    return {
      ...countdown,
      tone: broadcast.status === 'PARTIAL' ? 'warning' : 'active',
    };
  }

  if (broadcast.failedChats > 0) {
    return {
      label: 'Ошибки',
      value: String(broadcast.failedChats),
      caption: formatRussianCountLabel(broadcast.failedChats, 'чат', 'чата', 'чатов'),
      tone: broadcast.status === 'FAILED' ? 'danger' : 'warning',
    };
  }

  if (broadcast.pendingChats > 0) {
    return {
      label: 'В очереди',
      value: String(broadcast.pendingChats),
      caption: formatRussianCountLabel(broadcast.pendingChats, 'чат', 'чата', 'чатов'),
      tone: 'active',
    };
  }

  return {
    label: 'Доставлено',
    value: `${broadcast.deliveredChats}/${broadcast.targetChats}`,
    caption: broadcast.applyToAllChats ? 'все чаты' : 'текущий чат',
    tone: broadcast.status === 'COMPLETED' ? 'muted' : 'active',
  };
}

function buildManagedBroadcastFactChips(broadcast: ManagedBroadcastListItem): string[] {
  const scopeLabel = broadcast.applyToAllChats
    ? formatRussianCountLabel(broadcast.targetChats, 'чат', 'чата', 'чатов')
    : 'Текущий чат';
  const scheduleLabel =
    broadcast.scheduleMode === 'calendar'
      ? formatRussianCountLabel(broadcast.scheduledSlots.length, 'слот', 'слота', 'слотов')
      : broadcast.cycleEnabled
        ? `Цикл ${broadcast.sentCount}/${broadcast.cycleCount}`
        : '1 отправка';
  const extras = [broadcast.buttonEnabled ? 'CTA' : null, broadcast.hasImage ? 'Фото' : null]
    .filter((item): item is string => Boolean(item))
    .join(' · ');

  return [
    scopeLabel,
    scheduleLabel,
    extras || null,
    broadcast.pendingChats > 0 ? `В очереди ${broadcast.pendingChats}` : null,
  ].filter((item): item is string => Boolean(item));
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

function resolveCommercialSensitivityConfig(value: number): {
  sensitivity: ChatSettings['commercialAdsSensitivity'];
  warnThreshold: number;
  deleteThreshold: number;
} {
  const safe = clampCommercialSlider(value);

  if (safe <= COMMERCIAL_SOFT_MAX) {
    const progress = safe / COMMERCIAL_SOFT_MAX;
    return {
      sensitivity: 'BALANCED',
      warnThreshold: Math.round(60 + (54 - 60) * progress),
      deleteThreshold: Math.round(82 + (74 - 82) * progress),
    };
  }

  if (safe <= COMMERCIAL_BALANCED_MAX) {
    const progress = (safe - (COMMERCIAL_SOFT_MAX + 1)) / (COMMERCIAL_BALANCED_MAX - 25);
    return {
      sensitivity: 'BALANCED',
      warnThreshold: Math.round(53 + (45 - 53) * progress),
      deleteThreshold: Math.round(73 + (65 - 73) * progress),
    };
  }

  const progress = (safe - 70) / 30;
  return {
    sensitivity: 'STRICT',
    warnThreshold: Math.round(44 + (38 - 44) * progress),
    deleteThreshold: Math.round(63 + (55 - 63) * progress),
  };
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
    const progress = Math.max(0, Math.min(1, (44 - warn) / 6));
    return Math.round(70 + progress * 30);
  }

  if (warn >= 54) {
    const progress = Math.max(0, Math.min(1, (60 - warn) / 6));
    return Math.round(progress * COMMERCIAL_SOFT_MAX);
  }

  const progress = Math.max(0, Math.min(1, (53 - warn) / 8));
  return Math.round(25 + progress * (COMMERCIAL_BALANCED_MAX - 25));
}

function normalizeLegacyChatCommentScope(settings: ChatSettings): ChatSettings {
  if (!settings.commentsAllEnabled) {
    return settings;
  }

  return {
    ...settings,
    commentsAllEnabled: false,
  };
}

function mergeSectionSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
  section: ApplySectionKey,
): ChatSettings {
  if (section === 'night') {
    return mergeNightSectionSettings(targetSettings, sourceSettings);
  }

  const nextSettings = { ...targetSettings } as ChatSettings;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of SECTION_SETTING_KEYS[section]) {
    nextRecord[key] = sourceRecord[key];
  }

  return nextSettings;
}

function mergeCommentsSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
): ChatSettings {
  const nextSettings = { ...targetSettings } as ChatSettings;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of COMMENTS_SETTING_KEYS) {
    nextRecord[key] = sourceRecord[key];
  }

  nextSettings.commentsAllEnabled = false;

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

function getRouteChatAvatarUrl(state: unknown): string | null {
  if (
    typeof state === 'object' &&
    state &&
    'avatarUrl' in state &&
    typeof state.avatarUrl === 'string'
  ) {
    const normalized = state.avatarUrl.trim();
    return normalized || null;
  }

  return null;
}

function resolveDesktopToggleRowLabel(target: EventTarget | null): HTMLLabelElement | null {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function' ||
    !window.matchMedia('(hover: hover) and (pointer: fine)').matches ||
    !(target instanceof HTMLElement)
  ) {
    return null;
  }

  if (window.getSelection()?.type === 'Range') {
    return null;
  }

  if (target.closest(DESKTOP_TOGGLE_ROW_BLOCKERS)) {
    return null;
  }

  const row = target.closest('.settings-native-toggle__row');
  if (!row) {
    return null;
  }

  const switchLabel = row.querySelector<HTMLLabelElement>('.settings-native-switch');
  const switchInput = switchLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!switchLabel || !switchInput || switchInput.disabled) {
    return null;
  }

  return switchLabel;
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

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      focusable="false"
      width="18"
      height="18"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.75v4.8l3.45 1.95" strokeLinecap="round" strokeLinejoin="round" />
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
  const [rulesAutoFillSeedText, setRulesAutoFillSeedText] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [, setRulesTextError] = useState('');
  const [, setRulesImageError] = useState('');
  const [rulesButtonUrlError, setRulesButtonUrlError] = useState('');
  const [rulesButtonTextError, setRulesButtonTextError] = useState('');
  const [rulesButtonFieldsTouched, setRulesButtonFieldsTouched] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [domainInputMode, setDomainInputMode] = useState<AllowlistMatchType>('EXACT');
  const [domainInputError, setDomainInputError] = useState('');
  const [messageLimitsBlockedWordsInput, setMessageLimitsBlockedWordsInput] = useState('');
  const [messageLimitsBlockedWordsExpanded, setMessageLimitsBlockedWordsExpanded] = useState(false);
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
  const [mailingScheduleTimezone, setMailingScheduleTimezone] = useState(() =>
    resolveBroadcastScheduleTimezone(),
  );
  const [mailingBotHasContent, setMailingBotHasContent] = useState(false);
  const [, setMailingScheduleEnabled] = useState(false);
  const [, setMailingScheduleDays] = useState(0);
  const [, setMailingScheduleTime] = useState(() =>
    toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)),
  );
  const [, setMailingCycleEnabled] = useState(false);
  const [, setMailingCycleEveryHours] = useState(MIN_BROADCAST_CYCLE_HOURS);
  const [, setMailingCycleCount] = useState(2);
  const [, setMailingTextError] = useState('');
  const [mailingButtonUrlError, setMailingButtonUrlError] = useState('');
  const [mailingButtonTextError, setMailingButtonTextError] = useState('');
  const [, setMailingImageError] = useState('');
  const [mailingScheduleError, setMailingScheduleError] = useState('');
  const [, setMailingCycleError] = useState('');
  const [requiredSubscriptionExternalChannelValue, setRequiredSubscriptionExternalChannelValue] =
    useState('');
  const [requiredSubscriptionExternalChannelError, setRequiredSubscriptionExternalChannelError] =
    useState('');

  useEffect(() => {
    const { body } = document;
    body.classList.add('settings-home-page-open');

    return () => {
      body.classList.remove('settings-home-page-open');
    };
  }, []);
  const [resolvedRequiredSubscriptionChannels, setResolvedRequiredSubscriptionChannels] = useState<
    ManagedEntityHeader[]
  >([]);
  const [mailingPlannerResetKey, setMailingPlannerResetKey] = useState(0);
  const [mailingPlannerState, setMailingPlannerState] =
    useState<BroadcastSchedulePlannerSelectionState>(EMPTY_BROADCAST_PLANNER_STATE);
  const [editingManagedBroadcast, setEditingManagedBroadcast] =
    useState<ManagedBroadcastDetails | null>(null);
  const [mailingNowMs, setMailingNowMs] = useState(() => Date.now());
  const [mailingWorkspaceView, setMailingWorkspaceView] = useState<MailingWorkspaceView>('compose');
  const [duplicateWindowInputValue, setDuplicateWindowInputValue] = useState('');
  const [rulesFailedSnapshot, setRulesFailedSnapshot] = useState('');
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const [openMuteDurationKey, setOpenMuteDurationKey] = useState<AutoMuteDurationKey | null>(null);
  const [openBotEditorKey, setOpenBotEditorKey] = useState<BotMessageEditorKey | null>(null);
  const [openWarnEditorKey, setOpenWarnEditorKey] = useState<WarnMessageEditorKey | null>(null);
  const [pendingSpeechStyle, setPendingSpeechStyle] = useState<BotSpeechStyle | null>(null);
  const [expandedSections, setExpandedSections] =
    useState<Record<SettingsSectionKey, boolean>>(INITIAL_EXPANDED_SECTIONS);
  const isLinksKeyboardOpen = useKeyboardOpen(120, expandedSections.links);
  const appliedBroadcastHandoffSignatureRef = useRef<string | null>(null);

  const routeChatTitle = getRouteChatTitle(location.state);
  const routeChatAvatarUrl = getRouteChatAvatarUrl(location.state);
  const searchParams = new URLSearchParams(location.search);
  const focusSection = searchParams.get('focus');
  const handoffRequested = searchParams.get('handoff') === '1';

  useEffect(() => {
    if (
      focusSection !== 'links' &&
      focusSection !== 'rules' &&
      focusSection !== 'comments' &&
      focusSection !== 'poll' &&
      focusSection !== 'giveaway' &&
      focusSection !== 'broadcast' &&
      focusSection !== 'requiredSubscription'
    ) {
      return;
    }

    setExpandedSections({
      ...INITIAL_EXPANDED_SECTIONS,
      ...(focusSection === 'links'
        ? { links: true }
        : focusSection === 'rules'
          ? { rules: true }
          : focusSection === 'comments'
            ? { comments: true }
            : focusSection === 'poll'
              ? { poll: true }
              : focusSection === 'giveaway'
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
    setRulesAutoFillSeedText(null);
    setRulesTextError('');
    setRulesImageError('');
    setRulesButtonUrlError('');
    setRulesButtonTextError('');
    setRulesButtonFieldsTouched(false);
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
    setMailingScheduleTimezone(resolveBroadcastScheduleTimezone());
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
    setRequiredSubscriptionExternalChannelValue('');
    setRequiredSubscriptionExternalChannelError('');
    setResolvedRequiredSubscriptionChannels([]);
    resetMailingPlanner();
    setEditingManagedBroadcast(null);
    setMailingWorkspaceView('compose');
    setDuplicateWindowInputValue('');
    setPendingSpeechStyle(null);
  }, [chatId]);

  const settingsScreenQuery = useQuery({
    queryKey: ['settings-screen', chatId],
    queryFn: ({ signal }) => getSettingsScreen(api, chatId ?? '', { signal }),
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
    queryKey: ['me', chatId ?? null],
    queryFn: ({ signal }) =>
      getMe(api, { chatId: chatId ?? undefined, entityType: 'chat', signal }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const shouldLoadRequiredSubscriptionChannels =
    Boolean(chatId) &&
    (expandedSections.requiredSubscription || focusSection === 'requiredSubscription');
  const channelsList = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: shouldLoadRequiredSubscriptionChannels,
    resumeOnVisibilityReturn: true,
    skipInitialSyncIfCached: true,
  });
  const channelsQuery = {
    data: channelsList.data,
    isLoading: channelsList.isLoading,
    error: channelsList.error,
    isSuccess: channelsList.data !== null && channelsList.error === null,
    isSyncComplete: channelsList.isSyncComplete,
    isBackoffActive: channelsList.isBackoffActive,
    isSyncing: channelsList.isRefreshing,
    phase: channelsList.phase,
  };
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
    const map = new Map<string, ManagedEntityHeader>();
    for (const channel of availableRequiredSubscriptionChannels) {
      map.set(channel.id, {
        id: channel.id,
        title: channel.title,
        entityType: 'channel',
        link: channel.link?.trim() ?? null,
        participantsCount: null,
        primaryBotId: channel.primaryBotId ?? null,
        assignedBots: channel.assignedBots ?? [],
        sharedMode: channel.sharedMode ?? 'owned',
      });
    }
    for (const channel of resolvedRequiredSubscriptionChannels) {
      map.set(channel.id, channel);
    }
    return map;
  }, [availableRequiredSubscriptionChannels, resolvedRequiredSubscriptionChannels]);
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
    return (draft?.requiredSubscriptionChannelIds ?? []).filter(
      (channelId) => !availableRequiredSubscriptionChannelById.has(channelId),
    );
  }, [availableRequiredSubscriptionChannelById, draft?.requiredSubscriptionChannelIds]);
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

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [chatHeaderQuery.data?.title, chatId, routeChatTitle]);

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
      state: {
        chatTitle,
        avatarUrl: chatHeaderQuery.data?.avatarUrl ?? routeChatAvatarUrl ?? null,
      },
    });
  }, [
    chatHeaderQuery.data?.avatarUrl,
    chatTitle,
    location.pathname,
    location.search,
    navigate,
    routeChatAvatarUrl,
    routeChatTitle,
  ]);

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    setDraft(normalizeDuplicateFlowSettings(normalizeLegacyChatCommentScope(settingsQuery.data)));
    setFieldErrors({});
    setDuplicateWindowInputValue('');
  }, [settingsQuery.data]);

  useEffect(() => {
    setResolvedRequiredSubscriptionChannels(
      settingsScreenQuery.data?.requiredSubscriptionChannels ?? [],
    );
  }, [settingsScreenQuery.data?.requiredSubscriptionChannels]);

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
    setMailingScheduleTimezone(
      broadcastHandoffStateQuery.data.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
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
    setMailingWorkspaceView('compose');
    if (broadcastHandoffStateQuery.data.hasContent) {
      pushToast({
        title: 'Контент сохранён в боте',
        description: 'Календарь восстановлен из личного чата бота.',
        tone: 'success',
      });
    }
  }, [broadcastHandoffStateQuery.data, pushToast]);

  useEffect(() => {
    if (!rulesQuery.data) {
      return;
    }

    setRulesDraft(chatRulesSchema.parse(rulesQuery.data));
    setRulesAutoFillSeedText(null);
    setRulesTextError('');
    setRulesImageError('');
    setRulesButtonUrlError('');
    setRulesButtonTextError('');
    setRulesButtonFieldsTouched(false);
  }, [rulesQuery.data]);

  useEffect(() => {
    if (!scheduleDomain) {
      return;
    }

    const exists = (domainsQuery.data ?? []).some(
      (item) => item.normalizedValue === scheduleDomain,
    );
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
    () =>
      settingsQuery.data ? JSON.stringify(normalizeLegacyChatCommentScope(settingsQuery.data)) : '',
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

  const saveCommentsMutation = useMutation({
    mutationFn: (payload: ChatSettings) => updateSettings(api, chatId ?? '', payload),
    onSuccess: (saved) => {
      syncSavedCommentsSettings(saved);
      pushToast({
        tone: 'success',
        title: 'Комментарии сохранены',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить комментарии',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingComments = saveCommentsMutation.isPending;
  const mutateCommentsAsync = saveCommentsMutation.mutateAsync;

  const resolveRequiredSubscriptionChannelMutation = useMutation({
    mutationFn: (value: string) => resolveRequiredSubscriptionChannel(api, chatId ?? '', value),
    onSuccess: ({ channel }) => {
      const alreadySelected = draft?.requiredSubscriptionChannelIds.includes(channel.id) ?? false;
      setResolvedRequiredSubscriptionChannels((current) => {
        const next = current.filter((item) => item.id !== channel.id);
        next.push(channel);
        return next;
      });
      if (!alreadySelected) {
        addRequiredSubscriptionChannel(channel.id);
      }
      setRequiredSubscriptionExternalChannelValue('');
      setRequiredSubscriptionExternalChannelError('');
      pushToast({
        tone: 'success',
        title: alreadySelected ? 'Канал уже в списке' : `Канал «${channel.title}» добавлен`,
      });
      maxNotify('success');
    },
    onError: (error) => {
      setRequiredSubscriptionExternalChannelError(formatApiError(error));
      maxNotify('error');
    },
  });
  const isResolvingRequiredSubscriptionChannel =
    resolveRequiredSubscriptionChannelMutation.isPending;

  const saveSpeechStyleMutation = useMutation({
    mutationFn: ({ payload }: { style: BotSpeechStyle; payload: ChatSettings }) =>
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
      setRulesButtonUrlError('');
      setRulesButtonTextError('');
      setRulesButtonFieldsTouched(false);
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
    mutationFn: (payload: { domain: string; matchType: AllowlistMatchType }) =>
      addDomain(api, chatId ?? '', payload),
    onSuccess: (_, payload) => {
      setDomainInput('');
      setDomainInputError('');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: 'success',
        title:
          payload.matchType === 'DOMAIN'
            ? 'Домен добавлен в разрешенные'
            : 'Ссылка добавлена в разрешенные',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title:
          domainInputMode === 'DOMAIN' ? 'Не удалось добавить домен' : 'Не удалось добавить ссылку',
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
      pushToast({ tone: 'success', title: 'Правило удалено из разрешенных' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить правило',
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
          title: 'Удаление правила запланировано',
          description: `Правило будет удалено ${formatRemovalDateTime(payload.removeAfterAt)}.`,
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

  const handoffRulesMutation = useMutation({
    mutationFn: () => handoffRules(api, chatId ?? ''),
    onSuccess: (result) => {
      pushToast({
        tone: 'info',
        title: 'Открываем личный чат бота',
        description:
          'Отправьте там текст или фото. Публиковать можно и там, и здесь. Кнопка «Правила» остаётся в mini app.',
      });
      openMaxBotLink(result.botUrl);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть правила в боте',
        description: formatApiError(error),
      });
    },
  });

  const updateRulesAttachMutation = useMutation({
    mutationFn: (enabled: boolean) => {
      const base = settingsQuery.data ?? draft;
      if (!chatId || !base) {
        throw new Error('Чат не выбран');
      }

      return updateSettings(api, chatId, {
        ...base,
        rulesAttachViolationsEnabled: enabled,
      });
    },
    onSuccess: (saved) => {
      setDraft((current) =>
        current
          ? {
              ...current,
              rulesAttachViolationsEnabled: saved.rulesAttachViolationsEnabled,
            }
          : saved,
      );
      queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
        ['settings-screen', chatId],
        (current) =>
          current
            ? {
                ...current,
                settings: {
                  ...current.settings,
                  rulesAttachViolationsEnabled: saved.rulesAttachViolationsEnabled,
                },
              }
            : current,
      );
      pushToast({
        tone: 'success',
        title: saved.rulesAttachViolationsEnabled
          ? 'Кнопка «Правила» включена'
          : 'Кнопка «Правила» выключена',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить кнопку «Правила»',
        description: formatApiError(error),
      });
      maxNotify('error');
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
          ? `Следующая отправка: ${formatRemovalDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
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
        title: 'Рассылка удалена',
        description: 'Будущие отправки сняты, карточка убрана из списка.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить рассылку',
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
          ? `Следующая отправка: ${formatRemovalDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
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

  const openManagedBroadcastEditorMutation = useMutation({
    mutationFn: (broadcastId: string) => getManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      setEditingManagedBroadcast(broadcast);
      setMailingApplyToAllChats(broadcast.applyToAllChats);
      setMailingText(broadcast.text);
      setMailingBotHasContent(false);
      setMailingButtonEnabled(broadcast.buttonEnabled);
      setMailingButtonUrl(broadcast.buttonUrl);
      setMailingButtonText(broadcast.buttonText || 'Открыть');
      setMailingImageEnabled(broadcast.imageEnabled);
      setMailingImageBase64(broadcast.imageBase64);
      setMailingImageMimeType(broadcast.imageMimeType);
      setMailingImageFileName(broadcast.imageFileName);
      setMailingScheduledSlots(sortAndUniqueBroadcastSlots(broadcast.scheduledSlots));
      setMailingScheduleTimezone(
        broadcast.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      );
      setMailingTextError('');
      setMailingButtonUrlError('');
      setMailingButtonTextError('');
      setMailingImageError('');
      setMailingScheduleError('');
      setMailingCycleError('');
      resetMailingPlanner();
      setMailingWorkspaceView('compose');
      setExpandedSections((current) => ({ ...current, mailing: true }));
      pushToast({
        tone: 'info',
        title: 'Редактирование рассылки',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatRemovalDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Измените время и сохраните рассылку.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть рассылку',
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

  function handleResolveRequiredSubscriptionExternalChannel() {
    const normalizedValue = requiredSubscriptionExternalChannelValue.trim();
    if (!chatId) {
      return;
    }

    if (!normalizedValue) {
      setRequiredSubscriptionExternalChannelError('Укажите публичную ссылку или ID канала.');
      return;
    }

    if ((draft?.requiredSubscriptionChannelIds.length ?? 0) >= REQUIRED_SUBSCRIPTION_MAX_CHANNELS) {
      setRequiredSubscriptionExternalChannelError(
        `Можно выбрать максимум ${REQUIRED_SUBSCRIPTION_MAX_CHANNELS} каналов.`,
      );
      return;
    }

    setRequiredSubscriptionExternalChannelError('');
    resolveRequiredSubscriptionChannelMutation.mutate(normalizedValue);
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

  function clearCommentsErrors() {
    setFieldErrors((current) => {
      let changed = false;
      const next = { ...current };

      for (const key of COMMENTS_SETTING_KEYS) {
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

  function syncSavedCommentsSettings(saved: ChatSettings) {
    setDraft((current) => (current ? mergeCommentsSettings(current, saved) : saved));
    clearCommentsErrors();
    queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
      ['settings-screen', chatId],
      (current) =>
        current
          ? {
              ...current,
              settings: mergeCommentsSettings(current.settings, saved),
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

  function validateRulesDraft(
    value: ChatRules,
    options: { forceButtonErrors?: boolean } = {},
  ): UpdateChatRulesPayload | null {
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

    const normalizedButtonUrl = value.buttonUrl.trim();
    const normalizedButtonText = value.buttonText.trim();
    const shouldShowButtonErrors = Boolean(options.forceButtonErrors || rulesButtonFieldsTouched);
    if (value.buttonEnabled) {
      if (!isValidHttpUrl(normalizedButtonUrl)) {
        setRulesButtonUrlError(
          shouldShowButtonErrors ? 'Укажите корректную ссылку (http/https).' : '',
        );
        setRulesButtonTextError('');
        return null;
      }
      setRulesButtonUrlError('');

      if (!normalizedButtonText || normalizedButtonText.length > 32) {
        setRulesButtonTextError(
          shouldShowButtonErrors ? 'Введите название кнопки до 32 символов.' : '',
        );
        return null;
      }
      setRulesButtonTextError('');
    } else {
      setRulesButtonUrlError('');
      setRulesButtonTextError('');
    }

    return {
      autoTextEnabled: value.autoTextEnabled,
      text: value.text,
      imageBase64: value.imageBase64,
      imageMimeType: value.imageMimeType,
      imageFileName: value.imageFileName,
      buttonEnabled: value.buttonEnabled,
      buttonUrl: value.buttonUrl,
      buttonText: value.buttonText,
    };
  }

  async function saveRulesDraftNow(
    options: { forceButtonErrors?: boolean } = {},
  ): Promise<ChatRules | null> {
    if (!rulesDraft) {
      return null;
    }

    const payload = validateRulesDraft(rulesDraft, options);
    if (!payload) {
      return null;
    }

    return mutateRulesAsync(payload);
  }

  function secondsToHours(value: number): number {
    return Math.max(1, Math.round(value / 3600));
  }

  function applyDuplicateFlowConfig(overrides: {
    allowedCount?: number;
    windowSec?: number;
    duplicateBotMessageEnabled?: boolean;
    duplicateWarnEnabled?: boolean;
    duplicateMuteEnabled?: boolean;
    duplicateBanEnabled?: boolean;
  }) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const duplicateBotMessageEnabled =
        overrides.duplicateBotMessageEnabled ?? current.duplicateBotMessageEnabled;
      const duplicateWarnEnabled = overrides.duplicateWarnEnabled ?? current.duplicateWarnEnabled;
      const duplicateMuteEnabled = overrides.duplicateMuteEnabled ?? current.duplicateMuteEnabled;
      const duplicateBanEnabled = overrides.duplicateBanEnabled ?? current.duplicateBanEnabled;
      const allowedCount = overrides.allowedCount ?? resolveDuplicateAllowedCount(current);
      const windowSec = overrides.windowSec ?? resolveDuplicateSharedWindowSec(current);

      return {
        ...current,
        duplicateBotMessageEnabled,
        duplicateWarnEnabled,
        duplicateMuteEnabled,
        duplicateBanEnabled,
        ...buildDuplicateFlowSettings({
          duplicateBotMessageEnabled,
          duplicateWarnEnabled,
          duplicateMuteEnabled,
          duplicateBanEnabled,
          allowedCount,
          windowSec,
        }),
      };
    });

    clearFieldError('duplicateWarnWindowSec');
    clearFieldError('duplicateWarnMaxCount');
    clearFieldError('duplicateMuteWindowSec');
    clearFieldError('duplicateMuteMaxCount');
    clearFieldError('duplicateBanWindowSec');
    clearFieldError('duplicateBanMaxCount');
  }

  function handleDuplicateWindowHoursChange(rawValue: string) {
    setDuplicateWindowInputValue(rawValue);

    const normalized = rawValue.trim();
    if (normalized.length === 0) {
      return;
    }

    const hours = Number.parseInt(normalized, 10);
    if (Number.isNaN(hours)) {
      return;
    }

    const safeHours = Math.min(168, Math.max(1, hours));
    applyDuplicateFlowConfig({ windowSec: safeHours * 3600 });
  }

  function handleDuplicateWindowHoursBlur() {
    const rawValue = duplicateWindowInputValue;
    const normalized = rawValue.trim();
    const parsed = Number.parseInt(normalized, 10);

    const fallbackHours = draft ? secondsToHours(resolveDuplicateSharedWindowSec(draft)) : 1;
    const safeHours = Number.isNaN(parsed) ? fallbackHours : Math.min(168, Math.max(1, parsed));
    applyDuplicateFlowConfig({ windowSec: safeHours * 3600 });
    setDuplicateWindowInputValue('');
  }

  function formatMuteDurationCompact(hours: number) {
    return hours >= 24 && hours % 24 === 0 ? `${hours / 24}д` : `${hours}ч`;
  }

  function setMuteDurationValue(key: AutoMuteDurationKey, nextValue: number) {
    const safeValue = Math.min(
      AUTO_MUTE_DURATION_MAX_HOURS,
      Math.max(AUTO_MUTE_DURATION_MIN_HOURS, Math.round(nextValue)),
    );
    setFieldValue(key, safeValue as ChatSettings[AutoMuteDurationKey]);
  }

  function adjustMuteDuration(key: AutoMuteDurationKey, deltaHours: number) {
    if (!draft) {
      return;
    }

    setMuteDurationValue(key, Number(draft[key]) + deltaHours);
  }

  function adjustDeleteBotMessagesDelayValue(
    key: 'deleteBotMessagesDelayMinutes' | 'greetingDeleteBotMessageDelayMinutes',
    direction: number,
  ) {
    if (!draft) {
      return;
    }

    const next = stepDeleteBotMessagesDelayMinutes(Number(draft[key]), direction);

    setFieldValue(key, next as ChatSettings[typeof key]);
  }

  function adjustDeleteBotMessagesDelay(direction: number) {
    adjustDeleteBotMessagesDelayValue('deleteBotMessagesDelayMinutes', direction);
  }

  function adjustGreetingDeleteBotMessagesDelay(direction: number) {
    adjustDeleteBotMessagesDelayValue('greetingDeleteBotMessageDelayMinutes', direction);
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

  function adjustDuplicateAllowedCount(currentValue: number, delta: number) {
    const next = Math.min(
      DUPLICATE_ALLOWED_COUNT_MAX,
      Math.max(DUPLICATE_ALLOWED_COUNT_MIN, Number(currentValue) + delta),
    );
    applyDuplicateFlowConfig({ allowedCount: next });
  }

  function addMessageLimitsBlockedWords() {
    if (!draft) {
      return;
    }

    const nextCandidates = splitMessageLimitsBlockedWordsInput(messageLimitsBlockedWordsInput);
    if (nextCandidates.length === 0) {
      if (messageLimitsBlockedWordsInput.trim()) {
        setFieldErrors((current) => ({
          ...current,
          messageLimitsBlockedWords: 'Нужно одно слово без пробелов, от 2 до 32 символов.',
        }));
      }
      return;
    }

    const existingWords = new Set(
      draft.messageLimitsBlockedWords
        .map((item) => normalizeMessageLimitsBlockedWordCandidate(item))
        .filter((item): item is string => Boolean(item)),
    );
    const nextWords = [...draft.messageLimitsBlockedWords];

    for (const candidate of nextCandidates) {
      if (nextWords.length >= MESSAGE_LIMITS_BLOCKED_WORDS_MAX || existingWords.has(candidate)) {
        continue;
      }

      existingWords.add(candidate);
      nextWords.push(candidate);
    }

    clearFieldError('messageLimitsBlockedWords');
    setDraft((current) =>
      current
        ? {
            ...current,
            messageLimitsBlockedWords: nextWords,
            messageLimitsBotMessageEnabled:
              nextWords.length > 0 ? true : current.messageLimitsBotMessageEnabled,
          }
        : current,
    );
    setMessageLimitsBlockedWordsInput('');
  }

  function applyMessageLimitsBlockedWords(nextWords: string[]) {
    clearFieldError('messageLimitsBlockedWords');
    setDraft((current) =>
      current
        ? {
            ...current,
            messageLimitsBlockedWords: nextWords,
            messageLimitsBotMessageEnabled: true,
          }
        : current,
    );
  }

  function removeMessageLimitsBlockedWord(wordToRemove: string) {
    if (!draft) {
      return;
    }

    setFieldValue(
      'messageLimitsBlockedWords',
      draft.messageLimitsBlockedWords.filter(
        (word) => word !== wordToRemove,
      ) as ChatSettings['messageLimitsBlockedWords'],
    );
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
    rulesButtonFieldsTouched,
    rulesDraft,
    rulesDraftSnapshot,
    rulesFailedSnapshot,
  ]);

  useEffect(() => {
    if (!chatId || !draft || !expandedSections.comments || isSavingComments) {
      return;
    }

    if (!isCommentsDirty()) {
      return;
    }

    const payload = buildCommentsPayload();
    if (!payload) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      saveCommentsMutation.mutate(payload);
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    chatId,
    draftSnapshot,
    expandedSections.comments,
    isSavingComments,
    saveCommentsMutation,
    serverSnapshot,
  ]);

  function handleAddDomain() {
    if (!chatId) {
      return;
    }

    const normalizedDomain =
      domainInputMode === 'DOMAIN' ? normalizeAllowlistDomain(domainInput) : null;
    const normalizedLink = domainInputMode === 'EXACT' ? normalizeAllowlistLink(domainInput) : null;
    const normalizedValue = normalizeStoredAllowlistEntry(domainInput, domainInputMode);
    const normalizedInput = normalizedDomain ?? normalizedLink;

    if (!normalizedInput || !normalizedValue) {
      setDomainInputError(
        domainInputMode === 'DOMAIN'
          ? 'Введите корректный домен.'
          : 'Введите корректную ссылку (http/https).',
      );
      return;
    }

    const alreadyExists = (domainsQuery.data ?? []).some(
      (item) => item.normalizedValue === normalizedValue,
    );
    if (alreadyExists) {
      setDomainInputError('');
      setDomainInput('');
      pushToast({ title: 'Такое правило уже есть в списке' });
      return;
    }

    setDomainInputError('');
    addDomainMutation.mutate({
      domain: normalizedInput,
      matchType: domainInputMode,
    });
  }

  function toggleDomainScheduleEditor(entry: DomainAllowlistEntry) {
    if (scheduleDomain === entry.normalizedValue) {
      setScheduleDomain(null);
      setScheduleError('');
      return;
    }

    const initial = parseIsoToLocalDateTime(entry.removeAfterAt);
    setScheduleDate(initial.date);
    setScheduleTime(initial.time);
    setScheduleError('');
    setScheduleDomain(entry.normalizedValue);
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

  async function handleHandoffRules() {
    if (!chatId) {
      return;
    }

    if (hasRulesChanges) {
      const saved = await saveRulesDraftNow({ forceButtonErrors: true });
      if (!saved) {
        return;
      }
    }

    handoffRulesMutation.mutate();
  }

  async function handlePublishRules() {
    if (!chatId || !rulesDraft) {
      return;
    }

    if (!rulesDraft.autoTextEnabled && !rulesDraft.text.trim()) {
      setRulesTextError('Введите текст правил перед публикацией.');
      return;
    }
    setRulesTextError('');

    if (rulesDraft.text.length > MAX_CHAT_RULES_TEXT_LENGTH) {
      setRulesTextError(`Максимум ${MAX_CHAT_RULES_TEXT_LENGTH} символов.`);
      return;
    }

    if (!hasRulesChanges && !validateRulesDraft(rulesDraft, { forceButtonErrors: true })) {
      return;
    }

    const saved = hasRulesChanges
      ? await saveRulesDraftNow({ forceButtonErrors: true })
      : rulesDraft;
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
    setMailingScheduleTimezone(resolveBroadcastScheduleTimezone());
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

  function handleCancelMailingEdit() {
    resetMailingComposer();
  }

  function handleDeleteManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || cancelManagedBroadcastMutation.isPending) {
      return;
    }

    const nextSendLabel = formatCompactBroadcastDateTime(
      broadcast.nextSendAt,
      broadcast.scheduleTimezone,
    );
    const confirmationText = [
      'Удалить рассылку?',
      nextSendLabel ? `Следующая отправка: ${nextSendLabel}.` : null,
      'Все будущие слоты будут сняты, а карточка исчезнет из раздела «В работе».',
    ]
      .filter(Boolean)
      .join('\n\n');

    if (typeof window !== 'undefined' && !window.confirm(confirmationText)) {
      return;
    }

    cancelManagedBroadcastMutation.mutate(broadcast.id);
  }

  function handleEditManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || openManagedBroadcastEditorMutation.isPending) {
      return;
    }

    openManagedBroadcastEditorMutation.mutate(broadcast.id);
  }

  function validateMailingButtonDraft() {
    let hasError = false;
    const normalizedButtonUrl = mailingButtonUrl.trim();
    const normalizedButtonText = mailingButtonText.trim();

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

    return !hasError;
  }

  function buildMailingHandoffPayload(): BroadcastHandoffPayload {
    const normalizedButtonUrl = mailingButtonUrl.trim();
    const normalizedButtonText = mailingButtonText.trim();
    const scheduledSlots = sortAndUniqueBroadcastSlots(mailingScheduledSlots);

    return {
      applyToAllChats: mailingApplyToAllChats,
      buttonEnabled: mailingButtonEnabled,
      buttonUrl: normalizedButtonUrl,
      buttonText: normalizedButtonText || 'Открыть',
      scheduleMode: 'calendar',
      scheduleTimezone: mailingScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots,
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: Math.max(scheduledSlots.length, 1),
    };
  }

  function handleSendBroadcast() {
    if (!chatId) {
      return;
    }

    const normalizedText = mailingText.trim();
    const scheduledSlots = sortAndUniqueBroadcastSlots(mailingScheduledSlots);

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

    if (!validateMailingButtonDraft()) {
      hasError = true;
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

    const handoffPayload = buildMailingHandoffPayload();

    if (editingManagedBroadcast) {
      const payload: SendBroadcastPayload = {
        text: normalizedText,
        textFormat: editingManagedBroadcast.textFormat,
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

    const config = resolveCommercialSensitivityConfig(rawValue);
    setFieldValue('commercialAdsSensitivity', config.sensitivity);
    setFieldValue('commercialAdsWarnThreshold', config.warnThreshold);
    setFieldValue('commercialAdsDeleteThreshold', config.deleteThreshold);
  }

  function toggleHint(key: HintKey) {
    setOpenHintKey((current) => (current === key ? null : key));
  }

  function toggleMuteDurationEditor(key: AutoMuteDurationKey) {
    setOpenMuteDurationKey((current) => (current === key ? null : key));
  }

  function renderInlineHint(hintKey: HintKey, hintId: string, text: string, hidden = false) {
    if (hidden || openHintKey !== hintKey) {
      return null;
    }

    return (
      <p id={hintId} className="settings-native-toggle__hint settings-native-toggle__hint--inline">
        {text}
      </p>
    );
  }

  function renderMuteDurationEditor(key: AutoMuteDurationKey, label: string) {
    if (!draft || openMuteDurationKey !== key) {
      return null;
    }

    const value = Number(draft[key]);

    return (
      <div id={`mute-duration-${key}`} className="logs-violation-item__ban-config">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <ClockIcon />
            <span className="settings-native-toggle__title">{label}</span>
          </div>
          <output className="ban-duration-stepper__value" aria-live="polite">
            {formatMuteDurationCompact(value)}
          </output>
        </div>

        <div className="logs-violation-item__ban-presets">
          {AUTO_MUTE_DURATION_PRESET_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              className={cn('logs-violation-item__ban-preset', value === hours && 'is-active')}
              onClick={() => setMuteDurationValue(key, hours)}
            >
              {formatMuteDurationCompact(hours)}
            </button>
          ))}
        </div>

        <div className="logs-violation-item__ban-config-controls">
          <div className="ban-duration-stepper">
            <button
              type="button"
              className="ban-duration-stepper__button"
              onClick={() => adjustMuteDuration(key, -1)}
              disabled={value <= AUTO_MUTE_DURATION_MIN_HOURS}
            >
              -
            </button>
            <output className="ban-duration-stepper__value" aria-live="polite">
              {value}ч
            </output>
            <button
              type="button"
              className="ban-duration-stepper__button"
              onClick={() => adjustMuteDuration(key, 1)}
              disabled={value >= AUTO_MUTE_DURATION_MAX_HOURS}
            >
              +
            </button>
          </div>

          <label className="logs-violation-item__hours-input">
            <span>Часы</span>
            <input
              type="number"
              min={AUTO_MUTE_DURATION_MIN_HOURS}
              max={AUTO_MUTE_DURATION_MAX_HOURS}
              step={1}
              value={value}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (!Number.isFinite(nextValue)) {
                  return;
                }

                setMuteDurationValue(key, nextValue);
              }}
            />
            <small>
              {AUTO_MUTE_DURATION_MIN_HOURS}–{AUTO_MUTE_DURATION_MAX_HOURS}ч
            </small>
          </label>
        </div>
      </div>
    );
  }

  function renderMuteStageToggle(params: {
    enabledKey: AutoMuteEnabledKey;
    durationKey: AutoMuteDurationKey;
    title: string;
    onEnable: () => void;
  }) {
    if (!draft) {
      return null;
    }

    const enabled = draft[params.enabledKey];
    const durationValue = Number(draft[params.durationKey]);
    const isOpen = openMuteDurationKey === params.durationKey;
    const error = fieldErrors[params.durationKey];

    return (
      <div
        className={cn(
          'settings-native-toggle',
          'settings-native-toggle--nested',
          error && 'field--error',
        )}
      >
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">{params.title}</span>
            <div className="settings-native-toggle__title-actions">
              <button
                type="button"
                className={cn('logs-violation-item__ban-preset', isOpen && 'is-active')}
                onClick={() => toggleMuteDurationEditor(params.durationKey)}
              >
                <ClockIcon />
                <span>{formatMuteDurationCompact(durationValue)}</span>
              </button>
            </div>
          </div>

          <label className="settings-native-switch" aria-label={params.title}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                const nextEnabled = event.target.checked;
                setFieldValue(params.enabledKey, nextEnabled as ChatSettings[AutoMuteEnabledKey]);
                if (nextEnabled) {
                  params.onEnable();
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {renderMuteDurationEditor(params.durationKey, 'Срок мута')}

        {error ? <small className="field__hint">{error}</small> : null}
      </div>
    );
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
  const messageLimitsBlockedWords = draft?.messageLimitsBlockedWords ?? [];
  const messageLimitsBlockedWordsError = fieldErrors.messageLimitsBlockedWords;
  const messageLimitsBlockedWordsRemaining = Math.max(
    0,
    MESSAGE_LIMITS_BLOCKED_WORDS_MAX - messageLimitsBlockedWords.length,
  );
  const hasMessageLimitsBlockedWordsOverflow =
    messageLimitsBlockedWords.length > MESSAGE_LIMITS_BLOCKED_WORDS_PREVIEW_COUNT;
  const visibleMessageLimitsBlockedWords =
    hasMessageLimitsBlockedWordsOverflow && !messageLimitsBlockedWordsExpanded
      ? messageLimitsBlockedWords.slice(-MESSAGE_LIMITS_BLOCKED_WORDS_PREVIEW_COUNT)
      : messageLimitsBlockedWords;
  const messageLimitsBotButtonUrlError = showMessageLimitsBotButtonErrors
    ? fieldErrors.messageLimitsBotButtonUrl
    : undefined;
  const messageLimitsBotButtonTextError = showMessageLimitsBotButtonErrors
    ? fieldErrors.messageLimitsBotButtonText
    : undefined;
  const hasMessageLimitsBotButtonError = Boolean(
    messageLimitsBotButtonUrlError || messageLimitsBotButtonTextError,
  );

  useEffect(() => {
    if (!hasMessageLimitsBlockedWordsOverflow && messageLimitsBlockedWordsExpanded) {
      setMessageLimitsBlockedWordsExpanded(false);
    }
  }, [hasMessageLimitsBlockedWordsOverflow, messageLimitsBlockedWordsExpanded]);
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
    draft?.linkMuteEnabled,
  ].filter(Boolean).length;
  const linksHeaderSummary =
    draft?.linkPolicy === 'ALERT_ONLY'
      ? 'Ссылки не удаляются'
      : draft?.linkPolicy === 'ALLOWLIST_ONLY'
        ? `Разрешено: ${allowlistEntries.length}`
        : `${linkStagesEnabledCount}/4 ступени включено`;
  const allowlistCountLabel =
    allowlistEntries.length === 1
      ? '1 правило'
      : `${allowlistEntries.length} ${allowlistEntries.length < 5 ? 'правила' : 'правил'}`;
  const allowlistComposerExamples =
    domainInputMode === 'DOMAIN'
      ? [
          { label: 'example.com', value: 'example.com' },
          { label: 'docs.max.ru', value: 'docs.max.ru' },
        ]
      : [
          {
            label: 'https://example.com/path',
            value: 'https://example.com/path',
          },
          {
            label: 'https://docs.max.ru/',
            value: 'https://docs.max.ru/',
          },
        ];
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
  const hasRulesDraftText = Boolean(rulesDraft?.text.trim());
  const rulesHeroStatusLabel = hasPublishedRules
    ? 'Опубликовано'
    : hasRulesDraftText
      ? 'Черновик'
      : 'Пусто';
  const rulesHeroTitle = hasPublishedRules
    ? 'Правила опубликованы'
    : hasRulesDraftText
      ? 'Черновик готов к публикации'
      : 'Правила ещё не опубликованы';
  const rulesHeroMeta = hasPublishedRules
    ? rulesPublishedAtLabel
      ? `Последняя публикация · ${rulesPublishedAtLabel}`
      : 'Пост опубликован'
    : hasRulesDraftText
      ? `${rulesDraft?.text.trim().length ?? 0}/${MAX_CHAT_RULES_TEXT_LENGTH} символов`
      : 'Редактирование через бота';
  const rulesButtonPreviewText = rulesDraft?.buttonText.trim() || DEFAULT_RULES_POST_BUTTON_TEXT;
  const rulesButtonPreviewUrl = rulesDraft?.buttonUrl.trim() ?? '';
  const hasRulesButtonPreviewUrl = isValidHttpUrl(rulesButtonPreviewUrl);
  const rulesAutoFillSummary = rulesDraft?.autoTextEnabled ? 'Включено' : 'Выключено';
  const rulesPostButtonSummary = rulesDraft?.buttonEnabled ? rulesButtonPreviewText : 'Выключена';
  const rulesViolationButtonSummary = draft?.rulesAttachViolationsEnabled
    ? 'Включена'
    : 'Выключена';
  const greetingHeaderSummary = draft?.greetingEnabled
    ? draft?.greetingBotMessageEnabled
      ? draft?.greetingBotButtonEnabled || draft?.greetingRulesButtonEnabled
        ? 'Сообщение + кнопки'
        : 'Только сообщение'
      : 'Сообщение выключено'
    : 'Выключено';
  const duplicateAllowedCount = draft ? resolveDuplicateAllowedCount(draft) : 1;
  const duplicateSharedWindowHours = draft
    ? secondsToHours(resolveDuplicateSharedWindowSec(draft))
    : 12;
  const duplicateStagesEnabledCount = [
    draft?.duplicateBotMessageEnabled,
    draft?.duplicateWarnEnabled,
    draft?.duplicateMuteEnabled,
    draft?.duplicateBanEnabled,
  ].filter(Boolean).length;
  const duplicatesHeaderSummary = draft?.antiDuplicateEnabled
    ? `${formatDuplicateAllowanceLabel(duplicateAllowedCount)} • ${duplicateSharedWindowHours}ч • ${duplicateStagesEnabledCount}/4 этапа`
    : 'Выключено';
  const profanityStagesEnabledCount = draft?.russianProfanityFilterEnabled
    ? [
        draft?.profanityBotMessageEnabled,
        draft?.profanityWarnEnabled,
        draft?.profanityBanEnabled,
        draft?.profanityMuteEnabled,
      ].filter(Boolean).length
    : 0;
  const textFiltersStagesEnabledCount = draft?.commercialAdsFilterEnabled
    ? [
        draft?.textFiltersBotMessageEnabled,
        draft?.textFiltersWarnEnabled,
        draft?.textFiltersBanEnabled,
        draft?.textFiltersMuteEnabled,
      ].filter(Boolean).length
    : 0;
  const thematicFiltersEnabledCount = draft?.thematicCodewordEnabled ? 1 : 0;
  const thematicFiltersStagesEnabledCount = thematicFiltersEnabledCount
    ? [
        draft?.thematicFiltersBotMessageEnabled,
        draft?.thematicFiltersWarnEnabled,
        draft?.thematicFiltersBanEnabled,
        draft?.thematicFiltersMuteEnabled,
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
    draft ? draft.messageLimitsBlockedWords.length > 0 : false,
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
  const requiredSubscriptionStagesEnabledCount = [
    draft?.requiredSubscriptionBotMessageEnabled,
    draft?.requiredSubscriptionWarnEnabled,
    draft?.requiredSubscriptionBanEnabled,
    draft?.requiredSubscriptionMuteEnabled,
  ].filter(Boolean).length;
  const areChannelsSyncing =
    shouldLoadRequiredSubscriptionChannels &&
    (channelsQuery.phase === 'loading' || channelsQuery.phase === 'syncing');
  const requiredSubscriptionHeaderSummary = draft?.requiredSubscriptionEnabled
    ? areChannelsSyncing
      ? 'Синхронизируем каналы...'
      : requiredSubscriptionStaleCount > 0
        ? `Нужно исправить: ${requiredSubscriptionStaleCount} недоступен`
        : `${formatRequiredSubscriptionCount(requiredSubscriptionSelectedCount)} · ${requiredSubscriptionStagesEnabledCount}/4 ступени`
    : 'Выключено';
  const profanityFilterHeaderSummary = draft?.russianProfanityFilterEnabled
    ? `${profanityStagesEnabledCount}/4 ступени включено`
    : 'Выключено';
  const commercialFilterHeaderSummary = draft?.commercialAdsFilterEnabled
    ? `${textFiltersStagesEnabledCount}/4 ступени · ${commercialSensitivityLabel.toLowerCase()}`
    : 'Выключено';
  const thematicFiltersHeaderSummary = thematicFiltersEnabledCount
    ? `код: ${draft?.thematicCodeword?.trim() || 'не задан'} · ${thematicFiltersStagesEnabledCount}/4 ступени`
    : 'Выключено';
  const extraEnabledCount = [
    draft?.deleteSpammersEnabled,
    draft?.deleteBotMessagesEnabled,
    draft?.removeBotsFromGroupEnabled,
  ].filter(Boolean).length;
  const extraHeaderSummary =
    extraEnabledCount > 0 ? `${extraEnabledCount} опции включено` : 'Выключено';
  const canApplyToAllChats = true;
  const canApplyMailingToAllChats = true;
  const managedBroadcasts = managedBroadcastsQuery.data ?? [];
  const orderedManagedBroadcasts = useMemo(() => {
    const priority = (item: ManagedBroadcastListItem): number => {
      if (item.status === 'FAILED') {
        return 0;
      }
      if (item.status === 'PARTIAL') {
        return 1;
      }
      if (item.status === 'ACTIVE') {
        return 2;
      }
      if (item.status === 'COMPLETED') {
        return 3;
      }
      return 4;
    };

    const parseTimestamp = (value: string | null): number => {
      if (!value) {
        return Number.MAX_SAFE_INTEGER;
      }

      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    };

    return [...managedBroadcasts].sort((left, right) => {
      const priorityDiff = priority(left) - priority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      const nextSendDiff = parseTimestamp(left.nextSendAt) - parseTimestamp(right.nextSendAt);
      if (nextSendDiff !== 0) {
        return nextSendDiff;
      }

      return parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt);
    });
  }, [managedBroadcasts]);
  const mailingOccupiedSlots = managedBroadcasts
    .filter((broadcast) => broadcast.id !== editingManagedBroadcast?.id)
    .flatMap((broadcast) => broadcast.scheduledSlots);
  const activeManagedBroadcast = orderedManagedBroadcasts.find((broadcast) => {
    if (broadcast.status !== 'ACTIVE' && broadcast.status !== 'PARTIAL') {
      return false;
    }

    return resolveBroadcastCountdown(broadcast.nextSendAt, mailingNowMs) !== null;
  });
  const activeManagedBroadcastCountdown = activeManagedBroadcast
    ? resolveBroadcastCountdown(activeManagedBroadcast.nextSendAt, mailingNowMs)
    : null;
  const isUpdatingManagedBroadcast = updateManagedBroadcastMutation.isPending;
  const isOpeningManagedBroadcastEditor = openManagedBroadcastEditorMutation.isPending;
  const isMailingBusy =
    handoffBroadcastMutation.isPending ||
    isOpeningManagedBroadcastEditor ||
    isUpdatingManagedBroadcast ||
    cancelManagedBroadcastMutation.isPending ||
    retryManagedBroadcastMutation.isPending;
  const commentsTargetSummary = [
    draft?.commentsAdminsEnabled ? 'посты админов' : null,
    draft?.commentsChatBroadcastsEnabled ? 'рассылки' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const commentsCardSummary = !draft?.commentsEnabled
    ? 'обсуждение выключено'
    : commentsTargetSummary || 'не выбрано, где бот публикует кнопку';
  const mailingTargetLabel = mailingApplyToAllChats ? 'Во все чаты' : 'Текущий чат';
  const mailingHeaderTargetLabel = mailingApplyToAllChats ? 'Все чаты' : 'Текущий чат';
  const mailingSlotsLabel = formatRussianCountLabel(
    mailingScheduledSlots.length,
    'слот',
    'слота',
    'слотов',
  );
  const normalizedMailingText = mailingText.trim();
  const normalizedMailingButtonUrl = mailingButtonUrl.trim();
  const normalizedMailingButtonText = mailingButtonText.trim();
  const mailingContentReady = editingManagedBroadcast
    ? normalizedMailingText.length > 0 || mailingImageEnabled
    : mailingBotHasContent;
  const mailingHeaderSummary = [
    mailingHeaderTargetLabel,
    mailingSlotsLabel,
    mailingContentReady ? 'готово' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const showMailingResetAction =
    editingManagedBroadcast !== null ||
    mailingScheduledSlots.length > 0 ||
    mailingText.trim().length > 0 ||
    mailingImageEnabled ||
    mailingButtonEnabled;
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
  const mailingSendDisabled = isMailingBusy;
  const showMailingWorkspaceTabs = !editingManagedBroadcast && orderedManagedBroadcasts.length > 0;
  const mailingDrilldownFooter = (
    <>
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
              : isOpeningManagedBroadcastEditor
                ? 'Открываем...'
                : editingManagedBroadcast
                  ? 'Сохранить рассылку'
                  : 'Открыть бота'}
        </button>
      </div>
    </>
  );

  useEffect(() => {
    if (mailingWorkspaceView === 'active' && orderedManagedBroadcasts.length === 0) {
      setMailingWorkspaceView('compose');
    }

    if (editingManagedBroadcast && mailingWorkspaceView !== 'compose') {
      setMailingWorkspaceView('compose');
    }
  }, [editingManagedBroadcast, mailingWorkspaceView, orderedManagedBroadcasts.length]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !expandedSections.mailing ||
      !activeManagedBroadcastCountdown
    ) {
      return undefined;
    }

    setMailingNowMs(Date.now());
    const timerId = window.setInterval(() => {
      setMailingNowMs(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [activeManagedBroadcastCountdown, expandedSections.mailing]);

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

  function isCommentsDirty() {
    if (!draft || !settingsQuery.data) {
      return false;
    }

    const savedSettings = settingsQuery.data;
    return COMMENTS_SETTING_KEYS.some((key) => draft[key] !== savedSettings[key]);
  }

  function buildSectionPayload(section: ApplySectionKey) {
    if (!draft || !settingsQuery.data) {
      return null;
    }

    return validateDraft(mergeSectionSettings(settingsQuery.data, draft, section));
  }

  function buildCommentsPayload() {
    if (!draft || !settingsQuery.data) {
      return null;
    }

    return validateDraft(mergeCommentsSettings(settingsQuery.data, draft));
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

  async function handleSaveComments() {
    if (!chatId) {
      return;
    }

    if (!isCommentsDirty()) {
      closeSection('comments');
      return;
    }

    const payload = buildCommentsPayload();
    if (!payload) {
      pushToast({
        tone: 'danger',
        title: 'Исправьте блок «Комментарии»',
        description: 'В блоке есть ошибки, их нужно исправить перед сохранением.',
      });
      return;
    }

    try {
      await mutateCommentsAsync(payload);
      closeSection('comments');
    } catch {
      // Errors are handled by the mutation.
    }
  }

  async function handleSaveSectionToAllChats(section: ApplySectionKey) {
    if (!chatId || !draft) {
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
      note?: string | null;
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
    const footerNote = options?.note !== undefined ? options.note : null;

    return (
      <>
        {footerNote ? <p className="settings-drilldown__footer-note">{footerNote}</p> : null}
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

  function handleDesktopToggleRowClick(event: MouseEvent<HTMLElement>) {
    const switchLabel = resolveDesktopToggleRowLabel(event.target);
    if (!switchLabel) {
      return;
    }

    event.preventDefault();
    switchLabel.click();
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
        <section
          className="settings-sections settings-sections--chat-home"
          aria-label="Настройки модерации"
          onClickCapture={handleDesktopToggleRowClick}
        >
          <CompactStickyHeader
            backTo={buildManagedEntitiesRoute('chat')}
            backLabel="Назад к чатам"
            title={chatTitle || chatId || 'Настройки'}
            subtitle="Настройки чата"
            avatar={
              <EntityAvatar
                title={chatTitle || chatId || 'Настройки'}
                entityType="chat"
                avatarUrl={chatHeaderQuery.data?.avatarUrl ?? routeChatAvatarUrl ?? null}
                className="compact-page-header__entity-avatar"
              />
            }
            compact={isHeaderCompact}
            hidden={isHeaderHidden}
            className="settings-home-sticky-header stagger-in"
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
                    <span className="settings-native-toggle__title">3. Мут</span>
                  </div>
                  <p className="settings-native-toggle__hint">{pendingSpeechStyleSamples.mute}</p>
                </div>

                <div className="settings-native-toggle settings-native-toggle--nested">
                  <div className="settings-native-toggle__row">
                    <span className="settings-native-toggle__title">4. Бан</span>
                  </div>
                  <p className="settings-native-toggle__hint">{pendingSpeechStyleSamples.ban}</p>
                </div>
              </div>
            ) : null}
          </SettingsDrilldownPanel>

          <div className="settings-sections-shell">
            <div className="settings-home-group-head stagger-in" style={{ order: 10 }}>
              <h2 className="settings-home-group-head__title">Защита</h2>
            </div>

            <div className="settings-home-group-head stagger-in" style={{ order: 20 }}>
              <h2 className="settings-home-group-head__title">Контент</h2>
            </div>

            <div className="settings-home-group-head stagger-in" style={{ order: 30 }}>
              <h2 className="settings-home-group-head__title">Бот</h2>
            </div>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
              style={{ order: 1 }}
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Ссылки"
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
                footer={renderSectionSaveFooter('links', {
                  note: isLinksKeyboardOpen ? null : undefined,
                })}
                keepFooterVisibleWhenKeyboardOpen
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
                                  <span className="policy-card__content">
                                    <span className="policy-card__eyebrow">{option.eyebrow}</span>
                                    <span className="policy-card__text">
                                      <span className="policy-card__title">{option.label}</span>
                                      <small className="policy-card__description">
                                        {option.description}
                                      </small>
                                    </span>
                                  </span>
                                  <span className="policy-card__selection" aria-hidden />
                                </button>
                              );
                            })}
                          </div>
                          {linkPolicyError ? (
                            <small className="field__hint">{linkPolicyError}</small>
                          ) : null}
                        </div>

                        {isAllowlistMode ? (
                          <div className="allowlist-workspace">
                            <div
                              className={cn(
                                'field',
                                'allowlist-panel',
                                domainInputError && 'allowlist-panel--error',
                              )}
                            >
                              <div className="allowlist-panel__head">
                                <div className="allowlist-panel__title-block">
                                  <div className="allowlist-panel__title-row">
                                    <span className="field__label">
                                      Разрешенные ссылки и домены
                                    </span>
                                    <SettingsHintAnchor
                                      hintKey="linkAllowlistScope"
                                      openHintKey={openHintKey}
                                      onToggleHint={toggleHint}
                                      label="Пояснение по разрешенным ссылкам и доменам"
                                    >
                                      Выберите точную ссылку или весь домен. Доменные правила
                                      разрешают все пути только этого хоста, без wildcard по
                                      поддоменам.
                                    </SettingsHintAnchor>
                                  </div>
                                </div>
                                <span className="chip chip--success">
                                  {allowlistEntries.length}
                                </span>
                              </div>

                              <div className="allowlist-composer">
                                <div className="allowlist-composer__head">
                                  <span className="allowlist-composer__label">Что разрешить</span>
                                  <SettingsHintAnchor
                                    hintKey="linkAllowlistMode"
                                    openHintKey={openHintKey}
                                    onToggleHint={toggleHint}
                                    label="Пояснение по режиму разрешения ссылки"
                                  >
                                    {domainInputMode === 'DOMAIN'
                                      ? 'Разрешит весь хост, например `example.com`.'
                                      : 'Разрешит только один конкретный URL, включая путь и параметры.'}
                                  </SettingsHintAnchor>
                                </div>
                                <SegmentedControl
                                  value={domainInputMode}
                                  options={ALLOWLIST_MATCH_OPTIONS}
                                  onChange={(value) => {
                                    setDomainInputMode(value);
                                    setDomainInputError('');
                                  }}
                                  className="allowlist-composer__mode"
                                />
                                <div className="allowlist-add-row">
                                  <input
                                    type="text"
                                    inputMode={domainInputMode === 'EXACT' ? 'url' : 'text'}
                                    value={domainInput}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    enterKeyHint="done"
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
                                    placeholder={
                                      domainInputMode === 'DOMAIN'
                                        ? 'example.com'
                                        : 'https://example.com/path'
                                    }
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

                                <div
                                  className="allowlist-composer__examples"
                                  aria-label="Быстрые примеры"
                                >
                                  {allowlistComposerExamples.map((example) => (
                                    <button
                                      key={example.value}
                                      type="button"
                                      className="allowlist-composer__example"
                                      title={example.label}
                                      onClick={() => {
                                        setDomainInput(example.value);
                                        setDomainInputError('');
                                      }}
                                    >
                                      {example.label}
                                    </button>
                                  ))}
                                </div>
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
                                  <div className="allowlist-results">
                                    <div className="allowlist-results__head">
                                      <span className="allowlist-results__title">В списке</span>
                                      <small>{allowlistCountLabel}</small>
                                    </div>

                                    <ul
                                      className="allowlist-list"
                                      aria-label="Разрешенные ссылки и домены"
                                    >
                                      {allowlistEntries.map((entry) => {
                                        const isScheduleOpen =
                                          scheduleDomain === entry.normalizedValue;
                                        const scheduledAtLabel = formatRemovalDateTime(
                                          entry.removeAfterAt,
                                        );
                                        const entryIdSuffix = encodeURIComponent(
                                          entry.normalizedValue,
                                        );

                                        return (
                                          <li
                                            key={entry.normalizedValue}
                                            className={cn(
                                              'allowlist-item',
                                              'allowlist-item--domain',
                                            )}
                                          >
                                            <div className="allowlist-item__stack">
                                              <div className="allowlist-item__header">
                                                <div className="allowlist-item__lead">
                                                  <span
                                                    className="allowlist-item__domain"
                                                    title={entry.domain}
                                                  >
                                                    {entry.domain}
                                                  </span>
                                                  <small className="allowlist-item__type">
                                                    {formatAllowlistModeLabel(entry.matchType)}
                                                  </small>
                                                </div>
                                                <span
                                                  className={cn(
                                                    'chip',
                                                    'allowlist-item__status',
                                                    scheduledAtLabel
                                                      ? 'chip--warning'
                                                      : 'chip--success',
                                                  )}
                                                >
                                                  {scheduledAtLabel ? 'По таймеру' : 'Без таймера'}
                                                </span>
                                              </div>

                                              <small className="allowlist-item__meta">
                                                {formatAllowlistMetaLabel(entry, scheduledAtLabel)}
                                              </small>

                                              <div className="allowlist-item__actions">
                                                <button
                                                  type="button"
                                                  className={cn(
                                                    'allowlist-item__action',
                                                    'allowlist-item__action--schedule',
                                                    isScheduleOpen && 'is-open',
                                                  )}
                                                  aria-label={`Запланировать удаление ${entry.domain}`}
                                                  title="Запланировать удаление"
                                                  onClick={() => toggleDomainScheduleEditor(entry)}
                                                  disabled={isDomainMutationPending}
                                                >
                                                  <CalendarIcon />
                                                  <span>
                                                    {scheduledAtLabel
                                                      ? isScheduleOpen
                                                        ? 'Свернуть таймер'
                                                        : 'Изменить таймер'
                                                      : isScheduleOpen
                                                        ? 'Свернуть таймер'
                                                        : 'Поставить таймер'}
                                                  </span>
                                                </button>
                                                <button
                                                  type="button"
                                                  className={cn(
                                                    'allowlist-item__action',
                                                    'allowlist-item__action--remove',
                                                  )}
                                                  onClick={() =>
                                                    removeDomainMutation.mutate(
                                                      entry.normalizedValue,
                                                    )
                                                  }
                                                  disabled={isDomainMutationPending}
                                                  aria-label={`Удалить ${entry.domain} из разрешенных`}
                                                  title="Удалить правило"
                                                >
                                                  <TrashIcon />
                                                  <span>Удалить</span>
                                                </button>
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
                                                        submitDomainSchedule(entry.normalizedValue)
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
                                                          clearDomainSchedule(entry.normalizedValue)
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
                                  </div>
                                ) : (
                                  <p className="allowlist-empty">
                                    Список пуст. Добавьте первое правило.
                                  </p>
                                )
                              ) : null}
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
                                  предупреждение, потом мут и далее бан.
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

                            {renderMuteStageToggle({
                              enabledKey: 'linkMuteEnabled',
                              durationKey: 'linkMuteDurationHours',
                              title: '3. Мут',
                              onEnable: () => {
                                setFieldValue('linkWarnEnabled', true);
                                setFieldValue('linkBotMessageEnabled', true);
                              },
                            })}

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">4. Бан</span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить бан за повторные ссылки"
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

                                {renderInlineHint(
                                  'linkBotButton',
                                  'link-bot-button-hint',
                                  'Добавляет кнопку в сообщение бота. Подходит для ссылки на чат, канал или профиль.',
                                  hasLinkBotButtonError,
                                )}

                                {draft.linkBotButtonEnabled ? (
                                  <ManagedLinkButtonFieldsSlot
                                    api={api}
                                    urlValue={draft.linkBotButtonUrl}
                                    onUrlChange={(nextValue) =>
                                      setFieldValue('linkBotButtonUrl', nextValue)
                                    }
                                    textValue={draft.linkBotButtonText}
                                    onTextChange={(nextValue) =>
                                      setFieldValue('linkBotButtonText', nextValue)
                                    }
                                    urlError={linkBotButtonUrlError}
                                    textError={linkBotButtonTextError}
                                    urlPlaceholder="https://max.ru/channel/..."
                                    textPlaceholder="Открыть"
                                  />
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
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '45ms', order: 21 }}
              aria-label="Правила"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Правила"
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
                            <div className="rules-studio">
                              <div className="rules-studio__hero rules-hero-card">
                                <div className="rules-hero-card__head">
                                  <div className="rules-hero-card__copy">
                                    <span className="rules-studio__eyebrow">Пост с правилами</span>
                                    <h4>{rulesHeroTitle}</h4>
                                    <p>{rulesHeroMeta}</p>
                                  </div>
                                  <span
                                    className={cn(
                                      'chip',
                                      hasPublishedRules
                                        ? 'chip--success'
                                        : hasRulesDraftText
                                          ? 'chip--warning'
                                          : undefined,
                                    )}
                                  >
                                    {rulesHeroStatusLabel}
                                  </span>
                                </div>

                                <div className="rules-hero-card__meta">
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
                                </div>

                                <div className="rules-hero-card__actions">
                                  <button
                                    type="button"
                                    className="button button--ghost rules-hero-card__secondary"
                                    onClick={() => void handleHandoffRules()}
                                    disabled={
                                      rulesQuery.isLoading ||
                                      Boolean(rulesQuery.error) ||
                                      handoffRulesMutation.isPending
                                    }
                                  >
                                    {handoffRulesMutation.isPending
                                      ? 'Открываем бота...'
                                      : 'Редактировать в боте'}
                                  </button>

                                  <button
                                    type="button"
                                    className="button button--accent rules-hero-card__primary"
                                    onClick={() => void handlePublishRules()}
                                    disabled={
                                      rulesQuery.isLoading ||
                                      Boolean(rulesQuery.error) ||
                                      isPublishingRules ||
                                      isSavingRules
                                    }
                                  >
                                    {isPublishingRules
                                      ? 'Публикуем...'
                                      : hasPublishedRules
                                        ? 'Переопубликовать'
                                        : 'Опубликовать'}
                                  </button>
                                </div>

                                {hasPublishedRules ? (
                                  <button
                                    type="button"
                                    className="button button--ghost rules-hero-card__reset"
                                    onClick={handleResetPublishedRules}
                                    disabled={isResettingPublishedRules}
                                  >
                                    {isResettingPublishedRules
                                      ? 'Сбрасываем...'
                                      : 'Сбросить публикацию'}
                                  </button>
                                ) : null}
                              </div>

                              <div className="rules-settings-stack">
                                <div className="settings-native-toggle rules-native-card">
                                  <div className="settings-native-toggle__row">
                                    <div className="settings-native-toggle__title-wrap">
                                      <div className="rules-native-card__copy">
                                        <span className="settings-native-toggle__title">
                                          Автозаполнять правила из настроек
                                        </span>
                                        <span className="rules-native-card__meta">
                                          {rulesAutoFillSummary}
                                        </span>
                                      </div>
                                    </div>

                                    <label
                                      className="settings-native-switch"
                                      aria-label="Включить автозаполнение правил из настроек"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={Boolean(rulesDraft.autoTextEnabled)}
                                        onChange={(event) =>
                                          setRulesDraft((current) =>
                                            current
                                              ? {
                                                  ...current,
                                                  autoTextEnabled: event.target.checked,
                                                }
                                              : current,
                                          )
                                        }
                                      />
                                      <span className="toggle-switch" aria-hidden>
                                        <span className="toggle-switch__thumb" />
                                      </span>
                                    </label>
                                  </div>
                                </div>

                                <div className="settings-native-toggle rules-native-card">
                                  <div className="settings-native-toggle__row">
                                    <div className="settings-native-toggle__title-wrap">
                                      <div className="rules-native-card__copy">
                                        <span className="settings-native-toggle__title">
                                          Пользовательская кнопка в посте
                                        </span>
                                        <span className="rules-native-card__meta">
                                          {rulesPostButtonSummary}
                                        </span>
                                      </div>
                                    </div>

                                    <label
                                      className="settings-native-switch"
                                      aria-label="Включить пользовательскую кнопку в посте правил"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={rulesDraft.buttonEnabled}
                                        onChange={(event) => {
                                          setRulesButtonFieldsTouched(false);
                                          setRulesButtonUrlError('');
                                          setRulesButtonTextError('');
                                          setRulesDraft((current) =>
                                            current
                                              ? {
                                                  ...current,
                                                  buttonEnabled: event.target.checked,
                                                  buttonText:
                                                    current.buttonText ||
                                                    DEFAULT_RULES_POST_BUTTON_TEXT,
                                                }
                                              : current,
                                          );
                                        }}
                                      />
                                      <span className="toggle-switch" aria-hidden>
                                        <span className="toggle-switch__thumb" />
                                      </span>
                                    </label>
                                  </div>

                                  {rulesDraft.buttonEnabled ? (
                                    <div className="rules-native-card__body">
                                      <div className="rules-button-preview">
                                        {hasRulesButtonPreviewUrl ? (
                                          <a
                                            href={rulesButtonPreviewUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="rules-button-preview__button"
                                          >
                                            {rulesButtonPreviewText}
                                          </a>
                                        ) : (
                                          <span
                                            className="rules-button-preview__button is-disabled"
                                            aria-disabled="true"
                                          >
                                            {rulesButtonPreviewText}
                                          </span>
                                        )}
                                      </div>
                                      <ManagedLinkButtonFieldsSlot
                                        api={api}
                                        urlValue={rulesDraft.buttonUrl}
                                        onUrlChange={(nextValue) => {
                                          setRulesButtonFieldsTouched(true);
                                          if (rulesButtonUrlError) {
                                            setRulesButtonUrlError('');
                                          }
                                          setRulesDraft((current) =>
                                            current
                                              ? {
                                                  ...current,
                                                  buttonUrl: nextValue,
                                                }
                                              : current,
                                          );
                                        }}
                                        textValue={rulesDraft.buttonText}
                                        onTextChange={(nextValue) => {
                                          setRulesButtonFieldsTouched(true);
                                          if (rulesButtonTextError) {
                                            setRulesButtonTextError('');
                                          }
                                          setRulesDraft((current) =>
                                            current
                                              ? {
                                                  ...current,
                                                  buttonText: nextValue,
                                                }
                                              : current,
                                          );
                                        }}
                                        urlError={rulesButtonUrlError || undefined}
                                        textError={rulesButtonTextError || undefined}
                                        urlPlaceholder="https://max.ru/channel/rules"
                                        textPlaceholder={DEFAULT_RULES_POST_BUTTON_TEXT}
                                        urlHint={null}
                                        textHint={null}
                                      />
                                    </div>
                                  ) : null}
                                </div>

                                <div className="settings-native-toggle rules-native-card">
                                  <div className="settings-native-toggle__row">
                                    <div className="settings-native-toggle__title-wrap">
                                      <div className="rules-native-card__copy">
                                        <span className="settings-native-toggle__title">
                                          Кнопка «Правила» в нарушениях
                                        </span>
                                        <span className="rules-native-card__meta">
                                          {rulesViolationButtonSummary}
                                        </span>
                                      </div>
                                    </div>

                                    <label
                                      className="settings-native-switch"
                                      aria-label="Включить кнопку Правила в сообщениях о нарушениях"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={Boolean(draft?.rulesAttachViolationsEnabled)}
                                        disabled={updateRulesAttachMutation.isPending}
                                        onChange={(event) =>
                                          updateRulesAttachMutation.mutate(event.target.checked)
                                        }
                                      />
                                      <span className="toggle-switch" aria-hidden>
                                        <span className="toggle-switch__thumb" />
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              </div>
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
                className="settings-section settings-home-entry settings-home-entry--list stagger-in"
                style={{ animationDelay: '52ms', order: 24 }}
                aria-label="Опрос чата"
              >
                <div
                  className={cn('settings-section__head', 'settings-section__head--interactive')}
                >
                  <SettingsSectionToggle
                    title="Опросы"
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
                className="settings-section settings-home-entry settings-home-entry--list stagger-in"
                style={{ animationDelay: '56ms', order: 25 }}
                aria-label="Розыгрыши"
              >
                <div
                  className={cn('settings-section__head', 'settings-section__head--interactive')}
                >
                  <SettingsSectionToggle
                    title="Розыгрыши"
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
                  className="settings-drilldown__panel--giveaway"
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
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '60ms', order: 22 }}
              aria-label="Приветствие новых участников"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Приветствие"
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
                            <span className="settings-native-toggle__title">Приветствие</span>
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
                                  setFieldValue('greetingRulesButtonEnabled', false);
                                  clearFieldError('greetingRulesButtonEnabled');
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
                                      setFieldValue('greetingRulesButtonEnabled', false);
                                      clearFieldError('greetingRulesButtonEnabled');
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
                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    Удалять приветствие
                                  </span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'greetingDeleteBotMessages' && 'is-open',
                                    )}
                                    aria-label="Пояснение для автоудаления приветствия"
                                    aria-controls="greeting-delete-bot-messages-hint"
                                    aria-expanded={openHintKey === 'greetingDeleteBotMessages'}
                                    onClick={() => toggleHint('greetingDeleteBotMessages')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить автоудаление приветственных сообщений бота"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.greetingDeleteBotMessageEnabled}
                                    onChange={(event) =>
                                      setFieldValue(
                                        'greetingDeleteBotMessageEnabled',
                                        event.target.checked,
                                      )
                                    }
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {openHintKey === 'greetingDeleteBotMessages' ? (
                                <p
                                  id="greeting-delete-bot-messages-hint"
                                  className="settings-native-toggle__hint"
                                >
                                  Бот будет автоматически удалять приветствие через выбранное время.
                                </p>
                              ) : null}
                            </div>
                          ) : null}

                          {draft.greetingBotMessageEnabled &&
                          draft.greetingDeleteBotMessageEnabled ? (
                            <DeleteDelayStepper
                              title="Через сколько удалять"
                              value={draft.greetingDeleteBotMessageDelayMinutes}
                              fieldError={fieldErrors.greetingDeleteBotMessageDelayMinutes}
                              groupAriaLabel="Задержка удаления приветствия"
                              decreaseAriaLabel="Уменьшить задержку удаления приветствия"
                              increaseAriaLabel="Увеличить задержку удаления приветствия"
                              onAdjust={adjustGreetingDeleteBotMessagesDelay}
                            />
                          ) : null}

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

                              {renderInlineHint(
                                'greetingBotButton',
                                'greeting-bot-button-hint',
                                'Добавляет кнопку в приветствие, например на чат или канал.',
                                hasGreetingBotButtonError,
                              )}

                              {draft.greetingBotButtonEnabled ? (
                                <ManagedLinkButtonFieldsSlot
                                  api={api}
                                  urlValue={draft.greetingBotButtonUrl}
                                  onUrlChange={(nextValue) =>
                                    setFieldValue('greetingBotButtonUrl', nextValue)
                                  }
                                  textValue={draft.greetingBotButtonText}
                                  onTextChange={(nextValue) =>
                                    setFieldValue('greetingBotButtonText', nextValue)
                                  }
                                  urlError={greetingBotButtonUrlError}
                                  textError={greetingBotButtonTextError}
                                  urlPlaceholder="https://max.ru/channel/rules"
                                  textPlaceholder="Открыть"
                                />
                              ) : null}
                            </div>
                          ) : null}

                          {draft.greetingBotMessageEnabled ? (
                            <PublishedRulesButtonToggleSlot
                              ariaLabel="Кнопка Правила в приветствии"
                              enabled={draft.greetingRulesButtonEnabled}
                              hasRules={hasPublishedRules}
                              onChange={(enabled) =>
                                setFieldValue('greetingRulesButtonEnabled', enabled)
                              }
                            />
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '90ms', order: 11 }}
              aria-label="Мат и оскорбления"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Мат и оскорбления"
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
                title="Мат и оскорбления"
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

                          {renderMuteStageToggle({
                            enabledKey: 'profanityMuteEnabled',
                            durationKey: 'profanityMuteDurationHours',
                            title: '3. Мут',
                            onEnable: () => {
                              setFieldValue('profanityWarnEnabled', true);
                              setFieldValue('profanityBotMessageEnabled', true);
                            },
                          })}

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">4. Бан</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить бан за повторную нецензурную лексику"
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
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '135ms', order: 12 }}
              aria-label="Коммерческая реклама"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Коммерческая реклама"
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
                title="Коммерческая реклама"
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
                              Фильтровать коммерческую рекламу (RU)
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'textFiltersCommercial' && 'is-open',
                              )}
                              aria-label='Пояснение для "Фильтровать коммерческую рекламу (RU)"'
                              aria-controls="commercial-ads-filter-enabled-hint"
                              aria-expanded={openHintKey === 'textFiltersCommercial'}
                              onClick={() => toggleHint('textFiltersCommercial')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Фильтровать коммерческую рекламу (RU)"
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
                            Удаляет явную коммерческую промо-подачу: акции, витрины и ссылки на
                            продажу. Частные объявления и разовые бытовые услуги старается не
                            трогать.
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
                            <span>Фильтр коммерческой рекламы</span>
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
                                WARN {draft.commercialAdsWarnThreshold} • DELETE{' '}
                                {draft.commercialAdsDeleteThreshold}.
                              </p>
                            ) : null}
                          </div>

                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Действия бота для коммерческих объявлений"
                          >
                            <span>Действия бота · Коммерческая реклама</span>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">1. Объяснение</span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст сообщения об удалении рекламы"
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
                                    label="Редактировать текст предупреждения об удалении рекламы"
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

                          {renderMuteStageToggle({
                            enabledKey: 'textFiltersMuteEnabled',
                            durationKey: 'textFiltersMuteDurationHours',
                            title: '3. Мут',
                            onEnable: () => {
                              setFieldValue('textFiltersWarnEnabled', true);
                              setFieldValue('textFiltersBotMessageEnabled', true);
                            },
                          })}

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">4. Бан</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить бан за повторное нарушение коммерческого фильтра"
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

                              {renderInlineHint(
                                'textFiltersBotButton',
                                'text-filters-bot-button-hint',
                                'Добавляет кнопку в сообщение бота о коммерческом нарушении.',
                                hasTextFiltersBotButtonError,
                              )}

                              {draft.textFiltersBotButtonEnabled ? (
                                <ManagedLinkButtonFieldsSlot
                                  api={api}
                                  urlValue={draft.textFiltersBotButtonUrl}
                                  onUrlChange={(nextValue) =>
                                    setFieldValue('textFiltersBotButtonUrl', nextValue)
                                  }
                                  textValue={draft.textFiltersBotButtonText}
                                  onTextChange={(nextValue) =>
                                    setFieldValue('textFiltersBotButtonText', nextValue)
                                  }
                                  urlError={textFiltersBotButtonUrlError}
                                  textError={textFiltersBotButtonTextError}
                                  urlPlaceholder="https://max.ru/channel/rules"
                                  textPlaceholder="Правила чата"
                                />
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
                className="settings-section settings-home-entry settings-home-entry--list stagger-in"
                style={{ animationDelay: '157ms', order: 13 }}
                aria-label="Кодовые слова"
              >
                <div
                  className={cn('settings-section__head', 'settings-section__head--interactive')}
                >
                  <SettingsSectionToggle
                    title="Кодовые слова"
                    icon="keywords"
                    tone="sky"
                    open={expandedSections.thematicFilters}
                    controls="settings-thematic-filters-content"
                    onClick={() => toggleSection('thematicFilters')}
                  />
                </div>

                <SettingsDrilldownPanel
                  id="settings-thematic-filters-content"
                  open={expandedSections.thematicFilters}
                  title="Кодовые слова"
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
                              <ManagedLinkButtonFieldsSlot
                                api={api}
                                urlValue={draft.thematicFiltersBotButtonUrl}
                                onUrlChange={(nextValue) =>
                                  setFieldValue('thematicFiltersBotButtonUrl', nextValue)
                                }
                                textValue={draft.thematicFiltersBotButtonText}
                                onTextChange={(nextValue) =>
                                  setFieldValue('thematicFiltersBotButtonText', nextValue)
                                }
                                urlError={thematicBotButtonUrlError}
                                textError={thematicBotButtonTextError}
                                urlPlaceholder="https://max.ru/channel/..."
                                textPlaceholder="Открыть"
                              />
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

                            {renderMuteStageToggle({
                              enabledKey: 'thematicFiltersMuteEnabled',
                              durationKey: 'thematicFiltersMuteDurationHours',
                              title: '3. Мут',
                              onEnable: () => {
                                setFieldValue('thematicFiltersWarnEnabled', true);
                                setFieldValue('thematicFiltersBotMessageEnabled', true);
                              },
                            })}

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">4. Бан</span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить бан для повторного нарушения тематического фильтра"
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
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </SettingsDrilldownPanel>
              </GlassCard>
            ) : null}

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '180ms', order: 14 }}
              aria-label="Повторы"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Повторы"
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
                          <span className="settings-native-toggle__title">Антидубль</span>
                          <label className="settings-native-switch" aria-label="Включить антидубль">
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

                      {draft.antiDuplicateEnabled ? (
                        <div className="settings-native-toggle">
                          <div className="settings-native-toggle__row">
                            <div className="settings-native-toggle__title-wrap">
                              <span className="settings-native-toggle__title">1. Объяснение</span>
                              <div className="settings-native-toggle__title-actions">
                                <EditToggleButton
                                  label="Текст о дублях"
                                  onClick={() => toggleBotMessageEditor('duplicate')}
                                  disabled={!draft.duplicateBotMessageEnabled}
                                  isOpen={openBotEditorKey === 'duplicate'}
                                />
                              </div>
                            </div>

                            <label
                              className="settings-native-switch"
                              aria-label="Сообщение о дублях"
                            >
                              <input
                                type="checkbox"
                                checked={draft.duplicateBotMessageEnabled}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  applyDuplicateFlowConfig({
                                    duplicateBotMessageEnabled: enabled,
                                  });
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
                            <span className="settings-native-toggle__title">Добавить кнопку</span>

                            <label
                              className="settings-native-switch"
                              aria-label="Кнопка в сообщении о дублях"
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
                            <ManagedLinkButtonFieldsSlot
                              api={api}
                              urlValue={draft.duplicateBotButtonUrl}
                              onUrlChange={(nextValue) =>
                                setFieldValue('duplicateBotButtonUrl', nextValue)
                              }
                              textValue={draft.duplicateBotButtonText}
                              onTextChange={(nextValue) =>
                                setFieldValue('duplicateBotButtonText', nextValue)
                              }
                              urlError={duplicateBotButtonUrlError}
                              textError={duplicateBotButtonTextError}
                              urlPlaceholder="https://max.ru/profile/..."
                              textPlaceholder="Открыть"
                            />
                          ) : null}
                        </div>
                      ) : null}

                      {draft.antiDuplicateEnabled ? (
                        <>
                          <article
                            className={cn(
                              'duplicate-stage',
                              (fieldErrors.duplicateWarnWindowSec ||
                                fieldErrors.duplicateWarnMaxCount) &&
                                'field--error',
                            )}
                          >
                            <div className="duplicate-stage__top">
                              <span className="duplicate-stage__title">
                                Когда включать модерацию
                              </span>
                            </div>

                            <div className="duplicate-stage__controls">
                              <label
                                className={cn(
                                  'duplicate-stage__field',
                                  fieldErrors.duplicateWarnWindowSec && 'field--error',
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
                                      duplicateWindowInputValue ||
                                      String(duplicateSharedWindowHours)
                                    }
                                    onChange={(event) =>
                                      handleDuplicateWindowHoursChange(event.target.value)
                                    }
                                    onBlur={handleDuplicateWindowHoursBlur}
                                    aria-label="Интервал дублей, часы"
                                  />
                                  <span className="duplicate-stage__suffix" aria-hidden>
                                    часы
                                  </span>
                                </div>
                              </label>

                              <div
                                className={cn(
                                  'duplicate-stage__field',
                                  fieldErrors.duplicateWarnMaxCount && 'field--error',
                                )}
                              >
                                <span className="duplicate-stage__field-label">
                                  Разрешено дублей
                                </span>
                                <div
                                  className="duplicate-count-stepper"
                                  role="group"
                                  aria-label="Разрешено дублей"
                                >
                                  <button
                                    type="button"
                                    className="duplicate-count-stepper__button"
                                    onClick={() =>
                                      adjustDuplicateAllowedCount(duplicateAllowedCount, -1)
                                    }
                                    disabled={duplicateAllowedCount <= DUPLICATE_ALLOWED_COUNT_MIN}
                                    aria-label="Меньше дублей"
                                  >
                                    -
                                  </button>

                                  <output
                                    className="duplicate-count-stepper__value"
                                    aria-live="polite"
                                  >
                                    {duplicateAllowedCount}
                                  </output>

                                  <button
                                    type="button"
                                    className="duplicate-count-stepper__button"
                                    onClick={() =>
                                      adjustDuplicateAllowedCount(duplicateAllowedCount, 1)
                                    }
                                    disabled={duplicateAllowedCount >= DUPLICATE_ALLOWED_COUNT_MAX}
                                    aria-label="Больше дублей"
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            </div>

                            {fieldErrors.duplicateWarnWindowSec ||
                            fieldErrors.duplicateWarnMaxCount ? (
                              <div className="duplicate-stage__errors">
                                {fieldErrors.duplicateWarnWindowSec ? (
                                  <small className="field__hint">
                                    {fieldErrors.duplicateWarnWindowSec}
                                  </small>
                                ) : null}
                                {fieldErrors.duplicateWarnMaxCount ? (
                                  <small className="field__hint">
                                    {fieldErrors.duplicateWarnMaxCount}
                                  </small>
                                ) : null}
                              </div>
                            ) : null}
                          </article>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">
                                2. Предупреждение
                              </span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить предупреждение за повторы"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateWarnEnabled}
                                  onChange={(event) =>
                                    applyDuplicateFlowConfig({
                                      duplicateWarnEnabled: event.target.checked,
                                    })
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div
                            className={cn(
                              'settings-native-toggle',
                              'settings-native-toggle--nested',
                              fieldErrors.duplicateMuteDurationHours && 'field--error',
                            )}
                          >
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">3. Мут</span>
                                <div className="settings-native-toggle__title-actions">
                                  <button
                                    type="button"
                                    className={cn(
                                      'logs-violation-item__ban-preset',
                                      openMuteDurationKey === 'duplicateMuteDurationHours' &&
                                        'is-active',
                                    )}
                                    onClick={() =>
                                      toggleMuteDurationEditor('duplicateMuteDurationHours')
                                    }
                                  >
                                    <ClockIcon />
                                    <span>
                                      {formatMuteDurationCompact(
                                        Number(draft.duplicateMuteDurationHours),
                                      )}
                                    </span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить мут за повторы"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateMuteEnabled}
                                  onChange={(event) =>
                                    applyDuplicateFlowConfig({
                                      duplicateMuteEnabled: event.target.checked,
                                    })
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {renderMuteDurationEditor('duplicateMuteDurationHours', 'Срок мута')}

                            {fieldErrors.duplicateMuteDurationHours ? (
                              <small className="field__hint">
                                {fieldErrors.duplicateMuteDurationHours}
                              </small>
                            ) : null}
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">4. Бан</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить бан за повторы"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateBanEnabled}
                                  onChange={(event) =>
                                    applyDuplicateFlowConfig({
                                      duplicateBanEnabled: event.target.checked,
                                    })
                                  }
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
              className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
              style={{ animationDelay: '225ms', order: 2 }}
              aria-label="Ограничения"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Ограничения"
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
                        className={cn(
                          'settings-word-banlist',
                          messageLimitsBlockedWordsError && 'settings-word-banlist--error',
                        )}
                      >
                        <div className="settings-word-banlist__head">
                          <span className="settings-native-toggle__title">Стоп-слова</span>
                          {messageLimitsBlockedWords.length > 0 ? (
                            <span className="chip chip--danger">
                              {messageLimitsBlockedWords.length}
                            </span>
                          ) : null}
                        </div>

                        <Suspense fallback={null}>
                          <LazyMessageLimitsBlockedWordPresets
                            selectedWords={draft.messageLimitsBlockedWords}
                            remainingSlots={messageLimitsBlockedWordsRemaining}
                            onApplyWords={applyMessageLimitsBlockedWords}
                          />
                        </Suspense>

                        <div className="settings-word-banlist__add-row">
                          <input
                            type="text"
                            value={messageLimitsBlockedWordsInput}
                            onChange={(event) => {
                              setMessageLimitsBlockedWordsInput(event.target.value);
                              clearFieldError('messageLimitsBlockedWords');
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ',') {
                                event.preventDefault();
                                addMessageLimitsBlockedWords();
                              }
                            }}
                            placeholder="Введите слово"
                            maxLength={240}
                            disabled={
                              messageLimitsBlockedWords.length >= MESSAGE_LIMITS_BLOCKED_WORDS_MAX
                            }
                            aria-label="Добавить стоп-слово"
                          />
                          <button
                            type="button"
                            className="button button--accent settings-word-banlist__add-button"
                            onClick={addMessageLimitsBlockedWords}
                            disabled={
                              !messageLimitsBlockedWordsInput.trim() ||
                              messageLimitsBlockedWords.length >= MESSAGE_LIMITS_BLOCKED_WORDS_MAX
                            }
                          >
                            Добавить
                          </button>
                        </div>

                        {messageLimitsBlockedWords.length > 0 ? (
                          <>
                            <div className="settings-word-banlist__chips-head">
                              <small className="settings-word-banlist__chips-caption">
                                {hasMessageLimitsBlockedWordsOverflow &&
                                !messageLimitsBlockedWordsExpanded
                                  ? `Показаны последние ${visibleMessageLimitsBlockedWords.length} из ${messageLimitsBlockedWords.length}`
                                  : `Все ${messageLimitsBlockedWords.length} слов`}
                              </small>
                              {hasMessageLimitsBlockedWordsOverflow ? (
                                <button
                                  type="button"
                                  className="settings-word-banlist__toggle"
                                  onClick={() =>
                                    setMessageLimitsBlockedWordsExpanded((current) => !current)
                                  }
                                  aria-expanded={messageLimitsBlockedWordsExpanded}
                                  aria-controls="settings-message-limits-blocked-words"
                                >
                                  {messageLimitsBlockedWordsExpanded
                                    ? 'Свернуть'
                                    : `Показать все ${messageLimitsBlockedWords.length}`}
                                </button>
                              ) : null}
                            </div>

                            <div
                              className="settings-word-banlist__chips"
                              id="settings-message-limits-blocked-words"
                              aria-label="Стоп-слова"
                            >
                              {visibleMessageLimitsBlockedWords.map((word) => (
                                <button
                                  key={word}
                                  type="button"
                                  className="settings-word-banlist__chip"
                                  onClick={() => removeMessageLimitsBlockedWord(word)}
                                  aria-label={`Удалить слово ${word}`}
                                >
                                  <span>{word}</span>
                                  <span aria-hidden>+</span>
                                </button>
                              ))}
                            </div>
                          </>
                        ) : null}

                        {messageLimitsBlockedWordsError ? (
                          <small className="field__hint">{messageLimitsBlockedWordsError}</small>
                        ) : null}
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

                      {renderMuteStageToggle({
                        enabledKey: 'messageLimitsMuteEnabled',
                        durationKey: 'messageLimitsMuteDurationHours',
                        title: '3. Мут',
                        onEnable: () => {
                          setFieldValue('messageLimitsWarnEnabled', true);
                          setFieldValue('messageLimitsBotMessageEnabled', true);
                        },
                      })}

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">4. Бан</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить бан за повторные нарушения ограничений сообщений"
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

                          {renderInlineHint(
                            'messageLimitsBotButton',
                            'message-limits-bot-button-hint',
                            'Добавляет кнопку в сообщение бота с переходом на чат, канал или профиль.',
                            hasMessageLimitsBotButtonError,
                          )}

                          {draft.messageLimitsBotButtonEnabled ? (
                            <ManagedLinkButtonFieldsSlot
                              api={api}
                              urlValue={draft.messageLimitsBotButtonUrl}
                              onUrlChange={(nextValue) =>
                                setFieldValue('messageLimitsBotButtonUrl', nextValue)
                              }
                              textValue={draft.messageLimitsBotButtonText}
                              onTextChange={(nextValue) =>
                                setFieldValue('messageLimitsBotButtonText', nextValue)
                              }
                              urlError={messageLimitsBotButtonUrlError}
                              textError={messageLimitsBotButtonTextError}
                              urlPlaceholder="https://max.ru/channel/..."
                              textPlaceholder="Открыть"
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '270ms', order: 15 }}
              aria-label="Ночной режим"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Ночной режим"
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
                                setDraft((current) =>
                                  current ? applyNightModeEnabledChange(current, enabled) : current,
                                );
                                clearFieldError('nightModeEnabled');
                                if (!enabled) {
                                  clearFieldError('nightModeBotMessageEnabled');
                                  clearFieldError('nightModeCommentsEnabled');
                                  clearFieldError('nightModeBotButtonEnabled');
                                  clearFieldError('nightModeRulesButtonEnabled');
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
                                    setDraft((current) =>
                                      current
                                        ? applyNightModeBotMessageEnabledChange(current, enabled)
                                        : current,
                                    );
                                    clearFieldError('nightModeBotMessageEnabled');
                                    if (!enabled) {
                                      clearFieldError('nightModeCommentsEnabled');
                                      clearFieldError('nightModeBotButtonEnabled');
                                      clearFieldError('nightModeRulesButtonEnabled');
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
                              )}
                            >
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">Комментарии</span>
                                  <div className="settings-native-toggle__title-actions">
                                    <SettingsHintAnchor
                                      hintKey="nightComments"
                                      openHintKey={openHintKey}
                                      onToggleHint={toggleHint}
                                      label="Как работают комментарии под ночным сообщением"
                                    >
                                      Добавляет кнопку комментариев под сообщением о закрытии
                                      группы. Работает, если в чате включён блок «Комментарии».
                                    </SettingsHintAnchor>
                                  </div>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Добавить комментарии под сообщением ночного режима"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.nightModeCommentsEnabled}
                                    onChange={(event) =>
                                      setFieldValue(
                                        'nightModeCommentsEnabled',
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
                          ) : null}

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

                              {renderInlineHint(
                                'nightBotButton',
                                'night-bot-button-hint',
                                'Добавляет кнопку в сообщение о закрытии чата на ночь.',
                                hasNightBotButtonError,
                              )}

                              {draft.nightModeBotButtonEnabled ? (
                                <ManagedLinkButtonFieldsSlot
                                  api={api}
                                  urlValue={draft.nightModeBotButtonUrl}
                                  onUrlChange={(nextValue) =>
                                    setFieldValue('nightModeBotButtonUrl', nextValue)
                                  }
                                  textValue={draft.nightModeBotButtonText}
                                  onTextChange={(nextValue) =>
                                    setFieldValue('nightModeBotButtonText', nextValue)
                                  }
                                  urlError={nightBotButtonUrlError}
                                  textError={nightBotButtonTextError}
                                  urlPlaceholder="https://max.ru/channel/..."
                                  textPlaceholder="Правила чата"
                                />
                              ) : null}
                            </div>
                          ) : null}

                          {draft.nightModeBotMessageEnabled ? (
                            <PublishedRulesButtonToggleSlot
                              ariaLabel="Кнопка Правила в ночном режиме"
                              enabled={draft.nightModeRulesButtonEnabled}
                              hasRules={hasPublishedRules}
                              onChange={(enabled) =>
                                setFieldValue('nightModeRulesButtonEnabled', enabled)
                              }
                            />
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
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '315ms', order: 23 }}
              aria-label="Рассылки"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Рассылки"
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
                      <div className="broadcast-studio-shell">
                        {showMailingWorkspaceTabs ? (
                          <SegmentedControl
                            className="broadcast-studio-shell__tabs"
                            value={mailingWorkspaceView}
                            onChange={setMailingWorkspaceView}
                            options={[
                              { value: 'compose', label: 'Сценарий' },
                              {
                                value: 'active',
                                label: 'В работе',
                                count: orderedManagedBroadcasts.length,
                              },
                            ]}
                          />
                        ) : null}

                        {showMailingResetAction ? (
                          <div className="managed-broadcast-editor-note__actions">
                            <button
                              type="button"
                              className="managed-broadcast-editor-note__link"
                              onClick={
                                editingManagedBroadcast
                                  ? handleCancelMailingEdit
                                  : resetMailingComposer
                              }
                              disabled={isMailingBusy}
                            >
                              {editingManagedBroadcast ? 'Сбросить' : 'Очистить'}
                            </button>
                          </div>
                        ) : null}

                        {mailingWorkspaceView === 'compose' ? (
                          <div className="broadcast-compose-flow">
                            <div className="broadcast-stage-card">
                              <div className="broadcast-stage-card__head">
                                <div className="broadcast-stage-card__title-wrap">
                                  <strong>Охват</strong>
                                </div>
                                <span className="broadcast-stage-card__status is-ready">
                                  {mailingTargetLabel}
                                </span>
                              </div>

                              <div className="broadcast-stage-card__body">
                                <div
                                  className={cn(
                                    'mailing-target-card',
                                    !canApplyMailingToAllChats && 'is-single-chat',
                                  )}
                                >
                                  <div className="mailing-target-card__row">
                                    <span className="mailing-target-card__title">
                                      {canApplyMailingToAllChats ? 'Все чаты' : 'Только этот чат'}
                                    </span>

                                    <label
                                      className="settings-native-switch"
                                      aria-label="Применить рассылку во всех чатах"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={mailingApplyToAllChats}
                                        onChange={(event) =>
                                          setMailingApplyToAllChats(event.target.checked)
                                        }
                                        disabled={!canApplyMailingToAllChats || isMailingBusy}
                                      />
                                      <span className="toggle-switch" aria-hidden>
                                        <span className="toggle-switch__thumb" />
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div className="broadcast-stage-card broadcast-stage-card--planner">
                              <div className="broadcast-stage-card__head">
                                <div className="broadcast-stage-card__title-wrap">
                                  <strong>Выберите дни</strong>
                                </div>
                                <span
                                  className={cn(
                                    'broadcast-stage-card__status',
                                    mailingHasFutureSlots ? 'is-ready' : 'is-pending',
                                  )}
                                >
                                  {mailingHasFutureSlots ? mailingSlotsLabel : 'Нет слотов'}
                                </span>
                              </div>

                              <div className="broadcast-stage-card__body">
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
                            </div>

                            <div className="broadcast-stage-card">
                              <div className="broadcast-stage-card__head">
                                <div className="broadcast-stage-card__title-wrap">
                                  <strong>Кнопка</strong>
                                </div>
                                <span
                                  className={cn(
                                    'broadcast-stage-card__status',
                                    mailingButtonEnabled ? 'is-ready' : 'is-muted',
                                  )}
                                >
                                  {mailingButtonEnabled ? 'Есть' : 'Нет'}
                                </span>
                              </div>

                              <div className="broadcast-stage-card__body">
                                <div className="mailing-options-grid">
                                  <div
                                    className={cn(
                                      'mailing-option-card',
                                      mailingButtonEnabled && 'is-enabled',
                                      (mailingButtonUrlError || mailingButtonTextError) &&
                                        'field--error',
                                    )}
                                  >
                                    <div className="mailing-option-card__head">
                                      <span className="mailing-option-card__title">
                                        Добавить кнопку
                                      </span>

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
                                        <ManagedLinkButtonFieldsSlot
                                          api={api}
                                          urlValue={mailingButtonUrl}
                                          onUrlChange={(nextValue) => {
                                            setMailingButtonUrl(nextValue);
                                            if (mailingButtonUrlError) {
                                              setMailingButtonUrlError('');
                                            }
                                          }}
                                          textValue={mailingButtonText}
                                          onTextChange={(nextValue) => {
                                            setMailingButtonText(nextValue);
                                            if (mailingButtonTextError) {
                                              setMailingButtonTextError('');
                                            }
                                          }}
                                          urlError={mailingButtonUrlError}
                                          textError={mailingButtonTextError}
                                          disabled={isMailingBusy}
                                          urlLabel="Ссылка"
                                          textLabel="Текст"
                                          urlPlaceholder="https://max.ru/channel/..."
                                          textPlaceholder="Открыть"
                                        />
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="broadcast-stage-card broadcast-stage-card--active">
                            <div className="broadcast-stage-card__head">
                              <div className="broadcast-stage-card__title-wrap">
                                <strong>В работе</strong>
                              </div>
                              <span className="broadcast-stage-card__status is-ready">
                                {managedBroadcastsQuery.isLoading
                                  ? 'Загрузка...'
                                  : orderedManagedBroadcasts.length > 0
                                    ? `${orderedManagedBroadcasts.length} в работе`
                                    : 'Пусто'}
                              </span>
                            </div>

                            <div className="broadcast-stage-card__body">
                              <div className="managed-broadcasts-list">
                                {orderedManagedBroadcasts.length === 0 &&
                                !managedBroadcastsQuery.isLoading ? (
                                  <div className="managed-broadcasts-list__empty">
                                    Активных рассылок нет.
                                  </div>
                                ) : null}

                                {orderedManagedBroadcasts.map((broadcast) => {
                                  const cardTone = resolveManagedBroadcastCardTone(broadcast);
                                  const cardMetric = resolveManagedBroadcastMetric(
                                    broadcast,
                                    mailingNowMs,
                                  );
                                  const cardFacts = buildManagedBroadcastFactChips(broadcast);
                                  const canEditBroadcastSchedule =
                                    broadcast.scheduleMode === 'calendar';
                                  const isDeletingBroadcast =
                                    cancelManagedBroadcastMutation.isPending &&
                                    cancelManagedBroadcastMutation.variables === broadcast.id;
                                  const isOpeningBroadcastEditor =
                                    openManagedBroadcastEditorMutation.isPending &&
                                    openManagedBroadcastEditorMutation.variables === broadcast.id;
                                  const isRetryingBroadcast =
                                    retryManagedBroadcastMutation.isPending &&
                                    retryManagedBroadcastMutation.variables === broadcast.id;

                                  return (
                                    <div
                                      key={broadcast.id}
                                      className={cn('managed-broadcast-card', `is-${cardTone}`)}
                                    >
                                      <div className="managed-broadcast-card__top">
                                        <span className="managed-broadcast-card__main">
                                          <span
                                            className={cn(
                                              'managed-broadcast-card__badge',
                                              `is-${cardTone}`,
                                            )}
                                          >
                                            {resolveManagedBroadcastCardBadge(broadcast)}
                                          </span>
                                          <strong>
                                            {resolveManagedBroadcastCardTitle(broadcast)}
                                          </strong>
                                          <small>{broadcast.textPreview}</small>
                                        </span>
                                        <span className="managed-broadcast-card__aside">
                                          <span
                                            className={cn(
                                              'managed-broadcast-card__metric',
                                              `is-${cardMetric.tone}`,
                                            )}
                                          >
                                            <small>{cardMetric.label}</small>
                                            <strong>{cardMetric.value}</strong>
                                            <span>{cardMetric.caption}</span>
                                          </span>
                                        </span>
                                      </div>

                                      <div className="managed-broadcast-card__facts">
                                        {cardFacts.map((fact) => (
                                          <span key={`${broadcast.id}-${fact}`}>{fact}</span>
                                        ))}
                                      </div>

                                      <div className="managed-broadcast-card__body">
                                        {broadcast.lastError ? (
                                          <small className="managed-broadcast-card__error">
                                            {broadcast.lastError}
                                          </small>
                                        ) : null}
                                        <p className="managed-broadcast-card__note">
                                          {canEditBroadcastSchedule
                                            ? 'Можно изменить время отправки или удалить рассылку.'
                                            : 'Удаление снимет будущие отправки и уберёт карточку из списка.'}
                                        </p>
                                        <div className="managed-broadcast-card__actions">
                                          {canEditBroadcastSchedule ? (
                                            <button
                                              type="button"
                                              className="button button--ghost"
                                              onClick={() => handleEditManagedBroadcast(broadcast)}
                                              disabled={isMailingBusy}
                                            >
                                              {isOpeningBroadcastEditor
                                                ? 'Открываем...'
                                                : 'Изменить время'}
                                            </button>
                                          ) : null}
                                          {broadcast.canRetry ? (
                                            <button
                                              type="button"
                                              className="button button--accent"
                                              onClick={() =>
                                                retryManagedBroadcastMutation.mutate(broadcast.id)
                                              }
                                              disabled={isMailingBusy}
                                            >
                                              {isRetryingBroadcast
                                                ? 'Повторяем...'
                                                : 'Повторить ошибки'}
                                            </button>
                                          ) : null}
                                          <button
                                            type="button"
                                            className="button button--danger"
                                            onClick={() => handleDeleteManagedBroadcast(broadcast)}
                                            disabled={isMailingBusy}
                                          >
                                            {isDeletingBroadcast ? 'Удаляем...' : 'Удалить'}
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
              style={{ animationDelay: '338ms', order: 3 }}
              aria-label="Комментарии"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Комментарии"
                  icon="comments"
                  tone="mint"
                  open={expandedSections.comments}
                  controls="settings-comments-content"
                  onClick={() => toggleSection('comments')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-comments-content"
                open={expandedSections.comments}
                title="Комментарии"
                summary={commentsCardSummary}
                onClose={() => toggleSection('comments')}
              >
                <div
                  id="settings-comments-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.comments && 'is-open',
                  )}
                >
                  {expandedSections.comments ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Включить комментарии
                            </span>
                            <div className="settings-native-toggle__title-actions">
                              <SettingsHintAnchor
                                hintKey="commentsEnabled"
                                openHintKey={openHintKey}
                                onToggleHint={toggleHint}
                                label="Как работают комментарии в чатах"
                              >
                                В MAX нет нативных комментариев под сообщениями в чатах, поэтому бот
                                сам публикует сообщение с кнопкой комментариев. Для постов админа
                                бот отправляет копию с той же разметкой и удаляет исходное
                                сообщение, а для рассылок кнопка ставится сразу на сообщение бота.
                              </SettingsHintAnchor>
                            </div>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить комментарии в чатах"
                          >
                            <input
                              type="checkbox"
                              checked={draft.commentsEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        commentsEnabled: enabled,
                                        commentsAdminsEnabled:
                                          enabled &&
                                          !current.commentsAdminsEnabled &&
                                          !current.commentsChatBroadcastsEnabled
                                            ? true
                                            : current.commentsAdminsEnabled,
                                        commentsAllEnabled: false,
                                      }
                                    : current,
                                );
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      {draft.commentsEnabled ? (
                        <>
                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Только у админов
                                </span>
                                <div className="settings-native-toggle__title-actions">
                                  <SettingsHintAnchor
                                    hintKey="commentsAdmins"
                                    openHintKey={openHintKey}
                                    onToggleHint={toggleHint}
                                    label="Как работают комментарии для постов админов"
                                  >
                                    Когда пишет админ, бот публикует такое же сообщение от себя с
                                    кнопкой комментариев и удаляет исходное. Это нужно, потому что
                                    MAX не умеет вешать кнопку прямо под сообщением человека в чате.
                                  </SettingsHintAnchor>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Комментарии под постами админов"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.commentsAdminsEnabled}
                                  onChange={(event) =>
                                    setFieldValue('commentsAdminsEnabled', event.target.checked)
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">Для рассылки</span>
                                <div className="settings-native-toggle__title-actions">
                                  <SettingsHintAnchor
                                    hintKey="commentsChatBroadcasts"
                                    openHintKey={openHintKey}
                                    onToggleHint={toggleHint}
                                    label="Как работают комментарии для рассылок"
                                  >
                                    Для рассылки бот публикует сообщение сам и сразу добавляет в
                                    него кнопку комментариев. Сообщения участников чата при этом не
                                    заменяются.
                                  </SettingsHintAnchor>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Комментарии для рассылки в чатах"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.commentsChatBroadcastsEnabled}
                                  onChange={(event) =>
                                    setFieldValue(
                                      'commentsChatBroadcastsEnabled',
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
                        </>
                      ) : null}

                      <p className="settings-drilldown__footer-note">
                        Изменения сохраняются автоматически после переключения. Кнопка ниже нужна,
                        если хотите сохранить сразу.
                      </p>
                      <div className="settings-drilldown__footer-actions">
                        <button
                          type="button"
                          className="button button--accent"
                          onClick={() => void handleSaveComments()}
                          disabled={isSavingComments || !isCommentsDirty()}
                        >
                          {isSavingComments ? 'Сохраняем...' : 'Сохранить сейчас'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
              style={{ animationDelay: '360ms', order: 4 }}
              aria-label="Подписка на канал"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Подписка"
                  icon="subscription"
                  tone="sky"
                  open={expandedSections.requiredSubscription}
                  controls="settings-required-subscription-content"
                  onClick={() => toggleSection('requiredSubscription')}
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-required-subscription-content"
                open={expandedSections.requiredSubscription}
                title="Подписка на канал"
                summary={requiredSubscriptionHeaderSummary}
                onClose={() => toggleSection('requiredSubscription')}
                footer={renderSectionSaveFooter('requiredSubscription', {
                  note: 'Сначала сохраните в этом чате, затем при необходимости примените во все чаты.',
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
                        <div className="managed-giveaway__title-row">
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
                            Можно выбрать свои каналы ниже или добавить чужой канал по публичной
                            ссылке. Чтобы MAX проверял подписку, бот должен быть администратором
                            этого канала.
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
                          {!channelsQuery.isLoading && channelsQuery.isSyncing ? (
                            <span>Синхронизируем список каналов...</span>
                          ) : null}
                          {channelsQuery.error ? (
                            <span>
                              Ошибка загрузки каналов: {formatApiError(channelsQuery.error)}
                            </span>
                          ) : null}
                          {!channelsQuery.isLoading &&
                          !channelsQuery.isSyncing &&
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

                        <div className="managed-giveaway__editor-grid">
                          <label
                            className={cn(
                              'field settings-text-field',
                              requiredSubscriptionExternalChannelError && 'field--error',
                            )}
                          >
                            <span>Чужой канал</span>
                            <input
                              type="text"
                              value={requiredSubscriptionExternalChannelValue}
                              onChange={(event) => {
                                setRequiredSubscriptionExternalChannelValue(event.target.value);
                                if (requiredSubscriptionExternalChannelError) {
                                  setRequiredSubscriptionExternalChannelError('');
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  handleResolveRequiredSubscriptionExternalChannel();
                                }
                              }}
                              placeholder="https://max.ru/..."
                              disabled={isResolvingRequiredSubscriptionChannel}
                            />
                            {requiredSubscriptionExternalChannelError ? (
                              <small className="field__hint">
                                {requiredSubscriptionExternalChannelError}
                              </small>
                            ) : null}
                          </label>
                          <div className="managed-giveaway__section-actions managed-giveaway__section-actions--align-end">
                            <button
                              type="button"
                              className="button button--ghost managed-giveaway__channel-action"
                              disabled={
                                isResolvingRequiredSubscriptionChannel ||
                                requiredSubscriptionSelectedCount >=
                                  REQUIRED_SUBSCRIPTION_MAX_CHANNELS
                              }
                              onClick={handleResolveRequiredSubscriptionExternalChannel}
                            >
                              {isResolvingRequiredSubscriptionChannel
                                ? 'Проверяем канал...'
                                : 'Добавить чужой канал'}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div
                        className="settings-subsection-divider"
                        role="separator"
                        aria-label="Действия бота для обязательной подписки"
                      >
                        <span>Стандартные действия бота</span>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">1. Объяснение</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать объяснение об обязательной подписке"
                                onClick={() => toggleBotMessageEditor('requiredSubscription')}
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

                          <label
                            className="settings-native-switch"
                            aria-label="Включить объяснение для обязательной подписки"
                          >
                            <input
                              type="checkbox"
                              checked={draft.requiredSubscriptionBotMessageEnabled}
                              onChange={(event) => {
                                setFieldValue(
                                  'requiredSubscriptionBotMessageEnabled',
                                  event.target.checked,
                                );
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'requiredSubscriptionBotMessage' ? (
                          <p
                            id="required-subscription-bot-message-hint"
                            className="settings-native-toggle__hint"
                          >
                            Санкции усиливаются по ступеням, если пользователь повторно пишет без
                            подписки в течение 24 часов: сначала объяснение, затем предупреждение,
                            потом мут и далее бан.
                          </p>
                        ) : null}

                        {draft.requiredSubscriptionBotMessageEnabled &&
                        openBotEditorKey === 'requiredSubscription' ? (
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

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">2. Предупреждение</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать предупреждение об обязательной подписке"
                                onClick={() => toggleWarnMessageEditor('requiredSubscriptionWarn')}
                                isOpen={openWarnEditorKey === 'requiredSubscriptionWarn'}
                              />
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'requiredSubscriptionWarnMessage' && 'is-open',
                                )}
                                aria-label="Пояснение для предупреждения об обязательной подписке"
                                aria-controls="required-subscription-warn-message-hint"
                                aria-expanded={openHintKey === 'requiredSubscriptionWarnMessage'}
                                onClick={() => toggleHint('requiredSubscriptionWarnMessage')}
                              >
                                <span aria-hidden>i</span>
                              </button>
                            </div>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить предупреждение за второе сообщение без подписки"
                          >
                            <input
                              type="checkbox"
                              checked={draft.requiredSubscriptionWarnEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('requiredSubscriptionWarnEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('requiredSubscriptionBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'requiredSubscriptionWarnMessage' ? (
                          <p
                            id="required-subscription-warn-message-hint"
                            className="settings-native-toggle__hint"
                          >
                            Текст отправляется при 2-м сообщении без подписки за 24 часа, если
                            ступень включена.
                          </p>
                        ) : null}

                        {openWarnEditorKey === 'requiredSubscriptionWarn' ? (
                          <WarnMessageEditor
                            editorKey="requiredSubscriptionWarn"
                            botSpeechStyle={draft.botSpeechStyle}
                            value={draft.requiredSubscriptionWarnMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'requiredSubscriptionWarnMessageText',
                                nextValue as ChatSettings['requiredSubscriptionWarnMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('requiredSubscriptionWarnMessageText', '')}
                          />
                        ) : null}
                      </div>

                      {renderMuteStageToggle({
                        enabledKey: 'requiredSubscriptionMuteEnabled',
                        durationKey: 'requiredSubscriptionMuteDurationHours',
                        title: '3. Мут',
                        onEnable: () => {
                          setFieldValue('requiredSubscriptionWarnEnabled', true);
                          setFieldValue('requiredSubscriptionBotMessageEnabled', true);
                        },
                      })}

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">4. Бан</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить бан за повторные сообщения без подписки"
                          >
                            <input
                              type="checkbox"
                              checked={draft.requiredSubscriptionBanEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('requiredSubscriptionBanEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('requiredSubscriptionWarnEnabled', true);
                                  setFieldValue('requiredSubscriptionBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '372ms', order: 31 }}
              aria-label="Сервис"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Сервис"
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
                title="Сервис"
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
                        <DeleteDelayStepper
                          title="Через сколько удалять"
                          value={draft.deleteBotMessagesDelayMinutes}
                          fieldError={fieldErrors.deleteBotMessagesDelayMinutes}
                          groupAriaLabel="Задержка удаления сообщений бота"
                          decreaseAriaLabel="Уменьшить задержку удаления сообщений бота"
                          increaseAriaLabel="Увеличить задержку удаления сообщений бота"
                          onAdjust={adjustDeleteBotMessagesDelay}
                        />
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
                            Глобальная база: после 5 чатов за 2 минуты бот предупреждает, после 6
                            добавляет в базу и удаляет из текущего чата.
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

            <GlassCard
              className="settings-speech-style-card settings-home-entry settings-home-entry--speech stagger-in"
              style={{ order: 32 }}
            >
              <div className="settings-speech-style-card__head">
                <div className="settings-speech-style-card__title-copy">
                  <h3 className="settings-speech-style-card__title">Стиль речи</h3>
                </div>
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
