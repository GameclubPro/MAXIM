import type { VkParsingEntityType } from '../lib/api/vk-parsing-client';
import type { ApiTransport } from '../lib/api/transport';
import { HealthSummary } from './vk-parsing/health-summary';
import { Pagination } from './vk-parsing/pagination';
import { PostList } from './vk-parsing/post-list';
import { SettingsToggles } from './vk-parsing/settings-toggles';
import { SourcesBar } from './vk-parsing/sources-bar';
import { StatusFilterBar } from './vk-parsing/status-filter-bar';
import { normalizeApiError } from './vk-parsing/format';
import { useVkParsingCard } from './vk-parsing/use-vk-parsing-card';
import { SkeletonCard } from './ui/skeleton';
import { StatusState } from './ui/status-state';
import '../styles/vk-parsing.css';

type VkParsingCardProps = {
  api: ApiTransport;
  chatId: string;
  active: boolean;
  entityType?: VkParsingEntityType;
};

export function VkParsingCard({ api, chatId, active, entityType = 'channel' }: VkParsingCardProps) {
  const state = useVkParsingCard({ api, chatId, active, entityType });
  const { feed, feedQuery, settings, posts, sources } = state;

  return (
    <div className="vk-parsing-card">
      <SourcesBar
        sourceUrl={state.sourceUrl}
        sources={sources}
        selectedSourceId={state.selectedSourceId}
        openHintKey={state.openHintKey}
        isAdding={state.isAddingSource}
        isRefreshing={state.isRefreshing}
        isRemoving={state.isRemovingSource}
        onSourceUrlChange={state.setSourceUrl}
        onSubmitSource={state.submitSource}
        onToggleHint={state.toggleHint}
        onRefresh={state.refreshSources}
        onSelectSource={state.selectSource}
        onRemoveSource={state.removeSource}
      />

      {feed ? (
        <SettingsToggles
          settings={settings}
          openHintKey={state.openHintKey}
          isSaving={state.isSavingSettings}
          onToggleHint={state.toggleHint}
          onToggleSetting={state.toggleSetting}
        />
      ) : null}

      {feed && settings.autoPublishEnabled ? (
        <div className="vk-parsing-compliance" role="status">
          Первичный импорт не публикует старые материалы. Рекламные посты остаются в ленте, если
          включён режим «Без рекламы».
        </div>
      ) : null}

      <HealthSummary summary={feed?.summary} />

      {feed ? (
        <StatusFilterBar
          statusFilter={state.statusFilter}
          onSelectStatusFilter={state.selectStatusFilter}
        />
      ) : null}

      {feedQuery.isLoading ? <SkeletonCard lines={5} /> : null}

      {feedQuery.error ? (
        <StatusState
          tone="danger"
          title="Не удалось загрузить VK-посты"
          description={normalizeApiError(feedQuery.error)}
          action={
            <button
              type="button"
              className="button button--danger"
              onClick={() => void feedQuery.refetch()}
            >
              Повторить
            </button>
          }
        />
      ) : null}

      {!feedQuery.isLoading && !feedQuery.error && posts.length === 0 ? (
        <div className="vk-parsing-card__empty">Постов пока нет</div>
      ) : null}

      <PostList
        posts={posts}
        settings={settings}
        editingPostId={state.editingPostId}
        publishingPostId={state.publishingPostId}
        retryingPostId={state.retryingPostId}
        draftText={state.draftText}
        selectedPhotoUrls={state.selectedPhotoUrls}
        selectedLinkUrls={state.selectedLinkUrls}
        onStartEditing={state.startEditing}
        onCancelEditing={state.cancelEditing}
        onPublishEditingPost={state.publishEditingPost}
        onRetryPost={state.retryPost}
        onDraftTextChange={state.setDraftText}
        onTogglePhoto={state.togglePhoto}
        onToggleLink={state.toggleLink}
      />

      <Pagination
        pagination={feed?.pagination}
        postsLength={posts.length}
        pageOffset={state.pageOffset}
        isFetching={feedQuery.isFetching}
        onPageOffsetChange={state.setPageOffset}
      />
    </div>
  );
}
