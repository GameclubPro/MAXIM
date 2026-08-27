import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import { ManagedEntityAccessRole, ManagedEntityAccessState } from '../prisma/prisma-client';
import { PublisherChatCommentProducerService } from './publisher-chat-comment-producer.service';

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
    publisherSettings: {
      chatCommentsEnabled: boolean;
      chatCommentsAdminsEnabled: boolean;
    };
    accessEdges: Array<{
      state: ManagedEntityAccessState;
      userRole: ManagedEntityAccessRole;
    }>;
  } | null,
) {
  const prisma = { chat: { findFirst: jest.fn().mockResolvedValue(source) } };
  const queue = { enqueueAttach: jest.fn().mockResolvedValue(undefined) };
  const service = new PublisherChatCommentProducerService(
    prisma as never,
    queue as never,
    {
      get: jest.fn((key: string) => (key === 'MAX_PUBLISHER_BOT_ID' ? 'publik-bot' : undefined)),
    } as unknown as ConfigService,
  );
  const markerStore = {
    claimChatAutoComment: jest.fn().mockResolvedValue({
      status: 'claimed',
      markerId: `ccr1_${'a'.repeat(32)}`,
      lockToken: 'lock-1',
    }),
    releaseChatAutoComment: jest.fn(),
    skipChatAutoCommentAfterPublisherAdmissionFailure: jest.fn(),
  };
  (service as unknown as { markerStore: typeof markerStore }).markerStore = markerStore;
  return { service, prisma, queue, markerStore };
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

      expect(fixture.queue.enqueueAttach).toHaveBeenCalledWith({
        markerId: `ccr1_${'a'.repeat(32)}`,
        lockToken: 'lock-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        senderId: 'user-1',
        dialogBotId: 'publik-bot',
      });
    },
  );

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
});
