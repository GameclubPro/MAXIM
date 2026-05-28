import type { VkParsingEntityType } from '../lib/api/vk-parsing-client';
import type { ApiTransport } from '../lib/api/transport';
import { HealthSummary } from './vk-parsing/health-summary';
import { Pagination } from './vk-parsing/pagination';
import { PostList } from './vk-parsing/post-list';
import { QueueTimeline } from './vk-parsing/queue-timeline';
import { SafetyPanel } from './vk-parsing/safety-panel';
import { SchedulerPanel } from './vk-parsing/scheduler-panel';
import { SourceDashboard } from './vk-parsing/source-dashboard';
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
  const activeSourceCount = sources.filter((source) => source.importEnabled).length;
  const publishedCount = posts.filter((post) => post.status === 'PUBLISHED').length;
  const autopublishLabel = settings.autoPublishKillSwitchEnabled
    ? 'Стоп'
    : settings.autoPublishEnabled
      ? 'Вкл'
      : 'Ручной';

  return (
    <div className="vk-parsing-card">
      {feed ? (
        <div className="vk-parsing-overview" aria-label="Сводка VK-парсинга">
          <span>
            <b>
              {activeSourceCount}/{sources.length}
            </b>
            <small>Источн.</small>
          </span>
          <span>
            <b>{feed.queue.length}</b>
            <small>Очередь</small>
          </span>
          <span>
            <b>{publishedCount}</b>
            <small>Посты</small>
          </span>
          <span
            className={
              settings.autoPublishKillSwitchEnabled
                ? 'is-danger'
                : settings.autoPublishEnabled
                  ? 'is-success'
                  : undefined
            }
          >
            <b>{autopublishLabel}</b>
            <small>Авто</small>
          </span>
        </div>
      ) : null}

      <SourceDashboard
        sourceUrl={state.sourceUrl}
        sources={sources}
        selectedSourceId={state.selectedSourceId}
        selectedBulkSourceIds={state.selectedBulkSourceIds}
        isAdding={state.isAddingSource}
        isRefreshing={state.isRefreshing}
        isRemoving={state.isRemovingSource}
        isSavingSource={state.isSavingSource}
        isApplyingPreset={state.isApplyingPreset}
        refreshingSourceId={state.refreshingSourceId}
        onSourceUrlChange={state.setSourceUrl}
        onSubmitSource={state.submitSource}
        onRefresh={state.refreshSources}
        onRefreshSource={state.refreshSource}
        onSelectSource={state.selectSource}
        onToggleBulkSource={state.toggleBulkSource}
        onSelectAllBulkSources={state.selectAllBulkSources}
        onApplyPreset={state.applySourcePreset}
        onUpdateSource={state.updateSource}
        onRemoveSource={state.removeSource}
      />

      {feed ? (
        <div className="vk-parsing-control-stack">
          <details className="vk-parsing-fold">
            <summary>Автопостинг</summary>
            <SchedulerPanel
              settings={settings}
              isSaving={state.isSavingSettings}
              onUpdateSetting={state.updateSetting}
            />
            <HealthSummary summary={feed.summary} />
          </details>

          {feed.queue.length > 0 ? (
            <details className="vk-parsing-fold">
              <summary>Очередь · {feed.queue.length}</summary>
              <QueueTimeline
                posts={feed.queue}
                schedulingPostId={state.schedulingPostId}
                cancelingPostId={state.cancelingPostId}
                publishingNowPostId={state.publishingNowPostId}
                onSchedulePost={state.schedulePost}
                onCancelPost={state.cancelScheduledPost}
                onPublishNow={state.publishPostNow}
              />
            </details>
          ) : null}

          <details className="vk-parsing-fold">
            <summary>Защита</summary>
            <SafetyPanel
              sources={sources}
              auditEvents={feed.auditEvents}
              isRollingBack={state.isRollingBack}
              onRollback={state.rollback}
            />
          </details>
        </div>
      ) : null}

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
