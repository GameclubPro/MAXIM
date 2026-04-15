import type { ChatParticipantItem } from '@maxim/contracts';
import { useEffect, useState } from 'react';
import { PersonAvatar } from '../ui/person-avatar';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';

const IMMUNITY_DURATION_MIN_HOURS = 1;
const IMMUNITY_DURATION_MAX_HOURS = 168;
const IMMUNITY_DAILY_LIMIT_MIN = 1;
const IMMUNITY_DAILY_LIMIT_MAX = 10;

type ChatParticipantSheetProps = {
  open: boolean;
  item: ChatParticipantItem | null;
  isSaving: boolean;
  onClose: () => void;
  onSave: (payload: { durationHours: number; dailyViolationLimit: number }) => void;
  onClear: () => void;
  onProfileActivate: () => void;
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

function formatDuration(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) {
    return `${hours / 24}д`;
  }

  return `${hours}ч`;
}

function formatTimeLeft(expiresAt: string): string {
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return '0ч';
  }

  const diffMs = Math.max(0, expiresAtMs - Date.now());
  const diffHours = Math.max(1, Math.ceil(diffMs / (60 * 60 * 1000)));
  return formatDuration(diffHours);
}

export function ChatParticipantSheet({
  open,
  item,
  isSaving,
  onClose,
  onSave,
  onClear,
  onProfileActivate,
}: ChatParticipantSheetProps) {
  const [durationHours, setDurationHours] = useState(24);
  const [dailyViolationLimit, setDailyViolationLimit] = useState(3);

  useEffect(() => {
    if (!item || !open) {
      return;
    }

    const nextDurationHours = item.immunity
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
    setDurationHours(Number.isFinite(nextDurationHours) ? nextDurationHours : 24);
    setDailyViolationLimit(item.immunity?.dailyViolationLimit ?? 3);
  }, [item, open]);

  if (!item) {
    return null;
  }

  const displayName = resolveDisplayName(item);
  const username = item.username?.replace(/^@+/u, '').trim() ?? '';
  const footer = (
    <div className="participant-immunity-sheet__footer-actions">
      {item.immunity ? (
        <button
          type="button"
          className="button button--ghost"
          onClick={onClear}
          disabled={isSaving}
        >
          Снять
        </button>
      ) : null}
      <button
        type="button"
        className="button button--accent"
        onClick={() => onSave({ durationHours, dailyViolationLimit })}
        disabled={isSaving}
      >
        {isSaving ? 'Сохраняем…' : 'Сохранить'}
      </button>
    </div>
  );

  return (
    <SettingsDrilldownPanel
      id="participant-immunity"
      open={open}
      title={displayName}
      summary={username ? `@${username}` : undefined}
      tone="sky"
      onClose={onClose}
      className="participant-immunity-sheet"
      footer={footer}
    >
      <div className="participant-immunity-sheet__hero">
        <div className="participant-immunity-sheet__hero-main">
          <PersonAvatar
            avatarUrl={item.avatarUrl?.trim() || null}
            fallback={resolveInitial(displayName)}
            className="participant-immunity-sheet__avatar"
          />
          <div className="participant-immunity-sheet__identity">
            <strong>{displayName}</strong>
            {item.immunity ? (
              <div className="participant-immunity-sheet__chips">
                <span className="participant-immunity-sheet__chip participant-immunity-sheet__chip--immune">
                  {item.immunity.remainingViolatingMessagesToday}/
                  {item.immunity.dailyViolationLimit}
                </span>
                <span className="participant-immunity-sheet__chip">
                  {formatTimeLeft(item.immunity.expiresAt)}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          className="button button--ghost participant-immunity-sheet__profile"
          onClick={onProfileActivate}
          disabled={isSaving}
        >
          Профиль
        </button>
      </div>

      <div className="participant-immunity-sheet__slider-block">
        <div className="participant-immunity-sheet__slider-head">
          <span>Срок</span>
          <output aria-live="polite">{formatDuration(durationHours)}</output>
        </div>
        <input
          className="settings-length-limit__slider"
          type="range"
          min={IMMUNITY_DURATION_MIN_HOURS}
          max={IMMUNITY_DURATION_MAX_HOURS}
          step={1}
          value={durationHours}
          onChange={(event) => setDurationHours(Number(event.target.value))}
          aria-label="Срок иммунитета в часах"
        />
        <div className="participant-immunity-sheet__slider-labels" aria-hidden="true">
          <span>{formatDuration(IMMUNITY_DURATION_MIN_HOURS)}</span>
          <span>{formatDuration(IMMUNITY_DURATION_MAX_HOURS)}</span>
        </div>
      </div>

      <div className="participant-immunity-sheet__slider-block">
        <div className="participant-immunity-sheet__slider-head">
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
        <div className="participant-immunity-sheet__slider-labels" aria-hidden="true">
          <span>{IMMUNITY_DAILY_LIMIT_MIN}</span>
          <span>{IMMUNITY_DAILY_LIMIT_MAX}</span>
        </div>
      </div>
    </SettingsDrilldownPanel>
  );
}
