// FLAG: This bounds speculative preparation only. Actual due/manual producers retain
// their durable work; a saturated queue never authorizes or silently drops a send.
export const PUBLISHER_PREFLIGHT_INTERVAL_MS = 2_000;
export const PUBLISHER_PREFLIGHT_PENDING_LIMIT = 8;
export const PUBLISHER_PREFLIGHT_TARGET_BUDGET = 4;
export const PUBLISHER_PUBLICATION_URGENCY_MS = 60_000;
export const PUBLISHER_PREFLIGHT_PRIORITY = 8;

export function publicationUrgentAt(scheduledAt: Date): Date {
  return new Date(Math.max(0, scheduledAt.getTime() - PUBLISHER_PUBLICATION_URGENCY_MS));
}

export function publicationPreparationBudget(counts: Record<string, number>): number {
  const urgent = (counts['1'] ?? 0) + (counts['5'] ?? 0);
  const preparing = counts[String(PUBLISHER_PREFLIGHT_PRIORITY)] ?? 0;
  if (![urgent, preparing].every((n) => Number.isSafeInteger(n) && n >= 0)) return 0;
  // Two workers are unchanged. Reserve at least one pair of starts for existing
  // urgent work, and count two possible nominations (bot + actor) per target.
  if (urgent >= 2) return 0;
  return Math.max(
    0,
    Math.min(
      PUBLISHER_PREFLIGHT_TARGET_BUDGET,
      Math.floor((PUBLISHER_PREFLIGHT_PENDING_LIMIT - preparing - urgent) / 2),
    ),
  );
}
