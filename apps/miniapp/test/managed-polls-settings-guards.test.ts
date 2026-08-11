import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatPollSettingsSource = readFileSync(
  new URL('../src/pages/settings/settings-polls-section.tsx', import.meta.url),
  'utf8',
);
const channelSettingsSource = readFileSync(
  new URL('../src/pages/channel-settings-page.tsx', import.meta.url),
  'utf8',
);
const pollWorkspaceSource = readFileSync(
  new URL('../src/components/managed-poll-workspace.tsx', import.meta.url),
  'utf8',
);

test('chat and channel settings mount entity-scoped poll workspaces', () => {
  assert.match(
    chatPollSettingsSource,
    /<LazyManagedPollWorkspace[\s\S]*?entityType="chat"[\s\S]*?entityId=\{chatId\}/u,
  );
  assert.match(
    channelSettingsSource,
    /<LazyManagedPollWorkspace[\s\S]*?entityType="channel"[\s\S]*?entityId=\{chatId\}/u,
  );
});

test('shared poll workspace uses entity-neutral publication copy', () => {
  assert.doesNotMatch(pollWorkspaceSource, /Обновить пост|Пост не обновился|Пост обновлён/u);
  assert.match(pollWorkspaceSource, /entityType === 'channel' \? 'в канале' : 'в чате'/u);
});

test('new polls stay available alongside current polls and both tabs can load more', () => {
  assert.doesNotMatch(pollWorkspaceSource, /currentPolls\.length\s*(?:>|===)\s*0/u);
  assert.doesNotMatch(pollWorkspaceSource, /showCreateButton/u);
  assert.match(
    pollWorkspaceSource,
    /className="managed-poll-workspace__create"[\s\S]*?onClick=\{startNewPoll\}/u,
  );
  assert.match(pollWorkspaceSource, /\{pollsQuery\.hasNextPage \? \(/u);
  assert.doesNotMatch(pollWorkspaceSource, /tab === 'archive' && pollsQuery\.hasNextPage/u);
});

test('failed publication keeps the persisted draft open for retry', () => {
  const publishMutationSource = pollWorkspaceSource.match(
    /const publishMutation = useMutation\([\s\S]*?\n {2}const closeMutation = useMutation/u,
  )?.[0];

  assert.ok(publishMutationSource);
  assert.match(
    publishMutationSource,
    /onError:[\s\S]*?const persistedDraft = publishSavedPollRef\.current;[\s\S]*?const nextDraft = toEditorDraft\(persistedDraft\);[\s\S]*?setDraft\(nextDraft\);[\s\S]*?setSavedDraft\(nextDraft\);/u,
  );
  assert.doesNotMatch(publishMutationSource, /onError:[\s\S]*?setDraft\(null\)/u);
});
