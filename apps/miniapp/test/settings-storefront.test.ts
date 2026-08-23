import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sectionSource = readFileSync(
  new URL('../src/pages/settings/settings-storefront-section.tsx', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const stateSource = readFileSync(
  new URL('../src/pages/settings-page-state.ts', import.meta.url),
  'utf8',
);

test('storefront settings expose the admin-only toggle and keep the allowlist conditional', () => {
  assert.match(sectionSource, /karavanStorefrontAdminsOnly/u);
  assert.match(sectionSource, /draft\.karavanStorefrontEnabled\s*\?/u);
  assert.match(sectionSource, /settings-storefront__allowlist/u);
  assert.match(sectionSource, /Добавить пользователя/u);
  assert.match(sectionSource, /openMaxBotLinkAndClose/u);
  assert.match(sectionSource, /revokeKaravanStorefrontAllowlistEntry/u);
});

test('chat settings page scopes both storefront settings fields and passes the authenticated transport', () => {
  assert.match(
    stateSource,
    /storefront:\s*\[\s*'karavanStorefrontEnabled',\s*'karavanStorefrontAdminsOnly'/u,
  );
  assert.match(pageSource, /<SettingsStorefrontSection/u);
  assert.match(pageSource, /api=\{api\}/u);
  assert.match(pageSource, /chatId=\{chatId\}/u);
  assert.match(pageSource, /onAdminsOnlyChange=/u);
});
