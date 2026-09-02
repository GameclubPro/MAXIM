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
const settingsExperienceCss = readFileSync(
  new URL('../src/styles/settings-experience.css', import.meta.url),
  'utf8',
);
const settingsNativePolishCss = readFileSync(
  new URL('../src/styles/settings-native-polish.css', import.meta.url),
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
  assert.match(settingsTileGridCss, /min-height: 68px;/u);
  assert.match(
    settingsTileGridCss,
    /grid-template-columns: 36px minmax\(0, 1fr\) minmax\(0, max-content\) 18px;/u,
  );
  assert.match(
    settingsTileGridCss,
    /\.settings-section__summary \{[\s\S]*?-webkit-line-clamp: 1;/u,
  );
  assert.match(settingsTileGridCss, /\.settings-section__status-chip \{[\s\S]*?grid-column: 3;/u);
  assert.match(settingsTileGridCss, /\.settings-section__chevron \{[\s\S]*?grid-column: 4;/u);
  assert.match(
    settingsExperienceCss,
    /\.channel-settings-card[\s\S]*?\.settings-section__toggle\[aria-expanded='false'\][\s\S]*?:is\(\.settings-section__summary, \.settings-section__status-chip\)[\s\S]*?min-width: 0;[\s\S]*?max-width: 1px;/u,
  );
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

test('settings dialogs keep stable geometry and accessible controls', () => {
  assert.match(
    settingsExperienceCss,
    /\.settings-drilldown__panel:focus \{\s*outline: none;\s*\}/u,
  );
  assert.match(
    settingsExperienceCss,
    /\.settings-drilldown \.settings-info-button,[\s\S]*?display: grid;[\s\S]*?width: 44px;[\s\S]*?min-height: 44px;/u,
  );
  assert.doesNotMatch(
    settingsExperienceCss,
    /\.settings-drilldown__panel--post-suggestions-screen:has/u,
  );
  assert.match(
    settingsExperienceCss,
    /@media \(max-width: 430px\) \{[\s\S]*?\.settings-drilldown__panel--duplicates[\s\S]*?\.duplicate-stage__controls \{\s*grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(
    settingsExperienceCss,
    /\.settings-drilldown__panel--limits\s+\.settings-subsection-divider \{\s*display: flex;/u,
  );
});

test('night schedule validation does not stretch the sibling time control', () => {
  assert.match(
    settingsExperienceCss,
    /\.settings-drilldown__panel--night\s+\.night-window-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);\s*align-items: start;/u,
  );
});

test('open settings hints render above neighboring toggle rows', () => {
  assert.match(
    settingsRoutePolishCss,
    /:is\(\.settings-native-toggle, \.channel-settings-toggle-card, \.managed-giveaway__section\):has\(\s*\.channel-settings-hint-popover\s*\) \{\s*position: relative;\s*overflow: visible;\s*z-index: 90;/u,
  );
});

test('disabled settings publish actions remain legible', () => {
  assert.match(
    settingsNativePolishCss,
    /\.broadcast-publish-bar__primary:disabled \{[\s\S]*?background: var\(--surface-card-muted\);\s*color: var\(--text-primary\);\s*opacity: 1;/u,
  );
});
