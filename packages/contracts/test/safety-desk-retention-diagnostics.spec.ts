import { describe, expect, it } from 'vitest';
import {
  safetyDeskRetentionRuntimeItemSchema,
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
