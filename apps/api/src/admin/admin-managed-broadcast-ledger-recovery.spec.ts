import {
  ManagedBroadcastDeliveryStatus,
  PublicationDispatchProfile,
  type ManagedBroadcast,
} from '../prisma/prisma-client';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import {
  buildManagedBroadcastLedgerRecoveryActionKeys,
  classifyManagedBroadcastLedgerRecovery,
  collectManagedBroadcastLedgerRecoveryActionKeys,
  PUBLIK_LEDGER_DISPATCH_MARKER,
  type ManagedBroadcastLedgerRecoveryRow,
} from './admin-managed-broadcast-ledger-recovery';

const broadcast = {
  id: 'broadcast-1',
  publicationContentRevisionId: 'revision-7',
  dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
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

  it('keeps a stale LEGACY_ROUTED claim without ledger evidence pending', async () => {
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
        lastErrorCode: null,
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

  async function reconcilePublikDelivery(options: {
    lastErrorCode: string | null;
    ledgerOverrides?: Partial<ManagedBroadcastLedgerRecoveryRow>;
  }) {
    const lockedAt = new Date('2026-09-01T10:00:00.000Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const publikBroadcast = {
      ...broadcast,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
    } as ManagedBroadcast;
    const actionKey = buildManagedBroadcastLedgerRecoveryActionKeys(
      publikBroadcast,
      1,
      'chat-9',
      1,
    ).currentKey;
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          findUnique: jest.fn().mockResolvedValue(publikBroadcast),
        },
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'publik-delivery-1',
              targetChatId: 'chat-9',
              botId: 'publisher-bot',
              attemptCount: 1,
              lockedAt,
              lockToken: 'stale-publik-lock',
              lastErrorCode: options.lastErrorCode,
            },
          ]),
          updateMany,
        },
        maxActionLedgerEntry: {
          findMany: jest
            .fn()
            .mockResolvedValue(
              options.ledgerOverrides ? [ledger(actionKey, options.ledgerOverrides)] : [],
            ),
        },
      },
      maxRoutedPublicationService: {},
    } as never);

    await (runtime as any).reconcileStaleManagedBroadcastDeliveries(
      publikBroadcast.id,
      1,
      new Date('2026-09-01T10:05:00.000Z'),
    );

    return { lockedAt, updateMany };
  }

  it('releases a marked Publik claim with no ledger evidence back to pending', async () => {
    const { lockedAt, updateMany } = await reconcilePublikDelivery({
      lastErrorCode: PUBLIK_LEDGER_DISPATCH_MARKER,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: ManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
        OR: [
          {
            id: 'publik-delivery-1',
            attemptCount: 1,
            lockedAt,
            lockToken: 'stale-publik-lock',
          },
        ],
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.PENDING,
        attemptCount: { decrement: 1 },
        lockedAt: null,
        lockToken: null,
        lastErrorCode: null,
        lastError: null,
      },
    });
  });

  it('quarantines a marked Publik claim whose ledger has a dispatch fence', async () => {
    const { updateMany } = await reconcilePublikDelivery({
      lastErrorCode: PUBLIK_LEDGER_DISPATCH_MARKER,
      ledgerOverrides: {
        dispatchToken: 'dispatch-token-1',
        dispatchStartedAt: new Date('2026-09-01T10:00:01.000Z'),
        dispatchBotId: 'publisher-bot',
        lastAttemptAt: new Date('2026-09-01T10:00:00.500Z'),
      },
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['publik-delivery-1'] },
        status: ManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        lockedAt: null,
        lockToken: null,
        lastErrorCode: null,
        lastError:
          'Прошлая попытка была прервана после старта отправки. Проверьте чат вручную перед повтором.',
      },
    });
  });

  it('recovers a marked completed Publik ledger result as sent', async () => {
    const completedAt = new Date('2026-09-01T10:00:02.000Z');
    const { updateMany } = await reconcilePublikDelivery({
      lastErrorCode: PUBLIK_LEDGER_DISPATCH_MARKER,
      ledgerOverrides: {
        remoteMessageId: 'mid-publik-1',
        dispatchToken: 'dispatch-token-1',
        dispatchStartedAt: new Date('2026-09-01T10:00:01.000Z'),
        dispatchBotId: 'publisher-bot',
        lastAttemptAt: new Date('2026-09-01T10:00:00.500Z'),
        completedAt,
        terminal: true,
      },
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'publik-delivery-1' }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.SENT,
          botId: 'publisher-bot',
          remoteMessageId: 'mid-publik-1',
          sentAt: completedAt,
          lastErrorCode: null,
        }),
      }),
    );
  });

  it('clears the rollout marker when a marked pre-dispatch ledger failure is terminal', async () => {
    const { updateMany } = await reconcilePublikDelivery({
      lastErrorCode: PUBLIK_LEDGER_DISPATCH_MARKER,
      ledgerOverrides: {
        lastAttemptAt: new Date('2026-09-01T10:00:00.500Z'),
        terminal: true,
        lastError: 'MAX rejected the prepared send before dispatch',
      },
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'publik-delivery-1',
        status: ManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.FAILED,
        botId: 'publisher-bot',
        lockedAt: null,
        lockToken: null,
        lastErrorCode: null,
        lastError: 'MAX rejected the prepared send before dispatch',
      },
    });
  });

  it('quarantines an unmarked pre-ledger Publik claim during rollout', async () => {
    const { updateMany } = await reconcilePublikDelivery({ lastErrorCode: null });

    expect(
      updateMany.mock.calls.some(
        ([query]) => query.data?.status === ManagedBroadcastDeliveryStatus.PENDING,
      ),
    ).toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['publik-delivery-1'] },
        status: ManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        lockedAt: null,
        lockToken: null,
        lastErrorCode: null,
        lastError:
          'Прошлая попытка была прервана после старта отправки. Проверьте чат вручную перед повтором.',
      },
    });
  });
});
