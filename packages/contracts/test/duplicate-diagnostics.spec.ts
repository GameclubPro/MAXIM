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
