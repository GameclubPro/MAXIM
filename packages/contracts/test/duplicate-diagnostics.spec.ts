import { describe, expect, it } from 'vitest';
import { duplicateDiagnosticsResponseSchema } from '../src/duplicate-diagnostics';

const time = '2026-09-14T12:00:00.000Z';
const payload = {
  generatedAt: time,
  enabled: true,
  mode: 'FULL',
  capability: { state: 'UNKNOWN', checkedAt: null },
  history: { available: true, since: time, sampledIntents: 0, limited: false, attempts: [] },
};
describe('duplicate diagnostics contract', () => {
  it('keeps absent telemetry compatible and rejects invented coverage or arbitrary outcome labels', () => {
    expect(duplicateDiagnosticsResponseSchema.parse(payload).observation).toBeUndefined();
    const observation = {
      state: 'AVAILABLE',
      since: time,
      until: time,
      basis: 'ATTEMPTS',
      completeness: 'BEST_EFFORT',
      supportedAttempts: 2,
      verifiedAttempts: 0,
      coverage: 0,
      outcomes: [{ outcome: 'COMPARISON_FAILED', count: 2 }],
    };
    expect(
      duplicateDiagnosticsResponseSchema.parse({ ...payload, observation }).observation?.coverage,
    ).toBe(0);
    for (const patch of [
      { state: 'NO_DATA' },
      { verifiedAttempts: 3 },
      { coverage: 1 },
      { outcomes: [{ outcome: 'private-id', count: 1 }] },
    ]) {
      expect(
        duplicateDiagnosticsResponseSchema.safeParse({
          ...payload,
          observation: { ...observation, ...patch },
        }).success,
      ).toBe(false);
    }
  });
  it('preserves unknown capability and unavailable history without inventing defaults', () => {
    const parsed = duplicateDiagnosticsResponseSchema.parse({
      ...payload,
      history: { ...payload.history, available: false },
    });
    expect(parsed.capability.state).toBe('UNKNOWN');
    expect(parsed.history.available).toBe(false);
    expect(duplicateDiagnosticsResponseSchema.safeParse({}).success).toBe(false);
  });
  it('strips internal fields and rejects unbounded or unrecognized outcomes', () => {
    const parsed = duplicateDiagnosticsResponseSchema.parse({
      ...payload,
      botId: 'secret',
      capability: { ...payload.capability, botId: 'secret' },
    });
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(
      duplicateDiagnosticsResponseSchema.safeParse({
        ...payload,
        history: { ...payload.history, sampledIntents: 211 },
      }).success,
    ).toBe(false);
    const attempt = {
      id: 'id',
      createdAt: time,
      updatedAt: time,
      outcome: 'DELETED',
      reason: null,
      nextAttemptAt: null,
    };
    expect(
      duplicateDiagnosticsResponseSchema.safeParse({
        ...payload,
        history: { ...payload.history, attempts: Array(6).fill(attempt) },
      }).success,
    ).toBe(false);
    expect(
      duplicateDiagnosticsResponseSchema.safeParse({
        ...payload,
        history: { ...payload.history, attempts: [{ ...attempt, outcome: 'PROBABLY_DELETED' }] },
      }).success,
    ).toBe(false);
  });
});
