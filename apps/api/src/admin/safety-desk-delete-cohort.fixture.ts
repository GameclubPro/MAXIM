import { safetyDeskDeleteCohortStatusSchema } from '@maxim/contracts/safety-desk';
import { type SafetyDeskDeleteCohortQueryRow } from './safety-desk-delete-cohort.model';

export const deleteCohortObservedAt = new Date('2035-01-01T00:15:30.000Z');
export function emptyDeleteCohortRecords(): SafetyDeskDeleteCohortQueryRow[] {
  return safetyDeskDeleteCohortStatusSchema.options.map((status) => ({
    observedAt: deleteCohortObservedAt,
    windowStartedAt: new Date('2035-01-01T00:00:00.000Z'),
    windowEndedAt: new Date('2035-01-01T00:15:00.000Z'),
    status,
    sampleCount: 0,
    truncated: false,
    id: null,
    createdAt: null,
    executeAt: null,
    nextAttemptAt: null,
    retryUntilAt: null,
    deleteDispatchStartedAt: null,
    remoteDeleteSucceededAt: null,
    remoteDeleteSucceededBotId: null,
    completedAt: null,
    absenceVerifiedAt: null,
    absenceVerifiedBotId: null,
    absenceVerificationCode: null,
    succeededBotId: null,
    leaseExpiresAt: null,
    hasLease: null,
  }));
}

export function deleteCohortRecord(
  status: SafetyDeskDeleteCohortQueryRow['status'] = 'PENDING',
  overrides: Partial<SafetyDeskDeleteCohortQueryRow> = {},
): SafetyDeskDeleteCohortQueryRow {
  return {
    ...emptyDeleteCohortRecords()[0]!,
    status,
    id: `intent-${status}`,
    createdAt: new Date('2035-01-01T00:14:00.000Z'),
    executeAt: new Date('2035-01-01T00:14:00.000Z'),
    nextAttemptAt: new Date('2035-01-01T00:14:00.000Z'),
    retryUntilAt: new Date('2035-01-01T00:20:00.000Z'),
    sampleCount: 1,
    hasLease: false,
    ...overrides,
  };
}

export function deleteCohortRecordsWith(
  ...records: SafetyDeskDeleteCohortQueryRow[]
): SafetyDeskDeleteCohortQueryRow[] {
  return emptyDeleteCohortRecords().flatMap((empty) => {
    const selected = records.filter((record) => record.status === empty.status);
    return selected.length
      ? selected.map((record) => ({ ...record, sampleCount: selected.length }))
      : [empty];
  });
}
