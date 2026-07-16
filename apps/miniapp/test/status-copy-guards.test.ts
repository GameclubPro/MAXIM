import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatsPageSource = readFileSync(
  new URL('../src/pages/chats-page.tsx', import.meta.url),
  'utf8',
);
const chatSettingsSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const channelSettingsSource = readFileSync(
  new URL('../src/pages/channel-settings-page.tsx', import.meta.url),
  'utf8',
);
const chatsPageCss = readFileSync(
  new URL('../src/pages/chats-page.css', import.meta.url),
  'utf8',
);
const componentsCss = readFileSync(
  new URL('../src/styles/components.css', import.meta.url),
  'utf8',
);

test('settings headers do not expose abbreviated draft or saving statuses', () => {
  for (const source of [chatSettingsSource, channelSettingsSource]) {
    assert.doesNotMatch(source, /['"](?:Черн\.|Сохр\.)['"]/u);
  }

  assert.doesNotMatch(chatSettingsSource, /compactHeaderStatusLabel|showHeaderStatus/u);
  assert.doesNotMatch(channelSettingsSource, /compactHeaderStatusLabel|headerStatusTone/u);
});

test('home uses a stable icon indicator without technical status copy', () => {
  assert.match(chatsPageSource, /chats-command__sync-indicator/u);
  assert.match(chatsPageSource, /chats-command__sync-check/u);
  assert.doesNotMatch(chatsPageSource, /Пауза|Кэш|Сверяем|Готово ·/u);
  assert.match(
    chatsPageCss,
    /\.chats-command__sync-indicator \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u,
  );
  assert.match(chatsPageCss, /@keyframes chats-sync-indicator-spin/u);
  assert.match(
    chatsPageSource,
    /hasError: Boolean\(queryError\)[\s\S]*?isBackoffActive: activeEntitiesState\.isBackoffActive/u,
  );
  assert.match(
    chatsPageSource,
    /isRefreshing: isFetching \|\| isManualRefreshInProgressByState/u,
  );
  assert.match(
    chatsPageSource,
    /if \(options\.isLoading \|\| options\.isRefreshing\)[\s\S]*?if \(options\.hasError\)[\s\S]*?if \(options\.isBackoffActive\)/u,
  );
  assert.match(chatsPageSource, /<XmarkGlyph aria-hidden \/>/u);
});

test('settings save retry stays icon-only, announced and dark-theme semantic', () => {
  assert.match(
    channelSettingsSource,
    /role="status"[\s\S]*?aria-live="assertive"[\s\S]*?compact-page-header__sr/u,
  );
  assert.match(
    componentsCss,
    /\.compact-page-header__retry \{[\s\S]*?background: color-mix\(in srgb, var\(--danger\) 11%, var\(--surface-card\)\);[\s\S]*?color: var\(--danger\);/u,
  );
});
