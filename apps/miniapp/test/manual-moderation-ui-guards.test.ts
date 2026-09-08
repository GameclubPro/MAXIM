import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const eventsPageSource = readFileSync(
  new URL('../src/pages/events-page.tsx', import.meta.url),
  'utf8',
);
const confirmSheetSource = readFileSync(
  new URL('../src/components/ui/action-confirm-sheet.tsx', import.meta.url),
  'utf8',
);
const confirmSheetCss = readFileSync(
  new URL('../src/components/ui/action-confirm-sheet.css', import.meta.url),
  'utf8',
);

test('manual moderation shows progress on the selected scope action', () => {
  assert.match(eventsPageSource, /setPendingScopeChoice\(scope\);/u);
  assert.match(
    eventsPageSource,
    /confirmBusy=\{[\s\S]*?pendingScopeChoice === 'current_chat'[\s\S]*?extraActionBusy=\{[\s\S]*?pendingScopeChoice === 'all_chats'/u,
  );
  assert.match(confirmSheetSource, /const isConfirmBusy = confirmBusy \?\? isBusy;/u);
  assert.match(confirmSheetSource, /isConfirmBusy \? confirmBusyLabel : confirmLabel/u);
});

test('disabled confirmation actions have a visible state', () => {
  assert.match(confirmSheetCss, /\.action-confirm-sheet__button:disabled\s*\{[\s\S]*?opacity:/u);
});

test('history actions keep the confirmation visible until the request settles', () => {
  const start = eventsPageSource.indexOf('function ViolationModerationControls');
  assert.ok(start >= 0);
  const source = eventsPageSource.slice(start);
  const actionStart = source.indexOf('const applyAction =');
  const actionEnd = source.indexOf('const openScopeAction =', actionStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  const action = source.slice(actionStart, actionEnd);
  assert.match(action, /if \(applyMutation\.isPending\) return;/u);
  assert.doesNotMatch(action, /setPendingScopeAction\(null\)/u);
  assert.match(
    eventsPageSource,
    /confirmBusy=\{applyMutation\.isPending && pendingScopeChoice === 'current_chat'\}/u,
  );
  assert.match(
    eventsPageSource,
    /extraActionBusy=\{applyMutation\.isPending && pendingScopeChoice === 'all_chats'\}/u,
  );
});
