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
      profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
    }),
    'https://max.ru/designer',
  );
});

test('resolveAdminContactProfileUrl falls back to the handoff url without a direct profile url', () => {
  assert.equal(
    resolveAdminContactProfileUrl({
      profileUrl: null,
      profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
    }),
    'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
  );
});

test('normalizeAdminContactProfileUrl keeps only ordinary web links', () => {
  assert.equal(normalizeAdminContactProfileUrl(' max://user/admin-1 '), null);
  assert.equal(
    normalizeAdminContactProfileUrl('https://max.ru/designer '),
    'https://max.ru/designer',
  );
});
