import {
  MANAGED_GIVEAWAY_DESCRIPTION_MAX_LENGTH,
  MANAGED_GIVEAWAY_MAX_PRIZES,
  MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH,
  MANAGED_GIVEAWAY_TITLE_MAX_LENGTH,
  type ManagedGiveawayDetails,
  type ManagedGiveawaySummary,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/cn';
import { prepareBroadcastImage } from '../lib/broadcast-image';
import type { ApiClient, UpdateManagedGiveawayPayload } from '../lib/api-client';
import { openMaxBotLink } from '../lib/max-bridge';
import { useToast } from './ui/toast';

const MAX_GIVEAWAY_IMAGE_SIZE_BYTES = 1_000_000;

type GiveawayDraft = UpdateManagedGiveawayPayload;

function createDefaultEndsAt(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
}

function createDefaultDraft(): GiveawayDraft {
  return {
    title: '',
    description: '',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    startsAt: null,
    endsAt: createDefaultEndsAt(),
    claimHours: 24,
    prizes: [{ position: 1, title: '' }],
  };
}

function toDraft(details: ManagedGiveawayDetails): GiveawayDraft {
  return {
    title: details.title,
    description: details.description,
    imageEnabled: details.imageEnabled,
    imageBase64: details.imageBase64,
    imageMimeType: details.imageMimeType,
    imageFileName: details.imageFileName,
    startsAt: details.startsAt,
    endsAt: details.endsAt,
    claimHours: details.claimHours,
    prizes: details.prizes.map((prize) => ({
      position: prize.position,
      title: prize.title,
    })),
  };
}

function formatApiError(error: unknown): string {
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

function formatDateTimeLabel(value: string | null): string {
  if (!value) {
    return 'не задано';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toLocalDateTimeInputValue(value: string | null): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60 * 1_000);
  return local.toISOString().slice(0, 16);
}

function fromLocalDateTimeInputValue(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function buildStatusLabel(status: ManagedGiveawaySummary['status']): string {
  switch (status) {
    case 'ACTIVE':
      return 'Активен';
    case 'SCHEDULED':
      return 'По таймеру';
    case 'DRAWING':
      return 'Подводим итоги';
    case 'COMPLETED':
      return 'Завершён';
    case 'CANCELED':
      return 'Отменён';
    default:
      return 'Черновик';
  }
}

function buildStatusTone(
  status: ManagedGiveawaySummary['status'],
): 'success' | 'warning' | 'muted' | 'danger' {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'SCHEDULED':
    case 'DRAFT':
      return 'warning';
    case 'CANCELED':
      return 'danger';
    default:
      return 'muted';
  }
}

function buildWinnerStatusLabel(status: ManagedGiveawayDetails['winners'][number]['status']): string {
  switch (status) {
    case 'CLAIMED':
      return 'приз подтверждён';
    case 'DELIVERED':
      return 'выдан';
    case 'EXPIRED':
      return 'claim истёк';
    case 'REROLLED':
      return 'перевыбран';
    default:
      return 'ждёт claim';
  }
}

function isCurrentLifecycle(status: ManagedGiveawaySummary['status']): boolean {
  return (
    status === 'DRAFT' ||
    status === 'SCHEDULED' ||
    status === 'ACTIVE' ||
    status === 'DRAWING'
  );
}

function getEntityLabel(entityType: 'chat' | 'channel'): string {
  return entityType === 'channel' ? 'канала' : 'чата';
}

export function ManagedGiveawayCard({
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
  const [selectedGiveawayId, setSelectedGiveawayId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GiveawayDraft | null>(null);

  const listQuery = useQuery({
    queryKey: ['managed-giveaways', entityType, entityId] as const,
    queryFn: () => api.getManagedGiveaways(entityType, entityId),
    enabled: Boolean(entityId),
    refetchOnWindowFocus: false,
  });

  const giveaways = listQuery.data ?? [];
  const currentGiveaway = useMemo(
    () => giveaways.find((item) => isCurrentLifecycle(item.status)) ?? null,
    [giveaways],
  );

  useEffect(() => {
    if (!giveaways.length) {
      setSelectedGiveawayId(null);
      return;
    }

    if (selectedGiveawayId && giveaways.some((item) => item.id === selectedGiveawayId)) {
      return;
    }

    setSelectedGiveawayId((currentGiveaway ?? giveaways[0]).id);
  }, [currentGiveaway, giveaways, selectedGiveawayId]);

  const detailQuery = useQuery({
    queryKey: ['managed-giveaway', entityType, entityId, selectedGiveawayId] as const,
    queryFn: () => api.getManagedGiveaway(entityType, entityId, selectedGiveawayId ?? ''),
    enabled: Boolean(entityId && selectedGiveawayId),
    refetchOnWindowFocus: false,
  });

  const selectedGiveaway = detailQuery.data ?? null;

  useEffect(() => {
    if (!selectedGiveaway || selectedGiveaway.status !== 'DRAFT') {
      return;
    }

    setDraft(toDraft(selectedGiveaway));
  }, [selectedGiveaway]);

  const historyGiveaways = giveaways.filter((item) => item.id !== currentGiveaway?.id);
  const canCreateNew = !currentGiveaway || ['COMPLETED', 'CANCELED'].includes(currentGiveaway.status);

  const invalidateGiveawayQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['managed-giveaways', entityType, entityId] }),
      queryClient.invalidateQueries({
        queryKey: ['managed-giveaway', entityType, entityId, selectedGiveawayId],
      }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: (payload: GiveawayDraft) => api.createManagedGiveaway(entityType, entityId, payload),
    onSuccess: async (created) => {
      setSelectedGiveawayId(created.id);
      setDraft(toDraft(created));
      await invalidateGiveawayQueries();
      pushToast({
        tone: 'success',
        title: 'Черновик создан',
        description: 'Розыгрыш сохранён.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось создать розыгрыш',
        description: formatApiError(error),
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ giveawayId, payload }: { giveawayId: string; payload: GiveawayDraft }) =>
      api.updateManagedGiveaway(entityType, entityId, giveawayId, payload),
    onSuccess: async (updated) => {
      setDraft(toDraft(updated));
      await invalidateGiveawayQueries();
      pushToast({
        tone: 'success',
        title: 'Черновик обновлён',
        description: 'Изменения сохранены.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить розыгрыш',
        description: formatApiError(error),
      });
    },
  });

  const handoffMutation = useMutation({
    mutationFn: (giveawayId: string | null) =>
      api.handoffManagedGiveaway(entityType, entityId, { giveawayId }),
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть бота',
        description: formatApiError(error),
      });
    },
  });

  const isBusy =
    createMutation.isPending ||
    updateMutation.isPending ||
    handoffMutation.isPending;

  const startNewDraft = () => {
    setSelectedGiveawayId(null);
    setDraft(createDefaultDraft());
  };

  const handleDraftChange = <K extends keyof GiveawayDraft>(key: K, value: GiveawayDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const handlePrizeChange = (index: number, title: string) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const prizes = current.prizes.map((prize, prizeIndex) =>
        prizeIndex === index ? { ...prize, title } : prize,
      );
      return { ...current, prizes };
    });
  };

  const addPrize = () => {
    setDraft((current) => {
      if (!current || current.prizes.length >= MANAGED_GIVEAWAY_MAX_PRIZES) {
        return current;
      }

      return {
        ...current,
        prizes: [
          ...current.prizes,
          {
            position: current.prizes.length + 1,
            title: '',
          },
        ],
      };
    });
  };

  const removePrize = (index: number) => {
    setDraft((current) => {
      if (!current || current.prizes.length <= 1) {
        return current;
      }

      const prizes = current.prizes
        .filter((_, prizeIndex) => prizeIndex !== index)
        .map((prize, prizeIndex) => ({
          ...prize,
          position: prizeIndex + 1,
        }));
      return { ...current, prizes };
    });
  };

  const handleImageUpload = async (file: File | null) => {
    if (!file) {
      return;
    }

    if (file.size > MAX_GIVEAWAY_IMAGE_SIZE_BYTES) {
      pushToast({
        tone: 'danger',
        title: 'Файл слишком большой',
        description: 'Максимум 1 MB.',
      });
      return;
    }

    try {
      const prepared = await prepareBroadcastImage(file);
      const approxSize = Math.ceil((prepared.base64.length * 3) / 4);
      if (approxSize > MAX_GIVEAWAY_IMAGE_SIZE_BYTES) {
        throw new Error('После подготовки изображение всё ещё больше 1 MB.');
      }

      setDraft((current) =>
        current
          ? {
              ...current,
              imageEnabled: true,
              imageBase64: prepared.base64,
              imageMimeType: prepared.mimeType,
              imageFileName: prepared.fileName,
            }
          : current,
      );
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось подготовить изображение',
        description: formatApiError(error),
      });
    }
  };

  const clearImage = () => {
    setDraft((current) =>
      current
        ? {
            ...current,
            imageEnabled: false,
            imageBase64: '',
            imageMimeType: '',
            imageFileName: '',
          }
        : current,
    );
  };

  const saveDraft = async (): Promise<ManagedGiveawayDetails | null> => {
    if (!draft) {
      return null;
    }

    if (selectedGiveaway?.status === 'DRAFT') {
      return updateMutation.mutateAsync({
        giveawayId: selectedGiveaway.id,
        payload: draft,
      });
    }

    return createMutation.mutateAsync(draft);
  };

  const continueInBot = async () => {
    try {
      let giveawayId = selectedGiveaway?.id ?? null;

      if (draft) {
        const saved = await saveDraft();
        giveawayId = saved?.id ?? giveawayId;
      }

      if (!giveawayId) {
        pushToast({
          tone: 'danger',
          title: 'Сначала сохраните черновик',
          description: 'Боту нужен конкретный розыгрыш для продолжения сценария.',
        });
        return;
      }

      const result = await handoffMutation.mutateAsync(giveawayId);
      openMaxBotLink(result.botUrl);
    } catch {
      // Toasts already handled in mutations above.
    }
  };

  const selectedSummary = giveaways.find((item) => item.id === selectedGiveawayId) ?? null;
  const statusSummary =
    selectedGiveaway ?? currentGiveaway ?? selectedSummary ?? (giveaways[0] ?? null);

  return (
    <div className="managed-giveaway">
      <div className="managed-giveaway__toolbar">
        <div>
          <div className="managed-giveaway__title">Текущий розыгрыш</div>
          <div className="managed-giveaway__subtitle">
            {statusSummary
              ? `${buildStatusLabel(statusSummary.status)} · ${statusSummary.entriesCount} заявок`
              : 'Черновика ещё нет'}
          </div>
        </div>

        {canCreateNew ? (
          <button
            type="button"
            className="button button--ghost"
            disabled={isBusy}
            onClick={startNewDraft}
          >
            Новый
          </button>
        ) : null}
      </div>

      <div className="managed-giveaway__panel">
        <p>
          Здесь собирается карточка розыгрыша: текст, фото, призы и тайминг. Публикация,
          завершение, reroll и выдача приза идут дальше в личке бота.
        </p>
      </div>

      {listQuery.isLoading ? (
        <div className="managed-giveaway__empty">Загружаем розыгрыши...</div>
      ) : null}

      {listQuery.error ? (
        <div className="managed-giveaway__empty is-danger">{formatApiError(listQuery.error)}</div>
      ) : null}

      {!listQuery.isLoading && !listQuery.error && !selectedGiveaway && !draft && giveaways.length === 0 ? (
        <div className="managed-giveaway__empty">
          <p>Запустите первый розыгрыш для этого {getEntityLabel(entityType)}.</p>
          <button type="button" className="button button--accent" onClick={startNewDraft}>
            Создать черновик
          </button>
        </div>
      ) : null}

      {draft ? (
        <div className="managed-giveaway__panel">
          <div className="managed-giveaway__grid">
            <label className="field settings-text-field">
              <span>Название</span>
              <input
                type="text"
                value={draft.title}
                maxLength={MANAGED_GIVEAWAY_TITLE_MAX_LENGTH}
                onChange={(event) => handleDraftChange('title', event.target.value)}
                placeholder="Например: Весенний розыгрыш"
              />
            </label>

            <label className="field settings-text-field">
              <span>Claim-окно, часы</span>
              <input
                type="number"
                min={1}
                max={336}
                value={draft.claimHours}
                onChange={(event) =>
                  handleDraftChange('claimHours', Math.min(336, Math.max(1, Number(event.target.value) || 1)))
                }
              />
            </label>
          </div>

          <label className="field settings-text-field">
            <span>Описание</span>
            <textarea
              rows={4}
              maxLength={MANAGED_GIVEAWAY_DESCRIPTION_MAX_LENGTH}
              value={draft.description}
              onChange={(event) => handleDraftChange('description', event.target.value)}
              placeholder="Коротко объясните условия и что разыгрываете."
            />
          </label>

          <div className="managed-giveaway__grid">
            <label className="field settings-text-field">
              <span>Старт</span>
              <input
                type="datetime-local"
                value={toLocalDateTimeInputValue(draft.startsAt)}
                onChange={(event) => handleDraftChange('startsAt', fromLocalDateTimeInputValue(event.target.value))}
              />
            </label>

            <label className="field settings-text-field">
              <span>Завершение</span>
              <input
                type="datetime-local"
                value={toLocalDateTimeInputValue(draft.endsAt)}
                onChange={(event) =>
                  handleDraftChange(
                    'endsAt',
                    fromLocalDateTimeInputValue(event.target.value) ?? createDefaultEndsAt(),
                  )
                }
              />
            </label>
          </div>

          <div className="managed-giveaway__panel">
            <div className="managed-giveaway__section-head">
              <div>
                <strong>Обложка</strong>
                <small>{draft.imageEnabled ? draft.imageFileName || 'Файл загружен' : 'Необязательно'}</small>
              </div>
              {draft.imageEnabled ? (
                <button type="button" className="button button--ghost" onClick={clearImage}>
                  Убрать
                </button>
              ) : null}
            </div>

            <label className="field settings-text-field mailing-upload-field">
              <span>Фото до 1 MB</span>
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  void handleImageUpload(event.target.files?.[0] ?? null);
                  event.currentTarget.value = '';
                }}
              />
            </label>
          </div>

          <div className="managed-giveaway__panel">
            <div className="managed-giveaway__section-head">
              <div>
                <strong>Призы</strong>
                <small>{draft.prizes.length} мест</small>
              </div>
              <button
                type="button"
                className="button button--ghost"
                disabled={draft.prizes.length >= MANAGED_GIVEAWAY_MAX_PRIZES}
                onClick={addPrize}
              >
                Добавить
              </button>
            </div>

            <div className="managed-giveaway__prizes">
              {draft.prizes.map((prize, index) => (
                <div key={`prize-${prize.position}`} className="managed-giveaway__prize-row">
                  <span className="managed-giveaway__prize-position">{prize.position}</span>
                  <input
                    type="text"
                    value={prize.title}
                    maxLength={MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH}
                    onChange={(event) => handlePrizeChange(index, event.target.value)}
                    placeholder={`Приз за ${prize.position} место`}
                  />
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={draft.prizes.length <= 1}
                    onClick={() => removePrize(index)}
                  >
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="managed-giveaway__actions">
            <button
              type="button"
              className="button button--ghost"
              disabled={isBusy}
              onClick={() => {
                setDraft(selectedGiveaway?.status === 'DRAFT' ? toDraft(selectedGiveaway) : null);
              }}
            >
              Сбросить
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={isBusy}
              onClick={() => {
                void saveDraft();
              }}
            >
              {selectedGiveaway?.status === 'DRAFT' ? 'Сохранить' : 'Создать черновик'}
            </button>
            <button
              type="button"
              className="button button--accent"
              disabled={isBusy}
              onClick={() => {
                void continueInBot();
              }}
            >
              Продолжить в боте
            </button>
          </div>
        </div>
      ) : null}

      {selectedGiveaway && !draft ? (
        <div className="managed-giveaway__panel">
          <div className="managed-giveaway__summary-head">
            <div>
              <h4>{selectedGiveaway.title}</h4>
              <div
                className={cn(
                  'managed-giveaway__badge',
                  `is-${buildStatusTone(selectedGiveaway.status)}`,
                )}
              >
                {buildStatusLabel(selectedGiveaway.status)}
              </div>
            </div>
            <div className="managed-giveaway__meta">
              <span>{selectedGiveaway.entriesCount} заявок</span>
              <span>{selectedGiveaway.winnersCount} победителей</span>
            </div>
          </div>

          <div className="managed-giveaway__details">
            <p>{selectedGiveaway.description || 'Описание не добавлено.'}</p>
            <div className="managed-giveaway__meta-list">
              <span>Старт: {formatDateTimeLabel(selectedGiveaway.startsAt)}</span>
              <span>Финиш: {formatDateTimeLabel(selectedGiveaway.endsAt)}</span>
              <span>Claim: {selectedGiveaway.claimHours} ч.</span>
            </div>
            <div className="managed-giveaway__chips">
              {selectedGiveaway.prizes.map((prize) => (
                <span key={prize.id} className="managed-giveaway__chip">
                  {prize.position}. {prize.title}
                </span>
              ))}
            </div>
          </div>

          {selectedGiveaway.winners.length > 0 ? (
            <div className="managed-giveaway__winners">
              <div className="managed-giveaway__section-head">
                <div>
                  <strong>Победители</strong>
                  <small>Reroll и выдача приза продолжаются в личке бота</small>
                </div>
              </div>

              {selectedGiveaway.winners.map((winner) => (
                <div key={winner.id} className="managed-giveaway__winner-row">
                  <div>
                    <strong>
                      {winner.prizePosition}. {winner.prizeTitle}
                    </strong>
                    <p>{winner.displayName || winner.userId}</p>
                    <small>{buildWinnerStatusLabel(winner.status)}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="managed-giveaway__actions">
            <button
              type="button"
              className="button button--ghost"
              disabled={detailQuery.isFetching || isBusy}
              onClick={() => {
                void detailQuery.refetch();
                void listQuery.refetch();
              }}
            >
              Обновить
            </button>
            {selectedGiveaway.status === 'DRAFT' ? (
              <button
                type="button"
                className="button button--ghost"
                disabled={isBusy}
                onClick={() => setDraft(toDraft(selectedGiveaway))}
              >
                Править
              </button>
            ) : null}
            <button
              type="button"
              className="button button--accent"
              disabled={isBusy}
              onClick={() => {
                void continueInBot();
              }}
            >
              Продолжить в боте
            </button>
          </div>
        </div>
      ) : null}

      {historyGiveaways.length > 0 ? (
        <div className="managed-giveaway__history">
          <div className="managed-giveaway__section-head">
            <div>
              <strong>История</strong>
              <small>Завершённые и отменённые розыгрыши</small>
            </div>
          </div>

          <div className="managed-giveaway__history-list">
            {historyGiveaways.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  'managed-giveaway__history-item',
                  selectedGiveawayId === item.id && 'is-active',
                )}
                onClick={() => {
                  setDraft(null);
                  setSelectedGiveawayId(item.id);
                }}
              >
                <span>{item.title}</span>
                <small>
                  {buildStatusLabel(item.status)} · {formatDateTimeLabel(item.completedAt ?? item.endsAt)}
                </small>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
