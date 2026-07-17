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

test('entity cards expose direct settings, statistics and category actions', () => {
  assert.doesNotMatch(chatsPageSource, /chat-card__primary-link/u);
  assert.match(chatsPageSource, /className="chat-card__title-link"/u);
  assert.match(chatsPageSource, /chat-card__action chat-card__action--statistics/u);
  assert.match(chatsPageSource, /chat-card__action chat-card__action--settings/u);
  assert.match(chatsPageSource, /className=\{cn\([\s\S]*?'chat-card__category'/u);
  assert.match(chatsPageSource, /to=\{settingsRoute\}/u);
  assert.match(chatsPageSource, /to=\{statisticsRoute\}/u);
  assert.match(chatsPageSource, /`\/channel\/\$\{entityId\}\/settings`/u);
  assert.match(chatsPageSource, /`\/chat\/\$\{entityId\}\/settings`/u);
  assert.match(chatsPageSource, /`\/channel\/\$\{entityId\}\/stats\?section=overview`/u);
  assert.match(chatsPageSource, /`\/chat\/\$\{entityId\}\/events\?section=activity`/u);
  assert.doesNotMatch(chatsPageSource, /<details\b/u);
  assert.match(chatsPageSource, /aria-haspopup="dialog"/u);
  assert.match(chatsPageSource, /import\('\.\/home-entity-sheets'\)/u);
  assert.doesNotMatch(chatsPageSource, /from '\.\.\/lib\/dialog-focus'/u);
  assert.doesNotMatch(chatsPageSource, /chat-card__more|MoreGlyph/u);
  assert.doesNotMatch(sheetsSource, /home-actions__panel|<strong>Статистика<\/strong>/u);
});

test('root navigation exposes chats, channels and posts as primary destinations', () => {
  const labels = shellSource.match(/className="bottom-nav__label"/gu) ?? [];

  assert.equal(labels.length, 3);
  assert.match(shellSource, /buildManagedEntitiesRoute\('chat'\)/u);
  assert.match(shellSource, /buildManagedEntitiesRoute\('channel'\)/u);
  assert.match(shellSource, />Чаты</u);
  assert.match(shellSource, />Каналы</u);
  assert.match(shellSource, />Посты</u);
  assert.match(shellSource, /selectedRootEntityType === 'chat'/u);
  assert.match(shellSource, /selectedRootEntityType === 'channel'/u);
  assert.doesNotMatch(chatsPageSource, /chats-command__tabs/u);
  assert.doesNotMatch(shellSource, /bottom-nav__label">Настройки/u);
  assert.doesNotMatch(shellSource, /bottom-nav__label">\{activityNavLabel\}/u);
  assert.match(shellSource, /const shouldShowBottomNav = isChatsRoute \|\| isPublicationsRoute/u);
  assert.match(shellSource, /\{shouldShowBottomNav \? \(/u);
});

test('home sheets are named, focus-trapped and leave the shell controls inert', () => {
  assert.match(sheetsSource, /useDialogFocusTrap\(true/u);
  assert.match(sheetsSource, /aria-labelledby=\{titleId\}/u);
  assert.match(sheetsSource, /className="favorite-picker__backdrop"[\s\S]*?onClick=\{onClose\}/u);
  assert.match(chatsPageSource, /homeRoot\.inert = true/u);
  assert.match(chatsPageSource, /bottomNav\.inert = true/u);
  assert.match(chatsPageSource, /event\.key !== 'Escape'/u);
});

test('compact home controls keep direct 44px actions and one filter control', () => {
  assert.match(chatsPageCss, /\.chats-command__icon-button \{[\s\S]*?min-width: 44px/u);
  assert.match(chatsPageNativeCss, /\.favorite-filter__trigger \{[\s\S]*?min-width: 44px/u);
  assert.match(chatsPageNativeCss, /\.chat-card__main \{[\s\S]*?min-height: 88px/u);
  assert.match(chatsPageNativeCss, /\.chat-card__category \{[\s\S]*?min-height: 44px/u);
  assert.match(chatsPageNativeCss, /\.chat-card__action \{[\s\S]*?min-width: 44px/u);
  assert.match(
    chatsPageNativeCss,
    /\.chats-command__tools \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) repeat\(2, 44px\)/u,
  );
  assert.match(chatsPageNativeCss, /\.chat-card__category span \{[\s\S]*?text-overflow: ellipsis/u);
  assert.match(
    chatsPageSource,
    /className=\{cn\([\s\S]*?'favorite-filter__trigger'[\s\S]*?aria-controls="home-sheet-filter"/u,
  );
  assert.match(
    chatsPageSource,
    /const FavoriteFilterIcon =[\s\S]*?HOME_ENTITY_FAVORITE_ICONS\[favoriteFilter\]/u,
  );
  assert.doesNotMatch(chatsPageSource, /data-allow-horizontal-overflow|favorite-filter-bar/u);
  assert.match(sheetsSource, /sheetKey="filter"[\s\S]*?home-filter__grid/u);
  assert.match(sheetsSource, /<strong>Настроить названия<\/strong>/u);
  assert.match(
    chatsPageNativeCss,
    /\.favorite-picker__header span \{[\s\S]*?color: var\(--home-muted\);/u,
  );
});

test('home list keeps grouped rows at wide breakpoints', () => {
  assert.match(
    chatsPageNativeCss,
    /\.chats-home \.chat-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(chatsPageSource, /const CHAT_LIST_VIRTUAL_ROW_HEIGHT = 96;/u);
  assert.match(chatsPageNativeCss, /\.chat-grid--virtual \.chat-card \{[\s\S]*?height: 88px;/u);
});

test('home exposes sync, result and virtual-list state to assistive technology', () => {
  assert.match(
    chatsPageSource,
    /const homeSyncAccessibleLabel = `Статус списка: \$\{homeSyncStatus\.label\}`;/u,
  );
  assert.match(
    chatsPageSource,
    /className="chats-command__sr"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/u,
  );
  assert.match(
    chatsPageSource,
    /'chats-command__refresh'[\s\S]*?homeSyncStatus\.tone === 'syncing'[\s\S]*?chats-command__sync-ring[\s\S]*?<RefreshGlyph/u,
  );
  assert.match(chatsPageSource, /\{homeSyncAccessibleLabel\}[\s\S]*?<\/span>/u);
  assert.doesNotMatch(
    chatsPageSource,
    /homeSyncVisualLabel|chats-command__sync-indicator|chats-command__sync-check|MAX на паузе/u,
  );
  assert.match(chatsPageSource, /<output[\s\S]*?aria-live="polite"[\s\S]*?homeResultStatus/u);
  assert.match(
    chatsPageSource,
    /role="listitem"[\s\S]*?aria-posinset=\{index \+ 1\}[\s\S]*?aria-setsize=\{filteredEntities\.length\}/u,
  );
  assert.match(
    chatsPageSource,
    /role="list"[\s\S]*?aria-label=\{`\$\{tabLabel\}: \$\{filteredEntities\.length\}`\}[\s\S]*?aria-busy=/u,
  );
  assert.match(chatsPageSource, /<GlassCard role="alert" aria-live="assertive">/u);
});

test('home reports favorite persistence failures through the shared toast', () => {
  assert.match(chatsPageSource, /const \{ pushToast \} = useToast\(\);/u);
  assert.match(
    chatsPageSource,
    /catch \(error: unknown\)[\s\S]*?pushToast\(\{[\s\S]*?tone: 'danger'/u,
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
