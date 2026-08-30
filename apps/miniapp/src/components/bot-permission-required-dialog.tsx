import type { BotPermissionBlocker } from '../lib/bot-permission-error';
import { getBotPermissionBlockerLabels } from '../lib/bot-permission-error';
import { ActionConfirmSheet } from './ui/action-confirm-sheet';
import './bot-permission-required-dialog.css';

type BotPermissionRequiredDialogProps = {
  id: string;
  blocker: BotPermissionBlocker | null;
  isRechecking: boolean;
  onClose: () => void;
  onRecheck: () => void;
};

export function BotPermissionRequiredDialog({
  id,
  blocker,
  isRechecking,
  onClose,
  onRecheck,
}: BotPermissionRequiredDialogProps) {
  const permissionLabels = blocker ? getBotPermissionBlockerLabels(blocker) : [];
  let summary = 'Выдайте боту необходимые права в MAX, затем запустите проверку ещё раз.';
  if (blocker?.canRecheck === false) {
    summary = 'Выполните указанные действия в MAX, затем повторите включение функции.';
  } else if (blocker?.stale) {
    summary =
      'Сведения о правах устарели. Запустите проверку, чтобы получить актуальный статус из MAX.';
  } else if (blocker?.code === 'PUBLISHER_SETUP_REQUIRED') {
    summary = 'Проверьте подключение Публика и выдайте боту необходимые права в MAX.';
  }

  return (
    <ActionConfirmSheet
      id={id}
      open={blocker !== null}
      role="alertdialog"
      title="Боту не хватает прав"
      summary={summary}
      previewTitle={
        <div className="bot-permission-required-dialog__details">
          {blocker?.affectedEntities.map((entity) => (
            <strong key={entity.id} className="bot-permission-required-dialog__entity">
              {entity.title}
            </strong>
          ))}
          <ul className="bot-permission-required-dialog__permissions">
            {permissionLabels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      }
      confirmLabel={blocker?.canRecheck === false ? 'Понятно' : 'Проверить снова'}
      confirmBusyLabel="Проверяем..."
      cancelLabel="Закрыть"
      tone="accent"
      isBusy={isRechecking}
      onClose={onClose}
      onConfirm={blocker?.canRecheck === false ? onClose : onRecheck}
    />
  );
}
