import {
  chatSettingsSchema,
  type ChatSettings,
  type GlobalUserBlacklistEntry,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { saveLastChatId } from '../lib/last-chat';

type FieldErrors = Partial<Record<keyof ChatSettings, string>>;

const DOMAIN_PATTERN = /^(?=.{3,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/i;
const AUTO_SAVE_DELAY_MS = 650;
const BAN_DURATION_MIN_HOURS = 1;
const BAN_DURATION_MAX_HOURS = 36;
const DUPLICATE_COUNT_MIN = 2;
const DUPLICATE_COUNT_MAX = 20;
const MESSAGE_LENGTH_MIN = 50;
const MESSAGE_LENGTH_MAX = 1500;
const PHOTO_COOLDOWN_MIN_HOURS = 1;
const PHOTO_COOLDOWN_MAX_HOURS = 24;
const COMMERCIAL_SENSITIVITY_MIN = 0;
const COMMERCIAL_SENSITIVITY_MAX = 100;
const COMMERCIAL_BALANCED_MAX = 69;

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
  | 'messageLimitsBotMessage'
  | 'messageLimitsBotButton'
  | 'nightModeEnabled'
  | 'nightBotMessage'
  | 'nightBotButton'
  | 'removeBotsFromGroup'
  | 'globalBlacklist';
type BotMessageEditorKey = 'link' | 'greeting' | 'textFilters' | 'duplicate' | 'messageLimits' | 'night';
type WarnMessageEditorKey = 'linkWarn' | 'textFiltersWarn';
type SettingsSectionKey =
  | 'links'
  | 'greeting'
  | 'textFilters'
  | 'duplicates'
  | 'limits'
  | 'night'
  | 'extra';

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

const TEXT_FILTER_OPTIONS: Array<{
  key: 'russianProfanityFilterEnabled' | 'commercialAdsFilterEnabled';
  title: string;
  description: string;
}> = [
  {
    key: 'russianProfanityFilterEnabled',
    title: 'Нецензурная лексика (RU)',
    description: 'Удаляет сообщения с матом и грубой лексикой на русском.',
  },
  {
    key: 'commercialAdsFilterEnabled',
    title: 'Коммерческие объявления (RU)',
    description: 'Удаляет рекламные и торговые объявления в чате.',
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

const BOT_MESSAGE_PREVIEW_REPLACEMENTS: Record<BotMessageEditorKey, Record<string, string>> = {
  link: {
    user: '"Алексей"',
    message_status: 'удалено',
    reason: 'в этом чате нельзя отправлять ссылки. Пожалуйста, без ссылок.',
  },
  greeting: {
    user: '"Алексей"',
    greeting: 'добро пожаловать в чат',
  },
  textFilters: {
    user: '"Алексей"',
    message_status: 'удалено',
    reason: 'нецензурная лексика запрещена правилами чата',
  },
  duplicate: {
    user: '"Алексей"',
    duplicate_context: 'удалено как дубль',
    sanction: 'Пользователю вынесено предупреждение.',
    ban_duration: '6 часов',
  },
  messageLimits: {
    user: '"Алексей"',
    message_status: 'удалено',
    reason: 'длина сообщения 1860 символов, лимит 1500',
    actual_length: '1860',
    max_length: '1500',
    photo_cooldown_hours: '2',
  },
  night: {
    user: '"Алексей"',
    night_window: '23:00-08:00',
    night_timezone: 'Москва',
    night_status: 'Сообщение пользователя "Алексей" удалено.',
  },
};

const WARN_MESSAGE_PREVIEW_REPLACEMENTS: Record<WarnMessageEditorKey, Record<string, string>> = {
  linkWarn: {
    user: '"Алексей"',
    warning: 'вынесено предупреждение за ссылку',
    reason: 'в этом чате нельзя отправлять ссылки',
  },
  textFiltersWarn: {
    user: '"Алексей"',
    warning: 'вынесено предупреждение за нарушение текстовых правил',
    reason: 'нарушение текстовых правил',
  },
};

function resolveBotMessageTemplate(customValue: string, fallbackTemplate: string): string {
  return customValue.trim().length > 0 ? customValue : fallbackTemplate;
}

function renderBotMessageTemplate(template: string, replacements: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.split(`{${key}}`).join(value);
  }
  return rendered.trim();
}

function formatApiError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : '';
  const normalized = rawMessage.toLowerCase();

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

function normalizeDomain(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) {
    return '';
  }

  const withScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const hostname = new URL(withScheme).hostname.toLowerCase();
    return hostname.replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return raw
      .replace(/^[a-z][a-z\d+\-.]*:\/\//i, '')
      .split(/[/?#]/)[0]
      .replace(/:\d+$/, '')
      .replace(/^www\./, '')
      .replace(/\.$/, '');
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

type BotMessageEditorProps = {
  editorKey: BotMessageEditorKey;
  value: string;
  onChange: (value: string) => void;
  onReset: () => void;
};

function BotMessageEditor({ editorKey, value, onChange, onReset }: BotMessageEditorProps) {
  const defaultTemplate = DEFAULT_BOT_MESSAGE_TEMPLATES[editorKey];
  const templateHint = BOT_MESSAGE_TEMPLATE_HINTS[editorKey];
  const previewReplacements = BOT_MESSAGE_PREVIEW_REPLACEMENTS[editorKey];
  const isDefaultTemplate = value.trim().length === 0;
  const editorValue = resolveBotMessageTemplate(value, defaultTemplate);
  const previewText = renderBotMessageTemplate(editorValue, previewReplacements);

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

      <div className="bot-message-editor__preview" aria-live="polite">
        <span className="field__label">Предпросмотр</span>
        <p>{previewText}</p>
      </div>
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
  const previewReplacements = WARN_MESSAGE_PREVIEW_REPLACEMENTS[editorKey];
  const isDefaultTemplate = value.trim().length === 0;
  const editorValue = resolveBotMessageTemplate(value, defaultTemplate);
  const previewText = renderBotMessageTemplate(editorValue, previewReplacements);

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

      <div className="bot-message-editor__preview" aria-live="polite">
        <span className="field__label">Предпросмотр</span>
        <p>{previewText}</p>
      </div>
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [domainInput, setDomainInput] = useState('');
  const [domainInputError, setDomainInputError] = useState('');
  const [blacklistInput, setBlacklistInput] = useState('');
  const [blacklistInputError, setBlacklistInputError] = useState('');
  const [failedSnapshot, setFailedSnapshot] = useState<string>('');
  const [showApplyAllConfirm, setShowApplyAllConfirm] = useState(false);
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const [openBotEditorKey, setOpenBotEditorKey] = useState<BotMessageEditorKey | null>(null);
  const [openWarnEditorKey, setOpenWarnEditorKey] = useState<WarnMessageEditorKey | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<SettingsSectionKey, boolean>>({
    links: true,
    greeting: false,
    textFilters: false,
    duplicates: false,
    limits: false,
    night: false,
    extra: false,
  });

  const routeChatTitle = getRouteChatTitle(location.state);

  useEffect(() => {
    if (chatId) {
      saveLastChatId(chatId);
    }
  }, [chatId]);

  useEffect(() => {
    setShowApplyAllConfirm(false);
  }, [chatId]);

  const settingsQuery = useQuery({
    queryKey: ['settings', chatId],
    queryFn: () => api.getSettings(chatId ?? ''),
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

  const domainsQuery = useQuery({
    queryKey: ['domains', chatId],
    queryFn: () => api.getDomainAllowlist(chatId ?? ''),
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

    const fromList = chatsQuery.data?.find((chat) => chat.id === chatId)?.title?.trim();
    if (fromList) {
      return fromList;
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [chatId, chatsQuery.data, routeChatTitle]);

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
  }, [settingsQuery.data]);

  const draftSnapshot = useMemo(() => (draft ? JSON.stringify(draft) : ''), [draft]);

  const serverSnapshot = useMemo(
    () => (settingsQuery.data ? JSON.stringify(settingsQuery.data) : ''),
    [settingsQuery.data],
  );

  const hasChanges = Boolean(draft && settingsQuery.data && draftSnapshot !== serverSnapshot);

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

  const applyToAllMutation = useMutation({
    mutationFn: (payload: ChatSettings) => api.applySettingsToAllChats(chatId ?? '', payload),
    onSuccess: (result, payload) => {
      setDraft(payload);
      setFieldErrors({});
      setFailedSnapshot('');
      setShowApplyAllConfirm(false);
      queryClient.setQueryData(['settings', chatId], payload);
      pushToast({
        tone: 'success',
        title: 'Настройки применены ко всем чатам',
        description: `Обновлено чатов: ${result.updatedChats}.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить настройки ко всем чатам',
        description: formatApiError(error),
      });
    },
  });
  const isApplyingSettingsToAll = applyToAllMutation.isPending;

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

  function secondsToHours(value: number): number {
    return Math.max(1, Math.round(value / 3600));
  }

  function handleDuplicateWindowHoursChange(key: DuplicateWindowKey, rawValue: string) {
    const hours = Number.parseInt(rawValue, 10);
    const safeHours = Number.isNaN(hours) ? 0 : Math.max(0, hours);
    setFieldValue(key, (safeHours * 3600) as ChatSettings[DuplicateWindowKey]);
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
    if (!chatId || !draft || !hasChanges || isSavingSettings || isApplyingSettingsToAll) {
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
    isApplyingSettingsToAll,
    mutateSettings,
  ]);

  function handleAddDomain() {
    if (!chatId) {
      return;
    }

    const normalized = normalizeDomain(domainInput);
    if (!normalized) {
      setDomainInputError('Введите домен или полную ссылку');
      return;
    }

    if (!DOMAIN_PATTERN.test(normalized)) {
      setDomainInputError('Не удалось распознать домен в ссылке');
      return;
    }

    const alreadyExists = (domainsQuery.data ?? []).includes(normalized);
    if (alreadyExists) {
      setDomainInputError('');
      setDomainInput('');
      pushToast({ title: 'Ссылка уже есть в списке' });
      return;
    }

    setDomainInputError('');
    addDomainMutation.mutate(normalized);
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

  function handleApplySettingsToAllChats() {
    if (!chatId || !draft) {
      return;
    }

    const chatsCount = chatsQuery.data?.length ?? 0;
    if (chatsCount <= 1) {
      pushToast({
        title: 'Нет других чатов для применения',
        description: 'Откройте миниапп в другом чате, чтобы добавить его в список.',
      });
      setShowApplyAllConfirm(false);
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

    applyToAllMutation.mutate(parsed);
  }

  if (!chatId) {
    return (
      <GlassCard>
        <StatusState
          tone="warning"
          title="Чат не выбран"
          description="Откройте экран настроек из карточки чата."
          action={
            <Link to="/" className="button button--accent">
              К списку чатов
            </Link>
          }
        />
      </GlassCard>
    );
  }

  const linkPolicyError = fieldErrors.linkPolicy;
  const allowlistDomains = domainsQuery.data ?? [];
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
  const hasGreetingBotButtonError = Boolean(greetingBotButtonUrlError || greetingBotButtonTextError);
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
  const textFiltersEnabledCount = [
    draft?.russianProfanityFilterEnabled,
    draft?.commercialAdsFilterEnabled,
  ].filter(Boolean).length;
  const textFiltersStagesEnabledCount = [
    draft?.textFiltersBotMessageEnabled,
    draft?.textFiltersWarnEnabled,
    draft?.textFiltersBanEnabled,
    draft?.textFiltersKickEnabled,
  ].filter(Boolean).length;
  const commercialSensitivitySliderValue = draft
    ? inferCommercialSensitivitySliderValue(draft)
    : 50;
  const commercialSensitivityLabel = getCommercialSensitivityLabel(
    commercialSensitivitySliderValue,
  );
  const limitsRulesEnabledCount = [
    draft?.maxMessageLengthEnabled,
    draft?.photoMessageCooldownEnabled,
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
  const textFiltersHeaderSummary = draft
    ? `${textFiltersEnabledCount}/2 фильтра · ${textFiltersStagesEnabledCount}/4 ступени · ${commercialSensitivityLabel.toLowerCase()}`
    : `${textFiltersEnabledCount}/2 фильтра`;
  const extraEnabledCount = [
    draft?.removeBotsFromGroupEnabled,
    draft?.globalUserBlacklistEnabled,
  ].filter(Boolean).length;
  const extraHeaderSummary =
    extraEnabledCount > 0
      ? `${extraEnabledCount} опции · ${globalBlacklistEntries.length} в списке`
      : `${globalBlacklistEntries.length} в списке`;
  const chatsCount = chatsQuery.data?.length ?? 0;
  const canApplyToAllChats = chatsCount > 1;
  const applyAllHint = canApplyToAllChats
    ? `Применим в ${chatsCount} чатах, где у вас и у бота есть админ-права.`
    : 'Пока доступен только этот чат.';

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
              <div className="settings-page-header__identity">
                <p className="settings-page-header__eyebrow">Чат</p>
                <h2 className="settings-page-header__title">{chatTitle || chatId}</h2>
              </div>
              <button
                type="button"
                className="button button--ghost settings-page-header__apply-button"
                onClick={() => setShowApplyAllConfirm((current) => !current)}
                disabled={!canApplyToAllChats || isApplyingSettingsToAll}
                aria-expanded={showApplyAllConfirm}
                aria-controls="apply-settings-all-confirm"
              >
                {isApplyingSettingsToAll ? 'Применяем...' : 'Применить ко всем чатам'}
              </button>
            </div>
            <p className="settings-page-header__hint">{applyAllHint}</p>

            {showApplyAllConfirm ? (
              <div
                id="apply-settings-all-confirm"
                className="settings-page-header__confirm"
                role="group"
                aria-label="Подтверждение применения настроек ко всем чатам"
              >
                <p className="settings-page-header__confirm-title">
                  Применить текущие настройки ко всем чатам?
                </p>
                <p className="settings-page-header__confirm-description">
                  Будет скопирована текущая конфигурация этого чата.
                </p>
                <div className="settings-page-header__confirm-actions">
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setShowApplyAllConfirm(false)}
                    disabled={isApplyingSettingsToAll}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="button button--accent"
                    onClick={handleApplySettingsToAllChats}
                    disabled={isApplyingSettingsToAll}
                  >
                    Применить сейчас
                  </button>
                </div>
              </div>
            ) : null}
          </header>

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
                            Можно вставить полный URL, сохраним домен автоматически.
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
                              disabled={
                                addDomainMutation.isPending || removeDomainMutation.isPending
                              }
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
                            allowlistDomains.length > 0 ? (
                              <ul className="allowlist-list" aria-label="Разрешенные ссылки">
                                {allowlistDomains.map((domain) => (
                                  <li key={domain} className="allowlist-item">
                                    <span className="allowlist-item__domain">{domain}</span>
                                    <button
                                      type="button"
                                      className="allowlist-item__remove"
                                      onClick={() => removeDomainMutation.mutate(domain)}
                                      disabled={
                                        removeDomainMutation.isPending ||
                                        addDomainMutation.isPending
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
                      </div>
                    </div>
                  ) : null}

                  {shouldShowLinkStages ? (
                    <>
                      <div
                        className="settings-subsection-divider"
                        role="separator"
                        aria-label="Блок сообщений бота"
                      >
                        <span>Сообщения бота</span>
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
                            <span className="settings-native-toggle__title">2. Предупреждение</span>
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
                              onChange={(event) =>
                                setFieldValue('linkWarnEnabled', event.target.checked)
                              }
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
                              onChange={(event) =>
                                setFieldValue('linkBanEnabled', event.target.checked)
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
                            4. Удаление из группы
                          </span>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить удаление из группы за четвертую ссылку в 24 часа"
                          >
                            <input
                              type="checkbox"
                              checked={draft.linkKickEnabled}
                              onChange={(event) =>
                                setFieldValue('linkKickEnabled', event.target.checked)
                              }
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
                              <span className="settings-native-toggle__title">Добавить кнопку</span>
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
              </div>
            </div>
          </GlassCard>

          <GlassCard
            className="settings-section stagger-in"
            style={{ animationDelay: '45ms' }}
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
                        className={cn('settings-info-button', openHintKey === 'greetingEnabled' && 'is-open')}
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
                        <p id="greeting-bot-message-hint" className="settings-native-toggle__hint">
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
                                <small className="field__hint">{greetingBotButtonTextError}</small>
                              ) : null}
                            </label>
                          </div>
                        ) : null}

                        {!hasGreetingBotButtonError && openHintKey === 'greetingBotButton' ? (
                          <p id="greeting-bot-button-hint" className="settings-native-toggle__hint">
                            Добавляет кнопку в приветствие, например на правила чата.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          </GlassCard>

          <GlassCard
            className="settings-section stagger-in"
            style={{ animationDelay: '90ms' }}
            aria-label="Фильтрация текста"
          >
            <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
              <button
                type="button"
                className="settings-section__toggle"
                aria-expanded={expandedSections.textFilters}
                aria-controls="settings-text-filters-content"
                onClick={() => toggleSection('textFilters')}
              >
                <span className="settings-section__toggle-main">
                  <h3>Фильтрация текста</h3>
                  <small>{textFiltersHeaderSummary}</small>
                </span>
                <SectionChevron isOpen={expandedSections.textFilters} />
              </button>
            </div>

            <div
              id="settings-text-filters-content"
              className={cn(
                'settings-section__collapse',
                expandedSections.textFilters && 'is-open',
              )}
            >
              <div className="settings-section__collapse-inner">
                <div className="text-filters-grid">
                  {TEXT_FILTER_OPTIONS.map((option) => {
                    const hintKey: HintKey =
                      option.key === 'russianProfanityFilterEnabled'
                        ? 'textFiltersProfanity'
                        : 'textFiltersCommercial';
                    const hintId = `${option.key}-hint`;

                    return (
                      <div key={option.key} className="settings-native-toggle text-filter-card">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">{option.title}</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === hintKey && 'is-open',
                              )}
                              aria-label={`Пояснение для "${option.title}"`}
                              aria-controls={hintId}
                              aria-expanded={openHintKey === hintKey}
                              onClick={() => toggleHint(hintKey)}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label className="settings-native-switch" aria-label={option.title}>
                            <input
                              type="checkbox"
                              checked={draft[option.key]}
                              onChange={(event) => setFieldValue(option.key, event.target.checked)}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === hintKey ? (
                          <p id={hintId} className="settings-native-toggle__hint">
                            {option.description}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

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
                    <p id="commercial-sensitivity-hint" className="settings-native-toggle__hint">
                      Ползунок меняет строгость фильтра и автоматически подбирает внутренние пороги.
                    </p>
                  ) : null}
                </div>

                <div
                  className="settings-subsection-divider"
                  role="separator"
                  aria-label="Сообщения бота для фильтрации текста"
                >
                  <span>Сообщения бота</span>
                </div>

                <div className="settings-native-toggle">
                  <div className="settings-native-toggle__row">
                    <div className="settings-native-toggle__title-wrap">
                      <span className="settings-native-toggle__title">1. Объяснение</span>
                      <div className="settings-native-toggle__title-actions">
                        <EditToggleButton
                          label="Редактировать текст сообщения фильтрации текста"
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
                          aria-label="Пояснение для тумблера сообщений о фильтрации текста"
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
                      aria-label="Включить сообщение от бота для фильтрации текста"
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
                    <p id="text-filters-bot-message-hint" className="settings-native-toggle__hint">
                      Санкции усиливаются по ступеням, если пользователь повторно нарушает текстовый
                      фильтр в течение 24 часов.
                    </p>
                  ) : null}

                  {draft.textFiltersBotMessageEnabled && openBotEditorKey === 'textFilters' ? (
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
                          label="Редактировать текст предупреждения текстового фильтра"
                          onClick={() => toggleWarnMessageEditor('textFiltersWarn')}
                          isOpen={openWarnEditorKey === 'textFiltersWarn'}
                        />
                        <button
                          type="button"
                          className={cn(
                            'settings-info-button',
                            openHintKey === 'textFiltersWarnMessage' && 'is-open',
                          )}
                          aria-label="Пояснение для предупреждения текстового фильтра"
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
                      aria-label="Включить предупреждение за второе нарушение текстового фильтра"
                    >
                      <input
                        type="checkbox"
                        checked={draft.textFiltersWarnEnabled}
                        onChange={(event) =>
                          setFieldValue('textFiltersWarnEnabled', event.target.checked)
                        }
                      />
                      <span className="toggle-switch" aria-hidden>
                        <span className="toggle-switch__thumb" />
                      </span>
                    </label>
                  </div>

                  {openHintKey === 'textFiltersWarnMessage' ? (
                    <p id="text-filters-warn-message-hint" className="settings-native-toggle__hint">
                      Текст отправляется при 2-м нарушении текстового фильтра за 24 часа.
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
                      aria-label="Включить бан на шесть часов за третье нарушение текстового фильтра"
                    >
                      <input
                        type="checkbox"
                        checked={draft.textFiltersBanEnabled}
                        onChange={(event) =>
                          setFieldValue('textFiltersBanEnabled', event.target.checked)
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
                    <span className="settings-native-toggle__title">4. Удаление из группы</span>

                    <label
                      className="settings-native-switch"
                      aria-label="Включить удаление из группы за четвертое нарушение текстового фильтра"
                    >
                      <input
                        type="checkbox"
                        checked={draft.textFiltersKickEnabled}
                        onChange={(event) =>
                          setFieldValue('textFiltersKickEnabled', event.target.checked)
                        }
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
                          aria-label="Пояснение для кнопки в сообщении фильтрации текста"
                          aria-controls="text-filters-bot-button-hint"
                          aria-expanded={openHintKey === 'textFiltersBotButton'}
                          onClick={() => toggleHint('textFiltersBotButton')}
                        >
                          <span aria-hidden>i</span>
                        </button>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Добавить кнопку в сообщение бота для фильтрации текста"
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
                            <small className="field__hint">{textFiltersBotButtonUrlError}</small>
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
                            <small className="field__hint">{textFiltersBotButtonTextError}</small>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    {!hasTextFiltersBotButtonError && openHintKey === 'textFiltersBotButton' ? (
                      <p id="text-filters-bot-button-hint" className="settings-native-toggle__hint">
                        Добавляет кнопку в сообщение бота о фильтрации текста.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </GlassCard>

          <GlassCard
            className="settings-section stagger-in"
            style={{ animationDelay: '135ms' }}
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
                  <small>{duplicateStagesEnabledCount}/3 ступени включено</small>
                </span>
                <SectionChevron isOpen={expandedSections.duplicates} />
              </button>
            </div>

            <div
              id="settings-duplicates-content"
              className={cn('settings-section__collapse', expandedSections.duplicates && 'is-open')}
            >
              <div className="settings-section__collapse-inner">
                {draft.duplicateBanEnabled ? (
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

                <div className="duplicate-stage-list">
                  <p className="duplicate-stage-list__caption">Количество дублей</p>

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
                              onChange={(event) =>
                                setFieldValue(
                                  stage.enabledKey,
                                  event.target.checked as ChatSettings[DuplicateEnabledKey],
                                )
                              }
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                            <span className="duplicate-stage__title">{stage.label}</span>
                          </label>
                        </div>

                        <div className="duplicate-stage__controls">
                          <label
                            className={cn('duplicate-stage__field', windowError && 'field--error')}
                          >
                            <span className="duplicate-stage__field-label">Окно, ч</span>
                            <div className="duplicate-stage__input-wrap">
                              <input
                                type="number"
                                min={1}
                                max={168}
                                step={1}
                                value={secondsToHours(Number(windowSec))}
                                onChange={(event) =>
                                  handleDuplicateWindowHoursChange(
                                    stage.windowKey,
                                    event.target.value,
                                  )
                                }
                                disabled={!enabled}
                                aria-label={`Окно для ступени ${stage.label} в часах`}
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
                            <span className="duplicate-stage__field-label">Количество дублей</span>
                            <div
                              className="duplicate-count-stepper"
                              role="group"
                              aria-label={`Количество дублей для ступени ${stage.label}`}
                            >
                              <button
                                type="button"
                                className="duplicate-count-stepper__button"
                                onClick={() =>
                                  adjustDuplicateMaxCount(stage.maxCountKey, Number(maxCount), -1)
                                }
                                disabled={!enabled || Number(maxCount) <= DUPLICATE_COUNT_MIN}
                                aria-label={`Уменьшить количество дублей для ${stage.label}`}
                              >
                                -
                              </button>

                              <output className="duplicate-count-stepper__value" aria-live="polite">
                                {Number(maxCount)}
                              </output>

                              <button
                                type="button"
                                className="duplicate-count-stepper__button"
                                onClick={() =>
                                  adjustDuplicateMaxCount(stage.maxCountKey, Number(maxCount), 1)
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

                <div
                  className="settings-subsection-divider"
                  role="separator"
                  aria-label="Блок сообщений бота"
                >
                  <span>Сообщения бота</span>
                </div>

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

                {draft.duplicateBotMessageEnabled ? (
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
              </div>
            </div>
          </GlassCard>

          <GlassCard
            className="settings-section stagger-in"
            style={{ animationDelay: '180ms' }}
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
                        onChange={(event) =>
                          setFieldValue('maxMessageLengthEnabled', event.target.checked)
                        }
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
                        onChange={(event) =>
                          setFieldValue('photoMessageCooldownEnabled', event.target.checked)
                        }
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
                            Number(event.target.value) as ChatSettings['photoMessageCooldownHours'],
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

                <div className="settings-native-toggle">
                  <div className="settings-native-toggle__row">
                    <span className="settings-native-toggle__title">Разрешить видео</span>

                    <label className="settings-native-switch" aria-label="Разрешить отправку видео">
                      <input
                        type="checkbox"
                        checked={draft.videoMessagesEnabled}
                        onChange={(event) =>
                          setFieldValue('videoMessagesEnabled', event.target.checked)
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
                    <span className="settings-native-toggle__title">Разрешить файлы</span>

                    <label
                      className="settings-native-switch"
                      aria-label="Разрешить отправку файлов"
                    >
                      <input
                        type="checkbox"
                        checked={draft.fileMessagesEnabled}
                        onChange={(event) =>
                          setFieldValue('fileMessagesEnabled', event.target.checked)
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
                    <span className="settings-native-toggle__title">Разрешить голосовые</span>

                    <label
                      className="settings-native-switch"
                      aria-label="Разрешить отправку голосовых"
                    >
                      <input
                        type="checkbox"
                        checked={draft.voiceMessagesEnabled}
                        onChange={(event) =>
                          setFieldValue('voiceMessagesEnabled', event.target.checked)
                        }
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
                  aria-label="Блок сообщений бота"
                >
                  <span>Сообщения бота</span>
                </div>

                <div className="settings-native-toggle">
                  <div className="settings-native-toggle__row">
                    <div className="settings-native-toggle__title-wrap">
                      <span className="settings-native-toggle__title">Сообщение от бота</span>
                      <div className="settings-native-toggle__title-actions">
                        <EditToggleButton
                          label="Редактировать текст сообщения ограничений"
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
                    </p>
                  ) : null}

                  {draft.messageLimitsBotMessageEnabled && openBotEditorKey === 'messageLimits' ? (
                    <BotMessageEditor
                      editorKey="messageLimits"
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
                            <small className="field__hint">{messageLimitsBotButtonUrlError}</small>
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
                            <small className="field__hint">{messageLimitsBotButtonTextError}</small>
                          ) : null}
                        </label>
                      </div>
                    ) : null}

                    {!hasMessageLimitsBotButtonError && openHintKey === 'messageLimitsBotButton' ? (
                      <p
                        id="message-limits-bot-button-hint"
                        className="settings-native-toggle__hint"
                      >
                        Добавляет кнопку в сообщение бота с переходом на чат, канал или профиль.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </GlassCard>

          <GlassCard
            className="settings-section stagger-in"
            style={{ animationDelay: '225ms' }}
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
                        onChange={(event) =>
                          setFieldValue('nightModeEnabled', event.target.checked)
                        }
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
                        onChange={(event) => setFieldValue('nightModeTimezone', event.target.value)}
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

                <div
                  className="settings-subsection-divider"
                  role="separator"
                  aria-label="Блок сообщений бота для ночного режима"
                >
                  <span>Сообщения бота</span>
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
              </div>
            </div>
          </GlassCard>

          <GlassCard
            className="settings-section stagger-in"
            style={{ animationDelay: '270ms' }}
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
                      <span className="settings-native-toggle__title">Удалять ботов из группы</span>
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
              </div>
            </div>
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
