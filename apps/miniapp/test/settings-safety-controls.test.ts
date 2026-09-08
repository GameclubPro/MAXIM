import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsSectionSaveFooter } from '../src/pages/settings/settings-section-save-footer';

const stopWordsSource = readFileSync(
  new URL('../src/pages/settings/settings-stop-words-editor.tsx', import.meta.url),
  'utf8',
);
const stopWordsSectionSource = readFileSync(
  new URL('../src/pages/settings/settings-stop-words-section.tsx', import.meta.url),
  'utf8',
);
const commandSource = readFileSync(
  new URL('../src/pages/settings/settings-admin-commands-section.tsx', import.meta.url),
  'utf8',
);
const hintSource = readFileSync(
  new URL('../src/pages/settings/settings-hint-anchor.tsx', import.meta.url),
  'utf8',
);
const duplicatePhotoSource = readFileSync(
  new URL('../src/pages/settings/settings-duplicate-photo-controls.tsx', import.meta.url),
  'utf8',
);

function renderFooter(overrides: Partial<Parameters<typeof SettingsSectionSaveFooter>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SettingsSectionSaveFooter, {
      section: 'links',
      isSavingSettings: false,
      savingSection: null,
      isApplyingSectionToAll: false,
      applyingSection: null,
      onSaveSection: () => undefined,
      ...overrides,
    }),
  );
}

test('a section cannot start saving while another section is still being saved or applied', () => {
  assert.doesNotMatch(renderFooter(), /disabled=""/u);
  assert.match(renderFooter({ isSavingSettings: true, savingSection: 'night' }), /disabled=""/u);
  assert.match(
    renderFooter({ isApplyingSectionToAll: true, applyingSection: 'stopWords' }),
    /disabled=""/u,
  );
});

test('the active save action announces that it is busy', () => {
  const html = renderFooter({ isApplyingSectionToAll: true, applyingSection: 'links' });
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /Сохраняем/u);
});

test('stop-word catalog mounts the recoverable editor only when its panel is open', () => {
  assert.match(stopWordsSectionSource, /<SettingsSectionToggle/u);
  assert.match(stopWordsSectionSource, /<SettingsDrilldownPanel/u);
  assert.match(
    stopWordsSectionSource,
    /recoverableLazyNamedComponent<SettingsStopWordsSectionProps>/u,
  );
  assert.match(stopWordsSectionSource, /\(\) => import\('\.\/settings-stop-words-editor'\)/u);
  assert.match(
    stopWordsSectionSource,
    /\{expanded \? \(\s*<Suspense fallback=\{<Spinner[^>]+\/>\}>\s*<LazySettingsStopWordsEditor \{\.\.\.props\} \/>/u,
  );
  assert.doesNotMatch(
    stopWordsSectionSource,
    /<input|LazyMessageLimitsBlockedWordPresets|useHintPopoverAutoPosition/u,
  );
  assert.match(stopWordsSource, /import type \{ SettingsStopWordsSectionProps \}/u);
  assert.doesNotMatch(stopWordsSource, /SettingsDrilldownPanel|GlassCard/u);
  assert.match(
    stopWordsSource,
    /import type \{[^}]*HintKey[^}]*\} from '\.\/settings-page-helpers'/u,
  );
  assert.match(
    stopWordsSource,
    /import \{ EditToggleButton \} from '\.\/settings-edit-toggle-button'/u,
  );
  assert.match(
    stopWordsSource,
    /\(\) => import\('\.\.\/\.\.\/components\/bot-speech-message-editor'\)/u,
  );
  assert.match(
    stopWordsSource,
    /\(\) => import\('\.\.\/\.\.\/components\/message-limits-blocked-word-presets'\)/u,
  );
});

test('stop-list keyboard submission respects the same disabled and composition states as buttons', () => {
  assert.equal(stopWordsSource.match(/!event\.nativeEvent\.isComposing/gu)?.length, 2);
  assert.match(
    stopWordsSource,
    /if \(!isMessageLimitsBlockedWordsApplyDisabled\) \{\s*addMessageLimitsBlockedWords\(\)/u,
  );
  assert.match(
    stopWordsSource,
    /if \(!isMessageLimitsBlockedDomainsApplyDisabled\) \{\s*addMessageLimitsBlockedDomains\(\)/u,
  );
  assert.match(stopWordsSource, /inputMode="url"/u);
  assert.match(stopWordsSource, /aria-invalid=\{Boolean\(messageLimitsBlockedWordsError\)\}/u);
  assert.match(stopWordsSource, /aria-invalid=\{Boolean\(messageLimitsBlockedDomainsError\)\}/u);
});

test('stop-list explanations are on demand and describe shared actions and allowed exceptions', () => {
  assert.match(stopWordsSource, /hintKey="stopWordsImageText"/u);
  assert.match(stopWordsSource, /hintKey="stopWordsText"/u);
  assert.match(stopWordsSource, /hintKey="stopWordsDomains"/u);
  const normalizedSource = stopWordsSource.replace(/\s+/gu, ' ');
  assert.match(normalizedSource, /действия берутся из раздела «Ограничения»/u);
  assert.match(normalizedSource, /Разрешённые исключения из раздела «Ссылки»/u);
  assert.doesNotMatch(normalizedSource, /мут и бан/u);
});

test('command fields preserve case and expose limits, errors, and individual explanations', () => {
  assert.match(commandSource, /maxLength=\{ADMIN_COMMAND_NAME_MAX_LENGTH\}/u);
  assert.match(commandSource, /autoCapitalize="none"/u);
  assert.match(commandSource, /autoCorrect="off"/u);
  assert.match(commandSource, /aria-invalid=\{Boolean\(error\)\}/u);
  assert.equal(commandSource.match(/hintKey: 'admin/gu)?.length, 7);
  assert.match(commandSource, /hintKey=\{item\.hintKey\}/u);
});

test('settings help is labelled and describes its trigger only while visible', () => {
  assert.match(hintSource, /data-hint-key=\{hintKey\}/u);
  assert.match(hintSource, /title=\{label\}/u);
  assert.match(
    hintSource,
    /aria-describedby=\{isOpen \? `settings-hint-\$\{hintKey\}` : undefined\}/u,
  );
  assert.match(hintSource, /role="note"\s*aria-label=\{label\}/u);
});

test('lazy settings help does not import the full settings helper module at runtime', () => {
  for (const source of [commandSource, duplicatePhotoSource]) {
    assert.match(source, /import \{ SettingsHintAnchor \} from '\.\/settings-hint-anchor'/u);
    assert.match(source, /import type \{[^}]*HintKey[^}]*\} from '\.\/settings-page-helpers'/u);
  }
  assert.doesNotMatch(hintSource, /@maxim\/contracts|settings-page-helpers/u);
});
