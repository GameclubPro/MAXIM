import { describe, expect, it } from 'vitest';
import {
  updateMessageRetentionSchema,
  messageRetentionStateSchema,
} from '../src/message-retention';

describe('message retention contracts', () => {
  it.each([24, 48])('accepts the %i-hour mode with explicit revision', (hours) => {
    expect(
      updateMessageRetentionSchema.parse({ enabled: true, hours, expectedRevision: 0 }).hours,
    ).toBe(hours);
  });
  it.each([
    { enabled: true, hours: 12, expectedRevision: 0 },
    { enabled: true, hours: '24', expectedRevision: 0 },
    { enabled: true, hours: 48 },
    { enabled: true, hours: 48, expectedRevision: -1 },
    { enabled: true, hours: 48, expectedRevision: 0, includeHistory: true },
  ])('rejects unsupported modes and authority fields', (input) => {
    expect(updateMessageRetentionSchema.safeParse(input).success).toBe(false);
  });
  it('validates explicit unavailable and pause states', () => {
    const state = {
      enabled: false,
      hours: 48,
      revision: 0,
      enabledAt: null,
      captureAfter: null,
      pausedAt: null,
      status: 'unavailable',
      pendingCount: 0,
      deletedCount: 0,
      skippedCount: 0,
      oldestDueAt: null,
    };
    expect(messageRetentionStateSchema.parse(state)).toEqual(state);
    expect(messageRetentionStateSchema.safeParse({ ...state, pendingCount: -1 }).success).toBe(
      false,
    );
  });
});
