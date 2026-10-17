import { buildPublicationDeliveryActionKey } from './publication-delivery-action-key';
import { buildManagedBroadcastDeliveryActionKey } from './admin-managed-broadcast-reconciliation';
import { buildManagedBroadcastLedgerRecoveryActionKeys } from './admin-managed-broadcast-ledger-recovery';
import type { ManagedBroadcast } from '../prisma/prisma-client';

describe('Narrow publication delivery action identity', () => {
  it.each([0, 1, 2, 19])(
    'preserves current and legacy action bytes for attempt %s',
    (attemptCount) => {
      const row: ManagedBroadcast = {
        id: 'broadcast',
        publicationContentRevisionId: 'saved-revision',
        publicationOccurrenceId: 'saved-occurrence',
        sourceChatId: 'source',
        entityType: 'CHAT',
        actorUserId: 'actor',
        text: '',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-9'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        mediaType: null,
        mediaPayload: null,
        mediaMimeType: '',
        mediaFileName: '',
        scheduleMode: 'now',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
        lockToken: null,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher',
        createdAt: new Date('2026-10-16T18:00:00Z'),
        updatedAt: new Date('2026-10-16T18:00:00Z'),
      };
      const narrow = buildPublicationDeliveryActionKey({
        broadcastId: row.id,
        occurrenceIndex: 2,
        targetChatId: 'chat-9',
        contentRevisionId: 'saved-revision',
        attemptCount,
      });
      const base =
        'managed-broadcast:send:broadcast:occurrence:2:target:chat-9:content:publication-saved-revision';
      expect(narrow).toBe(attemptCount <= 1 ? base : `${base}:attempt:${attemptCount}`);
      expect(buildManagedBroadcastDeliveryActionKey(row, 2, 'chat-9', attemptCount)).toBe(narrow);
      expect(buildManagedBroadcastLedgerRecoveryActionKeys(row, 2, 'chat-9', attemptCount)).toEqual(
        { currentKey: narrow, legacyKey: base },
      );
    },
  );
});
