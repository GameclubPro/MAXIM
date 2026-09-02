import { BadRequestException } from '@nestjs/common';
import { PublisherAutoReplyAuthoringState } from '../prisma/prisma-client';
import { PublisherAutoReplyAuthoringProcessingService } from './publisher-auto-reply-authoring-processing.service';
import { BotCapabilityRequiredException } from './bot-capability-required.error';

function savingSession() {
  return {
    id: 'session-1',
    publisherBotId: 'publik_bot',
    actorUserId: '42',
    targetChatId: 'chat-1',
    state: PublisherAutoReplyAuthoringState.SAVING,
    stageRevision: 4,
    phrase: 'Каталог',
    normalizedPhrase: 'каталог',
    triggerPhrases: ['Каталог'],
    matchInContext: false,
    fuzzyMatch: false,
    ruleId: 'rule-1',
    contentRevisionId: 'content-1',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function fixture() {
  const publisherAutoReplyAuthoringSession = {
    findFirst: jest.fn().mockResolvedValue(savingSession()),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const prisma = {
    publisherAutoReplyAuthoringSession,
    $transaction: jest.fn(),
  };
  const policy = {
    getEntity: jest.fn().mockResolvedValue({ id: 'chat-1' }),
    assertBotCapabilityForFeatureEnablement: jest.fn().mockResolvedValue(undefined),
  };
  const privateFlows = {
    renew: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  };
  const captureService = { capture: jest.fn() };
  const autoReplies = {
    createFromPreparedContent: jest.fn(),
    assertTriggerActivationCapacity: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new PublisherAutoReplyAuthoringProcessingService(
      prisma as never,
      captureService as never,
      autoReplies as never,
      policy as never,
      privateFlows as never,
    ),
    prisma,
    policy,
    privateFlows,
    captureService,
    autoReplies,
    publisherAutoReplyAuthoringSession,
  };
}

describe('PublisherAutoReplyAuthoringProcessingService', () => {
  it('preserves captured safe link buttons in the immutable draft content', async () => {
    const { service, prisma, captureService, autoReplies, publisherAutoReplyAuthoringSession } =
      fixture();
    publisherAutoReplyAuthoringSession.findFirst.mockResolvedValue({
      ...savingSession(),
      state: PublisherAutoReplyAuthoringState.PROCESSING,
      stageRevision: 2,
      privateChatId: '42',
      contentMessageId: 'message-1',
      phrase: 'Каталог',
      triggerPhrases: ['Каталог', 'Стоимость'],
      matchInContext: true,
      fuzzyMatch: true,
      sourceWebhookEventId: 'webhook-1',
    });
    captureService.capture.mockResolvedValue({
      text: '**Выберите раздел**',
      textFormat: 'markdown',
      images: [],
      buttons: [{ text: 'Каталог', url: 'https://example.com/catalog', row: 0 }],
      omissions: [],
    });
    autoReplies.createFromPreparedContent.mockResolvedValue({
      ruleId: 'rule-1',
      contentRevisionId: 'content-1',
      version: 1,
    });
    const tx = {
      publisherAutoReplyAuthoringSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation((run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    );

    await expect(service.processContent('session-1')).resolves.toBe('ready');

    expect(autoReplies.createFromPreparedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        phrases: ['Каталог', 'Стоимость'],
        matchInContext: true,
        fuzzyMatch: true,
        content: {
          text: '**Выберите раздел**',
          textFormat: 'markdown',
          images: [],
          buttons: [{ text: 'Каталог', url: 'https://example.com/catalog', row: 0 }],
        },
      }),
    );
  });

  it('atomically enables module settings without a create race', async () => {
    const { service, prisma, policy, privateFlows, autoReplies } = fixture();
    let settingsQueryText = '';
    const tx = {
      publisherAutoReplyRule: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'rule-1',
          version: 1,
          normalizedPhrase: 'каталог',
          fuzzyMatch: false,
          _count: { triggers: 1 },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn().mockImplementation(async (query: { strings?: readonly string[] }) => {
        settingsQueryText = query.strings?.join(' ') ?? '';
        return [{ revision: 3 }];
      }),
      publisherAutoReplyMutationRecord: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      publisherAutoReplyAuthoringSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation((run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    );

    await expect(service.activate('session-1')).resolves.toBe('activated');

    expect(policy.assertBotCapabilityForFeatureEnablement).toHaveBeenCalledWith('chat', 'chat-1', [
      'enabled',
      'autoRepliesEnabled',
    ]);
    expect(settingsQueryText).toContain('ON CONFLICT');
    expect(settingsQueryText).toContain('auto_replies_enabled');
    expect(settingsQueryText).toContain('auto_reply_config_revision');
    expect(autoReplies.assertTriggerActivationCapacity).toHaveBeenCalledWith(tx, {
      chatId: 'chat-1',
      ruleId: 'rule-1',
      phraseCount: 1,
      fuzzyMatch: false,
    });
    expect(tx.publisherAutoReplyRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          enabled: true,
          archivedAt: null,
          authoringSessionId: null,
        }),
      }),
    );
    expect(privateFlows.release).toHaveBeenCalled();
  });

  it('terminalizes a capability blocker as an actionable domain failure', async () => {
    const { service, prisma, policy, publisherAutoReplyAuthoringSession } = fixture();
    policy.assertBotCapabilityForFeatureEnablement.mockRejectedValueOnce(
      new BotCapabilityRequiredException({
        missingPermissions: ['write'],
        featureKeys: ['enabled', 'autoRepliesEnabled'],
      }),
    );

    await expect(service.activate('session-1')).resolves.toBe('failed');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(publisherAutoReplyAuthoringSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-1',
        state: PublisherAutoReplyAuthoringState.SAVING,
        stageRevision: 4,
      },
      data: expect.objectContaining({
        state: PublisherAutoReplyAuthoringState.FAILED,
        failureCode: 'bot_capability_required',
        notificationKind: 'failed',
        notificationPending: true,
      }),
    });
  });

  it.each([
    ['PUBLISHER_AUTO_REPLY_TRIGGER_LIMIT', 'trigger_capacity'],
    ['PUBLISHER_AUTO_REPLY_FUZZY_TRIGGER_LIMIT', 'fuzzy_trigger_capacity'],
  ] as const)('returns %s activation failures to review', async (code, failureCode) => {
    const { service, prisma, autoReplies, privateFlows } = fixture();
    autoReplies.assertTriggerActivationCapacity.mockRejectedValueOnce(
      new BadRequestException({ statusCode: 400, code, message: 'Capacity reached' }),
    );
    const tx = {
      publisherAutoReplyRule: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'rule-1',
          version: 1,
          normalizedPhrase: 'каталог',
          fuzzyMatch: code === 'PUBLISHER_AUTO_REPLY_FUZZY_TRIGGER_LIMIT',
          _count: { triggers: 1 },
        }),
        updateMany: jest.fn(),
      },
      publisherAutoReplyAuthoringSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation((run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    );

    await expect(service.activate('session-1')).resolves.toBe('ready');

    expect(tx.publisherAutoReplyRule.updateMany).not.toHaveBeenCalled();
    expect(tx.publisherAutoReplyAuthoringSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-1',
        state: PublisherAutoReplyAuthoringState.SAVING,
        stageRevision: 4,
      },
      data: expect.objectContaining({
        state: PublisherAutoReplyAuthoringState.REVIEW,
        failureCode,
        notificationKind: 'ready',
        notificationPending: true,
      }),
    });
    expect(privateFlows.renew).toHaveBeenCalled();
    expect(privateFlows.release).not.toHaveBeenCalled();
  });

  it('does not misclassify an unrelated unique constraint as a phrase conflict', async () => {
    const { service, prisma, publisherAutoReplyAuthoringSession } = fixture();
    const error = Object.assign(new Error('settings race'), {
      code: 'P2002',
      meta: { target: ['publisher_entity_settings', 'chat_id'] },
    });
    prisma.$transaction.mockRejectedValue(error);

    await expect(service.activate('session-1')).rejects.toBe(error);
    expect(publisherAutoReplyAuthoringSession.updateMany).not.toHaveBeenCalled();
  });
});
