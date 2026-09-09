import { CheckCircle, Copy, Refresh, WarningCircle } from 'iconoir-react';
import type { DraftSaveState } from './publication-draft-autosave';
import { describeUserFacingError } from '../../lib/user-facing-error';
import './publication-drafts.css';

export function PublicationDraftStatus({
  state,
  dirty,
  busy,
  onRetry,
  onReload,
  onCopy,
}: {
  state: DraftSaveState;
  dirty: boolean;
  busy: boolean;
  onRetry: () => void;
  onReload: () => void;
  onCopy: () => void;
}) {
  const failed =
    state.status === 'error' || state.status === 'conflict' || state.status === 'unavailable';
  const label =
    state.status === 'unavailable'
      ? 'Черновик удалён или опубликован'
      : state.status === 'conflict'
        ? 'Есть другая версия'
        : state.status === 'error'
          ? 'Не сохранено на сервере'
          : state.status === 'saving'
            ? 'Сохраняется...'
            : dirty
              ? 'Есть изменения'
              : state.status === 'saved'
                ? 'Сохранено в черновиках'
                : 'Черновик';
  return (
    <div className={`publication-draft-status${failed ? ' is-error' : ''}`}>
      <span role="status">
        {failed ? <WarningCircle aria-hidden /> : <CheckCircle aria-hidden />}
        <span>{label}</span>
      </span>
      {failed ? (
        <>
          <small>{describeUserFacingError(state.error, 'Повторите сохранение.')}</small>
          <div>
            {state.status === 'conflict' || state.status === 'unavailable' ? (
              <>
                {state.status === 'conflict' ? (
                  <button type="button" disabled={busy} onClick={onReload}>
                    <Refresh aria-hidden />
                    Загрузить версию
                  </button>
                ) : null}
                <button type="button" disabled={busy} onClick={onCopy}>
                  <Copy aria-hidden />
                  Сохранить копию
                </button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={onRetry}>
                <Refresh aria-hidden />
                Повторить
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
