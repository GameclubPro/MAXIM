import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(
  new URL('../src/pages/publications-page.tsx', import.meta.url),
  'utf8',
);
const composerSource = readFileSync(
  new URL('../src/components/broadcast-content-composer.tsx', import.meta.url),
  'utf8',
);
const contentEditorSource = readFileSync(
  new URL('../src/features/publications/publication-content-editor-section.tsx', import.meta.url),
  'utf8',
);
const composerHookSource = readFileSync(
  new URL('../src/features/publications/use-publication-composer.ts', import.meta.url),
  'utf8',
);

test('keeps text editable while image tools remain busy', () => {
  assert.match(composerSource, /const editorDisabled = disabled;/u);
  assert.match(
    composerSource,
    /const isBusy = disabled \|\| isPreparingImage \|\| !normalizationReady;/u,
  );
  assert.match(composerSource, /<MaxRichTextEditor[\s\S]*?disabled=\{editorDisabled\}/u);
});

test('publishing page owns media preparation and blocks review, test, publish, and close', () => {
  assert.match(pageSource, /const \[mediaPreparing, setMediaPreparing\] = useState\(false\)/u);
  assert.match(pageSource, /const isBusy = operationBusy \|\| mediaPreparing;/u);
  assert.match(
    contentEditorSource,
    /<BroadcastContentComposer[\s\S]*?disabled=\{operationBusy\}[\s\S]*?onImagePreparationChange=\{onImagePreparationChange\}/u,
  );
  assert.match(pageSource, /function requestCloseEditor[\s\S]*?if \(isBusy\) \{/u);
  assert.match(pageSource, /function submitPublication[\s\S]*?if \(mediaPreparing\) \{/u);
  assert.match(pageSource, /function handlePrimaryAction[\s\S]*?if \(mediaPreparing\) \{/u);
  assert.match(
    pageSource,
    /function handleTest[\s\S]*?testMutation\.isPending \|\| mediaPreparing/u,
  );
  assert.match(pageSource, /<BroadcastPublishReviewSheet[\s\S]*?isBusy=\{isBusy\}/u);
});

test('pending image work protects native and browser close before the first image is ready', () => {
  assert.match(
    pageSource,
    /usePublicationComposer\([\s\S]*?isPublisherProfile,[\s\S]*?mediaPreparing,[\s\S]*?userId,/u,
  );
  assert.match(composerHookSource, /pendingWork \|\| hasDraft/u);
});

test('composer invalidates and aborts an image run during teardown', () => {
  assert.match(composerSource, /preparationRunIdRef\.current \+= 1;/u);
  assert.match(composerSource, /preparationAbortRef\.current\?\.abort\(\);/u);
  assert.match(composerSource, /if \(!isCurrentRun\(\) \|\| result\.aborted\) \{/u);
});

test('picker return state is also cleared when the native picker is cancelled', () => {
  assert.match(composerSource, /addEventListener\('cancel', handlePickerCancel\)/u);
  assert.match(composerSource, /removeEventListener\('cancel', handlePickerCancel\)/u);
});

test('editor close flushes the latest autosave and successful publication awaits draft clearing', () => {
  assert.match(
    pageSource,
    /function requestCloseEditor[\s\S]*?setEditorClosePending\(true\)[\s\S]*?flushDraft\(\)/u,
  );
  assert.match(pageSource, /await clearDraft\(\);[\s\S]*?closeEditor\(false\);/u);
  assert.match(composerHookSource, /visibilitychange[\s\S]*?pagehide/u);
  assert.match(composerHookSource, /flushPublicationDraftStorage\(normalizedUserId\)/u);
});

test('image normalization and preview data urls are memoized across text edits', () => {
  assert.match(composerSource, /const currentImages = useMemo\(/u);
  assert.match(composerSource, /const imagePreviewItems = useMemo\(/u);
  assert.match(composerSource, /\[currentImages, maxImageCount\]/u);
});

test('missing persisted photo bytes require explicit reselection or dismissal', () => {
  assert.match(pageSource, /imagesNeedReselection/u);
  assert.match(contentEditorSource, /Фото из локального черновика недоступны/u);
  assert.match(contentEditorSource, /onDiscardMissingImages\(\)/u);
  assert.match(contentEditorSource, /onResolveMissingImages\(\)/u);
});
