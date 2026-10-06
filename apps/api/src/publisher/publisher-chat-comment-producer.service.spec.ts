import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import { ManagedEntityAccessRole, ManagedEntityAccessState } from '../prisma/prisma-client';
import {
  PublisherChatCommentClaimPendingError,
  PublisherChatCommentProducerService,
} from './publisher-chat-comment-producer.service';
import { PublisherChatCommentAdmissionError } from './publisher-chat-comment.queue';

const update: MaxUpdate = {
  updateId: 'publisher-update-1',
  botId: 'publik-bot',
  type: 'message_created',
  message: {
    chatId: 'chat-1',
    entityType: 'chat',
    messageId: 'message-1',
    senderId: 'user-1',
    text: 'Пост админа',
    createdAt: '2026-08-27T10:00:00.000Z',
  },
};

function createFixture(
  source: {
    publicationPolicy?: { publikEnabled: boolean; revision: number } | null;
    publisherSettings: {
      chatCommentsEnabled: boolean;
      chatCommentsAdminsEnabled: boolean;
      revision?: number;
    };
    accessEdges: Array<{
      state: ManagedEntityAccessState;
      userRole: ManagedEntityAccessRole;
    }>;
  } | null,
) {
  const persistedSource = source
    ? {
        ...source,
        publicationPolicy:
          source.publicationPolicy === undefined
            ? { publikEnabled: true, revision: 3 }
            : source.publicationPolicy,
        publisherSettings: { revision: 7, ...source.publisherSettings },
      }
    : null;
  const prisma = { chat: { findFirst: jest.fn().mockResolvedValue(persistedSource) } };
  const queue = {
    enqueueAttach: jest.fn().mockResolvedValue(undefined),
    hasMatchingAttachJob: jest.fn().mockResolvedValue(false),
  };
  const legacyHolds = {
    isMessageHeld: jest.fn().mockResolvedValue(false),
    isMemberHeld: jest.fn().mockResolvedValue(false),
    isGlobalUserHeld: jest.fn().mockResolvedValue(false),
  };
  const service = new PublisherChatCommentProducerService(
    prisma as never,
    queue as never,
    {
      get: jest.fn((key: string) => (key === 'MAX_PUBLISHER_BOT_ID' ? 'publik-bot' : undefined)),
    } as unknown as ConfigService,
    legacyHolds as never,
  );
  const markerStore = {
    claimChatAutoComment: jest.fn().mockResolvedValue({
      status: 'claimed',
      markerId: `ccr1_${'a'.repeat(32)}`,
      lockToken: 'lock-1',
    }),
    readChatAutoCommentPendingJobIdentity: jest.fn().mockResolvedValue(null),
    releaseChatAutoComment: jest.fn(),
    skipChatAutoCommentAfterPublisherAdmissionFailure: jest.fn(),
  };
  (service as unknown as { markerStore: typeof markerStore }).markerStore = markerStore;
  return { service, prisma, queue, markerStore, legacyHolds };
}

describe('PublisherChatCommentProducerService', () => {
  it.each([ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN])(
    'queues an unsigned candidate for an exact granted Publisher %s',
    async (userRole) => {
      const fixture = createFixture({
        publisherSettings: {
          chatCommentsEnabled: true,
          chatCommentsAdminsEnabled: true,
        },
        accessEdges: [
          {
            state: ManagedEntityAccessState.GRANTED,
            userRole,
          },
        ],
      });

      await fixture.service.observeWebhook(update);

      expect(fixture.markerStore.claimChatAutoComment).toHaveBeenCalledWith(
        expect.objectContaining({
          publisherSettingsRevision: 7,
          publicationPolicyRevision: 3,
        }),
      );
      expect(fixture.queue.enqueueAttach).toHaveBeenCalledWith({
        markerId: `ccr1_${'a'.repeat(32)}`,
        lockToken: 'lock-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        senderId: 'user-1',
        dialogBotId: 'publik-bot',
        publisherSettingsRevision: 7,
        publicationPolicyRevision: 3,
        sourceCreatedAt: new Date(update.message!.createdAt!),
      });
    },
  );

  function automaticFixture() {
    return createFixture({
      publisherSettings: { chatCommentsEnabled: true, chatCommentsAdminsEnabled: true },
      accessEdges: [
        { state: ManagedEntityAccessState.GRANTED, userRole: ManagedEntityAccessRole.ADMIN },
      ],
    });
  }

  it('denies a held original author on duplicate repair before creating a new marker or job', async () => {
    const fixture = automaticFixture();
    fixture.prisma.chat.findFirst.mockResolvedValueOnce(null);
    await fixture.service.observeWebhook(update); // The original receipt had the feature disabled.
    fixture.legacyHolds.isMessageHeld.mockImplementation(
      async (_chatId, messageId) => messageId === 'other-held-original',
    );
    fixture.legacyHolds.isMemberHeld.mockImplementation(
      async (chatId, userId) =>
        chatId === update.message!.chatId && userId === update.message!.senderId,
    );

    await fixture.service.observeWebhook(update);
    await fixture.service.observeWebhook(update);

    expect(fixture.prisma.chat.findFirst).toHaveBeenCalledTimes(1);
    expect(fixture.markerStore.claimChatAutoComment).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueAttach).not.toHaveBeenCalled();
  });

  it('denies globally held U in a fresh second chat while admitting an independent author V', async () => {
    const fixture = automaticFixture();
    fixture.legacyHolds.isGlobalUserHeld.mockImplementation(async (userId) => userId === 'held-U');
    const inSecondChat: MaxUpdate = {
      ...update,
      message: { ...update.message!, chatId: 'chat-B', senderId: 'held-U', messageId: 'fresh-U' },
    };
    await fixture.service.observeWebhook(inSecondChat);
    expect(fixture.markerStore.claimChatAutoComment).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueAttach).not.toHaveBeenCalled();

    await fixture.service.observeWebhook({
      ...inSecondChat,
      updateId: 'independent-update',
      message: { ...inSecondChat.message!, senderId: 'independent-V', messageId: 'fresh-V' },
    });
    expect(fixture.queue.enqueueAttach).toHaveBeenCalledTimes(1);
    expect(fixture.queue.enqueueAttach).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-B',
        senderId: 'independent-V',
        messageId: 'fresh-V',
      }),
    );
  });

  it('creates no automatic work when source hold authority is unavailable', async () => {
    const fixture = automaticFixture();
    fixture.legacyHolds.isGlobalUserHeld.mockRejectedValueOnce(new Error('Hold store unavailable'));
    await expect(fixture.service.observeWebhook(update)).rejects.toThrow('Hold store unavailable');
    expect(fixture.markerStore.claimChatAutoComment).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueAttach).not.toHaveBeenCalled();
  });

  it('never invents a source clock for a webhook without a verified creation time', async () => {
    const fixture = automaticFixture();
    await fixture.service.observeWebhook({
      ...update,
      message: { ...update.message!, createdAt: undefined },
    });
    expect(fixture.queue.enqueueAttach.mock.calls[0]?.[0]).not.toHaveProperty('sourceCreatedAt');
  });

  it('skips a sender without a fresh exact Publisher access edge', async () => {
    const fixture = createFixture({
      publisherSettings: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
      },
      accessEdges: [],
    });

    await fixture.service.observeWebhook(update);

    expect(fixture.markerStore.claimChatAutoComment).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueAttach).not.toHaveBeenCalled();
  });

  it('skips a sender with a fresh exact Publisher denial', async () => {
    const fixture = createFixture({
      publisherSettings: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
      },
      accessEdges: [
        {
          state: ManagedEntityAccessState.USER_DENIED,
          userRole: ManagedEntityAccessRole.MEMBER,
        },
      ],
    });

    await fixture.service.observeWebhook(update);

    expect(fixture.markerStore.claimChatAutoComment).not.toHaveBeenCalled();
    expect(fixture.queue.enqueueAttach).not.toHaveBeenCalled();
  });

  it('does nothing when the Publisher-owned module is disabled', async () => {
    const fixture = createFixture({
      publisherSettings: {
        chatCommentsEnabled: false,
        chatCommentsAdminsEnabled: true,
      },
      accessEdges: [],
    });

    await fixture.service.observeWebhook(update);

    expect(fixture.markerStore.claimChatAutoComment).not.toHaveBeenCalled();
  });

  it('keeps the claim and non-exhaustingly defers an ambiguous durable enqueue failure', async () => {
    const fixture = createFixture({
      publisherSettings: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
      },
      accessEdges: [
        {
          state: ManagedEntityAccessState.GRANTED,
          userRole: ManagedEntityAccessRole.ADMIN,
        },
      ],
    });
    const error = new Error('redis unavailable after Queue.add');
    fixture.queue.enqueueAttach.mockRejectedValueOnce(error);

    await expect(fixture.service.observeWebhook(update)).rejects.toMatchObject({
      code: 'WEBHOOK_PREPARATION_DEFERRED',
      cause: error,
    });

    expect(fixture.markerStore.releaseChatAutoComment).not.toHaveBeenCalled();
    expect(
      fixture.markerStore.skipChatAutoCommentAfterPublisherAdmissionFailure,
    ).not.toHaveBeenCalled();
  });

  it('terminally skips the claim when Publisher dispatch is explicitly disabled', async () => {
    const fixture = createFixture({
      publisherSettings: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
      },
      accessEdges: [
        {
          state: ManagedEntityAccessState.GRANTED,
          userRole: ManagedEntityAccessRole.ADMIN,
        },
      ],
    });
    fixture.queue.enqueueAttach.mockRejectedValueOnce(
      new PublisherChatCommentAdmissionError('dispatch_disabled'),
    );

    await expect(fixture.service.observeWebhook(update)).resolves.toBeUndefined();

    expect(
      fixture.markerStore.skipChatAutoCommentAfterPublisherAdmissionFailure,
    ).toHaveBeenCalledWith(expect.objectContaining({ reason: 'dispatch_disabled' }));
    expect(fixture.markerStore.releaseChatAutoComment).not.toHaveBeenCalled();
  });

  it('requests controlled webhook retry for a replayed in-progress predispatch claim', async () => {
    const fixture = createFixture({
      publisherSettings: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
      },
      accessEdges: [
        {
          state: ManagedEntityAccessState.GRANTED,
          userRole: ManagedEntityAccessRole.ADMIN,
        },
      ],
    });
    fixture.markerStore.claimChatAutoComment.mockResolvedValueOnce({ status: 'in_progress' });
    fixture.markerStore.readChatAutoCommentPendingJobIdentity.mockResolvedValueOnce({
      markerId: `ccr1_${'a'.repeat(32)}`,
      lockToken: 'lock-1',
      publisherSettingsRevision: 7,
      publicationPolicyRevision: 3,
    });

    await expect(fixture.service.observeWebhook(update)).rejects.toMatchObject({
      name: 'PublisherChatCommentClaimPendingError',
      code: 'WEBHOOK_PREPARATION_DEFERRED',
    } satisfies Partial<PublisherChatCommentClaimPendingError>);

    expect(fixture.queue.hasMatchingAttachJob).toHaveBeenCalledWith(
      expect.objectContaining({ markerId: `ccr1_${'a'.repeat(32)}`, lockToken: 'lock-1' }),
    );
    expect(fixture.queue.enqueueAttach).not.toHaveBeenCalled();
    expect(fixture.markerStore.releaseChatAutoComment).not.toHaveBeenCalled();
    expect(
      fixture.markerStore.skipChatAutoCommentAfterPublisherAdmissionFailure,
    ).not.toHaveBeenCalled();
  });

  it('acknowledges an in-progress replay only after proving its exact durable job', async () => {
    const fixture = createFixture({
      publisherSettings: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
      },
      accessEdges: [
        {
          state: ManagedEntityAccessState.GRANTED,
          userRole: ManagedEntityAccessRole.ADMIN,
        },
      ],
    });
    fixture.markerStore.claimChatAutoComment.mockResolvedValueOnce({ status: 'in_progress' });
    fixture.markerStore.readChatAutoCommentPendingJobIdentity.mockResolvedValueOnce({
      markerId: `ccr1_${'a'.repeat(32)}`,
      lockToken: 'lock-1',
      publisherSettingsRevision: 7,
      publicationPolicyRevision: 3,
    });
    fixture.queue.hasMatchingAttachJob.mockResolvedValueOnce(true);

    await expect(fixture.service.observeWebhook(update)).resolves.toBeUndefined();

    expect(fixture.queue.hasMatchingAttachJob).toHaveBeenCalledTimes(1);
    expect(fixture.queue.enqueueAttach).not.toHaveBeenCalled();
    expect(fixture.markerStore.releaseChatAutoComment).not.toHaveBeenCalled();
  });

  it('acknowledges a stale crash claim without enqueue after settings revision changes', async () => {
    const fixture = createFixture({
      publisherSettings: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
        revision: 8,
      },
      accessEdges: [
        {
          state: ManagedEntityAccessState.GRANTED,
          userRole: ManagedEntityAccessRole.ADMIN,
        },
      ],
    });
    fixture.markerStore.claimChatAutoComment.mockResolvedValueOnce({ status: 'settings_changed' });

    await expect(fixture.service.observeWebhook(update)).resolves.toBeUndefined();

    expect(fixture.queue.enqueueAttach).not.toHaveBeenCalled();
    expect(fixture.queue.hasMatchingAttachJob).not.toHaveBeenCalled();
  });

  it('acknowledges a replay after its marker is already terminal', async () => {
    const fixture = createFixture({
      publisherSettings: {
        chatCommentsEnabled: true,
        chatCommentsAdminsEnabled: true,
      },
      accessEdges: [
        {
          state: ManagedEntityAccessState.GRANTED,
          userRole: ManagedEntityAccessRole.ADMIN,
        },
      ],
    });
    fixture.markerStore.claimChatAutoComment.mockResolvedValueOnce({ status: 'done' });

    await expect(fixture.service.observeWebhook(update)).resolves.toBeUndefined();

    expect(fixture.queue.enqueueAttach).not.toHaveBeenCalled();
  });
});
