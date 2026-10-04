import { describe, expect, it } from 'vitest';
import {
  duplicateDiagnosticsResponseSchema,
  duplicateDiagnosticsQuerySchema,
  duplicateMessageLinkResponseSchema,
  duplicateObservationOutcomeSchema,
} from '../src/duplicate-diagnostics';

const time = '2026-09-14T12:00:00.000Z';
const payload = {
  generatedAt: time,
  enabled: true,
  mode: 'FULL',
  capability: { state: 'UNKNOWN', checkedAt: null },
  history: { available: true, since: time, sampledIntents: 0, limited: false, attempts: [] },
};
describe('duplicate diagnostics contract', () => {
  it('accepts every supported observation outcome together and rejects a larger payload', () => {
    const outcomes = duplicateObservationOutcomeSchema.options.map((outcome) => ({
      outcome,
      count: 1,
    }));
    const observation = {
      state: 'AVAILABLE',
      since: time,
      until: time,
      basis: 'ATTEMPTS',
      completeness: 'BEST_EFFORT',
      supportedAttempts: outcomes.length,
      verifiedAttempts: 0,
      coverage: 0,
      outcomes,
    };
    expect(
      duplicateDiagnosticsResponseSchema.parse({ ...payload, observation }).observation?.outcomes,
    ).toEqual(outcomes);
    expect(
      duplicateDiagnosticsResponseSchema.safeParse({
        ...payload,
        observation: {
          ...observation,
          outcomes: [...outcomes, outcomes[0]],
        },
      }).success,
    ).toBe(false);
  });
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
        history: { ...payload.history, attempts: Array(21).fill(attempt) },
      }).success,
    ).toBe(false);
    expect(
      duplicateDiagnosticsResponseSchema.safeParse({
        ...payload,
        history: { ...payload.history, attempts: [{ ...attempt, outcome: 'PROBABLY_DELETED' }] },
      }).success,
    ).toBe(false);
  });
  it('bounds pages and accepts only verified credential-free HTTPS MAX links', () => {
    expect(duplicateDiagnosticsQuerySchema.parse({}).limit).toBe(5);
    expect(duplicateDiagnosticsQuerySchema.parse({ limit: '20' }).limit).toBe(20);
    for (const limit of [0, 21, 'not-a-number'])
      expect(duplicateDiagnosticsQuerySchema.safeParse({ limit }).success).toBe(false);
    expect(
      duplicateMessageLinkResponseSchema.parse({
        state: 'AVAILABLE',
        url: 'https://max.ru/c/123/456',
      }).url,
    ).toBeTruthy();
    for (const url of [
      'http://max.ru/c/123/456',
      'https://max.ru.evil/c/123',
      'https://max.ru@evil/c/123',
      'https://user:pass@max.ru/c/123',
      'https://max.ru:444/c/123',
    ]) {
      expect(
        duplicateMessageLinkResponseSchema.safeParse({ state: 'AVAILABLE', url }).success,
      ).toBe(false);
    }
    expect(
      duplicateMessageLinkResponseSchema.safeParse({ state: 'AVAILABLE', url: null }).success,
    ).toBe(false);
  });
});
