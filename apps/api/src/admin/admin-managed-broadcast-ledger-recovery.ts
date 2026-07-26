import type { ManagedBroadcast as PersistedManagedBroadcast } from '../prisma/prisma-client';
import { buildManagedBroadcastDeliveryActionKey } from './admin-managed-broadcast-reconciliation';

export type ManagedBroadcastLedgerRecoveryActionKeys = {
  currentKey: string;
  legacyKey: string;
};

export type ManagedBroadcastLedgerRecoveryRow = {
  jobId: string;
  remoteMessageId: string | null;
  dispatchToken: string | null;
  dispatchStartedAt: Date | null;
  dispatchBotId: string | null;
  lastAttemptAt: Date | null;
  completedAt: Date | null;
  ambiguous: boolean;
  terminal: boolean;
  lastError: string | null;
};

export type ManagedBroadcastPendingDeliveryRecoveryClaim = {
  id: string;
  attemptCount: number;
  lockedAt: Date | null;
  lockToken: string | null;
};

export type ManagedBroadcastPendingDeliveryRecoveryUpdate = {
  where: {
    OR: ManagedBroadcastPendingDeliveryRecoveryClaim[];
  };
  data: {
    attemptCount?: { decrement: number };
    lockedAt: null;
    lockToken: null;
    lastError: null;
  };
};

export type ManagedBroadcastLedgerRecoveryDecision<T> =
  | { kind: 'completed'; ledger: T }
  | { kind: 'ambiguous' }
  | { kind: 'failed'; ledger: T }
  | { kind: 'pending' };

export function buildManagedBroadcastLedgerRecoveryActionKeys(
  row: PersistedManagedBroadcast,
  occurrenceIndex: number,
  targetChatId: string,
  attemptCount: number,
): ManagedBroadcastLedgerRecoveryActionKeys {
  const currentKey = buildManagedBroadcastDeliveryActionKey(
    row,
    occurrenceIndex,
    targetChatId,
    attemptCount,
  );
  return {
    currentKey,
    legacyKey:
      attemptCount > 1
        ? buildManagedBroadcastDeliveryActionKey(row, occurrenceIndex, targetChatId)
        : currentKey,
  };
}

export function collectManagedBroadcastLedgerRecoveryActionKeys(
  keys: Iterable<ManagedBroadcastLedgerRecoveryActionKeys>,
): string[] {
  return [...new Set([...keys].flatMap(({ currentKey, legacyKey }) => [currentKey, legacyKey]))];
}

export function buildManagedBroadcastPendingDeliveryRecoveryUpdates(
  deliveries: readonly ManagedBroadcastPendingDeliveryRecoveryClaim[],
): ManagedBroadcastPendingDeliveryRecoveryUpdate[] {
  // FLAG: A recovered pre-dispatch claim must reuse its interrupted action key. Claims with an
  // impossible zero attempt count are released without decrementing below zero.
  return [
    { rows: deliveries.filter((delivery) => delivery.attemptCount > 0), decrement: true },
    { rows: deliveries.filter((delivery) => delivery.attemptCount <= 0), decrement: false },
  ].flatMap(({ rows, decrement }) =>
    rows.length === 0
      ? []
      : [
          {
            where: {
              OR: rows.map(({ id, attemptCount, lockedAt, lockToken }) => ({
                id,
                attemptCount,
                lockedAt,
                lockToken,
              })),
            },
            data: {
              ...(decrement ? { attemptCount: { decrement: 1 } } : {}),
              lockedAt: null,
              lockToken: null,
              lastError: null,
            },
          },
        ],
  );
}

export function classifyManagedBroadcastLedgerRecovery<T extends ManagedBroadcastLedgerRecoveryRow>(
  actionKeys: ManagedBroadcastLedgerRecoveryActionKeys,
  ledgerByJobId: ReadonlyMap<string, T>,
  options: { legacyEligibleAfter: Date | null },
): ManagedBroadcastLedgerRecoveryDecision<T> {
  const currentLedger = ledgerByJobId.get(actionKeys.currentKey);
  const legacyCandidate =
    currentLedger || actionKeys.legacyKey === actionKeys.currentKey
      ? undefined
      : ledgerByJobId.get(actionKeys.legacyKey);
  if (legacyCandidate && !options.legacyEligibleAfter) {
    return { kind: 'ambiguous' };
  }
  const legacyActivityAt = legacyCandidate
    ? Math.max(
        legacyCandidate.lastAttemptAt?.getTime() ?? Number.NEGATIVE_INFINITY,
        legacyCandidate.dispatchStartedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
        legacyCandidate.completedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
      )
    : Number.NEGATIVE_INFINITY;
  const legacyLedger =
    legacyCandidate &&
    options.legacyEligibleAfter &&
    legacyActivityAt >= options.legacyEligibleAfter.getTime()
      ? legacyCandidate
      : undefined;
  const candidates = [currentLedger ?? legacyLedger].filter(
    (ledger): ledger is T => ledger !== undefined,
  );
  const remoteMessageIds = new Set(
    candidates.flatMap((ledger) => (ledger.remoteMessageId ? [ledger.remoteMessageId] : [])),
  );
  const hasUnresolvedDispatch = candidates.some(
    (ledger) =>
      !ledger.remoteMessageId &&
      (ledger.ambiguous ||
        Boolean(ledger.dispatchToken) ||
        Boolean(ledger.dispatchStartedAt) ||
        Boolean(ledger.dispatchBotId)),
  );
  if (remoteMessageIds.size > 1 || (remoteMessageIds.size === 1 && hasUnresolvedDispatch)) {
    return { kind: 'ambiguous' };
  }

  const completedLedger =
    (currentLedger?.remoteMessageId ? currentLedger : undefined) ??
    (legacyLedger?.remoteMessageId ? legacyLedger : undefined);
  if (completedLedger) return { kind: 'completed', ledger: completedLedger };
  if (candidates.length === 0) return { kind: 'pending' };
  if (
    candidates.some(
      (ledger) =>
        ledger.ambiguous ||
        Boolean(ledger.dispatchToken) ||
        Boolean(ledger.dispatchStartedAt) ||
        Boolean(ledger.dispatchBotId),
    )
  ) {
    return { kind: 'ambiguous' };
  }

  const terminalLedger =
    (currentLedger?.terminal ? currentLedger : undefined) ??
    (legacyLedger?.terminal ? legacyLedger : undefined);
  if (terminalLedger) return { kind: 'failed', ledger: terminalLedger };

  // FLAG: A rollout-era worker can still resume under the base key. Releasing that delivery would
  // claim an attempt-scoped key and leave two independent dispatch fences alive.
  if (legacyLedger) return { kind: 'ambiguous' };
  return { kind: 'pending' };
}
