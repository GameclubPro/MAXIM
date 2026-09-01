import type { MaxUpdate } from '@maxim/contracts';
import {
  parsePublisherSuggestionAdminReviewCallbackPayload,
  PublisherSuggestionAdminCallbackObserverService,
} from './publisher-suggestion-admin-callback-observer.service';
import { buildPublisherSuggestionAdminReviewCallbackPayload } from './publisher-suggestion-admin.queue';

function callbackUpdate(
  overrides: {
    botId?: string;
    payload?: string;
    callbackId?: string | null;
    actorUserId?: string | number | null;
    chatId?: string;
    messageId?: string | null;
  } = {},
): MaxUpdate {
  const chatId = overrides.chatId ?? '42';
  const messageId = overrides.messageId === null ? null : (overrides.messageId ?? 'admin-card-1');
  return {
    updateId: 'publisher-callback-update-1',
    botId: overrides.botId ?? 'publik_bot',
    type: 'message_callback',
    ...(messageId
      ? {
          message: {
            messageId,
            chatId,
            senderId: 'publik_bot',
            text: '',
            createdAt: '2026-09-01T12:00:00.000Z',
          },
        }
      : {}),
    raw: {
      callback: {
        timestamp: 1_788_264_000_000,
        ...(overrides.callbackId === null
          ? {}
          : { callback_id: overrides.callbackId ?? 'callback-1' }),
        payload:
          overrides.payload ??
          buildPublisherSuggestionAdminReviewCallbackPayload('publish', 'psg_1'),
        user: {
          user_id: overrides.actorUserId ?? 42,
          username: 'editor',
          first_name: 'Иван',
          last_name: 'Петров',
          avatar_url: 'https://example.test/avatar.jpg',
          profile_url: 'https://max.ru/u/editor',
        },
      },
      message: {
        ...(messageId ? { mid: messageId } : {}),
        recipient: { chat_id: Number(chatId), chat_type: 'dialog' },
      },
    },
  };
}

function createFixture() {
  const queue = { enqueueReview: jest.fn().mockResolvedValue(undefined) };
  const registry = {
    getPublisherBotDescriptor: jest.fn(() => ({ id: 'publik_bot' })),
  };
  return {
    queue,
    observer: new PublisherSuggestionAdminCallbackObserverService(
      registry as never,
      queue as never,
    ),
  };
}

describe('PublisherSuggestionAdminCallbackObserverService', () => {
  it('extracts an exact Publisher review job from a private callback', async () => {
    const { observer, queue } = createFixture();

    await expect(observer.observeWebhook(callbackUpdate(), 'webhook-event-1')).resolves.toBe(true);

    expect(queue.enqueueReview).toHaveBeenCalledWith({
      suggestionId: 'psg_1',
      requiredBotId: 'publik_bot',
      action: 'publish',
      actor: {
        userId: '42',
        username: 'editor',
        displayName: 'Иван Петров',
        avatarUrl: 'https://example.test/avatar.jpg',
        profileUrl: 'https://max.ru/u/editor',
      },
      callbackId: 'callback-1',
      privateChatId: '42',
      messageId: 'admin-card-1',
      webhookEventId: 'webhook-event-1',
      updateId: 'publisher-callback-update-1',
      dedupeKey: 'callback-1',
      requestedAt: new Date('2026-09-01T12:00:00.000Z'),
    });
  });

  it('ignores the same callback domain when it arrives through another bot', async () => {
    const { observer, queue } = createFixture();

    await expect(
      observer.observeWebhook(callbackUpdate({ botId: 'major_bot' }), 'webhook-event-1'),
    ).resolves.toBe(false);
    expect(queue.enqueueReview).not.toHaveBeenCalled();
  });

  it('consumes malformed Publisher callbacks without enqueueing or leaking into another flow', async () => {
    const { observer, queue } = createFixture();

    await expect(
      observer.observeWebhook(
        callbackUpdate({ payload: 'psa:v1:publish:bad:id' }),
        'webhook-event-1',
      ),
    ).resolves.toBe(true);
    await expect(
      observer.observeWebhook(callbackUpdate({ callbackId: null }), 'webhook-event-2'),
    ).resolves.toBe(true);
    await expect(
      observer.observeWebhook(callbackUpdate({ chatId: '-100500' }), 'webhook-event-3'),
    ).resolves.toBe(true);
    await expect(
      observer.observeWebhook(callbackUpdate({ messageId: null }), 'webhook-event-4'),
    ).resolves.toBe(true);
    expect(queue.enqueueReview).not.toHaveBeenCalled();
  });

  it('leaves unrelated Publisher callbacks for the existing private flows', async () => {
    const { observer, queue } = createFixture();

    await expect(
      observer.observeWebhook(callbackUpdate({ payload: 'ar:cancel:token-1' }), null),
    ).resolves.toBe(false);
    expect(queue.enqueueReview).not.toHaveBeenCalled();
  });

  it('re-observes a duplicate with the same callback dedupe identity', async () => {
    const { observer, queue } = createFixture();
    const update = callbackUpdate();

    await observer.observeWebhook(update, 'webhook-event-1');
    await observer.observeWebhook(update, null, { duplicate: true });

    expect(queue.enqueueReview).toHaveBeenCalledTimes(2);
    expect(queue.enqueueReview.mock.calls[0]?.[0]).toMatchObject({
      callbackId: 'callback-1',
      dedupeKey: 'callback-1',
      updateId: 'publisher-callback-update-1',
    });
    expect(queue.enqueueReview.mock.calls[1]?.[0]).toMatchObject({
      callbackId: 'callback-1',
      dedupeKey: 'callback-1',
      updateId: 'publisher-callback-update-1',
    });
  });

  it('parses only bounded versioned publish and cancel payloads', () => {
    expect(parsePublisherSuggestionAdminReviewCallbackPayload('psa:v1:cancel:psg_1')).toEqual({
      action: 'cancel',
      suggestionId: 'psg_1',
    });
    expect(parsePublisherSuggestionAdminReviewCallbackPayload('psa:v1:draft:psg_1')).toBeNull();
    expect(
      parsePublisherSuggestionAdminReviewCallbackPayload('pc2|suggestion_review_publish|1'),
    ).toBeNull();
  });
});
