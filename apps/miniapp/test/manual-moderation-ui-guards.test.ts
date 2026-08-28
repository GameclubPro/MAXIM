import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const eventsPageSource = readFileSync(new URL('../src/pages/events-page.tsx', import.meta.url), 'utf8');
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
