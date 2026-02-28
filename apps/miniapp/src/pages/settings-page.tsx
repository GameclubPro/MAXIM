import { chatSettingsSchema, type ChatSettings } from '@maxim/contracts';
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

const DOMAIN_PATTERN = /^(?=.{3,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;
const AUTO_SAVE_DELAY_MS = 650;
const BAN_DURATION_MIN_HOURS = 1;
const BAN_DURATION_MAX_HOURS = 36;
const DUPLICATE_COUNT_MIN = 2;
const DUPLICATE_COUNT_MAX = 20;

type DuplicateEnabledKey = 'duplicateWarnEnabled' | 'duplicateKickEnabled' | 'duplicateBanEnabled';
type DuplicateWindowKey =
  | 'duplicateWarnWindowSec'
  | 'duplicateKickWindowSec'
  | 'duplicateBanWindowSec';
type DuplicateMaxCountKey =
  | 'duplicateWarnMaxCount'
  | 'duplicateKickMaxCount'
  | 'duplicateBanMaxCount';
type BotHintKey = 'link' | 'duplicate';

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
    id: 'KICK',
    label: 'Удаление участника',
    enabledKey: 'duplicateKickEnabled',
    windowKey: 'duplicateKickWindowSec',
    maxCountKey: 'duplicateKickMaxCount',
  },
  {
    id: 'BAN',
    label: 'Бан',
    enabledKey: 'duplicateBanEnabled',
    windowKey: 'duplicateBanWindowSec',
    maxCountKey: 'duplicateBanMaxCount',
  },
];

const LINK_POLICY_OPTIONS: Array<{
  value: ChatSettings['linkPolicy'];
  label: string;
  description: string;
}> = [
  { value: 'ALERT_ONLY', label: 'Только предупреждать', description: 'Сообщение не удаляется.' },
  {
    value: 'ALLOWLIST_ONLY',
    label: 'Удалять кроме allowlist',
    description: 'Работает по списку разрешенных доменов.',
  },
  {
    value: 'BLOCKLIST_ONLY',
    label: 'Удалять все ссылки',
    description: 'Любая ссылка удаляется сразу.',
  },
];

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
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0] ?? ''
  );
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
  const [failedSnapshot, setFailedSnapshot] = useState<string>('');
  const [openHintKey, setOpenHintKey] = useState<BotHintKey | null>(null);

  const routeChatTitle = getRouteChatTitle(location.state);

  useEffect(() => {
    if (chatId) {
      saveLastChatId(chatId);
    }
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

  const addDomainMutation = useMutation({
    mutationFn: (domain: string) => api.addDomain(chatId ?? '', domain),
    onSuccess: () => {
      setDomainInput('');
      setDomainInputError('');
      void queryClient.invalidateQueries({ queryKey: ['domains', chatId] });
      pushToast({ tone: 'success', title: 'Домен добавлен в разрешенные' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось добавить домен',
        description: formatApiError(error),
      });
    },
  });

  const removeDomainMutation = useMutation({
    mutationFn: (domain: string) => api.removeDomain(chatId ?? '', domain),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['domains', chatId] });
      pushToast({ tone: 'success', title: 'Домен удален из разрешенных' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить домен',
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

  function adjustDuplicateMaxCount(
    key: DuplicateMaxCountKey,
    currentValue: number,
    delta: number,
  ) {
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
    if (!chatId || !draft || !hasChanges || isSavingSettings) {
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
  }, [chatId, draft, draftSnapshot, failedSnapshot, hasChanges, isSavingSettings, mutateSettings]);

  function handleAddDomain() {
    if (!chatId) {
      return;
    }

    const normalized = normalizeDomain(domainInput);
    if (!normalized) {
      setDomainInputError('Введите домен, например example.com');
      return;
    }

    if (!DOMAIN_PATTERN.test(normalized)) {
      setDomainInputError('Неверный формат домена');
      return;
    }

    const alreadyExists = (domainsQuery.data ?? []).includes(normalized);
    if (alreadyExists) {
      setDomainInputError('');
      setDomainInput('');
      pushToast({ title: 'Домен уже есть в списке' });
      return;
    }

    setDomainInputError('');
    addDomainMutation.mutate(normalized);
  }

  function toggleHint(key: BotHintKey) {
    setOpenHintKey((current) => (current === key ? null : key));
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
  const isAllowlistMode = draft?.linkPolicy === 'ALLOWLIST_ONLY';

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
          <GlassCard className="settings-section stagger-in">
            <div className="settings-section__head">
              <h3>Модерация ссылок</h3>
              <span className="settings-section__chat-chip">{chatTitle || chatId}</span>
            </div>

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
                        className={cn('policy-card', isActive && 'is-active')}
                        onClick={() => setFieldValue('linkPolicy', option.value)}
                      >
                        <span>{option.label}</span>
                        <small>{option.description}</small>
                      </button>
                    );
                  })}
                </div>
                {linkPolicyError ? <small className="field__hint">{linkPolicyError}</small> : null}
              </div>

              <div className="settings-native-toggle">
                <div className="settings-native-toggle__row">
                  <div className="settings-native-toggle__title-wrap">
                    <span className="settings-native-toggle__title">Сообщение от бота</span>
                    <button
                      type="button"
                      className={cn('settings-info-button', openHintKey === 'link' && 'is-open')}
                      aria-label="Пояснение для тумблера сообщений о ссылках"
                      aria-controls="link-bot-message-hint"
                      aria-expanded={openHintKey === 'link'}
                      onClick={() => toggleHint('link')}
                    >
                      <span aria-hidden>i</span>
                    </button>
                  </div>

                  <label
                    className="settings-native-switch"
                    aria-label="Включить сообщение от бота для модерации ссылок"
                  >
                    <input
                      type="checkbox"
                      checked={draft.linkBotMessageEnabled}
                      onChange={(event) =>
                        setFieldValue('linkBotMessageEnabled', event.target.checked)
                      }
                    />
                    <span className="toggle-switch" aria-hidden>
                      <span className="toggle-switch__thumb" />
                    </span>
                  </label>
                </div>

                {openHintKey === 'link' ? (
                  <p id="link-bot-message-hint" className="settings-native-toggle__hint">
                    После удаления ссылки бот отправляет короткое пояснение в чат.
                  </p>
                ) : null}
              </div>

              {isAllowlistMode ? (
                <div
                  className={cn(
                    'field',
                    'allowlist-panel',
                    domainInputError && 'allowlist-panel--error',
                  )}
                >
                  <div className="allowlist-panel__head">
                    <span className="field__label">Allowlist доменов</span>
                    <span className="chip">{allowlistDomains.length}</span>
                  </div>
                  <div className="allowlist-add-row">
                    <input
                      type="text"
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
                      placeholder="example.com"
                    />
                    <button
                      type="button"
                      className="button button--accent allowlist-add-row__button"
                      onClick={handleAddDomain}
                      disabled={addDomainMutation.isPending || removeDomainMutation.isPending}
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
                      <ul className="allowlist-list" aria-label="Разрешенные домены">
                        {allowlistDomains.map((domain) => (
                          <li key={domain} className="allowlist-item">
                            <span className="allowlist-item__domain">{domain}</span>
                            <button
                              type="button"
                              className="allowlist-item__remove"
                              onClick={() => removeDomainMutation.mutate(domain)}
                              disabled={
                                removeDomainMutation.isPending || addDomainMutation.isPending
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
          </GlassCard>

          <GlassCard
            className="settings-section stagger-in"
            style={{ animationDelay: '45ms' }}
            aria-label="Настройки дублей"
          >
            <div className="settings-section__head">
              <h3>Дубли сообщений</h3>
            </div>

            <div className="settings-native-toggle">
              <div className="settings-native-toggle__row">
                <div className="settings-native-toggle__title-wrap">
                  <span className="settings-native-toggle__title">Сообщение от бота</span>
                  <button
                    type="button"
                    className={cn('settings-info-button', openHintKey === 'duplicate' && 'is-open')}
                    aria-label="Пояснение для тумблера сообщений о дублях"
                    aria-controls="duplicate-bot-message-hint"
                    aria-expanded={openHintKey === 'duplicate'}
                    onClick={() => toggleHint('duplicate')}
                  >
                    <span aria-hidden>i</span>
                  </button>
                </div>

                <label
                  className="settings-native-switch"
                  aria-label="Включить сообщение от бота для дублей сообщений"
                >
                  <input
                    type="checkbox"
                    checked={draft.duplicateBotMessageEnabled}
                    onChange={(event) =>
                      setFieldValue('duplicateBotMessageEnabled', event.target.checked)
                    }
                  />
                  <span className="toggle-switch" aria-hidden>
                    <span className="toggle-switch__thumb" />
                  </span>
                </label>
              </div>

              {openHintKey === 'duplicate' ? (
                <p id="duplicate-bot-message-hint" className="settings-native-toggle__hint">
                  При срабатывании правила дублей бот публикует поясняющее сообщение.
                </p>
              ) : null}
            </div>

            <div className={cn('settings-native-toggle', fieldErrors.banDurationHours && 'field--error')}>
              <div className="settings-native-toggle__row">
                <span className="settings-native-toggle__title">Длительность бана</span>

                <div className="ban-duration-stepper" role="group" aria-label="Длительность бана в часах">
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

              <p className="settings-native-toggle__hint">
                После выдачи бана сообщения пользователя удаляются автоматически в течение этого
                времени.
              </p>

              {fieldErrors.banDurationHours ? (
                <small className="field__hint">{fieldErrors.banDurationHours}</small>
              ) : null}
            </div>

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
                      <label className={cn('duplicate-stage__field', windowError && 'field--error')}>
                        <span className="duplicate-stage__field-label">Окно, ч</span>
                        <div className="duplicate-stage__input-wrap">
                          <input
                            type="number"
                            min={1}
                            max={168}
                            step={1}
                            value={secondsToHours(Number(windowSec))}
                            onChange={(event) =>
                              handleDuplicateWindowHoursChange(stage.windowKey, event.target.value)
                            }
                            disabled={!enabled}
                            aria-label={`Окно для ступени ${stage.label} в часах`}
                          />
                          <span className="duplicate-stage__suffix" aria-hidden>
                            часы
                          </span>
                        </div>
                      </label>

                      <div className={cn('duplicate-stage__field', maxCountError && 'field--error')}>
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
                        {windowError ? <small className="field__hint">{windowError}</small> : null}
                        {maxCountError ? (
                          <small className="field__hint">{maxCountError}</small>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
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
