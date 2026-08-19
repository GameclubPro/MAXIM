import { closeMaxMiniApp } from '../lib/max-bridge';
import { StatusState } from './ui/status-state';

type PublicDialogUnavailableStateProps = {
  title: string;
  description: string;
  tone?: 'warning' | 'danger';
};

export function PublicDialogUnavailableState({
  title,
  description,
  tone = 'warning',
}: PublicDialogUnavailableStateProps) {
  return (
    <div className="page-stack page-enter">
      <div className="glass-card glass-card--md">
        <StatusState
          tone={tone}
          title={title}
          description={description}
          action={
            <button
              type="button"
              className="button button--accent"
              onClick={() => closeMaxMiniApp()}
            >
              Закрыть приложение
            </button>
          }
        />
      </div>
    </div>
  );
}
