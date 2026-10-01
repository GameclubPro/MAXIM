import { Link } from 'react-router';
import type { SettingsApplyPartialError } from '@maxim/contracts/settings';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';

export function SettingsApplyPartialResult({
  result,
  onClose,
}: {
  result: SettingsApplyPartialError;
  onClose: () => void;
}) {
  return (
    <ActionConfirmSheet
      id="settings-apply-partial-result"
      open={Boolean(result)}
      title="Часть настроек применена"
      summary={
        result
          ? `Обновлено: ${result.appliedCount} из ${result.targetCount}. Не изменено: ${result.unchangedCount}, из них с ошибкой: ${result.failedCount}, не обработано: ${result.notAttemptedCount}. ${result.causeMessage} Проверьте результат и заново выберите чаты перед повтором.`
          : ''
      }
      previewMeta={
        result && (
          <ul>
            {result.outcomes
              .filter((outcome) => outcome.status !== 'NOT_ATTEMPTED')
              .map((outcome) => (
                <li key={outcome.chatId}>
                  <Link to={`/chat/${encodeURIComponent(outcome.chatId)}/settings`}>
                    {outcome.status === 'APPLIED' ? 'Обновлённый чат' : 'Чат с ошибкой'}
                  </Link>
                  {outcome.message ? `: ${outcome.message}` : ''}
                </li>
              ))}
            {result.outcomesTruncated && (
              <li>Показана часть чатов; итоговые числа включают все выбранные.</li>
            )}
          </ul>
        )
      }
      confirmLabel="Понятно"
      cancelLabel="Закрыть"
      tone="accent"
      onClose={() => onClose()}
      onConfirm={() => onClose()}
    />
  );
}
