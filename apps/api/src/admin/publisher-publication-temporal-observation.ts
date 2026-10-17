import type { Logger } from '@nestjs/common';
import type { PublisherTemporalSelectionRollout } from './publisher-publication-temporal-enrollment';
import type { PublisherTemporalSelectionObservation } from './publisher-publication-temporal-selection';

const emptyCounts = (): PublisherTemporalSelectionObservation => ({
  candidates: 0,
  unsupported: 0,
  refused: 0,
  enrolled: 0,
  excludedWaiting: 0,
  preferredReturned: 0,
  fallbackReintroduced: 0,
  comparisonBatches: 0,
  changedDecisionBatches: 0,
  changedPositions: 0,
  newlySelected: 0,
  displaced: 0,
});

// FLAG: Selection observations repeat across polls; they are not unique operations or
// effect receipts. Aggregate locally to avoid a log per poll, with no timers or identifiers.
export class PublisherTemporalSelectionObserver {
  private counts = emptyCounts();
  private samples = 0;
  private windowStartedAtMs = Date.now();
  private nextLogAtMs = 0;

  constructor(private readonly logger: Pick<Logger, 'log'>) {}

  record(
    rollout: PublisherTemporalSelectionRollout,
    observation: PublisherTemporalSelectionObservation | undefined,
  ): void {
    if (!observation) return;
    this.samples += 1;
    for (const key of Object.keys(this.counts) as Array<keyof typeof this.counts>) {
      this.counts[key] += observation[key];
    }
    const now = Date.now();
    if (now < this.nextLogAtMs) return;
    try {
      this.logger.log({
        metric: 'publication_temporal_selection_v1',
        rollout,
        lane: 'now',
        samples: this.samples,
        windowMs: Math.max(0, now - this.windowStartedAtMs),
        ...this.counts,
      });
    } catch {
      // FLAG: Diagnostic emission cannot prevent an already selected guarded operation.
    }
    this.counts = emptyCounts();
    this.samples = 0;
    this.windowStartedAtMs = now;
    this.nextLogAtMs = now + 60_000;
  }
}
