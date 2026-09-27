import { ConfigService } from '@nestjs/config';
import {
  PublisherCommentNotificationService,
  resolvePublisherCommentNotificationSettings,
} from './publisher-comment-notification.service';
import { publisherNotificationFailure } from './publisher-comment-notification-delivery.service';
import type { DialogNotificationMode } from '../prisma/prisma-client';

const target = { entityType: 'channel' as const, chatId: 'channel-1', threadId: 'post-1' };

describe('Publisher comment notification preferences', () => {
  it.each(['OFF', 'REPLIES', 'ALL'] as const)(
    'keeps explicit thread %s above entity and global choices',
    (mode) => {
      expect(
        resolvePublisherCommentNotificationSettings(
          [
            { chatId: target.chatId, threadId: target.threadId, mode, explicit: true },
            { chatId: target.chatId, threadId: '', mode: 'ALL', explicit: true },
            { chatId: '', threadId: '', mode: 'ALL', explicit: true },
          ],
          target,
        ),
      ).toMatchObject({ mode: mode.toLowerCase(), scope: 'thread' });
    },
  );

  it.each(['OFF', 'REPLIES', 'ALL'] as const)(
    'lets entity %s override an implicit reply subscription',
    (mode) => {
      expect(
        resolvePublisherCommentNotificationSettings(
          [
            { chatId: target.chatId, threadId: target.threadId, mode: 'REPLIES', explicit: false },
            { chatId: target.chatId, threadId: '', mode, explicit: true },
            { chatId: '', threadId: '', mode: 'ALL', explicit: true },
          ],
          target,
        ),
      ).toMatchObject({ mode: mode.toLowerCase(), scope: 'channel' });
    },
  );

  it('keeps an implicit reply subscription as the fallback', () => {
    expect(
      resolvePublisherCommentNotificationSettings(
        [{ ...target, mode: 'REPLIES', explicit: false }],
        target,
      ),
    ).toMatchObject({ mode: 'replies', scope: 'thread' });
    expect(resolvePublisherCommentNotificationSettings([], target)).toMatchObject({
      mode: 'off',
      scope: 'thread',
    });
  });

  it('requires exact Publisher access for global preferences but not for a signed thread subscription', async () => {
    let rows = [
      { chatId: '', threadId: '', mode: 'ALL' as DialogNotificationMode, explicit: true },
    ];
    const prisma = {
      publisherCommentNotificationPreference: { findMany: jest.fn(async () => rows) },
      managedEntityAccessEdge: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new PublisherCommentNotificationService(
      prisma as never,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: 'publisher-test' }),
      {} as never,
    );
    expect(await service.canReceive(target, 'user-1', false)).toBe(false);
    expect(prisma.publisherCommentNotificationPreference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: 'publisher-test',
          userId: 'user-1',
          entityType: 'CHANNEL',
        }),
      }),
    );
    expect(prisma.managedEntityAccessEdge.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: target.chatId,
        botId: 'publisher-test',
        userId: 'user-1',
        state: 'GRANTED',
        chat: expect.anything(),
      }),
    });
    prisma.managedEntityAccessEdge.count.mockResolvedValue(1);
    expect(await service.canReceive(target, 'user-1', false)).toBe(true);
    rows = [{ chatId: target.chatId, threadId: target.threadId, mode: 'REPLIES', explicit: true }];
    prisma.managedEntityAccessEdge.count.mockClear();
    expect(await service.canReceive(target, 'user-1', false)).toBe(false);
    expect(await service.canReceive(target, 'user-1', true)).toBe(true);
    expect(prisma.managedEntityAccessEdge.count).not.toHaveBeenCalled();
  });

  it.each([
    [429, true, 'PENDING'],
    [403, true, 'FAILED'],
    [404, true, 'FAILED'],
    [500, true, 'UNKNOWN'],
    [504, true, 'UNKNOWN'],
    [408, true, 'UNKNOWN'],
    [500, false, 'PENDING'],
  ] as const)('classifies HTTP %s after attempted=%s as %s', (status, attempted, expected) => {
    expect(publisherNotificationFailure({ response: { status } }, attempted)).toBe(expected);
  });

  it('retries a pre-send outage but fences an attempted timeout', () => {
    expect(publisherNotificationFailure(new Error('timeout'), false)).toBe('PENDING');
    expect(publisherNotificationFailure(new Error('timeout'), true)).toBe('UNKNOWN');
  });
});
