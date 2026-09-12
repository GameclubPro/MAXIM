import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { applySettingsSectionSchema, chatSettingsSchema } from '@maxim/contracts/settings';
import {
  MINIAPP_VISUAL_PRESETS,
  MINIAPP_VISUAL_SCENARIOS,
} from '../../../scripts/miniapp-visual-scenarios.mjs';

const sectionSource = readFileSync(
  new URL('../src/pages/settings/settings-advertising-soon-section.tsx', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const parsed = ts.createSourceFile(
  'advertising.tsx',
  sectionSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

test('advertising announcement is a disabled chat module, never a navigation or publishing control', () => {
  const buttons: ts.JsxOpeningElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(parsed) === 'button')
      buttons.push(node);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      assert.ok(
        !['a', 'input', 'form', 'SettingsDrilldownPanel'].includes(node.tagName.getText(parsed)),
      );
      for (const attribute of node.attributes.properties) {
        assert.ok(
          ts.isJsxAttribute(attribute),
          'Unavailable modules cannot spread interactive props',
        );
        assert.doesNotMatch(
          attribute.name.getText(parsed),
          /^on|^href$|^aria-controls$|^aria-expanded$/u,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(buttons.length, 1);
  const disabled = buttons[0].attributes.properties.find(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(parsed) === 'disabled',
  );
  assert.ok(disabled && ts.isJsxAttribute(disabled));
  assert.equal(disabled.initializer, undefined);
  assert.match(sectionSource, /Рекламная площадка/u);
  assert.match(sectionSource, /Скоро/u);
  assert.match(sectionSource, /data-settings-search="[^"]*Связка[^"]*взаимопиар/u);
  assert.match(pageSource, /<SettingsAdvertisingSoonSection\s*\/>/u);
});

test('the announcement introduces no writable setting or bulk-apply section', () => {
  for (const name of [
    'advertising',
    'advertisingEnabled',
    'svyazka',
    'svyazkaAdvertisingEnabled',
  ]) {
    assert.equal(applySettingsSectionSchema.safeParse(name).success, false);
    const parsedSettings = chatSettingsSchema.parse({ [name]: true });
    assert.equal(Object.hasOwn(parsedSettings, name), false);
  }
  const imports = parsed.statements
    .filter(ts.isImportDeclaration)
    .map((node) => node.moduleSpecifier.getText(parsed));
  assert.equal(imports.length, 2);
  assert.ok(imports.every((value) => value.includes('/components/ui/')));
});

test('the unavailable module has a dedicated real-browser scenario and stays chat-only', () => {
  const scenario = MINIAPP_VISUAL_SCENARIOS.find(
    (item) => item.name === 'chat-settings-advertising-soon',
  );
  assert.equal(scenario?.routeId, 'chat-settings');
  assert.ok(MINIAPP_VISUAL_PRESETS.smoke.scenarioNames.includes('chat-settings'));
  const captureSource = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    captureSource,
    /name: 'chat-settings',[\s\S]*?await assertAdvertisingSoonModule\(page\)/u,
  );
  const channelSource = readFileSync(
    new URL('../src/pages/channel-settings-page.tsx', import.meta.url),
    'utf8',
  );
  const publisherSource = readFileSync(
    new URL('../src/pages/publisher-entity-modules-page.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(channelSource, /SettingsAdvertisingSoonSection/u);
  assert.doesNotMatch(publisherSource, /SettingsAdvertisingSoonSection/u);
});
