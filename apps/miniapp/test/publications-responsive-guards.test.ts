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
