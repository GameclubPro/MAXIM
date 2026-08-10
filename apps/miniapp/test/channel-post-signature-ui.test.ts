import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const channelSettingsSource = readFileSync(
  new URL('../src/pages/channel-settings-page.tsx', import.meta.url),
  'utf8',
);
const settingsSectionToggleSource = readFileSync(
  new URL('../src/components/ui/settings-section-toggle.tsx', import.meta.url),
  'utf8',
);

test('post signature stays compact on the overview and opens in a drilldown', () => {
  assert.match(
    channelSettingsSource,
    /<SettingsSectionToggle[\s\S]*?title="Подпись публикаций"[\s\S]*?controls="channel-settings-post-signature"/u,
  );
  assert.match(
    channelSettingsSource,
    /<SettingsDrilldownPanel[\s\S]*?id="channel-settings-post-signature"[\s\S]*?className="settings-drilldown__panel--signature"/u,
  );
  assert.doesNotMatch(
    channelSettingsSource,
    /postSignature\.enabled \? \(\s*<div className="channel-post-signature__body"/u,
  );
});

test('closing the signature drilldown flushes a valid dirty draft', () => {
  assert.match(
    channelSettingsSource,
    /function closePostSignatureSection\(\)[\s\S]*?isPostSignatureDirty && postSignatureUrlError[\s\S]*?savePostSignature\(postSignature\);[\s\S]*?closeSection\('postSignature'\);/u,
  );
});

test('settings search includes post signature terminology', () => {
  assert.match(
    settingsSectionToggleSource,
    /'Подпись публикаций': 'подпись ссылка адрес посты публикации канал'/u,
  );
});
