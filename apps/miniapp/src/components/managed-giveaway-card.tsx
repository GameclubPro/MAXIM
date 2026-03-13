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
import type { ApiClient, UpdateManagedGiveawayPayload } from '../lib/api-client';
import { openMaxBotLink } from '../lib/max-bridge';
import { useToast } from './ui/toast';

const MIN_CLAIM_HOURS = 1;
const MAX_CLAIM_HOURS = 336;
const QUICK_DURATION_HOURS = [24, 48, 72] as const;
const QUICK_CLAIM_HOURS = [24, 48, 72] as const;

type GiveawayEditorMode = 'closed' | 'create' | 'edit';

type GiveawayEditorDraft = {
  title: string;
  description: string;
  startsAtLocal: string;
  endsAtLocal: string;
  claimHours: number;
  prizes: string[];
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
};

function formatApiError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  const text = error.message.trim();
  if (!text) {
    return fallback;
  }

  if (text.startsWith('API request failed:')) {
    const details = text.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || fallback;
  }

  return text;
}

function buildHistoryLabel(status: ManagedGiveawaySummary['status']): string {
  return status === 'CANCELED' ? 'Отменён' : 'Завершён';
}

function buildStatusLabel(status: ManagedGiveawaySummary['status']): string {
  if (status === 'DRAFT') {
    return 'Черновик';
  }
  if (status === 'SCHEDULED') {
    return 'Запланирован';
  }
  if (status === 'ACTIVE') {
    return 'Идёт';
  }
  if (status === 'DRAWING') {
    return 'Подводим итоги';
  }
  if (status === 'COMPLETED') {
    return 'Завершён';
  }
  return 'Отменён';
}

function buildStatusTone(
  status: ManagedGiveawaySummary['status'],
): 'is-success' | 'is-warning' | 'is-danger' | 'is-muted' {
  if (status === 'ACTIVE' || status === 'COMPLETED') {
    return 'is-success';
  }
  if (status === 'SCHEDULED' || status === 'DRAWING' || status === 'DRAFT') {
    return 'is-warning';
  }
  if (status === 'CANCELED') {
    return 'is-danger';
  }
  return 'is-muted';
}

function formatDateTime(value: string | null, fallback = 'не задано'): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCompactDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}

function formatDateTimeInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function parseDateTimeInput(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function toDateTimeInputFromIso(value: string | null): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return formatDateTimeInputValue(parsed);
}

function addHours(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

function createDefaultEditorDraft(): GiveawayEditorDraft {
  const now = new Date();
  const roundedNow = new Date(now.getTime());
  roundedNow.setSeconds(0, 0);
  const defaultEnd = addHours(roundedNow, 24);

  return {
    title: 'Новый розыгрыш',
    description: '',
    startsAtLocal: '',
    endsAtLocal: formatDateTimeInputValue(defaultEnd),
    claimHours: 24,
    prizes: ['1 место'],
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
  };
}

function toEditorDraft(giveaway: ManagedGiveawayDetails): GiveawayEditorDraft {
  return {
    title: giveaway.title,
    description: giveaway.description,
    startsAtLocal: toDateTimeInputFromIso(giveaway.startsAt),
    endsAtLocal: toDateTimeInputFromIso(giveaway.endsAt),
    claimHours: giveaway.claimHours,
    prizes: giveaway.prizes
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((prize) => prize.title),
    imageEnabled: giveaway.imageEnabled,
    imageBase64: giveaway.imageBase64,
    imageMimeType: giveaway.imageMimeType,
    imageFileName: giveaway.imageFileName,
  };
}

function normalizePrizeKey(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase().replace(/ё/gu, 'е');
}

function validateDraft(draft: GiveawayEditorDraft): { valid: boolean; message: string } {
  if (!draft.title.trim()) {
    return { valid: false, message: 'Введите название розыгрыша.' };
  }

  if (!draft.endsAtLocal.trim()) {
    return { valid: false, message: 'Укажите время завершения.' };
  }

  const startsAt = draft.startsAtLocal.trim() ? parseDateTimeInput(draft.startsAtLocal) : null;
  if (draft.startsAtLocal.trim() && !startsAt) {
    return { valid: false, message: 'Укажите корректное время старта.' };
  }

  const endsAt = parseDateTimeInput(draft.endsAtLocal);
  if (!endsAt) {
    return { valid: false, message: 'Укажите корректное время завершения.' };
  }

  const startsAtMs = startsAt ? startsAt.getTime() : Date.now();
  if (endsAt.getTime() <= startsAtMs) {
    return { valid: false, message: 'Финиш должен быть позже старта.' };
  }

  if (
    !Number.isInteger(draft.claimHours) ||
    draft.claimHours < MIN_CLAIM_HOURS ||
    draft.claimHours > MAX_CLAIM_HOURS
  ) {
    return { valid: false, message: `Подтверждение: от ${MIN_CLAIM_HOURS} до ${MAX_CLAIM_HOURS} часов.` };
  }

  if (draft.prizes.length < 1 || draft.prizes.length > MANAGED_GIVEAWAY_MAX_PRIZES) {
    return { valid: false, message: `Количество мест: от 1 до ${MANAGED_GIVEAWAY_MAX_PRIZES}.` };
  }

  const trimmedPrizes = draft.prizes.map((item) => item.trim());
  if (trimmedPrizes.some((item) => !item)) {
    return { valid: false, message: 'Заполните названия всех призов.' };
  }

  const normalized = trimmedPrizes.map((item) => normalizePrizeKey(item));
  if (new Set(normalized).size !== normalized.length) {
    return { valid: false, message: 'Названия призов не должны повторяться.' };
  }

  if (draft.imageEnabled && (!draft.imageBase64.trim() || !draft.imageMimeType.trim())) {
    return { valid: false, message: 'Не удалось использовать сохранённое изображение.' };
  }

  return { valid: true, message: '' };
}

function toUpdatePayload(draft: GiveawayEditorDraft): UpdateManagedGiveawayPayload {
  const startsAtDate = draft.startsAtLocal.trim() ? parseDateTimeInput(draft.startsAtLocal) : null;
  const endsAtDate = parseDateTimeInput(draft.endsAtLocal);
  if (!endsAtDate) {
    throw new Error('Укажите корректное время завершения.');
  }
  if (draft.startsAtLocal.trim() && !startsAtDate) {
    throw new Error('Укажите корректное время старта.');
  }

  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    imageEnabled: draft.imageEnabled,
    imageBase64: draft.imageBase64,
    imageMimeType: draft.imageMimeType,
    imageFileName: draft.imageFileName,
    startsAt: startsAtDate ? startsAtDate.toISOString() : null,
    endsAt: endsAtDate.toISOString(),
    claimHours: Math.max(MIN_CLAIM_HOURS, Math.min(MAX_CLAIM_HOURS, Math.round(draft.claimHours))),
    prizes: draft.prizes.map((title, index) => ({
      position: index + 1,
      title: title.trim(),
    })),
  };
}

function buildEditorStatusLabel(params: {
  mode: GiveawayEditorMode;
  busy: boolean;
  isDirty: boolean;
  loadingDetails: boolean;
}): string {
  if (params.mode === 'closed') {
    return '';
  }
  if (params.loadingDetails) {
    return 'Загружаем черновик…';
  }
  if (params.busy) {
    return 'Сохраняем…';
  }
  if (params.mode === 'create') {
    return 'Новый черновик';
  }
  if (params.isDirty) {
    return 'Есть несохранённые изменения';
  }
  return 'Черновик синхронизирован';
}

function buildCurrentSubtitle(item: ManagedGiveawaySummary): string {
  if (item.status === 'DRAFT') {
    return `Черновик. Финиш: ${formatDateTime(item.endsAt)}.`;
  }
  if (item.status === 'SCHEDULED') {
    return `Старт: ${formatDateTime(item.startsAt, 'сразу')}. Финиш: ${formatDateTime(item.endsAt)}.`;
  }
  if (item.status === 'ACTIVE') {
    return `Идёт до ${formatDateTime(item.endsAt)}.`;
  }
  if (item.status === 'DRAWING') {
    return 'Подводим итоги.';
  }
  if (item.status === 'COMPLETED') {
    return `Обновлён: ${formatDateTime(item.completedAt ?? item.updatedAt)}.`;
  }
  return `Отменён: ${formatDateTime(item.updatedAt)}.`;
}

function StepChevron({ isOpen }: { isOpen: boolean }) {
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<GiveawayEditorMode>('closed');
  const [editingGiveawayId, setEditingGiveawayId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GiveawayEditorDraft | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<GiveawayEditorDraft | null>(null);
  const [editorError, setEditorError] = useState('');
  const [validationHint, setValidationHint] = useState('');

  const listQueryKey = useMemo(
    () => ['managed-giveaways', entityType, entityId] as const,
    [entityId, entityType],
  );

  const listQuery = useQuery({
    queryKey: listQueryKey,
    queryFn: () => api.getManagedGiveaways(entityType, entityId),
    enabled: Boolean(entityId),
    refetchOnWindowFocus: false,
  });

  const sortedItems = useMemo(
    () =>
      [...(listQuery.data ?? [])].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      ),
    [listQuery.data],
  );

  const currentItem = useMemo(
    () =>
      sortedItems.find(
        (item) =>
          item.status === 'DRAFT' ||
          item.status === 'SCHEDULED' ||
          item.status === 'ACTIVE' ||
          item.status === 'DRAWING',
      ) ?? null,
    [sortedItems],
  );

  const historyItems = useMemo(
    () => sortedItems.filter((item) => item.status === 'COMPLETED' || item.status === 'CANCELED'),
    [sortedItems],
  );

  const draftDetailsQuery = useQuery({
    queryKey: ['managed-giveaway-details', entityType, entityId, editingGiveawayId] as const,
    queryFn: () => {
      if (!editingGiveawayId) {
        throw new Error('Черновик не выбран.');
      }
      return api.getManagedGiveaway(entityType, entityId, editingGiveawayId);
    },
    enabled: editorMode === 'edit' && Boolean(entityId) && Boolean(editingGiveawayId),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!draftDetailsQuery.data) {
      return;
    }

    const nextDraft = toEditorDraft(draftDetailsQuery.data);
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setEditorError('');
    setValidationHint('');
  }, [draftDetailsQuery.data]);

  useEffect(() => {
    if (editorMode === 'closed') {
      return;
    }

    if (editorMode === 'edit') {
      if (!editingGiveawayId) {
        setEditorMode('closed');
        setDraft(null);
        setSavedSnapshot(null);
        return;
      }

      const matching = sortedItems.find((item) => item.id === editingGiveawayId);
      if (!matching || matching.status !== 'DRAFT') {
        setEditorMode('closed');
        setEditingGiveawayId(null);
        setDraft(null);
        setSavedSnapshot(null);
        setEditorError('');
        setValidationHint('');
      }
    }
  }, [editingGiveawayId, editorMode, sortedItems]);

  const draftKey = useMemo(() => (draft ? JSON.stringify(draft) : ''), [draft]);
  const savedKey = useMemo(() => (savedSnapshot ? JSON.stringify(savedSnapshot) : ''), [savedSnapshot]);
  const isDirty = editorMode === 'edit' ? Boolean(draft && savedSnapshot && draftKey !== savedKey) : true;
  const validation = useMemo(
    () => (draft ? validateDraft(draft) : { valid: false, message: 'Черновик не заполнен.' }),
    [draft],
  );

  const handoffMutation = useMutation({
    mutationFn: (giveawayId: string | null) =>
      api.handoffManagedGiveaway(entityType, entityId, { giveawayId }),
    onSuccess: (result) => {
      openMaxBotLink(result.botUrl);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть бота',
        description: formatApiError(error, 'Не удалось открыть бота.'),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (giveawayId: string) => api.deleteManagedGiveaway(entityType, entityId, giveawayId),
    onSuccess: async () => {
      await listQuery.refetch();
      pushToast({
        tone: 'success',
        title: 'Розыгрыш удалён',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить розыгрыш',
        description: formatApiError(error, 'Не удалось удалить розыгрыш.'),
      });
    },
  });

  const createMutation = useMutation({
    mutationFn: (payload: UpdateManagedGiveawayPayload) =>
      api.createManagedGiveaway(entityType, entityId, payload),
  });

  const updateMutation = useMutation({
    mutationFn: (params: { giveawayId: string; payload: UpdateManagedGiveawayPayload }) =>
      api.updateManagedGiveaway(entityType, entityId, params.giveawayId, params.payload),
  });

  const publishMutation = useMutation({
    mutationFn: (giveawayId: string) => api.publishManagedGiveaway(entityType, entityId, giveawayId),
  });

  const cancelMutation = useMutation({
    mutationFn: (giveawayId: string) => api.cancelManagedGiveaway(entityType, entityId, giveawayId),
  });

  const isBusy =
    handoffMutation.isPending ||
    deleteMutation.isPending ||
    createMutation.isPending ||
    updateMutation.isPending ||
    publishMutation.isPending ||
    cancelMutation.isPending;

  const clearEditor = () => {
    setEditorMode('closed');
    setEditingGiveawayId(null);
    setDraft(null);
    setSavedSnapshot(null);
    setEditorError('');
    setValidationHint('');
  };

  const applyEditorPayload = (giveaway: ManagedGiveawayDetails) => {
    const nextDraft = toEditorDraft(giveaway);
    setEditorMode('edit');
    setEditingGiveawayId(giveaway.id);
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setEditorError('');
    setValidationHint('');
  };

  const startCreate = () => {
    setEditorMode('create');
    const nextDraft = createDefaultEditorDraft();
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setEditingGiveawayId(null);
    setEditorError('');
    setValidationHint('');
  };

  const startEditCurrentDraft = () => {
    if (!currentItem || currentItem.status !== 'DRAFT') {
      return;
    }
    setEditorMode('edit');
    setEditingGiveawayId(currentItem.id);
    setEditorError('');
    setValidationHint('');
  };

  const refetchManagedGiveaways = async () => {
    await Promise.all([
      listQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ['managed-giveaway-details', entityType, entityId] }),
    ]);
  };

  const saveEditor = async ({
    silent = false,
  }: {
    silent?: boolean;
  } = {}): Promise<ManagedGiveawayDetails | null> => {
    if (!draft) {
      return null;
    }

    const checked = validateDraft(draft);
    if (!checked.valid) {
      setValidationHint(checked.message);
      if (!silent) {
        pushToast({
          tone: 'danger',
          title: 'Проверьте форму',
          description: checked.message,
        });
      }
      return null;
    }

    try {
      const payload = toUpdatePayload(draft);
      const saved =
        editorMode === 'create' || !editingGiveawayId
          ? await createMutation.mutateAsync(payload)
          : await updateMutation.mutateAsync({ giveawayId: editingGiveawayId, payload });

      applyEditorPayload(saved);
      await refetchManagedGiveaways();
      if (!silent) {
        pushToast({
          tone: 'success',
          title: editorMode === 'create' ? 'Черновик создан' : 'Черновик сохранён',
        });
      }
      return saved;
    } catch (error: unknown) {
      const message = formatApiError(error, 'Не удалось сохранить черновик.');
      setEditorError(message);
      if (!silent) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось сохранить',
          description: message,
        });
      }
      return null;
    }
  };

  const publishEditor = async () => {
    if (!draft) {
      return;
    }

    const checked = validateDraft(draft);
    if (!checked.valid) {
      setValidationHint(checked.message);
      pushToast({
        tone: 'danger',
        title: 'Проверьте форму',
        description: checked.message,
      });
      return;
    }

    try {
      let targetId = editingGiveawayId;

      if (editorMode === 'create' || !targetId) {
        const created = await saveEditor({ silent: true });
        if (!created) {
          return;
        }
        targetId = created.id;
      } else if (isDirty) {
        const updated = await saveEditor({ silent: true });
        if (!updated) {
          return;
        }
        targetId = updated.id;
      }

      if (!targetId) {
        throw new Error('Черновик не найден.');
      }

      await publishMutation.mutateAsync(targetId);
      await refetchManagedGiveaways();
      clearEditor();
      pushToast({
        tone: 'success',
        title: 'Розыгрыш опубликован',
      });
    } catch (error: unknown) {
      const message = formatApiError(error, 'Не удалось опубликовать розыгрыш.');
      setEditorError(message);
      pushToast({
        tone: 'danger',
        title: 'Ошибка публикации',
        description: message,
      });
    }
  };

  const cancelEditorDraft = async () => {
    if (editorMode === 'create' || !editingGiveawayId) {
      clearEditor();
      return;
    }

    try {
      await cancelMutation.mutateAsync(editingGiveawayId);
      await refetchManagedGiveaways();
      clearEditor();
      pushToast({
        tone: 'success',
        title: 'Черновик отменён',
      });
    } catch (error: unknown) {
      const message = formatApiError(error, 'Не удалось отменить черновик.');
      setEditorError(message);
      pushToast({
        tone: 'danger',
        title: 'Ошибка',
        description: message,
      });
    }
  };

  const editorStatusLabel = buildEditorStatusLabel({
    mode: editorMode,
    busy: isBusy,
    isDirty,
    loadingDetails: draftDetailsQuery.isLoading,
  });
  const isEditingOpen = editorMode !== 'closed';
  const canSaveEditor = Boolean(draft) && validation.valid && (editorMode === 'create' || isDirty);
  const canPublishEditor = Boolean(draft) && validation.valid;
  const shouldShowCurrentSummary = Boolean(currentItem) && (currentItem?.status !== 'DRAFT' || !isEditingOpen);

  return (
    <div className="managed-giveaway">
      <div className="managed-giveaway__header">
        <div className="managed-giveaway__header-copy">
          <strong className="managed-giveaway__title">Розыгрыши</strong>
          <small className="managed-giveaway__subtitle">
            Настройка черновика в miniapp, живое управление в боте.
          </small>
        </div>
        {isEditingOpen ? (
          <button type="button" className="button button--ghost" disabled={isBusy} onClick={clearEditor}>
            Свернуть
          </button>
        ) : currentItem?.status === 'DRAFT' ? (
          <button type="button" className="button button--accent" disabled={isBusy} onClick={startEditCurrentDraft}>
            Редактировать
          </button>
        ) : !currentItem ? (
          <button type="button" className="button button--accent" disabled={isBusy} onClick={startCreate}>
            Новый
          </button>
        ) : (
          <button
            type="button"
            className="button button--accent"
            disabled={isBusy}
            onClick={() => {
              void handoffMutation.mutateAsync(currentItem.id);
            }}
          >
            {handoffMutation.isPending ? 'Открываем…' : 'Открыть в боте'}
          </button>
        )}
      </div>

      {isEditingOpen ? (
        !draft ? (
          <div className={cn('managed-giveaway__panel', 'managed-giveaway__editor-card')}>
            <div className="managed-giveaway__editor-head">
              <div className="managed-giveaway__section-copy">
                <strong>Черновик</strong>
                <small>{draftDetailsQuery.isLoading ? 'Загружаем черновик…' : 'Подготовка формы…'}</small>
              </div>
              <span className="managed-giveaway__badge is-warning">Черновик</span>
            </div>
          </div>
        ) : (
        <div className={cn('managed-giveaway__panel', 'managed-giveaway__editor-card')}>
          <div className="managed-giveaway__editor-head">
            <div className="managed-giveaway__section-copy">
              <strong>Черновик</strong>
              <small>{editorStatusLabel}</small>
            </div>
            <span className={cn('managed-giveaway__badge', editorMode === 'create' ? 'is-warning' : 'is-muted')}>
              {editorMode === 'create' ? 'Новый' : 'Черновик'}
            </span>
          </div>

          <div className="managed-giveaway__preset-row">
            <span>Пресеты:</span>
            {QUICK_DURATION_HOURS.map((hours) => (
              <button
                key={`duration-${hours}`}
                type="button"
                className="button button--ghost managed-giveaway__preset-button"
                disabled={isBusy}
                onClick={() =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          startsAtLocal: '',
                          endsAtLocal: formatDateTimeInputValue(addHours(new Date(), hours)),
                        }
                      : current,
                  )
                }
              >
                {hours}ч
              </button>
            ))}
          </div>

          <label className="field">
            <span>
              Название ({draft.title.length}/{MANAGED_GIVEAWAY_TITLE_MAX_LENGTH})
            </span>
            <input
              type="text"
              value={draft.title}
              onChange={(event) => {
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        title: event.target.value,
                      }
                    : current,
                );
                setValidationHint('');
                setEditorError('');
              }}
              maxLength={MANAGED_GIVEAWAY_TITLE_MAX_LENGTH}
              placeholder="Например: Весенний розыгрыш"
              disabled={isBusy}
            />
          </label>

          <label className="field">
            <span>
              Описание ({draft.description.length}/{MANAGED_GIVEAWAY_DESCRIPTION_MAX_LENGTH})
            </span>
            <textarea
              rows={3}
              value={draft.description}
              onChange={(event) => {
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        description: event.target.value,
                      }
                    : current,
                );
                setValidationHint('');
                setEditorError('');
              }}
              maxLength={MANAGED_GIVEAWAY_DESCRIPTION_MAX_LENGTH}
              placeholder="Коротко опишите правила участия."
              disabled={isBusy}
            />
          </label>

          <div className="managed-giveaway__editor-grid">
            <label className="field">
              <span>Старт (опционально)</span>
              <input
                type="datetime-local"
                value={draft.startsAtLocal}
                onChange={(event) => {
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          startsAtLocal: event.target.value,
                        }
                      : current,
                  );
                  setValidationHint('');
                  setEditorError('');
                }}
                disabled={isBusy}
              />
            </label>

            <label className="field">
              <span>Финиш</span>
              <input
                type="datetime-local"
                value={draft.endsAtLocal}
                onChange={(event) => {
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          endsAtLocal: event.target.value,
                        }
                      : current,
                  );
                  setValidationHint('');
                  setEditorError('');
                }}
                disabled={isBusy}
              />
            </label>
          </div>

          <div className="managed-giveaway__editor-grid">
            <label className="field">
              <span>Подтверждение приза (часы)</span>
              <input
                type="number"
                min={MIN_CLAIM_HOURS}
                max={MAX_CLAIM_HOURS}
                value={draft.claimHours}
                onChange={(event) => {
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          claimHours: Number.parseInt(event.target.value, 10) || MIN_CLAIM_HOURS,
                        }
                      : current,
                  );
                  setValidationHint('');
                  setEditorError('');
                }}
                disabled={isBusy}
              />
            </label>

            <div className="managed-giveaway__preset-row managed-giveaway__preset-row--inline">
              <span>Быстро:</span>
              {QUICK_CLAIM_HOURS.map((hours) => (
                <button
                  key={`claim-${hours}`}
                  type="button"
                  className="button button--ghost managed-giveaway__preset-button"
                  disabled={isBusy}
                  onClick={() => {
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            claimHours: hours,
                          }
                        : current,
                    );
                    setValidationHint('');
                    setEditorError('');
                  }}
                >
                  {hours}ч
                </button>
              ))}
            </div>
          </div>

          <div className="managed-giveaway__section">
            <div className="managed-giveaway__section-head">
              <div className="managed-giveaway__section-copy">
                <strong>Призы</strong>
                <small>
                  {draft.prizes.length}/{MANAGED_GIVEAWAY_MAX_PRIZES} мест
                </small>
              </div>
            </div>

            <div className="managed-giveaway__prize-editor-list">
              {draft.prizes.map((prizeTitle, index) => (
                <div key={`draft-prize-${index}`} className="managed-giveaway__prize-editor-row">
                  <span className="managed-giveaway__prize-position">{index + 1}</span>
                  <label className="field">
                    <input
                      type="text"
                      value={prizeTitle}
                      placeholder={`Приз #${index + 1}`}
                      maxLength={MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH}
                      onChange={(event) => {
                        setDraft((current) => {
                          if (!current) {
                            return current;
                          }
                          const nextPrizes = [...current.prizes];
                          nextPrizes[index] = event.target.value;
                          return {
                            ...current,
                            prizes: nextPrizes,
                          };
                        });
                        setValidationHint('');
                        setEditorError('');
                      }}
                      disabled={isBusy}
                    />
                  </label>
                  {draft.prizes.length > 1 ? (
                    <button
                      type="button"
                      className="managed-giveaway__prize-remove"
                      onClick={() =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                prizes: current.prizes.filter((_, prizeIndex) => prizeIndex !== index),
                              }
                            : current,
                        )
                      }
                      disabled={isBusy}
                      aria-label={`Удалить приз ${index + 1}`}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="managed-giveaway__section-actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={isBusy || draft.prizes.length >= MANAGED_GIVEAWAY_MAX_PRIZES}
                onClick={() =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          prizes: [...current.prizes, `${current.prizes.length + 1} место`],
                        }
                      : current,
                  )
                }
              >
                + Добавить место
              </button>
            </div>
          </div>

          {validationHint ? <div className="managed-giveaway__error-inline">{validationHint}</div> : null}
          {editorError ? <div className="managed-giveaway__error-inline">{editorError}</div> : null}

          <div className="managed-giveaway__editor-actions">
            <button type="button" className="button button--ghost" onClick={cancelEditorDraft} disabled={isBusy}>
              {cancelMutation.isPending ? 'Отменяем…' : 'Отменить черновик'}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                void saveEditor();
              }}
              disabled={isBusy || !canSaveEditor}
            >
              {createMutation.isPending || updateMutation.isPending ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button
              type="button"
              className="button button--accent"
              onClick={() => {
                void publishEditor();
              }}
              disabled={isBusy || !canPublishEditor}
            >
              {publishMutation.isPending ? 'Публикуем…' : 'Опубликовать'}
            </button>
          </div>
        </div>
        )
      ) : null}

      {listQuery.isLoading ? (
        <div className="managed-giveaway__empty">
          <strong>Загружаем…</strong>
        </div>
      ) : null}

      {listQuery.error ? (
        <div className="managed-giveaway__error-inline">
          <span>{formatApiError(listQuery.error, 'Не удалось загрузить розыгрыши.')}</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              void listQuery.refetch();
            }}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {!listQuery.isLoading && !listQuery.error && shouldShowCurrentSummary && currentItem ? (
        <div className={cn('managed-giveaway__panel', 'managed-giveaway__summary-card')}>
          <div className="managed-giveaway__summary-topline">
            <span className="managed-giveaway__eyebrow">Текущий</span>
            <span className={cn('managed-giveaway__badge', buildStatusTone(currentItem.status))}>
              {buildStatusLabel(currentItem.status)}
            </span>
          </div>

          <div className="managed-giveaway__summary-copy">
            <h4>{currentItem.title}</h4>
            <p>{buildCurrentSubtitle(currentItem)}</p>
          </div>

          <div className="managed-giveaway__stat-grid">
            <div className="managed-giveaway__stat-card">
              <span>Заявки</span>
              <strong>{currentItem.entriesCount}</strong>
            </div>
            <div className="managed-giveaway__stat-card">
              <span>Победители</span>
              <strong>{currentItem.winnersCount}</strong>
            </div>
            <div className="managed-giveaway__stat-card">
              <span>Обновлён</span>
              <strong>{formatCompactDate(currentItem.updatedAt)}</strong>
            </div>
          </div>

          <div className="managed-giveaway__chips">
            <span className="managed-giveaway__chip">
              Старт: {formatDateTime(currentItem.startsAt, 'сразу')}
            </span>
            <span className="managed-giveaway__chip">
              Финиш: {formatDateTime(currentItem.endsAt)}
            </span>
          </div>

          <div className="managed-giveaway__actions">
            {currentItem.status === 'DRAFT' ? (
              <button
                type="button"
                className="button button--accent"
                disabled={isBusy}
                onClick={startEditCurrentDraft}
              >
                Редактировать в miniapp
              </button>
            ) : null}

            <button
              type="button"
              className={cn('button', currentItem.status === 'DRAFT' ? 'button--ghost' : 'button--accent')}
              disabled={isBusy}
              onClick={() => {
                void handoffMutation.mutateAsync(currentItem.id);
              }}
            >
              Открыть в боте
            </button>

            {currentItem.publicationUrl ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => openMaxBotLink(currentItem.publicationUrl ?? '')}
              >
                Публикация
              </button>
            ) : null}

            {currentItem.resultsUrl ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => openMaxBotLink(currentItem.resultsUrl ?? '')}
              >
                Итоги
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {!listQuery.isLoading && !listQuery.error && !currentItem && historyItems.length === 0 ? (
        <div className="managed-giveaway__empty">
          <strong>Пока пусто</strong>
          <p>Создайте первый розыгрыш прямо здесь.</p>
        </div>
      ) : null}

      {historyItems.length > 0 ? (
        <div className="managed-giveaway__history">
          <button
            type="button"
            className="managed-giveaway__history-toggle"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((current) => !current)}
          >
            <span className="managed-giveaway__history-copy">
              <strong>История</strong>
              <small>{historyItems.length} записей</small>
            </span>
            <StepChevron isOpen={historyOpen} />
          </button>

          <div className={cn('settings-section__collapse', historyOpen && 'is-open')}>
            <div className="settings-section__collapse-inner">
              <div className="managed-giveaway__history-list">
                {historyItems.map((item) => (
                  <div key={item.id} className="managed-giveaway__history-row">
                    <button
                      type="button"
                      className="managed-giveaway__history-item"
                      disabled={isBusy}
                      onClick={() => {
                        void handoffMutation.mutateAsync(item.id);
                      }}
                    >
                      <span className="managed-giveaway__history-title">{item.title}</span>
                      <span className="managed-giveaway__history-meta">
                        <span
                          className={cn(
                            'managed-giveaway__badge',
                            item.status === 'CANCELED' ? 'is-danger' : 'is-muted',
                          )}
                        >
                          {buildHistoryLabel(item.status)}
                        </span>
                        <small>{formatCompactDate(item.completedAt ?? item.updatedAt)}</small>
                      </span>
                    </button>

                    <button
                      type="button"
                      className="managed-giveaway__history-delete"
                      aria-label={`Удалить розыгрыш ${item.title}`}
                      disabled={isBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteMutation.mutateAsync(item.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
