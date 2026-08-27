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

test('Major exposes exactly one compact Publik toggle without secondary UI', () => {
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

test('Publik policy sits after settings search and participates in filtering', () => {
  const chatSearchIndex = chatSettingsSource.indexOf('<LazySettingsOverviewSearch');
  const chatCardIndex = chatSettingsSource.indexOf('<PublisherPolicyCardEntry');
  assert.ok(chatSearchIndex >= 0 && chatCardIndex > chatSearchIndex);
  assert.match(
    chatSettingsLazySurfacesSource,
    /publisher-policy-card-entry settings-home-entry stagger-in/u,
  );

  const channelSearchIndex = channelSettingsSource.indexOf('<LazySettingsOverviewSearch');
  const channelCardIndex = channelSettingsSource.indexOf(
    '<PublisherPolicyCard api={api} entityType="channel"',
  );
  assert.ok(channelSearchIndex >= 0 && channelCardIndex > channelSearchIndex);
  assert.match(
    channelSettingsSource,
    /entrySelector="\.channel-settings-card, \.publisher-policy-card"/u,
  );
});

test('Major home and entity settings contain no second Publik surface', () => {
  assert.doesNotMatch(chatsPageSource, /PublisherPolicy|>Публик</u);
  assert.equal(chatSettingsSource.match(/<PublisherPolicyCardEntry/gu)?.length, 1);
  assert.equal(channelSettingsSource.match(/<PublisherPolicyCard api=/gu)?.length, 1);
  assert.doesNotMatch(chatSettingsSource, /MAJOR_CHAT_COMMENTS_MODULE_VISIBLE|SettingsCommentsSection/u);
  assert.doesNotMatch(
    chatSettingsSource,
    /settings-home-group-head__title">Бот<\/h2>/u,
  );
  assert.doesNotMatch(
    `${chatSettingsSource}\n${channelSettingsSource}`,
    /PublisherReadiness|PublisherEntity|publisher-module|settingsHandoffUrl|suggestionsViaPublik/u,
  );
});
