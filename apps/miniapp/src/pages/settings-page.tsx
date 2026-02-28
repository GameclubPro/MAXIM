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

const LINK_POLICY_OPTIONS: Array<{ value: ChatSettings['linkPolicy']; label: string }> = [
  { value: 'ALERT_ONLY', label: 'Только предупреждать' },
  { value: 'ALLOWLIST_ONLY', label: 'Удалять, кроме разрешенных' },
  { value: 'BLOCKLIST_ONLY', label: 'Удалять все ссылки' },
];

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
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

  const hasChanges = useMemo(() => {
    if (!draft || !settingsQuery.data) {
      return false;
    }

    return JSON.stringify(draft) !== JSON.stringify(settingsQuery.data);
  }, [draft, settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: ChatSettings) => api.updateSettings(chatId ?? '', payload),
    onSuccess: (saved) => {
      setDraft(saved);
      setFieldErrors({});
      queryClient.setQueryData(['settings', chatId], saved);
      pushToast({ tone: 'success', title: 'Настройки сохранены' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Сохранение не удалось',
        description: (error as Error).message,
      });
    },
  });

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
        description: (error as Error).message,
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
        description: (error as Error).message,
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

  function handleSave() {
    if (!draft) {
      return;
    }

    const parsed = validateDraft(draft);
    if (!parsed) {
      pushToast({
        tone: 'danger',
        title: 'Проверьте поля формы',
        description: 'В некоторых настройках есть ошибки валидации.',
      });
      return;
    }

    saveMutation.mutate(parsed);
  }

  function handleReset() {
    if (!settingsQuery.data) {
      return;
    }

    setDraft(settingsQuery.data);
    setFieldErrors({});
    setDomainInput('');
    setDomainInputError('');
    pushToast({ title: 'Изменения сброшены' });
  }

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
            description={(settingsQuery.error as Error).message}
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
        <section className="settings-sections" aria-label="Настройки модерации ссылок">
          <GlassCard className="settings-section stagger-in">
            <div className="settings-section__head">
              <h3>Ссылки</h3>
              <p>{chatTitle ? `Чат: ${chatTitle}` : 'Название чата загружается...'}</p>
            </div>

            <div className="settings-grid settings-grid--single">
              <label className={cn('field', linkPolicyError && 'field--error')}>
                <span className="field__label">Политика ссылок</span>
                <select
                  value={draft.linkPolicy}
                  onChange={(event) =>
                    setFieldValue('linkPolicy', event.target.value as ChatSettings['linkPolicy'])
                  }
                >
                  {LINK_POLICY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <small className="field__hint">
                  {linkPolicyError ?? 'Выберите, как бот должен обрабатывать сообщения со ссылками.'}
                </small>
              </label>

              {isAllowlistMode ? (
                <div className={cn('field', domainInputError && 'field--error')}>
                  <span className="field__label">Разрешенные домены</span>
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
                      className="button button--ghost allowlist-add-row__button"
                      onClick={handleAddDomain}
                      disabled={addDomainMutation.isPending || removeDomainMutation.isPending}
                    >
                      {addDomainMutation.isPending ? 'Добавляем...' : 'Добавить'}
                    </button>
                  </div>
                  <small className="field__hint">
                    {domainInputError || 'Указывайте домены без http:// и без пути. Пример: docs.max.ru'}
                  </small>

                  {domainsQuery.isLoading ? (
                    <p className="allowlist-empty">Загружаю список разрешённых доменов...</p>
                  ) : null}

                  {domainsQuery.error ? (
                    <p className="allowlist-empty allowlist-empty--error">
                      Не удалось загрузить allowlist: {(domainsQuery.error as Error).message}
                    </p>
                  ) : null}

                  {!domainsQuery.isLoading && !domainsQuery.error ? (
                    allowlistDomains.length > 0 ? (
                      <ul className="allowlist-list" aria-label="Разрешенные домены">
                        {allowlistDomains.map((domain) => (
                          <li key={domain} className="allowlist-item">
                            <span>{domain}</span>
                            <button
                              type="button"
                              className="allowlist-item__remove"
                              onClick={() => removeDomainMutation.mutate(domain)}
                              disabled={removeDomainMutation.isPending || addDomainMutation.isPending}
                            >
                              Удалить
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="allowlist-empty">
                        Список пуст. Все ссылки будут удаляться, пока не добавите разрешенные домены.
                      </p>
                    )
                  ) : null}
                </div>
              ) : null}
            </div>
          </GlassCard>
        </section>
      ) : null}

      {!settingsQuery.isLoading && !settingsQuery.error && !draft ? (
        <GlassCard>
          <StatusState tone="warning" title="Настройки не найдены" description="Повторите загрузку страницы." />
        </GlassCard>
      ) : null}

      {!settingsQuery.isLoading && !settingsQuery.error && draft ? (
        <div className="settings-action-bar glass-card glass-card--sm">
          <div className="settings-action-bar__info">
            <span className={cn('chip', hasChanges ? 'chip--warning' : 'chip--success')}>
              {hasChanges ? 'Есть несохраненные изменения' : 'Все изменения сохранены'}
            </span>
          </div>
          <div className="settings-action-bar__buttons">
            <button
              type="button"
              className="button button--ghost"
              onClick={handleReset}
              disabled={!hasChanges || saveMutation.isPending}
            >
              Сбросить
            </button>
            <button
              type="button"
              className="button button--accent"
              onClick={handleSave}
              disabled={!hasChanges || saveMutation.isPending}
            >
              {saveMutation.isPending ? 'Сохраняем...' : 'Сохранить'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
