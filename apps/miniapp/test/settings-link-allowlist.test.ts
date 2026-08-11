import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWLIST_NAVIGATION_POLICY_DESCRIPTION,
  NAVIGATION_ALLOWLIST_TARGET_OPTIONS,
  STRICT_NAVIGATION_POLICY_DESCRIPTION,
  formatNavigationAllowlistEntryKindLabel,
  formatNavigationAllowlistEntryTarget,
  getNavigationAllowlistTargetOption,
  resolveNavigationAllowlistEntryKind,
} from '../src/pages/settings/settings-link-allowlist';

test('link allowlist composer exposes every supported navigation target kind', () => {
  assert.deepEqual(
    NAVIGATION_ALLOWLIST_TARGET_OPTIONS.map((option) => option.value),
    ['WEB_DOMAIN', 'WEB_EXACT', 'MAX_PROFILE', 'MAX_ENTITY', 'MINI_APP'],
  );
  assert.equal(new Set(NAVIGATION_ALLOWLIST_TARGET_OPTIONS.map((option) => option.label)).size, 5);

  for (const option of NAVIGATION_ALLOWLIST_TARGET_OPTIONS) {
    assert.ok(option.placeholder.length > 0);
    assert.ok(option.ariaLabel.length > 0);
    assert.equal(getNavigationAllowlistTargetOption(option.value), option);
  }

  const maxEntity = getNavigationAllowlistTargetOption('MAX_ENTITY');
  assert.equal(maxEntity.inputMode, 'url');
  assert.match(maxEntity.label, /^Ссылка/u);
  assert.match(maxEntity.placeholder, /^https:\/\/max\.ru\//u);
  assert.doesNotMatch(maxEntity.placeholder, /\bID\b|^-?\d/u);
});

test('allowlist labels resolve typed responses and legacy response fallbacks', () => {
  assert.equal(
    formatNavigationAllowlistEntryKindLabel({
      domain: 'user-id:42',
      target: 'user-id:42',
      normalizedValue: 'max-profile:user-id%3A42',
      matchType: 'EXACT',
      kind: 'MAX_PROFILE',
      removeAfterAt: null,
    }),
    'Профиль MAX',
  );
  assert.equal(
    formatNavigationAllowlistEntryTarget({
      domain: 'user-id:42',
      target: 'user-id:42',
      normalizedValue: 'max-profile:user-id%3A42',
    }),
    'max://user/42',
  );
  assert.equal(
    formatNavigationAllowlistEntryTarget({
      domain: 'url:https://max.ru/chats/team',
      target: 'url:https://max.ru/chats/team',
      normalizedValue: 'max-entity:url%3Ahttps%3A%2F%2Fmax.ru%2Fchats%2Fteam',
    }),
    'https://max.ru/chats/team',
  );
  assert.equal(
    formatNavigationAllowlistEntryKindLabel({
      normalizedValue: 'max-entity:chat-id%3A-42',
      matchType: 'EXACT',
      kind: 'MAX_ENTITY',
    }),
    'Устаревшее правило MAX',
  );
  assert.equal(
    resolveNavigationAllowlistEntryKind({
      normalizedValue: 'domain:docs.max.ru',
      matchType: 'DOMAIN',
    }),
    'WEB_DOMAIN',
  );
  assert.equal(
    resolveNavigationAllowlistEntryKind({
      normalizedValue: 'https://example.com/path',
      matchType: 'EXACT',
    }),
    'WEB_EXACT',
  );
});

test('strict link policy copy includes structured clickable navigation', () => {
  assert.match(STRICT_NAVIGATION_POLICY_DESCRIPTION, /ссылки/u);
  assert.match(STRICT_NAVIGATION_POLICY_DESCRIPTION, /кнопки/u);
  assert.match(STRICT_NAVIGATION_POLICY_DESCRIPTION, /упоминания/u);
  assert.match(ALLOWLIST_NAVIGATION_POLICY_DESCRIPTION, /разрешённых целей/u);
});
