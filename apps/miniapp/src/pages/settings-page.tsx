import {
  chatRulesSchema,
  chatSettingsSchema,
  normalizeAllowlistLink,
  type ChatRules,
  type ChatSettings,
  type DomainAllowlistEntry,
  type GlobalUserBlacklistEntry,
  type ManagedBroadcastDetails,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { MaxMarkdownEditor } from '../components/max-markdown-editor';
import { ManagedPollCard } from '../components/managed-poll-card';
import { GlassCard } from '../components/ui/glass-card';
import { BackChevronIcon, ParticipantsIcon } from '../components/ui/entity-header-icons';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { prepareBroadcastImage } from '../lib/broadcast-image';
import { cn } from '../lib/cn';
import type { ApiClient, SendBroadcastPayload, UpdateChatRulesPayload } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';

type FieldErrors = Partial<Record<keyof ChatSettings, string>>;

const AUTO_SAVE_DELAY_MS = 650;
const BAN_DURATION_MIN_HOURS = 1;
const BAN_DURATION_MAX_HOURS = 36;
const DUPLICATE_COUNT_MIN = 2;
const DUPLICATE_COUNT_MAX = 20;
const MESSAGE_LENGTH_MIN = 50;
const MESSAGE_LENGTH_MAX = 1500;
const PHOTO_COOLDOWN_MIN_HOURS = 1;
const PHOTO_COOLDOWN_MAX_HOURS = 24;
const STICKER_COOLDOWN_MIN_MINUTES = 1;
const STICKER_COOLDOWN_MAX_MINUTES = 60;
const COMMERCIAL_SENSITIVITY_MIN = 0;
const COMMERCIAL_SENSITIVITY_MAX = 100;
const COMMERCIAL_BALANCED_MAX = 69;
const BOT_MESSAGES_DELETE_DELAY_MIN = 1;
const BOT_MESSAGES_DELETE_DELAY_MAX = 60;
const DOMAIN_REMOVAL_MIN_FUTURE_MS = 30_000;
const MAX_BROADCAST_TEXT_LENGTH = 1_000;
const MAX_BROADCAST_SCHEDULE_DAYS = 14;
const MIN_BROADCAST_CYCLE_HOURS = 1;
const MAX_BROADCAST_CYCLE_HOURS = 24;
const MAX_BROADCAST_CYCLE_COUNT = 100;
const MAX_RULES_IMAGE_SIZE_BYTES = 1_000_000;
const MAX_CHAT_RULES_TEXT_LENGTH = 2_000;
const BROADCAST_HOUR_MS = 60 * 60 * 1_000;
const BROADCAST_DAY_MS = 24 * 60 * 60 * 1_000;

function formatParticipantsCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Intl.NumberFormat('ru-RU').format(value);
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
  | 'globalCrossChatSpam'
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
  | 'photoCooldown'
  | 'stickerCooldown'
  | 'messageLimitsBotMessage'
  | 'messageLimitsBotButton'
  | 'nightModeEnabled'
  | 'nightBotMessage'
  | 'nightBotButton'
  | 'deleteBotMessages'
  | 'removeBotsFromGroup'
  | 'globalBlacklist'
  | 'mailingText'
  | 'mailingTargets'
  | 'mailingImage'
  | 'mailingButton'
  | 'mailingSchedule'
  | 'mailingCycle';
type BotMessageEditorKey =
  | 'link'
  | 'greeting'
  | 'textFilters'
  | 'duplicate'
  | 'messageLimits'
  | 'night';
type WarnMessageEditorKey = 'linkWarn' | 'textFiltersWarn';
type SettingsSectionKey =
  | 'links'
  | 'rules'
  | 'poll'
  | 'greeting'
  | 'profanityFilter'
  | 'commercialFilter'
  | 'thematicFilters'
  | 'duplicates'
  | 'limits'
  | 'night'
  | 'mailing'
  | 'extra';
type ApplySectionKey = Exclude<SettingsSectionKey, 'mailing' | 'rules' | 'poll'>;

const SECTION_LABELS: Record<ApplySectionKey, string> = {
  links: 'Модерация ссылок',
  greeting: 'Приветствие',
  profanityFilter: 'Фильтр нецензурной лексики',
  commercialFilter: 'Фильтр коммерции',
  thematicFilters: 'Тематические фильтры',
  duplicates: 'Дубли сообщений',
  limits: 'Ограничения сообщений',
  night: 'Закрытие чата на ночь',
  extra: 'Дополнительно',
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
    'nightModeBotButtonEnabled',
    'nightModeBotButtonUrl',
    'nightModeBotButtonText',
  ],
  extra: [
    'globalCrossChatSpamEnabled',
    'deleteBotMessagesEnabled',
    'deleteBotMessagesDelayMinutes',
    'removeBotsFromGroupEnabled',
    'globalUserBlacklistEnabled',
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

const DEFAULT_BOT_MESSAGE_TEMPLATES: Record<BotMessageEditorKey, string> = {
  link: 'Сообщение пользователя {user} {message_status}: {reason}',
  greeting: 'Приветствуем {user} в чате!',
  textFilters: 'Сообщение пользователя {user} {message_status}: {reason}',
  duplicate: 'Сообщение пользователя {user} {duplicate_context}. {sanction}',
  messageLimits: 'Сообщение пользователя {user} {message_status}: {reason}',
  night: 'Чат сейчас закрыт на ночь ({night_window}, {night_timezone}). {night_status}',
};

const DEFAULT_WARN_MESSAGE_TEMPLATES: Record<WarnMessageEditorKey, string> = {
  linkWarn: 'Пользователю {user} {warning}. {reason}.',
  textFiltersWarn: 'Пользователю {user} {warning}.',
};

const BOT_MESSAGE_TEMPLATE_HINTS: Record<BotMessageEditorKey, string> = {
  link: 'Плейсхолдеры: {user}, {message_status}, {reason}.',
  greeting: 'Плейсхолдеры: {user}, {greeting}.',
  textFilters: 'Плейсхолдеры: {user}, {message_status}, {reason}.',
  duplicate: 'Плейсхолдеры: {user}, {duplicate_context}, {sanction}, {ban_duration}.',
  messageLimits:
    'Плейсхолдеры: {user}, {message_status}, {reason}, {actual_length}, {max_length}, {photo_cooldown_hours}.',
  night: 'Плейсхолдеры: {user}, {night_window}, {night_timezone}, {night_status}.',
};

const WARN_MESSAGE_TEMPLATE_HINTS: Record<WarnMessageEditorKey, string> = {
  linkWarn: 'Плейсхолдеры: {user}, {warning}, {reason}.',
  textFiltersWarn: 'Плейсхолдеры: {user}, {warning}, {reason}.',
};

const AUTO_RULES_FALLBACK_TEXT =
  'Пожалуйста, уважайте участников чата и соблюдайте порядок в обсуждении.';

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
    lines.push('Не отправляйте одно и то же сообщение повторно.');
  }

  if (settings.maxMessageLengthEnabled) {
    lines.push(`Сообщения должны быть не длиннее ${settings.maxMessageLength} символов.`);
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

function resolveBotMessageTemplate(customValue: string, fallbackTemplate: string): string {
  return customValue.trim().length > 0 ? customValue : fallbackTemplate;
}

function formatApiError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : '';
  const normalized = rawMessage.toLowerCase();

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
    normalized.includes('networkerror') ||
    normalized.includes('network error')
  ) {
    return 'Нет соединения с сервером.';
  }

  return rawMessage.trim() ? 'Не удалось выполнить запрос.' : 'Неизвестная ошибка.';
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
  value: string;
  onChange: (value: string) => void;
  onReset: () => void;
};

function BotMessageEditor({ editorKey, value, onChange, onReset }: BotMessageEditorProps) {
  const defaultTemplate = DEFAULT_BOT_MESSAGE_TEMPLATES[editorKey];
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
  value: string;
  onChange: (value: string) => void;
  onReset: () => void;
};

function WarnMessageEditor({ editorKey, value, onChange, onReset }: WarnMessageEditorProps) {
  const defaultTemplate = DEFAULT_WARN_MESSAGE_TEMPLATES[editorKey];
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

export function SettingsPage({ api }: { api: ApiClient }) {
  const { chatId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
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
  const [editingManagedBroadcast, setEditingManagedBroadcast] =
    useState<ManagedBroadcastDetails | null>(null);
  const [expandedManagedBroadcastId, setExpandedManagedBroadcastId] = useState<string | null>(null);
  const [blacklistInput, setBlacklistInput] = useState('');
  const [blacklistInputError, setBlacklistInputError] = useState('');
  const [duplicateWindowInputValues, setDuplicateWindowInputValues] = useState<
    Partial<Record<DuplicateWindowKey, string>>
  >({});
  const [failedSnapshot, setFailedSnapshot] = useState<string>('');
  const [rulesFailedSnapshot, setRulesFailedSnapshot] = useState('');
  const [openSectionApplyConfirm, setOpenSectionApplyConfirm] = useState<ApplySectionKey | null>(
    null,
  );
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const [openBotEditorKey, setOpenBotEditorKey] = useState<BotMessageEditorKey | null>(null);
  const [openWarnEditorKey, setOpenWarnEditorKey] = useState<WarnMessageEditorKey | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<SettingsSectionKey, boolean>>({
    links: false,
    rules: false,
    poll: false,
    greeting: false,
    profanityFilter: false,
    commercialFilter: false,
    thematicFilters: false,
    duplicates: false,
    limits: false,
    night: false,
    mailing: false,
    extra: false,
  });

  const routeChatTitle = getRouteChatTitle(location.state);

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('chat', chatId);
    }
  }, [chatId]);

  useEffect(() => {
    setOpenSectionApplyConfirm(null);
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
    setEditingManagedBroadcast(null);
    setExpandedManagedBroadcastId(null);
    setDuplicateWindowInputValues({});
  }, [chatId]);

  const settingsQuery = useQuery({
    queryKey: ['settings', chatId],
    queryFn: () => api.getSettings(chatId ?? ''),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });

  const rulesQuery = useQuery({
    queryKey: ['rules', chatId],
    queryFn: () => api.getRules(chatId ?? ''),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });

  const chatsQuery = useQuery({
    queryKey: ['chats'],
    queryFn: () => api.getChats(),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const managedBroadcastsQuery = useQuery({
    queryKey: ['managed-broadcasts', chatId],
    queryFn: () => api.getManagedBroadcasts(chatId ?? ''),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });

  const chatHeaderQuery = useQuery({
    queryKey: ['chat-header', chatId],
    queryFn: () => api.getChatHeader(chatId ?? ''),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const domainsQuery = useQuery({
    queryKey: ['domains', chatId],
    queryFn: () => api.getDomainAllowlistDetails(chatId ?? ''),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });

  const globalBlacklistQuery = useQuery({
    queryKey: ['global-user-blacklist', chatId],
    queryFn: () => api.getGlobalUserBlacklist(chatId ?? ''),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });

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

  const autoRulesText = useMemo(() => {
    const sourceSettings = draft ?? settingsQuery.data;
    return sourceSettings ? buildAutoRulesText(sourceSettings) : '';
  }, [draft, settingsQuery.data]);

  useEffect(() => {
    if (!rulesQuery.data) {
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
  }, [rulesQuery.data]);

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
    () =>
      rulesDraft
        ? JSON.stringify({
            text: rulesDraft.text,
            imageBase64: rulesDraft.imageBase64,
            imageMimeType: rulesDraft.imageMimeType,
            imageFileName: rulesDraft.imageFileName,
          })
        : '',
    [rulesDraft],
  );

  const serverSnapshot = useMemo(
    () => (settingsQuery.data ? JSON.stringify(settingsQuery.data) : ''),
    [settingsQuery.data],
  );
  const rulesServerSnapshot = useMemo(
    () =>
      rulesQuery.data
        ? JSON.stringify({
            text: rulesQuery.data.text,
            imageBase64: rulesQuery.data.imageBase64,
            imageMimeType: rulesQuery.data.imageMimeType,
            imageFileName: rulesQuery.data.imageFileName,
          })
        : '',
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

  const saveMutation = useMutation({
    mutationFn: (payload: ChatSettings) => api.updateSettings(chatId ?? '', payload),
    onSuccess: (saved) => {
      setDraft(saved);
      setFieldErrors({});
      setFailedSnapshot('');
      queryClient.setQueryData(['settings', chatId], saved);
    },
    onError: (error, payload) => {
      setFailedSnapshot(JSON.stringify(payload));
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить настройки',
        description: formatApiError(error),
      });
    },
  });
  const isSavingSettings = saveMutation.isPending;
  const mutateSettings = saveMutation.mutate;

  const saveRulesMutation = useMutation({
    mutationFn: (payload: UpdateChatRulesPayload) => api.updateRules(chatId ?? '', payload),
    onSuccess: (saved) => {
      setRulesDraft(saved);
      setRulesAutoFillSeedText(null);
      setRulesTextError('');
      setRulesImageError('');
      setRulesFailedSnapshot('');
      queryClient.setQueryData(['rules', chatId], saved);
    },
    onError: (error, payload) => {
      setRulesFailedSnapshot(JSON.stringify(payload));
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить черновик правил',
        description: formatApiError(error),
      });
    },
  });
  const isSavingRules = saveRulesMutation.isPending;
  const mutateRules = saveRulesMutation.mutate;
  const mutateRulesAsync = saveRulesMutation.mutateAsync;
  const isHeaderSaving = isSavingSettings || isSavingRules;
  const hasPendingHeaderChanges = hasChanges || hasRulesChanges;
  const headerStatusLabel = isHeaderSaving
    ? 'Сохраняем'
    : hasPendingHeaderChanges
      ? 'Черновик'
      : 'Сохранено';
  const chatMetaLabel = chatTitle && chatTitle !== chatId ? `ID ${chatId}` : 'Настройки модерации';
  const showHeaderStatus = isHeaderSaving || hasPendingHeaderChanges;
  const chatParticipantsCountLabel = formatParticipantsCount(
    chatHeaderQuery.data?.participantsCount ?? null,
  );

  const publishRulesMutation = useMutation({
    mutationFn: () => api.publishRules(chatId ?? ''),
    onSuccess: (result) => {
      const updated = chatRulesSchema.parse({
        ...(rulesDraft ?? rulesQuery.data ?? {}),
        publishedMessageId: result.messageId,
        publishedUrl: result.url,
        publishedAt: result.publishedAt,
      });
      setRulesDraft(updated);
      queryClient.setQueryData(['rules', chatId], updated);
      pushToast({
        tone: 'success',
        title: 'Правила опубликованы',
        description: 'Пост опубликован.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать правила',
        description: formatApiError(error),
      });
    },
  });
  const isPublishingRules = publishRulesMutation.isPending;

  const resetPublishedRulesMutation = useMutation({
    mutationFn: () => api.resetPublishedRules(chatId ?? ''),
    onSuccess: (updated) => {
      const nextDraft = chatRulesSchema.parse({
        ...(rulesDraft ?? updated),
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      });
      setRulesDraft(nextDraft);
      queryClient.setQueryData(['rules', chatId], nextDraft);
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

      const savedSourceSettings = await api.updateSettings(chatId, sourceSettings);
      const chats = chatsQuery.data ?? (await api.getChats());
      const targetChatIds = Array.from(
        new Set(chats.map((chat) => chat.id).filter((id) => id !== chatId)),
      );

      const updated: Array<{ chatId: string; settings: ChatSettings }> = [];
      const failedChatIds: string[] = [];

      for (const targetChatId of targetChatIds) {
        try {
          const targetSettings = await api.getSettings(targetChatId);
          const mergedSettings = mergeSectionSettings(targetSettings, savedSourceSettings, section);
          const parsedSettings = chatSettingsSchema.parse(mergedSettings);
          const savedSettings = await api.updateSettings(targetChatId, parsedSettings);
          updated.push({ chatId: targetChatId, settings: savedSettings });
        } catch {
          failedChatIds.push(targetChatId);
        }
      }

      return {
        section,
        sourceSettings: savedSourceSettings,
        updated,
        failedChatIds,
        totalChats: targetChatIds.length + 1,
      };
    },
    onSuccess: (result) => {
      setDraft(result.sourceSettings);
      setFieldErrors({});
      setFailedSnapshot('');
      setOpenSectionApplyConfirm(null);
      if (chatId) {
        queryClient.setQueryData(['settings', chatId], result.sourceSettings);
      }
      for (const item of result.updated) {
        queryClient.setQueryData(['settings', item.chatId], item.settings);
      }

      const syncedChats = result.updated.length + 1;
      const hasFailures = result.failedChatIds.length > 0;
      pushToast({
        tone: hasFailures ? 'info' : 'success',
        title: hasFailures
          ? `Блок «${SECTION_LABELS[result.section]}» применен частично`
          : `Блок «${SECTION_LABELS[result.section]}» применен`,
        description: hasFailures
          ? `Успешно: ${syncedChats}/${result.totalChats} чатов.`
          : `Обновлено чатов: ${syncedChats}.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить блок ко всем чатам',
        description: formatApiError(error),
      });
    },
  });
  const isApplyingSectionToAll = applySectionToAllMutation.isPending;
  const applyingSection = applySectionToAllMutation.variables?.section ?? null;

  const addDomainMutation = useMutation({
    mutationFn: (domain: string) => api.addDomain(chatId ?? '', domain),
    onSuccess: () => {
      setDomainInput('');
      setDomainInputError('');
      void queryClient.invalidateQueries({ queryKey: ['domains', chatId] });
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
    mutationFn: (domain: string) => api.removeDomain(chatId ?? '', domain),
    onSuccess: () => {
      setScheduleDomain(null);
      setScheduleError('');
      void queryClient.invalidateQueries({ queryKey: ['domains', chatId] });
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
      api.scheduleDomainRemoval(chatId ?? '', payload.domain, payload.removeAfterAt),
    onSuccess: (_, payload) => {
      setScheduleError('');
      setScheduleDomain(null);
      void queryClient.invalidateQueries({ queryKey: ['domains', chatId] });
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

  const addGlobalBlacklistUserMutation = useMutation({
    mutationFn: (userId: string) => api.addGlobalUserBlacklistUser(chatId ?? '', userId),
    onSuccess: () => {
      setBlacklistInput('');
      setBlacklistInputError('');
      void queryClient.invalidateQueries({ queryKey: ['global-user-blacklist', chatId] });
      pushToast({ tone: 'success', title: 'Пользователь добавлен в черный список' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось добавить пользователя',
        description: formatApiError(error),
      });
    },
  });

  const removeGlobalBlacklistUserMutation = useMutation({
    mutationFn: (userId: string) => api.removeGlobalUserBlacklistUser(chatId ?? '', userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['global-user-blacklist', chatId] });
      pushToast({ tone: 'success', title: 'Пользователь удален из черного списка' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить пользователя',
        description: formatApiError(error),
      });
    },
  });

  const sendBroadcastMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) => api.sendBroadcast(chatId ?? '', payload),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcasts', chatId] });
      resetMailingComposer();
      const cycleSuffix = result.cycleEnabled
        ? ` Цикл: ${result.cycleCount} отправок каждые ${result.cycleEveryHours}ч.`
        : '';
      const description = result.scheduleId
        ? result.sentChats > 0 && result.nextSendAt
          ? `Первый запуск отправлен. Следующая отправка: ${formatRemovalDateTime(result.nextSendAt)}. Чатов: ${result.targetChats}.${cycleSuffix}`
          : `Сохранено на ${formatRemovalDateTime(result.nextSendAt ?? result.sendAt)}. Чатов: ${result.targetChats}.${cycleSuffix}`
        : result.failedChats > 0
          ? `Доставлено в ${result.sentChats} чат(ов), ошибок: ${result.failedChats}.${cycleSuffix}`
          : `Отправлено в ${result.sentChats} чат(ов).${cycleSuffix}`;
      pushToast({
        tone: result.scheduleId || result.failedChats > 0 ? 'info' : 'success',
        title: result.scheduleId ? 'Рассылка сохранена' : 'Рассылка выполнена',
        description,
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отправить рассылку',
        description: formatApiError(error),
      });
    },
  });

  const loadManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) => api.getManagedBroadcast(chatId ?? '', broadcastId),
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
    }) => api.updateManagedBroadcast(chatId ?? '', broadcastId, payload),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcasts', chatId] });
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
    mutationFn: (broadcastId: string) => api.cancelManagedBroadcast(chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcasts', chatId] });
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

  function setRulesFieldValue<K extends keyof UpdateChatRulesPayload>(
    key: K,
    value: UpdateChatRulesPayload[K],
  ) {
    if (key === 'text') {
      const nextText = String(value);
      setRulesAutoFillSeedText((current) =>
        current !== null && current !== nextText ? null : current,
      );
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
      setFieldErrors({});
      return parsed.data;
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
    if (!failedSnapshot || failedSnapshot === draftSnapshot) {
      return;
    }

    setFailedSnapshot('');
  }, [draftSnapshot, failedSnapshot]);

  useEffect(() => {
    if (!rulesFailedSnapshot || rulesFailedSnapshot === rulesDraftSnapshot) {
      return;
    }

    setRulesFailedSnapshot('');
  }, [rulesDraftSnapshot, rulesFailedSnapshot]);

  useEffect(() => {
    if (!chatId || !draft || !hasChanges || isSavingSettings || isApplyingSectionToAll) {
      return;
    }

    if (failedSnapshot && failedSnapshot === draftSnapshot) {
      return;
    }

    const parsed = validateDraft(draft);
    if (!parsed) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      mutateSettings(parsed);
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    chatId,
    draft,
    draftSnapshot,
    failedSnapshot,
    hasChanges,
    isSavingSettings,
    isApplyingSectionToAll,
    mutateSettings,
  ]);

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

  function handleAddGlobalBlacklistUser() {
    if (!chatId) {
      return;
    }

    const normalized = blacklistInput.trim();
    if (!normalized) {
      setBlacklistInputError('Введите ID пользователя');
      return;
    }

    const existing = (globalBlacklistQuery.data ?? []).some((item) => item.userId === normalized);
    if (existing) {
      setBlacklistInput('');
      setBlacklistInputError('');
      pushToast({ title: 'Пользователь уже в черном списке' });
      return;
    }

    setBlacklistInputError('');
    addGlobalBlacklistUserMutation.mutate(normalized);
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
    setMailingButtonEnabled(false);
    setMailingButtonUrl('');
    setMailingButtonText('Открыть');
    setMailingImageEnabled(false);
    setMailingImageBase64('');
    setMailingImageMimeType('');
    setMailingImageFileName('');
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
  }

  function applyManagedBroadcastToComposer(broadcast: ManagedBroadcastDetails) {
    const schedule = decomposeBroadcastScheduleIso(broadcast.nextSendAt);
    setEditingManagedBroadcast(broadcast);
    setMailingApplyToAllChats(broadcast.applyToAllChats);
    setMailingText(broadcast.text);
    setMailingButtonEnabled(broadcast.buttonEnabled);
    setMailingButtonUrl(broadcast.buttonUrl);
    setMailingButtonText(broadcast.buttonText || 'Открыть');
    setMailingImageEnabled(broadcast.imageEnabled);
    setMailingImageBase64(broadcast.imageBase64);
    setMailingImageMimeType(broadcast.imageMimeType);
    setMailingImageFileName(broadcast.imageFileName);
    setMailingScheduleEnabled(Boolean(broadcast.nextSendAt));
    setMailingScheduleDays(schedule.days);
    setMailingScheduleTime(schedule.time);
    setMailingCycleEnabled(broadcast.cycleEnabled);
    setMailingCycleEveryHours(clampBroadcastCycleHours(broadcast.cycleEveryHours));
    setMailingCycleCount(broadcast.cycleCount);
    setMailingTextError('');
    setMailingButtonUrlError('');
    setMailingButtonTextError('');
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
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
    const scheduleIso = mailingScheduleEnabled
      ? buildBroadcastScheduleIso(mailingScheduleDays, mailingScheduleTime)
      : null;
    const cycleEveryHours = clampBroadcastCycleHours(
      Number.isFinite(mailingCycleEveryHours) ? mailingCycleEveryHours : 1,
    );
    const minimumCycleCount =
      editingManagedBroadcast && editingManagedBroadcast.sentCount > 0
        ? editingManagedBroadcast.sentCount + 1
        : 2;
    const cycleCount = Math.max(
      minimumCycleCount,
      Math.min(
        MAX_BROADCAST_CYCLE_COUNT,
        Number.isFinite(mailingCycleCount) ? mailingCycleCount : minimumCycleCount,
      ),
    );

    let hasError = false;
    if (!normalizedText && !mailingImageEnabled) {
      setMailingTextError('Введите текст или добавьте фото.');
      hasError = true;
    } else if (normalizedText.length > MAX_BROADCAST_TEXT_LENGTH) {
      setMailingTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
      hasError = true;
    } else {
      setMailingTextError('');
    }

    if (mailingImageEnabled) {
      if (!mailingImageBase64 || !mailingImageMimeType.toLowerCase().startsWith('image/')) {
        setMailingImageError('Добавьте фото для рассылки.');
        hasError = true;
      } else {
        setMailingImageError('');
      }
    } else {
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

    if (mailingScheduleEnabled) {
      if (!scheduleIso) {
        setMailingScheduleError('Проверьте день и время рассылки.');
        hasError = true;
      } else if (new Date(scheduleIso).getTime() <= Date.now() + 30_000) {
        setMailingScheduleError('Выберите время минимум через 30 секунд.');
        hasError = true;
      } else {
        setMailingScheduleError('');
      }
    } else {
      setMailingScheduleError('');
    }

    if (mailingCycleEnabled) {
      const firstDelayMs = scheduleIso ? new Date(scheduleIso).getTime() - Date.now() : 0;
      if (firstDelayMs < 0) {
        setMailingCycleError('Проверьте стартовое время цикла.');
        hasError = true;
      } else {
        const totalDelayMs = firstDelayMs + (cycleCount - 1) * cycleEveryHours * BROADCAST_HOUR_MS;
        if (totalDelayMs > MAX_BROADCAST_SCHEDULE_DAYS * BROADCAST_DAY_MS) {
          setMailingCycleError('Все циклы должны уместиться в 14 дней.');
          hasError = true;
        } else {
          setMailingCycleError('');
        }
      }
    } else {
      setMailingCycleError('');
    }

    if (editingManagedBroadcast) {
      if (!scheduleIso) {
        setMailingScheduleError('Для редактирования укажите следующую отправку.');
        hasError = true;
      }
      if (editingManagedBroadcast.sentCount > 0 && !mailingCycleEnabled) {
        setMailingCycleError('После первого запуска цикл нужно оставить включенным.');
        hasError = true;
      }
    }

    if (hasError) {
      return;
    }

    const payload: SendBroadcastPayload = {
      text: normalizedText,
      textFormat: 'markdown',
      applyToAllChats: mailingApplyToAllChats && canApplyToAllChats,
      buttonEnabled: mailingButtonEnabled,
      buttonUrl: normalizedButtonUrl,
      buttonText: normalizedButtonText || 'Открыть',
      imageEnabled: mailingImageEnabled,
      imageBase64: mailingImageEnabled ? mailingImageBase64 : '',
      imageMimeType: mailingImageEnabled ? mailingImageMimeType : '',
      imageFileName: mailingImageEnabled ? mailingImageFileName : '',
      sendAt: mailingScheduleEnabled ? scheduleIso : null,
      cycleEnabled: mailingCycleEnabled,
      cycleEveryHours: mailingCycleEnabled ? cycleEveryHours : 1,
      cycleCount: mailingCycleEnabled ? cycleCount : 1,
    };

    if (editingManagedBroadcast) {
      updateManagedBroadcastMutation.mutate({
        broadcastId: editingManagedBroadcast.id,
        payload,
      });
      return;
    }

    sendBroadcastMutation.mutate(payload);
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

  function toggleSection(section: SettingsSectionKey) {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }));
  }

  function toggleSectionApplyConfirm(section: ApplySectionKey) {
    setOpenSectionApplyConfirm((current) => (current === section ? null : section));
  }

  function handleApplySectionToAllChats(section: ApplySectionKey) {
    if (!chatId || !draft) {
      return;
    }

    const chatsCount = chatsQuery.data?.length ?? 0;
    if (chatsCount <= 1) {
      pushToast({
        title: 'Нет других чатов для применения',
        description: 'Откройте миниапп в другом чате, чтобы добавить его в список.',
      });
      setOpenSectionApplyConfirm(null);
      return;
    }

    const parsed = validateDraft(draft);
    if (!parsed) {
      pushToast({
        tone: 'danger',
        title: 'Исправьте настройки перед применением',
        description: 'В форме есть ошибки, их нужно исправить.',
      });
      return;
    }

    applySectionToAllMutation.mutate({
      section,
      sourceSettings: parsed,
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
  const allowlistEntries: DomainAllowlistEntry[] = domainsQuery.data ?? [];
  const allowlistDomains = allowlistEntries.map((entry) => entry.domain);
  const isDomainMutationPending =
    addDomainMutation.isPending ||
    removeDomainMutation.isPending ||
    scheduleDomainRemovalMutation.isPending;
  const globalBlacklistEntries: GlobalUserBlacklistEntry[] = globalBlacklistQuery.data ?? [];
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
  const greetingHeaderSummary = draft?.greetingEnabled
    ? draft?.greetingBotMessageEnabled
      ? draft?.greetingBotButtonEnabled
        ? 'Сообщение + кнопка'
        : 'Только сообщение'
      : 'Сообщение выключено'
    : 'Выключено';
  const duplicateStagesEnabledCount = [
    draft?.duplicateWarnEnabled,
    draft?.duplicateBanEnabled,
    draft?.duplicateKickEnabled,
  ].filter(Boolean).length;
  const duplicatesHeaderSummary = draft?.antiDuplicateEnabled
    ? `${duplicateStagesEnabledCount}/3 ступени включено`
    : 'Выключено';
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
    draft?.globalCrossChatSpamEnabled,
    draft?.deleteBotMessagesEnabled,
    draft?.removeBotsFromGroupEnabled,
    draft?.globalUserBlacklistEnabled,
  ].filter(Boolean).length;
  const extraHeaderSummary =
    extraEnabledCount > 0
      ? `${extraEnabledCount} опции · ${globalBlacklistEntries.length} в списке`
      : `${globalBlacklistEntries.length} в списке`;
  const chatsCount = chatsQuery.data?.length ?? 0;
  const canApplyToAllChats = chatsCount > 1;
  const managedBroadcasts = managedBroadcastsQuery.data ?? [];
  const mailingCycleCountMin =
    editingManagedBroadcast && editingManagedBroadcast.sentCount > 0
      ? editingManagedBroadcast.sentCount + 1
      : 2;
  const isUpdatingManagedBroadcast = updateManagedBroadcastMutation.isPending;
  const isMailingBusy =
    sendBroadcastMutation.isPending ||
    isUpdatingManagedBroadcast ||
    cancelManagedBroadcastMutation.isPending;
  const mailingTargetLabel =
    mailingApplyToAllChats && canApplyToAllChats
      ? `Во все чаты (${chatsCount})`
      : 'Только текущий чат';
  const mailingSchedulePreview = mailingScheduleEnabled
    ? formatRemovalDateTime(buildBroadcastScheduleIso(mailingScheduleDays, mailingScheduleTime))
    : '';
  const mailingCycleSummary = mailingCycleEnabled
    ? `${mailingCycleCount} отправок / ${mailingCycleEveryHours}ч`
    : '';
  const mailingContentLabel = mailingText.trim()
    ? `${mailingText.trim().length}/${MAX_BROADCAST_TEXT_LENGTH}`
    : mailingImageEnabled && mailingImageBase64
      ? 'фото'
      : 'пусто';
  const mailingHeaderSummary = `${mailingTargetLabel} · ${mailingContentLabel}${
    mailingScheduleEnabled ? ' · по таймеру' : ''
  }${mailingCycleEnabled ? ` · ${mailingCycleSummary}` : ''}`;
  const mailingCanSend = mailingText.trim().length > 0 || mailingImageBase64.length > 0;
  const mailingSendDisabled = isMailingBusy || !mailingCanSend;

  useHintPopoverAutoPosition(openHintKey !== null);

  function renderSectionApplyControl(section: ApplySectionKey) {
    const isConfirmOpen = openSectionApplyConfirm === section;
    const isThisSectionApplying = isApplyingSectionToAll && applyingSection === section;
    const sectionLabel = SECTION_LABELS[section];

    return (
      <div className={cn('settings-section-apply', !canApplyToAllChats && 'is-disabled')}>
        <button
          type="button"
          className="button button--accent settings-section-apply__cta"
          onClick={() => toggleSectionApplyConfirm(section)}
          disabled={!canApplyToAllChats || isApplyingSectionToAll}
          aria-expanded={isConfirmOpen}
          aria-controls={`apply-section-${section}-confirm`}
        >
          {isThisSectionApplying ? 'Применяем...' : 'Применить этот блок ко всем чатам'}
        </button>

        <small className="settings-section-apply__meta">
          {canApplyToAllChats
            ? `Синхронизация «${sectionLabel}» в ${chatsCount} чатах.`
            : 'Пока доступен только текущий чат.'}
        </small>

        {isConfirmOpen ? (
          <div
            id={`apply-section-${section}-confirm`}
            className="settings-section-apply__confirm"
            role="group"
            aria-label={`Подтверждение применения блока ${sectionLabel}`}
          >
            <p className="settings-section-apply__confirm-title">
              Применить блок «{sectionLabel}» ко всем чатам?
            </p>
            <p className="settings-section-apply__confirm-description">
              Будут обновлены только настройки выбранного блока.
            </p>
            <div className="settings-section-apply__confirm-actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setOpenSectionApplyConfirm(null)}
                disabled={isApplyingSectionToAll}
              >
                Отмена
              </button>
              <button
                type="button"
                className="button button--accent"
                onClick={() => handleApplySectionToAllChats(section)}
                disabled={isApplyingSectionToAll}
              >
                Применить сейчас
              </button>
            </div>
          </div>
        ) : null}
      </div>
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
          <header className="settings-page-header stagger-in">
            <div className="settings-page-header__top">
              <Link
                to={buildManagedEntitiesRoute('chat')}
                className="settings-page-header__back"
                aria-label="Назад к чатам"
              >
                <BackChevronIcon />
              </Link>
              <div className="settings-page-header__body">
                <div className="settings-page-header__title-row">
                  <div className="settings-page-header__identity">
                    <h2 className="settings-page-header__title">{chatTitle || chatId}</h2>
                    <p className="settings-page-header__meta">{chatMetaLabel}</p>
                  </div>
                  {showHeaderStatus ? (
                    <span
                      className={cn(
                        'settings-page-header__status',
                        isHeaderSaving ? 'is-saving' : 'is-draft',
                      )}
                      aria-live="polite"
                    >
                      {headerStatusLabel}
                    </span>
                  ) : null}
                </div>
                {chatParticipantsCountLabel ? (
                  <div className="settings-page-header__footer">
                    <span
                      className="settings-page-header__members"
                      aria-label={`Участников: ${chatParticipantsCountLabel}`}
                    >
                      <ParticipantsIcon />
                      <span>{chatParticipantsCountLabel}</span>
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <GlassCard className="settings-sections-shell" padding="sm">
            <GlassCard className="settings-section stagger-in">
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.links}
                  aria-controls="settings-links-content"
                  onClick={() => toggleSection('links')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Модерация ссылок</h3>
                    <small>{linksHeaderSummary}</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.links} />
                </button>
              </div>

              <div
                id="settings-links-content"
                className={cn('settings-section__collapse', expandedSections.links && 'is-open')}
              >
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
                                        className={cn('allowlist-item', 'allowlist-item--domain')}
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
                                                onClick={() => toggleDomainScheduleEditor(entry)}
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
                                                  onClick={() => submitDomainSchedule(entry.domain)}
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
                              <span className="settings-native-toggle__title">1. Объяснение</span>
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
                            <p id="link-bot-message-hint" className="settings-native-toggle__hint">
                              Санкции усиливаются по ступеням, если пользователь повторно отправляет
                              ссылки в течение 24 часов: сначала объяснение, затем предупреждение,
                              потом бан на 6 часов и далее удаление из группы.
                            </p>
                          ) : null}

                          {draft.linkBotMessageEnabled && openBotEditorKey === 'link' ? (
                            <BotMessageEditor
                              editorKey="link"
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
                            <p id="link-warn-message-hint" className="settings-native-toggle__hint">
                              Текст отправляется при 2-й ссылке за 24 часа, если ступень включена.
                            </p>
                          ) : null}

                          {openWarnEditorKey === 'linkWarn' ? (
                            <WarnMessageEditor
                              editorKey="linkWarn"
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
                                    <small className="field__hint">{linkBotButtonUrlError}</small>
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
                                    <small className="field__hint">{linkBotButtonTextError}</small>
                                  ) : null}
                                </label>
                              </div>
                            ) : null}

                            {!hasLinkBotButtonError && openHintKey === 'linkBotButton' ? (
                              <p id="link-bot-button-hint" className="settings-native-toggle__hint">
                                Добавляет кнопку в сообщение бота. Подходит для ссылки на чат, канал
                                или профиль.
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
                  {renderSectionApplyControl('links')}
                </div>
              </div>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '45ms' }}
              aria-label="Правила чата"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.rules}
                  aria-controls="settings-rules-content"
                  onClick={() => toggleSection('rules')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Правила</h3>
                    <small>{rulesHeaderSummary}</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.rules} />
                </button>
              </div>

              <div
                id="settings-rules-content"
                className={cn('settings-section__collapse', expandedSections.rules && 'is-open')}
              >
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

                        <label
                          className={cn(
                            'field settings-text-field mailing-message-field',
                            'rules-editor-field',
                            rulesTextError && 'field--error',
                          )}
                        >
                          <div className="mailing-message-field__meta rules-editor-field__meta">
                            <span className="rules-editor-field__title-group">
                              <span className="field__label">Текст правил</span>
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
                        </label>

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
                                    void handleRulesImageChange(event.target.files?.[0] ?? null);
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
                                  {isSavingRules ? 'Сохраняем черновик...' : 'Черновик обновлён'}
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
              </div>
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
                  <button
                    type="button"
                    className="settings-section__toggle"
                    aria-expanded={expandedSections.poll}
                    aria-controls="settings-poll-content"
                    onClick={() => toggleSection('poll')}
                  >
                    <span className="settings-section__toggle-main">
                      <h3>Опрос</h3>
                      <small>Голосование в отдельном посте</small>
                    </span>
                    <SectionChevron isOpen={expandedSections.poll} />
                  </button>
                </div>

                <div
                  id="settings-poll-content"
                  className={cn('settings-section__collapse', expandedSections.poll && 'is-open')}
                >
                  <div className="settings-section__collapse-inner">
                    <ManagedPollCard api={api} entityType="chat" entityId={chatId} />
                  </div>
                </div>
              </GlassCard>
            ) : null}

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '60ms' }}
              aria-label="Приветствие новых участников"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.greeting}
                  aria-controls="settings-greeting-content"
                  onClick={() => toggleSection('greeting')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Приветствие</h3>
                    <small>{greetingHeaderSummary}</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.greeting} />
                </button>
              </div>

              <div
                id="settings-greeting-content"
                className={cn('settings-section__collapse', expandedSections.greeting && 'is-open')}
              >
                <div className="settings-section__collapse-inner">
                  <div className="settings-native-toggle">
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">Включить приветствие</span>
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
                            <span className="settings-native-toggle__title">Сообщение от бота</span>
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
                            Текст приветствия отправляется только для обычных пользователей, боты
                            исключаются.
                          </p>
                        ) : null}

                        {draft.greetingBotMessageEnabled && openBotEditorKey === 'greeting' ? (
                          <BotMessageEditor
                            editorKey="greeting"
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
                              <span className="settings-native-toggle__title">Добавить кнопку</span>
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
                                  <small className="field__hint">{greetingBotButtonUrlError}</small>
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
                  {renderSectionApplyControl('greeting')}
                </div>
              </div>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '90ms' }}
              aria-label="Фильтр нецензурной лексики"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.profanityFilter}
                  aria-controls="settings-profanity-filter-content"
                  onClick={() => toggleSection('profanityFilter')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Фильтр нецензурной лексики</h3>
                    <small>{profanityFilterHeaderSummary}</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.profanityFilter} />
                </button>
              </div>

              <div
                id="settings-profanity-filter-content"
                className={cn(
                  'settings-section__collapse',
                  expandedSections.profanityFilter && 'is-open',
                )}
              >
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
                                setFieldValue('profanityBotMessageEnabled', event.target.checked)
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
                          <span className="settings-native-toggle__title">2. Предупреждение</span>

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
                  {renderSectionApplyControl('profanityFilter')}
                </div>
              </div>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '135ms' }}
              aria-label="Фильтр комерции"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.commercialFilter}
                  aria-controls="settings-commercial-filter-content"
                  onClick={() => toggleSection('commercialFilter')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Фильтр комерции</h3>
                    <small>{commercialFilterHeaderSummary}</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.commercialFilter} />
                </button>
              </div>

              <div
                id="settings-commercial-filter-content"
                className={cn(
                  'settings-section__collapse',
                  expandedSections.commercialFilter && 'is-open',
                )}
              >
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
                            <span className="chip chip--warning">{commercialSensitivityLabel}</span>
                          </div>

                          <input
                            type="range"
                            min={COMMERCIAL_SENSITIVITY_MIN}
                            max={COMMERCIAL_SENSITIVITY_MAX}
                            step={1}
                            value={commercialSensitivitySliderValue}
                            onChange={(event) =>
                              handleCommercialSensitivitySliderChange(Number(event.target.value))
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
                            Ползунок меняет строгость фильтра и автоматически подбирает внутренние
                            пороги.
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
                            <span className="settings-native-toggle__title">2. Предупреждение</span>
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
                            Текст отправляется при 2-м нарушении коммерческого фильтра за 24 часа.
                          </p>
                        ) : null}

                        {openWarnEditorKey === 'textFiltersWarn' ? (
                          <WarnMessageEditor
                            editorKey="textFiltersWarn"
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
                              <span className="settings-native-toggle__title">Добавить кнопку</span>
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
                                    setFieldValue('textFiltersBotButtonText', event.target.value)
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
                  {renderSectionApplyControl('commercialFilter')}
                </div>
              </div>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '157ms' }}
              aria-label="Тематические фильтры"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.thematicFilters}
                  aria-controls="settings-thematic-filters-content"
                  onClick={() => toggleSection('thematicFilters')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Тематические фильтры</h3>
                    <small>{thematicFiltersHeaderSummary}</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.thematicFilters} />
                </button>
              </div>

              <div
                id="settings-thematic-filters-content"
                className={cn(
                  'settings-section__collapse',
                  expandedSections.thematicFilters && 'is-open',
                )}
              >
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
                                setFieldValue('thematicFiltersBotButtonUrl', event.target.value)
                              }
                              placeholder="https://max.ru/channel/..."
                            />
                            {thematicBotButtonUrlError ? (
                              <small className="field__hint">{thematicBotButtonUrlError}</small>
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
                                setFieldValue('thematicFiltersBotButtonText', event.target.value)
                              }
                              placeholder="Открыть"
                              maxLength={32}
                            />
                            {thematicBotButtonTextError ? (
                              <small className="field__hint">{thematicBotButtonTextError}</small>
                            ) : hasThematicBotButtonError ? null : (
                              <small className="field__hint">До 32 символов.</small>
                            )}
                          </label>
                        </div>
                      ) : null}

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">2. Предупреждение</span>

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
                  {renderSectionApplyControl('thematicFilters')}
                </div>
              </div>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '180ms' }}
              aria-label="Настройки дублей"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.duplicates}
                  aria-controls="settings-duplicates-content"
                  onClick={() => toggleSection('duplicates')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Дубли сообщений</h3>
                    <small>{duplicatesHeaderSummary}</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.duplicates} />
                </button>
              </div>

              <div
                id="settings-duplicates-content"
                className={cn(
                  'settings-section__collapse',
                  expandedSections.duplicates && 'is-open',
                )}
              >
                <div className="settings-section__collapse-inner">
                  <div className="settings-native-toggle">
                    <div className="settings-native-toggle__row">
                      <span className="settings-native-toggle__title">Анти дубль</span>
                      <label className="settings-native-switch" aria-label="Включить анти дубль">
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
                          <span className="settings-native-toggle__title">Длительность бана</span>
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
                          После выдачи бана сообщения пользователя удаляются автоматически в течение
                          этого времени.
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
                                    onBlur={() => handleDuplicateWindowHoursBlur(stage.windowKey)}
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
                                    disabled={!enabled || Number(maxCount) <= DUPLICATE_COUNT_MIN}
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
                                    disabled={!enabled || Number(maxCount) >= DUPLICATE_COUNT_MAX}
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
                          <span className="settings-native-toggle__title">Сообщение от бота</span>
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
                        <p id="duplicate-bot-message-hint" className="settings-native-toggle__hint">
                          При срабатывании правила дублей бот публикует поясняющее сообщение.
                        </p>
                      ) : null}

                      {draft.duplicateBotMessageEnabled && openBotEditorKey === 'duplicate' ? (
                        <BotMessageEditor
                          editorKey="duplicate"
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
                              <small className="field__hint">{duplicateBotButtonUrlError}</small>
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
                              <small className="field__hint">{duplicateBotButtonTextError}</small>
                            ) : null}
                          </label>
                        </div>
                      ) : null}

                      {!hasDuplicateBotButtonError && openHintKey === 'duplicateBotButton' ? (
                        <p id="duplicate-bot-button-hint" className="settings-native-toggle__hint">
                          Добавляет кнопку в сообщение бота. Можно отправить пользователя в нужный
                          чат, канал или профиль.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {renderSectionApplyControl('duplicates')}
                </div>
              </div>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '225ms' }}
              aria-label="Ограничения сообщений"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.limits}
                  aria-controls="settings-limits-content"
                  onClick={() => toggleSection('limits')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Ограничения сообщений</h3>
                    <small>{limitsRulesEnabledCount} ограничений активно</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.limits} />
                </button>
              </div>

              <div
                id="settings-limits-content"
                className={cn('settings-section__collapse', expandedSections.limits && 'is-open')}
              >
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
                        Базовые параметры: не более 5 сообщений за 10 секунд от одного пользователя.
                        Изменение порогов через UI отключено.
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
                        <span className="settings-native-toggle__title">Лимит длины сообщения</span>
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
                      <>
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                            Максимум
                          </span>
                          <output className="settings-length-limit__value" aria-live="polite">
                            {draft.maxMessageLength} симв.
                          </output>
                        </div>

                        <input
                          className="settings-length-limit__slider"
                          type="range"
                          min={MESSAGE_LENGTH_MIN}
                          max={MESSAGE_LENGTH_MAX}
                          step={1}
                          value={draft.maxMessageLength}
                          onChange={(event) =>
                            setFieldValue(
                              'maxMessageLength',
                              Number(event.target.value) as ChatSettings['maxMessageLength'],
                            )
                          }
                          aria-label="Лимит длины сообщения"
                        />

                        <div className="settings-length-limit__labels" aria-hidden>
                          <span>{MESSAGE_LENGTH_MIN}</span>
                          <span>{MESSAGE_LENGTH_MAX}</span>
                        </div>
                      </>
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
                        <span className="settings-native-toggle__title">Фото: не чаще 1 раза</span>
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
                      <small className="field__hint">{fieldErrors.photoMessageCooldownHours}</small>
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
                              draft.stickerMessageCooldownMinutes <= STICKER_COOLDOWN_MIN_MINUTES
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
                              draft.stickerMessageCooldownMinutes >= STICKER_COOLDOWN_MAX_MINUTES
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
                        Текст фиксированный и в этом разделе не редактируется.
                      </p>
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
                      <span className="settings-native-toggle__title">4. Удаление из группы</span>

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
                          Добавляет кнопку в сообщение бота с переходом на чат, канал или профиль.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {renderSectionApplyControl('limits')}
                </div>
              </div>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '270ms' }}
              aria-label="Закрытие чата на ночь"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.night}
                  aria-controls="settings-night-content"
                  onClick={() => toggleSection('night')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Закрытие чата на ночь</h3>
                    <small>
                      {draft.nightModeEnabled
                        ? `${nightWindowLabel} • ${nightTimezoneLabel}`
                        : 'Выключено'}
                    </small>
                  </span>
                  <SectionChevron isOpen={expandedSections.night} />
                </button>
              </div>

              <div
                id="settings-night-content"
                className={cn('settings-section__collapse', expandedSections.night && 'is-open')}
              >
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
                      className={cn('settings-native-toggle', nightTimezoneError && 'field--error')}
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
                            <span className="settings-native-toggle__title">Сообщение от бота</span>
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
                          <p id="night-bot-message-hint" className="settings-native-toggle__hint">
                            Бот пишет, что чат закрыт на ночь, и поясняет удаление сообщения.
                          </p>
                        ) : null}

                        {draft.nightModeBotMessageEnabled && openBotEditorKey === 'night' ? (
                          <BotMessageEditor
                            editorKey="night"
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
                              <span className="settings-native-toggle__title">Добавить кнопку</span>
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
                                  <small className="field__hint">{nightBotButtonUrlError}</small>
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
                                  <small className="field__hint">{nightBotButtonTextError}</small>
                                ) : null}
                              </label>
                            </div>
                          ) : null}

                          {!hasNightBotButtonError && openHintKey === 'nightBotButton' ? (
                            <p id="night-bot-button-hint" className="settings-native-toggle__hint">
                              Добавляет кнопку в сообщение о закрытии чата на ночь.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {renderSectionApplyControl('night')}
                </div>
              </div>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '315ms' }}
              aria-label="Рассылка"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.mailing}
                  aria-controls="settings-mailing-content"
                  onClick={() => toggleSection('mailing')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Рассылка</h3>
                    <small>{mailingHeaderSummary}</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.mailing} />
                </button>
              </div>

              <div
                id="settings-mailing-content"
                className={cn('settings-section__collapse', expandedSections.mailing && 'is-open')}
              >
                <div className="settings-section__collapse-inner settings-mailing">
                  <div className="managed-broadcasts-list">
                    <div className="managed-broadcasts-list__head">
                      <span className="managed-broadcasts-list__title">Текущие рассылки</span>
                      <small className="managed-broadcasts-list__meta">
                        {managedBroadcastsQuery.isLoading
                          ? 'Загрузка...'
                          : managedBroadcasts.length > 0
                            ? `${managedBroadcasts.length} активных`
                            : 'Нет активных рассылок'}
                      </small>
                    </div>

                    {managedBroadcasts.map((broadcast) => {
                      const isOpen = expandedManagedBroadcastId === broadcast.id;
                      const progressLabel = `${broadcast.sentCount}/${broadcast.cycleCount}`;
                      const nextLabel = broadcast.nextSendAt
                        ? formatRemovalDateTime(broadcast.nextSendAt)
                        : 'ожидает правки';

                      return (
                        <div
                          key={broadcast.id}
                          className={cn(
                            'managed-broadcast-card',
                            isOpen && 'is-open',
                            broadcast.status === 'FAILED' && 'is-failed',
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
                                {broadcast.status === 'FAILED'
                                  ? 'Ошибка рассылки'
                                  : `Следующая: ${nextLabel}`}
                              </strong>
                              <small>{broadcast.textPreview}</small>
                            </span>
                            <span className="managed-broadcast-card__aside">
                              <small>{`Прогресс ${progressLabel}`}</small>
                              <SectionChevron isOpen={isOpen} />
                            </span>
                          </button>

                          <div
                            id={`managed-broadcast-${broadcast.id}`}
                            className={cn('managed-broadcast-card__body', isOpen && 'is-open')}
                          >
                            <div className="managed-broadcast-card__facts">
                              <span>{broadcast.applyToAllChats ? 'Во все чаты' : 'Только этот чат'}</span>
                              <span>{`Чатов: ${broadcast.targetChats}`}</span>
                              <span>{broadcast.hasImage ? 'С фото' : 'Без фото'}</span>
                              <span>{broadcast.buttonEnabled ? 'С кнопкой' : 'Без кнопки'}</span>
                              <span>
                                {broadcast.cycleEnabled
                                  ? `Каждые ${broadcast.cycleEveryHours}ч`
                                  : 'Одна отправка'}
                              </span>
                            </div>
                            {broadcast.lastError ? (
                              <small className="field__hint">{broadcast.lastError}</small>
                            ) : null}
                            <div className="managed-broadcast-card__actions">
                              <button
                                type="button"
                                className="button button--ghost"
                                onClick={() => handleEditManagedBroadcast(broadcast.id)}
                                disabled={isMailingBusy || loadManagedBroadcastMutation.isPending}
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
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {editingManagedBroadcast ? (
                    <div className="managed-broadcast-editor-note">
                      <strong>Редактирование рассылки</strong>
                      <small>
                        {editingManagedBroadcast.sentCount > 0
                          ? `Уже отправлено: ${editingManagedBroadcast.sentCount} из ${editingManagedBroadcast.cycleCount}.`
                          : 'Можно менять текст, фото, кнопку и следующее время отправки.'}
                      </small>
                    </div>
                  ) : null}

                  <div
                    className={cn('mailing-target-card', !canApplyToAllChats && 'is-single-chat')}
                  >
                    <div className="mailing-target-card__row">
                      <div className="mailing-target-card__title-wrap">
                        <div className="mailing-card-title-row">
                          <span className="mailing-target-card__title">Применить во всех чатах</span>
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

                  <label
                    className={cn(
                      'field',
                      'mailing-message-field',
                      mailingTextError && 'field--error',
                    )}
                  >
                    <div className="channel-settings-field-label">
                      <span className="field__label">Текст сообщения</span>
                      <span className="channel-settings-hint-anchor">
                        <button
                          type="button"
                          className={cn(
                            'settings-info-button',
                            openHintKey === 'mailingText' && 'is-open',
                          )}
                          aria-label="Пояснение для текста рассылки"
                          aria-controls="mailing-text-hint"
                          aria-expanded={openHintKey === 'mailingText'}
                          onClick={() => toggleHint('mailingText')}
                        >
                          <span aria-hidden>i</span>
                        </button>
                        {openHintKey === 'mailingText' ? (
                          <p id="mailing-text-hint" className="channel-settings-hint-popover">
                            MAX поддерживает markdown: жирный, курсив, подчеркивание, зачеркнутый
                            текст, код и ссылки. Отдельных заголовков нет, их лучше имитировать
                            короткой акцентной строкой. Можно отправить и только фото, но текст
                            обычно повышает вовлеченность.
                          </p>
                        ) : null}
                      </span>
                    </div>
                    <MaxMarkdownEditor
                      value={mailingText}
                      onChange={(nextValue) => {
                        setMailingText(nextValue);
                        if (mailingTextError) {
                          setMailingTextError('');
                        }
                      }}
                      ariaLabel="Текст рассылки в чат"
                      rows={5}
                      maxLength={MAX_BROADCAST_TEXT_LENGTH}
                      placeholder="Например: Сегодня в 21:00 старт турнира. Подключайтесь!"
                    />
                    <div className="mailing-message-field__meta">
                      {mailingTextError ? (
                        <small className="field__hint">{mailingTextError}</small>
                      ) : null}
                      <small
                        className={cn(
                          'mailing-message-field__counter',
                          mailingText.length >= MAX_BROADCAST_TEXT_LENGTH && 'is-limit',
                        )}
                      >
                        {mailingText.length}/{MAX_BROADCAST_TEXT_LENGTH}
                      </small>
                    </div>
                  </label>

                  <div className="mailing-options-grid">
                    <div
                      className={cn(
                        'mailing-option-card',
                        mailingImageEnabled && 'is-enabled',
                        mailingImageError && 'field--error',
                      )}
                    >
                      <div className="mailing-option-card__head">
                        <div className="mailing-option-card__title-wrap">
                          <div className="mailing-card-title-row">
                            <span className="mailing-option-card__title">Фото</span>
                            <SettingsHintAnchor
                              hintKey="mailingImage"
                              openHintKey={openHintKey}
                              onToggleHint={toggleHint}
                              label="Пояснение для фото в рассылке"
                            >
                              Фото можно отправить отдельно или вместе с текстом. Приложение
                              подготовит его перед отправкой.
                            </SettingsHintAnchor>
                          </div>
                        </div>

                        <label
                          className="settings-native-switch"
                          aria-label="Добавить фото в рассылку"
                        >
                          <input
                            type="checkbox"
                            checked={mailingImageEnabled}
                            onChange={(event) => {
                              const enabled = event.target.checked;
                              setMailingImageEnabled(enabled);
                              if (!enabled) {
                                setMailingImageBase64('');
                                setMailingImageMimeType('');
                                setMailingImageFileName('');
                                setMailingImageError('');
                              }
                            }}
                            disabled={isMailingBusy}
                          />
                          <span className="toggle-switch" aria-hidden>
                            <span className="toggle-switch__thumb" />
                          </span>
                        </label>
                      </div>

                      {mailingImageEnabled ? (
                        <div className="mailing-option-card__body">
                          <label
                            className={cn(
                              'field',
                              'mailing-upload-field',
                              mailingImageError && 'field--error',
                            )}
                          >
                            <span className="field__label">Файл изображения</span>
                            <input
                              type="file"
                              accept="image/*"
                              onChange={async (event) => {
                                const file = event.target.files?.[0];
                                if (!file) {
                                  setMailingImageBase64('');
                                  setMailingImageMimeType('');
                                  setMailingImageFileName('');
                                  setMailingImageError('Выберите фото.');
                                  return;
                                }

                                if (!file.type.toLowerCase().startsWith('image/')) {
                                  setMailingImageBase64('');
                                  setMailingImageMimeType('');
                                  setMailingImageFileName('');
                                  setMailingImageError('Нужен файл изображения.');
                                  return;
                                }

                                try {
                                  const preparedImage = await prepareBroadcastImage(file);
                                  setMailingImageBase64(preparedImage.base64);
                                  setMailingImageMimeType(preparedImage.mimeType);
                                  setMailingImageFileName(preparedImage.fileName);
                                  setMailingImageError('');
                                } catch (error: unknown) {
                                  setMailingImageBase64('');
                                  setMailingImageMimeType('');
                                  setMailingImageFileName('');
                                  setMailingImageError(
                                    error instanceof Error && error.message.trim()
                                      ? error.message
                                      : 'Не удалось подготовить фото.',
                                  );
                                }
                              }}
                              disabled={isMailingBusy}
                            />
                            {mailingImageError ? (
                              <small className="field__hint">{mailingImageError}</small>
                            ) : mailingImageFileName ? (
                              <small className="field__hint">{mailingImageFileName}</small>
                            ) : null}
                          </label>
                        </div>
                      ) : null}
                    </div>

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

                  <div className="mailing-options-grid mailing-options-grid--timing">
                    <div
                      className={cn(
                        'mailing-option-card',
                        mailingScheduleEnabled && 'is-enabled',
                        mailingScheduleError && 'field--error',
                      )}
                    >
                      <div className="mailing-option-card__head">
                        <div className="mailing-option-card__title-wrap">
                          <div className="mailing-card-title-row">
                            <span className="mailing-option-card__title">Таймер отправки</span>
                            <SettingsHintAnchor
                              hintKey="mailingSchedule"
                              openHintKey={openHintKey}
                              onToggleHint={toggleHint}
                              label="Пояснение для таймера рассылки"
                            >
                              Отложенная отправка доступна до 14 дней вперёд. Если таймер
                              выключен, сообщение уйдёт сразу.
                            </SettingsHintAnchor>
                          </div>
                        </div>

                        <label
                          className="settings-native-switch"
                          aria-label="Включить таймер рассылки"
                        >
                          <input
                            type="checkbox"
                            checked={mailingScheduleEnabled}
                            onChange={(event) => {
                              setMailingScheduleEnabled(event.target.checked);
                              setMailingScheduleError('');
                            }}
                            disabled={isMailingBusy}
                          />
                          <span className="toggle-switch" aria-hidden>
                            <span className="toggle-switch__thumb" />
                          </span>
                        </label>
                      </div>

                      {mailingScheduleEnabled ? (
                        <div className="mailing-option-card__body mailing-inline-fields">
                          <label className="field settings-text-field mailing-inline-field">
                            <span className="field__label">Через сколько дней</span>
                            <input
                              type="number"
                              min={0}
                              max={MAX_BROADCAST_SCHEDULE_DAYS}
                              value={mailingScheduleDays}
                              onChange={(event) => {
                                const nextValue = Number.parseInt(event.target.value, 10);
                                const safeValue = Number.isNaN(nextValue)
                                  ? 0
                                  : Math.max(0, Math.min(MAX_BROADCAST_SCHEDULE_DAYS, nextValue));
                                setMailingScheduleDays(safeValue);
                                setMailingScheduleError('');
                              }}
                              disabled={isMailingBusy}
                            />
                          </label>

                          <label className="field settings-text-field mailing-inline-field">
                            <span className="field__label">Время</span>
                            <input
                              type="time"
                              value={mailingScheduleTime}
                              onChange={(event) => {
                                setMailingScheduleTime(event.target.value);
                                setMailingScheduleError('');
                              }}
                              disabled={isMailingBusy}
                            />
                          </label>
                        </div>
                      ) : null}

                      {mailingScheduleError ? (
                        <small className="field__hint">{mailingScheduleError}</small>
                      ) : mailingScheduleEnabled && mailingSchedulePreview ? (
                        <small className="mailing-option-card__hint is-info">
                          {`Отправка: ${mailingSchedulePreview}`}
                        </small>
                      ) : null}
                    </div>

                    <div
                      className={cn(
                        'mailing-option-card',
                        mailingCycleEnabled && 'is-enabled',
                        mailingCycleError && 'field--error',
                      )}
                    >
                      <div className="mailing-option-card__head">
                        <div className="mailing-option-card__title-wrap">
                          <div className="mailing-card-title-row">
                            <span className="mailing-option-card__title">Циклическая рассылка</span>
                            <SettingsHintAnchor
                              hintKey="mailingCycle"
                              openHintKey={openHintKey}
                              onToggleHint={toggleHint}
                              label="Пояснение для циклической рассылки"
                            >
                              Интервал повторов задаётся в часах от 1 до 24. Максимум 100
                              отправок, но весь цикл всё равно должен уместиться в 14 дней.
                            </SettingsHintAnchor>
                          </div>
                        </div>

                        <label
                          className="settings-native-switch"
                          aria-label="Включить циклическую рассылку"
                        >
                          <input
                            type="checkbox"
                            checked={mailingCycleEnabled}
                            onChange={(event) => {
                              setMailingCycleEnabled(event.target.checked);
                              setMailingCycleError('');
                            }}
                            disabled={isMailingBusy || Boolean(editingManagedBroadcast?.sentCount)}
                          />
                          <span className="toggle-switch" aria-hidden>
                            <span className="toggle-switch__thumb" />
                          </span>
                        </label>
                      </div>

                      {mailingCycleEnabled ? (
                        <div className="mailing-option-card__body mailing-inline-fields">
                          <div className="mailing-inline-field mailing-hours-stepper">
                            <span className="mailing-hours-stepper__label">Интервал (часы)</span>
                            <div className="mailing-hours-stepper__control">
                              <button
                                type="button"
                                className="mailing-hours-stepper__button"
                                onClick={() => {
                                  setMailingCycleEveryHours((prev) =>
                                    clampBroadcastCycleHours(prev - 1),
                                  );
                                  setMailingCycleError('');
                                }}
                                disabled={
                                  isMailingBusy ||
                                  mailingCycleEveryHours <= MIN_BROADCAST_CYCLE_HOURS
                                }
                                aria-label="Уменьшить интервал цикла"
                              >
                                -
                              </button>

                              <div className="mailing-hours-stepper__value" aria-live="polite">
                                {mailingCycleEveryHours}ч
                              </div>

                              <button
                                type="button"
                                className="mailing-hours-stepper__button"
                                onClick={() => {
                                  setMailingCycleEveryHours((prev) =>
                                    clampBroadcastCycleHours(prev + 1),
                                  );
                                  setMailingCycleError('');
                                }}
                                disabled={
                                  isMailingBusy ||
                                  mailingCycleEveryHours >= MAX_BROADCAST_CYCLE_HOURS
                                }
                                aria-label="Увеличить интервал цикла"
                              >
                                +
                              </button>
                            </div>
                          </div>

                          <label className="field settings-text-field mailing-inline-field">
                            <span className="field__label">Количество отправок</span>
                            <input
                              type="number"
                              min={mailingCycleCountMin}
                              max={MAX_BROADCAST_CYCLE_COUNT}
                              value={mailingCycleCount}
                              onChange={(event) => {
                                const nextValue = Number.parseInt(event.target.value, 10);
                                const safeValue = Number.isNaN(nextValue)
                                  ? mailingCycleCountMin
                                  : Math.max(
                                      mailingCycleCountMin,
                                      Math.min(MAX_BROADCAST_CYCLE_COUNT, nextValue),
                                    );
                                setMailingCycleCount(safeValue);
                                setMailingCycleError('');
                              }}
                              disabled={isMailingBusy}
                            />
                          </label>
                        </div>
                      ) : null}

                      {mailingCycleError ? (
                        <small className="field__hint">{mailingCycleError}</small>
                      ) : editingManagedBroadcast?.sentCount ? (
                        <small className="mailing-option-card__hint is-info">
                          После первого запуска можно менять шаг, время и общий лимит отправок.
                        </small>
                      ) : mailingCycleEnabled && mailingCycleSummary ? (
                        <small className="mailing-option-card__hint is-info">
                          {`Цикл: ${mailingCycleSummary}`}
                        </small>
                      ) : null}
                    </div>
                  </div>

                  <div className="mailing-action-bar">
                    <button
                      type="button"
                      className="button button--accent mailing-action-bar__send"
                      onClick={handleSendBroadcast}
                      disabled={mailingSendDisabled}
                    >
                      {isUpdatingManagedBroadcast
                        ? 'Сохраняем...'
                        : sendBroadcastMutation.isPending
                          ? 'Отправляем...'
                          : editingManagedBroadcast
                            ? 'Сохранить рассылку'
                            : 'Отправить рассылку'}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost mailing-action-bar__clear"
                      onClick={editingManagedBroadcast ? handleCancelMailingEdit : resetMailingComposer}
                      disabled={isMailingBusy}
                    >
                      {editingManagedBroadcast ? 'Отменить редактирование' : 'Очистить'}
                    </button>
                  </div>
                </div>
              </div>
            </GlassCard>

            <GlassCard
              className="settings-section stagger-in"
              style={{ animationDelay: '360ms' }}
              aria-label="Дополнительные настройки"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <button
                  type="button"
                  className="settings-section__toggle"
                  aria-expanded={expandedSections.extra}
                  aria-controls="settings-extra-content"
                  onClick={() => toggleSection('extra')}
                >
                  <span className="settings-section__toggle-main">
                    <h3>Дополнительно</h3>
                    <small>{extraHeaderSummary}</small>
                  </span>
                  <SectionChevron isOpen={expandedSections.extra} />
                </button>
              </div>

              <div
                id="settings-extra-content"
                className={cn('settings-section__collapse', expandedSections.extra && 'is-open')}
              >
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
                        Бот будет автоматически удалять собственные сообщения через выбранное время.
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
                        <span className="settings-native-toggle__title">Через сколько удалять</span>

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
                              draft.deleteBotMessagesDelayMinutes <= BOT_MESSAGES_DELETE_DELAY_MIN
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
                              draft.deleteBotMessagesDelayMinutes >= BOT_MESSAGES_DELETE_DELAY_MAX
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
                        <span className="settings-native-toggle__title">
                          Анти-спам во всех чатах
                        </span>
                        <button
                          type="button"
                          className={cn(
                            'settings-info-button',
                            openHintKey === 'globalCrossChatSpam' && 'is-open',
                          )}
                          aria-label="Пояснение для анти-спама во всех чатах"
                          aria-controls="global-cross-chat-spam-hint"
                          aria-expanded={openHintKey === 'globalCrossChatSpam'}
                          onClick={() => toggleHint('globalCrossChatSpam')}
                        >
                          <span aria-hidden>i</span>
                        </button>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить анти-спам во всех чатах"
                      >
                        <input
                          type="checkbox"
                          checked={draft.globalCrossChatSpamEnabled}
                          onChange={(event) =>
                            setFieldValue('globalCrossChatSpamEnabled', event.target.checked)
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>

                    {openHintKey === 'globalCrossChatSpam' ? (
                      <p id="global-cross-chat-spam-hint" className="settings-native-toggle__hint">
                        Если пользователь отправляет одинаковый текст/фото/пересланное в 3+ чата за
                        2 минуты, бот удаляет сообщение и пишет предупреждение о спаме. Опция
                        действует только в связке чатов с общим администратором и не пересекается с
                        чужими чатами.
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

                  <div className="settings-native-toggle">
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">
                          Удалять пользователей из черного списка
                        </span>
                        <button
                          type="button"
                          className={cn(
                            'settings-info-button',
                            openHintKey === 'globalBlacklist' && 'is-open',
                          )}
                          aria-label="Пояснение для глобального черного списка"
                          aria-controls="global-blacklist-hint"
                          aria-expanded={openHintKey === 'globalBlacklist'}
                          onClick={() => toggleHint('globalBlacklist')}
                        >
                          <span aria-hidden>i</span>
                        </button>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Включить удаление пользователей из черного списка"
                      >
                        <input
                          type="checkbox"
                          checked={draft.globalUserBlacklistEnabled}
                          onChange={(event) =>
                            setFieldValue('globalUserBlacklistEnabled', event.target.checked)
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>

                    {openHintKey === 'globalBlacklist' ? (
                      <p id="global-blacklist-hint" className="settings-native-toggle__hint">
                        Если включить в любом чате, режим начнет действовать во всех чатах бота.
                      </p>
                    ) : null}
                  </div>

                  {draft.globalUserBlacklistEnabled ? (
                    <div
                      className={cn(
                        'field',
                        'allowlist-panel',
                        blacklistInputError && 'allowlist-panel--error',
                      )}
                    >
                      <div className="allowlist-panel__head">
                        <span className="field__label">Черный список пользователей</span>
                        <span className="chip">{globalBlacklistEntries.length}</span>
                      </div>

                      <p className="allowlist-panel__subtitle">
                        Добавьте ID пользователя, которого нужно удалять автоматически.
                      </p>

                      <div className="allowlist-add-row">
                        <input
                          type="text"
                          inputMode="text"
                          value={blacklistInput}
                          onChange={(event) => {
                            setBlacklistInput(event.target.value);
                            setBlacklistInputError('');
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              handleAddGlobalBlacklistUser();
                            }
                          }}
                          placeholder="user_id"
                        />
                        <button
                          type="button"
                          className="button button--accent allowlist-add-row__button"
                          onClick={handleAddGlobalBlacklistUser}
                          disabled={
                            addGlobalBlacklistUserMutation.isPending ||
                            removeGlobalBlacklistUserMutation.isPending
                          }
                        >
                          {addGlobalBlacklistUserMutation.isPending ? 'Добавляем...' : 'Добавить'}
                        </button>
                      </div>

                      {blacklistInputError ? (
                        <small className="field__hint">{blacklistInputError}</small>
                      ) : null}

                      {globalBlacklistQuery.isLoading ? (
                        <p className="allowlist-empty">Загрузка списка...</p>
                      ) : null}

                      {globalBlacklistQuery.error ? (
                        <p className="allowlist-empty allowlist-empty--error">
                          Ошибка: {formatApiError(globalBlacklistQuery.error)}
                        </p>
                      ) : null}

                      {!globalBlacklistQuery.isLoading && !globalBlacklistQuery.error ? (
                        globalBlacklistEntries.length > 0 ? (
                          <ul className="allowlist-list" aria-label="Черный список пользователей">
                            {globalBlacklistEntries.map((entry) => (
                              <li key={entry.userId} className="allowlist-item">
                                <span className="allowlist-item__domain">{entry.userId}</span>
                                <button
                                  type="button"
                                  className="allowlist-item__remove"
                                  onClick={() =>
                                    removeGlobalBlacklistUserMutation.mutate(entry.userId)
                                  }
                                  disabled={
                                    removeGlobalBlacklistUserMutation.isPending ||
                                    addGlobalBlacklistUserMutation.isPending
                                  }
                                >
                                  Удалить
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="allowlist-empty">Список пуст</p>
                        )
                      ) : null}
                    </div>
                  ) : null}
                  {renderSectionApplyControl('extra')}
                </div>
              </div>
            </GlassCard>
          </GlassCard>
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
