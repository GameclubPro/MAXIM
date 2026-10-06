import { LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES } from './legacy-recovery-live-protocol';

export const LEGACY_RECOVERY_LIVE_BUDGET = Object.freeze({
  pages: 512,
  rows: 10_000,
  probes: 50_000,
  bytes: LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES,
  durationMs: 30_000,
});
