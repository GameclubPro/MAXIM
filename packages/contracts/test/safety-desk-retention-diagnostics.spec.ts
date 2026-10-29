import { describe, expect, it } from 'vitest';
import {
  safetyDeskRetentionRuntimeItemSchema,
  safetyDeskRetentionRuntimeResponseSchema,
  safetyDeskRetentionPreviewResponseSchema,
  type SafetyDeskRetentionRuntimeItem,
} from '../src/safety-desk';

const item = {
  chatId: '-123',
  chatTitle: 'Тестовый чат',
  enabled: true,
  hours: 48,
  revision: 1,
  activationId: 'activation-1',
  pendingCount: 0,
  deletedCount: 0,
  skippedCount: 0,
  status: 'delayed',
  oldestDueAt: null,
  nextRunAt: null,
  hasTerminalReview: false,
  hasUnresolvedReceipt: true,
  historyStatus: 'blocked',
} satisfies SafetyDeskRetentionRuntimeItem;

const diagnostics = {
  lastError: null,
  historyBoundaryBlocked: false,
  awaitingCurrentProtection: true,
  awaitingHistoricalProtection: true,
};

describe('closed retention diagnostics boundary', () => {
  it('preserves independent history protection and uncertain deletion states', () => {
    expect(safetyDeskRetentionRuntimeItemSchema.parse({ ...item, diagnostics })).toMatchObject({
      hasUnresolvedReceipt: true,
      historyStatus: 'blocked',
      diagnostics,
    });
  });

  it('keeps older runtime diagnostics absent without inventing clean flags', () => {
    const parsed = safetyDeskRetentionRuntimeItemSchema.parse(item);
    expect(parsed).not.toHaveProperty('diagnostics');
    expect(parsed.historyStatus).toBe('blocked');
    for (const field of [
      'progress',
      'coverage',
      'connectionRequest',
      'confirmationCounts',
      'source',
    ])
      expect(parsed).not.toHaveProperty(field);
  });

  it('keeps unavailable sources separate from factual rows and redacts their details', () => {
    const parsed = safetyDeskRetentionRuntimeResponseSchema.parse({
      generatedAt: '2026-10-29T00:00:00.000Z',
      mode: 'on',
      nextAfter: '-2',
      quotas: [],
      items: [],
      incomplete: true,
      unavailableSources: [
        {
          chatId: '-1',
          chatTitle: 'Чат',
          source: 'eraser',
          reason: 'unavailable',
          deletedCount: 0,
          detail: 'private',
        },
      ],
    });
    expect(parsed.items).toEqual([]);
    expect(parsed.unavailableSources).toEqual([
      { chatId: '-1', chatTitle: 'Чат', source: 'eraser', reason: 'unavailable' },
    ]);
    expect(parsed.incomplete).toBe(true);
  });

  it('preserves opaque review cursors and leaves older completeness unknown', () => {
    const base = { chatId: '-1', revision: 1, activationId: 'activation-1', items: [] };
    expect(safetyDeskRetentionPreviewResponseSchema.parse(base)).not.toHaveProperty('incomplete');
    const page = {
      ...base,
      source: 'eraser',
      sourceStatus: 'available',
      nextAfter: 'opaque/+?cursor=unchanged',
      incomplete: true,
    };
    expect(safetyDeskRetentionPreviewResponseSchema.parse(page)).toEqual(page);
  });

  it('retains bounded eligibility separately from recorded uncertainty and coverage', () => {
    const progress = {
      pendingCountComplete: true,
      eligibleCount: 2,
      eligibleCountComplete: true,
      oldestEligibleDueAt: '2026-10-29T01:00:00.000Z',
      unknownCount: 201,
      unknownCountComplete: false,
      oldestUnknownAt: '2026-10-28T01:00:00.123456Z',
    };
    const coverage = {
      lastCompletedAt: null,
      gap: true,
      protectedHistory: true,
      executionStopped: false,
    };
    expect(
      safetyDeskRetentionRuntimeItemSchema.parse({ ...item, progress, coverage }),
    ).toMatchObject({ progress, coverage });
    expect(
      safetyDeskRetentionRuntimeItemSchema.safeParse({
        ...item,
        progress: { ...progress, eligibleCountComplete: undefined },
      }).success,
    ).toBe(false);
  });

  it('retains the full closed connection lifecycle without raw errors or lease secrets', () => {
    const connectionRequest = {
      status: 'activated',
      operationId: '4fe21b95-d545-4d62-b1ba-3d4eb747fd69',
      actorUserId: '123',
      policyRevision: 2,
      expiresAt: '2026-10-29T01:00:00.000Z',
      nextAttemptAt: null,
      updatedAt: '2026-10-29T00:01:00.000Z',
      lastError: 'raw-private',
      leaseToken: 'secret',
    };
    const parsed = safetyDeskRetentionRuntimeItemSchema.parse({ ...item, connectionRequest });
    expect(parsed.connectionRequest).toMatchObject({
      status: 'activated',
      lastError: 'unknown',
      nextAttemptAt: null,
    });
    expect(parsed.connectionRequest).not.toHaveProperty('leaseToken');
    expect(JSON.stringify(parsed)).not.toContain('raw-private');
  });

  it.each(['provider.error', 'private-upstream-detail', { detail: 'private' }, undefined])(
    'redacts an unrecognized error while preserving the rest of the snapshot: %j',
    (lastError) => {
      const parsed = safetyDeskRetentionRuntimeItemSchema.parse({
        ...item,
        diagnostics: { ...diagnostics, lastError, rawDetails: 'must-not-leak' },
      });
      expect(parsed.diagnostics).toEqual({ ...diagnostics, lastError: 'unknown' });
      expect(JSON.stringify(parsed)).not.toContain('private');
      expect(JSON.stringify(parsed)).not.toContain('must-not-leak');
    },
  );

  it.each(['eraser_rights_missing', 'transport_unknown', 'delete_unconfirmed', null])(
    'retains an allowlisted reason or explicit absence: %s',
    (lastError) => {
      expect(
        safetyDeskRetentionRuntimeItemSchema.parse({
          ...item,
          diagnostics: { ...diagnostics, lastError },
        }).diagnostics?.lastError,
      ).toBe(lastError);
    },
  );

  it.each(['false', 0, null, undefined])('rejects malformed safety flags: %j', (flag) => {
    expect(
      safetyDeskRetentionRuntimeItemSchema.safeParse({
        ...item,
        diagnostics: { ...diagnostics, awaitingHistoricalProtection: flag },
      }).success,
    ).toBe(false);
  });
});
