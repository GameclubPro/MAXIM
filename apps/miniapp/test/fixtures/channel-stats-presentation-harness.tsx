import { createRoot } from 'react-dom/client';
import type { ChannelStatsResponse } from '@maxim/contracts/channel-stats';
import { ChannelStatsOverview } from '../../src/components/dashboard/channel-stats-overview';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import '../../src/styles.css';
import '../../src/styles/moderation-workspace.css';
import '../../src/pages/channel-stats-page';

const stats = await createPreviewApiTransport().request<ChannelStatsResponse>(
  '/channels/preview-channel/stats?range=7d',
);
const root = createRoot(document.getElementById('root')!);
declare global {
  interface Window {
    renderStatistics: (scenario?: 'default' | 'stress' | 'empty' | 'unavailable') => void;
  }
}

window.renderStatistics = (scenario = 'default') => {
  const next = structuredClone(stats);
  if (scenario === 'stress') {
    next.summary.subscribers.current = 123456789;
    next.summary.reach.averageViews24h = 123456789;
    next.summary.reach.asOf = '2026-10-21T09:45:00.000Z';
    next.meta.officialCoverageFrom = next.period.to;
    next.meta.refreshQueued = true;
    next.summary.daily = [
      {
        ...next.summary.daily[0]!,
        subscribers: 123456789,
        delta: 123456,
        joined: 12345,
        left: 6789,
      },
    ];
  } else if (scenario === 'empty' || scenario === 'unavailable') {
    next.summary.subscribers.current = null;
    next.summary.reach.averageViews24h = null;
    next.summary.reach.coverage24h = 'unavailable';
    next.summary.reach.averageViews48h = null;
    next.summary.reach.err48Percent = null;
    next.summary.reach.coverage48h = 'unavailable';
    next.summary.reach.asOf = null;
    next.summary.daily = [];
    next.official.content.topPosts = [];
    next.signals.bestWindows = [];
    next.official.series.participants = next.official.series.participants.map((point) => ({
      ...point,
      participantsCount: null,
    }));
    if (scenario === 'empty') {
      next.official.series.participants = [];
      next.official.series.membership = [];
    }
  }
  root.render(
    <div className="channel-insights" data-managed-entity-workspace>
      <div className="channel-insights__body">
        <ChannelStatsOverview stats={next} range="7d" onRangeChange={() => {}} />
      </div>
    </div>,
  );
};
window.renderStatistics();
