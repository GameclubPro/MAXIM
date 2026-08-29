import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const shellSource = readFileSync(new URL('../src/components/shell.tsx', import.meta.url), 'utf8');
const modulesSource = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.tsx', import.meta.url),
  'utf8',
);
const createSheetSource = readFileSync(
  new URL('../src/components/auto-reply-create-sheet.tsx', import.meta.url),
  'utf8',
);
const composerSource = readFileSync(
  new URL('../src/components/broadcast-content-composer.tsx', import.meta.url),
  'utf8',
);
const richEditorSource = readFileSync(
  new URL('../src/components/max-rich-text-editor.tsx', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(
  new URL('../src/pages/publisher-auto-replies-page.tsx', import.meta.url),
  'utf8',
);
const pageCss = readFileSync(
  new URL('../src/pages/publisher-auto-replies-page.css', import.meta.url),
  'utf8',
);
const draftStorageSource = readFileSync(
  new URL('../src/lib/auto-reply-draft.ts', import.meta.url),
  'utf8',
);

test('auto-replies are a lazy Publisher chat workspace with guarded native back', () => {
  assert.match(appSource, /import\('\.\/pages\/publisher-auto-replies-page'\)/u);
  assert.match(appSource, /path="\/publisher\/chat\/:entityId\/auto-replies"/u);
  assert.match(appSource, /managedEntityWorkspace[\s\S]*?profile="publisher"/u);
  assert.match(shellSource, /isPublisherAutoRepliesRoute/u);
  assert.match(shellSource, /managedEntityNavigation\.requestBack\(managedEntityBackRoute\)/u);
  assert.match(pageSource, /useManagedEntityLeaveGuard/u);
  assert.match(pageSource, /useNativeBackHandler/u);
});

test('the module catalog exposes auto-replies only inside the chat branch', () => {
  assert.match(
    modulesSource,
    /\{entity\.entityType === 'chat' \? \([\s\S]*?<strong>Автоответы<\/strong>[\s\S]*?buildPublisherAutoRepliesRoute/u,
  );
  assert.match(modulesSource, /<span>Открыть<\/span>/u);
});

test('rich editor keeps retained assets by reference and new images inline', () => {
  assert.match(pageSource, /type: 'image-ref' as const/u);
  assert.match(pageSource, /type: 'image' as const/u);
  assert.match(pageSource, /getPublisherAutoReplyAsset/u);
  assert.match(pageSource, /URL\.createObjectURL/u);
  assert.doesNotMatch(pageSource, /data:\$\{asset\.mimeType\}/u);
  assert.match(pageSource, /<BroadcastContentComposer/u);
  assert.match(pageSource, /<MaxMarkdownPreview/u);
});

test('auto-reply buttons reuse the posting editor and persist across create and edit', () => {
  assert.match(pageSource, /import\('\.\.\/features\/publications\/publication-buttons-sheet'\)/u);
  assert.match(pageSource, /<PublicationButtonsSheet/u);
  assert.match(pageSource, /buttons=\{draft\.buttons\}/u);
  assert.match(pageSource, /buttonsPerRow=\{1\}/u);
  assert.match(pageSource, /onOpenButtons=\{\(\) => setButtonsOpen\(true\)\}/u);
  assert.match(pageSource, /buttons: normalized\.buttons\.map/u);
  assert.match(pageSource, /formatBroadcastButtonsStatus\(rule\.content\.buttons\)/u);
  assert.match(draftStorageSource, /buttons: readButtons\(draft\.buttons\)/u);
});

test('new rules are enabled directly while edit and list keep their switches', () => {
  assert.match(pageSource, /createPublisherAutoReply[\s\S]*?enabled: true/u);
  assert.match(
    pageSource,
    /\{rule \? \([\s\S]*?<strong>Правило включено<\/strong>[\s\S]*?<AutoReplySwitch/u,
  );
  assert.match(pageSource, /<AutoReplyRuleRow[\s\S]*?onToggle=/u);
  assert.match(pageSource, /rule \? \(draft\.enabled \? 'включён' : 'выключен'\) : null/u);
});

test('auto-reply controls and fixed media geometry stay usable on narrow WebViews', () => {
  assert.match(pageCss, /\.auto-reply-switch \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u);
  assert.match(
    pageCss,
    /\.publisher-auto-reply-row__actions button \{[\s\S]*?min-width: 44px;[\s\S]*?height: 44px;/u,
  );
  assert.match(pageCss, /\.publisher-auto-reply-editor__retained-item \{[\s\S]*?aspect-ratio: 1;/u);
  assert.match(pageCss, /@media \(max-width: 340px\)/u);
  assert.match(pageCss, /html\[data-max-theme='dark'\]/u);
  assert.match(
    pageCss,
    /\.max-rich-text-editor__link-panel button \{[\s\S]*?min-width: 44px;[\s\S]*?height: 44px;/u,
  );
  assert.match(pageCss, /--auto-reply-primary-ink: var\(--app-page-background\)/u);
  assert.doesNotMatch(pageCss, /font-size:\s*(?:clamp|min|max)\([^;]*vw/u);
});

test('auto-reply copy and validation stay concise and actionable', () => {
  assert.match(createSheetSource, />Создать здесь</u);
  assert.match(createSheetSource, /'Открыть Публика'/u);
  assert.match(pageSource, /<strong>Автоответы в чате<\/strong>/u);
  assert.match(pageSource, /aria-invalid=\{Boolean\(issues\.phrase\)\}/u);
  assert.match(pageSource, /aria-describedby="publisher-auto-reply-phrase-meta"/u);
  assert.match(pageSource, /role=\{issues\.phrase \? 'alert' : undefined\}/u);
  assert.match(composerSource, /ariaInvalid=\{Boolean\(textError\)\}/u);
  assert.match(composerSource, /ariaDescribedBy=\{textError \? textErrorId : undefined\}/u);
  assert.match(composerSource, /id=\{textErrorId\}[\s\S]*?role="alert"/u);
  assert.match(richEditorSource, /aria-invalid=\{ariaInvalid\}/u);
  assert.match(richEditorSource, /aria-describedby=\{ariaDescribedBy\}/u);
  assert.doesNotMatch(
    pageSource,
    /Главный выключатель|Проверить и сохранить|Включить автоответ\?/u,
  );
  assert.match(pageCss, /\.publisher-auto-replies-page__add \{[\s\S]*?position: fixed;/u);
});
