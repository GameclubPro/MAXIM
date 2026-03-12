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
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import type { ApiClient, UpdateManagedGiveawayPayload } from '../lib/api-client';
import { openMaxBotLink } from '../lib/max-bridge';
import { useToast } from './ui/toast';

const MAX_GIVEAWAY_IMAGE_SIZE_BYTES = 1_000_000;

type GiveawayDraft = UpdateManagedGiveawayPayload;
type ComposerMode = 'view' | 'create' | 'edit';
type ComposerStepKey = 'basics' | 'prizes' | 'timing' | 'cover';
type ManagedGiveawayHintKey = 'timing' | 'cover' | 'prizes';

type GiveawayDraftValidation = {
  title: string | null;
  claimHours: string | null;
  startsAt: string | null;
  endsAt: string | null;
  prizes: Array<string | null>;
  image: string | null;
  stepIssues: Record<ComposerStepKey, number>;
  firstError: string | null;
  hasErrors: boolean;
};

const COMPOSER_STEP_ORDER: ComposerStepKey[] = ['basics', 'prizes', 'timing', 'cover'];

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

function shortenText(value: string, maxLength = 40): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePrizeTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase().replace(/ё/gu, 'е');
}

function validateDraft(draft: GiveawayDraft): GiveawayDraftValidation {
  const stepIssues: Record<ComposerStepKey, number> = {
    basics: 0,
    prizes: 0,
    timing: 0,
    cover: 0,
  };

  let titleError: string | null = null;
  let claimHoursError: string | null = null;
  let startsAtError: string | null = null;
  let endsAtError: string | null = null;
  let imageError: string | null = null;
  const prizeErrors = draft.prizes.map(() => null as string | null);

  if (!draft.title.trim()) {
    titleError = 'Введите название розыгрыша.';
    stepIssues.basics += 1;
  }

  const claimHours = Number(draft.claimHours);
  if (!Number.isFinite(claimHours) || claimHours < 1 || claimHours > 336) {
    claimHoursError = 'Claim-окно должно быть от 1 до 336 часов.';
    stepIssues.timing += 1;
  }

  let startsAtTimestamp = Date.now();
  if (draft.startsAt) {
    startsAtTimestamp = Date.parse(draft.startsAt);
    if (!Number.isFinite(startsAtTimestamp)) {
      startsAtError = 'Укажите корректное время старта.';
      startsAtTimestamp = Date.now();
      stepIssues.timing += 1;
    }
  }

  const endsAtTimestamp = Date.parse(draft.endsAt);
  if (!Number.isFinite(endsAtTimestamp)) {
    endsAtError = 'Укажите корректное время завершения.';
    stepIssues.timing += 1;
  } else if (endsAtTimestamp <= startsAtTimestamp) {
    endsAtError = 'Завершение должно быть позже старта.';
    stepIssues.timing += 1;
  }

  const duplicateCounts = new Map<string, number>();
  draft.prizes.forEach((prize) => {
    const normalized = normalizePrizeTitle(prize.title);
    if (!normalized) {
      return;
    }
    duplicateCounts.set(normalized, (duplicateCounts.get(normalized) ?? 0) + 1);
  });

  draft.prizes.forEach((prize, index) => {
    const normalized = normalizePrizeTitle(prize.title);
    if (!normalized) {
      prizeErrors[index] = 'Введите название приза.';
      stepIssues.prizes += 1;
      return;
    }

    if ((duplicateCounts.get(normalized) ?? 0) > 1) {
      prizeErrors[index] = 'Название приза повторяется.';
      stepIssues.prizes += 1;
    }
  });

  if (draft.imageEnabled) {
    if (!draft.imageBase64.trim()) {
      imageError = 'Добавьте изображение для обложки.';
      stepIssues.cover += 1;
    } else if (
      !draft.imageMimeType.trim() ||
      !draft.imageMimeType.toLowerCase().startsWith('image/')
    ) {
      imageError = 'Поддерживаются только изображения.';
      stepIssues.cover += 1;
    }
  }

  const firstError =
    titleError ??
    prizeErrors.find((error): error is string => Boolean(error)) ??
    startsAtError ??
    endsAtError ??
    claimHoursError ??
    imageError ??
    null;

  const hasErrors =
    Boolean(titleError) ||
    Boolean(claimHoursError) ||
    Boolean(startsAtError) ||
    Boolean(endsAtError) ||
    Boolean(imageError) ||
    prizeErrors.some(Boolean);

  return {
    title: titleError,
    claimHours: claimHoursError,
    startsAt: startsAtError,
    endsAt: endsAtError,
    prizes: prizeErrors,
    image: imageError,
    stepIssues,
    firstError,
    hasErrors,
  };
}

function buildComposerStepSummary(
  step: ComposerStepKey,
  draft: GiveawayDraft,
  validation: GiveawayDraftValidation,
): string {
  switch (step) {
    case 'basics':
      return `${draft.title.trim() ? shortenText(draft.title, 32) : 'без названия'} · ${
        draft.description.trim() ? 'описание готово' : 'без описания'
      }`;
    case 'prizes': {
      const filled = draft.prizes.filter((prize) => prize.title.trim()).length;
      return `${draft.prizes.length} мест · ${filled}/${draft.prizes.length} заполнено`;
    }
    case 'timing':
      return `${
        draft.startsAt ? formatDateTimeLabel(draft.startsAt) : 'сразу'
      } -> ${formatDateTimeLabel(draft.endsAt)}`;
    case 'cover':
      return draft.imageEnabled ? draft.imageFileName || 'обложка загружена' : 'без обложки';
    default:
      return validation.hasErrors ? 'Нужно проверить поля' : 'Готово';
  }
}

function buildComposerOverview(
  draft: GiveawayDraft,
  validation: GiveawayDraftValidation,
  mode: ComposerMode,
): { title: string; subtitle: string; meta: string[] } {
  const invalidSteps = COMPOSER_STEP_ORDER.filter((step) => validation.stepIssues[step] > 0).length;

  return {
    title: draft.title.trim() || (mode === 'edit' ? 'Редактирование черновика' : 'Новый черновик'),
    subtitle:
      invalidSteps > 0
        ? `Нужно проверить ${invalidSteps} ${
            invalidSteps === 1 ? 'раздел' : invalidSteps < 5 ? 'раздела' : 'разделов'
          }`
        : 'Форма готова к сохранению и передаче в бота',
    meta: [
      `Призы: ${draft.prizes.length}`,
      `Финиш: ${formatDateTimeLabel(draft.endsAt)}`,
      `Claim: ${draft.claimHours} ч`,
    ],
  };
}

function buildViewOverview(
  giveaway: ManagedGiveawayDetails | ManagedGiveawaySummary | null,
  entityType: 'chat' | 'channel',
): { title: string; subtitle: string; meta: string[] } {
  if (!giveaway) {
    return {
      title: 'Розыгрышей пока нет',
      subtitle: `Создайте первый черновик для ${getEntityLabel(entityType)}.`,
      meta: ['Статус: пусто', 'Заявки: 0', 'Победители: 0'],
    };
  }

  return {
    title: giveaway.title,
    subtitle: `${buildStatusLabel(giveaway.status)} · ${giveaway.entriesCount} заявок`,
    meta: [
      `Победители: ${giveaway.winnersCount}`,
      `Финиш: ${formatDateTimeLabel(giveaway.endsAt)}`,
      giveaway.startsAt ? `Старт: ${formatDateTimeLabel(giveaway.startsAt)}` : 'Старт: сразу',
    ],
  };
}

function ManagedGiveawayInfoButton({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
}: {
  hintKey: ManagedGiveawayHintKey;
  openHintKey: ManagedGiveawayHintKey | null;
  onToggleHint: (hintKey: ManagedGiveawayHintKey) => void;
  label: string;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <button
      type="button"
      className={cn('settings-info-button', isOpen && 'is-open')}
      aria-label={label}
      aria-controls={`managed-giveaway-hint-${hintKey}`}
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

function ManagedGiveawayHintAnchor({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
  children,
}: {
  hintKey: ManagedGiveawayHintKey;
  openHintKey: ManagedGiveawayHintKey | null;
  onToggleHint: (hintKey: ManagedGiveawayHintKey) => void;
  label: string;
  children: string;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <span className="channel-settings-hint-anchor">
      <ManagedGiveawayInfoButton
        hintKey={hintKey}
        openHintKey={openHintKey}
        onToggleHint={onToggleHint}
        label={label}
      />
      {isOpen ? (
        <span id={`managed-giveaway-hint-${hintKey}`} className="channel-settings-hint-popover">
          {children}
        </span>
      ) : null}
    </span>
  );
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

function ManagedGiveawayStep({
  title,
  summary,
  isOpen,
  hasError,
  onToggle,
  hintKey,
  openHintKey,
  onToggleHint,
  hintLabel,
  hintText,
  children,
}: {
  title: string;
  summary: string;
  isOpen: boolean;
  hasError: boolean;
  onToggle: () => void;
  hintKey?: ManagedGiveawayHintKey;
  openHintKey: ManagedGiveawayHintKey | null;
  onToggleHint: (hintKey: ManagedGiveawayHintKey) => void;
  hintLabel?: string;
  hintText?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn('managed-giveaway__step', hasError && 'is-error', isOpen && 'is-open')}>
      <div className="managed-giveaway__step-head">
        <button
          type="button"
          className={cn('managed-giveaway__step-toggle', hasError && 'is-error')}
          aria-expanded={isOpen}
          onClick={onToggle}
        >
          <span className="managed-giveaway__step-main">
            <strong>{title}</strong>
            <small>{summary}</small>
          </span>
          <StepChevron isOpen={isOpen} />
        </button>
        {hintKey && hintLabel && hintText ? (
          <ManagedGiveawayHintAnchor
            hintKey={hintKey}
            openHintKey={openHintKey}
            onToggleHint={onToggleHint}
            label={hintLabel}
          >
            {hintText}
          </ManagedGiveawayHintAnchor>
        ) : null}
      </div>
      <div className={cn('settings-section__collapse', isOpen && 'is-open')}>
        <div className="settings-section__collapse-inner managed-giveaway__step-body">{children}</div>
      </div>
    </section>
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

  const [mode, setMode] = useState<ComposerMode>('view');
  const [selectedGiveawayId, setSelectedGiveawayId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GiveawayDraft | null>(null);
  const [openStep, setOpenStep] = useState<ComposerStepKey>('basics');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [openHintKey, setOpenHintKey] = useState<ManagedGiveawayHintKey | null>(null);

  const isComposing = mode === 'create' || mode === 'edit';
  useHintPopoverAutoPosition(openHintKey !== null);

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
    if (isComposing) {
      return;
    }

    if (!giveaways.length) {
      if (selectedGiveawayId !== null) {
        setSelectedGiveawayId(null);
      }
      return;
    }

    if (selectedGiveawayId && giveaways.some((item) => item.id === selectedGiveawayId)) {
      return;
    }

    setSelectedGiveawayId((currentGiveaway ?? giveaways[0]).id);
  }, [currentGiveaway, giveaways, isComposing, selectedGiveawayId]);

  useEffect(() => {
    if (isComposing) {
      setHistoryOpen(false);
    }
  }, [isComposing]);

  const detailQuery = useQuery({
    queryKey: ['managed-giveaway', entityType, entityId, selectedGiveawayId] as const,
    queryFn: () => api.getManagedGiveaway(entityType, entityId, selectedGiveawayId ?? ''),
    enabled: Boolean(entityId && selectedGiveawayId),
    refetchOnWindowFocus: false,
  });

  const selectedGiveaway = detailQuery.data ?? null;
  const selectedSummary = giveaways.find((item) => item.id === selectedGiveawayId) ?? null;
  const visibleSummary = selectedSummary ?? currentGiveaway ?? giveaways[0] ?? null;
  const historyGiveaways = giveaways.filter(
    (item) => item.id !== (selectedGiveawayId ?? currentGiveaway?.id ?? null),
  );
  const canCreateNew = !currentGiveaway || ['COMPLETED', 'CANCELED'].includes(currentGiveaway.status);
  const draftValidation = useMemo(
    () => (draft ? validateDraft(draft) : null),
    [draft],
  );

  const invalidateGiveawayQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['managed-giveaways', entityType, entityId] }),
      queryClient.invalidateQueries({ queryKey: ['managed-giveaway', entityType, entityId] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: (payload: GiveawayDraft) => api.createManagedGiveaway(entityType, entityId, payload),
    onSuccess: async (created) => {
      setSelectedGiveawayId(created.id);
      setMode('edit');
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
      setSelectedGiveawayId(updated.id);
      setMode('edit');
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
    listQuery.isFetching ||
    detailQuery.isFetching ||
    createMutation.isPending ||
    updateMutation.isPending ||
    handoffMutation.isPending;

  const toggleHint = (hintKey: ManagedGiveawayHintKey) => {
    setOpenHintKey((current) => (current === hintKey ? null : hintKey));
  };

  const openComposerStep = (step: ComposerStepKey) => {
    setOpenStep((current) => (current === step ? current : step));
  };

  const startNewDraft = () => {
    setMode('create');
    setDraft(createDefaultDraft());
    setOpenStep('basics');
    setShowErrors(false);
    setOpenHintKey(null);
  };

  const startEditing = () => {
    if (!selectedGiveaway || selectedGiveaway.status !== 'DRAFT') {
      return;
    }

    setMode('edit');
    setDraft(toDraft(selectedGiveaway));
    setOpenStep('basics');
    setShowErrors(false);
    setOpenHintKey(null);
  };

  const cancelComposer = () => {
    setMode('view');
    setDraft(null);
    setShowErrors(false);
    setOpenHintKey(null);
  };

  const handleDraftChange = <K extends keyof GiveawayDraft>(key: K, value: GiveawayDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const handlePrizeChange = (index: number, title: string) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        prizes: current.prizes.map((prize, prizeIndex) =>
          prizeIndex === index ? { ...prize, title } : prize,
        ),
      };
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

      return {
        ...current,
        prizes: current.prizes
          .filter((_, prizeIndex) => prizeIndex !== index)
          .map((prize, prizeIndex) => ({
            ...prize,
            position: prizeIndex + 1,
          })),
      };
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

  const ensureDraftValid = () => {
    if (!draft || !draftValidation) {
      return false;
    }

    if (!draftValidation.hasErrors) {
      return true;
    }

    setShowErrors(true);
    const firstInvalidStep =
      COMPOSER_STEP_ORDER.find((step) => draftValidation.stepIssues[step] > 0) ?? 'basics';
    setOpenStep(firstInvalidStep);
    pushToast({
      tone: 'danger',
      title: 'Проверьте поля',
      description: draftValidation.firstError ?? 'Форма заполнена не полностью.',
    });
    return false;
  };

  const persistDraft = async (): Promise<ManagedGiveawayDetails | null> => {
    if (!draft || !ensureDraftValid()) {
      return null;
    }

    if (mode === 'edit' && selectedGiveaway?.status === 'DRAFT') {
      return updateMutation.mutateAsync({
        giveawayId: selectedGiveaway.id,
        payload: draft,
      });
    }

    return createMutation.mutateAsync(draft);
  };

  const saveDraft = async () => {
    try {
      await persistDraft();
    } catch {
      // Mutation toasts are already shown in onError handlers.
    }
  };

  const continueInBot = async () => {
    try {
      let giveawayId = selectedGiveaway?.id ?? null;

      if (isComposing) {
        const saved = await persistDraft();
        giveawayId = saved?.id ?? giveawayId;
      }

      if (!giveawayId) {
        pushToast({
          tone: 'danger',
          title: 'Черновик не выбран',
          description: 'Сначала откройте розыгрыш или создайте новый черновик.',
        });
        return;
      }

      const result = await handoffMutation.mutateAsync(giveawayId);
      setMode('view');
      setDraft(null);
      setShowErrors(false);
      setOpenHintKey(null);
      openMaxBotLink(result.botUrl);
    } catch {
      // Mutation toasts are already shown in onError handlers.
    }
  };

  const refreshGiveaways = () => {
    void listQuery.refetch();
    if (selectedGiveawayId) {
      void detailQuery.refetch();
    }
  };

  const composerOverview = draft && draftValidation ? buildComposerOverview(draft, draftValidation, mode) : null;
  const viewOverview = buildViewOverview(visibleSummary, entityType);
  const overviewTone = isComposing
    ? 'warning'
    : visibleSummary
      ? buildStatusTone(visibleSummary.status)
      : 'muted';
  const overviewStatusLabel = isComposing
    ? mode === 'edit'
      ? 'Черновик'
      : 'Новый'
    : visibleSummary
      ? buildStatusLabel(visibleSummary.status)
      : 'Пусто';
  const canContinueInBot =
    !isComposing || Boolean(draft && draftValidation && !draftValidation.hasErrors);
  const coverPreviewSrc =
    draft?.imageEnabled && draft.imageBase64
      ? `data:${draft.imageMimeType || 'image/jpeg'};base64,${draft.imageBase64}`
      : null;

  return (
    <div className="managed-giveaway">
      <div className="managed-giveaway__header">
        <div className="managed-giveaway__header-copy">
          <div className="managed-giveaway__title">Розыгрыши</div>
          <div className="managed-giveaway__subtitle">
            {isComposing
              ? 'Соберите черновик и передайте публикацию в личку бота'
              : 'Черновик, публикация, итоги и работа с победителями'}
          </div>
        </div>

        {!isComposing && canCreateNew ? (
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

      <div className="managed-giveaway__overview-card">
        <div className="managed-giveaway__overview-main">
          <div className="managed-giveaway__overview-topline">
            <span className={cn('managed-giveaway__badge', `is-${overviewTone}`)}>
              {overviewStatusLabel}
            </span>
            <span className="managed-giveaway__overview-kicker">
              {isComposing ? 'miniapp -> бот' : `${getEntityLabel(entityType)} · hybrid-flow`}
            </span>
          </div>
          <strong>{isComposing && composerOverview ? composerOverview.title : viewOverview.title}</strong>
          <span>{isComposing && composerOverview ? composerOverview.subtitle : viewOverview.subtitle}</span>
        </div>
        <div className="managed-giveaway__overview-meta">
          {(isComposing && composerOverview ? composerOverview.meta : viewOverview.meta).map((item) => (
            <span key={item} className="managed-giveaway__overview-chip">
              {item}
            </span>
          ))}
        </div>
      </div>

      {listQuery.isLoading ? (
        <div className="managed-giveaway__empty">Загружаем розыгрыши...</div>
      ) : null}

      {listQuery.error ? (
        <div className="managed-giveaway__empty is-danger">{formatApiError(listQuery.error)}</div>
      ) : null}

      {!listQuery.isLoading &&
      !listQuery.error &&
      !isComposing &&
      !selectedGiveawayId &&
      giveaways.length === 0 ? (
        <div className="managed-giveaway__empty">
          <p>Запустите первый розыгрыш для этого {getEntityLabel(entityType)}.</p>
          <button type="button" className="button button--accent" onClick={startNewDraft}>
            Создать черновик
          </button>
        </div>
      ) : null}

      {isComposing && draft && draftValidation ? (
        <div className="managed-giveaway__composer">
          <ManagedGiveawayStep
            title="Основное"
            summary={buildComposerStepSummary('basics', draft, draftValidation)}
            isOpen={openStep === 'basics'}
            hasError={showErrors && draftValidation.stepIssues.basics > 0}
            onToggle={() => openComposerStep('basics')}
            openHintKey={openHintKey}
            onToggleHint={toggleHint}
          >
            <div className="managed-giveaway__grid">
              <label
                className={cn(
                  'field settings-text-field',
                  showErrors && draftValidation.title && 'field--error',
                )}
              >
                <span>Название</span>
                <input
                  type="text"
                  value={draft.title}
                  maxLength={MANAGED_GIVEAWAY_TITLE_MAX_LENGTH}
                  onChange={(event) => handleDraftChange('title', event.target.value)}
                  placeholder="Например: Весенний розыгрыш"
                />
                {showErrors && draftValidation.title ? (
                  <small className="field__hint">{draftValidation.title}</small>
                ) : null}
              </label>

              <label className="field settings-text-field">
                <span>Описание</span>
                <textarea
                  rows={4}
                  maxLength={MANAGED_GIVEAWAY_DESCRIPTION_MAX_LENGTH}
                  value={draft.description}
                  onChange={(event) => handleDraftChange('description', event.target.value)}
                  placeholder="Коротко объясните, что разыгрываете и какие условия участия."
                />
              </label>
            </div>
          </ManagedGiveawayStep>

          <ManagedGiveawayStep
            title="Призы"
            summary={buildComposerStepSummary('prizes', draft, draftValidation)}
            isOpen={openStep === 'prizes'}
            hasError={showErrors && draftValidation.stepIssues.prizes > 0}
            onToggle={() => openComposerStep('prizes')}
            hintKey="prizes"
            openHintKey={openHintKey}
            onToggleHint={toggleHint}
            hintLabel="Подсказка по призовым местам"
            hintText="Призы задают порядок победителей. После завершения бот автоматически назначит места сверху вниз и позволит сделать reroll по любому непринятому месту."
          >
            <div className="managed-giveaway__prizes">
              {draft.prizes.map((prize, index) => (
                <label
                  key={`prize-${prize.position}`}
                  className={cn(
                    'managed-giveaway__prize-row',
                    showErrors && draftValidation.prizes[index] && 'field--error',
                  )}
                >
                  <span className="managed-giveaway__prize-position">{prize.position}</span>
                  <div className="managed-giveaway__prize-field">
                    <input
                      type="text"
                      value={prize.title}
                      maxLength={MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH}
                      onChange={(event) => handlePrizeChange(index, event.target.value)}
                      placeholder={`Приз за ${prize.position} место`}
                    />
                    {showErrors && draftValidation.prizes[index] ? (
                      <small className="field__hint">{draftValidation.prizes[index]}</small>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={draft.prizes.length <= 1}
                    onClick={() => removePrize(index)}
                  >
                    Удалить
                  </button>
                </label>
              ))}
            </div>

            <button
              type="button"
              className="button button--ghost"
              disabled={draft.prizes.length >= MANAGED_GIVEAWAY_MAX_PRIZES}
              onClick={addPrize}
            >
              Добавить место
            </button>
          </ManagedGiveawayStep>

          <ManagedGiveawayStep
            title="Тайминг"
            summary={buildComposerStepSummary('timing', draft, draftValidation)}
            isOpen={openStep === 'timing'}
            hasError={showErrors && draftValidation.stepIssues.timing > 0}
            onToggle={() => openComposerStep('timing')}
            hintKey="timing"
            openHintKey={openHintKey}
            onToggleHint={toggleHint}
            hintLabel="Подсказка по таймингу"
            hintText="Если старт не задан, розыгрыш начнётся сразу после публикации. Claim-окно определяет, сколько часов победитель может подтвердить приз в личке бота."
          >
            <div className="managed-giveaway__grid">
              <label
                className={cn(
                  'field settings-text-field',
                  showErrors && draftValidation.startsAt && 'field--error',
                )}
              >
                <span>Старт</span>
                <input
                  type="datetime-local"
                  value={toLocalDateTimeInputValue(draft.startsAt)}
                  onChange={(event) =>
                    handleDraftChange('startsAt', fromLocalDateTimeInputValue(event.target.value))
                  }
                />
                {showErrors && draftValidation.startsAt ? (
                  <small className="field__hint">{draftValidation.startsAt}</small>
                ) : null}
              </label>

              <label
                className={cn(
                  'field settings-text-field',
                  showErrors && draftValidation.endsAt && 'field--error',
                )}
              >
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
                {showErrors && draftValidation.endsAt ? (
                  <small className="field__hint">{draftValidation.endsAt}</small>
                ) : null}
              </label>

              <label
                className={cn(
                  'field settings-text-field',
                  showErrors && draftValidation.claimHours && 'field--error',
                )}
              >
                <span>Claim-окно, часы</span>
                <input
                  type="number"
                  min={1}
                  max={336}
                  value={draft.claimHours}
                  onChange={(event) =>
                    handleDraftChange(
                      'claimHours',
                      Math.min(336, Math.max(1, Number(event.target.value) || 1)),
                    )
                  }
                />
                {showErrors && draftValidation.claimHours ? (
                  <small className="field__hint">{draftValidation.claimHours}</small>
                ) : null}
              </label>
            </div>
          </ManagedGiveawayStep>

          <ManagedGiveawayStep
            title="Обложка"
            summary={buildComposerStepSummary('cover', draft, draftValidation)}
            isOpen={openStep === 'cover'}
            hasError={showErrors && draftValidation.stepIssues.cover > 0}
            onToggle={() => openComposerStep('cover')}
            hintKey="cover"
            openHintKey={openHintKey}
            onToggleHint={toggleHint}
            hintLabel="Подсказка по обложке"
            hintText="Обложка нужна только если розыгрышу нужен визуальный акцент в посте. Лимит - до 1 MB после подготовки изображения."
          >
            <div className="managed-giveaway__cover-actions">
              <label
                className={cn(
                  'field settings-text-field mailing-upload-field',
                  showErrors && draftValidation.image && 'field--error',
                )}
              >
                <span>Фото до 1 MB</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    void handleImageUpload(event.target.files?.[0] ?? null);
                    event.currentTarget.value = '';
                  }}
                />
                {showErrors && draftValidation.image ? (
                  <small className="field__hint">{draftValidation.image}</small>
                ) : null}
              </label>

              {draft.imageEnabled ? (
                <div className="managed-giveaway__cover-preview">
                  {coverPreviewSrc ? (
                    <img
                      src={coverPreviewSrc}
                      alt="Превью обложки розыгрыша"
                      className="managed-giveaway__cover-image"
                    />
                  ) : null}
                  <div className="managed-giveaway__cover-loaded">
                    <span>{draft.imageFileName || 'Файл загружен'}</span>
                    <button type="button" className="button button--ghost" onClick={clearImage}>
                      Убрать
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </ManagedGiveawayStep>

          <div className="managed-giveaway__composer-bar">
            <button
              type="button"
              className="button button--ghost"
              disabled={isBusy}
              onClick={cancelComposer}
            >
              Назад
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={isBusy}
              onClick={() => {
                void saveDraft();
              }}
            >
              Сохранить
            </button>
            <button
              type="button"
              className="button button--accent"
              disabled={isBusy || !canContinueInBot}
              onClick={() => {
                void continueInBot();
              }}
            >
              В бота
            </button>
          </div>
        </div>
      ) : null}

      {!isComposing && selectedGiveawayId && detailQuery.isLoading ? (
        <div className="managed-giveaway__panel">Загружаем розыгрыш...</div>
      ) : null}

      {!isComposing && detailQuery.error ? (
        <div className="managed-giveaway__empty is-danger">
          <p>{formatApiError(detailQuery.error)}</p>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              void detailQuery.refetch();
            }}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {!isComposing && selectedGiveaway ? (
        <div className="managed-giveaway__panel">
          <div className="managed-giveaway__summary-head">
            <div className="managed-giveaway__section-copy">
              <h4>{selectedGiveaway.title}</h4>
              <div className={cn('managed-giveaway__badge', `is-${buildStatusTone(selectedGiveaway.status)}`)}>
                {buildStatusLabel(selectedGiveaway.status)}
              </div>
            </div>
            <div className="managed-giveaway__meta">
              <span>{selectedGiveaway.entriesCount} заявок</span>
              <span>{selectedGiveaway.winnersCount} победителей</span>
            </div>
          </div>

          {selectedGiveaway.description.trim() ? (
            <div className="managed-giveaway__details">
              <p>{selectedGiveaway.description}</p>
            </div>
          ) : null}

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

          {selectedGiveaway.winners.length > 0 ? (
            <div className="managed-giveaway__winners">
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
              disabled={isBusy}
              onClick={refreshGiveaways}
            >
              Обновить
            </button>
            {selectedGiveaway.status === 'DRAFT' ? (
              <button
                type="button"
                className="button button--ghost"
                disabled={isBusy}
                onClick={startEditing}
              >
                Править
              </button>
            ) : null}
            {selectedGiveaway.publicationUrl ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => openMaxBotLink(selectedGiveaway.publicationUrl ?? '')}
              >
                Открыть пост
              </button>
            ) : null}
            {selectedGiveaway.resultsUrl ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => openMaxBotLink(selectedGiveaway.resultsUrl ?? '')}
              >
                Итоги
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
              В бота
            </button>
          </div>
        </div>
      ) : null}

      {!isComposing && historyGiveaways.length > 0 ? (
        <div className="managed-giveaway__history">
          <button
            type="button"
            className="managed-giveaway__history-toggle"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((current) => !current)}
          >
            <span className="managed-giveaway__history-copy">
              <strong>Другие розыгрыши</strong>
              <small>{historyGiveaways.length} карточек в списке</small>
            </span>
            <StepChevron isOpen={historyOpen} />
          </button>

          <div className={cn('settings-section__collapse', historyOpen && 'is-open')}>
            <div className="settings-section__collapse-inner">
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
                      setSelectedGiveawayId(item.id);
                    }}
                  >
                    <span>{item.title}</span>
                    <small>
                      {buildStatusLabel(item.status)} ·{' '}
                      {formatDateTimeLabel(item.completedAt ?? item.endsAt)}
                    </small>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
