import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const managedPollCss = readFileSync(
  new URL('../src/components/managed-poll-workspace.css', import.meta.url),
  'utf8',
);
const managedGiveawayCss = readFileSync(
  new URL('../src/styles/managed-giveaway.css', import.meta.url),
  'utf8',
);
const chatsPageNativeCss = readFileSync(
  new URL('../src/pages/chats-page-native.css', import.meta.url),
  'utf8',
);
const settingsRoutePolishCss = readFileSync(
  new URL('../src/styles/settings-route-polish.css', import.meta.url),
  'utf8',
);

test('poll switch thumb uses a semantic dark surface without a white glow', () => {
  assert.match(
    managedPollCss,
    /html\[data-max-theme='dark'\] \.managed-poll-switch > span::after \{\s*background: var\(--text-muted\);\s*box-shadow: none;/u,
  );
});

test('selected audience chips stay on dark semantic surfaces', () => {
  assert.match(
    managedGiveawayCss,
    /html\[data-max-theme='dark'\][\s\S]*?\.broadcast-audience-sheet__selected-strip\s*> span:not\(\.broadcast-audience-sheet__badge\) \{\s*border-color: var\(--color-border\);\s*background: var\(--color-surface-tint\);\s*color: var\(--text-primary\);/u,
  );
});

test('ported home sheets own the semantic tokens used by their tiles', () => {
  assert.match(
    chatsPageNativeCss,
    /\.favorite-picker \{\s*--home-surface: var\(--surface-card\);[\s\S]*?--home-border: var\(--border-subtle\);[\s\S]*?--home-ink: var\(--text-primary\);/u,
  );
});

test('giveaway subsections cannot inherit light inset card chrome in dark settings', () => {
  assert.match(
    settingsRoutePolishCss,
    /html\[data-max-theme='dark'\][\s\S]*?\.managed-giveaway__subsection \{\s*border: 0;\s*border-top: 1px solid var\(--color-border\);\s*border-radius: 0;\s*background: transparent;\s*box-shadow: none;/u,
  );
});
