import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatsPageSource = readFileSync(
  new URL('../src/pages/chats-page.tsx', import.meta.url),
  'utf8',
);
const chatsPageCss = readFileSync(new URL('../src/pages/chats-page.css', import.meta.url), 'utf8');
const chatsPageNativeCss = readFileSync(
  new URL('../src/pages/chats-page-native.css', import.meta.url),
  'utf8',
);
const shellSource = readFileSync(new URL('../src/components/shell.tsx', import.meta.url), 'utf8');
const sheetsSource = readFileSync(
  new URL('../src/pages/home-entity-sheets.tsx', import.meta.url),
  'utf8',
);
const onboardingSource = readFileSync(
  new URL('../src/components/chat-onboarding-section.tsx', import.meta.url),
  'utf8',
);

test('entity cards open settings from the primary row and keep statistics in secondary actions', () => {
  assert.doesNotMatch(chatsPageSource, /chat-card__primary-link/u);
  assert.match(chatsPageSource, /className="chat-card__primary"/u);
  assert.match(chatsPageSource, /className="chat-card__more"/u);
  assert.match(chatsPageSource, /to=\{settingsRoute\}/u);
  assert.match(chatsPageSource, /`\/channel\/\$\{entityId\}\/settings`/u);
  assert.match(chatsPageSource, /`\/chat\/\$\{entityId\}\/settings`/u);
  assert.doesNotMatch(chatsPageSource, /<details\b/u);
  assert.match(chatsPageSource, /aria-haspopup="dialog"/u);
  assert.match(chatsPageSource, /import\('\.\/home-entity-sheets'\)/u);
  assert.doesNotMatch(chatsPageSource, /from '\.\.\/lib\/dialog-focus'/u);
  assert.match(sheetsSource, /\/stats\?section=overview/u);
  assert.match(sheetsSource, /\/events\?section=activity/u);
  assert.match(sheetsSource, /<strong>Статистика<\/strong>/u);
  assert.doesNotMatch(sheetsSource, /<strong>Настройки<\/strong>/u);
});

test('root navigation has one managed-entities destination and no remembered-entity shortcuts', () => {
  const labels = shellSource.match(/className="bottom-nav__label"/gu) ?? [];

  assert.equal(labels.length, 2);
  assert.match(shellSource, />Объекты</u);
  assert.match(shellSource, />Посты</u);
  assert.doesNotMatch(shellSource, /bottom-nav__label">Настройки/u);
  assert.doesNotMatch(shellSource, /bottom-nav__label">\{activityNavLabel\}/u);
});

test('home sheets are named, focus-trapped and leave the shell controls inert', () => {
  assert.match(sheetsSource, /useDialogFocusTrap\(true/u);
  assert.match(sheetsSource, /aria-labelledby=\{titleId\}/u);
  assert.match(sheetsSource, /className="favorite-picker__backdrop"[\s\S]*?onClick=\{onClose\}/u);
  assert.match(chatsPageSource, /homeRoot\.inert = true/u);
  assert.match(chatsPageSource, /bottomNav\.inert = true/u);
  assert.match(chatsPageSource, /event\.key !== 'Escape'/u);
});

test('compact home controls keep 44px targets and category labels on narrow screens', () => {
  assert.match(chatsPageCss, /\.chats-command__icon-button \{[\s\S]*?min-width: 44px/u);
  assert.match(chatsPageCss, /\.favorite-filter__chip \{[\s\S]*?min-height: 44px/u);
  assert.match(chatsPageNativeCss, /\.chat-card__primary \{[\s\S]*?min-height: 78px/u);
  assert.match(chatsPageNativeCss, /\.chat-card__more \{[\s\S]*?min-width: 44px/u);
  assert.match(
    chatsPageCss,
    /\.favorite-filter__chip:not\(:first-child\) span,[\s\S]*?display: inline/u,
  );
});

test('empty onboarding keeps the refresh action before optional detailed instructions', () => {
  const refreshIndex = onboardingSource.indexOf('onboarding-refresh');
  const instructionsIndex = onboardingSource.indexOf('onboarding-instructions');
  const cards = onboardingSource.match(/<GlassCard\b/gu) ?? [];

  assert.ok(refreshIndex >= 0);
  assert.ok(instructionsIndex > refreshIndex);
  assert.equal(cards.length, 1);
  assert.match(onboardingSource, /<summary>Показать инструкцию<\/summary>/u);
  assert.match(chatsPageSource, /isRefreshBlocked=\{isManualRefreshBlocked\}/u);
  assert.match(onboardingSource, /isRefreshBlocked && refreshLabel/u);
});
