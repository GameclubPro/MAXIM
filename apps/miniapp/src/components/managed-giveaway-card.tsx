import {
  type ChatSummary,
  MANAGED_GIVEAWAY_MAX_PRIZES,
  MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS,
  MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH,
  MANAGED_GIVEAWAY_TITLE_MAX_LENGTH,
  type ManagedGiveawayDetails,
  type ManagedGiveawaySummary,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { getChannels } from '../lib/api/root-client';
import {
  cancelManagedGiveaway,
  createManagedGiveaway,
  deleteManagedGiveaway,
  getManagedGiveaway,
  getManagedGiveaways,
  handoffManagedGiveaway,
  publishManagedGiveaway,
  updateManagedGiveaway,
} from '../lib/api/managed-giveaway-client';
import type { ApiTransport } from '../lib/api/transport';
import type { UpdateManagedGiveawayPayload } from '../lib/api/shared-types';
import { cn } from '../lib/cn';
import { openMaxBotLink } from '../lib/max-bridge';
import { useToast } from './ui/toast';

const MIN_CLAIM_HOURS = 1;
const MAX_CLAIM_HOURS = 336;
const CLAIM_HOUR_PRESETS = [24, 48, 72, 168] as const;
const FINISH_PRESETS = [
  { hours: 24, label: '24 часа' },
  { hours: 48, label: '48 часов' },
  { hours: 168, label: '7 дней' },
] as const;

type GiveawayEditorMode = 'closed' | 'create' | 'edit';
type GiveawayEditorStepId = 'basics' | 'conditions' | 'prizes';
type GiveawayValidationResult = { valid: boolean; message: string };
type SummaryMetric = { key: string; label: string; value: string; note: string };

type GiveawayEditorDraft = {
  title: string;
  description: string;
  startsAtLocal: string;
  endsAtLocal: string;
  claimHours: number;
  requiredChannelIds: string[];
  prizes: string[];
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
};

const GIVEAWAY_EDITOR_STEPS = [
  {
    id: 'basics',
    label: 'Основа',
    title: 'Название и сроки',
    description: 'Название и тайминг.',
  },
  {
    id: 'conditions',
    label: 'Условия',
    title: 'Кто участвует',
    description: 'Источник и каналы.',
  },
  {
    id: 'prizes',
    label: 'Призы',
    title: 'Сколько мест и что получат',
    description: 'Места и призы.',
  },
] as const satisfies ReadonlyArray<{
  id: GiveawayEditorStepId;
  label: string;
  title: string;
  description: string;
}>;

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

function formatCount(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatDateTimeInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimeInputValue(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
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

function roundToNextQuarter(date: Date): Date {
  const rounded = new Date(date.getTime() + 15 * 60 * 1000);
  rounded.setSeconds(0, 0);
  const remainder = rounded.getMinutes() % 15;
  if (remainder !== 0) {
    rounded.setMinutes(rounded.getMinutes() + (15 - remainder));
  }
  return rounded;
}

function readDateInputPart(value: string): string {
  const parsed = parseDateTimeInput(value);
  return parsed ? formatDateInputValue(parsed) : '';
}

function readTimeInputPart(value: string, fallback = '12:00'): string {
  const parsed = parseDateTimeInput(value);
  return parsed ? formatTimeInputValue(parsed) : fallback;
}

function mergeDateAndTime(dateValue: string, timeValue: string, fallbackDate: Date): string {
  if (!dateValue) {
    return '';
  }

  const safeTime = /^\d{2}:\d{2}$/u.test(timeValue)
    ? timeValue
    : formatTimeInputValue(fallbackDate);
  const [hours, minutes] = safeTime.split(':').map((item) => Number.parseInt(item, 10) || 0);
  const merged = new Date(`${dateValue}T00:00`);
  merged.setHours(hours, minutes, 0, 0);
  return formatDateTimeInputValue(merged);
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

function formatCompactInputDateTime(value: string, fallback = 'не задано'): string {
  const parsed = parseDateTimeInput(value);
  if (!parsed) {
    return fallback;
  }

  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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
    requiredChannelIds: [],
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
    requiredChannelIds: giveaway.requiredChannelIds.filter(
      (item) => item !== giveaway.sourceChatId,
    ),
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

function normalizeChannelId(value: string): string {
  return value.trim().replace(/\s+/gu, '');
}

function normalizeChannelLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const withProtocol = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    const path = parsed.pathname.replace(/\/+$/u, '');
    return `${host}${path}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function validateBasicsDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  if (!draft.title.trim()) {
    return { valid: false, message: 'Введите название.' };
  }

  if (!draft.endsAtLocal.trim()) {
    return { valid: false, message: 'Укажите дату и время финиша.' };
  }

  const startsAt = draft.startsAtLocal.trim() ? parseDateTimeInput(draft.startsAtLocal) : null;
  if (draft.startsAtLocal.trim() && !startsAt) {
    return { valid: false, message: 'Проверьте дату старта.' };
  }

  const endsAt = parseDateTimeInput(draft.endsAtLocal);
  if (!endsAt) {
    return { valid: false, message: 'Проверьте дату финиша.' };
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
    return {
      valid: false,
      message: `Срок подтверждения: от ${MIN_CLAIM_HOURS} до ${MAX_CLAIM_HOURS} часов.`,
    };
  }

  return { valid: true, message: '' };
}

function validateConditionsDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  if (draft.requiredChannelIds.length > MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS) {
    return {
      valid: false,
      message: `Доп. каналов: максимум ${MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}.`,
    };
  }

  const normalizedRequiredChannels = draft.requiredChannelIds.map((item) =>
    normalizeChannelId(item),
  );
  if (normalizedRequiredChannels.some((item) => !item)) {
    return { valid: false, message: 'Проверьте список доп. каналов.' };
  }

  if (
    new Set(normalizedRequiredChannels.map((item) => item.toLowerCase())).size !==
    normalizedRequiredChannels.length
  ) {
    return { valid: false, message: 'Доп. каналы не должны повторяться.' };
  }

  return { valid: true, message: '' };
}

function validatePrizesDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  if (draft.prizes.length < 1 || draft.prizes.length > MANAGED_GIVEAWAY_MAX_PRIZES) {
    return { valid: false, message: `Количество мест: от 1 до ${MANAGED_GIVEAWAY_MAX_PRIZES}.` };
  }

  const trimmedPrizes = draft.prizes.map((item) => item.trim());
  if (trimmedPrizes.some((item) => !item)) {
    return { valid: false, message: 'Заполните все призы.' };
  }

  const normalized = trimmedPrizes.map((item) => normalizePrizeKey(item));
  if (new Set(normalized).size !== normalized.length) {
    return { valid: false, message: 'Названия призов не должны повторяться.' };
  }

  return { valid: true, message: '' };
}

function validateMediaDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  if (draft.imageEnabled && (!draft.imageBase64.trim() || !draft.imageMimeType.trim())) {
    return { valid: false, message: 'Не удалось использовать сохранённое изображение.' };
  }

  return { valid: true, message: '' };
}

function validateDraft(draft: GiveawayEditorDraft): GiveawayValidationResult {
  const basicValidation = validateBasicsDraft(draft);
  if (!basicValidation.valid) {
    return basicValidation;
  }

  const conditionsValidation = validateConditionsDraft(draft);
  if (!conditionsValidation.valid) {
    return conditionsValidation;
  }

  const prizesValidation = validatePrizesDraft(draft);
  if (!prizesValidation.valid) {
    return prizesValidation;
  }

  return validateMediaDraft(draft);
}

function buildDraftTitleSummary(title: string): string {
  const trimmed = title.trim();
  return trimmed || 'Без названия';
}

function buildBasicsSummary(draft: GiveawayEditorDraft): string {
  return `${buildDraftTitleSummary(draft.title)} • ${formatCompactInputDateTime(draft.endsAtLocal, 'без финиша')}`;
}

function buildConditionsSummary(
  draft: GiveawayEditorDraft,
  selectedRequiredChannels: Array<{ id: string; title: string }>,
): string {
  if (draft.requiredChannelIds.length === 0) {
    return 'Только источник';
  }

  if (draft.requiredChannelIds.length === 1) {
    const onlyChannel = selectedRequiredChannels[0]?.title?.trim() || '1 доп. канал';
    return `Источник + ${onlyChannel}`;
  }

  return `Источник + ${draft.requiredChannelIds.length} канала`;
}

function buildPrizesSummary(draft: GiveawayEditorDraft): string {
  if (draft.prizes.length === 1) {
    return draft.prizes[0]?.trim() || '1 место';
  }

  return `${draft.prizes.length} места`;
}

function toUpdatePayload(draft: GiveawayEditorDraft): UpdateManagedGiveawayPayload {
  const startsAtDate = draft.startsAtLocal.trim() ? parseDateTimeInput(draft.startsAtLocal) : null;
  const endsAtDate = parseDateTimeInput(draft.endsAtLocal);
  if (!endsAtDate) {
    throw new Error('Проверьте дату финиша.');
  }
  if (draft.startsAtLocal.trim() && !startsAtDate) {
    throw new Error('Проверьте дату старта.');
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
    requiredChannelIds: Array.from(
      new Set(
        draft.requiredChannelIds
          .map((item) => normalizeChannelId(item))
          .filter((item) => item.length > 0),
      ),
    ),
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
    return 'Загружаем...';
  }
  if (params.busy) {
    return 'Сохраняем…';
  }
  if (params.mode === 'create') {
    return 'Заполните и публикуйте';
  }
  if (params.isDirty) {
    return 'Есть изменения';
  }
  return 'Сохранено';
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
  api: ApiTransport;
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
  const [editorStep, setEditorStep] = useState<GiveawayEditorStepId>('basics');
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [channelLinkValue, setChannelLinkValue] = useState('');
  const [awaitingBotSync, setAwaitingBotSync] = useState(false);

  const listQueryKey = useMemo(
    () => ['managed-giveaways', entityType, entityId] as const,
    [entityId, entityType],
  );

  const listQuery = useQuery({
    queryKey: listQueryKey,
    queryFn: () => getManagedGiveaways(api, entityType, entityId),
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
      return getManagedGiveaway(api, entityType, entityId, editingGiveawayId);
    },
    enabled: editorMode === 'edit' && Boolean(entityId) && Boolean(editingGiveawayId),
    refetchOnWindowFocus: false,
  });

  const channelsQuery = useQuery({
    queryKey: ['giveaway-owned-channels'] as const,
    queryFn: () => getChannels(api),
    enabled: editorMode !== 'closed',
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
  const savedKey = useMemo(
    () => (savedSnapshot ? JSON.stringify(savedSnapshot) : ''),
    [savedSnapshot],
  );
  const isDirty =
    editorMode === 'edit' ? Boolean(draft && savedSnapshot && draftKey !== savedKey) : true;
  const blankValidation = useMemo<GiveawayValidationResult>(
    () => ({ valid: false, message: 'Черновик не заполнен.' }),
    [],
  );
  const basicsValidation = useMemo(
    () => (draft ? validateBasicsDraft(draft) : blankValidation),
    [blankValidation, draft],
  );
  const conditionsValidation = useMemo(
    () => (draft ? validateConditionsDraft(draft) : blankValidation),
    [blankValidation, draft],
  );
  const prizesValidation = useMemo(
    () => (draft ? validatePrizesDraft(draft) : blankValidation),
    [blankValidation, draft],
  );
  const mediaValidation = useMemo(
    () => (draft ? validateMediaDraft(draft) : blankValidation),
    [blankValidation, draft],
  );
  const validation = useMemo(
    () => (draft ? validateDraft(draft) : blankValidation),
    [blankValidation, draft],
  );

  const ownedChannels = useMemo(
    () => (channelsQuery.data ?? []).filter((item) => item.entityType === 'channel'),
    [channelsQuery.data],
  );

  const channelById = useMemo(() => {
    const map = new Map<string, ChatSummary>();
    for (const channel of ownedChannels) {
      map.set(channel.id, channel);
    }
    return map;
  }, [ownedChannels]);

  const channelByLink = useMemo(() => {
    const map = new Map<string, ChatSummary>();
    for (const channel of ownedChannels) {
      if (channel.link) {
        const normalized = normalizeChannelLink(channel.link);
        if (normalized) {
          map.set(normalized, channel);
        }
      }
    }
    return map;
  }, [ownedChannels]);

  const selectedRequiredChannels = useMemo(() => {
    if (!draft) {
      return [];
    }
    return draft.requiredChannelIds.map((channelId) => {
      const channel = channelById.get(channelId);
      return {
        id: channelId,
        title: channel?.title?.trim() || 'Канал из условий',
      };
    });
  }, [channelById, draft]);

  const availableOwnedChannels = useMemo(() => {
    if (!draft) {
      return [];
    }
    const selected = new Set(draft.requiredChannelIds);
    return ownedChannels.filter((channel) => channel.id !== entityId && !selected.has(channel.id));
  }, [draft, entityId, ownedChannels]);

  const editorSteps = useMemo(
    () =>
      GIVEAWAY_EDITOR_STEPS.map((step) => {
        if (step.id === 'basics') {
          return {
            ...step,
            summary: draft ? buildBasicsSummary(draft) : 'Название и сроки',
            isComplete: basicsValidation.valid,
          };
        }
        if (step.id === 'conditions') {
          return {
            ...step,
            summary: draft
              ? buildConditionsSummary(draft, selectedRequiredChannels)
              : 'Источник и каналы',
            isComplete: conditionsValidation.valid,
          };
        }
        return {
          ...step,
          summary: draft ? buildPrizesSummary(draft) : 'Места и призы',
          isComplete: prizesValidation.valid,
        };
      }),
    [
      basicsValidation.valid,
      conditionsValidation.valid,
      draft,
      prizesValidation.valid,
      selectedRequiredChannels,
    ],
  );
  const activeEditorStepIndex = Math.max(
    0,
    editorSteps.findIndex((item) => item.id === editorStep),
  );
  const activeEditorStep = editorSteps[activeEditorStepIndex] ?? editorSteps[0];
  const currentStepValidation =
    editorStep === 'basics'
      ? basicsValidation
      : editorStep === 'conditions'
        ? conditionsValidation
        : prizesValidation;
  const firstConfigIssue = !basicsValidation.valid
    ? { step: 'basics' as GiveawayEditorStepId, message: basicsValidation.message }
    : !conditionsValidation.valid
      ? { step: 'conditions' as GiveawayEditorStepId, message: conditionsValidation.message }
      : !prizesValidation.valid
        ? { step: 'prizes' as GiveawayEditorStepId, message: prizesValidation.message }
        : !mediaValidation.valid
          ? { step: 'prizes' as GiveawayEditorStepId, message: mediaValidation.message }
          : null;
  const handoffMutation = useMutation({
    mutationFn: (giveawayId: string | null) =>
      handoffManagedGiveaway(api, entityType, entityId, { giveawayId }),
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
    mutationFn: (giveawayId: string) =>
      deleteManagedGiveaway(api, entityType, entityId, giveawayId),
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
      createManagedGiveaway(api, entityType, entityId, payload),
  });

  const updateMutation = useMutation({
    mutationFn: (params: { giveawayId: string; payload: UpdateManagedGiveawayPayload }) =>
      updateManagedGiveaway(api, entityType, entityId, params.giveawayId, params.payload),
  });

  const publishMutation = useMutation({
    mutationFn: (giveawayId: string) =>
      publishManagedGiveaway(api, entityType, entityId, giveawayId),
  });

  const cancelMutation = useMutation({
    mutationFn: (giveawayId: string) =>
      cancelManagedGiveaway(api, entityType, entityId, giveawayId),
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
    setEditorStep('basics');
    setChannelPickerOpen(false);
    setChannelLinkValue('');
    setAwaitingBotSync(false);
  };

  const applyEditorPayload = (giveaway: ManagedGiveawayDetails) => {
    const nextDraft = toEditorDraft(giveaway);
    setEditorMode('edit');
    setEditingGiveawayId(giveaway.id);
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setEditorError('');
    setValidationHint('');
    setChannelPickerOpen(false);
    setChannelLinkValue('');
  };

  const startCreate = () => {
    setEditorMode('create');
    const nextDraft = createDefaultEditorDraft();
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setEditingGiveawayId(null);
    setEditorError('');
    setValidationHint('');
    setEditorStep('basics');
    setChannelPickerOpen(false);
    setChannelLinkValue('');
    setAwaitingBotSync(false);
  };

  const startEditCurrentDraft = () => {
    if (!currentItem || currentItem.status !== 'DRAFT') {
      return;
    }
    setEditorMode('edit');
    setEditingGiveawayId(currentItem.id);
    setEditorError('');
    setValidationHint('');
    setEditorStep('basics');
    setChannelPickerOpen(false);
    setChannelLinkValue('');
    setAwaitingBotSync(false);
  };

  const updateDraft = (updater: (current: GiveawayEditorDraft) => GiveawayEditorDraft) => {
    setDraft((current) => (current ? updater(current) : current));
    setValidationHint('');
    setEditorError('');
  };

  const toggleStartMode = (nextMode: 'instant' | 'scheduled') => {
    updateDraft((current) => {
      if (nextMode === 'instant') {
        return {
          ...current,
          startsAtLocal: '',
        };
      }

      const suggestedStart =
        parseDateTimeInput(current.startsAtLocal) ?? roundToNextQuarter(new Date());
      const suggestedEnd = parseDateTimeInput(current.endsAtLocal);
      const normalizedEnd =
        suggestedEnd && suggestedEnd.getTime() > suggestedStart.getTime()
          ? current.endsAtLocal
          : formatDateTimeInputValue(addHours(suggestedStart, 24));

      return {
        ...current,
        startsAtLocal: formatDateTimeInputValue(suggestedStart),
        endsAtLocal: normalizedEnd,
      };
    });
  };

  const updateStartDate = (nextDate: string) => {
    updateDraft((current) => {
      const fallback = parseDateTimeInput(current.startsAtLocal) ?? roundToNextQuarter(new Date());
      return {
        ...current,
        startsAtLocal: mergeDateAndTime(
          nextDate,
          readTimeInputPart(current.startsAtLocal, formatTimeInputValue(fallback)),
          fallback,
        ),
      };
    });
  };

  const updateStartTime = (nextTime: string) => {
    updateDraft((current) => {
      const fallback = parseDateTimeInput(current.startsAtLocal) ?? roundToNextQuarter(new Date());
      const dateValue = readDateInputPart(current.startsAtLocal) || formatDateInputValue(fallback);
      return {
        ...current,
        startsAtLocal: mergeDateAndTime(dateValue, nextTime, fallback),
      };
    });
  };

  const updateEndDate = (nextDate: string) => {
    updateDraft((current) => {
      const fallback =
        parseDateTimeInput(current.endsAtLocal) ??
        addHours(parseDateTimeInput(current.startsAtLocal) ?? new Date(), 24);
      return {
        ...current,
        endsAtLocal: mergeDateAndTime(
          nextDate,
          readTimeInputPart(current.endsAtLocal, formatTimeInputValue(fallback)),
          fallback,
        ),
      };
    });
  };

  const updateEndTime = (nextTime: string) => {
    updateDraft((current) => {
      const fallback =
        parseDateTimeInput(current.endsAtLocal) ??
        addHours(parseDateTimeInput(current.startsAtLocal) ?? new Date(), 24);
      const dateValue = readDateInputPart(current.endsAtLocal) || formatDateInputValue(fallback);
      return {
        ...current,
        endsAtLocal: mergeDateAndTime(dateValue, nextTime, fallback),
      };
    });
  };

  const applyFinishPreset = (hours: number) => {
    updateDraft((current) => {
      const base =
        parseDateTimeInput(current.startsAtLocal) ??
        parseDateTimeInput(current.endsAtLocal) ??
        roundToNextQuarter(new Date());
      const nextEnd = addHours(base, hours);
      nextEnd.setSeconds(0, 0);
      return {
        ...current,
        endsAtLocal: formatDateTimeInputValue(nextEnd),
      };
    });
  };

  const applyClaimPreset = (hours: number) => {
    updateDraft((current) => ({
      ...current,
      claimHours: hours,
    }));
  };

  const addRequiredChannelById = (channelId: string) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const normalizedChannelId = normalizeChannelId(channelId);
      if (!normalizedChannelId || normalizedChannelId === entityId) {
        return current;
      }

      if (current.requiredChannelIds.includes(normalizedChannelId)) {
        return current;
      }

      return {
        ...current,
        requiredChannelIds: [...current.requiredChannelIds, normalizedChannelId],
      };
    });
    setChannelLinkValue('');
    setValidationHint('');
    setEditorError('');
  };

  const removeRequiredChannelById = (channelId: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            requiredChannelIds: current.requiredChannelIds.filter((item) => item !== channelId),
          }
        : current,
    );
    setValidationHint('');
    setEditorError('');
  };

  const addRequiredChannelByLink = () => {
    const normalized = normalizeChannelLink(channelLinkValue);
    if (!normalized) {
      setValidationHint('Вставьте ссылку канала.');
      return;
    }

    const matched = channelByLink.get(normalized);
    if (!matched) {
      setValidationHint('Не нашли канал по ссылке. Используйте кнопку «Свой канал».');
      return;
    }

    addRequiredChannelById(matched.id);
  };

  const refetchManagedGiveaways = async () => {
    await Promise.all([
      listQuery.refetch(),
      queryClient.invalidateQueries({
        queryKey: ['managed-giveaway-details', entityType, entityId],
      }),
    ]);
  };

  useEffect(() => {
    if (!awaitingBotSync || !editingGiveawayId) {
      return;
    }

    const syncAfterBotReturn = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void draftDetailsQuery.refetch();
      void refetchManagedGiveaways();
      setAwaitingBotSync(false);
    };

    window.addEventListener('focus', syncAfterBotReturn);
    document.addEventListener('visibilitychange', syncAfterBotReturn);

    return () => {
      window.removeEventListener('focus', syncAfterBotReturn);
      document.removeEventListener('visibilitychange', syncAfterBotReturn);
    };
  }, [awaitingBotSync, draftDetailsQuery, editingGiveawayId, refetchManagedGiveaways]);

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
          title: 'Проверьте поля',
          description: checked.message,
        });
      }
      return null;
    }

    try {
      const nextPayload = toUpdatePayload(draft);
      const payload = {
        ...nextPayload,
        requiredChannelIds: nextPayload.requiredChannelIds.filter((item) => item !== entityId),
      };
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

    if (firstConfigIssue) {
      setEditorStep(firstConfigIssue.step);
      setValidationHint(firstConfigIssue.message);
      pushToast({
        tone: 'danger',
        title: 'Закончите настройку',
        description: firstConfigIssue.message,
      });
      return;
    }

    if (!draft.description.trim()) {
      const message = 'Добавьте текст розыгрыша в чат-боте перед публикацией.';
      setEditorStep('prizes');
      setValidationHint(message);
      pushToast({
        tone: 'danger',
        title: 'Нужен текст публикации',
        description: message,
      });
      return;
    }

    const checked = validateDraft(draft);
    if (!checked.valid) {
      setValidationHint(checked.message);
      pushToast({
        tone: 'danger',
        title: 'Проверьте поля',
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
        title: 'Не удалось опубликовать',
        description: message,
      });
    }
  };

  const openEditorInBot = async () => {
    if (!draft) {
      return;
    }

    if (firstConfigIssue) {
      setEditorStep(firstConfigIssue.step);
      setValidationHint(firstConfigIssue.message);
      pushToast({
        tone: 'danger',
        title: 'Сначала закончите настройки',
        description: firstConfigIssue.message,
      });
      return;
    }

    try {
      let targetId = editingGiveawayId;

      if (editorMode === 'create' || !targetId || isDirty) {
        const saved = await saveEditor({ silent: true });
        if (!saved) {
          return;
        }
        targetId = saved.id;
      }

      await handoffMutation.mutateAsync(targetId);
      setAwaitingBotSync(true);
    } catch {
      // `handoffMutation` already reports the failure.
    }
  };

  const setPrizeCount = (nextCount: number) => {
    const normalizedCount = Math.max(1, Math.min(MANAGED_GIVEAWAY_MAX_PRIZES, nextCount));
    setDraft((current) => {
      if (!current || current.prizes.length === normalizedCount) {
        return current;
      }

      if (current.prizes.length > normalizedCount) {
        return {
          ...current,
          prizes: current.prizes.slice(0, normalizedCount),
        };
      }

      const extraPrizes = Array.from(
        { length: normalizedCount - current.prizes.length },
        (_, index) => `${current.prizes.length + index + 1} место`,
      );
      return {
        ...current,
        prizes: [...current.prizes, ...extraPrizes],
      };
    });
    setValidationHint('');
    setEditorError('');
  };

  const goToPreviousStep = () => {
    if (activeEditorStepIndex <= 0) {
      return;
    }
    setValidationHint('');
    setEditorStep(editorSteps[activeEditorStepIndex - 1]?.id ?? 'basics');
  };

  const goToNextStep = () => {
    if (activeEditorStepIndex >= editorSteps.length - 1) {
      return;
    }
    if (!currentStepValidation.valid) {
      setValidationHint(currentStepValidation.message);
      pushToast({
        tone: 'danger',
        title: 'Проверьте шаг',
        description: currentStepValidation.message,
      });
      return;
    }

    setValidationHint('');
    setEditorStep(editorSteps[activeEditorStepIndex + 1]?.id ?? 'publish');
  };

  const handleFinalPrimaryAction = () => {
    if (firstConfigIssue) {
      setEditorStep(firstConfigIssue.step);
      setValidationHint(firstConfigIssue.message);
      pushToast({
        tone: 'danger',
        title: 'Закончите настройку',
        description: firstConfigIssue.message,
      });
      return;
    }

    if (!publicationTextReady) {
      void openEditorInBot();
      return;
    }

    void publishEditor();
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
        title: 'Черновик удалён',
      });
    } catch (error: unknown) {
      const message = formatApiError(error, 'Не удалось отменить черновик.');
      setEditorError(message);
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить',
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
  const publicationTextReady = Boolean(draft?.description.trim());
  const canSaveEditor = Boolean(draft) && validation.valid && (editorMode === 'create' || isDirty);
  const totalItemsCount = sortedItems.length;
  const isScheduledStart = Boolean(draft?.startsAtLocal.trim());
  const headerTitle = isEditingOpen
    ? draft
      ? buildDraftTitleSummary(draft.title)
      : draftDetailsQuery.isLoading
        ? 'Открываем черновик'
        : 'Новый розыгрыш'
    : currentItem
      ? currentItem.title
      : 'Создайте новый розыгрыш';
  const headerSummaryText = draft
    ? activeEditorStep.description
    : currentItem
      ? buildCurrentSubtitle(currentItem)
      : totalItemsCount > 0
        ? `${totalItemsCount} сценария`
        : '3 шага здесь, контент через бота.';
  const finalPrimaryLabel = firstConfigIssue
    ? 'Закончить настройку'
    : publicationTextReady
      ? 'Опубликовать в чат'
      : 'Завершить в боте';
  const finalPrimaryBusyLabel = firstConfigIssue
    ? 'Готовим…'
    : publicationTextReady
      ? 'Публикуем…'
      : 'Открываем бота…';
  const nextStepLabel =
    editorStep === 'basics'
      ? 'Далее: условия'
      : editorStep === 'conditions'
        ? 'Далее: призы'
        : finalPrimaryLabel;
  const stickyTitle =
    editorStep === 'prizes'
      ? firstConfigIssue
        ? 'Нужно закончить'
        : publicationTextReady
          ? 'Готово к запуску'
          : 'Последний шаг: текст в боте'
      : `Шаг ${activeEditorStepIndex + 1}. ${activeEditorStep.title}`;
  const stickyDescription =
    editorStep === 'prizes'
      ? firstConfigIssue
        ? firstConfigIssue.message
        : publicationTextReady
          ? 'Черновик сохраним автоматически перед публикацией.'
          : 'Откроем чат-бот и вернёмся сюда с текстом и фото.'
      : currentStepValidation.valid
        ? editorStep === 'basics'
          ? 'Дальше соберём условия участия и список каналов для проверки.'
          : 'Останется добавить места, призы и финально проверить публикацию.'
        : currentStepValidation.message;
  const showStickyCopy =
    !currentStepValidation.valid || (editorStep === 'prizes' && !publicationTextReady);
  const dashboardNote =
    currentItem?.status === 'DRAFT'
      ? {
          title: 'Что осталось',
          description:
            'Проверьте сроки и механику здесь, а текст с фото спокойно доведите в чат-боте.',
          points: ['Сроки', 'Условия', 'Контент в боте'],
        }
      : currentItem
        ? {
            title:
              currentItem.status === 'SCHEDULED'
                ? 'Сценарий уже собран'
                : 'Управление остаётся под рукой',
            description:
              currentItem.status === 'SCHEDULED'
                ? 'До старта можно быстро вернуться в бота, проверить публикацию и не потерять сценарий.'
                : 'Публикация и итоги открываются через бота, а статус и быстрый вход остаются здесь.',
            points: [
              currentItem.publicationUrl ? 'Публикация' : 'Статус',
              currentItem.resultsUrl ? 'Итоги' : 'Бот',
              historyItems.length > 0 ? 'Архив' : 'Под рукой',
            ],
          }
        : {
            title: 'Как это работает',
            description:
              'Сначала собираете сценарий здесь, потом перед запуском добавляете текст и фото в личке бота.',
            points: ['Основа', 'Условия', 'Призы'],
          };
  const currentSummaryMetrics: SummaryMetric[] = currentItem
    ? [
        {
          key: 'timing',
          label: currentItem.status === 'SCHEDULED' ? 'Старт' : 'Финиш',
          value: formatCompactDate(
            currentItem.status === 'SCHEDULED'
              ? (currentItem.startsAt ?? currentItem.endsAt)
              : currentItem.endsAt,
          ),
          note: currentItem.status === 'SCHEDULED' ? 'По времени' : 'Автозавершение',
        },
        {
          key: 'entries',
          label: 'Заявки',
          value: formatCount(currentItem.entriesCount),
          note:
            currentItem.pendingEntriesCount > 0
              ? `${formatCount(currentItem.pendingEntriesCount)} ждут`
              : 'Без очереди',
        },
      ]
    : [];
  const currentSecondaryActionCount = currentItem
    ? Number(Boolean(currentItem.publicationUrl)) + Number(Boolean(currentItem.resultsUrl))
    : 0;
  const emptySummaryMetrics: SummaryMetric[] = [
    {
      key: 'steps',
      label: 'Сценарий',
      value: '3 шага',
      note: 'Основа, условия, призы',
    },
    {
      key: 'bot',
      label: 'Контент',
      value: 'Через бота',
      note: 'Текст и фото подтягиваются сюда',
    },
  ];
  const draftSummaryMetrics: SummaryMetric[] = draft
    ? [
        {
          key: 'finish',
          label: 'Финиш',
          value: formatCompactInputDateTime(draft.endsAtLocal, 'Не задан'),
          note: draft.startsAtLocal.trim()
            ? `Старт ${formatCompactInputDateTime(draft.startsAtLocal, 'по времени')}`
            : 'Старт сразу',
        },
        {
          key: 'prizes',
          label: 'Места',
          value: String(draft.prizes.length),
          note: buildPrizesSummary(draft),
        },
      ]
    : [];
  const renderFactGrid = (metrics: SummaryMetric[]) =>
    metrics.length > 0 ? (
      <div
        className={cn(
          'managed-giveaway__hero-facts',
          metrics.length === 2 && 'managed-giveaway__hero-facts--two',
        )}
      >
        {metrics.map((item) => (
          <div key={item.key} className="managed-giveaway__hero-fact">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.note}</small>
          </div>
        ))}
      </div>
    ) : null;

  return (
    <div
      className={cn(
        'managed-giveaway',
        isEditingOpen ? 'managed-giveaway--editing' : 'managed-giveaway--dashboard',
        isEditingOpen && `managed-giveaway--step-${editorStep}`,
      )}
    >
      {!isEditingOpen ? (
        listQuery.isLoading ? (
          <div className="managed-giveaway__hero-card managed-giveaway__hero-card--dashboard">
            <div className="managed-giveaway__hero-head">
              <div className="managed-giveaway__hero-copy">
                <span className="managed-giveaway__eyebrow">Розыгрыши</span>
                <h2>Подгружаем сценарии</h2>
                <p>Проверяем черновик и активный запуск.</p>
              </div>
              <div className="managed-giveaway__hero-badges">
                <span className="managed-giveaway__badge is-muted">Загрузка</span>
              </div>
            </div>
            {renderFactGrid(emptySummaryMetrics)}
          </div>
        ) : currentItem ? (
          currentItem.status === 'DRAFT' ? (
            <>
              <div className="managed-giveaway__hero-card managed-giveaway__hero-card--dashboard">
                <div className="managed-giveaway__hero-head">
                  <div className="managed-giveaway__hero-copy">
                    <span className="managed-giveaway__eyebrow">Активный сценарий</span>
                    <h2>{currentItem.title}</h2>
                    <p>{buildCurrentSubtitle(currentItem)}</p>
                  </div>
                  <div className="managed-giveaway__hero-badges">
                    <span
                      className={cn('managed-giveaway__badge', buildStatusTone(currentItem.status))}
                    >
                      {buildStatusLabel(currentItem.status)}
                    </span>
                    {historyItems.length > 0 ? (
                      <span className="managed-giveaway__chip">
                        {formatCount(historyItems.length)} в архиве
                      </span>
                    ) : null}
                  </div>
                </div>
                {renderFactGrid(currentSummaryMetrics)}
              </div>
              <div className="managed-giveaway__primary-actions managed-giveaway__primary-actions--split">
                <button
                  type="button"
                  className="button button--accent"
                  disabled={isBusy}
                  onClick={startEditCurrentDraft}
                >
                  Продолжить сценарий
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={isBusy}
                  onClick={() => {
                    void handoffMutation.mutateAsync(currentItem.id);
                  }}
                >
                  Завершить в боте
                </button>
              </div>
            </>
          ) : (
            <div className="managed-giveaway__dashboard-launchpad managed-giveaway__dashboard-launchpad--active">
              <div className="managed-giveaway__dashboard-launchpad-head">
                <div className="managed-giveaway__hero-copy">
                  <span className="managed-giveaway__eyebrow">Активный сценарий</span>
                  <h2>{currentItem.title}</h2>
                  <p>{buildCurrentSubtitle(currentItem)}</p>
                </div>
                <div className="managed-giveaway__hero-badges">
                  <span
                    className={cn('managed-giveaway__badge', buildStatusTone(currentItem.status))}
                  >
                    {buildStatusLabel(currentItem.status)}
                  </span>
                  {historyItems.length > 0 ? (
                    <span className="managed-giveaway__chip">
                      {formatCount(historyItems.length)} в архиве
                    </span>
                  ) : null}
                </div>
              </div>
              {renderFactGrid(currentSummaryMetrics)}
              <div className="managed-giveaway__dashboard-launchpad-actions">
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
              </div>
              {currentItem.publicationUrl || currentItem.resultsUrl ? (
                <div
                  className={cn(
                    'managed-giveaway__dashboard-secondary-actions',
                    currentSecondaryActionCount === 1 &&
                      'managed-giveaway__dashboard-secondary-actions--single',
                  )}
                >
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
              ) : null}
              <div className="managed-giveaway__dashboard-note managed-giveaway__dashboard-note--inline">
                <div className="managed-giveaway__dashboard-note-copy">
                  <strong>{dashboardNote.title}</strong>
                  <small>{dashboardNote.description}</small>
                </div>
                <div className="managed-giveaway__dashboard-note-points" aria-hidden>
                  {dashboardNote.points.map((point) => (
                    <span key={point} className="managed-giveaway__chip">
                      {point}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )
        ) : (
          <>
            <div className="managed-giveaway__dashboard-launchpad">
              <div className="managed-giveaway__dashboard-launchpad-head">
                <div className="managed-giveaway__hero-copy">
                  <span className="managed-giveaway__eyebrow">Розыгрыши</span>
                  <h2>Соберите сценарий за три шага</h2>
                  <p>Тайминг и условия настраиваются здесь, текст и фото завершаются в чат-боте.</p>
                </div>
                {historyItems.length > 0 ? (
                  <div className="managed-giveaway__hero-badges">
                    <span className="managed-giveaway__chip">
                      {formatCount(historyItems.length)} в архиве
                    </span>
                  </div>
                ) : null}
              </div>
              <div
                className={cn(
                  'managed-giveaway__primary-actions',
                  'managed-giveaway__primary-actions--launchpad',
                  historyItems.length > 0 && 'managed-giveaway__primary-actions--split',
                )}
              >
                <button
                  type="button"
                  className="button button--accent"
                  disabled={isBusy}
                  onClick={startCreate}
                >
                  Новый сценарий
                </button>
                {historyItems.length > 0 ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => setHistoryOpen(true)}
                  >
                    История
                  </button>
                ) : null}
              </div>
              {renderFactGrid(emptySummaryMetrics)}
            </div>
          </>
        )
      ) : null}

      {!isEditingOpen && (!currentItem || currentItem.status === 'DRAFT') ? (
        <div className="managed-giveaway__dashboard-note">
          <div className="managed-giveaway__dashboard-note-copy">
            <strong>{dashboardNote.title}</strong>
            <small>{dashboardNote.description}</small>
          </div>
          <div className="managed-giveaway__dashboard-note-points" aria-hidden>
            {dashboardNote.points.map((point) => (
              <span key={point} className="managed-giveaway__chip">
                {point}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {isEditingOpen ? (
        !draft ? (
          <div className={cn('managed-giveaway__surface', 'managed-giveaway__editor-card')}>
            <div
              className={cn(
                'managed-giveaway__hero-card',
                'managed-giveaway__hero-card--editor',
                editorStep !== 'basics' && 'managed-giveaway__hero-card--editor-compact',
              )}
            >
              <div className="managed-giveaway__hero-head">
                <div className="managed-giveaway__hero-copy">
                  <span className="managed-giveaway__eyebrow">Черновик</span>
                  <h2>{headerTitle}</h2>
                  <p>{headerSummaryText}</p>
                </div>
                <div className="managed-giveaway__hero-badges">
                  <span className="managed-giveaway__badge is-muted">
                    {draftDetailsQuery.isLoading ? 'Загрузка' : 'Черновик'}
                  </span>
                </div>
              </div>
              <div className="managed-giveaway__info-card">
                <strong>
                  {draftDetailsQuery.isLoading
                    ? 'Подтягиваем актуальные данные…'
                    : 'Открываем сценарий.'}
                </strong>
              </div>
            </div>
          </div>
        ) : (
          <div className={cn('managed-giveaway__surface', 'managed-giveaway__editor-card')}>
            <div className="managed-giveaway__hero-card managed-giveaway__hero-card--editor">
              <div className="managed-giveaway__hero-head">
                <div className="managed-giveaway__hero-copy">
                  <span className="managed-giveaway__eyebrow">
                    Шаг {activeEditorStepIndex + 1} из {editorSteps.length}
                  </span>
                  <h2>{headerTitle}</h2>
                  <p>Сценарий собираем здесь, текст и фото завершаем в чат-боте.</p>
                </div>
                <div className="managed-giveaway__hero-badges">
                  <span
                    className={cn(
                      'managed-giveaway__badge',
                      isDirty || editorMode === 'create' ? 'is-warning' : 'is-success',
                    )}
                  >
                    {editorStatusLabel}
                  </span>
                </div>
              </div>
              {renderFactGrid(draftSummaryMetrics)}
            </div>

            <div className="managed-giveaway__step-strip" aria-label="Прогресс по шагам">
              {editorSteps.map((step, index) => (
                <div
                  key={step.id}
                  className={cn(
                    'managed-giveaway__step-pill',
                    index === activeEditorStepIndex && 'is-active',
                    step.isComplete && 'is-complete',
                  )}
                >
                  <span className="managed-giveaway__step-pill-index">
                    {step.isComplete && index < activeEditorStepIndex ? '✓' : index + 1}
                  </span>
                  <strong>{step.label}</strong>
                </div>
              ))}
            </div>

            {editorStep === 'basics' ? (
              <div className="managed-giveaway__step-stage">
                <div className="managed-giveaway__section">
                  <div className="managed-giveaway__section-head">
                    <div className="managed-giveaway__section-copy">
                      <strong>Как называется розыгрыш</strong>
                      <small>Короткое и понятное название, которое будет видно в списке и в публикации.</small>
                    </div>
                    <span className="managed-giveaway__chip">
                      {draft.title.length}/{MANAGED_GIVEAWAY_TITLE_MAX_LENGTH}
                    </span>
                  </div>

                  <label className="field">
                    <span>Название</span>
                    <input
                      type="text"
                      value={draft.title}
                      onChange={(event) =>
                        updateDraft((current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                      maxLength={MANAGED_GIVEAWAY_TITLE_MAX_LENGTH}
                      placeholder="Например: Розыгрыш на выходные"
                      disabled={isBusy}
                    />
                  </label>
                </div>

                <div className="managed-giveaway__section">
                  <div className="managed-giveaway__section-head">
                    <div className="managed-giveaway__section-copy">
                      <strong>Когда запускать</strong>
                      <small>Можно стартовать сразу или поставить чёткое время запуска.</small>
                    </div>
                  </div>

                  <div className="managed-giveaway__choice-grid" role="tablist" aria-label="Режим старта">
                    <button
                      type="button"
                      className={cn('managed-giveaway__choice-card', !isScheduledStart && 'is-active')}
                      aria-pressed={!isScheduledStart}
                      disabled={isBusy}
                      onClick={() => toggleStartMode('instant')}
                    >
                      <span className="managed-giveaway__choice-copy">
                        <strong>Старт сразу</strong>
                        <small>Запуск без ожидания после финального действия.</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={cn('managed-giveaway__choice-card', isScheduledStart && 'is-active')}
                      aria-pressed={isScheduledStart}
                      disabled={isBusy}
                      onClick={() => toggleStartMode('scheduled')}
                    >
                      <span className="managed-giveaway__choice-copy">
                        <strong>По времени</strong>
                        <small>Отложенный старт с конкретной датой и временем.</small>
                      </span>
                    </button>
                  </div>

                  {isScheduledStart ? (
                    <div className="managed-giveaway__split-fields">
                      <label className="field">
                        <span>Дата старта</span>
                        <input
                          type="date"
                          value={readDateInputPart(draft.startsAtLocal)}
                          onChange={(event) => updateStartDate(event.target.value)}
                          disabled={isBusy}
                        />
                      </label>
                      <label className="field">
                        <span>Время</span>
                        <input
                          type="time"
                          value={readTimeInputPart(draft.startsAtLocal, '12:00')}
                          onChange={(event) => updateStartTime(event.target.value)}
                          disabled={isBusy}
                        />
                      </label>
                    </div>
                  ) : (
                    <div className="managed-giveaway__inline-note">
                      Публикация стартует сразу после финальной команды на последнем шаге.
                    </div>
                  )}
                </div>

                <div className="managed-giveaway__section">
                  <div className="managed-giveaway__section-head">
                    <div className="managed-giveaway__section-copy">
                      <strong>Когда завершать</strong>
                      <small>Сначала выберите типичный срок, потом при желании уточните дату и время.</small>
                    </div>
                  </div>

                  <div className="managed-giveaway__quick-actions">
                    {FINISH_PRESETS.map((preset) => (
                      <button
                        key={`finish-preset-${preset.hours}`}
                        type="button"
                        className="managed-giveaway__chip-button"
                        disabled={isBusy}
                        onClick={() => applyFinishPreset(preset.hours)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  <div className="managed-giveaway__split-fields">
                    <label className="field">
                      <span>Дата финиша</span>
                      <input
                        type="date"
                        value={readDateInputPart(draft.endsAtLocal)}
                        onChange={(event) => updateEndDate(event.target.value)}
                        disabled={isBusy}
                      />
                    </label>
                    <label className="field">
                      <span>Время</span>
                      <input
                        type="time"
                        value={readTimeInputPart(draft.endsAtLocal, '21:00')}
                        onChange={(event) => updateEndTime(event.target.value)}
                        disabled={isBusy}
                      />
                    </label>
                  </div>
                </div>

                <div className="managed-giveaway__section">
                  <div className="managed-giveaway__section-head">
                    <div className="managed-giveaway__section-copy">
                      <strong>Сколько дать на подтверждение</strong>
                      <small>Победителю нужен понятный срок, чтобы забрать приз без лишней спешки.</small>
                    </div>
                  </div>

                  <div className="managed-giveaway__quick-actions">
                    {CLAIM_HOUR_PRESETS.map((hours) => (
                      <button
                        key={`claim-preset-${hours}`}
                        type="button"
                        className={cn(
                          'managed-giveaway__chip-button',
                          draft.claimHours === hours && 'is-active',
                        )}
                        disabled={isBusy}
                        onClick={() => applyClaimPreset(hours)}
                      >
                        {hours}ч
                      </button>
                    ))}
                  </div>

                  <div className="managed-giveaway__split-fields">
                    <label className="field">
                      <span>Срок подтверждения, ч</span>
                      <input
                        type="number"
                        min={MIN_CLAIM_HOURS}
                        max={MAX_CLAIM_HOURS}
                        value={draft.claimHours}
                        onChange={(event) =>
                          updateDraft((current) => ({
                            ...current,
                            claimHours:
                              Number.parseInt(event.target.value, 10) || MIN_CLAIM_HOURS,
                          }))
                        }
                        disabled={isBusy}
                      />
                    </label>
                    <div className="managed-giveaway__info-card">
                      <strong>{draft.claimHours}ч на подтверждение</strong>
                      <small>Таймер для победителя запустится после определения итогов.</small>
                    </div>
                  </div>
                </div>

                <div className="managed-giveaway__summary-grid">
                  <div className="managed-giveaway__summary-card">
                    <span>Старт</span>
                    <strong>
                      {isScheduledStart
                        ? formatCompactInputDateTime(draft.startsAtLocal, 'по времени')
                        : 'Сразу'}
                    </strong>
                  </div>
                  <div className="managed-giveaway__summary-card">
                    <span>Финиш</span>
                    <strong>{formatCompactInputDateTime(draft.endsAtLocal, 'не задан')}</strong>
                  </div>
                  <div className="managed-giveaway__summary-card">
                    <span>Подтверждение</span>
                    <strong>{draft.claimHours}ч</strong>
                  </div>
                </div>
              </div>
            ) : null}

            {editorStep === 'conditions' ? (
              <div className="managed-giveaway__step-stage">
                <div className="managed-giveaway__section managed-giveaway__section--conditions">
                  <div className="managed-giveaway__section-head">
                    <div className="managed-giveaway__section-copy">
                      <strong>Кто участвует</strong>
                      <small>Источник всегда обязателен. Дополнительные каналы добавляйте только если это усиливает механику.</small>
                    </div>
                    <span className="managed-giveaway__badge is-muted">
                      {draft.requiredChannelIds.length}/{MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}
                    </span>
                  </div>

                  <div className="managed-giveaway__info-card">
                    <strong>Источник участвует всегда</strong>
                    <small>Список ниже расширяет условия подписки сверх основного чата или канала.</small>
                  </div>

                  {selectedRequiredChannels.length > 0 ? (
                    <div className="managed-giveaway__channel-list">
                      {selectedRequiredChannels.map((item, index) => (
                        <div
                          key={`required-channel-${item.id}`}
                          className="managed-giveaway__channel-row"
                        >
                          <span className="managed-giveaway__channel-index">{index + 1}</span>
                          <div className="managed-giveaway__channel-copy">
                            <strong>{item.title}</strong>
                            <small>Дополнительная подписка для участия</small>
                          </div>
                          <button
                            type="button"
                            className="managed-giveaway__channel-remove"
                            onClick={() => removeRequiredChannelById(item.id)}
                            disabled={isBusy}
                            aria-label={`Удалить доп. канал ${index + 1}`}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                      <strong>Пока достаточно подписки на источник.</strong>
                    </div>
                  )}

                  <div className="managed-giveaway__channel-tools">
                    <div className="managed-giveaway__channel-tool-card">
                      <div className="managed-giveaway__channel-tool-copy">
                        <strong>Свой канал</strong>
                        <small>Выберите из списка, если бот уже подключён и у вас есть доступ.</small>
                      </div>
                      <div className="managed-giveaway__section-actions">
                        <button
                          type="button"
                          className="button button--ghost managed-giveaway__channel-action"
                          disabled={isBusy || channelsQuery.isLoading}
                          onClick={() => setChannelPickerOpen((current) => !current)}
                        >
                          {channelPickerOpen ? 'Свернуть список' : 'Добавить свой канал'}
                        </button>
                        <span className="managed-giveaway__section-inline-note">
                          Свои каналы: {availableOwnedChannels.length}
                        </span>
                      </div>
                    </div>

                    <div className="managed-giveaway__channel-tool-card managed-giveaway__channel-tool-card--link">
                      <div className="managed-giveaway__channel-tool-copy">
                        <strong>Чужой канал</strong>
                        <small>Вставьте публичную ссылку, чтобы проверить канал и добавить его в механику.</small>
                      </div>
                      <div className="managed-giveaway__editor-grid managed-giveaway__editor-grid--align-end">
                        <label className="field">
                          <span>Публичная ссылка</span>
                          <input
                            type="text"
                            value={channelLinkValue}
                            onChange={(event) => {
                              setChannelLinkValue(event.target.value);
                              setValidationHint('');
                              setEditorError('');
                            }}
                            placeholder="https://max.ru/..."
                            disabled={isBusy}
                          />
                        </label>
                        <div className="managed-giveaway__section-actions managed-giveaway__section-actions--align-end">
                          <button
                            type="button"
                            className="button button--ghost managed-giveaway__channel-action"
                            disabled={isBusy}
                            onClick={addRequiredChannelByLink}
                          >
                            Проверить и добавить
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {channelPickerOpen ? (
                    <div className="managed-giveaway__channel-picker">
                      {channelsQuery.isLoading ? <span>Загружаем ваши каналы...</span> : null}
                      {!channelsQuery.isLoading && availableOwnedChannels.length === 0 ? (
                        <span>Нет доступных каналов для добавления.</span>
                      ) : null}
                      {!channelsQuery.isLoading
                        ? availableOwnedChannels.map((channel) => (
                            <button
                              key={`channel-pick-${channel.id}`}
                              type="button"
                              className="managed-giveaway__channel-picker-item"
                              disabled={isBusy}
                              onClick={() => addRequiredChannelById(channel.id)}
                            >
                              {channel.title}
                            </button>
                          ))
                        : null}
                    </div>
                  ) : null}

                  {channelsQuery.error ? (
                    <div className="managed-giveaway__error-inline">
                      {formatApiError(channelsQuery.error, 'Не удалось загрузить список каналов.')}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {editorStep === 'prizes' ? (
              <div className="managed-giveaway__step-stage">
                <div className="managed-giveaway__section">
                  <div className="managed-giveaway__section-head">
                    <div className="managed-giveaway__section-copy">
                      <strong>Что получают победители</strong>
                      <small>Держите список коротким и читаемым: одно место, один приз, одна строка.</small>
                    </div>
                  </div>

                  <div className="managed-giveaway__count-stepper">
                    <button
                      type="button"
                      className="managed-giveaway__count-stepper-button"
                      disabled={isBusy || draft.prizes.length <= 1}
                      onClick={() => setPrizeCount(draft.prizes.length - 1)}
                      aria-label="Уменьшить количество мест"
                    >
                      −
                    </button>
                    <div className="managed-giveaway__count-stepper-value">
                      <span>Количество мест</span>
                      <strong>{draft.prizes.length}</strong>
                    </div>
                    <button
                      type="button"
                      className="managed-giveaway__count-stepper-button"
                      disabled={isBusy || draft.prizes.length >= MANAGED_GIVEAWAY_MAX_PRIZES}
                      onClick={() => setPrizeCount(draft.prizes.length + 1)}
                      aria-label="Увеличить количество мест"
                    >
                      +
                    </button>
                  </div>

                  <div className="managed-giveaway__prize-editor-list">
                    {draft.prizes.map((prizeTitle, index) => (
                      <div
                        key={`draft-prize-${index}`}
                        className="managed-giveaway__prize-editor-row"
                      >
                        <span className="managed-giveaway__prize-position">{index + 1}</span>
                        <label className="field">
                          <input
                            type="text"
                            value={prizeTitle}
                            placeholder={`Место #${index + 1}`}
                            maxLength={MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH}
                            onChange={(event) =>
                              updateDraft((current) => {
                                const nextPrizes = [...current.prizes];
                                nextPrizes[index] = event.target.value;
                                return {
                                  ...current,
                                  prizes: nextPrizes,
                                };
                              })
                            }
                            disabled={isBusy}
                          />
                        </label>
                        {draft.prizes.length > 1 ? (
                          <button
                            type="button"
                            className="managed-giveaway__prize-remove"
                            onClick={() =>
                              updateDraft((current) => ({
                                ...current,
                                prizes: current.prizes.filter((_, prizeIndex) => prizeIndex !== index),
                              }))
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
                </div>

                {publicationTextReady || awaitingBotSync ? (
                  <div className="managed-giveaway__info-card">
                    <strong>
                      {awaitingBotSync ? 'Ждём обновления из бота' : 'Контент публикации уже готов'}
                    </strong>
                    <small>
                      {awaitingBotSync
                        ? 'После возврата подтянем текст и фото автоматически.'
                        : 'Если нужно, откройте чат-бот и поправьте текст или фото перед запуском.'}
                    </small>
                    {publicationTextReady ? (
                      <div className="managed-giveaway__section-actions managed-giveaway__section-actions--align-end">
                        <button
                          type="button"
                          className="button button--ghost managed-giveaway__channel-action"
                          disabled={isBusy}
                          onClick={() => {
                            void openEditorInBot();
                          }}
                        >
                          Открыть контент в боте
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {validationHint ? (
              <div className="managed-giveaway__error-inline">{validationHint}</div>
            ) : null}
            {editorError ? (
              <div className="managed-giveaway__error-inline">{editorError}</div>
            ) : null}

            <div className="managed-giveaway__editor-meta-actions">
              <button
                type="button"
                className={cn(
                  'button button--ghost managed-giveaway__meta-button',
                  'managed-giveaway__meta-button--danger',
                )}
                onClick={cancelEditorDraft}
                disabled={isBusy}
              >
                {cancelMutation.isPending
                  ? 'Удаляем…'
                  : editorMode === 'create'
                    ? 'Сбросить'
                    : 'Удалить черновик'}
              </button>
              <button
                type="button"
                className={cn(
                  'button button--ghost managed-giveaway__meta-button',
                  'managed-giveaway__meta-button--quiet',
                )}
                onClick={() => {
                  void saveEditor();
                }}
                disabled={isBusy || !canSaveEditor}
              >
                {createMutation.isPending || updateMutation.isPending
                  ? 'Сохраняем…'
                  : 'Сохранить черновик'}
              </button>
            </div>

            <div
              className={cn(
                'managed-giveaway__action-dock',
                !showStickyCopy && 'managed-giveaway__action-dock--compact',
              )}
            >
              {showStickyCopy ? (
                <div className="managed-giveaway__action-dock-copy">
                  <strong>{stickyTitle}</strong>
                  <span>{stickyDescription}</span>
                </div>
              ) : null}
              <div className="managed-giveaway__action-dock-actions">
                {activeEditorStepIndex > 0 ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={goToPreviousStep}
                    disabled={isBusy}
                  >
                    Назад
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button button--accent"
                  onClick={() => {
                    if (activeEditorStepIndex >= editorSteps.length - 1) {
                      handleFinalPrimaryAction();
                      return;
                    }
                    goToNextStep();
                  }}
                  disabled={isBusy || !draft}
                >
                  {isBusy
                    ? activeEditorStepIndex >= editorSteps.length - 1
                      ? finalPrimaryBusyLabel
                      : 'Переходим…'
                    : nextStepLabel}
                </button>
              </div>
            </div>
          </div>
        )
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
