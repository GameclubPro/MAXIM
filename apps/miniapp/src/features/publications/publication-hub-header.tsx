import { Plus, Post } from 'iconoir-react';
import { lazy, Suspense } from 'react';
import type { PublicationTarget } from './publication-model';
import './publication-hub-header.css';

const LazyPublisherReadinessOverview = lazy(async () => {
  const module = await import('./publisher-readiness-overview');
  return { default: module.PublisherReadinessOverview };
});

export function PublicationHubHeader({
  publisherProfile,
  canCreate,
  targets,
  sourcesLoading,
  sourcesFetching,
  sourcesHaveError,
  botDialogUrl,
  onCreate,
  onRefresh,
  onOpenBot,
}: {
  publisherProfile: boolean;
  canCreate: boolean;
  targets: PublicationTarget[];
  sourcesLoading: boolean;
  sourcesFetching: boolean;
  sourcesHaveError: boolean;
  botDialogUrl?: string | null;
  onCreate: () => void;
  onRefresh: () => void;
  onOpenBot: () => void;
}) {
  return (
    <>
      <header className="publications-header">
        <div>
          <h1>
            {publisherProfile ? <Post aria-hidden /> : null}
            <span>{publisherProfile ? 'Публик' : 'Посты'}</span>
          </h1>
          {publisherProfile ? <span>Посты</span> : null}
        </div>
        <button
          type="button"
          className="publications-primary"
          onClick={onCreate}
          aria-label="Создать публикацию"
          title={canCreate ? 'Создать публикацию' : 'Нет готовых получателей'}
          disabled={!canCreate}
        >
          <Plus aria-hidden />
          <span>Создать</span>
        </button>
      </header>

      {publisherProfile ? (
        <Suspense fallback={null}>
          <LazyPublisherReadinessOverview
            targets={targets}
            loading={sourcesLoading}
            fetching={sourcesFetching}
            error={sourcesHaveError}
            botDialogUrl={botDialogUrl}
            onRefresh={onRefresh}
            onOpenBot={onOpenBot}
          />
        </Suspense>
      ) : null}
    </>
  );
}
