import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsRoutePolishCss = readFileSync(
  new URL('../src/styles/settings-route-polish.css', import.meta.url),
  'utf8',
);
const settingsTileGridCss = readFileSync(
  new URL('../src/styles/settings-tile-grid.css', import.meta.url),
  'utf8',
);

test('link action titles wrap only between words on narrow settings screens', () => {
  assert.match(
    settingsRoutePolishCss,
    /\.settings-drilldown \.settings-drilldown__panel--links \.settings-native-toggle__title \{\s*overflow-wrap: normal;\s*word-break: normal;\s*hyphens: none;\s*\}/u,
  );
});

test('settings overviews use compact phone rows and expand only on wider screens', () => {
  assert.match(
    settingsTileGridCss,
    /\.channel-settings-screen \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(settingsTileGridCss, /min-height: 60px;/u);
  assert.match(
    settingsTileGridCss,
    /@media \(min-width: 560px\)[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u,
  );

  const darkBaseRule = settingsTileGridCss.indexOf("html[data-max-theme='dark']");
  const darkHoverRule = settingsTileGridCss.indexOf(
    '.settings-section__toggle:hover,',
    darkBaseRule,
  );
  const darkExpandedRule = settingsTileGridCss.indexOf(
    ".settings-section__toggle[aria-expanded='true'],",
    darkHoverRule,
  );
  assert.ok(darkBaseRule >= 0);
  assert.ok(darkHoverRule > darkBaseRule);
  assert.ok(darkExpandedRule > darkHoverRule);
  assert.match(
    settingsTileGridCss.slice(darkHoverRule, darkExpandedRule),
    /background: var\(--surface-card-muted\);/u,
  );
  assert.match(
    settingsTileGridCss.slice(darkExpandedRule),
    /background: var\(--accent-soft\);[\s\S]*?box-shadow: 0 0 0 2px var\(--app-focus-ring\);/u,
  );
});
