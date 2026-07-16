import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsRoutePolishCss = readFileSync(
  new URL('../src/styles/settings-route-polish.css', import.meta.url),
  'utf8',
);

test('link action titles wrap only between words on narrow settings screens', () => {
  assert.match(
    settingsRoutePolishCss,
    /\.settings-drilldown \.settings-drilldown__panel--links \.settings-native-toggle__title \{\s*overflow-wrap: normal;\s*word-break: normal;\s*hyphens: none;\s*\}/u,
  );
});
