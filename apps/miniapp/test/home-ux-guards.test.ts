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
const rootClientSource = readFileSync(
  new URL('../src/lib/api/root-client.ts', import.meta.url),
  'utf8',
);
const onboardingSource = readFileSync(
  new URL('../src/components/chat-onboarding-section.tsx', import.meta.url),
  'utf8',
);

test('entity cards expose settings, favorite, statistics and category edit targets', () => {
  assert.match(chatsPageSource, /className="chat-card__primary-link"/u);
  assert.match(chatsPageSource, /'chat-card__action--favorite'/u);
  assert.match(chatsPageSource, /chat-card__action chat-card__action--statistics/u);
  assert.doesNotMatch(chatsPageSource, /chat-card__action--settings|chat-card__title-link/u);
  assert.match(chatsPageSource, /chat-card__category-editor/u);
  assert.doesNotMatch(chatsPageSource, /chat-card__category-marker/u);
  assert.match(
    chatsPageSource,
    /aria-label=\{`Открыть настройки: \$\{entity\.title\}\$\{[\s\S]*?primaryFavoriteType \? `\. Категория: \$\{categoryLabel\}` : ''[\s\S]*?\}`\}/u,
  );
  assert.match(chatsPageSource, /<BackChevronIcon \/>/u);
  assert.match(chatsPageSource, /to=\{settingsRoute\}/u);
  assert.match(chatsPageSource, /to=\{statisticsRoute\}/u);
  assert.match(
    chatsPageSource,
    /const settingsRoute = preserveManagedEntityRouteContext\(\s*buildManagedEntitySettingsRoute\(activeTab, entity\.id\),\s*location\.search,\s*location\.hash,\s*\)/u,
  );
  assert.match(
    chatsPageSource,
    /const statsPreference = readEntityStatsPreference\(entity\.id\);[\s\S]*?const statisticsRoute = preserveManagedEntityRouteContext\(\s*buildManagedEntityStatisticsRoute\(activeTab, entity\.id, statsPreference\),\s*location\.search,\s*location\.hash,\s*\);/u,
  );
  assert.doesNotMatch(chatsPageSource, /function buildEntity(?:Settings|Statistics)Route/u);
  assert.doesNotMatch(chatsPageSource, /<details\b/u);
  assert.match(chatsPageSource, /aria-haspopup="dialog"/u);
  assert.match(
    chatsPageSource,
    /`Добавить в избранное: \$\{entity\.title\}`[\s\S]*?aria-controls="home-sheet-favorite"/u,
  );
  assert.match(chatsPageSource, /<StarGlyph aria-hidden focusable="false" \/>/u);
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
  assert.match(chatsPageNativeCss, /\.chat-card\.glass-card \{[\s\S]*?height: 72px/u);
  assert.match(
    chatsPageNativeCss,
    /\.chat-card\.glass-card \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 44px 52px;/u,
  );
  assert.match(
    chatsPageNativeCss,
    /\.chat-card__primary-link \{[\s\S]*?position: relative;[\s\S]*?grid-column: 1;[\s\S]*?min-height: 72px/u,
  );
  assert.match(chatsPageNativeCss, /\.chat-card__category-editor \{[\s\S]*?grid-column: 1 \/ -1;/u);
  assert.match(chatsPageNativeCss, /\.chat-card__action \{[\s\S]*?min-width: 44px/u);
  assert.match(
    chatsPageNativeCss,
    /\.chat-card__action--favorite\.is-active \{[\s\S]*?var\(--chat-card-favorite-accent\)/u,
  );
  assert.match(
    chatsPageNativeCss,
    /html\[data-max-theme='dark'\] \.chat-card\.is-important \.chat-card__action--favorite\.is-active \{\s*color: var\(--warning\);/u,
  );
  assert.match(
    chatsPageNativeCss,
    /\.chats-command__tools \{[\s\S]*?grid-template-columns: minmax\(112px, 1fr\) repeat\(3, 44px\)/u,
  );
  assert.match(
    chatsPageNativeCss,
    /\.chat-card__category-value span \{[\s\S]*?text-overflow: ellipsis/u,
  );
  assert.match(
    chatsPageSource,
    /className=\{cn\([\s\S]*?'favorite-filter__trigger'[\s\S]*?aria-controls="home-sheet-filter"/u,
  );
  assert.match(
    chatsPageSource,
    /const FavoriteFilterIcon =[\s\S]*?HOME_ENTITY_FAVORITE_ICONS\[favoriteFilter\]/u,
  );
  assert.doesNotMatch(chatsPageSource, /data-allow-horizontal-overflow|favorite-filter-bar/u);
  assert.match(chatsPageSource, /className=\{cn\('home-active-filter'/u);
  assert.match(sheetsSource, /sheetKey="filter"[\s\S]*?home-filter__grid/u);
  assert.match(sheetsSource, /Распределить по категориям/u);
  assert.match(sheetsSource, /<strong>Настроить названия<\/strong>/u);
  assert.match(sheetsSource, /'Добавить в избранное'/u);
  assert.match(
    chatsPageNativeCss,
    /\.favorite-picker__header span \{[\s\S]*?color: var\(--home-muted\);/u,
  );
  assert.match(
    chatsPageNativeCss,
    /@media \(max-width: 430px\) \{\s*\.home-sheet--favorite \.favorite-picker__grid \{\s*grid-template-columns: minmax\(0, 1fr\);/u,
  );
});

test('home connection flow is always available and opens the signed launch bot dialog', () => {
  assert.match(
    chatsPageSource,
    /className="chats-command__connect"[\s\S]*?aria-controls="home-sheet-connect"[\s\S]*?<PlusCircleGlyph/u,
  );
  assert.doesNotMatch(chatsPageSource, /<span>Подключить<\/span>/u);
  assert.doesNotMatch(chatsPageSource, /botDialogUrl|setBotDialogUrl/u);
  assert.match(chatsPageSource, /import\('\.\.\/lib\/api\/me-client'\)/u);
  assert.doesNotMatch(chatsPageSource, /from '\.\.\/lib\/api\/me-client'/u);
  assert.doesNotMatch(rootClientSource, /\bgetMe\b|\bparseMe\b|botDialogUrl/u);
  assert.match(sheetsSource, /from '\.\.\/lib\/api\/me-client'/u);
  assert.match(sheetsSource, /getMe\(api,[\s\S]*?botDialogUrlRef\.current = me\.botDialogUrl/u);
  assert.match(sheetsSource, /coordinator\.run\([\s\S]*?openMaxBotLinkAndClose/u);
  assert.doesNotMatch(chatsPageSource, /createBotDialogHandoffCoordinator|openMaxBotLinkAndClose/u);
  assert.match(chatsPageSource, /if \(showEmptyState\) \{[\s\S]*?preloadHomeEntitySheets\(\)/u);
  assert.match(chatsPageSource, /if \(connectSheetOpen\) \{[\s\S]*?closeHomeEntitySheet\(\)/u);
  assert.match(sheetsSource, /sheetKey="connect"[\s\S]*?title="Подключить чат или канал"/u);
  assert.match(sheetsSource, /Добавьте бота в администраторы/u);
  assert.match(sheetsSource, /Включите доступ ко всем сообщениям/u);
  assert.match(sheetsSource, /Перешлите боту любое сообщение или пост/u);
  assert.match(sheetsSource, /Бот проверит права и добавит чат или канал/u);
  assert.doesNotMatch(sheetsSource, /Три коротких шага|Mini app закроется/u);
  assert.match(sheetsSource, /Открыть диалог с ботом/u);
  assert.match(sheetsSource, /<ol className="home-connect__steps" role="list">/u);
  assert.match(sheetsSource, /aria-label="Шаг 1"/u);
  assert.match(sheetsSource, /aria-label="Шаг 2"/u);
  assert.match(chatsPageNativeCss, /\.chats-command__connect \{[\s\S]*?color: var\(--home-ink\);/u);
  assert.match(
    chatsPageNativeCss,
    /\.home-connect__steps li > span \{[\s\S]*?color: var\(--home-ink\);/u,
  );
  assert.doesNotMatch(chatsPageSource, /closeMaxMiniApp/u);
});

test('home list keeps grouped rows at wide breakpoints', () => {
  assert.match(
    chatsPageNativeCss,
    /\.chats-home \.chat-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(chatsPageSource, /const CHAT_LIST_ROW_HEIGHT = 72;/u);
  assert.match(chatsPageSource, /const CHAT_LIST_VIRTUAL_ROW_PITCH = 80;/u);
  assert.match(
    chatsPageSource,
    /top: index \* CHAT_LIST_VIRTUAL_ROW_PITCH,[\s\S]*?height: CHAT_LIST_ROW_HEIGHT/u,
  );
  assert.match(chatsPageSource, /height: filteredEntities\.length \* CHAT_LIST_VIRTUAL_ROW_PITCH/u);
  assert.match(chatsPageNativeCss, /\.chat-grid--virtual \.chat-card \{[\s\S]*?height: 72px;/u);
});

test('category assignment is explicit, exclusive and stable while editing', () => {
  assert.match(
    chatsPageSource,
    /const \[categoryEditMode, setCategoryEditMode\] = useState\(false\)/u,
  );
  assert.match(chatsPageSource, /if \(categoryEditMode\) \{\s*return matchingEntities;/u);
  assert.match(chatsPageSource, /enabled: categoryEditMode && !homeOverlayOpen, priority: 600/u);
  assert.match(chatsPageSource, />\s*Готово\s*<\/button>/u);
  assert.match(chatsPageSource, /handleSetHomeEntityFavoriteType/u);
  assert.match(chatsPageSource, /setHomeEntityFavoriteTypes/u);
  assert.doesNotMatch(chatsPageSource, /toggleHomeEntityFavoriteType/u);
  assert.match(sheetsSource, /<fieldset className="favorite-picker__fieldset"/u);
  assert.match(sheetsSource, /type="radio"/u);
  assert.match(sheetsSource, /<strong>Без категории<\/strong>/u);
  assert.doesNotMatch(sheetsSource, /aria-pressed=/u);
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
  assert.doesNotMatch(chatsPageSource, /<GlassCard role="alert" aria-live="assertive">/u);
  assert.match(chatsPageSource, /<StatusState[\s\S]*?tone="danger"/u);
});

test('home reports favorite persistence failures through the shared toast', () => {
  assert.match(chatsPageSource, /const \{ pushToast \} = useToast\(\);/u);
  assert.match(
    chatsPageSource,
    /catch \(error: unknown\)[\s\S]*?pushToast\(\{[\s\S]*?tone: 'danger'/u,
  );
});

test('empty onboarding promotes the shared connection flow before refresh', () => {
  const connectIndex = onboardingSource.indexOf('onboarding-connect');
  const refreshIndex = onboardingSource.indexOf('onboarding-refresh');
  const cards = onboardingSource.match(/<GlassCard\b/gu) ?? [];

  assert.ok(connectIndex >= 0);
  assert.ok(refreshIndex >= 0);
  assert.ok(connectIndex < refreshIndex);
  assert.equal(cards.length, 1);
  assert.match(onboardingSource, /aria-controls="home-sheet-connect"/u);
  assert.match(onboardingSource, /Подключить чат или канал/u);
  assert.match(onboardingSource, /onConnect\(event\.currentTarget\)/u);
  assert.match(onboardingSource, /<RefreshGlyph[\s\S]*?Обновить/u);
  assert.doesNotMatch(
    onboardingSource,
    /<details\b|Показать инструкцию|слово «Старт»|onboarding-diagnostics|recentSignals/u,
  );
  assert.match(chatsPageSource, /isRefreshBlocked=\{isManualRefreshBlocked\}/u);
  assert.doesNotMatch(onboardingSource, /refreshLabel|getManagedEntityOnboardingDiagnostics/u);
});
