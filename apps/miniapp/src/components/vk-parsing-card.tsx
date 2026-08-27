import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  type ChannelPostSignatureSettings,
} from '@maxim/contracts/channel-post-signature';
import { type VkParsingSettings, type VkParsingSource } from '@maxim/contracts/vk-parsing';
import type { VkParsingEntityType } from '../lib/api/vk-parsing-client';
import type { ApiTransport } from '../lib/api/transport';
import { Pagination } from './vk-parsing/pagination';
import { PostList } from './vk-parsing/post-list';
import { QueueTimeline } from './vk-parsing/queue-timeline';
import {
  SchedulerPanel,
  type AutopostStatusModel,
  type AutopostStatusTone,
} from './vk-parsing/scheduler-panel';
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
  channelLinkUrl?: string;
  postSignature?: ChannelPostSignatureSettings;
};

function parseTimeMinutes(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }
  return hours * 60 + minutes;
}

function isWithinRange(now: number, start: number, end: number): boolean {
  if (start === end) {
    return true;
  }
  if (start < end) {
    return now >= start && now < end;
  }
  return now >= start || now < end;
}

function getNowMinutes(timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
      timeZone,
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      return hour * 60 + minute;
    }
  } catch {
    // Fall through to local browser time if the runtime does not know this timezone.
  }

  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function resolveTimeWindow(settings: VkParsingSettings): { ready: boolean; label: string } {
  const now = getNowMinutes(settings.schedulerTimezone);
  const workStart = parseTimeMinutes(settings.workHoursStart) ?? 0;
  const workEnd = parseTimeMinutes(settings.workHoursEnd) ?? 24 * 60;
  const quietStart = parseTimeMinutes(settings.quietHoursStart);
  const quietEnd = parseTimeMinutes(settings.quietHoursEnd);
  const insideWork = isWithinRange(now, workStart, workEnd);
  const insideQuiet =
    quietStart !== null && quietEnd !== null ? isWithinRange(now, quietStart, quietEnd) : false;

  return {
    ready: insideWork && !insideQuiet,
    label:
      insideWork && !insideQuiet
        ? `${settings.workHoursStart}-${settings.workHoursEnd}`
        : 'Тихие часы',
  };
}

function buildAutopostStatus(
  settings: VkParsingSettings,
  sources: VkParsingSource[],
): AutopostStatusModel {
  const activeSourceCount = sources.filter((source) => source.importEnabled).length;
  const autoSourceCount = sources.filter(
    (source) => source.importEnabled && source.autoPublishEnabled,
  ).length;
  const hasSourceError = sources.some(
    (source) =>
      source.syncStatus === 'ERROR' || source.autoPublishPausedReason === 'circuit_breaker',
  );
  const timeWindow = resolveTimeWindow(settings);
  const isPaused = settings.autoPublishKillSwitchEnabled;
  const isWorking =
    settings.autoPublishEnabled &&
    !isPaused &&
    activeSourceCount > 0 &&
    autoSourceCount > 0 &&
    timeWindow.ready;

  let title = 'Ручной';
  let reason = 'Автопостинг выключен';
  let tone: AutopostStatusTone = 'muted';

  if (isPaused) {
    title = 'Пауза';
    reason = 'Автопубликация приостановлена';
    tone = 'danger';
  } else if (hasSourceError) {
    title = 'Ошибка';
    reason = 'Проверьте источники';
    tone = 'danger';
  } else if (!settings.autoPublishEnabled) {
    title = 'Ручной';
    reason = 'Автопубликация выключена';
  } else if (activeSourceCount === 0) {
    title = 'Ручной';
    reason = 'Нет активных источников';
    tone = 'warning';
  } else if (autoSourceCount === 0) {
    title = 'Ручной';
    reason = 'Авто выключено у источников';
    tone = 'warning';
  } else if (!timeWindow.ready) {
    title = 'Авто';
    reason = 'Пауза по расписанию';
    tone = 'warning';
  } else if (isWorking) {
    title = 'Авто';
    reason = 'Готово к публикации';
    tone = 'success';
  }

  return {
    title,
    reason,
    tone,
  };
}

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
  const publishedCount =
    sources.length > 0
      ? sources.reduce((sum, source) => sum + source.publishedPostCount, 0)
      : posts.filter((post) => post.status === 'PUBLISHED').length;
  const autopostStatus = feed ? buildAutopostStatus(settings, sources) : null;
  const effectivePostSignature = postSignature ?? {
    enabled: settings.appendChannelLinkEnabled,
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
          queueCount={feed.queue.length}
          publishedCount={publishedCount}
          isSaving={state.isSavingSettings}
          isSavingSource={state.isSavingSource}
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
          <details className="vk-parsing-fold vk-parsing-fold--secondary">
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
        </section>
      ) : null}
    </div>
  );
}
