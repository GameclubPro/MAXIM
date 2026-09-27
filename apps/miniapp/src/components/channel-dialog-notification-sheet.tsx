import type {
  ChannelDialogNotificationMode,
  ChannelDialogNotificationScope,
} from '@maxim/contracts';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';
import { useDialogFocusTrap } from '../lib/dialog-focus';
import type { LastEntityType } from '../lib/last-chat';
import { useNativeBackHandler } from '../lib/native-back';
import { openPublikBot, PUBLIK_BOT_URL } from '../lib/publik-bot';
import './channel-dialog-notification-sheet.css';

type ChannelDialogNotificationSheetProps = {
  portalTarget: Element;
  entityType: LastEntityType;
  profile: MiniappProfile;
  threadOverrideMode: ChannelDialogNotificationMode | null;
  draftMode: ChannelDialogNotificationMode;
  draftScope: ChannelDialogNotificationScope;
  availableTargetCount: number;
  canUseAllNotifications: boolean;
  isPending: boolean;
  applyDisabled: boolean;
  onClose: () => void;
  onDraftModeSelect: (mode: ChannelDialogNotificationMode) => void;
  onDraftScopeSelect: (scope: ChannelDialogNotificationScope) => void;
  onApply: () => void;
};

const NOTIFICATION_SCOPE_OPTIONS: ChannelDialogNotificationScope[] = [
  'thread',
  'channel',
  'all_channels',
];

function handleRadioKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
    return;
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'),
  );
  const current = buttons.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || !buttons.length) return;
  const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + direction + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next]?.focus();
  buttons[next]?.click();
}

function getNotificationModeLabel(mode: ChannelDialogNotificationMode): string {
  if (mode === 'off') {
    return 'Выкл';
  }
  if (mode === 'all') {
    return 'Все';
  }
  return 'Ответы';
}

function getNotificationScopeLabel(
  scope: ChannelDialogNotificationScope,
  entityType: LastEntityType,
): string {
  if (scope === 'all_channels') {
    return entityType === 'channel' ? 'Все каналы' : 'Все чаты';
  }
  if (scope === 'channel') {
    return entityType === 'channel' ? 'Канал' : 'Чат';
  }
  return 'Пост';
}

export default function ChannelDialogNotificationSheet({
  portalTarget,
  entityType,
  profile,
  threadOverrideMode,
  draftMode,
  draftScope,
  availableTargetCount,
  canUseAllNotifications,
  isPending,
  applyDisabled,
  onClose,
  onDraftModeSelect,
  onDraftScopeSelect,
  onApply,
}: ChannelDialogNotificationSheetProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocusTrap(true, panelRef, cancelButtonRef);
  useNativeBackHandler(
    () => {
      onClose();
      return true;
    },
    { priority: 700 },
  );

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const modeOptions: ChannelDialogNotificationMode[] = [
    'replies',
    ...(canUseAllNotifications ? (['all'] as const) : []),
    'off',
  ];
  const selectedScope = draftScope;
  const scopeLabel =
    selectedScope === 'all_channels' && draftMode !== 'off' && availableTargetCount > 0
      ? `${availableTargetCount} ${entityType === 'channel' ? 'каналов' : 'чатов'}`
      : getNotificationScopeLabel(selectedScope, entityType);

  return createPortal(
    <div className="channel-dialog-notification-sheet">
      <button
        type="button"
        className="channel-dialog-notification-sheet__backdrop"
        aria-label="Закрыть уведомления"
        onClick={onClose}
        tabIndex={-1}
      />
      <section
        ref={panelRef}
        className="channel-dialog-notification-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-dialog-notification-sheet-title"
        tabIndex={-1}
      >
        <div className="channel-dialog-notification-sheet__grabber" aria-hidden />
        <header className="channel-dialog-notification-sheet__head">
          <strong id="channel-dialog-notification-sheet-title">Уведомления</strong>
          <span>{scopeLabel}</span>
        </header>

        <div
          className="channel-dialog-notification-sheet__modes"
          role="radiogroup"
          aria-label="Какие уведомления получать"
          onKeyDown={handleRadioKeys}
        >
          {modeOptions.map((mode) => (
            <button
              key={mode}
              type="button"
              className={cn(
                'channel-dialog-notification-sheet__chip',
                draftMode === mode && 'is-active',
              )}
              role="radio"
              aria-checked={draftMode === mode}
              tabIndex={draftMode === mode ? 0 : -1}
              disabled={isPending}
              onClick={() => onDraftModeSelect(mode)}
            >
              {getNotificationModeLabel(mode)}
            </button>
          ))}
        </div>

        <div
          className="channel-dialog-notification-sheet__scopes"
          role="radiogroup"
          aria-label="Где получать уведомления"
          onKeyDown={handleRadioKeys}
        >
          {NOTIFICATION_SCOPE_OPTIONS.map((scope) => (
            <button
              key={scope}
              type="button"
              className={cn(
                'channel-dialog-notification-sheet__scope',
                draftScope === scope && 'is-active',
              )}
              role="radio"
              aria-checked={draftScope === scope}
              tabIndex={draftScope === scope ? 0 : -1}
              disabled={isPending}
              onClick={() => onDraftScopeSelect(scope)}
            >
              <span>{getNotificationScopeLabel(scope, entityType)}</span>
              <i aria-hidden />
            </button>
          ))}
        </div>

        {draftScope !== 'thread' && threadOverrideMode !== null ? (
          <p className="channel-dialog-notification-sheet__note">
            Для этого поста действует отдельная настройка:{' '}
            {getNotificationModeLabel(threadOverrideMode).toLowerCase()}.
          </p>
        ) : null}
        {profile === 'publisher' ? (
          <div className="channel-dialog-notification-sheet__delivery">
            <p>Личные сообщения от Публика. Бот должен быть запущен и не заблокирован.</p>
            <a href={PUBLIK_BOT_URL} onClick={openPublikBot}>
              Открыть Публик
            </a>
          </div>
        ) : null}

        <footer className="channel-dialog-notification-sheet__actions">
          <button
            ref={cancelButtonRef}
            type="button"
            className="channel-dialog-notification-sheet__button channel-dialog-notification-sheet__button--ghost"
            onClick={onClose}
            disabled={isPending}
          >
            Отмена
          </button>
          <button
            type="button"
            className="channel-dialog-notification-sheet__button channel-dialog-notification-sheet__button--accent"
            onClick={onApply}
            disabled={applyDisabled}
          >
            {isPending ? 'Сохраняем...' : 'Готово'}
          </button>
        </footer>
      </section>
    </div>,
    portalTarget,
  );
}
