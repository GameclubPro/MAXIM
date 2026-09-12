import assert from 'node:assert/strict';
import test from 'node:test';
import { chatParticipantItemSchema } from '@maxim/contracts/chat-participants';
import {
  buildAdminContactOptions,
  getAdminContactLabel,
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

test('admin contact choices keep only this roster owners and admins, excluding bots and duplicates', () => {
  const member = (userId: string, role: 'owner' | 'admin' | 'member', isBot = false) =>
    chatParticipantItemSchema.parse({
      userId,
      userDisplayName: userId,
      role,
      isBot,
      profileUrl: `https://max.ru/${userId}`,
    });
  const options = buildAdminContactOptions([
    member('owner', 'owner'),
    member('admin', 'admin'),
    member('member', 'member'),
    member('bot', 'admin', true),
    member('admin', 'admin'),
  ]);
  assert.deepEqual(
    options.map((option) => option.userId),
    ['owner', 'admin'],
  );
  assert.equal(options[1].contactUrl, 'https://max.ru/admin');
});

test('admin contact choices preserve the selected participant name in a signed handoff', () => {
  const participant = chatParticipantItemSchema.parse({
    userId: 'admin-2',
    userDisplayName: 'Мария Иванова',
    role: 'admin',
    profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-2_abcdef0123456789',
  });
  const [option] = buildAdminContactOptions([participant]);
  const url = new URL(option.contactUrl!);
  assert.equal(url.searchParams.get('start'), 'pm2_chat-1_h_admin-2_abcdef0123456789');
  assert.equal(url.searchParams.get('profile_label'), participant.userDisplayName);
  assert.equal(getAdminContactLabel(option.contactUrl!), participant.userDisplayName);
});

test('admins without a profile stay visible as unavailable, with no invented link', () => {
  const [option] = buildAdminContactOptions([
    chatParticipantItemSchema.parse({
      userId: 'admin-2',
      userDisplayName: 'Мария',
      role: 'admin',
    }),
  ]);
  assert.equal(option.contactUrl, null);
});

test('saved contact labels distinguish direct profiles without exposing handoff payloads', () => {
  assert.equal(getAdminContactLabel('https://max.ru/maria'), 'max.ru/maria');
  assert.equal(
    getAdminContactLabel('https://max.ru/bot?start=pm2_private'),
    'Администратор выбран',
  );
  assert.equal(getAdminContactLabel('invalid'), 'Администратор выбран');
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
