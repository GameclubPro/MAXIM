import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getNetworkSettingsSectionPresentation } from '../src/pages/settings/settings-workspace-sections';

const channelSettingsSource = readFileSync(
  new URL('../src/pages/channel-settings-page.tsx', import.meta.url),
  'utf8',
);
const postSignatureFieldsSource = readFileSync(
  new URL('../src/pages/settings/channel-post-signature-fields.tsx', import.meta.url),
  'utf8',
);
const settingsSectionToggleSource = readFileSync(
  new URL('../src/components/ui/settings-section-toggle.tsx', import.meta.url),
  'utf8',
);

test('channel post action stays compact on the overview and opens in a drilldown', () => {
  const presentation = getNetworkSettingsSectionPresentation('channel', 'postSignature');
  assert.equal(presentation.title, 'Действие под публикацией');
  assert.equal(presentation.panelClassName, 'settings-drilldown__panel--signature');
  assert.match(
    channelSettingsSource,
    /postSignature: getNetworkSettingsSectionPresentation\('channel', 'postSignature'\)/u,
  );
  assert.match(
    channelSettingsSource,
    /<SettingsSectionToggle[\s\S]*?title=\{SHARED_CHANNEL_SECTION_PRESENTATIONS\.postSignature\.title\}[\s\S]*?controls="channel-settings-post-signature"/u,
  );
  assert.match(
    channelSettingsSource,
    /<SettingsDrilldownPanel[\s\S]*?id="channel-settings-post-signature"[\s\S]*?title=\{SHARED_CHANNEL_SECTION_PRESENTATIONS\.postSignature\.title\}[\s\S]*?className=\{SHARED_CHANNEL_SECTION_PRESENTATIONS\.postSignature\.panelClassName\}/u,
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
    /<ChannelPostSignatureFields[\s\S]*?settings: postSignature/u,
  );
  assert.match(postSignatureFieldsSource, /const presentation = fields\.read\('presentation'\)/u);
  assert.match(
    postSignatureFieldsSource,
    /<SegmentedControl[\s\S]*?value=\{presentation\.kind === 'common' \? presentation\.value : ''\}[\s\S]*?value: 'signature'[\s\S]*?value: 'button'[\s\S]*?value === 'signature' \|\| value === 'button'[\s\S]*?fields\.setScalar\('presentation', value\)/u,
  );
  assert.match(channelSettingsSource, /className="channel-post-signature__message-button"/u);
  assert.match(
    postSignatureFieldsSource,
    /isButton \? \(\s*<button type="button" className="channel-post-signature__message-button" disabled>\s*\{label\}/u,
  );
  assert.match(
    postSignatureFieldsSource,
    /disabled: fields\.readOnly \|\| presentation\.kind === 'loading'/u,
  );
});

test('settings search includes post action terminology', () => {
  assert.match(
    settingsSectionToggleSource,
    /'Действие под публикацией': 'подпись кнопка ссылка адрес реклама посты публикации канал'/u,
  );
});
