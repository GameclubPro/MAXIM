import { MAX_SEND_FENCE_STALE_MS } from '../max/max-send-ambiguity.util';
import {
  ChatRulesPublishFenceRetryError,
  classify,
  isRetryable,
} from './chat-rules-own-bot-message-classifier';

const NOW_MS = Date.parse('2026-07-19T12:00:00.000Z');

describe('chat rules own-bot message classifier', () => {
  it('matches the published message id after trimming and before checking the fence', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      publishedMessageId: '  mid-rules-1  ',
      publishSendStartedAt: new Date(NOW_MS - 1_000),
    });
    const now = jest.fn(() => NOW_MS);

    await expect(
      classify({ findUnique }, { chatId: 'chat-1', messageId: ' mid-rules-1 ' }, now),
    ).resolves.toBe('published_chat_rules');

    expect(findUnique).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      select: {
        publishedMessageId: true,
        publishSendStartedAt: true,
      },
    });
    expect(now).not.toHaveBeenCalled();
  });

  it('defers an unmatched message while the publish fence is fresh', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      publishedMessageId: 'mid-previous-rules',
      publishSendStartedAt: new Date(NOW_MS - 1_000),
    });

    await expect(
      classify({ findUnique }, { chatId: 'chat-1', messageId: 'mid-unrelated' }, () => NOW_MS),
    ).rejects.toMatchObject({
      name: 'ChatRulesPublishFenceRetryError',
      chatRulesPublishFenceRetryable: true,
      retryAfterMs: 15_000,
    });
  });

  it('rechecks at the exact remaining millisecond before the fence becomes stale', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      publishedMessageId: null,
      publishSendStartedAt: new Date(NOW_MS - MAX_SEND_FENCE_STALE_MS + 1),
    });

    await expect(
      classify({ findUnique }, { chatId: 'chat-1', messageId: 'mid-rules' }, () => NOW_MS),
    ).rejects.toMatchObject({ retryAfterMs: 1 });
  });

  it.each([MAX_SEND_FENCE_STALE_MS, MAX_SEND_FENCE_STALE_MS + 1])(
    'keeps an unmatched message eligible for cleanup when the fence age is %d ms',
    async (fenceAgeMs) => {
      const findUnique = jest.fn().mockResolvedValue({
        publishedMessageId: 'mid-previous-rules',
        publishSendStartedAt: new Date(NOW_MS - fenceAgeMs),
      });

      await expect(
        classify({ findUnique }, { chatId: 'chat-1', messageId: 'mid-unrelated' }, () => NOW_MS),
      ).resolves.toBeNull();
    },
  );

  it('does not treat a future publish timestamp as an in-flight fence', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      publishedMessageId: null,
      publishSendStartedAt: new Date(NOW_MS + 1),
    });

    await expect(
      classify({ findUnique }, { chatId: 'chat-1', messageId: 'mid-unrelated' }, () => NOW_MS),
    ).resolves.toBeNull();
  });

  it('keeps messages eligible for cleanup when no chat-rules row exists', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);

    await expect(
      classify({ findUnique }, { chatId: 'chat-1', messageId: 'mid-unrelated' }, () => NOW_MS),
    ).resolves.toBeNull();
  });

  it('recognizes only its typed retry error', () => {
    expect(isRetryable(new ChatRulesPublishFenceRetryError(1_000))).toBe(true);
    expect(
      isRetryable({
        chatRulesPublishFenceRetryable: true,
        retryAfterMs: 1_000,
      }),
    ).toBe(false);
  });
});
