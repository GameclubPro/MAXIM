import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isManagedEntityWorkspacePath } from '../src/lib/last-chat';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const dialogPageSource = readSource('../src/pages/channel-dialog-page.tsx');
const suggestDialogPageSource = readSource('../src/pages/channel-suggest-dialog-page.tsx');
const shellSource = readSource('../src/components/shell.tsx');
const unavailableStateSource = readSource('../src/components/public-dialog-unavailable-state.tsx');

test('only managed settings and statistics routes can update last-managed state', () => {
  assert.equal(isManagedEntityWorkspacePath('/chat/chat-a/settings'), true);
  assert.equal(isManagedEntityWorkspacePath('/chat/chat-a/events'), true);
  assert.equal(isManagedEntityWorkspacePath('/channel/channel-a/settings'), true);
  assert.equal(isManagedEntityWorkspacePath('/channel/channel-a/stats'), true);

  assert.equal(isManagedEntityWorkspacePath('/chat/public-b/dialog/comments'), false);
  assert.equal(isManagedEntityWorkspacePath('/channel/public-b/dialog/comments'), false);
  assert.equal(isManagedEntityWorkspacePath('/channel/public-b/dialog/suggest'), false);
  assert.equal(isManagedEntityWorkspacePath('/chat/chat-a/stats'), false);
  assert.equal(isManagedEntityWorkspacePath('/channel/channel-a/events'), false);

  assert.match(
    shellSource,
    /const isManagedEntityRoute = isManagedEntityWorkspacePath\(location\.pathname\)/u,
  );
  assert.match(
    shellSource,
    /if \(!chatId \|\| !isManagedEntityRoute\) \{[\s\S]*?saveLastEntityId/u,
  );
});

test('public dialog pages keep terminal failures in the public flow', () => {
  assert.match(dialogPageSource, /setTerminalDialogErrorState\(\{/u);
  assert.match(suggestDialogPageSource, /setTerminalDialogErrorState\(\[/u);

  for (const source of [dialogPageSource, suggestDialogPageSource]) {
    assert.match(source, /<PublicDialogUnavailableState/u);
    assert.match(
      source,
      /title=\{sessionExpired \? 'Нужно открыть приложение заново' : 'Диалог недоступен'\}/u,
    );
    assert.doesNotMatch(source, /buildManagedEntitiesRoute|saveLastEntityId|navigate\(/u);
  }

  assert.match(unavailableStateSource, /onClick=\{\(\) => closeMaxMiniApp\(\)\}/u);
  assert.match(unavailableStateSource, /Закрыть приложение/u);
});
