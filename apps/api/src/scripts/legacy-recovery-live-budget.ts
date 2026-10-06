export const LEGACY_RECOVERY_LIVE_BUDGET = Object.freeze({
  pages: 512,
  rows: 10_000,
  probes: 50_000,
  // Selected production reads charge transferred plan and result bytes. Plain
  // planning estimates never claim to measure physical database I/O.
  bytes: 8 * 1024 * 1024,
  durationMs: 30_000,
});
