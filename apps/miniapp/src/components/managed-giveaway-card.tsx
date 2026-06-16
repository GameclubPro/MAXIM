import {
  type ChatSummary,
  MANAGED_GIVEAWAY_MAX_PRIZES,
  MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS,
  MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH,
  MANAGED_GIVEAWAY_TITLE_MAX_LENGTH,
  type ManagedGiveawayDetails,
  type ManagedGiveawaySummary,
  type ManagedGiveawayWinner,
} from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { getChannels } from '../lib/api/root-client';
import {
  cancelManagedGiveaway,
  closeManagedGiveaway,
  createManagedGiveaway,
  deleteManagedGiveaway,
  getManagedGiveaway,
  getManagedGiveaways,
  markManagedGiveawayWinnerDelivered,
  publishManagedGiveaway,
  rerollManagedGiveawayWinner,
  resolveManagedGiveawayRequiredChannel,
  updateManagedGiveaway,
} from '../lib/api/managed-giveaway-client';
import type { ApiTransport } from '../lib/api/transport';
import type { UpdateManagedGiveawayPayload } from '../lib/api/shared-types';
import { cn } from '../lib/cn';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import {
  canShareNativeContent,
  maxNotify,
  maxSelectionChanged,
  openMaxBotLink,
  shareNativeContent,
} from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { queryKeys } from '../lib/query-keys';
import { TimeField } from './ui/time-field';
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
type GiveawayValidationFocusTarget = 'title' | 'endsAt' | 'channels' | 'prizes';

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

function resolveValidationFocusTarget(issue: {
  step: GiveawayEditorStepId;
  message: string;
}): GiveawayValidationFocusTarget {
  if (issue.step === 'conditions') {
    return 'channels';
  }

  if (issue.step === 'prizes') {
    return 'prizes';
  }

  if (issue.message.toLowerCase().includes('название')) {
    return 'title';
  }

  return 'endsAt';
}

function areStringListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => item === right[index]);
}

function isDraftEqual(left: GiveawayEditorDraft, right: GiveawayEditorDraft): boolean {
  return (
    left.title === right.title &&
    left.description === right.description &&
    left.startsAtLocal === right.startsAtLocal &&
    left.endsAtLocal === right.endsAtLocal &&
    left.claimHours === right.claimHours &&
    left.imageEnabled === right.imageEnabled &&
    left.imageBase64 === right.imageBase64 &&
    left.imageMimeType === right.imageMimeType &&
    left.imageFileName === right.imageFileName &&
    areStringListsEqual(left.requiredChannelIds, right.requiredChannelIds) &&
    areStringListsEqual(left.prizes, right.prizes)
  );
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

function buildWinnerStatusLabel(status: ManagedGiveawayWinner['status']): string {
  if (status === 'DELIVERED') {
    return 'Выдан';
  }
  if (status === 'CLAIMED') {
    return 'Ожидает выдачи';
  }
  if (status === 'SELECTED') {
    return 'Новый победитель';
  }
  if (status === 'EXPIRED') {
    return 'Нужен реролл';
  }
  return 'Архив';
}

function formatCompactMetricDate(value: string | null, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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
  const [resolvedExternalChannels, setResolvedExternalChannels] = useState<
    Record<string, { title: string; link: string | null }>
  >({});
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const endDateInputRef = useRef<HTMLInputElement | null>(null);
  const channelLinkInputRef = useRef<HTMLInputElement | null>(null);
  const firstPrizeInputRef = useRef<HTMLInputElement | null>(null);
  const channelModalPanelRef = useRef<HTMLElement | null>(null);
  const channelModalReturnFocusRef = useRef<HTMLElement | null>(null);

  const listQueryKey = useMemo(
    () => queryKeys.managedGiveaways(entityType, entityId),
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
  const featuredItem = currentItem ?? sortedItems[0] ?? null;
  const featuredGiveawayId = featuredItem?.id ?? null;

  const draftDetailsQuery = useQuery({
    queryKey: queryKeys.managedGiveawayDetails(entityType, entityId, editingGiveawayId),
    queryFn: () => {
      if (!editingGiveawayId) {
        throw new Error('Черновик не выбран.');
      }
      return getManagedGiveaway(api, entityType, entityId, editingGiveawayId);
    },
    enabled: editorMode === 'edit' && Boolean(entityId) && Boolean(editingGiveawayId),
    refetchOnWindowFocus: false,
  });

  const featuredDetailsQuery = useQuery({
    queryKey: queryKeys.managedGiveawayDetails(entityType, entityId, featuredGiveawayId),
    queryFn: () => {
      if (!featuredGiveawayId) {
        throw new Error('Розыгрыш не выбран.');
      }
      return getManagedGiveaway(api, entityType, entityId, featuredGiveawayId);
    },
    enabled: editorMode === 'closed' && Boolean(entityId) && Boolean(featuredGiveawayId),
    refetchOnWindowFocus: false,
  });

  const channelsQuery = useQuery({
    queryKey: queryKeys.giveawayOwnedChannels,
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

  useHintPopoverAutoPosition(openHintKey !== null, openHintKey);

  useEffect(() => {
    if (!channelModalOpen || typeof window === 'undefined') {
      return undefined;
    }

    window.requestAnimationFrame(() => {
      channelModalPanelRef.current?.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setChannelModalOpen(false);
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const panel = channelModalPanelRef.current;
      if (!panel) {
        return;
      }

      const focusableElements = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('aria-hidden'));
      const firstElement = focusableElements[0];
      const lastElement = focusableElements.at(-1);

      if (!firstElement || !lastElement) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [channelModalOpen]);

  useEffect(() => {
    if (channelModalOpen || typeof window === 'undefined') {
      return;
    }

    const target = channelModalReturnFocusRef.current;
    channelModalReturnFocusRef.current = null;
    if (!target) {
      return;
    }

    window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
    });
  }, [channelModalOpen]);

  const toggleHint = (hintKey: GiveawayHintKey) => {
    setOpenHintKey((current) => (current === hintKey ? null : hintKey));
  };

  const isDirty =
    editorMode === 'edit'
      ? Boolean(draft && savedSnapshot && !isDraftEqual(draft, savedSnapshot))
      : true;
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

  const selectedRequiredChannels = useMemo(() => {
    if (!draft) {
      return [];
    }
    return draft.requiredChannelIds.map((channelId) => {
      const channel = channelById.get(channelId);
      const externalChannel = resolvedExternalChannels[channelId];
      return {
        id: channelId,
        title: channel?.title?.trim() || externalChannel?.title?.trim() || 'Канал из условий',
        link: channel?.link ?? externalChannel?.link ?? null,
      };
    });
  }, [channelById, draft, resolvedExternalChannels]);

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

  const resolveRequiredChannelMutation = useMutation({
    mutationFn: (value: string) =>
      resolveManagedGiveawayRequiredChannel(api, entityType, entityId, value),
  });

  const closeMutation = useMutation({
    mutationFn: (giveawayId: string) => closeManagedGiveaway(api, entityType, entityId, giveawayId),
  });

  const rerollMutation = useMutation({
    mutationFn: (params: { giveawayId: string; winnerId: string }) =>
      rerollManagedGiveawayWinner(api, entityType, entityId, params.giveawayId, params.winnerId),
  });

  const deliverMutation = useMutation({
    mutationFn: (params: { giveawayId: string; winnerId: string }) =>
      markManagedGiveawayWinnerDelivered(
        api,
        entityType,
        entityId,
        params.giveawayId,
        params.winnerId,
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (giveawayId: string) =>
      deleteManagedGiveaway(api, entityType, entityId, giveawayId),
  });

  const isBusy =
    createMutation.isPending ||
    updateMutation.isPending ||
    publishMutation.isPending ||
    cancelMutation.isPending ||
    resolveRequiredChannelMutation.isPending ||
    closeMutation.isPending ||
    rerollMutation.isPending ||
    deliverMutation.isPending ||
    deleteMutation.isPending;

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
    setResolvedExternalChannels({});
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
    setResolvedExternalChannels({});
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
      const { prepareBroadcastImage } = await import('../lib/broadcast-image');
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

  const openOwnedChannelsModal = (event?: ReactMouseEvent<HTMLElement>) => {
    if (typeof document !== 'undefined') {
      channelModalReturnFocusRef.current =
        event?.currentTarget ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    }
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
    const normalizedChannelId = normalizeChannelId(channelId);
    if (!normalizedChannelId || normalizedChannelId === entityId) {
      return;
    }
    if ((draft?.requiredChannelIds.length ?? 0) >= MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS) {
      setValidationHint(`Доп. каналов: максимум ${MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}.`);
      return;
    }

    setDraft((current) => {
      if (!current) {
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

  const addRequiredChannelByLink = async () => {
    const normalized = normalizeChannelLink(channelLinkValue);
    if (!normalized) {
      setValidationHint('Вставьте ссылку канала.');
      return;
    }
    if ((draft?.requiredChannelIds.length ?? 0) >= MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS) {
      setValidationHint(`Доп. каналов: максимум ${MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}.`);
      return;
    }

    try {
      const result = await resolveRequiredChannelMutation.mutateAsync(channelLinkValue);
      const channel = result.channel;
      if (channel.id === entityId) {
        setValidationHint('Источник уже входит в обязательную проверку.');
        return;
      }
      if (draft?.requiredChannelIds.includes(channel.id)) {
        setValidationHint('Канал уже добавлен в условия.');
        return;
      }

      setResolvedExternalChannels((current) => ({
        ...current,
        [channel.id]: {
          title: channel.title,
          link: channel.link ?? null,
        },
      }));
      addRequiredChannelById(channel.id);
      pushToast({
        tone: 'success',
        title: 'Канал добавлен',
        description: channel.title,
      });
    } catch (error: unknown) {
      const message = formatApiError(error, 'Не удалось проверить ссылку канала.');
      setValidationHint(message);
      pushToast({
        tone: 'danger',
        title: 'Не удалось добавить канал',
        description: message,
      });
    }
  };

  const refetchManagedGiveaways = async () => {
    await Promise.all([
      listQuery.refetch(),
      queryClient.invalidateQueries({
        queryKey: queryKeys.managedGiveawayDetailsScope(entityType, entityId),
      }),
    ]);
  };

  const openManagedGiveawayLink = (url: string | null) => {
    const targetUrl = url?.trim() ?? '';
    if (!targetUrl || typeof window === 'undefined') {
      return;
    }

    if (window.MAX?.WebApp ?? window.WebApp) {
      maxSelectionChanged();
      openMaxBotLink(targetUrl);
      return;
    }

    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  };

  const shareManagedGiveawayLink = async (url: string | null, label: string) => {
    const targetUrl = url?.trim() ?? '';
    if (!targetUrl) {
      return;
    }

    try {
      maxSelectionChanged();
      await shareNativeContent({
        text: label,
        link: targetUrl,
        preferMax: true,
      });
      maxNotify('success');
    } catch {
      openManagedGiveawayLink(targetUrl);
    }
  };

  const closeFeaturedGiveaway = async () => {
    if (!featuredItem) {
      return;
    }

    try {
      await closeMutation.mutateAsync(featuredItem.id);
      await refetchManagedGiveaways();
      pushToast({
        tone: 'success',
        title: 'Розыгрыш завершён',
      });
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось завершить розыгрыш',
        description: formatApiError(error, 'Не удалось завершить розыгрыш.'),
      });
    }
  };

  const rerollFeaturedWinner = async (winnerId: string) => {
    if (!featuredItem) {
      return;
    }

    try {
      await rerollMutation.mutateAsync({
        giveawayId: featuredItem.id,
        winnerId,
      });
      await refetchManagedGiveaways();
      pushToast({
        tone: 'success',
        title: 'Реролл выполнен',
      });
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сделать реролл',
        description: formatApiError(error, 'Не удалось сделать реролл.'),
      });
    }
  };

  const markFeaturedWinnerDelivered = async (winnerId: string) => {
    if (!featuredItem) {
      return;
    }

    try {
      await deliverMutation.mutateAsync({
        giveawayId: featuredItem.id,
        winnerId,
      });
      await refetchManagedGiveaways();
      pushToast({
        tone: 'success',
        title: 'Выдача отмечена',
      });
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отметить выдачу',
        description: formatApiError(error, 'Не удалось отметить выдачу.'),
      });
    }
  };

  const deleteFeaturedGiveaway = async () => {
    if (!featuredItem) {
      return;
    }

    try {
      await deleteMutation.mutateAsync(featuredItem.id);
      await refetchManagedGiveaways();
      pushToast({
        tone: 'success',
        title: 'Розыгрыш удалён',
      });
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить розыгрыш',
        description: formatApiError(error, 'Не удалось удалить розыгрыш.'),
      });
    }
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
      const targetStep = !basicsValidation.valid
        ? 'basics'
        : !conditionsValidation.valid
          ? 'conditions'
          : 'prizes';
      focusEditorTarget(
        resolveValidationFocusTarget({
          step: targetStep,
          message: checked.message,
        }),
      );
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
      showEditorIssue(firstConfigIssue, 'Закончите настройку');
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
      focusEditorTarget(
        resolveValidationFocusTarget({
          step: 'prizes',
          message: checked.message,
        }),
      );
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

      const lastFilledPrize = [...current.prizes].reverse().find((item) => item.trim()) ?? '';
      const extraPrizes = Array.from(
        { length: normalizedCount - current.prizes.length },
        () => lastFilledPrize,
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
      showEditorIssue(
        {
          step: editorStep,
          message: currentStepValidation.message,
        },
        'Проверьте шаг',
      );
      return;
    }

    setValidationHint('');
    setEditorStep(editorSteps[activeEditorStepIndex + 1]?.id ?? 'publish');
  };

  const handleFinalPrimaryAction = () => {
    if (firstConfigIssue) {
      showEditorIssue(firstConfigIssue, 'Закончите настройку');
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
  useNativeBackHandler(
    () => {
      setOpenHintKey(null);
      return true;
    },
    { enabled: openHintKey !== null, priority: 520 },
  );
  useNativeBackHandler(
    () => {
      setChannelModalOpen(false);
      return true;
    },
    { enabled: channelModalOpen, priority: 650 },
  );
  useNativeBackHandler(
    () => {
      if (isBusy) {
        return false;
      }

      clearEditor();
      return true;
    },
    { enabled: isEditingOpen, priority: 540 },
  );
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
  const requiredChannelLimitReached =
    (draft?.requiredChannelIds.length ?? 0) >= MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS;
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

  const focusEditorTarget = (target: GiveawayValidationFocusTarget) => {
    if (target === 'channels') {
      setEditorStep('conditions');
    } else if (target === 'prizes') {
      setEditorStep('prizes');
    } else {
      setEditorStep('basics');
    }

    if (typeof window === 'undefined') {
      return;
    }

    window.setTimeout(() => {
      const element =
        target === 'title'
          ? titleInputRef.current
          : target === 'endsAt'
            ? endDateInputRef.current
            : target === 'channels'
              ? channelLinkInputRef.current
              : firstPrizeInputRef.current;

      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
  };

  const showEditorIssue = (
    issue: { step: GiveawayEditorStepId; message: string },
    toastTitle: string,
  ) => {
    setValidationHint(issue.message);
    focusEditorTarget(resolveValidationFocusTarget(issue));
    pushToast({
      tone: 'danger',
      title: toastTitle,
      description: issue.message,
    });
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

    if (featuredItem) {
      const currentIsDraft = featuredItem.status === 'DRAFT';
      const dashboardDetails = featuredDetailsQuery.data ?? null;
      const featuredPrizes = dashboardDetails?.prizes ?? [];
      const featuredWinners =
        dashboardDetails?.winners.filter((winner) => winner.status !== 'REROLLED') ?? [];
      const requiredChannelsCount = dashboardDetails?.requiredChannelIds.length ?? 0;
      const canStartNewScenario = !currentItem && !currentIsDraft;
      const canCloseFeatured =
        featuredItem.status === 'ACTIVE' || featuredItem.status === 'SCHEDULED';
      const canDeleteFeatured =
        featuredItem.status === 'COMPLETED' || featuredItem.status === 'CANCELED';
      const dashboardEyebrow = currentIsDraft
        ? 'Текущий черновик'
        : currentItem
          ? 'Текущий розыгрыш'
          : featuredItem.status === 'COMPLETED'
            ? 'Последний завершённый'
            : 'Последний сценарий';

      return (
        <div className="managed-giveaway__surface managed-giveaway__surface--dashboard">
          <div className="managed-giveaway__hero-head">
            <div className="managed-giveaway__hero-copy">
              <span className="managed-giveaway__eyebrow">{dashboardEyebrow}</span>
              <h2>{featuredItem.title}</h2>
              <p>{buildCurrentSubtitle(featuredItem)}</p>
            </div>
            <div className="managed-giveaway__hero-badges">
              <span className={cn('managed-giveaway__badge', buildStatusTone(featuredItem.status))}>
                {buildStatusLabel(featuredItem.status)}
              </span>
              {featuredItem.hasImage ? (
                <span className="managed-giveaway__badge is-muted">С фото</span>
              ) : null}
              {featuredDetailsQuery.isLoading ? (
                <span className="managed-giveaway__badge is-muted">Обновляем</span>
              ) : null}
            </div>
          </div>

          <div className="managed-giveaway__dashboard-stat-grid">
            <div className="managed-giveaway__dashboard-stat">
              <span>Заявки</span>
              <strong>{featuredItem.entriesCount}</strong>
              <small>{featuredItem.verifiedEntriesCount} подтверждено</small>
            </div>
            <div className="managed-giveaway__dashboard-stat">
              <span>Условия</span>
              <strong>{1 + requiredChannelsCount}</strong>
              <small>
                {requiredChannelsCount > 0 ? 'доп. каналы включены' : 'только источник'}
              </small>
            </div>
            <div className="managed-giveaway__dashboard-stat">
              <span>Места</span>
              <strong>{featuredPrizes.length || featuredItem.winnersCount || '—'}</strong>
              <small>
                {featuredWinners.length > 0
                  ? `${featuredWinners.length} победителей уже выбрано`
                  : currentIsDraft
                    ? 'список призов готовится'
                    : 'итоги появятся после закрытия'}
              </small>
            </div>
            <div className="managed-giveaway__dashboard-stat">
              <span>{featuredItem.status === 'COMPLETED' ? 'Итоги' : 'Финиш'}</span>
              <strong>
                {formatCompactMetricDate(
                  featuredItem.completedAt ?? featuredItem.endsAt,
                  'Без даты',
                )}
              </strong>
              <small>
                {featuredItem.status === 'SCHEDULED'
                  ? `Старт ${formatCompactMetricDate(featuredItem.startsAt, 'сразу')}`
                  : featuredItem.status === 'CANCELED'
                    ? 'розыгрыш остановлен'
                    : currentIsDraft
                      ? 'можно донастроить и опубликовать'
                      : 'актуальный тайминг сценария'}
              </small>
            </div>
          </div>

          {dashboardDetails?.description.trim() ? (
            <div className="managed-giveaway__dashboard-note">
              <strong>Публикация</strong>
              <p>{dashboardDetails.description.trim()}</p>
            </div>
          ) : null}

          {featuredPrizes.length > 0 ? (
            <div className="managed-giveaway__dashboard-prize-rail">
              {featuredPrizes.slice(0, 3).map((prize) => (
                <div
                  key={`featured-prize-${prize.id}`}
                  className="managed-giveaway__dashboard-prize-chip"
                >
                  <span>{prize.position} место</span>
                  <strong>{prize.title}</strong>
                </div>
              ))}
              {featuredPrizes.length > 3 ? (
                <div className="managed-giveaway__dashboard-prize-chip is-muted">
                  <span>Ещё</span>
                  <strong>+{featuredPrizes.length - 3}</strong>
                </div>
              ) : null}
            </div>
          ) : null}

          {featuredItem.publicationUrl || featuredItem.resultsUrl ? (
            <div className="managed-giveaway__dashboard-links">
              {featuredItem.publicationUrl ? (
                <button
                  type="button"
                  className="button button--ghost managed-giveaway__dashboard-link"
                  onClick={() => openManagedGiveawayLink(featuredItem.publicationUrl)}
                  disabled={isBusy}
                >
                  Открыть пост
                </button>
              ) : null}
              {featuredItem.publicationUrl && canShareNativeContent() ? (
                <button
                  type="button"
                  className="button button--ghost managed-giveaway__dashboard-link"
                  onClick={() =>
                    void shareManagedGiveawayLink(featuredItem.publicationUrl, featuredItem.title)
                  }
                  disabled={isBusy}
                >
                  Поделиться
                </button>
              ) : null}
              {featuredItem.resultsUrl ? (
                <button
                  type="button"
                  className="button button--ghost managed-giveaway__dashboard-link"
                  onClick={() => openManagedGiveawayLink(featuredItem.resultsUrl)}
                  disabled={isBusy}
                >
                  Открыть итоги
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="managed-giveaway__primary-actions managed-giveaway__primary-actions--dashboard">
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
            {canCloseFeatured ? (
              <button
                type="button"
                className="button button--accent"
                disabled={isBusy}
                onClick={() => {
                  void closeFeaturedGiveaway();
                }}
              >
                {closeMutation.isPending ? 'Завершаем…' : 'Завершить сейчас'}
              </button>
            ) : null}
            {canStartNewScenario ? (
              <button
                type="button"
                className="button button--accent"
                disabled={isBusy}
                onClick={startCreate}
              >
                Новый сценарий
              </button>
            ) : null}
            {canDeleteFeatured ? (
              <button
                type="button"
                className="button button--ghost managed-giveaway__dashboard-link managed-giveaway__dashboard-link--danger"
                disabled={isBusy}
                onClick={() => {
                  void deleteFeaturedGiveaway();
                }}
              >
                {deleteMutation.isPending ? 'Удаляем…' : 'Удалить сценарий'}
              </button>
            ) : null}
          </div>

          {featuredWinners.length > 0 ? (
            <div className="managed-giveaway__section managed-giveaway__section--dashboard">
              <div className="managed-giveaway__title-row">
                <div className="managed-giveaway__section-copy">
                  <strong>Победители</strong>
                </div>
                <div className="managed-giveaway__section-actions">
                  <span className="managed-giveaway__chip">{featuredWinners.length} мест</span>
                </div>
              </div>

              <div className="managed-giveaway__dashboard-winner-list">
                {featuredWinners.map((winner) => {
                  const canReroll =
                    winner.status === 'SELECTED' ||
                    winner.status === 'CLAIMED' ||
                    winner.status === 'EXPIRED';
                  const canDeliver = winner.status === 'SELECTED' || winner.status === 'CLAIMED';

                  return (
                    <div key={winner.id} className="managed-giveaway__dashboard-winner">
                      <div className="managed-giveaway__dashboard-winner-rank">
                        {winner.prizePosition}
                      </div>
                      <div className="managed-giveaway__dashboard-winner-copy">
                        <strong>{winner.displayName?.trim() || 'Победитель определён'}</strong>
                        <span>{winner.prizeTitle}</span>
                      </div>
                      <div className="managed-giveaway__dashboard-winner-side">
                        <span
                          className={cn(
                            'managed-giveaway__badge',
                            winner.status === 'DELIVERED'
                              ? 'is-success'
                              : winner.status === 'EXPIRED'
                                ? 'is-danger'
                                : 'is-warning',
                          )}
                        >
                          {buildWinnerStatusLabel(winner.status)}
                        </span>
                        {canDeliver || canReroll ? (
                          <div className="managed-giveaway__dashboard-winner-actions">
                            {canDeliver ? (
                              <button
                                type="button"
                                className="button button--ghost managed-giveaway__dashboard-link"
                                disabled={isBusy}
                                onClick={() => {
                                  void markFeaturedWinnerDelivered(winner.id);
                                }}
                              >
                                {deliverMutation.isPending ? 'Сохраняем…' : 'Выдано'}
                              </button>
                            ) : null}
                            {canReroll ? (
                              <button
                                type="button"
                                className="button button--ghost managed-giveaway__dashboard-link"
                                disabled={isBusy}
                                onClick={() => {
                                  void rerollFeaturedWinner(winner.id);
                                }}
                              >
                                {rerollMutation.isPending ? 'Рероллим…' : 'Реролл'}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {featuredDetailsQuery.error ? (
            <div className="managed-giveaway__error-inline">
              {formatApiError(
                featuredDetailsQuery.error,
                'Не удалось подгрузить детали розыгрыша.',
              )}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="managed-giveaway__surface managed-giveaway__surface--dashboard">
        <div className="managed-giveaway__hero-head">
          <div className="managed-giveaway__hero-copy">
            <span className="managed-giveaway__eyebrow">Розыгрыши</span>
            <h2>Соберите сценарий</h2>
            <p>Запуск и итоги внутри mini app.</p>
          </div>
          <div className="managed-giveaway__hero-badges">
            <GiveawayHintAnchor
              hintKey="dashboard"
              openHintKey={openHintKey}
              onToggleHint={toggleHint}
              label="Как устроен запуск розыгрыша"
            >
              Здесь настраиваются тайминг, условия, призы и публикация.
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
                  ref={titleInputRef}
                  type="text"
                  value={draft.title}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  maxLength={MANAGED_GIVEAWAY_TITLE_MAX_LENGTH}
                  aria-invalid={!basicsValidation.valid && !draft.title.trim()}
                  aria-describedby={validationHint ? 'managed-giveaway-editor-alert' : undefined}
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
                  role="group"
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
                    <div className="field">
                      <TimeField
                        label="Время"
                        value={readTimeInputPart(draft.startsAtLocal, '12:00')}
                        variant="embedded"
                        onChange={updateStartTime}
                        disabled={isBusy}
                      />
                    </div>
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
                      ref={endDateInputRef}
                      type="date"
                      value={readDateInputPart(draft.endsAtLocal)}
                      onChange={(event) => updateEndDate(event.target.value)}
                      aria-invalid={!basicsValidation.valid}
                      aria-describedby={
                        validationHint ? 'managed-giveaway-editor-alert' : undefined
                      }
                      disabled={isBusy}
                    />
                  </label>
                  <div className="field">
                    <TimeField
                      label="Время"
                      value={readTimeInputPart(draft.endsAtLocal, '21:00')}
                      variant="embedded"
                      onChange={updateEndTime}
                      disabled={isBusy}
                    />
                  </div>
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
                    Доп. каналы {draft.requiredChannelIds.length}/
                    {MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS}
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
                        {item.link ? <small>{item.link}</small> : null}
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
                      ref={channelLinkInputRef}
                      type="text"
                      value={channelLinkValue}
                      onChange={(event) => {
                        setChannelLinkValue(event.target.value);
                        setValidationHint('');
                        setEditorError('');
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') {
                          return;
                        }

                        event.preventDefault();
                        void addRequiredChannelByLink();
                      }}
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      enterKeyHint="done"
                      placeholder="https://max.ru/..."
                      aria-invalid={!conditionsValidation.valid}
                      aria-describedby={
                        validationHint ? 'managed-giveaway-editor-alert' : undefined
                      }
                      disabled={isBusy || requiredChannelLimitReached}
                    />
                  </label>
                  <div className="managed-giveaway__section-actions managed-giveaway__section-actions--align-end">
                    <button
                      type="button"
                      className="button button--ghost managed-giveaway__channel-action"
                      disabled={isBusy || requiredChannelLimitReached}
                      onClick={() => {
                        void addRequiredChannelByLink();
                      }}
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

              <div className="managed-giveaway__prize-presets" aria-label="Быстрое количество мест">
                {[3, 5, 10].map((count) => (
                  <button
                    key={`giveaway-prize-count-${count}`}
                    type="button"
                    className={cn(
                      'managed-giveaway__chip-button',
                      draft.prizes.length === count && 'is-active',
                    )}
                    onClick={() => setPrizeCount(count)}
                    disabled={isBusy}
                  >
                    {count}
                  </button>
                ))}
              </div>

              <div className="managed-giveaway__prize-editor-list">
                {draft.prizes.map((prizeTitle, index) => (
                  <div key={`draft-prize-${index}`} className="managed-giveaway__prize-editor-row">
                    <span className="managed-giveaway__prize-position">{index + 1}</span>
                    <label className="field">
                      <input
                        ref={index === 0 ? firstPrizeInputRef : undefined}
                        type="text"
                        value={prizeTitle}
                        placeholder="Приз"
                        maxLength={MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH}
                        aria-label={`Приз за ${index + 1} место`}
                        aria-invalid={!prizesValidation.valid}
                        aria-describedby={
                          validationHint ? 'managed-giveaway-editor-alert' : undefined
                        }
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
                      {draft.description.trim()
                        ? `${draft.description.trim().length}/2000`
                        : 'Текст'}
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
                  <div className="field managed-giveaway__file-field">
                    <span>Фото публикации</span>
                    <button
                      type="button"
                      className="button button--ghost managed-giveaway__file-picker"
                      disabled={isBusy}
                      tabIndex={-1}
                      aria-hidden="true"
                    >
                      {draft.imageEnabled ? 'Заменить фото' : 'Добавить фото'}
                    </button>
                    <input
                      className="managed-giveaway__file-input"
                      type="file"
                      accept="image/*"
                      onChange={handlePublicationImageChange}
                      disabled={isBusy}
                      aria-label={
                        draft.imageEnabled ? 'Заменить фото публикации' : 'Добавить фото публикации'
                      }
                    />
                  </div>
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
          <div
            id="managed-giveaway-editor-alert"
            className="managed-giveaway__error-inline"
            role="alert"
            aria-live="assertive"
          >
            {validationHint}
          </div>
        ) : null}
        {editorError ? (
          <div className="managed-giveaway__error-inline" role="alert" aria-live="assertive">
            {editorError}
          </div>
        ) : null}

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

    const ownedSelectionLimitRemaining = Math.max(
      0,
      MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS -
        (draft.requiredChannelIds.length - selectedOwnedChannelIds.length),
    );
    const modalSelectionLimitReached = channelModalSelection.length >= ownedSelectionLimitRemaining;

    return createPortal(
      <div className="managed-giveaway-modal" aria-hidden={!channelModalOpen}>
        <button
          type="button"
          className="managed-giveaway-modal__backdrop"
          aria-label="Закрыть выбор каналов"
          tabIndex={-1}
          onClick={() => setChannelModalOpen(false)}
        />

        <section
          ref={channelModalPanelRef}
          className="managed-giveaway-modal__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="managed-giveaway-modal-title"
          tabIndex={-1}
        >
          <div className="managed-giveaway-modal__grabber" aria-hidden />

          <div className="managed-giveaway-modal__sheet">
            <div className="managed-giveaway-modal__head">
              <div>
                <strong id="managed-giveaway-modal-title">Добавьте свои каналы</strong>
                <small>Отметьте каналы, которые станут дополнительным условием участия.</small>
              </div>
              <span className="managed-giveaway__badge is-muted">
                {channelModalSelection.length}/{ownedSelectionLimitRemaining}
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
                  const optionDisabled = isBusy || (!checked && modalSelectionLimitReached);

                  return (
                    <label
                      key={`owned-channel-option-${channel.id}`}
                      className={cn(
                        'managed-giveaway-modal__option',
                        checked && 'is-selected',
                        optionDisabled && 'is-disabled',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setChannelModalSelection((current) =>
                            current.includes(channel.id)
                              ? current.filter((item) => item !== channel.id)
                              : current.length < ownedSelectionLimitRemaining
                                ? [...current, channel.id]
                                : current,
                          );
                        }}
                        disabled={optionDisabled}
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
