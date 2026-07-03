import { BadRequestException } from '@nestjs/common';
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
    videoUrls: [],
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
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
      domains: ['example.com'],
      photoUrls: ['https://cdn.example.com/photo.jpg'],
      videoUrls: [],
      status: 'REVIEW',
    });
    expect(queue.items[0]?.checks.map((check) => check.label)).toContain(
      'До решения владельца в MAX ничего не отправляется',
    );
  });

  it('treats VK and MAX links as trusted Safety Desk domains', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([
      createReviewPost({
        url: 'https://vk.com/wall-36819802_101',
        linkUrls: [
          'https://vk.ru/club1',
          'https://m.vk.com/wall-1_2',
          'https://max.ru/channel/team',
          'https://dev.max.ru/docs',
        ],
        photoUrls: [],
        videoUrls: [],
      }),
    ]);

    const queue = await service.getQueue();

    expect(queue.items[0]?.domains).toEqual([]);
    expect(queue.items[0]?.checks).toContainEqual({
      label: 'Внешних ссылок нет',
      state: 'PASSED',
    });
    expect(queue.items[0]?.risk).toBe('LOW');
  });

  it('keeps posts with unsupported attachments out of the owner review queue', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([
      createReviewPost({
        text: '',
        photoUrls: [],
        linkUrls: [],
        hasUnsupportedAttachments: true,
        unsupportedAttachments: [{ type: 'video', label: 'Видео', count: 1 }],
      }),
    ]);

    const queue = await service.getQueue();

    expect(queue.summary.review).toBe(0);
    expect(queue.summary.blocked).toBe(0);
    expect(queue.items).toEqual([]);
  });

  it('does not expose unsupported-only posts in the owner review queue', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([
      createReviewPost({
        id: 'post-video',
        text: '',
        photoUrls: [],
        linkUrls: [],
        hasUnsupportedAttachments: true,
        unsupportedAttachments: [{ type: 'video', label: 'Видео', count: 1 }],
      }),
      createReviewPost({ id: 'post-text', text: 'Можно проверить' }),
    ]);

    const queue = await service.getQueue();

    expect(queue.items.map((item) => item.id)).toEqual(['post-text']);
    expect(queue.summary.review).toBe(1);
    expect(queue.summary.blocked).toBe(0);
  });

  it('keeps posts with warnings approvable', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([createReviewPost({ isAdvertising: true })]);

    const queue = await service.getQueue();

    expect(queue.summary.review).toBe(1);
    expect(queue.summary.blocked).toBe(0);
    expect(queue.items[0]).toMatchObject({
      status: 'REVIEW',
      risk: 'HIGH',
    });
  });

  it('approves a review item through the VK publish path and records audit', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const post = createReviewPost();
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    const result = await service.approveItem('post-1', 'maxim', {});

    expect(vkPublishService.publishPost).toHaveBeenCalledWith(
      'channel-1',
      'post-1',
      'safety-desk-owner',
      {
        text: post.text,
        photoUrls: ['https://cdn.example.com/photo.jpg'],
        videoUrls: [],
        linkUrls: ['https://example.com/post'],
      },
    );
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

  it('keeps VK video review posts visible and passes videoUrls to publish', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const post = createReviewPost({
      text: 'Видео на проверку',
      photoUrls: [],
      videoUrls: ['https://vkvd.example/video-720.mp4'],
      linkUrls: [],
      attachmentTypes: ['video'],
    });
    prisma.vkParsingPost.findMany.mockResolvedValue([post]);
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    const queue = await service.getQueue();
    await service.approveItem('post-1', 'maxim', {});

    expect(queue.items[0]).toMatchObject({
      id: 'post-1',
      videoUrls: ['https://vkvd.example/video-720.mp4'],
      status: 'REVIEW',
    });
    expect(vkPublishService.publishPost).toHaveBeenCalledWith(
      'channel-1',
      'post-1',
      'safety-desk-owner',
      {
        text: 'Видео на проверку',
        photoUrls: [],
        videoUrls: ['https://vkvd.example/video-720.mp4'],
        linkUrls: [],
      },
    );
  });

  it('does not approve a blocked review item', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(
      createReviewPost({
        hasUnsupportedAttachments: true,
        unsupportedAttachments: [{ type: 'video', label: 'Видео', count: 1 }],
      }),
    );

    await expect(service.approveItem('post-1', 'maxim', {})).rejects.toThrow(
      BadRequestException,
    );
    expect(vkPublishService.publishPost).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('approves all review items through the VK publish path', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const postOne = createReviewPost({ id: 'post-1', text: 'Первый пост' });
    const postTwo = createReviewPost({ id: 'post-2', text: 'Второй пост' });
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([postOne, postTwo])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await service.approveAllReviewItems('maxim', {});

    expect(vkPublishService.publishPost).toHaveBeenCalledTimes(2);
    expect(vkPublishService.publishPost).toHaveBeenNthCalledWith(
      1,
      'channel-1',
      'post-1',
      'safety-desk-owner',
      expect.objectContaining({ text: 'Первый пост' }),
    );
    expect(vkPublishService.publishPost).toHaveBeenNthCalledWith(
      2,
      'channel-1',
      'post-2',
      'safety-desk-owner',
      expect.objectContaining({ text: 'Второй пост' }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(result.message).toContain('2');
    expect(result.queue.summary.review).toBe(0);
  });

  it('rejects a review item without sending anything to MAX', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(createReviewPost());

    const result = await service.rejectItem('post-1', 'maxim', {});

    expect(vkPublishService.publishPost).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        publishCancelledAt: null,
        source: {
          status: 'ACTIVE',
          publishMode: 'REVIEW',
        },
      }),
      data: expect.objectContaining({
        publishCancelledAt: expect.any(Date),
        publishCancelledByUserId: 'maxim',
        publishIdempotencyKey: null,
      }),
    });
    expect(result.message).toContain('ничего не отправлено');
  });

  it('treats stale reject decisions as not found without audit side effects', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(createReviewPost());
    prisma.vkParsingPost.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.rejectItem('post-1', 'maxim', {})).rejects.toThrow(
      'Материал проверки уже обработан или недоступен',
    );

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('treats stale recheck decisions as not found without audit side effects', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(createReviewPost({ publishCancelledAt: new Date() }));
    prisma.vkParsingPost.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.recheckItem('post-1', 'maxim')).rejects.toThrow(
      'Материал проверки уже обработан или недоступен',
    );

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
