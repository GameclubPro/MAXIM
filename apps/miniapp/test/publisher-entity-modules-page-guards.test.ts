import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.tsx', import.meta.url),
  'utf8',
);
const pageCss = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.css', import.meta.url),
  'utf8',
);

test('Publik module workspace owns its settings and never imports Major presentation state', () => {
  assert.match(pageSource, /chatComments: updatePublisherChatCommentSetting/u);
  assert.match(pageSource, /channelSuggestionsEnabled/u);
  assert.match(pageSource, /updatePublisherModules/u);
  assert.doesNotMatch(
    pageSource,
    /channelOverview|settingsHandoff|postSignature|getChats|getChannels/u,
  );
});

test('VK module is capability-gated, lazy, and inactive while its workspace is closed', () => {
  assert.match(pageSource, /lazy\(async \(\) =>/u);
  assert.match(pageSource, /import\('\.\.\/components\/vk-parsing-card'\)/u);
  assert.match(pageSource, /getVkParsingCapability\(api, entityType!, entityId\)/u);
  assert.match(pageSource, /active=\{vkOpen && vkAvailable\}/u);
  assert.match(pageSource, /vkOpen && vkAvailable \? \(/u);
  assert.match(
    pageSource,
    /aria-label=\{vkOpen \? 'Закрыть посты из VK' : 'Открыть посты из VK'\}/u,
  );
  assert.match(
    pageSource,
    /publisher-entity-vk-module__workspace vk-parsing-surface/u,
  );
});

test('module controls keep stable mobile touch targets without nested module cards', () => {
  assert.match(pageCss, /\.publisher-module-switch \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u);
  assert.match(pageCss, /\.publisher-entity-module__action \{[\s\S]*?min-height: 44px;/u);
  assert.match(pageCss, /\.publisher-entity-vk-module \{[\s\S]*?display: grid;/u);
  assert.doesNotMatch(pageSource, /<article className="publisher-entity-vk-module"/u);
});
