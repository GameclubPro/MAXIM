import {
  MANAGED_POLL_MAX_OPTIONS,
  MANAGED_POLL_MIN_OPTIONS,
  MANAGED_POLL_OPTION_MAX_LENGTH,
  MANAGED_POLL_QUESTION_MAX_LENGTH,
  type ManagedPoll,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { GlassCard } from './ui/glass-card';
import { useToast } from './ui/toast';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';

const AUTOSAVE_DELAY_MS = 650;
const AUTOSAVE_SAVED_HIDE_MS = 1600;

type ManagedPollDraft = {
  question: string;
  options: string[];
};

type ManagedPollHintKey = 'rules' | 'publish';

function toDraft(poll: ManagedPoll): ManagedPollDraft {
  const options = poll.options.slice(0, MANAGED_POLL_MAX_OPTIONS);
  while (options.length < MANAGED_POLL_MIN_OPTIONS) {
    options.push('');
  }

  return {
    question: poll.question,
    options,
  };
}

function normalizeDraft(draft: ManagedPollDraft): ManagedPollDraft {
  const options = draft.options.slice(0, MANAGED_POLL_MAX_OPTIONS);
  while (options.length < MANAGED_POLL_MIN_OPTIONS) {
    options.push('');
  }

  return {
    question: draft.question,
    options,
  };
}

function formatManagedPollError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось выполнить действие.';
  }

  const text = error.message.trim();
  if (!text) {
    return 'Не удалось выполнить действие.';
  }

  if (text.startsWith('API request failed:')) {
    const details = text.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось выполнить действие.';
  }

  return text;
}

function normalizeOptionKey(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase().replace(/ё/gu, 'е');
}

function buildStatusLabel(status: ManagedPoll['status']): string {
  if (status === 'ACTIVE') {
    return 'Активен';
  }
  if (status === 'CLOSED') {
    return 'Закрыт';
  }
  return 'Черновик';
}

function buildStatusTone(status: ManagedPoll['status']): 'success' | 'warning' | undefined {
  if (status === 'ACTIVE') {
    return 'success';
  }
  if (status === 'DRAFT') {
    return 'warning';
  }
  return undefined;
}

function ManagedPollInfoButton({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
}: {
  hintKey: ManagedPollHintKey;
  openHintKey: ManagedPollHintKey | null;
  onToggleHint: (hintKey: ManagedPollHintKey) => void;
  label: string;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <button
      type="button"
      className={cn('settings-info-button', isOpen && 'is-open')}
      aria-label={label}
      aria-controls={`managed-poll-hint-${hintKey}`}
      aria-expanded={isOpen}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggleHint(hintKey);
      }}
    >
      <span aria-hidden>i</span>
    </button>
  );
}

function ManagedPollHintAnchor({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
  children,
}: {
  hintKey: ManagedPollHintKey;
  openHintKey: ManagedPollHintKey | null;
  onToggleHint: (hintKey: ManagedPollHintKey) => void;
  label: string;
  children: string;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <span className="channel-settings-hint-anchor">
      <ManagedPollInfoButton
        hintKey={hintKey}
        openHintKey={openHintKey}
        onToggleHint={onToggleHint}
        label={label}
      />
      {isOpen ? (
        <span id={`managed-poll-hint-${hintKey}`} className="channel-settings-hint-popover">
          {children}
        </span>
      ) : null}
    </span>
  );
}

export function ManagedPollCard({
  api,
  entityType,
  entityId,
}: {
  api: ApiClient;
  entityType: 'chat' | 'channel';
  entityId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draft, setDraft] = useState<ManagedPollDraft | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ManagedPollDraft | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [questionError, setQuestionError] = useState('');
  const [optionError, setOptionError] = useState('');
  const [openHintKey, setOpenHintKey] = useState<ManagedPollHintKey | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveHideTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef<Promise<ManagedPoll> | null>(null);
  const latestDraftRef = useRef<ManagedPollDraft | null>(null);
  const latestDraftKeyRef = useRef('');
  const lastFailedDraftKeyRef = useRef<string | null>(null);
  const isDirtyRef = useRef(false);

  const queryKey = useMemo(
    () => ['managed-poll', entityType, entityId] as const,
    [entityId, entityType],
  );

  const pollQuery = useQuery({
    queryKey,
    queryFn: () =>
      entityType === 'channel' ? api.getChannelPoll(entityId) : api.getChatPoll(entityId),
    enabled: Boolean(entityId),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!pollQuery.data) {
      return;
    }

    const nextDraft = toDraft(pollQuery.data);
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setSaveState('idle');
    setQuestionError('');
    setOptionError('');
    lastFailedDraftKeyRef.current = null;
  }, [pollQuery.data]);

  const normalizedDraft = useMemo(() => (draft ? normalizeDraft(draft) : null), [draft]);
  const normalizedSavedSnapshot = useMemo(
    () => (savedSnapshot ? normalizeDraft(savedSnapshot) : null),
    [savedSnapshot],
  );
  const normalizedDraftKey = useMemo(
    () => (normalizedDraft ? JSON.stringify(normalizedDraft) : ''),
    [normalizedDraft],
  );
  const normalizedSavedKey = useMemo(
    () => (normalizedSavedSnapshot ? JSON.stringify(normalizedSavedSnapshot) : ''),
    [normalizedSavedSnapshot],
  );
  const isDirty = Boolean(normalizedDraft && normalizedDraftKey !== normalizedSavedKey);
  const poll = pollQuery.data ?? null;
  const isActive = poll?.status === 'ACTIVE';
  const totalVotes = poll?.totalVotes ?? 0;

  useEffect(() => {
    latestDraftRef.current = normalizedDraft;
    latestDraftKeyRef.current = normalizedDraftKey;
    isDirtyRef.current = isDirty;
  }, [isDirty, normalizedDraft, normalizedDraftKey]);

  const clearAutosaveTimer = () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  };

  const clearAutosaveHideTimer = () => {
    if (autosaveHideTimerRef.current !== null) {
      window.clearTimeout(autosaveHideTimerRef.current);
      autosaveHideTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      clearAutosaveTimer();
      clearAutosaveHideTimer();
    },
    [],
  );

  const applyPollResponse = (nextPoll: ManagedPoll, payloadKey?: string) => {
    const nextDraft = toDraft(nextPoll);
    queryClient.setQueryData(queryKey, nextPoll);
    setSavedSnapshot(nextDraft);
    setDraft((current) => {
      if (!current || !payloadKey) {
        return nextDraft;
      }

      const currentKey = JSON.stringify(normalizeDraft(current));
      return currentKey === payloadKey ? nextDraft : current;
    });
  };

  const saveDraftNow = async ({ force = false }: { force?: boolean } = {}): Promise<ManagedPoll | null> => {
    const payload = latestDraftRef.current;
    const payloadKey = latestDraftKeyRef.current;

    if (!payload || isActive || (!force && !isDirtyRef.current)) {
      return null;
    }

    if (!force && payloadKey === lastFailedDraftKeyRef.current) {
      setSaveState('error');
      return null;
    }

    if (saveInFlightRef.current) {
      return saveInFlightRef.current;
    }

    clearAutosaveTimer();
    clearAutosaveHideTimer();
    setSaveState('saving');

    const request =
      (entityType === 'channel'
        ? api.updateChannelPoll(entityId, payload)
        : api.updateChatPoll(entityId, payload))
        .then((saved) => {
          lastFailedDraftKeyRef.current = null;
          applyPollResponse(saved, payloadKey);
          setSaveState('saved');
          autosaveHideTimerRef.current = window.setTimeout(() => {
            setSaveState((current) => (current === 'saved' ? 'idle' : current));
            autosaveHideTimerRef.current = null;
          }, AUTOSAVE_SAVED_HIDE_MS);
          return saved;
        })
        .catch((error: unknown) => {
          lastFailedDraftKeyRef.current = payloadKey;
          setSaveState('error');
          throw error;
        })
        .finally(() => {
          saveInFlightRef.current = null;
        });

    saveInFlightRef.current = request;
    return request;
  };

  useEffect(() => {
    clearAutosaveTimer();

    if (!entityId || !normalizedDraft || !normalizedSavedSnapshot || !isDirty || isActive) {
      return;
    }

    if (saveInFlightRef.current) {
      setSaveState('saving');
      return;
    }

    if (normalizedDraftKey === lastFailedDraftKeyRef.current) {
      setSaveState('error');
      return;
    }

    clearAutosaveHideTimer();
    setSaveState('saving');
    autosaveTimerRef.current = window.setTimeout(() => {
      void saveDraftNow();
    }, AUTOSAVE_DELAY_MS);

    return clearAutosaveTimer;
  }, [entityId, isActive, isDirty, normalizedDraft, normalizedDraftKey, normalizedSavedSnapshot]);

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!entityId) {
        throw new Error('Сущность не выбрана.');
      }

      if (isDirty) {
        await saveDraftNow({ force: true });
      }

      return entityType === 'channel' ? api.publishChannelPoll(entityId) : api.publishChatPoll(entityId);
    },
    onSuccess: (nextPoll) => {
      applyPollResponse(nextPoll);
      pushToast({
        tone: 'success',
        title: 'Опрос опубликован',
        description: 'Голосование запущено и доступно по кнопкам под постом.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать опрос',
        description: formatManagedPollError(error),
      });
    },
  });

  const closeMutation = useMutation({
    mutationFn: () => (entityType === 'channel' ? api.closeChannelPoll(entityId) : api.closeChatPoll(entityId)),
    onSuccess: (nextPoll) => {
      applyPollResponse(nextPoll);
      pushToast({
        tone: 'success',
        title: 'Опрос закрыт',
        description: 'Кнопки голосования отключены, итог сохранён в публикации.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось закрыть опрос',
        description: formatManagedPollError(error),
      });
    },
  });

  const draftStatusText = useMemo(() => {
    if (saveState === 'saving') {
      return 'Сохраняем черновик';
    }
    if (saveState === 'saved') {
      return 'Черновик обновлён';
    }
    if (saveState === 'error') {
      return 'Ошибка сохранения';
    }
    if (isDirty) {
      return 'Есть несохранённые изменения';
    }
    return 'Черновик синхронизирован';
  }, [isDirty, saveState]);

  const canPublish = useMemo(() => {
    if (!draft || isActive || publishMutation.isPending || closeMutation.isPending) {
      return false;
    }

    const question = draft.question.trim();
    if (!question) {
      return false;
    }

    const trimmedOptions = draft.options.map((option) => option.trim());
    if (trimmedOptions.some((option) => !option)) {
      return false;
    }

    const uniqueOptions = new Set(trimmedOptions.map((option) => normalizeOptionKey(option)));
    return uniqueOptions.size === trimmedOptions.length;
  }, [closeMutation.isPending, draft, isActive, publishMutation.isPending]);

  const toggleHint = (hintKey: ManagedPollHintKey) => {
    setOpenHintKey((current) => (current === hintKey ? null : hintKey));
  };

  useEffect(() => {
    if (!draft) {
      return;
    }

    if (!draft.question.trim()) {
      setQuestionError('');
    } else if (draft.question.trim().length > MANAGED_POLL_QUESTION_MAX_LENGTH) {
      setQuestionError(`Максимум ${MANAGED_POLL_QUESTION_MAX_LENGTH} символов.`);
    } else {
      setQuestionError('');
    }

    const trimmedOptions = draft.options.map((option) => option.trim()).filter(Boolean);
    const uniqueOptions = new Set(trimmedOptions.map((option) => normalizeOptionKey(option)));
    if (trimmedOptions.length > 0 && uniqueOptions.size !== trimmedOptions.length) {
      setOptionError('Варианты должны отличаться друг от друга.');
    } else {
      setOptionError('');
    }
  }, [draft]);

  if (pollQuery.error) {
    return (
      <GlassCard className="managed-poll-card" elevated>
        <div className="managed-poll-card__empty managed-poll-card__empty--error">
          Ошибка: {formatManagedPollError(pollQuery.error)}
        </div>
      </GlassCard>
    );
  }

  if (pollQuery.isLoading || !draft || !poll) {
    return (
      <GlassCard className="managed-poll-card" elevated>
        <div className="managed-poll-card__empty">Загружаем опрос…</div>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="managed-poll-card" elevated>
      <div className="managed-poll-card__head">
        <div className="managed-poll-card__title-wrap">
          <div className="managed-poll-card__title-row">
            <h3>Опрос</h3>
            <ManagedPollHintAnchor
              hintKey="rules"
              openHintKey={openHintKey}
              onToggleHint={toggleHint}
              label="Как работает голосование"
            >
              Один голос на участника, переголосование разрешено.
            </ManagedPollHintAnchor>
          </div>
        </div>
        <div className="managed-poll-card__chips">
          <span className={cn('chip', buildStatusTone(poll.status) && `chip--${buildStatusTone(poll.status)}`)}>
            {buildStatusLabel(poll.status)}
          </span>
          <span className="chip">{totalVotes} голосов</span>
        </div>
      </div>

      <div className="managed-poll-card__meta">
        <div className="managed-poll-card__meta-line">
          <span>{poll.publishedAt ? `Пост опубликован ${new Date(poll.publishedAt).toLocaleString('ru-RU')}` : 'Пост ещё не опубликован'}</span>
          {poll.publishedUrl ? (
            <a
              href={poll.publishedUrl}
              target="_blank"
              rel="noreferrer"
              className="managed-poll-card__link"
            >
              Открыть пост
            </a>
          ) : null}
        </div>
        <div className="managed-poll-card__meta-line">
          <span>{draftStatusText}</span>
          <span>{draft.options.length}/{MANAGED_POLL_MAX_OPTIONS} вариантов</span>
        </div>
      </div>

      <label className={cn('field', questionError && 'field--error')}>
        <span className="managed-poll-card__field-head">
          <span>Вопрос</span>
          <span className="chip">
            {draft.question.length}/{MANAGED_POLL_QUESTION_MAX_LENGTH}
          </span>
        </span>
        <textarea
          rows={3}
          value={draft.question}
          onChange={(event) =>
            setDraft((current) =>
              current
                ? {
                    ...current,
                    question: event.target.value,
                  }
                : current,
            )
          }
          placeholder="Что хотите спросить у аудитории?"
          maxLength={MANAGED_POLL_QUESTION_MAX_LENGTH}
          disabled={isActive || publishMutation.isPending || closeMutation.isPending}
        />
        {questionError ? <small className="field__hint">{questionError}</small> : null}
      </label>

      <div className="managed-poll-card__options">
        {draft.options.map((option, index) => {
          const result = poll.optionResults[index];

          return (
            <div key={`managed-poll-option-${index}`} className="managed-poll-option-card">
              <div className="managed-poll-option-card__head">
                <strong>Вариант {index + 1}</strong>
                <div className="managed-poll-option-card__meta">
                  {result && (poll.status === 'ACTIVE' || poll.status === 'CLOSED') ? (
                    <span className="chip">
                      {result.votes} · {result.percent}%
                    </span>
                  ) : null}
                  {draft.options.length > MANAGED_POLL_MIN_OPTIONS && !isActive ? (
                    <button
                      type="button"
                      className="button button--ghost managed-poll-option-card__remove"
                      onClick={() =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                options: current.options.filter((_, itemIndex) => itemIndex !== index),
                              }
                            : current,
                        )
                      }
                      disabled={publishMutation.isPending || closeMutation.isPending}
                    >
                      Убрать
                    </button>
                  ) : null}
                </div>
              </div>

              <label className="field">
                <input
                  type="text"
                  value={option}
                  onChange={(event) =>
                    setDraft((current) => {
                      if (!current) {
                        return current;
                      }

                      const nextOptions = [...current.options];
                      nextOptions[index] = event.target.value;
                      return {
                        ...current,
                        options: nextOptions,
                      };
                    })
                  }
                  placeholder={`Например: Вариант ${index + 1}`}
                  maxLength={MANAGED_POLL_OPTION_MAX_LENGTH}
                  disabled={isActive || publishMutation.isPending || closeMutation.isPending}
                />
              </label>
            </div>
          );
        })}
      </div>

      {optionError ? <small className="field__hint managed-poll-card__hint-error">{optionError}</small> : null}

      {!isActive && draft.options.length < MANAGED_POLL_MAX_OPTIONS ? (
        <button
          type="button"
          className="button button--ghost managed-poll-card__add-option"
          onClick={() =>
            setDraft((current) =>
              current
                ? {
                    ...current,
                    options: [...current.options, ''],
                  }
                : current,
            )
          }
          disabled={publishMutation.isPending || closeMutation.isPending}
        >
          Добавить вариант
        </button>
      ) : null}

      <div className="managed-poll-card__footer">
        <div className="managed-poll-card__footer-copy">
          <span className="managed-poll-card__footer-copy-label">Подсказка</span>
          <ManagedPollHintAnchor
            hintKey="publish"
            openHintKey={openHintKey}
            onToggleHint={toggleHint}
            label="Подсказка по публикации опроса"
          >
            {isActive
              ? 'Поля заблокированы до закрытия опроса.'
              : 'После публикации опрос появится в виде поста с кнопками голосования.'}
          </ManagedPollHintAnchor>
        </div>
        <div className="managed-poll-card__actions">
          {isActive ? (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => closeMutation.mutate()}
              disabled={closeMutation.isPending || publishMutation.isPending}
            >
              {closeMutation.isPending ? 'Закрываем…' : 'Закрыть опрос'}
            </button>
          ) : (
            <button
              type="button"
              className="button button--accent"
              onClick={() => publishMutation.mutate()}
              disabled={!canPublish}
            >
              {publishMutation.isPending
                ? 'Публикуем…'
                : saveState === 'saving' && isDirty
                  ? 'Сохраняем…'
                  : poll.status === 'CLOSED'
                    ? 'Опубликовать новый опрос'
                    : 'Опубликовать опрос'}
            </button>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
