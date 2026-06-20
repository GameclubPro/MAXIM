import {
  DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  MAX_MESSAGE_LENGTH_MAX,
  MAX_MESSAGE_LENGTH_MIN,
  type AllowlistMatchType,
  type ApplySettingsTarget,
  type BotSpeechMediaImage,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type DomainAllowlistEntry,
  formatDeleteBotMessagesDelayLabel,
} from '@maxim/contracts/settings';
import { type BroadcastImage, type SendBroadcastResult } from '@maxim/contracts/broadcast';
import {
  type ManagedEntityAssignedBot,
  type ManagedEntityHeader,
} from '@maxim/contracts/managed-entities';
import {
  BOT_SPEECH_STYLE_OPTIONS,
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  type BotSpeechEditableFieldKey,
  type BotSpeechMediaFieldKey,
  type BotSpeechPersona,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import botSpeechRobotImage from '../../../../../bot.webp';
import botSpeechFriendlyImage from '../../../../../frendly.webp';
import botSpeechIronicImage from '../../../../../joker.webp';
import botSpeechPoliceImage from '../../../../../police.webp';
import type { BroadcastSchedulePlannerSelectionState } from '../../components/broadcast-schedule-planner';
import type { PublishedRulesButtonToggleProps } from '../../components/published-rules-button-toggle';
import { HOME_ENTITY_FAVORITE_ICONS } from '../../components/ui/compact-icons';
import { formatBroadcastButtonsStatus } from '../../lib/broadcast-link-buttons';
import { buildBroadcastAudiencePresentation } from '../../lib/broadcast-audience-presentation';
import { sortAndUniqueBroadcastSlots } from '../../lib/broadcast-schedule';
import type { SendBroadcastPayload } from '../../lib/api/shared-types';
import { cn } from '../../lib/cn';
import { HEALTH_BASE } from '../../lib/public-config';
import type { SettingsWorkspaceState } from '../../lib/settings-workspace-state';
import type { ApplySectionKey } from '../settings-page-state';

export type FieldErrors = Partial<Record<keyof ChatSettings, string>>;
export type { BotSpeechMediaFieldKey, BotSpeechMediaImage };
export type ManagedBroadcastListItem = ChatSettingsScreenResponse['managedBroadcasts'][number];
export type BroadcastCountdownPresentation = {
  label: string;
  value: string;
  caption: string;
};
export type ManagedBroadcastCardTone = 'active' | 'warning' | 'danger' | 'muted';
export type MailingWorkspaceView = SettingsWorkspaceState['broadcastView'];
export type PendingBroadcastPublishReview = {
  broadcastId: string | null;
  payload: SendBroadcastPayload;
};

export function normalizeBroadcastImageList(images: BroadcastImage[]): BroadcastImage[] {
  return images.filter((image) => image.base64.trim()).slice(0, 10);
}

export function resolveBroadcastImagesFromLegacyFields(value: {
  imageEnabled?: boolean;
  imageBase64?: string | null;
  imageMimeType?: string | null;
  imageFileName?: string | null;
  images?: BroadcastImage[] | null;
}): BroadcastImage[] {
  const images = normalizeBroadcastImageList(value.images ?? []);
  const imageBase64 = value.imageBase64?.trim() ?? '';
  if (images.length > 0 || !value.imageEnabled || !imageBase64) {
    return images;
  }

  return [
    {
      base64: imageBase64,
      mimeType: value.imageMimeType?.trim() ?? '',
      fileName: value.imageFileName?.trim() ?? '',
    },
  ];
}

export function areBroadcastImagesReady(images: BroadcastImage[]): boolean {
  return (
    images.length > 0 &&
    images.every((image) => image.base64 && image.mimeType.toLowerCase().startsWith('image/'))
  );
}

export type DeleteDelayStepperProps = {
  title: string;
  value: number;
  fieldError?: string;
  groupAriaLabel: string;
  decreaseAriaLabel: string;
  increaseAriaLabel: string;
  onAdjust: (direction: number) => void;
};
export type ChatSettingsButtonGroup = {
  buttonsKey:
    | 'linkBotButtons'
    | 'greetingBotButtons'
    | 'textFiltersBotButtons'
    | 'thematicFiltersBotButtons'
    | 'duplicateBotButtons'
    | 'messageLimitsBotButtons'
    | 'nightModeBotButtons';
  enabledKey:
    | 'linkBotButtonEnabled'
    | 'greetingBotButtonEnabled'
    | 'textFiltersBotButtonEnabled'
    | 'thematicFiltersBotButtonEnabled'
    | 'duplicateBotButtonEnabled'
    | 'messageLimitsBotButtonEnabled'
    | 'nightModeBotButtonEnabled';
  urlKey:
    | 'linkBotButtonUrl'
    | 'greetingBotButtonUrl'
    | 'textFiltersBotButtonUrl'
    | 'thematicFiltersBotButtonUrl'
    | 'duplicateBotButtonUrl'
    | 'messageLimitsBotButtonUrl'
    | 'nightModeBotButtonUrl';
  textKey:
    | 'linkBotButtonText'
    | 'greetingBotButtonText'
    | 'textFiltersBotButtonText'
    | 'thematicFiltersBotButtonText'
    | 'duplicateBotButtonText'
    | 'messageLimitsBotButtonText'
    | 'nightModeBotButtonText';
};

export type AdminContactButtonGroup = {
  enabledKey:
    | 'linkAdminContactButtonEnabled'
    | 'profanityAdminContactButtonEnabled'
    | 'textFiltersAdminContactButtonEnabled'
    | 'thematicFiltersAdminContactButtonEnabled'
    | 'duplicateAdminContactButtonEnabled'
    | 'messageLimitsAdminContactButtonEnabled'
    | 'phoneNumbersAdminContactButtonEnabled'
    | 'requiredSubscriptionAdminContactButtonEnabled'
    | 'invitationAccessAdminContactButtonEnabled';
  urlKey:
    | 'linkAdminContactButtonUrl'
    | 'profanityAdminContactButtonUrl'
    | 'textFiltersAdminContactButtonUrl'
    | 'thematicFiltersAdminContactButtonUrl'
    | 'duplicateAdminContactButtonUrl'
    | 'messageLimitsAdminContactButtonUrl'
    | 'phoneNumbersAdminContactButtonUrl'
    | 'requiredSubscriptionAdminContactButtonUrl'
    | 'invitationAccessAdminContactButtonUrl';
};

export const LazyMessageLimitsBlockedWordPresets = lazy(
  () => import('../../components/message-limits-blocked-word-presets'),
);
export const LazyPublishedRulesButtonToggle = lazy(
  () => import('../../components/published-rules-button-toggle'),
);
export const LazyBroadcastAudienceControls = lazy(() =>
  import('../../components/broadcast-audience-controls').then((module) => ({
    default: module.BroadcastAudienceControls,
  })),
);
export const LazyBroadcastSchedulePlanner = lazy(() =>
  import('../../components/broadcast-schedule-planner').then((module) => ({
    default: module.BroadcastSchedulePlanner,
  })),
);
const loadBotSpeechMessageEditorSheet = () => import('../../components/bot-speech-message-editor');
export function preloadBotSpeechMessageEditorSheet() {
  void loadBotSpeechMessageEditorSheet();
}
const LazyBotMessageEditorModule = lazy(() =>
  loadBotSpeechMessageEditorSheet().then((module) => ({
    default: module.BotMessageEditor,
  })),
);
const LazyWarnMessageEditorModule = lazy(() =>
  loadBotSpeechMessageEditorSheet().then((module) => ({
    default: module.WarnMessageEditor,
  })),
);
export function LazyBotMessageEditor(props: BotMessageEditorProps) {
  return (
    <Suspense fallback={null}>
      <LazyBotMessageEditorModule {...props} />
    </Suspense>
  );
}
export function LazyWarnMessageEditor(props: WarnMessageEditorProps) {
  return (
    <Suspense fallback={null}>
      <LazyWarnMessageEditorModule {...props} />
    </Suspense>
  );
}
export const LazyBroadcastContentComposer = lazy(
  () => import('../../components/broadcast-content-composer'),
);
export const LazyBroadcastButtonsSheet = lazy(
  () => import('../../components/broadcast-buttons-sheet'),
);
export const LazyBroadcastPublishReviewSheet = lazy(
  () => import('../../components/broadcast-publish-review-sheet'),
);
export const LazySettingsHandoffState = lazy(() => import('../../components/handoff'));
export const LazyManagedPollCard = lazy(() =>
  import('../../components/managed-poll-card').then((module) => ({
    default: module.ManagedPollCard,
  })),
);
export const LazyManagedGiveawayCard = lazy(() =>
  import('../../components/managed-giveaway-card').then((module) => ({
    default: module.ManagedGiveawayCard,
  })),
);

export const AUTO_SAVE_DELAY_MS = 650;
export const AUTO_MUTE_DURATION_MIN_HOURS = 1;
export const AUTO_MUTE_DURATION_MAX_HOURS = 168;
export const AUTO_MUTE_DURATION_PRESET_HOURS = [1, 6, 24, 168] as const;
export const DUPLICATE_ALLOWED_COUNT_MIN = 0;
export const DUPLICATE_ALLOWED_COUNT_MAX = 16;
export const MESSAGE_COUNT_LIMIT_MIN = 1;
export const MESSAGE_COUNT_LIMIT_MAX = 10;
export const MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS = 1;
export const MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS = 24;
export const MESSAGE_LENGTH_MIN = MAX_MESSAGE_LENGTH_MIN;
export const MESSAGE_LENGTH_MAX = MAX_MESSAGE_LENGTH_MAX;
export const MESSAGE_LENGTH_STEP = 10;
export const PHOTO_COOLDOWN_MIN_HOURS = 1;
export const PHOTO_COOLDOWN_MAX_HOURS = 24;
export const STICKER_COOLDOWN_MIN_MINUTES = 1;
export const STICKER_COOLDOWN_MAX_MINUTES = 60;
export const NIGHT_FORCE_CLOSE_MIN_HOURS = 0;
export const NIGHT_FORCE_CLOSE_MAX_HOURS = 23;
export const NIGHT_FORCE_CLOSE_MIN_DAYS = 0;
export const NIGHT_FORCE_CLOSE_MAX_DAYS = 30;
export const COMMERCIAL_SENSITIVITY_MIN = 0;
export const COMMERCIAL_SENSITIVITY_MAX = 100;
export const COMMERCIAL_SOFT_MAX = 24;
export const COMMERCIAL_BALANCED_MAX = 69;
export const BOT_MESSAGES_DELETE_DELAY_OPTIONS = DELETE_BOT_MESSAGES_DELAY_ALLOWED_MINUTES;
export const DOMAIN_REMOVAL_MIN_FUTURE_MS = 30_000;
export const MAX_BROADCAST_TEXT_LENGTH = 2_000;
export const MIN_BROADCAST_CYCLE_HOURS = 1;
export const LINK_BOT_BUTTON_GROUP = {
  buttonsKey: 'linkBotButtons',
  enabledKey: 'linkBotButtonEnabled',
  urlKey: 'linkBotButtonUrl',
  textKey: 'linkBotButtonText',
} as const satisfies ChatSettingsButtonGroup;
export const GREETING_BOT_BUTTON_GROUP = {
  buttonsKey: 'greetingBotButtons',
  enabledKey: 'greetingBotButtonEnabled',
  urlKey: 'greetingBotButtonUrl',
  textKey: 'greetingBotButtonText',
} as const satisfies ChatSettingsButtonGroup;
export const TEXT_FILTERS_BOT_BUTTON_GROUP = {
  buttonsKey: 'textFiltersBotButtons',
  enabledKey: 'textFiltersBotButtonEnabled',
  urlKey: 'textFiltersBotButtonUrl',
  textKey: 'textFiltersBotButtonText',
} as const satisfies ChatSettingsButtonGroup;
export const THEMATIC_FILTERS_BOT_BUTTON_GROUP = {
  buttonsKey: 'thematicFiltersBotButtons',
  enabledKey: 'thematicFiltersBotButtonEnabled',
  urlKey: 'thematicFiltersBotButtonUrl',
  textKey: 'thematicFiltersBotButtonText',
} as const satisfies ChatSettingsButtonGroup;
export const DUPLICATE_BOT_BUTTON_GROUP = {
  buttonsKey: 'duplicateBotButtons',
  enabledKey: 'duplicateBotButtonEnabled',
  urlKey: 'duplicateBotButtonUrl',
  textKey: 'duplicateBotButtonText',
} as const satisfies ChatSettingsButtonGroup;
export const MESSAGE_LIMITS_BOT_BUTTON_GROUP = {
  buttonsKey: 'messageLimitsBotButtons',
  enabledKey: 'messageLimitsBotButtonEnabled',
  urlKey: 'messageLimitsBotButtonUrl',
  textKey: 'messageLimitsBotButtonText',
} as const satisfies ChatSettingsButtonGroup;
export const NIGHT_MODE_BOT_BUTTON_GROUP = {
  buttonsKey: 'nightModeBotButtons',
  enabledKey: 'nightModeBotButtonEnabled',
  urlKey: 'nightModeBotButtonUrl',
  textKey: 'nightModeBotButtonText',
} as const satisfies ChatSettingsButtonGroup;
export const LINK_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'linkAdminContactButtonEnabled',
  urlKey: 'linkAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
export const PROFANITY_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'profanityAdminContactButtonEnabled',
  urlKey: 'profanityAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
export const TEXT_FILTERS_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'textFiltersAdminContactButtonEnabled',
  urlKey: 'textFiltersAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
export const THEMATIC_FILTERS_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'thematicFiltersAdminContactButtonEnabled',
  urlKey: 'thematicFiltersAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
export const DUPLICATE_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'duplicateAdminContactButtonEnabled',
  urlKey: 'duplicateAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
export const MESSAGE_LIMITS_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'messageLimitsAdminContactButtonEnabled',
  urlKey: 'messageLimitsAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
export const PHONE_NUMBERS_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'phoneNumbersAdminContactButtonEnabled',
  urlKey: 'phoneNumbersAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
export const REQUIRED_SUBSCRIPTION_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'requiredSubscriptionAdminContactButtonEnabled',
  urlKey: 'requiredSubscriptionAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
export const INVITATION_ACCESS_ADMIN_CONTACT_BUTTON_GROUP = {
  enabledKey: 'invitationAccessAdminContactButtonEnabled',
  urlKey: 'invitationAccessAdminContactButtonUrl',
} as const satisfies AdminContactButtonGroup;
export const MAX_CHAT_RULES_TEXT_LENGTH = 2_000;
export const MESSAGE_LIMITS_BLOCKED_WORDS_PREVIEW_COUNT = 9;
export const DEFAULT_RULES_POST_BUTTON_TEXT = 'Открыть';
export const ADMIN_CONTACT_BUTTON_TEXT = 'Связь с админом';
export const BROADCAST_HOUR_MS = 60 * 60 * 1_000;
export const DESKTOP_TOGGLE_ROW_BLOCKERS = [
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

export type MaxMessageLengthSliderProps = {
  value: ChatSettings['maxMessageLength'];
  min: number;
  max: number;
  step: number;
  onCommit: (value: ChatSettings['maxMessageLength']) => void;
};

export function MaxMessageLengthSlider({
  value,
  min,
  max,
  step,
  onCommit,
}: MaxMessageLengthSliderProps) {
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

export function DeleteDelayStepper({
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

export function PublishedRulesButtonToggleSlot(props: PublishedRulesButtonToggleProps) {
  return (
    <Suspense fallback={null}>
      <LazyPublishedRulesButtonToggle {...props} />
    </Suspense>
  );
}

export type AutoMuteDurationKey =
  | 'duplicateMuteDurationHours'
  | 'linkMuteDurationHours'
  | 'messageLimitsMuteDurationHours'
  | 'phoneNumbersMuteDurationHours'
  | 'profanityMuteDurationHours'
  | 'requiredSubscriptionMuteDurationHours'
  | 'invitationAccessMuteDurationHours'
  | 'textFiltersMuteDurationHours'
  | 'thematicFiltersMuteDurationHours';
export type AutoMuteEnabledKey =
  | 'duplicateMuteEnabled'
  | 'linkMuteEnabled'
  | 'messageLimitsMuteEnabled'
  | 'phoneNumbersMuteEnabled'
  | 'profanityMuteEnabled'
  | 'requiredSubscriptionMuteEnabled'
  | 'invitationAccessMuteEnabled'
  | 'textFiltersMuteEnabled'
  | 'thematicFiltersMuteEnabled';
export type HintKey =
  | 'antiSpam'
  | 'antiDuplicate'
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
  | 'duplicateDetectionMode'
  | 'duplicateIgnoreLinks'
  | 'duplicateIgnorePhones'
  | 'duplicateNearMatch'
  | 'duplicateModerationStart'
  | 'duplicateBotMessage'
  | 'duplicateBotButton'
  | 'duplicateWarnStage'
  | 'duplicateMuteStage'
  | 'duplicateBanStage'
  | 'maxMessageLength'
  | 'messageCountLimit'
  | 'photoCooldown'
  | 'stickerCooldown'
  | 'messageLimitsBotMessage'
  | 'messageLimitsBotButton'
  | 'stopWordsDomains'
  | 'phoneNumbersBotMessage'
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
  | 'invitationAccessEnabled'
  | 'invitationAccessBotMessage'
  | 'invitationAccessWarnMessage'
  | 'adminBanCommand'
  | 'adminMuteCommand'
  | 'adminPermanentMuteCommand'
  | 'adminRulesCommand'
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
export type BotMessageEditorKey =
  | 'link'
  | 'greeting'
  | 'requiredSubscription'
  | 'invitationAccess'
  | 'textFilters'
  | 'duplicate'
  | 'messageLimits'
  | 'stopWords'
  | 'phoneNumbers'
  | 'night'
  | 'nightOpen';
export type WarnMessageEditorKey =
  | 'linkWarn'
  | 'requiredSubscriptionWarn'
  | 'invitationAccessWarn'
  | 'textFiltersWarn'
  | 'stopWordsWarn';
export type SettingsSectionKey =
  | ApplySectionKey
  | 'rules'
  | 'poll'
  | 'giveaway'
  | 'comments'
  | 'mailing'
  | 'vkParsing';

export const INITIAL_EXPANDED_SECTIONS: Record<SettingsSectionKey, boolean> = {
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
  stopWords: false,
  phones: false,
  night: false,
  requiredSubscription: false,
  invitationAccess: false,
  commands: false,
  comments: false,
  mailing: false,
  vkParsing: false,
  extra: false,
};

export const SECTION_LABELS: Record<ApplySectionKey, string> = {
  links: 'Ссылки',
  greeting: 'Приветствие',
  profanityFilter: 'Мат и оскорбления',
  commercialFilter: 'Коммерческая реклама',
  thematicFilters: 'Кодовые слова',
  duplicates: 'Повторы',
  limits: 'Ограничения',
  stopWords: 'Стоп-слова',
  phones: 'Телефоны',
  night: 'Ночной режим',
  requiredSubscription: 'Подписка на канал',
  invitationAccess: 'Настройки',
  commands: 'Команды',
  extra: 'Сервис',
};
export const APPLY_TARGET_FAVORITE_ICONS = HOME_ENTITY_FAVORITE_ICONS;

export function createDefaultApplySettingsTarget(): ApplySettingsTarget {
  return {
    mode: 'all',
    favoriteTypes: [],
    chatIds: [],
  };
}

export function resolveDuplicateSharedWindowSec(
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

export function resolveDuplicateFirstThreshold(
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

export function resolveDuplicateAllowedCount(
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

export function buildDuplicateFlowSettings(
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

export function normalizeDuplicateFlowSettings(settings: ChatSettings): ChatSettings {
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

export function formatDuplicateAllowanceLabel(count: number): string {
  if (count === 0) {
    return 'с первого дубля';
  }

  if (count === 1) {
    return 'после 1 дубля';
  }

  return `после ${count} дублей`;
}

export const LINK_POLICY_OPTIONS: Array<{
  value: ChatSettings['linkPolicy'];
  eyebrow: string;
  label: string;
  description: string;
}> = [
  {
    value: 'ALERT_ONLY',
    eyebrow: 'Наблюдение',
    label: 'Не удалять',
    description: 'Ссылки остаются в чате, а блок санкций скрыт.',
  },
  {
    value: 'BLOCKLIST_ONLY',
    eyebrow: 'Жёсткий режим',
    label: 'Удалять',
    description: 'Любая ссылка удаляется сразу.',
  },
  {
    value: 'ALLOWLIST_ONLY',
    eyebrow: 'Разрешённые',
    label: 'Белый список',
    description: 'Удаляются все ссылки, кроме списка ниже.',
  },
];

export const RUSSIAN_TIMEZONE_OPTIONS = [
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

export const BOT_SPEECH_SYNC_SETTING_KEYS = [
  'botSpeechStyle',
  'botSpeechMedia',
  'greetingBotMessageText',
  'linkBotMessageText',
  'linkWarnMessageText',
  'requiredSubscriptionBotMessageText',
  'requiredSubscriptionWarnMessageText',
  'invitationAccessBotMessageText',
  'invitationAccessWarnMessageText',
  'textFiltersBotMessageText',
  'textFiltersWarnMessageText',
  'duplicateBotMessageText',
  'messageLimitsBotMessageText',
  'messageLimitsWarnMessageText',
  'phoneNumbersBotMessageText',
  'nightModeBotMessageText',
  'nightModeOpenMessageText',
] as const satisfies ReadonlyArray<keyof ChatSettings>;

export const BOT_SPEECH_STYLE_ICON_ASSETS = {
  robot: botSpeechRobotImage,
  friendly: botSpeechFriendlyImage,
  police: botSpeechPoliceImage,
  ironic: botSpeechIronicImage,
} as const;

export const BOT_SPEECH_STYLE_SELECTOR_LABELS: Record<BotSpeechStyle, string> = {
  ROBOT: 'Робот',
  FRIENDLY: 'Друг',
  POLICE: 'Коп',
  IRONIC: 'Шут',
};

export type BotSpeechPreviewContext = {
  persona: BotSpeechPersona;
  characterName: string;
};

export type HeaderBotLoadSnapshot = {
  queueLagSec: number;
  queuedEvents: number;
  failedEvents: number;
  actionErrorRate: number;
  maxApiLoad: number | null;
};

export const DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT: BotSpeechPreviewContext = {
  persona: 'neutral',
  characterName: 'Чат-бот',
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveHeaderAssignedBots(
  header: Pick<ManagedEntityHeader, 'primaryBotId' | 'assignedBots'> | null | undefined,
): ManagedEntityAssignedBot[] {
  if (!header?.assignedBots?.length) {
    return [];
  }

  return [...header.assignedBots].sort((left, right) => {
    const leftPrimary = left.botId === header.primaryBotId ? 1 : 0;
    const rightPrimary = right.botId === header.primaryBotId ? 1 : 0;
    if (leftPrimary !== rightPrimary) {
      return rightPrimary - leftPrimary;
    }

    if (left.role !== right.role) {
      return left.role === 'primary' ? -1 : 1;
    }

    return left.label.localeCompare(right.label, 'ru-RU');
  });
}

export function parseHeaderBotLoadSnapshots(value: unknown): Record<string, HeaderBotLoadSnapshot> {
  if (!isRecord(value) || !isRecord(value.bots)) {
    throw new Error('Invalid bot load snapshot');
  }

  return Object.fromEntries(
    Object.entries(value.bots)
      .map(([botId, snapshot]) => {
        if (!isRecord(snapshot)) {
          return null;
        }
        if (
          snapshot.load !== null &&
          snapshot.load !== undefined &&
          typeof snapshot.load !== 'number'
        ) {
          return null;
        }

        return [
          botId,
          {
            queueLagSec: 0,
            queuedEvents: 0,
            failedEvents: 0,
            actionErrorRate: 0,
            maxApiLoad:
              typeof snapshot.load === 'number' && Number.isFinite(snapshot.load)
                ? snapshot.load
                : null,
          },
        ] satisfies [string, HeaderBotLoadSnapshot];
      })
      .filter((entry): entry is [string, HeaderBotLoadSnapshot] => entry !== null),
  );
}

export async function getHeaderBotLoadSnapshots(
  botIds: readonly string[],
): Promise<Record<string, HeaderBotLoadSnapshot>> {
  const params = new URLSearchParams();
  if (botIds.length > 0) {
    params.set('bots', botIds.join(','));
  }

  const response = await fetch(`${HEALTH_BASE}/health/bot-load?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Bot load request failed: ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  return parseHeaderBotLoadSnapshots(payload);
}

export function resolveHeaderBotLoadLevel(snapshot: HeaderBotLoadSnapshot | undefined): {
  value: number;
  tone: 'cool' | 'warm' | 'hot';
} {
  if (!snapshot) {
    return {
      value: 0.18,
      tone: 'cool',
    };
  }

  if (typeof snapshot.maxApiLoad === 'number') {
    const value = Math.max(0.14, Math.min(1, snapshot.maxApiLoad));
    if (value >= 0.85) {
      return { value, tone: 'hot' };
    }
    if (value >= 0.55) {
      return { value, tone: 'warm' };
    }
    return { value, tone: 'cool' };
  }

  const lagScore = Math.min(1, snapshot.queueLagSec / 10);
  const queueScore = Math.min(1, snapshot.queuedEvents / 6);
  const failedScore = Math.min(1, snapshot.failedEvents / 2);
  const errorScore = Math.min(1, snapshot.actionErrorRate / 0.2);
  const value = Math.max(
    0.14,
    Math.min(1, lagScore * 0.58 + queueScore * 0.22 + failedScore * 0.1 + errorScore * 0.1),
  );

  if (value >= 0.72) {
    return { value, tone: 'hot' };
  }

  if (value >= 0.4) {
    return { value, tone: 'warm' };
  }

  return { value, tone: 'cool' };
}

export function resolveBotSpeechPreviewContext(
  _header: Pick<ManagedEntityHeader, 'primaryBotId' | 'assignedBots'> | null | undefined,
): BotSpeechPreviewContext {
  return DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT;
}

export function getSpeechTemplateFallback(
  style: ChatSettings['botSpeechStyle'],
  fieldKey: BotSpeechEditableFieldKey,
  previewContext: BotSpeechPreviewContext = DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT,
): string {
  return getBotSpeechEditableTemplate(style, fieldKey, previewContext.persona);
}

export function getSpeechSystemTemplateFallback(
  style: ChatSettings['botSpeechStyle'],
  templateKey: Parameters<typeof getBotSpeechSystemTemplate>[1],
  previewContext: BotSpeechPreviewContext = DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT,
): string {
  return getBotSpeechSystemTemplate(style, templateKey, previewContext.persona);
}

export function resolveBotMessageTemplate(customValue: string, fallbackTemplate: string): string {
  return customValue.trim().length > 0 ? customValue : fallbackTemplate;
}

export function renderBotMessageTemplatePreview(
  templateText: string,
  replacements: Record<string, string>,
  previewContext: BotSpeechPreviewContext = DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT,
): string {
  let rendered = templateText;
  const mergedReplacements: Record<string, string> = {
    bot_character_name: previewContext.characterName,
    ...replacements,
  };
  for (const [key, value] of Object.entries(mergedReplacements)) {
    rendered = rendered.split(`{${key}}`).join(value);
  }

  return rendered.trim();
}

export function mergeBotSpeechStyleSettings(
  target: ChatSettings,
  source: ChatSettings,
): ChatSettings {
  const nextSettings: ChatSettings = {
    ...target,
  };

  for (const key of BOT_SPEECH_SYNC_SETTING_KEYS) {
    nextSettings[key] = source[key] as never;
  }

  return nextSettings;
}

export function buildSpeechStylePreviewSamples(
  style: BotSpeechStyle,
  previewContext: BotSpeechPreviewContext = DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT,
): {
  greeting: string;
  explanation: string;
  warning: string;
  mute: string;
  ban: string;
} {
  return {
    greeting: renderBotMessageTemplatePreview(
      getSpeechTemplateFallback(style, 'greetingBotMessageText', previewContext),
      {
        user: 'Алексей',
        greeting: 'добро пожаловать в чат',
      },
      previewContext,
    ),
    explanation: renderBotMessageTemplatePreview(
      getSpeechTemplateFallback(style, 'linkBotMessageText', previewContext),
      {
        user: 'Алексей',
        message_status: 'снято с линии',
        reason: 'в этом чате ссылки не проходят, без ссылок',
      },
      previewContext,
    ),
    warning: renderBotMessageTemplatePreview(
      getSpeechTemplateFallback(style, 'textFiltersWarnMessageText', previewContext),
      {
        user: 'Алексей',
        warning: 'вынесено предупреждение за грубую лексику',
        reason: 'грубая лексика запрещена правилами чата',
      },
      previewContext,
    ),
    mute: renderBotMessageTemplatePreview(
      getSpeechSystemTemplateFallback(style, 'muteNotice', previewContext),
      {
        user: 'Алексей',
        mute_duration: '24 часа',
        ban_duration: '24 часа',
      },
      previewContext,
    ),
    ban: renderBotMessageTemplatePreview(
      getSpeechSystemTemplateFallback(style, 'topicBan', previewContext),
      {
        user: 'Алексей',
        reason: 'повторные нарушения правил чата',
      },
      previewContext,
    ),
  };
}

export function formatApiError(error: unknown): string {
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

export function normalizeDayMinutes(value: number, fallback = 0): number {
  if (!Number.isInteger(value) || value < 0 || value > 1_439) {
    return fallback;
  }

  return value;
}

export function minutesToTimeInput(value: number): string {
  const safe = normalizeDayMinutes(value);
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function timeInputToMinutes(value: string, fallback: number): number {
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

export function toLocalDateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toLocalTimeInputValue(value: Date): string {
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function parseIsoToLocalDateTime(value: string | null): { date: string; time: string } {
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

export function formatDateTimeInTimeZone(
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

export function formatRemovalDateTime(value: string | null, timeZone?: string | null): string {
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

export function formatMiniappBroadcastResultDescription(result: SendBroadcastResult): string {
  const sentTargetLabel =
    result.sentChatPreviews.length > 0
      ? `${result.sentChatPreviews[0]?.title}${result.sentChatOverflowCount > 0 ? ` +${result.sentChatOverflowCount}` : ''}`
      : '';
  const failedTargetLabel =
    result.failedChatPreviews.length > 0
      ? `${result.failedChatPreviews[0]?.title}${result.failedChatOverflowCount > 0 ? ` +${result.failedChatOverflowCount}` : ''}`
      : '';
  if (result.sentChats === 0 && result.nextSendAt) {
    return `Первый слот: ${formatRemovalDateTime(result.nextSendAt, result.scheduleTimezone)}.`;
  }

  if (result.failedChats > 0) {
    if (failedTargetLabel) {
      return `Ошибки: ${failedTargetLabel}. Отправлено: ${result.sentChats}/${result.targetChats}.`;
    }
    return `Отправлено: ${result.sentChats}/${result.targetChats}, ошибок: ${result.failedChats}.`;
  }

  if (result.nextSendAt && result.scheduledOccurrences > 0) {
    return `Следующий слот: ${formatRemovalDateTime(result.nextSendAt, result.scheduleTimezone)}.`;
  }

  return sentTargetLabel
    ? `Отправлено: ${sentTargetLabel}.`
    : `Отправлено: ${result.sentChats}/${result.targetChats}.`;
}

export function formatAllowlistModeLabel(matchType: AllowlistMatchType): string {
  return matchType === 'DOMAIN' ? 'Весь домен' : 'Точная ссылка';
}

export function formatAllowlistMetaLabel(
  entry: DomainAllowlistEntry,
  scheduledAtLabel: string,
): string {
  const targetLabel =
    entry.matchType === 'DOMAIN'
      ? 'Домен не удаляется без таймера.'
      : 'Ссылка не удаляется без таймера.';

  if (!scheduledAtLabel) {
    return targetLabel;
  }

  return `Удаление: ${scheduledAtLabel}`;
}

export const ALLOWLIST_MATCH_OPTIONS: Array<{ value: AllowlistMatchType; label: string }> = [
  { value: 'DOMAIN', label: 'Весь домен' },
  { value: 'EXACT', label: 'Точная ссылка' },
];

export function formatCompactBroadcastDateTime(
  value: string | null,
  timeZone?: string | null,
): string {
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

export function formatRussianCountLabel(
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

export function formatBroadcastPayloadScheduleLabel(payload: SendBroadcastPayload): string {
  if (payload.scheduleMode === 'calendar') {
    const slots = sortAndUniqueBroadcastSlots(payload.scheduledSlots);
    if (slots.length === 1) {
      return formatCompactBroadcastDateTime(slots[0], payload.scheduleTimezone);
    }

    return formatRussianCountLabel(slots.length, 'слот', 'слота', 'слотов');
  }

  if (payload.sendAt) {
    return formatCompactBroadcastDateTime(payload.sendAt, payload.scheduleTimezone);
  }

  return 'Сразу';
}

export function formatBroadcastCountdownValue(remainingMs: number): string {
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

export function resolveBroadcastCountdown(
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

export function resolveManagedBroadcastCardTone(
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

export function resolveManagedBroadcastCardBadge(broadcast: ManagedBroadcastListItem): string {
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

export function resolveManagedBroadcastCardTitle(broadcast: ManagedBroadcastListItem): string {
  if (broadcast.status === 'PARTIAL') {
    return 'Есть ошибки доставки';
  }
  if (broadcast.status === 'FAILED') {
    return 'Нужно повторить отправку';
  }
  if (broadcast.status === 'COMPLETED') {
    return 'Автопостинг завершён';
  }
  if (broadcast.status === 'CANCELED') {
    return 'Автопостинг остановлен';
  }
  return broadcast.nextSendAt ? 'Следующая отправка' : 'Активный автопостинг';
}

export function resolveManagedBroadcastScopeLabel(broadcast: ManagedBroadcastListItem): string {
  return buildBroadcastAudiencePresentation({
    targetMode: broadcast.targetMode,
    targetChatIds: broadcast.targetChatIds,
    targetPreviews: broadcast.targetPreviews,
    targetOverflowCount: broadcast.targetOverflowCount,
    targetChats: broadcast.targetChats,
    currentLabel: 'Текущий чат',
  }).label;
}

export function resolveManagedBroadcastMetric(
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
    caption: resolveManagedBroadcastScopeLabel(broadcast),
    tone: broadcast.status === 'COMPLETED' ? 'muted' : 'active',
  };
}

export function buildManagedBroadcastFactChips(broadcast: ManagedBroadcastListItem): string[] {
  const scopeLabel = resolveManagedBroadcastScopeLabel(broadcast);
  const scheduleLabel =
    broadcast.scheduleMode === 'calendar'
      ? formatRussianCountLabel(broadcast.scheduledSlots.length, 'слот', 'слота', 'слотов')
      : broadcast.cycleEnabled
        ? `Цикл ${broadcast.sentCount}/${broadcast.cycleCount}`
        : '1 отправка';
  const extras = [
    broadcast.buttonEnabled ? formatBroadcastButtonsStatus(broadcast.buttons) : null,
    broadcast.hasImage
      ? broadcast.imageCount > 1
        ? `${broadcast.imageCount} фото`
        : 'Фото'
      : null,
    broadcast.hasVideo ? 'Видео' : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(' · ');

  return [
    scopeLabel,
    scheduleLabel,
    extras || null,
    broadcast.pendingChats > 0 ? `В очереди ${broadcast.pendingChats}` : null,
  ].filter((item): item is string => Boolean(item));
}

export function formatNightForceCloseDuration(days: number, hours: number): string {
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}д`);
  }
  if (hours > 0 || parts.length === 0) {
    parts.push(`${hours}ч`);
  }
  return parts.join(' ');
}

export function clampCommercialSlider(value: number): number {
  return Math.max(COMMERCIAL_SENSITIVITY_MIN, Math.min(COMMERCIAL_SENSITIVITY_MAX, value));
}

export function resolveCommercialSensitivityConfig(value: number): {
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

export function getCommercialSensitivityLabel(value: number): string {
  const safe = clampCommercialSlider(value);
  if (safe < 25) {
    return 'Мягко';
  }
  if (safe < 70) {
    return 'Баланс';
  }
  return 'Строго';
}

export function inferCommercialSensitivitySliderValue(settings: ChatSettings): number {
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

export function normalizeLegacyChatCommentScope(settings: ChatSettings): ChatSettings {
  if (!settings.commentsAllEnabled) {
    return settings;
  }

  return {
    ...settings,
    commentsAllEnabled: false,
  };
}

export function formatRequiredSubscriptionCount(count: number): string {
  const safeCount = Math.max(0, Math.trunc(count));
  const mod10 = safeCount % 10;
  const mod100 = safeCount % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${safeCount} чат или канал`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${safeCount} чата/канала`;
  }
  return `${safeCount} чатов/каналов`;
}

export function clampInvitationAccessRequiredCount(count: number): number {
  return Math.min(
    INVITATION_ACCESS_REQUIRED_COUNT_MAX,
    Math.max(INVITATION_ACCESS_REQUIRED_COUNT_MIN, Math.round(count)),
  );
}

export function formatInvitationAccessCount(count: number): string {
  const safeCount = Math.max(0, Math.trunc(count));
  if (safeCount === 1) {
    return '1 друг';
  }
  if (safeCount >= 2 && safeCount <= 4) {
    return `${safeCount} друга`;
  }

  return `${safeCount} друзей`;
}

export function formatRequiredSubscriptionEntityLabel(entityType: 'chat' | 'channel'): string {
  return entityType === 'chat' ? 'Чат' : 'Канал';
}

export function formatRequiredSubscriptionLinkPreview(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./, '');
    const pathSegments = url.pathname.split('/').filter(Boolean);
    if (pathSegments.length === 0) {
      return host;
    }

    const tail = decodeURIComponent(pathSegments[pathSegments.length - 1] ?? '');
    return tail ? `${host}/${tail}` : host;
  } catch {
    return normalized.length > 28 ? `${normalized.slice(0, 25)}...` : normalized;
  }
}

export function getRouteChatTitle(state: unknown): string {
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

export function getRouteChatAvatarUrl(state: unknown): string | null {
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

export function resolveDesktopToggleRowLabel(target: EventTarget | null): HTMLLabelElement | null {
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

export function EditIcon() {
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

export function CalendarIcon() {
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

export function ClockIcon() {
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

export function TrashIcon() {
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

export function BotSpeechStyleIcon({
  iconKey,
}: {
  iconKey: (typeof BOT_SPEECH_STYLE_OPTIONS)[number]['iconKey'];
}) {
  return <img src={BOT_SPEECH_STYLE_ICON_ASSETS[iconKey]} alt="" loading="lazy" />;
}

export function StyleSelectedIcon() {
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

export type EditToggleButtonProps = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  isOpen?: boolean;
};

export function EditToggleButton({ label, onClick, disabled, isOpen }: EditToggleButtonProps) {
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

export function SettingsHintAnchor({
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

export type BotSpeechMessageEditorProps = {
  settings: Pick<ChatSettings, 'botSpeechStyle' | 'botSpeechMedia'>;
  botSpeechPreviewContext: BotSpeechPreviewContext;
  value: string;
  onChange: (value: string) => void;
  onImageChange?: (fieldKey: BotSpeechMediaFieldKey, image: BotSpeechMediaImage | null) => void;
  onReset: () => void;
  onClose: () => void;
};

export type BotMessageEditorProps = BotSpeechMessageEditorProps & {
  editorKey: BotMessageEditorKey;
};

export type WarnMessageEditorProps = BotSpeechMessageEditorProps & {
  editorKey: WarnMessageEditorKey;
};

export const EMPTY_BROADCAST_PLANNER_STATE: BroadcastSchedulePlannerSelectionState = {
  pickedDayCount: 0,
  selectedDayCount: 0,
  slotCount: 0,
  futureSlotCount: 0,
  isDaySheetOpen: false,
  isConfirmed: false,
};

export function areBroadcastPlannerStatesEqual(
  left: BroadcastSchedulePlannerSelectionState,
  right: BroadcastSchedulePlannerSelectionState,
): boolean {
  return (
    left.pickedDayCount === right.pickedDayCount &&
    left.selectedDayCount === right.selectedDayCount &&
    left.slotCount === right.slotCount &&
    left.futureSlotCount === right.futureSlotCount &&
    left.isDaySheetOpen === right.isDaySheetOpen &&
    left.isConfirmed === right.isConfirmed
  );
}
