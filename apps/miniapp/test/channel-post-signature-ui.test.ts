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

test('channel post action stays compact on the overview and opens in a drilldown', () => {
  assert.match(
    channelSettingsSource,
    /<SettingsSectionToggle[\s\S]*?title="Действие под публикацией"[\s\S]*?controls="channel-settings-post-signature"/u,
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

test('closing the post action drilldown blocks invalid fields and flushes a valid dirty draft', () => {
  assert.match(
    channelSettingsSource,
    /function closePostSignatureSection\(\)[\s\S]*?isPostSignatureDirty && \(postSignatureUrlError \|\| postSignatureTextError\)[\s\S]*?savePostSignature\(postSignature\);[\s\S]*?closeSection\('postSignature'\);/u,
  );
});

test('post action offers signature and button modes with a real button preview', () => {
  assert.match(
    channelSettingsSource,
    /value=\{postSignature\.presentation\}[\s\S]*?value: 'signature'[\s\S]*?value: 'button'/u,
  );
  assert.match(channelSettingsSource, /className="channel-post-signature__message-button"/u);
});

test('settings search includes post action terminology', () => {
  assert.match(
    settingsSectionToggleSource,
    /'Действие под публикацией': 'подпись кнопка ссылка адрес реклама посты публикации канал'/u,
  );
});
