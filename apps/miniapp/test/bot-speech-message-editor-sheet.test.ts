import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isElementInTopmostNativeBackModal,
  NATIVE_BACK_RICH_TEXT_LINK_PRIORITY,
  registerNativeBackHandler,
  runNativeBackHandlers,
} from '../src/lib/native-back';

const editorSheetSource = readFileSync(
  new URL('../src/components/bot-speech-message-editor-sheet.tsx', import.meta.url),
  'utf8',
);
const editorSheetCss = [
  readFileSync(
    new URL('../src/components/bot-speech-message-editor-sheet.css', import.meta.url),
    'utf8',
  ),
  readFileSync(
    new URL('../src/components/bot-speech-message-editor-sheet-a11y.css', import.meta.url),
    'utf8',
  ),
].join('\n');
const richTextEditorSource = readFileSync(
  new URL('../src/components/max-rich-text-editor.tsx', import.meta.url),
  'utf8',
);

test('bot speech editor keeps focus inside the topmost named dialog', () => {
  assert.match(editorSheetSource, /useDialogFocusTrap\(true, panelRef, closeButtonRef\);/u);
  assert.match(
    editorSheetSource,
    /ref=\{panelRef\}[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-label=\{ariaLabel\}[\s\S]*?aria-labelledby=\{titleId\}[\s\S]*?tabIndex=\{-1\}/u,
  );
  assert.match(editorSheetSource, /<h2 id=\{titleId\}>\{title\}<\/h2>/u);
  assert.match(editorSheetSource, /ref=\{closeButtonRef\}[\s\S]*?aria-label="Закрыть редактор"/u);
  assert.match(
    editorSheetSource,
    /event\.key !== 'Escape'[\s\S]*?isTopmostModalDialog\(panel\)[\s\S]*?onClose\(\)/u,
  );
  assert.match(editorSheetSource, /BOT_MESSAGE_EDITOR_NATIVE_BACK_PRIORITY = 700/u);
  assert.match(
    editorSheetSource,
    /bot-message-editor-sheet__backdrop[\s\S]*?tabIndex=\{-1\}/u,
  );
});

test('rich text link panel handles native Back before its parent speech editor', () => {
  assert.match(richTextEditorSource, /priority: NATIVE_BACK_RICH_TEXT_LINK_PRIORITY/u);
  assert.match(
    richTextEditorSource,
    /!root \|\| !isElementInTopmostNativeBackModal\(root\)[\s\S]*?return false;/u,
  );

  const handled: string[] = [];
  const unregisterParent = registerNativeBackHandler(
    () => {
      handled.push('parent');
      return true;
    },
    { priority: 700 },
  );
  const unregisterLinkPanel = registerNativeBackHandler(
    () => {
      handled.push('link');
      return true;
    },
    { priority: NATIVE_BACK_RICH_TEXT_LINK_PRIORITY },
  );

  try {
    assert.equal(runNativeBackHandlers(), true);
    assert.deepEqual(handled, ['link']);
  } finally {
    unregisterLinkPanel();
    unregisterParent();
  }
});

test('native Back modal ownership follows the newest visible dialog', () => {
  const editor = {} as HTMLElement;
  const ownerDialog = {
    contains: (candidate: Element) => candidate === editor,
    getAttribute: () => null,
    hasAttribute: () => false,
  } as unknown as HTMLElement;
  const newerDialog = {
    contains: () => false,
    getAttribute: () => null,
    hasAttribute: () => false,
  } as unknown as HTMLElement;
  const originalDocument = globalThis.document;

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [ownerDialog, newerDialog] },
  });
  try {
    assert.equal(isElementInTopmostNativeBackModal(editor), false);
  } finally {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
  }
});

test('a newer modal handles native Back when a rich text link panel is underneath it', () => {
  const handled: string[] = [];
  const unregisterModal = registerNativeBackHandler(
    () => {
      handled.push('modal');
      return true;
    },
    { priority: 680 },
  );
  const unregisterCoveredLinkPanel = registerNativeBackHandler(
    () => {
      handled.push('covered-link');
      return false;
    },
    { priority: NATIVE_BACK_RICH_TEXT_LINK_PRIORITY },
  );

  try {
    assert.equal(runNativeBackHandlers(), true);
    assert.deepEqual(handled, ['covered-link', 'modal']);
  } finally {
    unregisterCoveredLinkPanel();
    unregisterModal();
  }
});

test('bot speech editor keeps every compact action at least 44px', () => {
  assert.match(
    editorSheetCss,
    /\.bot-message-editor-sheet__close \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u,
  );
  assert.match(
    editorSheetCss,
    /\.bot-message-editor-sheet__tool \{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/u,
  );
  assert.match(
    editorSheetCss,
    /\.bot-message-editor-sheet__media-remove \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u,
  );
  assert.match(
    editorSheetCss,
    /\.bot-message-editor-sheet__media-button \{[\s\S]*?min-height: 44px;/u,
  );
  assert.match(
    editorSheetCss,
    /\.bot-message-editor-sheet__rich-editor \.max-rich-text-editor__link-panel button \{[\s\S]*?min-width: 44px;[\s\S]*?height: 44px;/u,
  );
  assert.match(editorSheetCss, /\.bot-message-editor-sheet__rich-editor:focus-within/u);
});
