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
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { getChannels } from '../lib/api/root-client';
import {
  cancelManagedGiveaway,
  createManagedGiveaway,
  getManagedGiveaway,
  getManagedGiveaways,
  publishManagedGiveaway,
  updateManagedGiveaway,
} from '../lib/api/managed-giveaway-client';
import type { ApiTransport } from '../lib/api/transport';
import type { UpdateManagedGiveawayPayload } from '../lib/api/shared-types';
import { cn } from '../lib/cn';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { prepareBroadcastImage } from '../lib/broadcast-image';
import { useToast } from './ui/toast';

const MIN_CLAIM_HOURS = 1;
const MAX_CLAIM_HOURS = 336;
const FINISH_PRESETS = [
  { hours: 24, label: '24 часа' },
  { hours: 48, label: '48 часов' },
  { hours: 168, label: '7 дней' },
] as const;

type GiveawayEditorMode = 'closed' | 'create' | 'edit';
type GiveawayEditorStepId = 'basics' | 'conditions' | 'prizes';
type GiveawayHintKey =
  | 'dashboard'
  | 'title'
  | 'timing'
  | 'start'
  | 'finish'
  | 'claim'
  | 'conditions'
  | 'conditionsOwned'
  | 'conditionsLink'
  | 'prizes';
type GiveawayValidationResult = { valid: boolean; message: string };

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
  },
  {
    id: 'conditions',
    label: 'Условия',
    title: 'Кто участвует',
  },
  {
    id: 'prizes',
    label: 'Призы',
    title: 'Сколько мест и что получат',
  },
] as const satisfies ReadonlyArray<{
  id: GiveawayEditorStepId;
  label: string;
  title: string;
}>;

function GiveawayHintAnchor({
  hintKey,
  openHintKey,
  onToggleHint,
  label,
  children,
}: {
  hintKey: GiveawayHintKey;
  openHintKey: GiveawayHintKey | null;
  onToggleHint: (key: GiveawayHintKey) => void;
  label: string;
  children: string;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <span className="channel-settings-hint-anchor managed-giveaway__hint-anchor">
      <button
        type="button"
        className={cn('settings-info-button', 'managed-giveaway__info-button', isOpen && 'is-open')}
        aria-label={label}
        aria-controls={`giveaway-hint-${hintKey}`}
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
          id={`giveaway-hint-${hintKey}`}
          className="channel-settings-hint-popover managed-giveaway__hint-popover"
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
    prizes: [''],
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
  const [editorMode, setEditorMode] = useState<GiveawayEditorMode>('closed');
  const [editingGiveawayId, setEditingGiveawayId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GiveawayEditorDraft | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<GiveawayEditorDraft | null>(null);
  const [editorError, setEditorError] = useState('');
  const [validationHint, setValidationHint] = useState('');
  const [editorStep, setEditorStep] = useState<GiveawayEditorStepId>('basics');
  const [openHintKey, setOpenHintKey] = useState<GiveawayHintKey | null>(null);
  const [channelModalOpen, setChannelModalOpen] = useState(false);
  const [channelModalSelection, setChannelModalSelection] = useState<string[]>([]);
  const [channelLinkValue, setChannelLinkValue] = useState('');

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

  useEffect(() => {
    setOpenHintKey(null);
  }, [editorMode, editorStep]);

  useEffect(() => {
    if (editorMode !== 'edit' && editorMode !== 'create') {
      setChannelModalOpen(false);
      return;
    }

    if (editorStep !== 'conditions') {
      setChannelModalOpen(false);
    }
  }, [editorMode, editorStep]);

  useEffect(() => {
    if (!openHintKey || typeof document === 'undefined') {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest('.managed-giveaway__hint-anchor')) {
        return;
      }
      setOpenHintKey(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenHintKey(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openHintKey]);

  useHintPopoverAutoPosition(openHintKey !== null);

  useEffect(() => {
    if (!channelModalOpen || typeof window === 'undefined') {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setChannelModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [channelModalOpen]);

  const toggleHint = (hintKey: GiveawayHintKey) => {
    setOpenHintKey((current) => (current === hintKey ? null : hintKey));
  };

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

  const ownedSelectableChannels = useMemo(
    () => ownedChannels.filter((channel) => channel.id !== entityId),
    [entityId, ownedChannels],
  );

  const selectedOwnedChannelIds = useMemo(() => {
    if (!draft) {
      return [];
    }

    const selected = new Set(draft.requiredChannelIds);
    return ownedSelectableChannels
      .filter((channel) => selected.has(channel.id))
      .map((channel) => channel.id);
  }, [draft, ownedSelectableChannels]);

  const editorSteps = useMemo(
    () =>
      GIVEAWAY_EDITOR_STEPS.map((step) => {
        if (step.id === 'basics') {
          return {
            ...step,
            isComplete: basicsValidation.valid,
          };
        }
        if (step.id === 'conditions') {
          return {
            ...step,
            isComplete: conditionsValidation.valid,
          };
        }
        return {
          ...step,
          isComplete: prizesValidation.valid,
        };
      }),
    [basicsValidation.valid, conditionsValidation.valid, prizesValidation.valid],
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
    setChannelModalOpen(false);
    setChannelModalSelection([]);
    setChannelLinkValue('');
  };

  const applyEditorPayload = (giveaway: ManagedGiveawayDetails) => {
    const nextDraft = toEditorDraft(giveaway);
    setEditorMode('edit');
    setEditingGiveawayId(giveaway.id);
    setDraft(nextDraft);
    setSavedSnapshot(nextDraft);
    setEditorError('');
    setValidationHint('');
    setChannelModalOpen(false);
    setChannelModalSelection([]);
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
    setChannelModalOpen(false);
    setChannelModalSelection([]);
    setChannelLinkValue('');
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
    setChannelModalOpen(false);
    setChannelModalSelection([]);
    setChannelLinkValue('');
  };

  const updateDraft = (updater: (current: GiveawayEditorDraft) => GiveawayEditorDraft) => {
    setDraft((current) => (current ? updater(current) : current));
    setValidationHint('');
    setEditorError('');
  };

  const clearPublicationImage = () => {
    updateDraft((current) => ({
      ...current,
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
    }));
  };

  const handlePublicationImageChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    try {
      const prepared = await prepareBroadcastImage(file);
      updateDraft((current) => ({
        ...current,
        imageEnabled: true,
        imageBase64: prepared.base64,
        imageMimeType: prepared.mimeType,
        imageFileName: prepared.fileName,
      }));
    } catch (error: unknown) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Не удалось подготовить фото.';
      setValidationHint(message);
      pushToast({
        tone: 'danger',
        title: 'Не удалось добавить фото',
        description: message,
      });
    }
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

  const openOwnedChannelsModal = () => {
    setChannelModalSelection(selectedOwnedChannelIds);
    setChannelModalOpen(true);
    setValidationHint('');
    setEditorError('');
  };

  const applyOwnedChannelsSelection = () => {
    const nextSelection = new Set(channelModalSelection);
    const ownedChannelIds = new Set(ownedSelectableChannels.map((channel) => channel.id));

    setDraft((current) => {
      if (!current) {
        return current;
      }

      const externalRequiredChannelIds = current.requiredChannelIds.filter(
        (channelId) => !ownedChannelIds.has(channelId),
      );
      const nextOwnedChannelIds = ownedSelectableChannels
        .map((channel) => channel.id)
        .filter((channelId) => nextSelection.has(channelId));

      return {
        ...current,
        requiredChannelIds: [...externalRequiredChannelIds, ...nextOwnedChannelIds],
      };
    });

    setChannelModalOpen(false);
    setValidationHint('');
    setEditorError('');
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
      const message = 'Добавьте текст публикации прямо в mini app перед публикацией.';
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

      const extraPrizes = Array.from({ length: normalizedCount - current.prizes.length }, () => '');
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
      setEditorStep('prizes');
      const message = 'Добавьте текст публикации и при необходимости фото прямо в этом шаге.';
      setValidationHint(message);
      pushToast({
        tone: 'danger',
        title: 'Нужен текст публикации',
        description: message,
      });
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
  const isScheduledStart = Boolean(draft?.startsAtLocal.trim());
  const finalPrimaryLabel = firstConfigIssue
    ? 'Проверить'
    : publicationTextReady
      ? 'Опубликовать'
      : 'Заполнить публикацию';
  const finalPrimaryBusyLabel = firstConfigIssue
    ? 'Готовим…'
    : publicationTextReady
      ? 'Публикуем…'
      : 'Сохраняем…';
  const nextStepLabel =
    editorStep === 'basics'
      ? 'К условиям'
      : editorStep === 'conditions'
        ? 'К призам'
        : finalPrimaryLabel;
  const stickyTitle =
    editorStep === 'prizes'
      ? firstConfigIssue
        ? 'Нужно закончить'
        : publicationTextReady
          ? 'Готово к запуску'
          : 'Последний шаг: публикация'
      : `Шаг ${activeEditorStepIndex + 1}. ${activeEditorStep.title}`;
  const stickyDescription =
    editorStep === 'prizes'
      ? firstConfigIssue
        ? firstConfigIssue.message
        : publicationTextReady
          ? 'Черновик сохраним автоматически перед публикацией.'
          : 'Добавьте текст публикации и при необходимости фото прямо здесь.'
      : currentStepValidation.valid
        ? editorStep === 'basics'
          ? 'Дальше соберём условия участия и список каналов для проверки.'
          : 'Останется добавить места, призы и финально проверить публикацию.'
        : currentStepValidation.message;
  const showStickyCopy =
    !currentStepValidation.valid || (editorStep === 'prizes' && !publicationTextReady);
  const canOpenOwnedChannelsModal =
    !channelsQuery.isLoading && !channelsQuery.error && ownedSelectableChannels.length > 0;
  const handleStepPillClick = (stepId: GiveawayEditorStepId, stepIndex: number) => {
    if (stepIndex === activeEditorStepIndex) {
      return;
    }

    if (stepIndex > activeEditorStepIndex && !currentStepValidation.valid) {
      setValidationHint(currentStepValidation.message);
      pushToast({
        tone: 'danger',
        title: 'Проверьте шаг',
        description: currentStepValidation.message,
      });
      return;
    }

    setValidationHint('');
    setEditorStep(stepId);
  };

  const renderDashboardSurface = () => {
    if (listQuery.isLoading) {
      return (
        <div className="managed-giveaway__surface managed-giveaway__surface--dashboard">
          <div className="managed-giveaway__hero-head">
            <div className="managed-giveaway__hero-copy">
              <span className="managed-giveaway__eyebrow">Розыгрыши</span>
              <h2>Подгружаем сценарии</h2>
              <p>Проверяем активный сценарий.</p>
            </div>
            <div className="managed-giveaway__hero-badges">
              <span className="managed-giveaway__badge is-muted">Загрузка</span>
            </div>
          </div>
        </div>
      );
    }

    if (currentItem) {
      const currentIsDraft = currentItem.status === 'DRAFT';

      return (
        <div className="managed-giveaway__surface managed-giveaway__surface--dashboard">
          <div className="managed-giveaway__hero-head">
            <div className="managed-giveaway__hero-copy">
              <span className="managed-giveaway__eyebrow">
                {currentIsDraft ? 'Текущий черновик' : 'Активный сценарий'}
              </span>
              <h2>{currentItem.title}</h2>
              <p>{buildCurrentSubtitle(currentItem)}</p>
            </div>
            <div className="managed-giveaway__hero-badges">
              <span className={cn('managed-giveaway__badge', buildStatusTone(currentItem.status))}>
                {buildStatusLabel(currentItem.status)}
              </span>
            </div>
          </div>

          <div className="managed-giveaway__primary-actions">
            {currentIsDraft ? (
              <button
                type="button"
                className="button button--accent"
                disabled={isBusy}
                onClick={startEditCurrentDraft}
              >
                Продолжить настройку
              </button>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div className="managed-giveaway__surface managed-giveaway__surface--dashboard">
        <div className="managed-giveaway__hero-head">
          <div className="managed-giveaway__hero-copy">
            <span className="managed-giveaway__eyebrow">Розыгрыши</span>
            <h2>Соберите сценарий</h2>
            <p>3 шага и публикация полностью внутри mini app.</p>
          </div>
          <div className="managed-giveaway__hero-badges">
            <GiveawayHintAnchor
              hintKey="dashboard"
              openHintKey={openHintKey}
              onToggleHint={toggleHint}
              label="Как устроен запуск розыгрыша"
            >
              Здесь настраиваются тайминг, условия, призы и финальная публикация. Бот для запуска
              больше не нужен.
            </GiveawayHintAnchor>
          </div>
        </div>

        <div className="managed-giveaway__primary-actions">
          <button
            type="button"
            className="button button--accent"
            disabled={isBusy}
            onClick={startCreate}
          >
            Новый сценарий
          </button>
        </div>
      </div>
    );
  };

  const renderEditorSurface = () => {
    if (!draft) {
      return (
        <div className="managed-giveaway__surface managed-giveaway__surface--editor">
          <div className="managed-giveaway__hero-head">
            <div className="managed-giveaway__hero-copy">
              <span className="managed-giveaway__eyebrow">Черновик</span>
              <h2>Открываем сценарий</h2>
              <p>Подтягиваем актуальные данные и возвращаем вас на первый шаг.</p>
            </div>
            <div className="managed-giveaway__hero-badges">
              <span className="managed-giveaway__badge is-muted">
                {draftDetailsQuery.isLoading ? 'Загрузка' : 'Черновик'}
              </span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="managed-giveaway__surface managed-giveaway__surface--editor">
        <div className="managed-giveaway__hero-head">
          <div className="managed-giveaway__hero-copy">
            <span className="managed-giveaway__eyebrow">
              Шаг {activeEditorStepIndex + 1} из {editorSteps.length}
            </span>
            <h2>{activeEditorStep.title}</h2>
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
            {canSaveEditor ? (
              <button
                type="button"
                className="button button--ghost managed-giveaway__hero-button"
                onClick={() => {
                  void saveEditor();
                }}
                disabled={isBusy}
              >
                {createMutation.isPending || updateMutation.isPending ? 'Сохраняем…' : 'Сохранить'}
              </button>
            ) : null}
            <button
              type="button"
              className="button button--ghost managed-giveaway__hero-button managed-giveaway__hero-button--danger"
              onClick={cancelEditorDraft}
              disabled={isBusy}
            >
              {cancelMutation.isPending
                ? 'Удаляем…'
                : editorMode === 'create'
                  ? 'Сбросить'
                  : 'Удалить'}
            </button>
          </div>
        </div>

        <div className="managed-giveaway__step-strip" aria-label="Прогресс по шагам">
          {editorSteps.map((step, index) => (
            <button
              key={step.id}
              type="button"
              className={cn(
                'managed-giveaway__step-pill',
                index === activeEditorStepIndex && 'is-active',
                step.isComplete && 'is-complete',
              )}
              onClick={() => handleStepPillClick(step.id, index)}
              aria-current={index === activeEditorStepIndex ? 'step' : undefined}
              disabled={isBusy}
            >
              <span className="managed-giveaway__step-pill-index">
                {step.isComplete && index < activeEditorStepIndex ? '✓' : index + 1}
              </span>
              <strong>{step.label}</strong>
            </button>
          ))}
        </div>

        {editorStep === 'basics' ? (
          <div className="managed-giveaway__step-stage">
            <div className="managed-giveaway__section">
              <div className="managed-giveaway__title-row">
                <div className="managed-giveaway__section-copy">
                  <strong>Как называется розыгрыш</strong>
                </div>
                <div className="managed-giveaway__section-actions">
                  <span className="managed-giveaway__chip">
                    {draft.title.length}/{MANAGED_GIVEAWAY_TITLE_MAX_LENGTH}
                  </span>
                  <GiveawayHintAnchor
                    hintKey="title"
                    openHintKey={openHintKey}
                    onToggleHint={toggleHint}
                    label="Подсказка по названию розыгрыша"
                  >
                    Короткое название показывается в списке, карточке и публикации. Лучше держать
                    его коротким и сразу понятным.
                  </GiveawayHintAnchor>
                </div>
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
              <div className="managed-giveaway__title-row">
                <div className="managed-giveaway__section-copy">
                  <strong>Когда проходит</strong>
                </div>
                <div className="managed-giveaway__section-actions">
                  <GiveawayHintAnchor
                    hintKey="timing"
                    openHintKey={openHintKey}
                    onToggleHint={toggleHint}
                    label="Подсказка по таймингу розыгрыша"
                  >
                    Здесь задаются старт, финиш и срок на подтверждение приза. Быстрые чипы ускоряют
                    типовые сценарии, а ниже можно вручную уточнить дату и время.
                  </GiveawayHintAnchor>
                </div>
              </div>

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Старт</strong>
                  </div>
                  <div className="managed-giveaway__section-actions">
                    <span className="managed-giveaway__chip">
                      {isScheduledStart ? 'По времени' : 'Сразу'}
                    </span>
                    <GiveawayHintAnchor
                      hintKey="start"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label="Подсказка по старту розыгрыша"
                    >
                      Можно запустить розыгрыш сразу после финального шага или отложить его на
                      конкретную дату и время.
                    </GiveawayHintAnchor>
                  </div>
                </div>

                <div
                  className="managed-giveaway__choice-grid"
                  role="tablist"
                  aria-label="Режим старта"
                >
                  <button
                    type="button"
                    className={cn(
                      'managed-giveaway__choice-card',
                      !isScheduledStart && 'is-active',
                    )}
                    aria-pressed={!isScheduledStart}
                    disabled={isBusy}
                    onClick={() => toggleStartMode('instant')}
                  >
                    <span className="managed-giveaway__choice-copy">
                      <strong>Сразу</strong>
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
                ) : null}
              </div>

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Финиш</strong>
                  </div>
                  <div className="managed-giveaway__section-actions">
                    <span className="managed-giveaway__chip">
                      {formatCompactInputDateTime(draft.endsAtLocal, 'Не задан')}
                    </span>
                    <GiveawayHintAnchor
                      hintKey="finish"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label="Подсказка по завершению розыгрыша"
                    >
                      Быстрые чипы ставят типовой срок. Если нужно, ниже можно вручную задать точную
                      дату и время завершения.
                    </GiveawayHintAnchor>
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
            </div>
          </div>
        ) : null}

        {editorStep === 'conditions' ? (
          <div className="managed-giveaway__step-stage">
            <div className="managed-giveaway__section managed-giveaway__section--conditions">
              <div className="managed-giveaway__title-row">
                <div className="managed-giveaway__section-copy">
                  <strong>Кто участвует</strong>
                </div>
                <div className="managed-giveaway__section-actions">
                  <span className="managed-giveaway__badge is-muted">
                    {draft.requiredChannelIds.length}/{MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}
                  </span>
                  <GiveawayHintAnchor
                    hintKey="conditions"
                    openHintKey={openHintKey}
                    onToggleHint={toggleHint}
                    label="Подсказка по условиям участия"
                  >
                    Подписка на источник обязательна всегда. Дополнительные каналы добавляйте только
                    когда они реально участвуют в механике розыгрыша.
                  </GiveawayHintAnchor>
                </div>
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
                  <strong>Пока только источник</strong>
                  {channelsQuery.isLoading ? <span>Загружаем ваши каналы…</span> : null}
                  {!channelsQuery.isLoading && canOpenOwnedChannelsModal ? (
                    <button
                      type="button"
                      className="button button--ghost managed-giveaway__empty-action"
                      onClick={openOwnedChannelsModal}
                      disabled={isBusy}
                    >
                      Добавить свой канал
                    </button>
                  ) : null}
                  {!channelsQuery.isLoading &&
                  !channelsQuery.error &&
                  ownedSelectableChannels.length === 0 ? (
                    <span>Нет доступных каналов, где бот уже администратор.</span>
                  ) : null}
                </div>
              )}

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Свой канал</strong>
                  </div>
                  <div className="managed-giveaway__section-actions">
                    <GiveawayHintAnchor
                      hintKey="conditionsOwned"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label="Подсказка по выбору своего канала"
                    >
                      Здесь показываются ваши каналы, где бот уже подключён и у вас есть доступ на
                      управление.
                    </GiveawayHintAnchor>
                    <button
                      type="button"
                      className="button button--ghost managed-giveaway__channel-action"
                      disabled={isBusy || !canOpenOwnedChannelsModal}
                      onClick={openOwnedChannelsModal}
                    >
                      {selectedOwnedChannelIds.length > 0
                        ? `Выбрано · ${selectedOwnedChannelIds.length}`
                        : 'Открыть список'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Чужой канал</strong>
                  </div>
                  <div className="managed-giveaway__section-actions">
                    <GiveawayHintAnchor
                      hintKey="conditionsLink"
                      openHintKey={openHintKey}
                      onToggleHint={toggleHint}
                      label="Подсказка по добавлению канала по ссылке"
                    >
                      Вставьте публичную ссылку MAX. Мы проверим её и добавим канал без ручного
                      поиска по списку.
                    </GiveawayHintAnchor>
                  </div>
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
              <div className="managed-giveaway__title-row">
                <div className="managed-giveaway__section-copy">
                  <strong>Что получают победители</strong>
                </div>
                <div className="managed-giveaway__section-actions">
                  <span className="managed-giveaway__chip">{draft.prizes.length} места</span>
                  <GiveawayHintAnchor
                    hintKey="prizes"
                    openHintKey={openHintKey}
                    onToggleHint={toggleHint}
                    label="Подсказка по настройке призов"
                  >
                    Один приз на одну строку. Так карточка, результаты и публикация остаются
                    компактными и читаемыми.
                  </GiveawayHintAnchor>
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
                  <span>Места</span>
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
                  <div key={`draft-prize-${index}`} className="managed-giveaway__prize-editor-row">
                    <span className="managed-giveaway__prize-position">{index + 1}</span>
                    <label className="field">
                      <input
                        type="text"
                        value={prizeTitle}
                        placeholder="Приз"
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

              <div className="managed-giveaway__subsection">
                <div className="managed-giveaway__subsection-row">
                  <div className="managed-giveaway__subsection-copy">
                    <strong>Публикация</strong>
                  </div>
                  <div className="managed-giveaway__section-actions">
                    <span className="managed-giveaway__chip">
                      {draft.description.trim() ? `${draft.description.trim().length}/2000` : 'Текст'}
                    </span>
                  </div>
                </div>

                <label className="field">
                  <span>Текст публикации</span>
                  <textarea
                    rows={5}
                    value={draft.description}
                    onChange={(event) =>
                      updateDraft((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                    maxLength={2_000}
                    placeholder="Опишите розыгрыш, условия и что получат победители."
                    disabled={isBusy}
                  />
                </label>

                <div className="managed-giveaway__editor-grid managed-giveaway__editor-grid--align-end">
                  <label className="field">
                    <span>Фото публикации</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handlePublicationImageChange}
                      disabled={isBusy}
                    />
                  </label>
                  {draft.imageEnabled ? (
                    <div className="managed-giveaway__section-actions managed-giveaway__section-actions--align-end">
                      <button
                        type="button"
                        className="button button--ghost managed-giveaway__channel-action"
                        onClick={clearPublicationImage}
                        disabled={isBusy}
                      >
                        Убрать фото
                      </button>
                    </div>
                  ) : null}
                </div>

                {draft.imageEnabled ? (
                  <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                    <strong>Фото прикреплено</strong>
                    <span>{draft.imageFileName || 'Изображение готово к публикации.'}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {validationHint ? (
          <div className="managed-giveaway__error-inline">{validationHint}</div>
        ) : null}
        {editorError ? <div className="managed-giveaway__error-inline">{editorError}</div> : null}

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
    );
  };

  const renderOwnedChannelsModal = () => {
    if (
      typeof document === 'undefined' ||
      !channelModalOpen ||
      editorStep !== 'conditions' ||
      !draft
    ) {
      return null;
    }

    return createPortal(
      <div className="managed-giveaway-modal" aria-hidden={!channelModalOpen}>
        <button
          type="button"
          className="managed-giveaway-modal__backdrop"
          aria-label="Закрыть выбор каналов"
          onClick={() => setChannelModalOpen(false)}
        />

        <section
          className="managed-giveaway-modal__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="managed-giveaway-modal-title"
        >
          <div className="managed-giveaway-modal__grabber" aria-hidden />

          <div className="managed-giveaway-modal__sheet">
            <div className="managed-giveaway-modal__head">
              <div>
                <strong id="managed-giveaway-modal-title">Добавьте свои каналы</strong>
                <small>Отметьте каналы, которые станут дополнительным условием участия.</small>
              </div>
              <span className="managed-giveaway__badge is-muted">
                {channelModalSelection.length}/{ownedSelectableChannels.length}
              </span>
            </div>

            {channelsQuery.isLoading ? (
              <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                <strong>Загружаем каналы</strong>
              </div>
            ) : null}

            {!channelsQuery.isLoading && channelsQuery.error ? (
              <div className="managed-giveaway__error-inline">
                {formatApiError(channelsQuery.error, 'Не удалось загрузить список каналов.')}
              </div>
            ) : null}

            {!channelsQuery.isLoading &&
            !channelsQuery.error &&
            ownedSelectableChannels.length === 0 ? (
              <div className="managed-giveaway__empty managed-giveaway__empty--soft">
                <strong>Нет доступных каналов</strong>
                <span>Бот должен быть администратором канала, чтобы включить его в проверку.</span>
              </div>
            ) : null}

            {!channelsQuery.isLoading &&
            !channelsQuery.error &&
            ownedSelectableChannels.length > 0 ? (
              <div className="managed-giveaway-modal__list" aria-label="Список своих каналов">
                {ownedSelectableChannels.map((channel) => {
                  const checked = channelModalSelection.includes(channel.id);

                  return (
                    <label
                      key={`owned-channel-option-${channel.id}`}
                      className={cn('managed-giveaway-modal__option', checked && 'is-selected')}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setChannelModalSelection((current) =>
                            current.includes(channel.id)
                              ? current.filter((item) => item !== channel.id)
                              : [...current, channel.id],
                          );
                        }}
                        disabled={isBusy}
                      />
                      <span className="managed-giveaway-modal__checkbox" aria-hidden>
                        {checked ? '✓' : ''}
                      </span>
                      <span className="managed-giveaway-modal__option-copy">
                        <strong>{channel.title}</strong>
                        {channel.link ? <small>{channel.link}</small> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}

            <div className="managed-giveaway-modal__actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setChannelModalOpen(false)}
                disabled={isBusy}
              >
                Отмена
              </button>
              <button
                type="button"
                className="button button--accent"
                onClick={applyOwnedChannelsSelection}
                disabled={isBusy}
              >
                Сохранить выбор
              </button>
            </div>
          </div>
        </section>
      </div>,
      document.body,
    );
  };

  return (
    <div
      className={cn(
        'managed-giveaway',
        isEditingOpen ? 'managed-giveaway--editing' : 'managed-giveaway--dashboard',
        isEditingOpen && `managed-giveaway--step-${editorStep}`,
      )}
    >
      {!isEditingOpen ? renderDashboardSurface() : null}

      {isEditingOpen ? renderEditorSurface() : null}

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

      {renderOwnedChannelsModal()}
    </div>
  );
}
