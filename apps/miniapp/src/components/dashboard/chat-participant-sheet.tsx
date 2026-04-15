import type { ChatParticipantItem } from '@maxim/contracts';
import { useEffect, useState } from 'react';
import { PersonAvatar } from '../ui/person-avatar';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';

const MUTE_DURATION_MIN_HOURS = 1;
const MUTE_DURATION_MAX_HOURS = 336;
const IMMUNITY_DURATION_MIN_HOURS = 1;
const IMMUNITY_DURATION_MAX_HOURS = 168;
const IMMUNITY_DAILY_LIMIT_MIN = 1;
const IMMUNITY_DAILY_LIMIT_MAX = 10;

type ChatParticipantSheetProps = {
  open: boolean;
  item: ChatParticipantItem | null;
  rangeLabel: string;
  isSavingImmunity: boolean;
  isApplyingModeration: boolean;
  onClose: () => void;
  onSaveImmunity: (payload: { durationHours: number; dailyViolationLimit: number }) => void;
  onClearImmunity: () => void;
  onProfileActivate: () => void;
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
  onMute,
  onBan,
}: ChatParticipantSheetProps) {
  const [activeComposer, setActiveComposer] = useState<'mute' | 'immunity' | null>(null);
  const [muteDurationHours, setMuteDurationHours] = useState(24);
  const [immunityDurationHours, setImmunityDurationHours] = useState(24);
  const [dailyViolationLimit, setDailyViolationLimit] = useState(3);

  useEffect(() => {
    if (!item || !open) {
      return;
    }

    setActiveComposer(null);
    setMuteDurationHours(24);

    const nextImmunityDurationHours = item.immunity
      ? Math.min(
          IMMUNITY_DURATION_MAX_HOURS,
          Math.max(
            IMMUNITY_DURATION_MIN_HOURS,
            Math.ceil(
              (new Date(item.immunity.expiresAt).getTime() - Date.now()) / (60 * 60 * 1000),
            ),
          ),
        )
      : 24;
    setImmunityDurationHours(
      Number.isFinite(nextImmunityDurationHours) ? nextImmunityDurationHours : 24,
    );
    setDailyViolationLimit(item.immunity?.dailyViolationLimit ?? 3);
  }, [item, open]);

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
  const immunityValue = item.immunity
    ? `${item.immunity.remainingViolatingMessagesToday}/${item.immunity.dailyViolationLimit}`
    : 'Выкл';
  const immunityMeta = item.immunity ? formatImmunityLeft(item.immunity.expiresAt) : '—';
  const isMuteComposerOpen = activeComposer === 'mute';
  const isImmunityComposerOpen = activeComposer === 'immunity';

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
                <span className="participant-sheet__chip participant-sheet__chip--immune">
                  <ShieldIcon />
                  <span>{immunityValue}</span>
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="participant-sheet__stats">
          <article className="participant-sheet__stat">
            <small>Наруш.</small>
            <strong>{formatViolationCount(violationCount)}</strong>
            <span>{rangeLabel}</span>
          </article>

          <article className="participant-sheet__stat">
            <small>Иммун.</small>
            <strong>{immunityValue}</strong>
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
                <span>Иммун</span>
              </button>
            ) : null}

            {canManageParticipant ? (
              <button
                type="button"
                className="participant-sheet__action participant-sheet__action--ban"
                onClick={() => {
                  if (window.confirm(`Забанить ${displayName}?`)) {
                    onBan();
                  }
                }}
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
                <span className="participant-sheet__composer-title">Иммун</span>
                <output aria-live="polite">{immunityValue}</output>
              </div>

              <div className="participant-sheet__slider-block">
                <div className="participant-sheet__slider-head">
                  <span>Срок</span>
                  <output aria-live="polite">{formatDuration(immunityDurationHours)}</output>
                </div>
                <input
                  className="settings-length-limit__slider"
                  type="range"
                  min={IMMUNITY_DURATION_MIN_HOURS}
                  max={IMMUNITY_DURATION_MAX_HOURS}
                  step={1}
                  value={immunityDurationHours}
                  onChange={(event) => setImmunityDurationHours(Number(event.target.value))}
                  aria-label="Срок иммунитета в часах"
                />
                <div className="participant-sheet__slider-labels" aria-hidden="true">
                  <span>{formatDuration(IMMUNITY_DURATION_MIN_HOURS)}</span>
                  <span>{formatDuration(IMMUNITY_DURATION_MAX_HOURS)}</span>
                </div>
              </div>

              <div className="participant-sheet__slider-block">
                <div className="participant-sheet__slider-head">
                  <span>Лимит</span>
                  <output aria-live="polite">{dailyViolationLimit}/д</output>
                </div>
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
                  onClick={() =>
                    onSaveImmunity({
                      durationHours: immunityDurationHours,
                      dailyViolationLimit,
                    })
                  }
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
