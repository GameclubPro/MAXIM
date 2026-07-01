import type {
  ChannelDialogNotificationMode,
  ChannelDialogNotificationScope,
} from '@maxim/contracts';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';
import type { LastEntityType } from '../lib/last-chat';
import './channel-dialog-notification-sheet.css';

type ChannelDialogNotificationSheetProps = {
  portalTarget: Element;
  entityType: LastEntityType;
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
    <div className="channel-dialog-notification-sheet" role="dialog" aria-modal="true">
      <button
        type="button"
        className="channel-dialog-notification-sheet__backdrop"
        aria-label="Закрыть уведомления"
        onClick={onClose}
      />
      <section
        className="channel-dialog-notification-sheet__panel"
        aria-labelledby="channel-dialog-notification-sheet-title"
      >
        <div className="channel-dialog-notification-sheet__grabber" aria-hidden />
        <header className="channel-dialog-notification-sheet__head">
          <strong id="channel-dialog-notification-sheet-title">Уведомления</strong>
          <span>{scopeLabel}</span>
        </header>

        <div className="channel-dialog-notification-sheet__modes" role="radiogroup">
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
              disabled={isPending}
              onClick={() => onDraftModeSelect(mode)}
            >
              {getNotificationModeLabel(mode)}
            </button>
          ))}
        </div>

        <div className="channel-dialog-notification-sheet__scopes" role="radiogroup">
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
              disabled={isPending}
              onClick={() => onDraftScopeSelect(scope)}
            >
              <span>{getNotificationScopeLabel(scope, entityType)}</span>
              <i aria-hidden />
            </button>
          ))}
        </div>

        <footer className="channel-dialog-notification-sheet__actions">
          <button
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
