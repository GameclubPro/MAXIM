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
const editorSource = readFileSync(
  new URL('../src/pages/settings/settings-storefront-text-editor.tsx', import.meta.url),
  'utf8',
);

test('storefront copy editor shares runtime defaults, text limits, and the section draft', () => {
  assert.match(editorSource, /resolveKaravanStorefrontTexts\(draft\)/u);
  assert.match(editorSource, /maxLength=\{KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH\}/u);
  assert.match(editorSource, /maxLength=\{KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH\}/u);
  assert.match(editorSource, /aria-pressed=\{variant === value\}/u);
  assert.match(editorSource, /Вернуть стандартные тексты витрины/u);
  assert.match(
    sectionSource,
    /<SettingsStorefrontTextEditor draft=\{draft\} onChange=\{onTextChange\}/u,
  );
  assert.match(pageSource, /onTextChange=\{setFieldValue\}/u);
  for (const field of ['Message', 'OpenButton', 'CatalogButton', 'CreateButton']) {
    assert.ok(stateSource.includes(`'karavanStorefront${field}Text'`));
  }
});

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
