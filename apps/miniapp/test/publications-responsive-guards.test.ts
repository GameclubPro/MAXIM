import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const composerCss = readFileSync(
  new URL('../src/components/broadcast-content-composer.css', import.meta.url),
  'utf8',
);
const publicationWorkbenchCss = readFileSync(
  new URL('../src/features/publications/publication-workbench.css', import.meta.url),
  'utf8',
);
const publicationVideoToolSource = readFileSync(
  new URL('../src/features/publications/publication-video-tool.tsx', import.meta.url),
  'utf8',
);
const publicationsCss = readFileSync(
  new URL('../src/styles/publications-page.css', import.meta.url),
  'utf8',
);
const broadcastStudioCss = readFileSync(
  new URL('../src/styles/broadcast-studio.css', import.meta.url),
  'utf8',
);

test('publication editor grid tracks stay contained on narrow native viewports', () => {
  assert.match(
    publicationWorkbenchCss,
    /\.app-shell:has\(\.publications-page\) \{\s*grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(
    publicationWorkbenchCss,
    /\.app-shell:has\(\.publications-page\) \.shell-content \{\s*min-width: 0;\s*grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(
    publicationWorkbenchCss,
    /\.publications-editor,\s*\.publication-editor-section \{\s*min-width: 0;\s*grid-template-columns: minmax\(0, 1fr\);/u,
  );
});

test('publication editor is full bleed and keeps its action in normal scroll flow', () => {
  assert.match(
    publicationWorkbenchCss,
    /body\.publications-editor-open \.app-shell:has\(\.publications-page\.is-editor\) \{[\s\S]*?width: 100%;[\s\S]*?max-width: none;[\s\S]*?padding: 0;[\s\S]*?overflow: hidden;/u,
  );
  assert.match(
    publicationWorkbenchCss,
    /\.publications-page\.is-editor \{[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\);[\s\S]*?padding: 0;[\s\S]*?overflow: hidden;/u,
  );
  assert.match(
    publicationWorkbenchCss,
    /\.publications-page\.is-editor > \.publications-editor \{[\s\S]*?display: flex;[\s\S]*?overflow-y: auto;[\s\S]*?touch-action: pan-y;/u,
  );
  assert.match(
    publicationWorkbenchCss,
    /\.publications-page\.is-editor \.publications-editor > \.publications-publish-bar \{[\s\S]*?position: static;[\s\S]*?margin-top: auto;[\s\S]*?transform: none;/u,
  );
  assert.doesNotMatch(
    publicationWorkbenchCss,
    /html\[data-max-keyboard-open='true'\][\s\S]*?\.publications-publish-bar \{\s*display: none;/u,
  );
  assert.doesNotMatch(publicationsCss, /\.publications-publish-bar \{\s*position: fixed;/u);
});

test('publisher composer consumes free editor height instead of stretching empty grid tracks', () => {
  assert.match(
    publicationWorkbenchCss,
    /\.publication-editor-section--content \{\s*flex: 1 0 auto;\s*display: flex;\s*flex-direction: column;/u,
  );
  assert.match(
    publicationWorkbenchCss,
    /\.publication-content-composer \{\s*min-height: 188px;\s*flex: 1 0 auto;\s*display: flex;\s*flex-direction: column;/u,
  );
  assert.match(
    publicationWorkbenchCss,
    /\.broadcast-content-composer__workspace,[\s\S]*?\.broadcast-content-composer__editor \{\s*flex: 1 0 auto;\s*display: flex;\s*flex-direction: column;/u,
  );
  assert.match(
    publicationWorkbenchCss,
    /\.publication-content-composer \.broadcast-message-card \{\s*flex: 1 0 auto;/u,
  );
});

test('publication video recovery state is visible and described to assistive technology', () => {
  assert.match(publicationVideoToolSource, /aria-label=\{label\}/u);
  assert.match(
    publicationVideoToolSource,
    /aria-describedby=\{preparing \|\| needsReselection \? statusId : undefined\}/u,
  );
  assert.match(publicationVideoToolSource, /needs-reselection/u);
  assert.match(publicationVideoToolSource, /WarningCircle/u);
});

test('broadcast composer owns the base preview button layout', () => {
  assert.match(
    composerCss,
    /\.broadcast-message-card__buttons \{\s*min-width: 0;\s*display: grid;/u,
  );
  assert.match(
    composerCss,
    /\.broadcast-message-card__button-row \{\s*min-width: 0;\s*display: flex;/u,
  );
  assert.match(
    composerCss,
    /\.broadcast-message-card__button \{[\s\S]*?display: inline-flex;[\s\S]*?background: var\(--broadcast-preview-button-bg\);/u,
  );
  assert.match(
    composerCss,
    /\.broadcast-message-card__button\.is-system \{\s*background: var\(--broadcast-preview-system-button-bg\);/u,
  );
  assert.doesNotMatch(broadcastStudioCss, /^\s{2}\.broadcast-message-card__buttons \{/mu);
});
