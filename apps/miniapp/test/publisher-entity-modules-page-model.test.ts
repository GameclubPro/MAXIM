import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublisherEntityListRoute,
  buildPublisherEntityModulesRoute,
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

  assert.deepEqual(
    updatePublisherChatCommentSetting(current, 'commentsAdminsEnabled', true),
    {
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsChatBroadcastsEnabled: true,
    },
  );
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
