import { VkPublishService } from './vk-publish.service';
import { buildVkBotReviewFingerprint } from './vk-bot-review-protocol';

function fixture() {
  const scope = { ownerProfile: 'PUBLISHER', ownerBotId: 'publik_bot' };
  const settings = {
    stripLinksEnabled: false,
    skipAdsEnabled: false,
    appendChannelLinkEnabled: false,
    channelLinkText: 'Channel',
    botReviewRecipientUserId: '17',
  };
  const post = {
    id: 'post-1',
    chatId: '-1',
    ...scope,
    status: 'NEW',
    publishActorUserId: '17',
    publishAttemptCount: 0,
    text: 'Post',
    textFormat: 'plain',
    contentHash: 'hash',
    photoUrls: [],
    videoUrls: [],
    linkUrls: [],
    isAdvertising: false,
    manualContentEditedAt: null,
    source: { publishMode: 'BOT_REVIEW', status: 'ACTIVE' },
    botReview: { status: 'APPROVED', decidedByUserId: '17', fingerprint: '' },
  };
  post.botReview.fingerprint = buildVkBotReviewFingerprint(post, settings);
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: '-1' }]),
    $transaction: jest.fn(),
    vkParsingPost: {
      findFirst: jest.fn().mockResolvedValue(post),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    vkParsingSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
    vkBotReview: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const service = new VkPublishService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { get: () => undefined } as never,
    { getPublisherScope: () => scope } as never,
  );
  const internal = service as unknown as {
    recordBotReviewPublishAttempt(
      post: unknown,
      reason: string,
      key: string,
      at: Date,
    ): Promise<boolean>;
    assertReviewSourceOwnerAction(post: unknown, actor: string | null): void;
  };
  return { prisma, internal, settings, post };
}

describe('VK review publication admission', () => {
  it('uses the same chat lock and exact intent CAS before a remote attempt', async () => {
    const { prisma, internal, post } = fixture();
    const at = new Date();
    expect(await internal.recordBotReviewPublishAttempt(post, 'manual-retry', 'intent-1', at)).toBe(
      true,
    );
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'post-1',
        publishReason: 'manual-retry',
        publishIdempotencyKey: 'intent-1',
        publishLockedAt: at,
      },
      data: { publishAttemptCount: { increment: 1 } },
    });
  });
  it('revokes only the unattempted intent when settings race with approval', async () => {
    const { prisma, internal, post, settings } = fixture();
    settings.stripLinksEnabled = true;
    expect(
      await internal.recordBotReviewPublishAttempt(post, 'manual-retry', 'intent-1', new Date()),
    ).toBe(false);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publishAttemptCount: 0, publishedMessageId: null }),
        data: expect.objectContaining({ publishIdempotencyKey: null }),
      }),
    );
    expect(prisma.vkBotReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }),
    );
  });
  it('does not revoke approval if the unattempted intent CAS loses', async () => {
    const { prisma, internal, post, settings } = fixture();
    settings.stripLinksEnabled = true;
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await internal.recordBotReviewPublishAttempt(post, 'manual-retry', 'intent-1', new Date()),
    ).toBe(false);
    expect(prisma.vkBotReview.updateMany).not.toHaveBeenCalled();
  });
  it('does not allow ordinary or Safety Desk publish routes to bypass bot review', () => {
    const { internal, post } = fixture();
    expect(() => internal.assertReviewSourceOwnerAction(post, '17')).toThrow('согласуется');
    expect(() => internal.assertReviewSourceOwnerAction(post, null)).toThrow('согласуется');
  });
});
