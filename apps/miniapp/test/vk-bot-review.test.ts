import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getVkBotReviewState,
  submitVkBotReviewPost,
  updateVkBotReviewState,
} from '../src/lib/api/vk-parsing-client';
import { createPreviewVkParsingFeed } from '../src/lib/api/preview-transport-vk';
import { buildAutopostStatus } from '../src/components/vk-parsing/autopost-status';

test('VK review uses channel Publisher routes and never supplies recipient identity from the client', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const state = {
    available: true,
    inboxConnected: true,
    isRecipient: true,
    recipientConfigured: true,
    paused: false,
    pendingCount: 2,
    botUrl: 'https://max.ru/publik_bot',
  };
  const api = {
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return state;
    },
    requestKeepalive: () => {},
  };
  assert.deepEqual(await getVkBotReviewState(api, '-1'), state);
  await updateVkBotReviewState(api, '-1', { action: 'CONNECT' });
  await submitVkBotReviewPost(api, '-1', 'post/1');
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/publisher/entities/channel/-1/vk-parsing/bot-review',
      '/publisher/entities/channel/-1/vk-parsing/bot-review',
      '/publisher/entities/channel/-1/vk-parsing/bot-review/posts/post%2F1',
    ],
  );
  assert.equal(calls[1]?.init?.body, JSON.stringify({ action: 'CONNECT' }));
});

test('bot review never appears as automatic delivery even with legacy auto flags', () => {
  const feed = createPreviewVkParsingFeed('-1', new Date());
  const result = buildAutopostStatus(
    { ...feed.settings, autoPublishEnabled: true, autoPublishKillSwitchEnabled: false },
    feed.sources.map((source) => ({
      ...source,
      publishMode: 'BOT_REVIEW',
      importEnabled: true,
      autoPublishEnabled: true,
    })),
  );
  assert.equal(result.title, 'На проверке');
});
