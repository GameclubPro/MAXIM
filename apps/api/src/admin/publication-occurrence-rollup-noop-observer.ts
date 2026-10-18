import type { Logger } from '@nestjs/common';
import type { PublicationOccurrenceRollupNoopRollout } from './publication-occurrence-rollup-noop';

type RollupObservation = 'unchanged' | 'fallback' | 'error';
const emptyCounts = () => ({ observations: 0, admitted: 0, unchanged: 0, fallback: 0, error: 0 });

// FLAG: These are repeated reader observations, not unique operations or effect receipts.
// Diagnostics have no entity labels, timers or authority and cannot fail application work.
export class PublicationOccurrenceRollupNoopObserver {
  private counts = emptyCounts();
  private windowStartedAtMs = 0;
  private nextLogAtMs = 0;

  constructor(private readonly logger: Pick<Logger, 'log'>) {}

  record(
    rollout: PublicationOccurrenceRollupNoopRollout,
    admitted: boolean,
    result: RollupObservation,
  ): void {
    if (rollout === 'off') return;
    try {
      const increment = (key: keyof typeof this.counts) => {
        this.counts[key] = Math.min(Number.MAX_SAFE_INTEGER, this.counts[key] + 1);
      };
      increment('observations');
      if (admitted) increment('admitted');
      increment(result);
      const now = Date.now();
      if (!Number.isFinite(now)) return;
      if (this.windowStartedAtMs === 0) this.windowStartedAtMs = now;
      if (now < this.nextLogAtMs) return;
      const observation = {
        metric: 'publication_occurrence_rollup_noop_v1',
        rollout,
        windowMs: Math.max(0, now - this.windowStartedAtMs),
        ...this.counts,
      };
      this.counts = emptyCounts();
      this.windowStartedAtMs = now;
      this.nextLogAtMs = now + 60_000;
      this.logger.log(observation);
    } catch {
      // FLAG: A failed diagnostic must neither retry SQL nor replace its original error.
    }
  }
}
