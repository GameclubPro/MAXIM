import { ChatEntityType } from '../prisma/prisma-client';
import { SafetyDeskService } from './safety-desk.service';

function createReviewPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    sourceId: 'source-1',
    chatId: 'channel-1',
    vkOwnerId: -36819802,
    vkPostId: 101,
    vkPublishedAt: new Date('2026-06-27T10:00:00.000Z'),
    text: 'Проверяем публикацию\nhttps://example.com/post',
    url: 'https://vk.ru/wall-36819802_101',
    photoUrls: ['https://cdn.example.com/photo.jpg'],
    linkUrls: ['https://example.com/post'],
    attachments: [],
    attachmentTypes: ['photo'],
    unsupportedAttachments: [],
    hasUnsupportedAttachments: false,
    isAdvertising: false,
    advertisingMarkers: [],
    raw: {},
    contentHash: 'content-hash',
    publishedContentHash: null,
    status: 'NEW',
    publishedMessageId: null,
    publishedUrl: null,
    publishedAtMax: null,
    autoPublishedAt: null,
    autoPublishError: null,
    skippedAt: null,
    skipReason: null,
    lastSeenAt: new Date('2026-06-27T10:00:00.000Z'),
    missingSinceAt: null,
    missingSeenCount: 0,
    lastAvailabilityCheckedAt: null,
    unavailableAt: null,
    publishQueuedAt: null,
    publishScheduledAt: null,
    publishCancelledAt: null,
    publishCancelledByUserId: null,
    publishLockedAt: null,
    publishAttemptCount: 0,
    publishIdempotencyKey: null,
    publishReason: null,
    lastError: null,
    createdAt: new Date('2026-06-27T10:00:00.000Z'),
    updatedAt: new Date('2026-06-27T10:05:00.000Z'),
    chat: {
      title: 'Канал администраторов',
      entityType: ChatEntityType.CHANNEL,
    },
    source: {
      id: 'source-1',
      title: 'Источник MAXIM',
      url: 'https://vk.ru/source',
      status: 'ACTIVE',
      publishMode: 'REVIEW',
    },
    ...overrides,
  };
}

function createFixture() {
  const prisma = {
    vkParsingPost: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };
  const vkPublishService = {
    publishPost: jest.fn().mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
      post: {},
    }),
  };
  const service = new SafetyDeskService(prisma as never, vkPublishService as never);

  return { prisma, service, vkPublishService };
}

describe('SafetyDeskService', () => {
  it('builds a visible review queue from real VK review posts', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([createReviewPost()]);

    const queue = await service.getQueue();

    expect(queue.summary.review).toBe(1);
    expect(queue.items[0]).toMatchObject({
      id: 'post-1',
      source: 'VK_REVIEW',
      entityTitle: 'Канал: Канал администраторов',
      author: 'Источник MAXIM',
      text: expect.stringContaining('Проверяем публикацию'),
      domains: ['example.com', 'vk.ru'],
      photoUrls: ['https://cdn.example.com/photo.jpg'],
      status: 'REVIEW',
    });
    expect(queue.items[0]?.checks.map((check) => check.label)).toContain(
      'До решения владельца в MAX ничего не отправляется',
    );
  });

  it('approves a review item through the VK publish path and records audit', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const post = createReviewPost();
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    const result = await service.approveItem('post-1', 'maxim', {});

    expect(vkPublishService.publishPost).toHaveBeenCalledWith('channel-1', 'post-1', 'safety-desk-owner', {
      text: post.text,
      photoUrls: ['https://cdn.example.com/photo.jpg'],
      linkUrls: ['https://example.com/post'],
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'channel-1',
          actorUserId: 'maxim',
          action: 'SAFETY_DESK_APPROVE',
        }),
      }),
    );
    expect(result.message).toContain('опубликован');
  });

  it('rejects a review item without sending anything to MAX', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(createReviewPost());
    prisma.vkParsingPost.update.mockResolvedValue(createReviewPost({ publishCancelledAt: new Date() }));

    const result = await service.rejectItem('post-1', 'maxim', {});

    expect(vkPublishService.publishPost).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.update).toHaveBeenCalledWith({
      where: { id: 'post-1' },
      data: expect.objectContaining({
        publishCancelledAt: expect.any(Date),
        publishCancelledByUserId: 'maxim',
        publishIdempotencyKey: null,
      }),
    });
    expect(result.message).toContain('ничего не отправлено');
  });
});
