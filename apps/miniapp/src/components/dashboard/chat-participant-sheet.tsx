import type { ChatParticipantItem } from '@maxim/contracts';
import { useEffect, useState } from 'react';
import { PersonAvatar } from '../ui/person-avatar';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';

const MUTE_DURATION_MIN_HOURS = 1;
const MUTE_DURATION_MAX_HOURS = 336;
const IMMUNITY_DURATION_MIN_DAYS = 1;
const IMMUNITY_DURATION_MAX_DAYS = 30;
const IMMUNITY_DURATION_MIN_HOURS = IMMUNITY_DURATION_MIN_DAYS * 24;
const IMMUNITY_DURATION_MAX_HOURS = IMMUNITY_DURATION_MAX_DAYS * 24;
const IMMUNITY_DAILY_LIMIT_MIN = 1;
const IMMUNITY_DAILY_LIMIT_MAX = 10;

type ParticipantHintKey = 'immunity' | 'duration' | 'limit';

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
  onMute,
  onBan,
}: ChatParticipantSheetProps) {
  const [activeComposer, setActiveComposer] = useState<'mute' | 'immunity' | 'ban' | null>(null);
  const [muteDurationHours, setMuteDurationHours] = useState(24);
  const [immunityDurationDays, setImmunityDurationDays] = useState(3);
  const [dailyViolationLimit, setDailyViolationLimit] = useState(3);
  const [openHintKey, setOpenHintKey] = useState<ParticipantHintKey | null>(null);

  useEffect(() => {
    if (!item || !open) {
      return;
    }

    setActiveComposer(null);
    setOpenHintKey(null);
    setMuteDurationHours(24);

    const nextImmunityDurationDays = item.immunity
      ? Math.min(
          IMMUNITY_DURATION_MAX_DAYS,
          Math.max(
            IMMUNITY_DURATION_MIN_DAYS,
            Math.ceil(
              (new Date(item.immunity.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
            ),
          ),
        )
      : 3;
    setImmunityDurationDays(
      Number.isFinite(nextImmunityDurationDays) ? nextImmunityDurationDays : 3,
    );
    setDailyViolationLimit(item.immunity?.dailyViolationLimit ?? 3);
  }, [item, open]);

  useEffect(() => {
    if (activeComposer !== 'immunity' && openHintKey !== null) {
      setOpenHintKey(null);
    }
  }, [activeComposer, openHintKey]);

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
  const isBanComposerOpen = activeComposer === 'ban';
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
                className={`participant-sheet__action participant-sheet__action--ban ${
                  isBanComposerOpen ? 'is-active' : ''
                }`}
                onClick={() => setActiveComposer((current) => (current === 'ban' ? null : 'ban'))}
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

          {canManageParticipant && isBanComposerOpen ? (
            <div className="participant-sheet__composer">
              <div className="participant-sheet__composer-head">
                <span className="participant-sheet__composer-title">Подтвердите бан</span>
              </div>
              <p className="settings-native-toggle__hint settings-native-toggle__hint--inline participant-sheet__hint">
                {`Забанить ${displayName} в этом чате?`}
              </p>
              <div className="participant-sheet__row-actions">
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => setActiveComposer(null)}
                  disabled={isBusy}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={onBan}
                  disabled={isBusy}
                >
                  {isApplyingModeration ? 'Применяем…' : 'Забанить'}
                </button>
              </div>
            </div>
          ) : null}

          {canManageParticipant && isImmunityComposerOpen ? (
            <div className="participant-sheet__composer participant-sheet__composer--stack">
              <div className="participant-sheet__composer-head">
                <div className="participant-sheet__label-with-info">
                  <span className="participant-sheet__composer-title">Иммун</span>
                  <InfoButton
                    hintKey="immunity"
                    label="Что делает иммунитет"
                    openHintKey={openHintKey}
                    onToggle={toggleHint}
                  />
                </div>
                <output aria-live="polite">{immunityValue}</output>
              </div>
              {openHintKey === 'immunity' ? (
                <p
                  id="participant-sheet-hint-immunity"
                  className="settings-native-toggle__hint settings-native-toggle__hint--inline participant-sheet__hint"
                >
                  Иммунитет временно не даёт боту наказывать этого участника за нарушения. Обычные
                  сообщения лимит не тратят.
                </p>
              ) : null}

              <div className="participant-sheet__slider-block">
                <div className="participant-sheet__slider-head">
                  <div className="participant-sheet__label-with-info">
                    <span>Срок</span>
                    <InfoButton
                      hintKey="duration"
                      label="Что значит срок иммунитета"
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
                    Срок показывает, сколько дней иммунитет будет действовать для этого участника.
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
                  aria-label="Срок иммунитета в днях"
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
                      label="Что значит лимит иммунитета"
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
                      durationHours: immunityDurationDays * 24,
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
