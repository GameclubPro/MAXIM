import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import {
  MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
  MAX_SEND_ROUTE_QUARANTINE_MS,
  recordMaxSendRouteDisappearance,
  recordMaxSendRouteStableSuccess,
} from './max-send-route-health';

describe('MAX send route health', () => {
  const sentAt = new Date('2026-07-27T12:00:00.000Z');
  const observedAt = new Date('2026-07-27T12:05:00.000Z');

  it('quarantines only a failure newer than the latest route observation', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });

    await expect(
      recordMaxSendRouteDisappearance({ chatBotMembership: { updateMany } } as never, {
        chatId: 'chat-1',
        botId: 'bot-9',
        sentAt,
        observedAt,
      }),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        botId: 'bot-9',
        status: ChatBotMembershipStatus.ACTIVE,
        AND: [
          {
            OR: [{ sendRouteLastSuccessAt: null }, { sendRouteLastSuccessAt: { lt: sentAt } }],
          },
          {
            OR: [{ sendRouteLastFailureAt: null }, { sendRouteLastFailureAt: { lt: sentAt } }],
          },
        ],
      },
      data: {
        sendRouteFailureCount: { increment: 1 },
        sendRouteQuarantinedUntil: new Date(observedAt.getTime() + MAX_SEND_ROUTE_QUARANTINE_MS),
        sendRouteLastFailureAt: sentAt,
        sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
      },
    });
  });

  it('clears a penalty only for a success at least as new as the last failure', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });

    await expect(
      recordMaxSendRouteStableSuccess({ chatBotMembership: { updateMany } } as never, {
        chatId: 'chat-1',
        botId: 'bot-4',
        sentAt,
        observedAt,
      }),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              OR: [{ sendRouteLastSuccessAt: null }, { sendRouteLastSuccessAt: { lt: sentAt } }],
            },
            {
              OR: [{ sendRouteLastFailureAt: null }, { sendRouteLastFailureAt: { lte: sentAt } }],
            },
          ],
        }),
        data: {
          sendRouteFailureCount: 0,
          sendRouteQuarantinedUntil: null,
          sendRouteLastFailureCode: null,
          sendRouteLastSuccessAt: sentAt,
        },
      }),
    );
  });

  it('does not mutate route health without an exact bot route', async () => {
    const updateMany = jest.fn();

    await expect(
      recordMaxSendRouteDisappearance({ chatBotMembership: { updateMany } } as never, {
        chatId: 'chat-1',
        botId: null,
        sentAt,
        observedAt,
      }),
    ).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
