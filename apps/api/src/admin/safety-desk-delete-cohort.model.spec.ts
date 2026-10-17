import { projectDeleteOutcome } from './safety-desk-delete-evidence.service';
import {
  deleteCohortObservedAt,
  deleteCohortRecord,
  deleteCohortRecordsWith,
  emptyDeleteCohortRecords,
} from './safety-desk-delete-cohort.fixture';
import {
  projectSafetyDeskDeleteCohort,
  type SafetyDeskDeleteCohortQueryRow,
} from './safety-desk-delete-cohort.model';

describe('recorded DELETE cohort projection', () => {
  function project(...records: SafetyDeskDeleteCohortQueryRow[]) {
    return projectSafetyDeskDeleteCohort(deleteCohortRecordsWith(...records));
  }

  it('includes all ten statuses, including observation-only and stopped units', () => {
    const records = emptyDeleteCohortRecords().map(({ status }) => deleteCohortRecord(status));
    const value = project(...records);
    expect(value).toMatchObject({
      includesObservedOnly: true,
      totalCountLowerBound: 10,
      sampleComplete: true,
    });
    for (const record of records) {
      expect(value.rows.find((row) => row.status === record.status)?.outcomeCounts).toHaveProperty(
        projectDeleteOutcome({ ...record, createdAt: record.createdAt! }, deleteCohortObservedAt),
        1,
      );
    }
    expect(value.rows.find((row) => row.status === 'OBSERVED')?.outcomeCounts.observed).toBe(1);
    expect(value.rows.find((row) => row.status === 'EXPIRED')?.outcomeCounts.stopped).toBe(1);
    expect(JSON.stringify(value)).not.toContain('intent-');
  });

  it('preserves uncertainty after the deadline and reports overlapping saved waits', () => {
    const unknown = deleteCohortRecord('AMBIGUOUS', {
      deleteDispatchStartedAt: new Date('2035-01-01T00:14:05.000Z'),
      retryUntilAt: new Date('2035-01-01T00:15:00.000Z'),
      nextAttemptAt: new Date('2035-01-01T00:16:00.000Z'),
      hasLease: true,
      leaseExpiresAt: new Date('2035-01-01T00:16:00.000Z'),
    });
    const value = project(
      unknown,
      deleteCohortRecord('RETRYABLE'),
      deleteCohortRecord('WAITING_CAPABILITY'),
    );
    expect(value.rows.find((row) => row.status === 'AMBIGUOUS')).toMatchObject({
      outcomeCounts: { unknown: 1, stopped: 0 },
      deadlineCounts: { elapsed: 1 },
      waitCounts: { effectUnknown: 1, notDue: 1, leaseActive: 1 },
      waitCountsOverlap: true,
      finalizedLatency: { sampleCount: 0, invalidClockCount: 0, p95Ms: null, p99Ms: null },
    });
    expect(value.rows.find((row) => row.status === 'RETRYABLE')?.waitCounts.retryDue).toBe(1);
    expect(
      value.rows.find((row) => row.status === 'WAITING_CAPABILITY')?.waitCounts.capability,
    ).toBe(1);
  });

  it('measures only finalized exact receipts and records invalid completion clocks separately', () => {
    const receipt = new Date('2035-01-01T00:14:10.000Z');
    const completed = new Date('2035-01-01T00:14:12.000Z');
    const success = deleteCohortRecord('SUCCEEDED', {
      remoteDeleteSucceededAt: receipt,
      remoteDeleteSucceededBotId: 'bot',
      succeededBotId: 'bot',
      completedAt: completed,
    });
    const absence = deleteCohortRecord('ALREADY_ABSENT', {
      absenceVerifiedAt: receipt,
      absenceVerifiedBotId: 'bot',
      absenceVerificationCode: 'postdelete_exact_presence',
      completedAt: completed,
    });
    const value = project(
      success,
      absence,
      { ...success, id: 'wrong-bot', succeededBotId: 'other' },
      { ...success, id: 'invalid-completion', completedAt: new Date('2035-01-01T00:14:09.000Z') },
      { ...absence, id: 'generic-404', absenceVerificationCode: 'http_404' },
      { ...absence, id: 'missing-completion', completedAt: null },
      { ...success, id: 'unsettled', status: 'AMBIGUOUS', completedAt: null },
    );
    expect(value.rows.find((row) => row.status === 'SUCCEEDED')).toMatchObject({
      countLowerBound: 3,
      outcomeCounts: { confirmed: 1, acknowledged: 2 },
      finalizedLatency: { sampleCount: 1, invalidClockCount: 1, p95Ms: 12_000, p99Ms: 12_000 },
    });
    expect(value.rows.find((row) => row.status === 'ALREADY_ABSENT')).toMatchObject({
      countLowerBound: 3,
      outcomeCounts: { already_absent: 2, unknown: 1 },
      finalizedLatency: { sampleCount: 1, invalidClockCount: 1, p95Ms: 12_000, p99Ms: 12_000 },
    });
    expect(value.rows.find((row) => row.status === 'AMBIGUOUS')).toMatchObject({
      outcomeCounts: { acknowledged: 1 },
      waitCounts: { receiptSettlement: 1 },
      finalizedLatency: { sampleCount: 0, invalidClockCount: 0 },
    });
  });

  it('does not manufacture valid deadlines, leases or latency from malformed clocks', () => {
    const value = project(
      deleteCohortRecord('PENDING', {
        retryUntilAt: new Date('2035-01-01T00:13:00.000Z'),
        hasLease: true,
        leaseExpiresAt: null,
      }),
      deleteCohortRecord('RETRYABLE', {
        retryUntilAt: null,
        nextAttemptAt: new Date(Number.NaN),
        hasLease: true,
        leaseExpiresAt: new Date('2035-01-01T00:14:05.000Z'),
      }),
    );
    expect(value.rows.find((row) => row.status === 'PENDING')).toMatchObject({
      deadlineCounts: { invalid: 1 },
      waitCounts: { leaseActive: 0, leaseStale: 0 },
    });
    expect(value.rows.find((row) => row.status === 'RETRYABLE')).toMatchObject({
      deadlineCounts: { invalid: 1 },
      waitCounts: { notDue: 0, retryDue: 0, leaseStale: 1 },
    });
  });

  it('uses deterministic nearest-rank percentiles over the finalized subset', () => {
    const records = Array.from({ length: 100 }, (_, index) =>
      deleteCohortRecord('SUCCEEDED', {
        id: `latency-${index}`,
        remoteDeleteSucceededAt: new Date('2035-01-01T00:14:00.000Z'),
        remoteDeleteSucceededBotId: 'bot',
        succeededBotId: 'bot',
        completedAt: new Date(Date.parse('2035-01-01T00:14:00.000Z') + index + 1),
      }),
    );
    expect(
      project(...records).rows.find((row) => row.status === 'SUCCEEDED')?.finalizedLatency,
    ).toEqual({ sampleCount: 100, invalidClockCount: 0, p95Ms: 95, p99Ms: 99 });
  });

  it('rejects missing status, mixed snapshots, duplicate units and sentinel metadata', () => {
    expect(() => projectSafetyDeskDeleteCohort(emptyDeleteCohortRecords().slice(1))).toThrow();
    const mixed = emptyDeleteCohortRecords();
    mixed[0]!.observedAt = new Date(deleteCohortObservedAt.getTime() - 1);
    expect(() => projectSafetyDeskDeleteCohort(mixed)).toThrow();
    expect(() => project(deleteCohortRecord(), deleteCohortRecord())).toThrow();
    const overflow = Array.from({ length: 513 }, (_, index) =>
      deleteCohortRecord('PENDING', { id: `overflow-${index}` }),
    );
    expect(() => project(...overflow)).toThrow();
    expect(() =>
      project(deleteCohortRecord('PENDING', { createdAt: new Date('2035-01-01T00:15:00.000Z') })),
    ).toThrow();
  });
});
