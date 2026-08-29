import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const appSource = readSource('../src/app.tsx');
const launchRouteSource = readSource('../src/lib/launch-route.ts');
const chatSettingsSource = readSource('../src/pages/settings-page.legacy.tsx');
const settingsHelpersSource = readSource('../src/pages/settings/settings-page-helpers.tsx');
const settingsSearchSource = readSource('../src/components/ui/settings-section-toggle.tsx');
const channelSettingsClientSource = readSource('../src/lib/api/channel-settings-client.ts');
const queryKeysSource = readSource('../src/lib/query-keys.ts');
const previewSettingsSource = readSource('../src/lib/api/preview-transport-settings.ts');
const previewSystemSource = readSource('../src/lib/api/preview-transport-system.ts');
const previewVkSource = readSource('../src/lib/api/preview-transport-vk.ts');
const vkClientSource = readSource('../src/lib/api/vk-parsing-client.ts');
const vkStylesSource = readSource('../src/styles/vk-parsing.css');
const settingsExperienceStyles = readSource('../src/styles/settings-experience.css');
const settingsNativeStyles = readSource('../src/styles/settings-native-polish.css');

test('Major routes and settings contain no VK parsing surface', () => {
  assert.doesNotMatch(launchRouteSource, /vkParsing/u);
  assert.doesNotMatch(chatSettingsSource, /vkParsing|VkParsing|vk-parsing/u);
  assert.doesNotMatch(settingsHelpersSource, /vkParsing|VkParsing|vk-parsing/u);
  assert.doesNotMatch(settingsSearchSource, /Посты из VK|вконтакте импорт парсинг/u);
  assert.doesNotMatch(channelSettingsClientSource, /VkParsing|vk-parsing/u);
  assert.doesNotMatch(queryKeysSource, /channelVkParsing|channel-vk-parsing/u);
  assert.doesNotMatch(previewSettingsSource, /channelVkParsing/u);
  assert.doesNotMatch(previewSystemSource, /vk-parsing-publish['"]/u);
  assert.doesNotMatch(settingsExperienceStyles, /vk-parsing|VK parsing/u);
  assert.doesNotMatch(settingsNativeStyles, /vk-(?:parsing|autopost|source|feed)/u);
});

test('Publik exclusively owns the VK route, client namespace, preview, and styles', () => {
  assert.match(
    appSource,
    /!moderationProfile\s*\?\s*\([\s\S]*?path="\/publisher\/:entityType\/:entityId"[\s\S]*?LazyPublisherEntityModulesPage/u,
  );
  assert.match(
    vkClientSource,
    /`\/publisher\/entities\/\$\{entityType\}\/\$\{encodeURIComponent\(chatId\)\}\/vk-parsing`/u,
  );
  assert.doesNotMatch(vkClientSource, /`\/(?:chats|channels)\//u);
  assert.match(previewVkSource, /context\.state\.me\.profile !== 'publisher'/u);
  assert.match(previewVkSource, /publisher !== 'publisher'/u);
  assert.doesNotMatch(previewVkSource, /resolvePreviewEntityRequest/u);
  assert.match(vkStylesSource, /\.vk-parsing-surface/u);
  assert.doesNotMatch(vkStylesSource, /settings-drilldown__panel--vk-parsing/u);
});
