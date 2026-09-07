import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const cardSource = readFileSync(
  new URL('../src/components/publisher-policy-card.tsx', import.meta.url),
  'utf8',
);
const cardCss = readFileSync(
  new URL('../src/components/publisher-policy-card.css', import.meta.url),
  'utf8',
);
const chatSettingsSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const chatSettingsLazySurfacesSource = readFileSync(
  new URL('../src/pages/settings/settings-lazy-surfaces.tsx', import.meta.url),
  'utf8',
);
const channelSettingsSource = readFileSync(
  new URL('../src/pages/channel-settings-page.tsx', import.meta.url),
  'utf8',
);
const chatsPageSource = readFileSync(
  new URL('../src/pages/chats-page.tsx', import.meta.url),
  'utf8',
);
const broadcastStudioCss = readFileSync(
  new URL('../src/styles/broadcast-studio.css', import.meta.url),
  'utf8',
);

test('Publik owns one compact policy switch without secondary rows', () => {
  assert.equal(cardSource.match(/type="checkbox"/gu)?.length, 1);
  assert.equal(cardSource.match(/>Публик<\/strong>/gu)?.length, 1);
  assert.match(cardSource, /mutationFn: \(publikEnabled: boolean\)/u);
  assert.match(cardSource, /getPublisherPolicy/u);
  assert.doesNotMatch(cardSource, /getPublisherEntity/u);
  assert.doesNotMatch(
    cardSource,
    /<small|<p|<a|<Link|<button|<ul|<ol|<Post|Badge|suggestionsViaPublik|readiness|details|refreshPublisherEntity|settingsHandoff|moduleSettings/u,
  );
  assert.match(
    cardCss,
    /\.publisher-policy-card \{[\s\S]*?min-height: 52px;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?box-shadow: none;/u,
  );
  assert.doesNotMatch(
    cardCss,
    /publisher-policy-card__icon|publisher-policy-card__readiness|publisher-policy-card__details|publisher-policy-pulse/u,
  );
});

test('Publik permission preview keeps a semantic surface in dark settings', () => {
  assert.match(
    broadcastStudioCss,
    /\.action-confirm-sheet__panel--accent \.action-confirm-sheet__preview \{[^}]*background: var\(--color-surface-muted\);/u,
  );
  assert.doesNotMatch(
    broadcastStudioCss,
    /\.action-confirm-sheet__panel--accent \.action-confirm-sheet__preview \{[^}]*background: #f8fafb;/u,
  );
});

test('Publik policy belongs to its entity module page, never Major settings', () => {
  const modules = readFileSync(
    new URL('../src/pages/publisher-entity-modules-page.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(modules.includes('<PublisherPolicyCard api={api}'));
  assert.doesNotMatch(chatSettingsSource + channelSettingsSource, /PublisherPolicyCard/u);
  assert.doesNotMatch(chatSettingsLazySurfacesSource, /PublisherPolicyCard/u);
});

test('Major offers only a bot handoff, not Publisher controls', () => {
  assert.doesNotMatch(chatsPageSource, /PublisherPolicy/u);
  assert.equal(chatsPageSource.match(/<LazyPublikHandoff \/>/gu)?.length, 1);
  assert.doesNotMatch(chatSettingsSource, /<PublisherPolicyCardEntry/u);
  assert.doesNotMatch(channelSettingsSource, /<PublisherPolicyCard api=/u);
  assert.doesNotMatch(
    chatSettingsSource,
    /MAJOR_CHAT_COMMENTS_MODULE_VISIBLE|SettingsCommentsSection/u,
  );
  assert.doesNotMatch(chatSettingsSource, /settings-home-group-head__title">Бот<\/h2>/u);
  assert.doesNotMatch(
    `${chatSettingsSource}\n${channelSettingsSource}`,
    /PublisherReadiness|PublisherEntity|publisher-module|settingsHandoffUrl|suggestionsViaPublik/u,
  );
});
