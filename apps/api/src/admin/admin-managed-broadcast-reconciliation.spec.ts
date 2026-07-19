import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  type ManagedBroadcast,
  type ManagedBroadcastDelivery,
} from '../prisma/prisma-client';
import {
  buildManagedBroadcastDeliveryActionKey,
  createManagedBroadcastDeliverySnapshot,
  isAmbiguousManagedBroadcastSendError,
  isManagedBroadcastAutoRetryableDeliveryFailureMessage,
  markManagedBroadcastSendPhase,
  isManagedBroadcastTransientDeliveryFailureMessage,
} from './admin-managed-broadcast-reconciliation';
import { MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX } from './admin.service.support';

describe('admin managed broadcast reconciliation', () => {
  it('keeps ambiguous send markers out of ordinary automatic retries', () => {
    const ambiguous = 'Прошлая попытка была прервана после старта отправки. Проверьте чат.';
    expect(isManagedBroadcastTransientDeliveryFailureMessage(ambiguous)).toBe(true);
    expect(isManagedBroadcastAutoRetryableDeliveryFailureMessage(ambiguous)).toBe(false);
    expect(isManagedBroadcastAutoRetryableDeliveryFailureMessage('MAX timeout')).toBe(true);
  });

  it('requires the send-start marker before treating a timeout as ambiguous', () => {
    const timeout = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(markManagedBroadcastSendPhase(timeout, false)).toMatchObject({
      managedBroadcastSendStarted: false,
    });
    expect(isAmbiguousManagedBroadcastSendError(timeout)).toBe(false);
    expect(markManagedBroadcastSendPhase(timeout, true)).toMatchObject({
      managedBroadcastSendStarted: true,
    });
    expect(isAmbiguousManagedBroadcastSendError(timeout)).toBe(true);
  });

  it('classifies quarantined, permanent and ambiguous delivery states in snapshots', () => {
    const row = {
      status: ManagedBroadcastStatus.PARTIAL,
      sentCount: 0,
      cycleCount: 1,
    } as ManagedBroadcast;
    const delivery = (status: ManagedBroadcastDeliveryStatus, lastError: string) =>
      ({ status, lastError }) as ManagedBroadcastDelivery;
    const snapshot = createManagedBroadcastDeliverySnapshot(row, [
      delivery(
        ManagedBroadcastDeliveryStatus.CANCELED,
        `${MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX}: 3 проблемных слота подряд.`,
      ),
      delivery(ManagedBroadcastDeliveryStatus.CANCELED, 'chat.not.found'),
      delivery(
        ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        'Прошлая попытка была прервана после старта отправки.',
      ),
      delivery(ManagedBroadcastDeliveryStatus.FAILED, 'MAX timeout'),
    ]);
    expect(snapshot.failureBreakdown).toEqual({
      transient: 2,
      permanentTarget: 1,
      quarantined: 1,
      unknown: 0,
    });
    expect(snapshot.canRetry).toBe(true);
  });

  it('keys publication sends by the recorded content revision', () => {
    const base = {
      id: 'broadcast-1',
      publicationContentRevisionId: 'revision-7',
    } as ManagedBroadcast;
    expect(buildManagedBroadcastDeliveryActionKey(base, 2, 'chat-9')).toBe(
      'managed-broadcast:send:broadcast-1:occurrence:2:target:chat-9:content:publication-revision-7',
    );
  });
});
