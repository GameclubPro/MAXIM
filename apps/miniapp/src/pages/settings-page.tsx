import { chatSettingsSchema, type ChatSettings } from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { PageHeader } from '../components/ui/page-header';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { saveLastChatId } from '../lib/last-chat';
import { settingsFieldConfig, settingsSections } from './settings-field-config';

type FieldErrors = Partial<Record<keyof ChatSettings, string>>;

export function SettingsPage({ api }: { api: ApiClient }) {
  const { chatId } = useParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draft, setDraft] = useState<ChatSettings | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

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
    pushToast({ title: 'Изменения сброшены' });
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

  return (
    <div className="page-stack page-enter">
      <GlassCard className="hero-card" elevated>
        <PageHeader
          title="Настройки"
          subtitle="Управляйте модерацией по всем правилам чата."
          badge={`Чат: ${chatId}`}
        />
      </GlassCard>

      {settingsQuery.isLoading ? (
        <section className="settings-sections" aria-label="Загрузка настроек">
          {Array.from({ length: 3 }).map((_, index) => (
            <GlassCard key={index} className="settings-section">
              <SkeletonCard lines={4} />
            </GlassCard>
          ))}
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
        <section className="settings-sections" aria-label="Настройки модерации">
          {settingsSections.map((section, index) => {
            const sectionFields = settingsFieldConfig.filter((field) => field.section === section.id);

            return (
              <GlassCard
                key={section.id}
                className="settings-section stagger-in"
                style={{ animationDelay: `${index * 45}ms` }}
              >
                <div className="settings-section__head">
                  <h3>{section.title}</h3>
                  <p>{section.description}</p>
                </div>

                <div className="settings-grid">
                  {sectionFields.map((field) => {
                    const error = fieldErrors[field.key];

                    return (
                      <label key={field.key} className={cn('field', error && 'field--error')}>
                        <span className="field__label">{field.label}</span>

                        {field.input === 'select' ? (
                          <select
                            value={draft[field.key] as string}
                            onChange={(event) =>
                              setFieldValue(field.key, event.target.value as ChatSettings[typeof field.key])
                            }
                          >
                            {field.options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div className="field__number-wrap">
                            <input
                              type="number"
                              min={field.min}
                              max={field.max}
                              step={field.step ?? 1}
                              value={String(draft[field.key])}
                              onChange={(event) => {
                                const value = Number(event.target.value);
                                if (Number.isNaN(value)) {
                                  return;
                                }
                                setFieldValue(field.key, value as ChatSettings[typeof field.key]);
                              }}
                            />
                            {field.unit ? <small>{field.unit}</small> : null}
                          </div>
                        )}

                        <small className="field__hint">{error ?? field.hint}</small>
                      </label>
                    );
                  })}
                </div>
              </GlassCard>
            );
          })}
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
