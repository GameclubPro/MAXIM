import type { VkParsingSettings, VkParsingSource } from '@maxim/contracts';
import type { VkParsingEntityType } from '../lib/api/vk-parsing-client';
import type { ApiTransport } from '../lib/api/transport';
import { HealthSummary } from './vk-parsing/health-summary';
import { Pagination } from './vk-parsing/pagination';
import { PostList } from './vk-parsing/post-list';
import { QueueTimeline } from './vk-parsing/queue-timeline';
import { SafetyPanel } from './vk-parsing/safety-panel';
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
};

const VK_AUTOPUBLISH_TARGETS = {
  source: 'vk-parsing-source-section',
  automation: 'vk-parsing-automation-switch',
  mode: 'vk-parsing-publish-mode',
  time: 'vk-parsing-work-time',
} as const;

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

function resolveCommonValue<T>(values: T[]): T | null {
  if (values.length === 0) {
    return null;
  }
  const [first] = values;
  return values.every((value) => value === first) ? first : null;
}

function formatPublishMode(mode: VkParsingSource['publishMode'] | null): string {
  if (!mode) {
    return 'Выберите';
  }
  if (mode === 'IMMEDIATE') {
    return 'Сразу';
  }
  if (mode === 'REVIEW') {
    return 'Проверка';
  }
  return 'Очередь';
}

function buildAutopostStatus(
  settings: VkParsingSettings,
  sources: VkParsingSource[],
): AutopostStatusModel {
  const activeSourceCount = sources.filter((source) => source.importEnabled).length;
  const autoSourceCount = sources.filter(
    (source) => source.importEnabled && source.autoPublishEnabled,
  ).length;
  const activeAutoSources = sources.filter(
    (source) => source.importEnabled && source.autoPublishEnabled,
  );
  const commonPublishMode = resolveCommonValue(
    activeAutoSources.map((source) => source.publishMode),
  );
  const timeWindow = resolveTimeWindow(settings);
  const isPaused = settings.autoPublishKillSwitchEnabled;
  const isWorking =
    settings.autoPublishEnabled &&
    !isPaused &&
    activeSourceCount > 0 &&
    autoSourceCount > 0 &&
    timeWindow.ready;

  let title = 'Ручной режим';
  let reason = 'Автопостинг выключен';
  let tone: AutopostStatusTone = 'muted';

  if (isPaused) {
    title = 'Всё на паузе';
    reason = 'Стоп включён';
    tone = 'danger';
  } else if (!settings.autoPublishEnabled) {
    title = 'Ручной режим';
    reason = 'Общий тумблер выключен';
  } else if (activeSourceCount === 0) {
    title = 'Ручной режим';
    reason = 'Нет активных источников';
    tone = 'warning';
  } else if (autoSourceCount === 0) {
    title = 'Ручной режим';
    reason = 'Авто выключено у источников';
    tone = 'warning';
  } else if (!timeWindow.ready) {
    title = 'Всё на паузе';
    reason = 'Тихие часы';
    tone = 'warning';
  } else if (isWorking) {
    title = 'Автопостинг работает';
    reason = 'Готово к публикации';
    tone = 'success';
  }

  return {
    title,
    reason,
    tone,
    readiness: [
      {
        label: 'Источник',
        value: activeSourceCount > 0 ? `${activeSourceCount} вкл` : 'Нет',
        ready: activeSourceCount > 0,
        targetId: VK_AUTOPUBLISH_TARGETS.source,
      },
      {
        label: 'Авто',
        value: settings.autoPublishEnabled && autoSourceCount > 0 && !isPaused ? 'Вкл' : 'Выкл',
        ready: settings.autoPublishEnabled && autoSourceCount > 0 && !isPaused,
        targetId: VK_AUTOPUBLISH_TARGETS.automation,
      },
      {
        label: 'Режим',
        value:
          activeAutoSources.length === 0
            ? 'Нет авто'
            : commonPublishMode
              ? formatPublishMode(commonPublishMode)
              : 'Разные',
        ready: activeAutoSources.length > 0,
        neutral: activeAutoSources.length > 0 && commonPublishMode === null,
        targetId: VK_AUTOPUBLISH_TARGETS.mode,
      },
      {
        label: 'Время',
        value: timeWindow.label,
        ready: timeWindow.ready,
        targetId: VK_AUTOPUBLISH_TARGETS.time,
      },
    ],
  };
}

export function VkParsingCard({ api, chatId, active, entityType = 'channel' }: VkParsingCardProps) {
  const state = useVkParsingCard({ api, chatId, active, entityType });
  const { feed, feedQuery, settings, posts, sources } = state;
  const publishedCount =
    sources.length > 0
      ? sources.reduce((sum, source) => sum + source.publishedPostCount, 0)
      : posts.filter((post) => post.status === 'PUBLISHED').length;
  const autopostStatus = feed ? buildAutopostStatus(settings, sources) : null;
  const focusAutopostTarget = (targetId: string) => {
    const target = document.getElementById(targetId);
    if (!target) {
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const focusTarget = target.matches('button, input, select, textarea')
      ? target
      : target.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select');
    focusTarget?.focus({ preventScroll: true });
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
          onSelectStatusTarget={focusAutopostTarget}
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

      {feed ? (
        <div className="vk-parsing-control-stack">
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
            <summary>Защита и история</summary>
            <HealthSummary summary={feed.summary} />
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
