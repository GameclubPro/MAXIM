export const PUBLISHER_AUTO_REPLY_FLOOD_GATE_BURST_WINDOW_SEC = 10;
export const PUBLISHER_AUTO_REPLY_FLOOD_GATE_ROLLING_WINDOW_SEC = 60;
export const PUBLISHER_AUTO_REPLY_FLOOD_GATE_DECISION_TTL_SEC = 120;

export const PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS = Object.freeze({
  userBurstLimit: 3,
  userRollingLimit: 10,
  chatBurstLimit: 30,
  chatRollingLimit: 120,
  queueBacklogLimit: 200,
  redisTimeoutMs: 100,
});

export const PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS = Object.freeze({
  userBurstLimit: { min: 1, max: 100 },
  userRollingLimit: { min: 1, max: 1_000 },
  chatBurstLimit: { min: 1, max: 1_000 },
  chatRollingLimit: { min: 1, max: 10_000 },
  queueBacklogLimit: { min: 10, max: 100_000 },
  redisTimeoutMs: { min: 10, max: 2_000 },
});
