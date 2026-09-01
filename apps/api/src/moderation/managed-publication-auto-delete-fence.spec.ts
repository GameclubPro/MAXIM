import { ChatEntityType, ManagedBroadcastDeliveryStatus } from '../prisma/prisma-client';
import { MAX_SEND_FENCE_STALE_MS } from '../max/max-send-ambiguity.util';
import { buildManagedPublicationAutoDeleteFenceWhere } from './managed-publication-auto-delete-fence';

describe('managed publication auto-delete fence', () => {
  it('covers a live send claim and a source-correlated ambiguous post-dispatch outcome', () => {
    const now = new Date('2026-09-01T09:10:00.000Z');
    const sourceMessageAt = new Date('2026-09-01T09:00:00.000Z');

    expect(
      buildManagedPublicationAutoDeleteFenceWhere({
        targetChatId: 'chat-1',
        messageId: 'message-1',
        originBotId: 'bot-1',
        entityType: ChatEntityType.CHAT,
        sourceMessageAt,
        now,
      }),
    ).toEqual({
      targetChatId: 'chat-1',
      OR: [
        { remoteMessageId: 'message-1' },
        {
          botId: 'bot-1',
          remoteMessageId: null,
          broadcast: { is: { entityType: ChatEntityType.CHAT } },
          OR: [
            {
              status: ManagedBroadcastDeliveryStatus.SENDING,
              lockedAt: { gt: new Date(now.getTime() - MAX_SEND_FENCE_STALE_MS) },
            },
            {
              status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
              updatedAt: {
                gte: new Date(sourceMessageAt.getTime() - MAX_SEND_FENCE_STALE_MS),
                lte: new Date(sourceMessageAt.getTime() + MAX_SEND_FENCE_STALE_MS),
              },
            },
          ],
        },
      ],
    });
  });

  it('does not apply a generic ambiguous fence without a trusted source timestamp', () => {
    const where = buildManagedPublicationAutoDeleteFenceWhere({
      targetChatId: 'chat-1',
      messageId: 'message-1',
      originBotId: 'bot-1',
      entityType: ChatEntityType.CHAT,
      sourceMessageAt: 'invalid',
      now: new Date('2026-09-01T09:10:00.000Z'),
    });

    expect((where.OR?.[1] as { OR: unknown[] }).OR).toEqual([
      expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.SENDING }),
    ]);
  });
});
