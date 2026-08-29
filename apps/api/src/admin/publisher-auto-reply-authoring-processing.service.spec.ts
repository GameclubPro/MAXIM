import { PublisherAutoReplyAuthoringState } from '../prisma/prisma-client';
import { PublisherAutoReplyAuthoringProcessingService } from './publisher-auto-reply-authoring-processing.service';

function savingSession() {
  return {
    id: 'session-1',
    publisherBotId: 'publik_bot',
    actorUserId: '42',
    targetChatId: 'chat-1',
    state: PublisherAutoReplyAuthoringState.SAVING,
    stageRevision: 4,
    normalizedPhrase: 'каталог',
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
  const policy = { getEntity: jest.fn().mockResolvedValue({ id: 'chat-1' }) };
  const privateFlows = {
    renew: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  };
  return {
    service: new PublisherAutoReplyAuthoringProcessingService(
      prisma as never,
      {} as never,
      {} as never,
      policy as never,
      privateFlows as never,
    ),
    prisma,
    policy,
    privateFlows,
    publisherAutoReplyAuthoringSession,
  };
}

describe('PublisherAutoReplyAuthoringProcessingService activation', () => {
  it('atomically enables module settings without a create race', async () => {
    const { service, prisma, privateFlows } = fixture();
    let settingsQueryText = '';
    const tx = {
      publisherAutoReplyRule: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'rule-1',
          version: 1,
          normalizedPhrase: 'каталог',
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

    expect(settingsQueryText).toContain('ON CONFLICT');
    expect(settingsQueryText).toContain('auto_replies_enabled');
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
