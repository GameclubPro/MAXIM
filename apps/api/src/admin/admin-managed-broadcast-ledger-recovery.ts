import {
  ManagedBroadcastDeliveryStatus,
  Prisma,
  PublicationDispatchProfile,
  type ManagedBroadcast as PersistedManagedBroadcast,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AdminManagedBroadcastMessageRuntime } from './admin-managed-broadcast-message-runtime';
import { readManagedBroadcastLedgerCommentDialogContext } from './admin-managed-broadcast-ledger';
import { buildManagedBroadcastDeliveryActionKey } from './admin-managed-broadcast-reconciliation';
import { buildPublicationDeliveryVerificationScheduledData } from './publication-delivery-verification-state';

export const PUBLIK_LEDGER_DISPATCH_MARKER = 'PUBLIK_LEDGER_DISPATCH_V1';

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
    lastErrorCode: null;
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
              lastErrorCode: null,
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

export async function reconcileRoutedManagedBroadcastSendingDeliveries(options: {
  prisma: PrismaService;
  messageRuntime: Pick<AdminManagedBroadcastMessageRuntime, 'recordDialogReference'>;
  broadcastId: string;
  occurrenceIndex: number;
  extraWhere?: Prisma.ManagedBroadcastDeliveryWhereInput;
}): Promise<void> {
  const { prisma, messageRuntime, broadcastId, occurrenceIndex, extraWhere } = options;
  const broadcast = await prisma.managedBroadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast) return;

  const deliveries = await prisma.managedBroadcastDelivery.findMany({
    where: {
      broadcastId,
      occurrenceIndex,
      status: ManagedBroadcastDeliveryStatus.SENDING,
      remoteMessageId: null,
      ...(extraWhere ?? {}),
    },
    select: {
      id: true,
      targetChatId: true,
      botId: true,
      attemptCount: true,
      lockedAt: true,
      lockToken: true,
      lastErrorCode: true,
    },
  });
  if (deliveries.length === 0) return;

  const actionKeysByDeliveryId = new Map(
    deliveries.map((delivery) => [
      delivery.id,
      buildManagedBroadcastLedgerRecoveryActionKeys(
        broadcast,
        occurrenceIndex,
        delivery.targetChatId,
        delivery.attemptCount,
      ),
    ]),
  );
  const actionKeys = collectManagedBroadcastLedgerRecoveryActionKeys(
    actionKeysByDeliveryId.values(),
  );
  const ledgerRows = await prisma.maxActionLedgerEntry.findMany({
    where: { jobId: { in: actionKeys } },
    select: {
      jobId: true,
      remoteMessageId: true,
      dispatchToken: true,
      dispatchStartedAt: true,
      dispatchBotId: true,
      lastAttemptAt: true,
      ambiguous: true,
      terminal: true,
      lastError: true,
      completedAt: true,
      metadata: true,
    },
  });
  const ledgerByJobId = new Map(ledgerRows.map((ledger) => [ledger.jobId, ledger]));
  const pendingDeliveries: Array<(typeof deliveries)[number]> = [];
  const ambiguousDeliveryIds: string[] = [];
  const failedDeliveries: Array<{
    deliveryId: string;
    botId: string | null;
    lastError: string;
  }> = [];
  const completedDeliveries: Array<{
    delivery: (typeof deliveries)[number];
    ledger: (typeof ledgerRows)[number];
  }> = [];
  const isPublikExecution = broadcast.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1;

  for (const delivery of deliveries) {
    if (isPublikExecution && delivery.lastErrorCode !== PUBLIK_LEDGER_DISPATCH_MARKER) {
      ambiguousDeliveryIds.push(delivery.id);
      continue;
    }
    const recovery = classifyManagedBroadcastLedgerRecovery(
      actionKeysByDeliveryId.get(delivery.id)!,
      ledgerByJobId,
      { legacyEligibleAfter: delivery.lockedAt },
    );
    if (recovery.kind === 'ambiguous') {
      ambiguousDeliveryIds.push(delivery.id);
    } else if (recovery.kind === 'completed') {
      completedDeliveries.push({ delivery, ledger: recovery.ledger });
    } else if (recovery.kind === 'pending') {
      pendingDeliveries.push(delivery);
    } else {
      failedDeliveries.push({
        deliveryId: delivery.id,
        botId: recovery.ledger.dispatchBotId ?? delivery.botId ?? null,
        lastError:
          recovery.ledger.lastError?.trim() ||
          'Отправка завершилась до обращения к MAX и требует ручного повтора.',
      });
    }
  }

  for (const { delivery, ledger } of completedDeliveries) {
    const sentAt = ledger.completedAt ?? new Date();
    const reconciled = await prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: delivery.id,
        status: ManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.SENT,
        botId: ledger.dispatchBotId ?? delivery.botId ?? null,
        remoteMessageId: ledger.remoteMessageId,
        sentAt,
        ...buildPublicationDeliveryVerificationScheduledData(sentAt),
        legacySentWithoutRemoteId: false,
        lockedAt: null,
        lockToken: null,
        lastErrorCode: null,
        lastError: null,
      },
    });
    if (reconciled.count === 0) continue;

    const recoveredContext = readManagedBroadcastLedgerCommentDialogContext(ledger.metadata);
    if (recoveredContext.found) {
      await messageRuntime.recordDialogReference({
        chatId: delivery.targetChatId,
        actorUserId: broadcast.actorUserId,
        messageId: ledger.remoteMessageId,
        text: broadcast.text,
        reference: recoveredContext.reference,
        source: 'ledger_recovery',
        broadcastId,
        occurrenceIndex,
      });
    }
  }

  for (const recoveryUpdate of buildManagedBroadcastPendingDeliveryRecoveryUpdates(
    pendingDeliveries,
  )) {
    await prisma.managedBroadcastDelivery.updateMany({
      where: {
        status: ManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
        ...recoveryUpdate.where,
      },
      data: { status: ManagedBroadcastDeliveryStatus.PENDING, ...recoveryUpdate.data },
    });
  }
  for (const failedDelivery of failedDeliveries) {
    await prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: failedDelivery.deliveryId,
        status: ManagedBroadcastDeliveryStatus.SENDING,
        remoteMessageId: null,
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.FAILED,
        botId: failedDelivery.botId,
        lockedAt: null,
        lockToken: null,
        lastErrorCode: null,
        lastError: failedDelivery.lastError,
      },
    });
  }
  if (ambiguousDeliveryIds.length > 0) {
    await prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: { in: ambiguousDeliveryIds },
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
  }
}
