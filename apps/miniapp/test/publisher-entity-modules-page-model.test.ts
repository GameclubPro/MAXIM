import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublisherEntityListRoute,
  buildPublisherEntityModulesRoute,
  countPublisherSuggestions,
  filterPublisherSuggestions,
  getPublisherSuggestionStatusLabel,
  growPublisherSuggestionLimit,
  PUBLISHER_SUGGESTIONS_PAGE_SIZE,
  updatePublisherChatCommentSetting,
} from '../src/pages/publisher-entity-modules-page-model';

test('publisher entity module routes keep the entity id encoded and return to its catalog', () => {
  assert.equal(
    buildPublisherEntityModulesRoute({ entityType: 'channel', id: 'channel/with?symbols' }),
    '/publisher/channel/channel%2Fwith%3Fsymbols',
  );
  assert.equal(buildPublisherEntityListRoute('chat'), '/?view=chat');
  assert.equal(buildPublisherEntityListRoute('channel'), '/?view=channel');
});

test('chat comment module changes one explicit Publik-owned setting', () => {
  const current = {
    commentsEnabled: true,
    commentsAdminsEnabled: false,
    commentsChatBroadcastsEnabled: true,
  };

  assert.deepEqual(updatePublisherChatCommentSetting(current, 'commentsAdminsEnabled', true), {
    commentsEnabled: true,
    commentsAdminsEnabled: true,
    commentsChatBroadcastsEnabled: true,
  });
  assert.equal(current.commentsAdminsEnabled, false);
});

test('enabling chat comments selects the admin scope when no target is configured', () => {
  assert.deepEqual(
    updatePublisherChatCommentSetting(
      {
        commentsEnabled: false,
        commentsAdminsEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      'commentsEnabled',
      true,
    ),
    {
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsChatBroadcastsEnabled: false,
    },
  );
});

test('enabling a chat comment scope enables the master setting', () => {
  assert.deepEqual(
    updatePublisherChatCommentSetting(
      {
        commentsEnabled: false,
        commentsAdminsEnabled: false,
        commentsChatBroadcastsEnabled: false,
      },
      'commentsChatBroadcastsEnabled',
      true,
    ),
    {
      commentsEnabled: true,
      commentsAdminsEnabled: false,
      commentsChatBroadcastsEnabled: true,
    },
  );
});

test('disabling the last chat comment scope disables the master setting', () => {
  assert.deepEqual(
    updatePublisherChatCommentSetting(
      {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsChatBroadcastsEnabled: false,
      },
      'commentsAdminsEnabled',
      false,
    ),
    {
      commentsEnabled: false,
      commentsAdminsEnabled: false,
      commentsChatBroadcastsEnabled: false,
    },
  );
});

test('publisher suggestions put actionable rows first and split history explicitly', () => {
  const suggestions = [
    {
      id: 'published-new',
      text: 'Published',
      textFormat: 'plain' as const,
      authorDisplayName: null,
      createdAt: '2026-08-27T12:00:00.000Z',
      reviewStatus: 'published' as const,
      publicationId: 'publication-1',
    },
    {
      id: 'pending-old',
      text: 'Pending',
      textFormat: 'plain' as const,
      authorDisplayName: 'Admin',
      createdAt: '2026-08-27T10:00:00.000Z',
      reviewStatus: 'pending' as const,
      publicationId: null,
    },
    {
      id: 'publishing',
      text: 'Publishing',
      textFormat: 'plain' as const,
      authorDisplayName: null,
      createdAt: '2026-08-27T11:00:00.000Z',
      reviewStatus: 'publishing' as const,
      publicationId: null,
    },
    {
      id: 'drafted',
      text: 'Drafted',
      textFormat: 'plain' as const,
      authorDisplayName: null,
      createdAt: '2026-08-27T11:30:00.000Z',
      reviewStatus: 'drafted' as const,
      publicationId: 'publication-draft',
    },
    {
      id: 'cancelled',
      text: 'Cancelled',
      textFormat: 'plain' as const,
      authorDisplayName: null,
      createdAt: '2026-08-27T09:00:00.000Z',
      reviewStatus: 'cancelled' as const,
      publicationId: null,
    },
  ];

  assert.deepEqual(
    filterPublisherSuggestions(suggestions, 'pending').map((suggestion) => suggestion.id),
    ['pending-old', 'publishing'],
  );
  assert.deepEqual(
    filterPublisherSuggestions(suggestions, 'history').map((suggestion) => suggestion.id),
    ['published-new', 'drafted', 'cancelled'],
  );
  assert.deepEqual(countPublisherSuggestions(suggestions), { pending: 2, history: 3 });
});

test('publisher suggestions progressively expose all one hundred returned rows', () => {
  let limit = PUBLISHER_SUGGESTIONS_PAGE_SIZE;
  assert.equal(limit, 20);
  limit = growPublisherSuggestionLimit(limit, 100);
  assert.equal(limit, 40);
  limit = growPublisherSuggestionLimit(limit, 100);
  limit = growPublisherSuggestionLimit(limit, 100);
  limit = growPublisherSuggestionLimit(limit, 100);
  assert.equal(limit, 100);
  assert.equal(growPublisherSuggestionLimit(limit, 100), 100);
});

test('publisher suggestion labels describe the resulting action accurately', () => {
  assert.equal(getPublisherSuggestionStatusLabel('published'), 'Публикация создана');
  assert.equal(getPublisherSuggestionStatusLabel('publishing'), 'Готовится');
  assert.equal(getPublisherSuggestionStatusLabel('drafted'), 'Черновик создан');
  assert.equal(getPublisherSuggestionStatusLabel('cancelled'), 'Отклонено');
});
