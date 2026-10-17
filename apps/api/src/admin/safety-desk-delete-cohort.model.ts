import {
  safetyDeskDeleteCohortResponseSchema,
  safetyDeskDeleteCohortStatusSchema,
  type SafetyDeskDeleteCohortResponse,
  type SafetyDeskDeleteCohortRow,
} from '@maxim/contracts/safety-desk';
import { projectDeleteOutcome } from './safety-desk-delete-evidence.service';

type DeleteOutcomeInput = Parameters<typeof projectDeleteOutcome>[0];
export type SafetyDeskDeleteCohortQueryRow = Omit<DeleteOutcomeInput, 'createdAt'> & {
  observedAt: Date;
  windowStartedAt: Date;
  windowEndedAt: Date;
  sampleCount: number;
  truncated: boolean;
  id: string | null;
  createdAt: Date | null;
  executeAt: Date | null;
  nextAttemptAt: Date | null;
  retryUntilAt: Date | null;
  leaseExpiresAt: Date | null;
  hasLease: boolean | null;
};

const milliseconds = (date: Date | null) => date?.getTime() ?? Number.NaN;
const emptyRow = (status: SafetyDeskDeleteCohortRow['status']): SafetyDeskDeleteCohortRow => ({
  status,
  countLowerBound: 0,
  truncated: false,
  outcomeCounts: {
    confirmed: 0,
    acknowledged: 0,
    already_absent: 0,
    unknown: 0,
    stopped: 0,
    observed: 0,
    pending: 0,
  },
  deadlineCounts: { notElapsed: 0, elapsed: 0, invalid: 0 },
  waitCounts: {
    notDue: 0,
    retryDue: 0,
    leaseActive: 0,
    leaseStale: 0,
    capability: 0,
    receiptSettlement: 0,
    effectUnknown: 0,
  },
  waitCountsOverlap: true,
  finalizedLatency: { sampleCount: 0, invalidClockCount: 0, p95Ms: null, p99Ms: null },
});

export function projectSafetyDeskDeleteCohort(
  records: SafetyDeskDeleteCohortQueryRow[],
): SafetyDeskDeleteCohortResponse {
  const first = records[0];
  if (!first) throw new Error('Missing deletion cohort bounds');
  const observedMs = first.observedAt.getTime();
  const statuses = safetyDeskDeleteCohortStatusSchema.options;
  const rows = statuses.map(emptyRow);
  for (const row of rows) {
    const selected = records.filter((record) => record.status === row.status);
    const head = selected[0];
    if (!head || selected.length > 512) throw new Error('Invalid deletion status sample');
    const details = selected.filter((record) => record.id !== null);
    if (
      details.length !== head.sampleCount ||
      selected.length !== Math.max(1, head.sampleCount) ||
      new Set(details.map((record) => record.id)).size !== details.length ||
      selected.some(
        (record) =>
          record.sampleCount !== head.sampleCount ||
          record.truncated !== head.truncated ||
          record.observedAt.getTime() !== observedMs ||
          record.windowStartedAt.getTime() !== first.windowStartedAt.getTime() ||
          record.windowEndedAt.getTime() !== first.windowEndedAt.getTime(),
      )
    )
      throw new Error('Inconsistent deletion cohort snapshot');
    row.countLowerBound = head.sampleCount;
    row.truncated = head.truncated;
    const latencies: number[] = [];
    for (const record of details) {
      const acceptedMs = milliseconds(record.createdAt);
      if (
        !record.createdAt ||
        !Number.isFinite(acceptedMs) ||
        acceptedMs < first.windowStartedAt.getTime() ||
        acceptedMs >= first.windowEndedAt.getTime()
      )
        throw new Error('Deletion receipt is outside its closed cohort');
      const outcome = projectDeleteOutcome(
        { ...record, createdAt: record.createdAt },
        first.observedAt,
      );
      row.outcomeCounts[outcome] += 1;
      const executeMs = milliseconds(record.executeAt);
      const nextAttemptMs = milliseconds(record.nextAttemptAt);
      const deadlineMs = milliseconds(record.retryUntilAt);
      if (
        !Number.isFinite(executeMs) ||
        !Number.isFinite(deadlineMs) ||
        deadlineMs < acceptedMs ||
        deadlineMs < executeMs
      )
        row.deadlineCounts.invalid += 1;
      else row.deadlineCounts[deadlineMs <= observedMs ? 'elapsed' : 'notElapsed'] += 1;

      // FLAG: These overlapping facts describe saved clocks, never current authorization,
      // an executor's liveness or permission to repeat an uncertain external action.
      if (
        ['PENDING', 'IN_PROGRESS', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS'].includes(
          record.status,
        )
      ) {
        if (
          Number.isFinite(executeMs) &&
          Number.isFinite(nextAttemptMs) &&
          Math.max(executeMs, nextAttemptMs) > observedMs
        )
          row.waitCounts.notDue += 1;
        if (
          record.status === 'RETRYABLE' &&
          Number.isFinite(executeMs) &&
          Number.isFinite(nextAttemptMs) &&
          Math.max(executeMs, nextAttemptMs) <= observedMs
        )
          row.waitCounts.retryDue += 1;
      }
      const leaseMs = milliseconds(record.leaseExpiresAt);
      if (record.hasLease && Number.isFinite(leaseMs) && leaseMs >= acceptedMs)
        row.waitCounts[leaseMs > observedMs ? 'leaseActive' : 'leaseStale'] += 1;
      if (record.status === 'WAITING_CAPABILITY') row.waitCounts.capability += 1;
      if (outcome === 'acknowledged') row.waitCounts.receiptSettlement += 1;
      if (outcome === 'unknown') row.waitCounts.effectUnknown += 1;

      if (record.status === 'SUCCEEDED' || record.status === 'ALREADY_ABSENT') {
        const completedMs = milliseconds(record.completedAt);
        const receiptMs = milliseconds(
          record.status === 'ALREADY_ABSENT'
            ? record.absenceVerifiedAt
            : record.remoteDeleteSucceededAt,
        );
        if (
          !Number.isFinite(completedMs) ||
          !Number.isFinite(receiptMs) ||
          receiptMs < acceptedMs ||
          completedMs < receiptMs ||
          completedMs > observedMs
        )
          row.finalizedLatency.invalidClockCount += 1;
        else if (outcome === 'confirmed' || outcome === 'already_absent')
          latencies.push(completedMs - acceptedMs);
      }
    }
    latencies.sort((left, right) => left - right);
    row.finalizedLatency.sampleCount = latencies.length;
    row.finalizedLatency.p95Ms = latencies.length
      ? latencies[Math.ceil(latencies.length * 0.95) - 1]!
      : null;
    row.finalizedLatency.p99Ms = latencies.length
      ? latencies[Math.ceil(latencies.length * 0.99) - 1]!
      : null;
  }
  if (records.some((record) => !statuses.some((status) => status === record.status)))
    throw new Error('Unknown deletion status');
  return safetyDeskDeleteCohortResponseSchema.parse({
    schemaVersion: 1,
    basis: 'delete_intent_created_at',
    includesObservedOnly: true,
    windowSeconds: 900,
    graceSeconds: 30,
    windowStartedAt: first.windowStartedAt.toISOString(),
    windowEndedAt: first.windowEndedAt.toISOString(),
    observedAt: first.observedAt.toISOString(),
    sampleLimitPerStatus: 512,
    sampleComplete: rows.every((row) => !row.truncated),
    totalCountLowerBound: rows.reduce((sum, row) => sum + row.countLowerBound, 0),
    rows,
  });
}
