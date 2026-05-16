import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAdminContactProfileUrl,
  resolveAdminContactProfileUrl,
} from '../src/lib/admin-contact-profile-url';

test('resolveAdminContactProfileUrl prefers the direct profile url when available', () => {
  assert.equal(
    resolveAdminContactProfileUrl({
      profileUrl: 'https://max.ru/designer',
      displayName: 'Designer',
      profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
    }),
    'https://max.ru/designer',
  );
});

test('resolveAdminContactProfileUrl falls back to a labeled handoff url', () => {
  assert.equal(
    resolveAdminContactProfileUrl({
      profileUrl: null,
      profileHandoffUrl:
        'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789&profile_label=%D0%90%D0%B4%D0%BC%D0%B8%D0%BD',
    }),
    'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789&profile_label=%D0%90%D0%B4%D0%BC%D0%B8%D0%BD',
  );
});

test('resolveAdminContactProfileUrl adds a profile label to profile handoff urls', () => {
  assert.equal(
    resolveAdminContactProfileUrl({
      displayName: 'Админ MAX',
      profileUrl: null,
      profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
    }),
    'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789&profile_label=%D0%90%D0%B4%D0%BC%D0%B8%D0%BD+MAX',
  );
});

test('resolveAdminContactProfileUrl rejects unlabeled profile handoff urls without profile data', () => {
  assert.equal(
    resolveAdminContactProfileUrl({
      profileUrl: null,
      profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
    }),
    null,
  );
});

test('normalizeAdminContactProfileUrl keeps only ordinary web links', () => {
  assert.equal(normalizeAdminContactProfileUrl(' max://user/admin-1 '), null);
  assert.equal(
    normalizeAdminContactProfileUrl('https://max.ru/designer '),
    'https://max.ru/designer',
  );
});
