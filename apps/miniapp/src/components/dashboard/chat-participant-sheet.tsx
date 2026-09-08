import type { ChatParticipantItem } from '@maxim/contracts';
import { InfoCircle, Prohibition, Search, ShieldCheck, SoundOff, UserCircle } from 'iconoir-react';
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from 'react';
import { useNativeBackHandler } from '../../lib/native-back';
import { PersonAvatar } from '../ui/person-avatar';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';
import './chat-participant-sheet.css';
import './chat-participant-sheet-controls.css';
import './chat-participant-sheet-theme.css';

const MUTE_DURATION_MIN_HOURS = 1;
const MUTE_DURATION_MAX_HOURS = 336;
const MUTE_DURATION_PRESETS = [1, 6, 24, 72, 168] as const;
const IMMUNITY_DURATION_MIN_DAYS = 1;
const IMMUNITY_DURATION_MAX_DAYS = 30;
const IMMUNITY_DAILY_LIMIT_MIN = 1;
const IMMUNITY_DAILY_LIMIT_MAX = 10;
const MUTE_COMPOSER_ID = 'participant-sheet-mute-composer';
const IMMUNITY_COMPOSER_ID = 'participant-sheet-immunity-composer';

type ImmunityMode = 'limited' | 'always';
type ParticipantHintKey = 'mute' | 'immunity' | 'duration' | 'limit';
type ChatParticipantImmunityView = Omit<
  NonNullable<ChatParticipantItem['immunity']>,
  'dailyViolationLimit' | 'expiresAt' | 'remainingViolatingMessagesToday'
> & {
  mode?: ImmunityMode | null;
  dailyViolationLimit?: number | null;
  expiresAt?: string | null;
  remainingViolatingMessagesToday?: number | null;
};
type SaveImmunityPayload =
  | {
      mode: 'limited';
      durationHours: number;
      dailyViolationLimit: number;
    }
  | {
      mode: 'always';
    };

type ChatParticipantSheetProps = {
  open: boolean;
  item: ChatParticipantItem | null;
  rangeLabel: string;
  isSavingImmunity: boolean;
  isApplyingModeration: boolean;
  isOpeningProfile: boolean;
  onClose: () => void;
  onSaveImmunity: (payload: SaveImmunityPayload) => void;
  onClearImmunity: () => void;
  onProfileActivate: () => void;
  onSpammerDiagnostics: () => void;
  onMute: (durationHours: number) => void;
  onBan: () => void;
};

function resolveDisplayName(item: ChatParticipantItem): string {
  const name = item.userDisplayName.trim();
  if (name) {
    return name;
  }

  const username = item.username?.trim() ?? '';
  if (username) {
    return `@${username.replace(/^@+/u, '')}`;
  }

  return item.isBot ? 'Бот MAX' : 'Участник';
}

function resolveInitial(name: string): string {
  const matched = name.match(/[A-Za-zА-Яа-яЁё0-9]/u);
  return matched ? matched[0]!.toUpperCase() : '•';
}

function resolveRoleLabel(item: ChatParticipantItem): string {
  if (item.isBot) {
    return 'Бот';
  }

  if (item.role === 'owner') {
    return 'Владелец';
  }

  if (item.role === 'admin') {
    return 'Админ';
  }

  return 'Участник';
}

function formatDuration(hours: number): string {
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return [days ? `${days} д` : '', remainingHours ? `${remainingHours} ч` : '']
    .filter(Boolean)
    .join(' ');
}

function formatDays(days: number): string {
  return `${Math.max(1, Math.trunc(days))} д`;
}

function formatImmunityLeft(expiresAt: string): string {
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return 'Срок неизвестен';
  }

  const diffMs = expiresAtMs - Date.now();
  if (diffMs <= 0) return 'Истекла';
  const diffHours = Math.max(1, Math.ceil(diffMs / (60 * 60 * 1000)));
  return formatDuration(diffHours);
}

function formatViolationCount(count: number): string {
  if (count > 99) {
    return '99+';
  }

  return String(Math.max(0, Math.trunc(count)));
}

function resolveImmunity(item: ChatParticipantItem): ChatParticipantImmunityView | null {
  return item.immunity ? (item.immunity as ChatParticipantImmunityView) : null;
}

function isAlwaysImmunity(immunity: ChatParticipantImmunityView | null): boolean {
  return immunity?.mode === 'always';
}

function parsePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(1, Math.trunc(value));
}

function parseNonNegativeInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.trunc(value));
}

function resolveInitialImmunityDurationDays(immunity: ChatParticipantImmunityView | null): number {
  if (!immunity || isAlwaysImmunity(immunity) || !immunity.expiresAt) {
    return 3;
  }

  const nextImmunityDurationDays = Math.min(
    IMMUNITY_DURATION_MAX_DAYS,
    Math.max(
      IMMUNITY_DURATION_MIN_DAYS,
      Math.ceil((new Date(immunity.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
    ),
  );

  return Number.isFinite(nextImmunityDurationDays) ? nextImmunityDurationDays : 3;
}

function resolveInitialDailyViolationLimit(immunity: ChatParticipantImmunityView | null): number {
  return parsePositiveInteger(immunity?.dailyViolationLimit) ?? 3;
}

function formatImmunityValue(immunity: ChatParticipantImmunityView | null): string {
  if (!immunity) {
    return 'Нет';
  }

  if (isAlwaysImmunity(immunity)) {
    return '∞';
  }

  const remaining = parseNonNegativeInteger(immunity.remainingViolatingMessagesToday);
  const limit = parsePositiveInteger(immunity.dailyViolationLimit);
  if (remaining !== null && limit !== null) {
    return `${formatViolationCount(remaining)}/${formatViolationCount(limit)}`;
  }

  if (limit !== null) {
    return `${formatViolationCount(limit)}/д`;
  }

  return 'Лимит';
}

function formatImmunityMeta(immunity: ChatParticipantImmunityView | null): string {
  if (!immunity) {
    return '—';
  }

  if (isAlwaysImmunity(immunity)) {
    return 'Всегда';
  }

  return immunity.expiresAt ? formatImmunityLeft(immunity.expiresAt) : '—';
}

function describeImmunity(immunity: ChatParticipantImmunityView | null): string | undefined {
  if (!immunity) {
    return undefined;
  }

  if (isAlwaysImmunity(immunity)) {
    return 'Защита всегда: без срока и дневного лимита';
  }

  const remaining = parseNonNegativeInteger(immunity.remainingViolatingMessagesToday);
  const limit = parsePositiveInteger(immunity.dailyViolationLimit);
  if (remaining !== null && limit !== null) {
    return `Защита: ${remaining} из ${limit} нарушающих сообщений осталось на сегодня`;
  }

  if (limit !== null) {
    return `Защита: лимит ${limit} нарушающих сообщений в день`;
  }

  return 'Защита с дневным лимитом';
}

function createAlwaysImmunityPayload(): SaveImmunityPayload {
  return { mode: 'always' };
}

function resolveNextImmunityMode(mode: ImmunityMode, key: string): ImmunityMode | null {
  if (key === 'Home') {
    return 'limited';
  }

  if (key === 'End') {
    return 'always';
  }

  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return mode === 'limited' ? 'always' : 'limited';
  }

  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return mode === 'always' ? 'limited' : 'always';
  }

  return null;
}

function InfoButton({
  hintKey,
  label,
  openHintKey,
  onToggle,
}: {
  hintKey: ParticipantHintKey;
  label: string;
  openHintKey: ParticipantHintKey | null;
  onToggle: (hintKey: ParticipantHintKey) => void;
}) {
  const isOpen = openHintKey === hintKey;

  return (
    <button
      type="button"
      className={`settings-info-button participant-sheet__info-button ${isOpen ? 'is-open' : ''}`.trim()}
      aria-label={label}
      title={label}
      aria-controls={isOpen ? `participant-sheet-hint-${hintKey}` : undefined}
      aria-expanded={isOpen}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle(hintKey);
      }}
    >
      <InfoCircle aria-hidden />
    </button>
  );
}

export function ChatParticipantSheet({
  open,
  item,
  rangeLabel,
  isSavingImmunity,
  isApplyingModeration,
  isOpeningProfile,
  onClose,
  onSaveImmunity,
  onClearImmunity,
  onProfileActivate,
  onSpammerDiagnostics,
  onMute,
  onBan,
}: ChatParticipantSheetProps) {
  const [activeComposer, setActiveComposer] = useState<'mute' | 'immunity' | null>(null);
  const [muteDurationHours, setMuteDurationHours] = useState(24);
  const [immunityMode, setImmunityMode] = useState<ImmunityMode>('limited');
  const [immunityDurationDays, setImmunityDurationDays] = useState(3);
  const [dailyViolationLimit, setDailyViolationLimit] = useState(3);
  const [openHintKey, setOpenHintKey] = useState<ParticipantHintKey | null>(null);
  const [pendingImmunityAction, setPendingImmunityAction] = useState<'save' | 'clear' | null>(null);
  const immunityModeGroupRef = useRef<HTMLDivElement | null>(null);
  const immunityDraftStartedRef = useRef(false);

  useNativeBackHandler(
    () => {
      if (isSavingImmunity || isApplyingModeration || isOpeningProfile) {
        return true;
      }

      if (openHintKey !== null) {
        setOpenHintKey(null);
        return true;
      }

      if (activeComposer !== null) {
        setActiveComposer(null);
        return true;
      }

      onClose();
      return true;
    },
    { enabled: open, priority: 660 },
  );

  const resetParticipantDraft = useEffectEvent(() => {
    if (!item || !open) {
      return;
    }

    setActiveComposer(null);
    setOpenHintKey(null);
    setPendingImmunityAction(null);
    immunityDraftStartedRef.current = false;
    setMuteDurationHours(24);
    const immunity = resolveImmunity(item);
    setImmunityMode(isAlwaysImmunity(immunity) ? 'always' : 'limited');
    setImmunityDurationDays(resolveInitialImmunityDurationDays(immunity));
    setDailyViolationLimit(resolveInitialDailyViolationLimit(immunity));
  });
  useEffect(() => {
    resetParticipantDraft();
  }, [item?.userId, open]);

  useEffect(() => {
    if (
      openHintKey !== null &&
      (openHintKey === 'mute' ? activeComposer !== 'mute' : activeComposer !== 'immunity')
    ) {
      setOpenHintKey(null);
      return;
    }

    if (immunityMode === 'always' && (openHintKey === 'duration' || openHintKey === 'limit')) {
      setOpenHintKey(null);
    }
  }, [activeComposer, immunityMode, openHintKey]);

  if (!item) {
    return null;
  }

  const displayName = resolveDisplayName(item);
  const username = item.username?.replace(/^@+/u, '').trim() ?? '';
  const roleLabel = resolveRoleLabel(item);
  const violationCount = Number.isFinite(item.violationCount)
    ? Math.max(0, Math.trunc(item.violationCount))
    : 0;
  const canManageParticipant = !item.isBot && item.role === 'member';
  const isBusy = isSavingImmunity || isApplyingModeration || isOpeningProfile;
  const immunity = resolveImmunity(item);
  const immunityValue = formatImmunityValue(immunity);
  const immunityDescription = describeImmunity(immunity);
  const immunityMeta = formatImmunityMeta(immunity);
  const isMuteComposerOpen = activeComposer === 'mute';
  const isImmunityComposerOpen = activeComposer === 'immunity';
  const isAlwaysMode = immunityMode === 'always';
  const toggleHint = (hintKey: ParticipantHintKey) => {
    setOpenHintKey((current) => (current === hintKey ? null : hintKey));
  };
  const handleImmunityModeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    mode: ImmunityMode,
  ) => {
    const nextMode = resolveNextImmunityMode(mode, event.key);
    if (!nextMode) {
      return;
    }

    event.preventDefault();
    setImmunityMode(nextMode);
    immunityModeGroupRef.current
      ?.querySelector<HTMLButtonElement>(`[data-immunity-mode="${nextMode}"]`)
      ?.focus();
  };

  return (
    <SettingsDrilldownPanel
      id="participant-sheet"
      open={open}
      title={displayName}
      summary={username ? `@${username}` : roleLabel}
      tone="sky"
      onClose={() => {
        if (!isBusy) onClose();
      }}
      className="participant-sheet"
    >
      <section className="participant-sheet__hero">
        <div className="participant-sheet__hero-top">
          <div className="participant-sheet__avatar-shell">
            <PersonAvatar
              avatarUrl={item.avatarUrl?.trim() || null}
              fallback={resolveInitial(displayName)}
              className="participant-sheet__avatar"
            />
          </div>

          <div className="participant-sheet__hero-copy">
            <div className="participant-sheet__identity">
              <strong>{displayName}</strong>
              <span>{username ? `@${username}` : roleLabel}</span>
            </div>

            <div className="participant-sheet__chips">
              <span className="participant-sheet__chip">{roleLabel}</span>
              {item.immunity ? (
                <span
                  className="participant-sheet__chip participant-sheet__chip--immune"
                  aria-label={immunityDescription}
                  title={immunityDescription}
                >
                  <ShieldCheck aria-hidden />
                  <span aria-hidden={Boolean(immunityDescription)}>{immunityValue}</span>
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="participant-sheet__stats">
          <article className="participant-sheet__stat">
            <small>Нарушения</small>
            <strong>{formatViolationCount(violationCount)}</strong>
            <span>{rangeLabel}</span>
          </article>

          <article className="participant-sheet__stat">
            <small>Защита</small>
            <strong aria-label={immunityDescription}>{immunityValue}</strong>
            <span>{immunityMeta}</span>
          </article>
        </div>
      </section>

      <section className="participant-sheet__section">
        <div className="participant-sheet__dock">
          <div className="participant-sheet__action-grid">
            <button
              type="button"
              className="participant-sheet__action participant-sheet__action--neutral"
              onClick={onProfileActivate}
              disabled={isBusy}
            >
              <UserCircle aria-hidden />
              <span>{isOpeningProfile ? 'Открываем...' : 'Профиль'}</span>
            </button>

            <button
              type="button"
              className="participant-sheet__action participant-sheet__action--registry"
              onClick={onSpammerDiagnostics}
              disabled={isBusy}
              title="Проверить участника по базе спамеров"
            >
              <Search aria-hidden />
              <span>Проверить</span>
            </button>

            {canManageParticipant ? (
              <button
                type="button"
                className={`participant-sheet__action participant-sheet__action--mute ${
                  isMuteComposerOpen ? 'is-active' : ''
                }`}
                aria-controls={MUTE_COMPOSER_ID}
                aria-expanded={isMuteComposerOpen}
                onClick={() => setActiveComposer((current) => (current === 'mute' ? null : 'mute'))}
                disabled={isBusy}
              >
                <SoundOff aria-hidden />
                <span>Без сообщений</span>
              </button>
            ) : null}

            {canManageParticipant ? (
              <button
                type="button"
                className={`participant-sheet__action participant-sheet__action--immunity ${
                  isImmunityComposerOpen ? 'is-active' : ''
                }`}
                aria-controls={IMMUNITY_COMPOSER_ID}
                aria-expanded={isImmunityComposerOpen}
                onClick={() => {
                  if (!immunityDraftStartedRef.current) {
                    setImmunityMode(isAlwaysImmunity(immunity) ? 'always' : 'limited');
                    setImmunityDurationDays(resolveInitialImmunityDurationDays(immunity));
                    setDailyViolationLimit(resolveInitialDailyViolationLimit(immunity));
                    immunityDraftStartedRef.current = true;
                  }
                  setActiveComposer((current) => (current === 'immunity' ? null : 'immunity'));
                }}
                disabled={isBusy}
              >
                <ShieldCheck aria-hidden />
                <span>Защита</span>
              </button>
            ) : null}

            {canManageParticipant ? (
              <button
                type="button"
                className="participant-sheet__action participant-sheet__action--ban"
                onClick={onBan}
                disabled={isBusy}
              >
                <Prohibition aria-hidden />
                <span>Заблокировать</span>
              </button>
            ) : null}
          </div>

          {canManageParticipant && isMuteComposerOpen ? (
            <div id={MUTE_COMPOSER_ID} className="participant-sheet__composer">
              <div className="participant-sheet__composer-head">
                <div className="participant-sheet__label-with-info">
                  <span className="participant-sheet__composer-title">Без сообщений</span>
                  <InfoButton
                    hintKey="mute"
                    label="Как работает ограничение сообщений"
                    openHintKey={openHintKey}
                    onToggle={toggleHint}
                  />
                </div>
                <output aria-live="polite">{formatDuration(muteDurationHours)}</output>
              </div>
              {openHintKey === 'mute' ? (
                <p id="participant-sheet-hint-mute" className="participant-sheet__hint">
                  Участник останется в чате, но бот будет удалять его новые сообщения в течение
                  выбранного срока. После этого ограничение снимется автоматически.
                </p>
              ) : null}
              <div
                className="participant-sheet__duration-presets"
                role="group"
                aria-label="Срок ограничения сообщений"
              >
                {MUTE_DURATION_PRESETS.map((hours) => (
                  <button
                    key={hours}
                    type="button"
                    aria-pressed={muteDurationHours === hours}
                    onClick={() => setMuteDurationHours(hours)}
                    disabled={isBusy}
                  >
                    {formatDuration(hours)}
                  </button>
                ))}
              </div>
              <input
                className="settings-length-limit__slider"
                type="range"
                min={MUTE_DURATION_MIN_HOURS}
                max={MUTE_DURATION_MAX_HOURS}
                step={1}
                value={muteDurationHours}
                onChange={(event) => setMuteDurationHours(Number(event.target.value))}
                aria-label="Срок ограничения в часах"
                aria-valuetext={formatDuration(muteDurationHours)}
                aria-describedby={
                  openHintKey === 'mute' ? 'participant-sheet-hint-mute' : undefined
                }
                disabled={isBusy}
              />
              <div className="participant-sheet__slider-labels" aria-hidden="true">
                <span>{formatDuration(MUTE_DURATION_MIN_HOURS)}</span>
                <span>{formatDuration(MUTE_DURATION_MAX_HOURS)}</span>
              </div>

              <div className="participant-sheet__row-actions">
                <button
                  type="button"
                  className="button button--accent"
                  onClick={() => onMute(muteDurationHours)}
                  disabled={isBusy}
                >
                  {isApplyingModeration ? 'Применяем...' : 'Продолжить'}
                </button>
              </div>
            </div>
          ) : null}

          {canManageParticipant && isImmunityComposerOpen ? (
            <div
              id={IMMUNITY_COMPOSER_ID}
              className="participant-sheet__composer participant-sheet__composer--stack"
            >
              <div className="participant-sheet__composer-head">
                <div className="participant-sheet__label-with-info">
                  <span className="participant-sheet__composer-title">Защита</span>
                  <InfoButton
                    hintKey="immunity"
                    label="Что делает защита"
                    openHintKey={openHintKey}
                    onToggle={toggleHint}
                  />
                </div>
                <output
                  aria-live="polite"
                  aria-label={
                    isAlwaysMode
                      ? 'Защита всегда: без срока и дневного лимита'
                      : `Лимит ${dailyViolationLimit} нарушающих сообщений в день`
                  }
                >
                  {isAlwaysMode ? 'Всегда' : `${dailyViolationLimit}/д`}
                </output>
              </div>
              {openHintKey === 'immunity' ? (
                <p id="participant-sheet-hint-immunity" className="participant-sheet__hint">
                  Защита делает исключение из автоматической модерации для участника в этом чате.
                  {isAlwaysMode
                    ? ' В режиме «Всегда» она действует без срока и лимита, пока вы её не снимете.'
                    : ' Она действует до выбранной даты, пока не исчерпан дневной лимит. Обычные сообщения лимит не тратят.'}{' '}
                  Ручные ограничения и блокировку защита не отменяет.
                </p>
              ) : null}

              <div
                ref={immunityModeGroupRef}
                className="participant-sheet__mode-switch"
                role="radiogroup"
                aria-label="Режим защиты"
              >
                <button
                  type="button"
                  className={`participant-sheet__mode-option ${
                    immunityMode === 'limited' ? 'is-active' : ''
                  }`}
                  role="radio"
                  aria-checked={immunityMode === 'limited'}
                  tabIndex={immunityMode === 'limited' ? 0 : -1}
                  data-immunity-mode="limited"
                  onClick={() => setImmunityMode('limited')}
                  onKeyDown={(event) => handleImmunityModeKeyDown(event, 'limited')}
                  disabled={isBusy}
                >
                  На срок
                </button>
                <button
                  type="button"
                  className={`participant-sheet__mode-option ${
                    immunityMode === 'always' ? 'is-active' : ''
                  }`}
                  role="radio"
                  aria-checked={immunityMode === 'always'}
                  tabIndex={immunityMode === 'always' ? 0 : -1}
                  data-immunity-mode="always"
                  onClick={() => setImmunityMode('always')}
                  onKeyDown={(event) => handleImmunityModeKeyDown(event, 'always')}
                  disabled={isBusy}
                >
                  Всегда
                </button>
              </div>

              {!isAlwaysMode ? (
                <>
                  <div className="participant-sheet__slider-block">
                    <div className="participant-sheet__slider-head">
                      <div className="participant-sheet__label-with-info">
                        <span>Срок</span>
                        <InfoButton
                          hintKey="duration"
                          label="Что значит срок защиты"
                          openHintKey={openHintKey}
                          onToggle={toggleHint}
                        />
                      </div>
                      <output aria-live="polite">{formatDays(immunityDurationDays)}</output>
                    </div>
                    {openHintKey === 'duration' ? (
                      <p id="participant-sheet-hint-duration" className="participant-sheet__hint">
                        Защита начнёт действовать после сохранения и отключится сама через выбранное
                        число дней. При повторном сохранении срок отсчитывается заново.
                      </p>
                    ) : null}
                    <input
                      className="settings-length-limit__slider"
                      type="range"
                      min={IMMUNITY_DURATION_MIN_DAYS}
                      max={IMMUNITY_DURATION_MAX_DAYS}
                      step={1}
                      value={immunityDurationDays}
                      onChange={(event) => setImmunityDurationDays(Number(event.target.value))}
                      aria-label="Срок защиты в днях"
                      aria-valuetext={formatDays(immunityDurationDays)}
                      aria-describedby={
                        openHintKey === 'duration' ? 'participant-sheet-hint-duration' : undefined
                      }
                      disabled={isBusy}
                    />
                    <div className="participant-sheet__slider-labels" aria-hidden="true">
                      <span>{formatDays(IMMUNITY_DURATION_MIN_DAYS)}</span>
                      <span>{formatDays(IMMUNITY_DURATION_MAX_DAYS)}</span>
                    </div>
                  </div>

                  <div className="participant-sheet__slider-block">
                    <div className="participant-sheet__slider-head">
                      <div className="participant-sheet__label-with-info">
                        <span>Сообщений в день</span>
                        <InfoButton
                          hintKey="limit"
                          label="Что значит лимит защиты"
                          openHintKey={openHintKey}
                          onToggle={toggleHint}
                        />
                      </div>
                      <output aria-live="polite">{dailyViolationLimit}</output>
                    </div>
                    {openHintKey === 'limit' ? (
                      <p id="participant-sheet-hint-limit" className="participant-sheet__hint">
                        Столько сообщений с нарушениями бот пропустит за день. Следующее нарушение
                        будет обработано по обычным правилам. Лимит обновляется в полночь по времени
                        чата; при сохранении защиты он тоже начинается заново.
                      </p>
                    ) : null}
                    <input
                      className="settings-length-limit__slider"
                      type="range"
                      min={IMMUNITY_DAILY_LIMIT_MIN}
                      max={IMMUNITY_DAILY_LIMIT_MAX}
                      step={1}
                      value={dailyViolationLimit}
                      onChange={(event) => setDailyViolationLimit(Number(event.target.value))}
                      aria-label="Лимит нарушающих сообщений в день"
                      aria-describedby={
                        openHintKey === 'limit' ? 'participant-sheet-hint-limit' : undefined
                      }
                      disabled={isBusy}
                    />
                    <div className="participant-sheet__slider-labels" aria-hidden="true">
                      <span>{IMMUNITY_DAILY_LIMIT_MIN}</span>
                      <span>{IMMUNITY_DAILY_LIMIT_MAX}</span>
                    </div>
                  </div>
                </>
              ) : null}

              <div className="participant-sheet__row-actions">
                {item.immunity ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => {
                      setPendingImmunityAction('clear');
                      onClearImmunity();
                    }}
                    disabled={isBusy}
                    aria-busy={isSavingImmunity && pendingImmunityAction === 'clear'}
                  >
                    {isSavingImmunity && pendingImmunityAction === 'clear'
                      ? 'Снимаем...'
                      : 'Снять защиту'}
                  </button>
                ) : null}

                <button
                  type="button"
                  className="button button--accent"
                  onClick={() => {
                    setPendingImmunityAction('save');
                    if (isAlwaysMode) {
                      onSaveImmunity(createAlwaysImmunityPayload());
                      return;
                    }

                    onSaveImmunity({
                      mode: 'limited',
                      durationHours: immunityDurationDays * 24,
                      dailyViolationLimit,
                    });
                  }}
                  disabled={isBusy}
                  aria-busy={isSavingImmunity && pendingImmunityAction === 'save'}
                >
                  {isSavingImmunity && pendingImmunityAction === 'save'
                    ? 'Сохраняем...'
                    : 'Сохранить'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </SettingsDrilldownPanel>
  );
}
