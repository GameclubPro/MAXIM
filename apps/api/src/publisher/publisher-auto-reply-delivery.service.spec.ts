import {
  PublicationContentFormat,
  PublisherAutoReplyAssetUploadStatus,
  PublisherAutoReplyDeliveryStatus,
} from '../prisma/prisma-client';
import { PublisherAutoReplyDeliveryService } from './publisher-auto-reply-delivery.service';
import type { PublisherAutoReplyJob } from './publisher-auto-reply.queue';

const job: PublisherAutoReplyJob = {
  version: 1,
  kind: 'deliver',
  retryPolicyName: 'publisher-auto-reply',
  deliveryId: 'delivery-1',
};
const attempt = { final: false, attemptsMade: 1, maxAttempts: 7 };

function asset(id = 'asset-1') {
  return {
    position: 0,
    asset: {
      id,
      chatId: '-100',
      bytes: Buffer.from('valid-image-bytes'),
      mimeType: 'image/jpeg',
      fileName: 'reply.jpg',
      sizeBytes: Buffer.byteLength('valid-image-bytes'),
    },
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    chatId: '-100',
    ruleId: 'rule-1',
    contentRevisionId: 'content-1',
    publisherBotId: 'publisher-bot',
    sourceMessageId: 'source-message-1',
    sourceUserId: 'user-1',
    matchedRuleVersion: 3,
    matchedNormalizedPhrase: 'прайс',
    publisherSettingsRevision: 4,
    publicationPolicyRevision: 2,
    status: PublisherAutoReplyDeliveryStatus.SENDING,
    dueAt: new Date('2026-08-29T12:00:00.000Z'),
    lockToken: 'runtime-lock',
    dispatchStartedAt: null,
    rule: {
      version: 3,
      normalizedPhrase: 'прайс',
      enabled: true,
      archivedAt: null,
      cooldownSeconds: 30,
      currentContentRevisionId: 'content-1',
    },
    chat: {
      publisherSettings: { autoRepliesEnabled: true, revision: 4 },
      publicationPolicy: { publikEnabled: true, revision: 2 },
    },
    contentRevision: {
      id: 'content-1',
      ruleId: 'rule-1',
      text: '**Цена** сегодня',
      textFormat: PublicationContentFormat.MARKDOWN,
      assets: [],
    },
    ...overrides,
  };
}

function harness(
  options: {
    leased?: ReturnType<typeof delivery>;
    cooldownClaimed?: boolean;
    uploadRow?: Record<string, unknown> | null;
    sendError?: Error & { response?: { status: number } };
  } = {},
) {
  const leased = options.leased ?? delivery();
  const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const uploadUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    publisherAutoReplyDelivery: {
      findFirst: jest.fn().mockResolvedValue(leased),
      updateMany: deliveryUpdateMany,
    },
    $queryRaw: jest
      .fn()
      .mockResolvedValue(options.cooldownClaimed === false ? [] : [{ rule_id: 'rule-1' }]),
  };
  const prisma = {
    publisherAutoReplyDelivery: {
      findUnique: jest.fn().mockResolvedValue({
        status: PublisherAutoReplyDeliveryStatus.PENDING,
        dueAt: new Date(Date.now() - 1_000),
        lockedAt: null,
        dispatchStartedAt: null,
      }),
      findFirstOrThrow: jest.fn().mockResolvedValue(leased),
      updateMany: deliveryUpdateMany,
    },
    publisherAutoReplyAssetUpload: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(options.uploadRow ?? null),
      updateMany: uploadUpdateMany,
    },
    $transaction: jest.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
  };
  const maxClient = {
    uploadImage: jest.fn().mockResolvedValue({ token: 'fresh-upload' }),
    sendMessageImmediateWithId: jest.fn(async (_chatId, _text, sendOptions) => {
      await sendOptions.beforeSend();
      if (options.sendError) throw options.sendError;
      return { messageId: 'remote-1' };
    }),
  };
  const readiness = {
    assertEntityReady: jest.fn().mockResolvedValue({
      chatId: '-100',
      entityType: 'chat',
      requiredBotId: 'publisher-bot',
      policyRevision: 2,
    }),
  };
  const dispatchHealth = {
    assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
    recordSendSuccess: jest.fn().mockResolvedValue(undefined),
    recordSendFailure: jest.fn().mockResolvedValue('transient'),
  };
  const service = new PublisherAutoReplyDeliveryService(
    prisma as never,
    maxClient as never,
    readiness as never,
    dispatchHealth as never,
    {
      getBotId: () => 'publisher-bot',
      getRequiredActionToken: jest.fn(() => 'not-a-real-token'),
    } as never,
  );
  return {
    service,
    prisma,
    tx,
    maxClient,
    readiness,
    dispatchHealth,
    deliveryUpdateMany,
    uploadUpdateMany,
  };
}

describe('PublisherAutoReplyDeliveryService', () => {
  it('cancels before upload or send when the frozen rule revision changed', async () => {
    const leased = delivery({ rule: { ...delivery().rule, version: 4 } });
    const { service, maxClient, deliveryUpdateMany } = harness({ leased });

    await service.process(job, attempt);

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublisherAutoReplyDeliveryStatus.CANCELED,
          failureCode: 'EPOCH_CHANGED',
        }),
      }),
    );
  });

  it('claims per-user cooldown in the send-fence transaction and suppresses a concurrent hit', async () => {
    const { service, tx, maxClient, deliveryUpdateMany } = harness({ cooldownClaimed: false });

    await service.process(job, attempt);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublisherAutoReplyDeliveryStatus.CANCELED,
          failureCode: 'COOLDOWN_ACTIVE',
        }),
      }),
    );
  });

  it('reuses only a bot-scoped cached image payload and sends safe HTML as a reply', async () => {
    const leased = delivery({
      contentRevision: { ...delivery().contentRevision, assets: [asset()] },
    });
    const cached = {
      status: PublisherAutoReplyAssetUploadStatus.READY,
      payload: { token: 'cached-upload', __maximUploadBotId: 'publisher-bot' },
      expiresAt: null,
    };
    const { service, maxClient } = harness({ leased, uploadRow: cached });

    await service.process(job, attempt);

    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '-100',
      '<strong>Цена</strong> сегодня',
      expect.objectContaining({
        textFormat: 'html',
        imagePayload: { token: 'cached-upload' },
        messageLink: { type: 'reply', mid: 'source-message-1' },
      }),
      expect.objectContaining({
        trafficClass: 'interactive',
        botId: 'publisher-bot',
      }),
    );
    expect(
      JSON.stringify((maxClient.sendMessageImmediateWithId as jest.Mock).mock.calls),
    ).not.toContain('__maximUploadBotId');
  });

  it('does not retry an unknown failure after crossing the send fence', async () => {
    const timeout = Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' });
    const { service, deliveryUpdateMany } = harness({ sendError: timeout });

    await service.process(job, attempt);

    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublisherAutoReplyDeliveryStatus.AMBIGUOUS,
          failureCode: 'AMBIGUOUS_SEND',
        }),
      }),
    );
  });

  it('uploads again when a READY cache belongs to another bot', async () => {
    const leased = delivery({
      contentRevision: { ...delivery().contentRevision, assets: [asset()] },
    });
    const foreignCache = {
      status: PublisherAutoReplyAssetUploadStatus.READY,
      payload: { token: 'foreign-upload', __maximUploadBotId: 'another-bot' },
      expiresAt: null,
    };
    const { service, maxClient } = harness({ leased, uploadRow: foreignCache });

    await service.process(job, attempt);

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'reply.jpg',
      'image/jpeg',
      expect.objectContaining({ botId: 'publisher-bot' }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ imagePayload: { token: 'fresh-upload' } }),
      expect.any(Object),
    );
  });

  it('invalidates and re-uploads a cached attachment once after a definitive MAX rejection', async () => {
    const leased = delivery({
      contentRevision: { ...delivery().contentRevision, assets: [asset()] },
    });
    const cached = {
      status: PublisherAutoReplyAssetUploadStatus.READY,
      payload: { token: 'expired-upload', __maximUploadBotId: 'publisher-bot' },
      expiresAt: null,
    };
    const { service, prisma, maxClient, uploadUpdateMany } = harness({ leased, uploadRow: cached });
    (prisma.publisherAutoReplyAssetUpload.findUnique as jest.Mock)
      .mockResolvedValueOnce(cached)
      .mockResolvedValueOnce({
        status: PublisherAutoReplyAssetUploadStatus.PENDING,
        payload: null,
        expiresAt: null,
      });
    const invalidAttachment = Object.assign(new Error('MAX rejected request'), {
      response: { status: 400, data: { code: 'invalid_attachment_token' } },
    });
    (maxClient.sendMessageImmediateWithId as jest.Mock)
      .mockImplementationOnce(async (_chatId, _text, sendOptions) => {
        await sendOptions.beforeSend();
        throw invalidAttachment;
      })
      .mockImplementationOnce(async (_chatId, _text, sendOptions) => {
        await sendOptions.beforeSend();
        return { messageId: 'remote-after-refresh' };
      });

    await service.process(job, attempt);

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
    expect(uploadUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublisherAutoReplyAssetUploadStatus.PENDING,
          failureCode: 'ATTACHMENT_REJECTED',
        }),
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ imagePayload: { token: 'fresh-upload' } }),
      expect.any(Object),
    );
  });
});
