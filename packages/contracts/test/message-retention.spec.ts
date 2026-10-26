import { describe, expect, it } from 'vitest';
import {
  updateMessageRetentionSchema,
  messageRetentionStateSchema,
} from '../src/message-retention';

describe('message retention contracts', () => {
  it.each([24, 48, 168])('accepts the %i-hour mode with explicit revision', (hours) => {
    expect(
      updateMessageRetentionSchema.parse({ enabled: true, hours, expectedRevision: 0 }).hours,
    ).toBe(hours);
  });
  it('accepts an operation identity and rejects malformed identities', () => {
    const request = { enabled: true, hours: 168, expectedRevision: 0 };
    const operationId = '1eb28182-cbfd-49df-9489-181f514241e3';
    expect(updateMessageRetentionSchema.parse({ ...request, operationId }).operationId).toBe(
      operationId,
    );
    expect(
      updateMessageRetentionSchema.safeParse({ ...request, operationId: 'retry' }).success,
    ).toBe(false);
  });
  it('requires explicit enable consent for deferred connection and leaves old requests immediate', () => {
    const input = { enabled: true, hours: 48, expectedRevision: 0 };
    expect(updateMessageRetentionSchema.parse(input).connectWhenReady).toBeUndefined();
    expect(
      updateMessageRetentionSchema.parse({ ...input, connectWhenReady: true }).connectWhenReady,
    ).toBe(true);
    expect(
      updateMessageRetentionSchema.safeParse({
        ...input,
        enabled: false,
        connectWhenReady: true,
      }).success,
    ).toBe(false);
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
    for (const status of ['pending', 'expired', 'cancelled']) {
      const connectionRequest = { status, expiresAt: '2026-10-26T16:00:00.000Z' };
      expect(messageRetentionStateSchema.parse({ ...state, connectionRequest })).toMatchObject({
        enabled: false,
        connectionRequest,
      });
    }
    expect(messageRetentionStateSchema.parse({ ...state, connectionRequest: null })).toMatchObject({
      connectionRequest: null,
    });
    expect(
      messageRetentionStateSchema.safeParse({
        ...state,
        connectionRequest: { status: 'pending', expiresAt: 'later' },
      }).success,
    ).toBe(false);
  });
});
