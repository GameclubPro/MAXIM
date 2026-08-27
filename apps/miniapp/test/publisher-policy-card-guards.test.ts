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

test('Major exposes one compact Publik policy toggle without publisher inventory', () => {
  assert.equal(cardSource.match(/type="checkbox"/gu)?.length, 2);
  assert.match(cardSource, /mutationFn: \(publikEnabled: boolean\)/u);
  assert.doesNotMatch(cardSource, /suggestionsViaPublik|readiness|details|refreshPublisherEntity/u);
  assert.match(
    cardCss,
    /\.publisher-policy-card \{[\s\S]*?min-height: 68px;[\s\S]*?box-shadow: none;/u,
  );
  assert.doesNotMatch(cardCss, /publisher-policy-card__readiness|publisher-policy-card__details/u);
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
