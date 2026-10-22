export const NETWORK_VIEW_OBSERVATION_GAP_MS = 2 * 60 * 60_000;

export type NetworkViewObservationState = {
  baselineAt: Date;
  observedAt: Date;
  observedViews: number;
  highWaterViews: number;
  anomalyAt: Date | null;
};

export type NetworkViewObservation = {
  observedAt: Date;
  views: number;
};

export type NetworkViewObservationTransition = {
  state: NetworkViewObservationState;
  interval: {
    fromAt: Date;
    toAt: Date;
    delta: number;
    quality: 'ready' | 'gap' | 'correction';
  } | null;
};

// FLAG: Observed counters are not retroactive calendar receipts. Baselines, gaps and
// corrections never manufacture views or distribute an uncertain interval across days.
export function advanceNetworkViewObservation(
  previous: NetworkViewObservationState | null,
  observation: NetworkViewObservation,
): NetworkViewObservationTransition | null {
  const { observedAt, views } = observation;
  if (!Number.isFinite(observedAt.getTime()) || !Number.isSafeInteger(views) || views < 0)
    return null;
  if (previous && observedAt.getTime() <= previous.observedAt.getTime()) return null;
  if (!previous)
    return {
      state: {
        baselineAt: observedAt,
        observedAt,
        observedViews: views,
        highWaterViews: views,
        anomalyAt: null,
      },
      interval: null,
    };

  const corrected = views < previous.highWaterViews;
  const quality =
    corrected || previous.observedViews < previous.highWaterViews
      ? 'correction'
      : observedAt.getTime() - previous.observedAt.getTime() > NETWORK_VIEW_OBSERVATION_GAP_MS
        ? 'gap'
        : 'ready';
  return {
    state: {
      baselineAt: previous.baselineAt,
      observedAt,
      observedViews: views,
      highWaterViews: Math.max(previous.highWaterViews, views),
      anomalyAt: quality === 'correction' ? observedAt : previous.anomalyAt,
    },
    interval: {
      fromAt: previous.observedAt,
      toAt: observedAt,
      delta: Math.max(0, views - previous.highWaterViews),
      quality,
    },
  };
}
