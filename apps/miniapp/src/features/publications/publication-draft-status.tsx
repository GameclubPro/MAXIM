import { Copy, Refresh, WarningCircle } from 'iconoir-react';
import type { DraftSaveState } from './publication-draft-autosave';
import {
  publicationDraftNeedsAttention,
  publicationDraftProblem,
  publicationDraftSaveLabel,
} from './publication-draft-presentation';
import './publication-drafts.css';

export function PublicationDraftSaveIndicator({
  state,
  dirty,
}: {
  state: DraftSaveState;
  dirty: boolean;
}) {
  return (
    <small className="publication-draft-indicator" role="status">
      {publicationDraftSaveLabel(state, dirty)}
    </small>
  );
}

export function PublicationDraftStatus({
  state,
  busy,
  onRetry,
  onReload,
  onCopy,
}: {
  state: DraftSaveState;
  busy: boolean;
  onRetry: () => void;
  onReload: () => void;
  onCopy: () => void;
}) {
  if (!publicationDraftNeedsAttention(state)) return null;
  const problem = publicationDraftProblem(state);
  return (
    <div className="publication-draft-status is-error" role="alert">
      <span>
        <WarningCircle aria-hidden />
        <strong>{problem.title}</strong>
      </span>
      <small>{problem.detail}</small>
      <div>
        {state.status === 'conflict' || state.status === 'unavailable' ? (
          <>
            {state.status === 'conflict' ? (
              <button type="button" disabled={busy} onClick={onReload}>
                <Refresh aria-hidden />
                Обновить
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
    </div>
  );
}
