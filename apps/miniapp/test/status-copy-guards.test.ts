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
const publicationsSource = readFileSync(
  new URL('../src/pages/publications-page.tsx', import.meta.url),
  'utf8',
);
const broadcastComposerSource = readFileSync(
  new URL('../src/components/broadcast-content-composer.tsx', import.meta.url),
  'utf8',
);
const shellSource = readFileSync(new URL('../src/components/shell.tsx', import.meta.url), 'utf8');
const chatsPageCss = readFileSync(new URL('../src/pages/chats-page.css', import.meta.url), 'utf8');
const chatsPageNativeCss = readFileSync(
  new URL('../src/pages/chats-page-native.css', import.meta.url),
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

test('channel comments use in-app terminology without a separate button mode', () => {
  assert.equal(channelSettingsSource.match(/title="Комментарии в приложении"/gu)?.length, 2);
  assert.match(channelSettingsSource, /placeholder="Например: поделитесь мнением о публикации"/u);
  assert.doesNotMatch(
    channelSettingsSource,
    /autoPostButtonsMode|Системные кнопки автопостинга|channel-settings-mode-card--broadcast-buttons/u,
  );
  assert.doesNotMatch(channelSettingsSource, /title="Обсуждение"|О чём обсуждение/u);
  assert.doesNotMatch(shellSource, /Обсуждение|Диалог обсуждения/u);
});

test('Major chat settings do not expose the Publisher-owned comments module', () => {
  assert.doesNotMatch(
    chatSettingsSource,
    /SettingsCommentsSection|commentsCardSummary|commentsCardStatus|commentsAdminsEnabled \? 'сообщения админов'/u,
  );
});

test('publication previews include saved channel system buttons', () => {
  assert.match(
    publicationsSource,
    /const systemButtons = buildPublicationSystemButtons\(previewTarget \? \[previewTarget\] : \[\]\)/u,
  );
  assert.match(publicationsSource, /systemButtons=\{systemButtons\}/u);
  assert.match(publicationsSource, /previewTargetKey=\{resolvedPreviewTargetKey\}/u);
  assert.doesNotMatch(publicationsSource, /Автокнопки|Кнопки · нет/u);
  assert.match(
    publicationsSource,
    /const visibleCustomButtonCount = visibleCustomButtons\.length/u,
  );
  assert.match(
    broadcastComposerSource,
    /const previewButtonLabel = formatBroadcastButtonsPreview\(\[[\s\S]*?\.\.\.previewSystemButtons/u,
  );
  assert.match(
    broadcastComposerSource,
    /const openButtonsCount = showButtonsLabel \? previewButtons\.length : previewButtonCount/u,
  );
  assert.match(
    channelSettingsSource,
    /async function handleSendChannelBroadcast\(\)[\s\S]*?await saveChannelSettingsForBroadcast\(\)[\s\S]*?navigate\('\/publications'\)/u,
  );
  assert.doesNotMatch(channelSettingsSource, /navigate\(['`]\/publications\?compose=1/u);
});

test('home folds sync state into one refresh control without technical status copy', () => {
  assert.match(chatsPageSource, /'chats-command__refresh'/u);
  assert.match(chatsPageSource, /chats-command__sync-ring/u);
  assert.doesNotMatch(chatsPageSource, /chats-command__sync-indicator|chats-command__sync-check/u);
  assert.doesNotMatch(chatsPageSource, /Пауза|Кэш|Сверяем|Готово ·/u);
  assert.match(
    chatsPageCss,
    /\.chats-command__icon-button \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u,
  );
  assert.match(chatsPageNativeCss, /\.chats-command__refresh\.is-error/u);
  assert.match(chatsPageCss, /@keyframes chats-sync-indicator-spin/u);
  assert.match(
    chatsPageSource,
    /hasError: Boolean\(queryError\)[\s\S]*?isBackoffActive: activeEntitiesState\.isBackoffActive/u,
  );
  assert.match(chatsPageSource, /isRefreshing: isFetching \|\| isManualRefreshInProgressByState/u);
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
