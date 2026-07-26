import { ManagedBroadcastDeliveryStatus, type ManagedBroadcast } from '../prisma/prisma-client';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import {
  buildManagedBroadcastLedgerRecoveryActionKeys,
  classifyManagedBroadcastLedgerRecovery,
  collectManagedBroadcastLedgerRecoveryActionKeys,
  type ManagedBroadcastLedgerRecoveryRow,
} from './admin-managed-broadcast-ledger-recovery';

const broadcast = {
  id: 'broadcast-1',
  publicationContentRevisionId: 'revision-7',
} as ManagedBroadcast;

function ledger(
  jobId: string,
  overrides: Partial<ManagedBroadcastLedgerRecoveryRow> = {},
): ManagedBroadcastLedgerRecoveryRow {
  return {
    jobId,
    remoteMessageId: null,
    dispatchToken: null,
    dispatchStartedAt: null,
    dispatchBotId: null,
    lastAttemptAt: null,
    completedAt: null,
    ambiguous: false,
    terminal: false,
    lastError: null,
    ...overrides,
  };
}

describe('managed broadcast ledger rollout recovery', () => {
  it('queries the attempt-scoped and pre-deploy base keys for retried deliveries', () => {
    const keys = buildManagedBroadcastLedgerRecoveryActionKeys(broadcast, 2, 'chat-9', 2);

    expect(keys).toEqual({
      currentKey:
        'managed-broadcast:send:broadcast-1:occurrence:2:target:chat-9:content:publication-revision-7:attempt:2',
      legacyKey:
        'managed-broadcast:send:broadcast-1:occurrence:2:target:chat-9:content:publication-revision-7',
    });
    expect(collectManagedBroadcastLedgerRecoveryActionKeys([keys])).toEqual([
      keys.currentKey,
      keys.legacyKey,
    ]);
  });

  it('recovers a retry completed under the pre-deploy base key', () => {
    const keys = buildManagedBroadcastLedgerRecoveryActionKeys(broadcast, 2, 'chat-9', 2);
    const legacyLedger = ledger(keys.legacyKey, {
      remoteMessageId: 'mid-legacy-retry',
      dispatchToken: 'legacy-dispatch',
      dispatchStartedAt: new Date('2026-07-26T20:00:00.000Z'),
      dispatchBotId: 'bot-1',
      terminal: true,
    });

    expect(
      classifyManagedBroadcastLedgerRecovery(keys, new Map([[keys.legacyKey, legacyLedger]]), {
        legacyEligibleAfter: new Date('2026-07-26T19:59:59.000Z'),
      }),
    ).toEqual({ kind: 'completed', ledger: legacyLedger });
  });

  it('ignores a base-key result from an older attempt', () => {
    const keys = buildManagedBroadcastLedgerRecoveryActionKeys(broadcast, 2, 'chat-9', 2);
    const staleLedger = ledger(keys.legacyKey, {
      remoteMessageId: 'mid-first-attempt',
      terminal: true,
    });

    expect(
      classifyManagedBroadcastLedgerRecovery(keys, new Map([[keys.legacyKey, staleLedger]]), {
        legacyEligibleAfter: new Date('2026-07-26T20:00:01.000Z'),
      }),
    ).toEqual({ kind: 'pending' });
  });

  it('ignores a base-key row whose generic update moved after the new delivery claim', () => {
    const keys = buildManagedBroadcastLedgerRecoveryActionKeys(broadcast, 2, 'chat-9', 2);
    const staleLedger = ledger(keys.legacyKey, {
      remoteMessageId: 'mid-first-attempt',
      completedAt: new Date('2026-07-26T19:59:00.000Z'),
      terminal: true,
    });
    const watchdogUpdatedLedger = {
      ...staleLedger,
      updatedAt: new Date('2026-07-26T20:01:00.000Z'),
    };

    expect(
      classifyManagedBroadcastLedgerRecovery(
        keys,
        new Map([[keys.legacyKey, watchdogUpdatedLedger]]),
        { legacyEligibleAfter: new Date('2026-07-26T20:00:00.000Z') },
      ),
    ).toEqual({ kind: 'pending' });
  });

  it('keeps the attempt-scoped ledger authoritative over an older base-key result', () => {
    const keys = buildManagedBroadcastLedgerRecoveryActionKeys(broadcast, 2, 'chat-9', 2);
    const ledgers = new Map([
      [keys.currentKey, ledger(keys.currentKey, { remoteMessageId: 'mid-current' })],
      [keys.legacyKey, ledger(keys.legacyKey, { remoteMessageId: 'mid-legacy' })],
    ]);

    expect(
      classifyManagedBroadcastLedgerRecovery(keys, ledgers, {
        legacyEligibleAfter: new Date('2026-07-26T19:59:59.000Z'),
      }),
    ).toEqual({ kind: 'completed', ledger: ledgers.get(keys.currentKey) });
  });

  it('keeps a live pre-dispatch legacy base-key claim quarantined', () => {
    const keys = buildManagedBroadcastLedgerRecoveryActionKeys(broadcast, 2, 'chat-9', 2);
    const lockedAt = new Date('2026-07-26T20:00:00.000Z');
    const legacyLedger = ledger(keys.legacyKey, {
      lastAttemptAt: new Date('2026-07-26T20:00:01.000Z'),
    });

    expect(
      classifyManagedBroadcastLedgerRecovery(keys, new Map([[keys.legacyKey, legacyLedger]]), {
        legacyEligibleAfter: lockedAt,
      }),
    ).toEqual({ kind: 'ambiguous' });
  });

  it('rolls back a stale pre-dispatch claim so the next worker reuses its action key', async () => {
    const lockedAt = new Date('2026-07-26T20:00:00.000Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          findUnique: jest.fn().mockResolvedValue(broadcast),
        },
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-1',
              targetChatId: 'chat-9',
              botId: 'bot-1',
              attemptCount: 2,
              lockedAt,
              lockToken: 'stale-lock-2',
            },
          ]),
          updateMany,
        },
        maxActionLedgerEntry: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      maxRoutedPublicationService: {},
    } as never);

    await (runtime as any).reconcileRoutedManagedBroadcastSendingDeliveries(broadcast.id, 2);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: ManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
        OR: [
          {
            id: 'delivery-1',
            attemptCount: 2,
            lockedAt,
            lockToken: 'stale-lock-2',
          },
        ],
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.PENDING,
        attemptCount: { decrement: 1 },
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
    const interruptedAttemptKey = buildManagedBroadcastLedgerRecoveryActionKeys(
      broadcast,
      2,
      'chat-9',
      2,
    ).currentKey;
    const rolledBackAttemptCount = 1;
    const nextClaimKey = buildManagedBroadcastLedgerRecoveryActionKeys(
      broadcast,
      2,
      'chat-9',
      rolledBackAttemptCount + 1,
    ).currentKey;
    expect(nextClaimKey).toBe(interruptedAttemptKey);
  });
});
