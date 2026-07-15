import type { ChatParticipantItem } from '@maxim/contracts';
import { useEffect, useState } from 'react';
import { useNativeBackHandler } from '../../lib/native-back';
import { PersonAvatar } from '../ui/person-avatar';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';
import './chat-participant-sheet.css';
import './chat-participant-sheet-theme.css';

const MUTE_DURATION_MIN_HOURS = 1;
const MUTE_DURATION_MAX_HOURS = 336;
const IMMUNITY_DURATION_MIN_DAYS = 1;
const IMMUNITY_DURATION_MAX_DAYS = 30;
const IMMUNITY_DAILY_LIMIT_MIN = 1;
const IMMUNITY_DAILY_LIMIT_MAX = 10;

type ImmunityMode = 'limited' | 'always';
type ParticipantHintKey = 'immunity' | 'duration' | 'limit';
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
  if (hours >= 24 && hours % 24 === 0) {
    return `${hours / 24}д`;
  }

  return `${hours}ч`;
}

function formatDays(days: number): string {
  return `${Math.max(1, Math.trunc(days))}д`;
}

function formatImmunityLeft(expiresAt: string): string {
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return '0ч';
  }

  const diffMs = Math.max(0, expiresAtMs - Date.now());
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
    return 'Выкл';
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

function ShieldIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M10 2.8 15.8 5v4.2c0 3.2-1.9 5.8-5.8 8-3.9-2.2-5.8-4.8-5.8-8V5L10 2.8Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MuteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <path
        d="M9.4 4.5 6.6 7H4.4v6h2.2l2.8 2.5V4.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.8 7.3 15.8 12.7M15.8 7.3l-3 5.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BanIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6.3 13.7 13.7 6.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <circle cx="10" cy="6.6" r="3.1" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4.8 15.3c.8-2.3 2.8-3.5 5.2-3.5s4.4 1.2 5.2 3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
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
      aria-controls={`participant-sheet-hint-${hintKey}`}
      aria-expanded={isOpen}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle(hintKey);
      }}
    >
      <span aria-hidden>i</span>
    </button>
  );
}

export function ChatParticipantSheet({
  open,
  item,
  rangeLabel,
  isSavingImmunity,
  isApplyingModeration,
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

  useNativeBackHandler(
    () => {
      if (openHintKey !== null) {
        setOpenHintKey(null);
        return true;
      }

      if (activeComposer !== null) {
        setActiveComposer(null);
        return true;
      }

      if (isSavingImmunity || isApplyingModeration) {
        return false;
      }

      onClose();
      return true;
    },
    { enabled: open, priority: 660 },
  );

  useEffect(() => {
    if (!item || !open) {
      return;
    }

    setActiveComposer(null);
    setOpenHintKey(null);
    setMuteDurationHours(24);
    const immunity = resolveImmunity(item);
    setImmunityMode(isAlwaysImmunity(immunity) ? 'always' : 'limited');
    setImmunityDurationDays(resolveInitialImmunityDurationDays(immunity));
    setDailyViolationLimit(resolveInitialDailyViolationLimit(immunity));
  }, [item, open]);

  useEffect(() => {
    if (activeComposer !== 'immunity' && openHintKey !== null) {
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
  const isBusy = isSavingImmunity || isApplyingModeration;
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

  return (
    <SettingsDrilldownPanel
      id="participant-sheet"
      open={open}
      title={displayName}
      summary={username ? `@${username}` : roleLabel}
      tone="sky"
      onClose={onClose}
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
                  <ShieldIcon />
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
              <ProfileIcon />
              <span>Профиль</span>
            </button>

            <button
              type="button"
              className="participant-sheet__action participant-sheet__action--registry"
              onClick={onSpammerDiagnostics}
              disabled={isBusy}
            >
              <ShieldIcon />
              <span>База</span>
            </button>

            {canManageParticipant ? (
              <button
                type="button"
                className={`participant-sheet__action participant-sheet__action--mute ${
                  isMuteComposerOpen ? 'is-active' : ''
                }`}
                onClick={() => setActiveComposer((current) => (current === 'mute' ? null : 'mute'))}
                disabled={isBusy}
              >
                <MuteIcon />
                <span>Мут</span>
              </button>
            ) : null}

            {canManageParticipant ? (
              <button
                type="button"
                className={`participant-sheet__action participant-sheet__action--immunity ${
                  isImmunityComposerOpen ? 'is-active' : ''
                }`}
                onClick={() =>
                  setActiveComposer((current) => (current === 'immunity' ? null : 'immunity'))
                }
                disabled={isBusy}
              >
                <ShieldIcon />
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
                <BanIcon />
                <span>Бан</span>
              </button>
            ) : null}
          </div>

          {canManageParticipant && isMuteComposerOpen ? (
            <div className="participant-sheet__composer">
              <div className="participant-sheet__composer-head">
                <span className="participant-sheet__composer-title">Мут</span>
                <output aria-live="polite">{formatDuration(muteDurationHours)}</output>
              </div>
              <input
                className="settings-length-limit__slider"
                type="range"
                min={MUTE_DURATION_MIN_HOURS}
                max={MUTE_DURATION_MAX_HOURS}
                step={1}
                value={muteDurationHours}
                onChange={(event) => setMuteDurationHours(Number(event.target.value))}
                aria-label="Срок мута в часах"
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
                  {isApplyingModeration ? 'Применяем…' : 'Выдать'}
                </button>
              </div>
            </div>
          ) : null}

          {canManageParticipant && isImmunityComposerOpen ? (
            <div className="participant-sheet__composer participant-sheet__composer--stack">
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
                <p
                  id="participant-sheet-hint-immunity"
                  className="settings-native-toggle__hint settings-native-toggle__hint--inline participant-sheet__hint"
                >
                  Защита временно не даёт боту наказывать этого участника за нарушения. Обычные
                  сообщения лимит не тратят.
                </p>
              ) : null}

              <div
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
                  onClick={() => setImmunityMode('limited')}
                  disabled={isBusy}
                >
                  Лимит
                </button>
                <button
                  type="button"
                  className={`participant-sheet__mode-option ${
                    immunityMode === 'always' ? 'is-active' : ''
                  }`}
                  role="radio"
                  aria-checked={immunityMode === 'always'}
                  onClick={() => setImmunityMode('always')}
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
                      <p
                        id="participant-sheet-hint-duration"
                        className="settings-native-toggle__hint settings-native-toggle__hint--inline participant-sheet__hint"
                      >
                        Срок показывает, сколько дней защита будет действовать для этого участника.
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
                    />
                    <div className="participant-sheet__slider-labels" aria-hidden="true">
                      <span>{formatDays(IMMUNITY_DURATION_MIN_DAYS)}</span>
                      <span>{formatDays(IMMUNITY_DURATION_MAX_DAYS)}</span>
                    </div>
                  </div>

                  <div className="participant-sheet__slider-block">
                    <div className="participant-sheet__slider-head">
                      <div className="participant-sheet__label-with-info">
                        <span>Лимит</span>
                        <InfoButton
                          hintKey="limit"
                          label="Что значит лимит защиты"
                          openHintKey={openHintKey}
                          onToggle={toggleHint}
                        />
                      </div>
                      <output aria-live="polite">{dailyViolationLimit}/д</output>
                    </div>
                    {openHintKey === 'limit' ? (
                      <p
                        id="participant-sheet-hint-limit"
                        className="settings-native-toggle__hint settings-native-toggle__hint--inline participant-sheet__hint"
                      >
                        Лимит показывает, сколько нарушений в день бот пропустит без санкции. После
                        лимита модерация снова сработает как обычно.
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
                    onClick={onClearImmunity}
                    disabled={isBusy}
                  >
                    {isSavingImmunity ? 'Снимаем…' : 'Снять'}
                  </button>
                ) : null}

                <button
                  type="button"
                  className="button button--accent"
                  onClick={() => {
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
                >
                  {isSavingImmunity ? 'Сохраняем…' : 'Сохранить'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </SettingsDrilldownPanel>
  );
}
