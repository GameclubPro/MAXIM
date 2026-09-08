import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  type ChannelPostSignatureSettings,
} from '@maxim/contracts/channel-post-signature';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { VkParsingEntityType } from '../lib/api/vk-parsing-client';
import type { ApiTransport } from '../lib/api/transport';
import { Pagination } from './vk-parsing/pagination';
import { PostList } from './vk-parsing/post-list';
import { SchedulerPanel } from './vk-parsing/scheduler-panel';
import { buildAutopostStatus } from './vk-parsing/autopost-status';
import { ActionConfirmSheet } from './ui/action-confirm-sheet';
import { SourceDashboard } from './vk-parsing/source-dashboard';
import { StatusFilterBar } from './vk-parsing/status-filter-bar';
import { normalizeApiError } from './vk-parsing/format';
import { useVkParsingCard } from './vk-parsing/use-vk-parsing-card';
import { SkeletonCard } from './ui/skeleton';
import { StatusState } from './ui/status-state';
import '../styles/vk-parsing.css';

const LazyQueueTimeline = lazy(() =>
  import('./vk-parsing/queue-timeline').then((module) => ({ default: module.QueueTimeline })),
);

type VkParsingCardProps = {
  api: ApiTransport;
  chatId: string;
  active: boolean;
  entityType?: VkParsingEntityType;
  channelLinkUrl?: string;
  postSignature?: ChannelPostSignatureSettings;
};

export function VkParsingCard({
  api,
  chatId,
  active,
  entityType = 'channel',
  channelLinkUrl,
  postSignature,
}: VkParsingCardProps) {
  const state = useVkParsingCard({ api, chatId, active, entityType });
  const { feed, feedQuery, settings, posts, sources } = state;
  const [now, setNow] = useState(() => new Date());
  const [queueOpen, setQueueOpen] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const publishedCount =
    sources.length > 0
      ? sources.reduce((sum, source) => sum + source.publishedPostCount, 0)
      : posts.filter((post) => post.status === 'PUBLISHED').length;
  const autopostStatus = feed ? buildAutopostStatus(settings, sources, now) : null;
  const preset = state.presetConfirmation?.preset;
  const presetDetails =
    preset === 'NEWS'
      ? 'Очередь · 20 мин · до 12 постов в день · высокий приоритет'
      : preset === 'SLOW'
        ? 'Очередь · 180 мин · до 3 постов в день'
        : preset === 'REVIEW'
          ? 'Ручная проверка · автопубликация источников выключена'
          : 'Очередь · 90 мин · до 4 постов в день. Ссылки удаляются, реклама пропускается во всех источниках этого чата или канала.';
  const effectivePostSignature = postSignature ?? {
    enabled: settings.appendChannelLinkEnabled,
    presentation: 'signature' as const,
    text: settings.channelLinkText || CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
    url: '',
  };

  return (
    <div className="vk-parsing-card">
      {feed && autopostStatus ? (
        <SchedulerPanel
          settings={settings}
          sources={sources}
          status={autopostStatus}
          queueCount={sources.reduce((sum, source) => sum + source.queuedPostCount, 0)}
          publishedCount={publishedCount}
          isSaving={state.isSavingSettings}
          isSavingSource={state.isSavingSource}
          settingsSaved={state.settingsSaved}
          onUpdateSetting={state.updateSetting}
          onUpdateSources={state.updateSources}
          onApplyPreset={state.applyPresetToAllSources}
        />
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

      <section className="vk-feed-section" aria-label="Посты VK">
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
          postSignature={effectivePostSignature}
          channelLinkUrl={channelLinkUrl}
          editingPostId={state.editingPostId}
          publishingPostId={state.publishingPostId}
          retryingPostId={state.retryingPostId}
          draftText={state.draftText}
          draftTextFormat={state.draftTextFormat}
          selectedPhotoUrls={state.selectedPhotoUrls}
          selectedVideoUrls={state.selectedVideoUrls}
          selectedLinkUrls={state.selectedLinkUrls}
          onStartEditing={state.startEditing}
          onCancelEditing={state.cancelEditing}
          onPublishEditingPost={state.publishEditingPost}
          onRetryPost={state.retryPost}
          onDraftTextChange={state.updateDraftText}
          onTogglePhoto={state.togglePhoto}
          onToggleVideo={state.toggleVideo}
          onToggleLink={state.toggleLink}
        />

        <Pagination
          pagination={feed?.pagination}
          postsLength={posts.length}
          pageOffset={state.pageOffset}
          isFetching={feedQuery.isFetching}
          onPageOffsetChange={state.setPageOffset}
        />
      </section>

      {feed && feed.queue.length > 0 ? (
        <section className="vk-parsing-service-section" aria-label="Запланированные публикации">
          <details
            className="vk-parsing-fold vk-parsing-fold--secondary"
            onToggle={(event) => setQueueOpen(event.currentTarget.open)}
          >
            <summary>Ближайшие публикации · {feed.queue.length}</summary>
            {queueOpen ? (
              <Suspense fallback={<SkeletonCard lines={3} />}>
                <LazyQueueTimeline
                  posts={feed.queue}
                  schedulingPostId={state.schedulingPostId}
                  cancelingPostId={state.cancelingPostId}
                  publishingNowPostId={state.publishingNowPostId}
                  onSchedulePost={state.schedulePost}
                  onCancelPost={state.cancelScheduledPost}
                  onPublishNow={state.publishPostNow}
                />
              </Suspense>
            ) : null}
          </details>
        </section>
      ) : null}
      <ActionConfirmSheet
        id="vk-preset-confirm"
        open={state.presetConfirmation !== null}
        title="Применить пресет?"
        tone="accent"
        summary={`Источников: ${state.presetConfirmation?.sourceIds.length ?? 0}. ${settings.autoPublishEnabled && !settings.autoPublishKillSwitchEnabled ? 'Автопостинг включен; новые параметры вступят в силу сразу.' : 'Общий режим автопостинга останется без изменений.'}`}
        previewTitle={presetDetails}
        confirmLabel="Применить"
        isBusy={state.isApplyingPreset}
        onClose={state.closePresetConfirmation}
        onConfirm={() => void state.confirmSourcePreset()}
      />
    </div>
  );
}
