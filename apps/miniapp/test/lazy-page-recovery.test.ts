import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLazyPageReloadMarkerKey } from '../src/pages/lazy-pages';

test('keys lazy page reload recovery by failed asset URL when available', () => {
  const key = buildLazyPageReloadMarkerKey(
    'EventsPage',
    new TypeError(
      'Failed to fetch dynamically imported module: https://maxim.play-team.ru/app/assets/events-page-oldHash.js',
    ),
  );

  assert.equal(
    key,
    'maxim:lazy-page-reload:v1:https://maxim.play-team.ru/app/assets/events-page-oldHash.js',
  );
});

test('falls back to page export name for generic lazy page load failures', () => {
  assert.equal(
    buildLazyPageReloadMarkerKey('SettingsPage', new Error('Network request failed')),
    'maxim:lazy-page-reload:v1:SettingsPage',
  );
});
