import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPreviewVkParsingPage,
  createPreviewVkParsingFeed,
} from '../src/lib/api/preview-transport-vk';
import {
  buildSourceDeliveryUpdate,
  describeVkSource,
  resolveSourceDeliveryMode,
  vkDraftFingerprint,
  vkPostBlockedReason,
  vkReviewLabel,
  vkAllDayScheduleUpdate,
  vkSourceLinkKey,
} from '../src/components/vk-parsing/workflow';

const feed = () => createPreviewVkParsingFeed('-1', new Date('2026-09-18T10:00:00Z'));

test('all-day publication removes both global time restrictions in one update', () => {
  assert.deepEqual(vkAllDayScheduleUpdate(), {
    workHoursStart: '00:00',
    workHoursEnd: '00:00',
    quietHoursStart: null,
    quietHoursEnd: null,
  });
});

test('VK source identity treats public host aliases and scheme-less links equally', () => {
  for (const value of [
    'https://vk.ru/community',
    'vk.com/community',
    'https://m.vk.com/COMMUNITY?w=wall-1_2',
    '@community',
  ])
    assert.equal(vkSourceLinkKey(value), 'community');
  assert.equal(vkSourceLinkKey('https://not-vk.test/community'), '');
});

test('one delivery choice sets routing and automation together', () => {
  assert.deepEqual(buildSourceDeliveryUpdate('MANUAL'), {
    publishMode: 'QUEUE',
    autoPublishEnabled: false,
  });
  assert.deepEqual(buildSourceDeliveryUpdate('QUEUE'), {
    publishMode: 'QUEUE',
    autoPublishEnabled: true,
  });
  assert.deepEqual(buildSourceDeliveryUpdate('BOT_REVIEW'), {
    publishMode: 'BOT_REVIEW',
    autoPublishEnabled: false,
  });
  assert.equal(
    resolveSourceDeliveryMode({ publishMode: 'QUEUE', autoPublishEnabled: false }),
    'MANUAL',
  );
  assert.equal(
    resolveSourceDeliveryMode({ publishMode: 'BOT_REVIEW', autoPublishEnabled: true }),
    'BOT_REVIEW',
  );
  assert.equal(
    resolveSourceDeliveryMode({ publishMode: 'REVIEW', autoPublishEnabled: false }),
    'REVIEW',
  );
});

test('source health never labels a failed source active or a globally disabled source automatic', () => {
  const data = feed();
  const source = data.sources[0]!;
  assert.equal(describeVkSource({ ...source, syncStatus: 'ERROR' }, data.settings).tone, 'danger');
  assert.equal(
    describeVkSource(source, { ...data.settings, autoPublishEnabled: false }).label,
    'В приложении',
  );
  assert.equal(
    describeVkSource(
      { ...source, publishMode: 'BOT_REVIEW' },
      { ...data.settings, autoPublishEnabled: false },
    ).label,
    'В личку',
  );
  assert.equal(
    describeVkSource({ ...source, importEnabled: false }, data.settings).label,
    'На паузе',
  );
});

test('incoming, scheduled and published views have distinct, server-compatible meanings', () => {
  const data = feed();
  data.posts.push({
    ...data.posts[0]!,
    id: 'cancelled',
    publishCancelledAt: new Date().toISOString(),
  });
  const incoming = buildPreviewVkParsingPage(data, new URLSearchParams({ status: 'NEW' }));
  assert.ok(incoming.posts.length > 0);
  assert.ok(
    incoming.posts.every(
      (post) => post.status === 'NEW' && !post.publishQueuedAt && !post.publishCancelledAt,
    ),
  );
  const queued = buildPreviewVkParsingPage(data, new URLSearchParams({ status: 'QUEUED' }));
  assert.ok(
    queued.posts.every((post) => post.publishQueuedAt && ['NEW', 'FAILED'].includes(post.status)),
  );
  const published = buildPreviewVkParsingPage(data, new URLSearchParams({ status: 'PUBLISHED' }));
  assert.ok(published.posts.some((post) => post.status === 'CHANGED_AFTER_PUBLISH'));
  assert.ok(!incoming.posts.some((post) => queued.posts.some((item) => item.id === post.id)));
});

test('queue filters and pagination preserve chronological send order', () => {
  const data = feed();
  const queued = data.posts.find((post) => post.publishQueuedAt)!;
  data.posts.push({ ...queued, id: 'earlier', publishScheduledAt: '2026-09-18T10:01:00Z' });
  const result = buildPreviewVkParsingPage(
    data,
    new URLSearchParams({ status: 'QUEUED', sourceId: queued.sourceId, limit: '1' }),
  );
  assert.equal(result.posts[0]!.id, 'earlier');
  assert.equal(result.pagination.hasMore, true);
});

test('unsettled sends cannot be presented as editable or retryable', () => {
  const post = feed().posts[0]!;
  assert.equal(vkPostBlockedReason(post), null);
  assert.ok(vkPostBlockedReason({ ...post, lastError: ' [max.send_ambiguous] timeout' }));
  assert.ok(
    vkPostBlockedReason({ ...post, autoPublishError: '[max.send_confirmed_persistence_pending]' }),
  );
  assert.ok(vkPostBlockedReason({ ...post, publishQueuedAt: new Date().toISOString() }));
  assert.ok(vkPostBlockedReason({ ...post, publishLockedAt: new Date().toISOString() }));
  assert.ok(
    vkPostBlockedReason({
      ...post,
      botReview: { status: 'PENDING', deliveryState: 'AMBIGUOUS', lastError: null },
    }),
  );
});

test('review labels separate missing tasks, successful delivery and delivery failure', () => {
  assert.equal(vkReviewLabel({ botReview: null }), 'Готов к согласованию');
  assert.equal(
    vkReviewLabel({ botReview: { status: 'PENDING', deliveryState: 'ERROR', lastError: null } }),
    'Не удалось отправить',
  );
  assert.equal(
    vkReviewLabel({
      botReview: { status: 'PENDING', deliveryState: 'DELIVERED', lastError: null },
    }),
    'Ждёт вашего решения',
  );
});

test('editor dirty state includes media selection and text formatting', () => {
  const draft = {
    text: 'Post',
    textFormat: 'plain',
    photoUrls: ['https://example.com/photo.jpg'],
    videoUrls: [],
    linkUrls: [],
  };
  assert.equal(vkDraftFingerprint(draft), vkDraftFingerprint({ ...draft }));
  assert.notEqual(vkDraftFingerprint(draft), vkDraftFingerprint({ ...draft, photoUrls: [] }));
  assert.notEqual(
    vkDraftFingerprint(draft),
    vkDraftFingerprint({ ...draft, textFormat: 'markdown' }),
  );
});
