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

test('poll editor preserves the stored plain or markdown source format', () => {
  assert.match(
    pollWorkspaceSource,
    /<BroadcastContentComposer[\s\S]*?text=\{draft\.question\}[\s\S]*?sourceFormat=\{draft\.questionFormat\}/u,
  );
});

test('new polls stay available alongside current polls and both tabs can load more', () => {
  assert.doesNotMatch(pollWorkspaceSource, /currentPolls\.length\s*(?:>|===)\s*0/u);
  assert.doesNotMatch(pollWorkspaceSource, /showCreateButton/u);
  assert.match(
    pollWorkspaceSource,
    /className="managed-poll-workspace__create"[\s\S]*?onClick=\{startNewPoll\}/u,
  );
  assert.match(pollWorkspaceSource, /scope: 'current'/u);
  assert.match(pollWorkspaceSource, /scope: 'archive'/u);
  assert.match(pollWorkspaceSource, /\{selectedPollsQuery\.hasNextPage \? \(/u);
  assert.match(pollWorkspaceSource, /count: currentPollTotal/u);
  assert.match(pollWorkspaceSource, /count: archivePollTotal/u);
});

test('failed publication reconciles remote state before offering a retry', () => {
  const publishMutationSource = pollWorkspaceSource.match(
    /const publishMutation = useMutation\([\s\S]*?\n {2}const closeMutation = useMutation/u,
  )?.[0];

  assert.ok(publishMutationSource);
  assert.match(
    publishMutationSource,
    /onError:[\s\S]*?await getManagedPoll\([\s\S]*?if \(!isManagedPollEditable\(latestPoll\)\)[\s\S]*?setDraft\(null\)[\s\S]*?const nextDraft = toEditorDraft\(latestPoll\)[\s\S]*?setDraft\(nextDraft\)/u,
  );
});

test('opening a stale poll never exposes a locked draft editor', () => {
  const openMutationSource = pollWorkspaceSource.match(
    /const openPollMutation = useMutation\([\s\S]*?\n {2}const saveMutation = useMutation/u,
  )?.[0];

  assert.ok(openMutationSource);
  assert.match(
    openMutationSource,
    /if \(!isManagedPollEditable\(poll\)\)[\s\S]*?setDraft\(null\)[\s\S]*?return;[\s\S]*?toEditorDraft\(poll\)/u,
  );
});

test('stale saves rebase authored edits and require an explicit retry before publishing', () => {
  const persistDraftSource = pollWorkspaceSource.match(
    /const persistDraft = useCallback\([\s\S]*?\n {2}const recoverFromEditConflict/u,
  )?.[0];
  const saveMutationSource = pollWorkspaceSource.match(
    /const saveMutation = useMutation\([\s\S]*?\n {2}const publishMutation/u,
  )?.[0];
  const publishMutationSource = pollWorkspaceSource.match(
    /const publishMutation = useMutation\([\s\S]*?\n {2}const closeMutation/u,
  )?.[0];

  assert.ok(persistDraftSource);
  assert.match(
    persistDraftSource,
    /!value\.pollId[\s\S]*?createManagedPoll\([\s\S]*?!value\.expectedUpdatedAt[\s\S]*?throw new Error[\s\S]*?updateManagedPoll\([\s\S]*?expectedUpdatedAt: value\.expectedUpdatedAt/u,
  );
  assert.ok(saveMutationSource);
  assert.match(
    saveMutationSource,
    /onError: async \(error, value\)[\s\S]*?recoverFromEditConflict\(error, value,[\s\S]*?\{\n\s+return;/u,
  );
  assert.ok(publishMutationSource);
  assert.match(
    publishMutationSource,
    /const persistedDraft = publishSavedPollRef\.current;[\s\S]*?!persistedDraft[\s\S]*?recoverFromEditConflict\(error, value,[\s\S]*?\{\n\s+return;/u,
  );
});

test('poll composition mutations refresh both scoped list totals', () => {
  const invalidateSource = pollWorkspaceSource.match(
    /const invalidatePollLists = useCallback\([\s\S]*?\n {2}const persistDraft/u,
  )?.[0];

  assert.ok(invalidateSource);
  assert.match(invalidateSource, /queryKey: currentListQueryKey/u);
  assert.match(invalidateSource, /queryKey: archiveListQueryKey/u);

  const mutationBoundaries = [
    ['saveMutation', 'publishMutation'],
    ['publishMutation', 'closeMutation'],
    ['closeMutation', 'refreshMutation'],
    ['resetPublicationMutation', 'deleteMutation'],
    ['deleteMutation', 'isBusy'],
  ] as const;
  for (const [mutationName, nextName] of mutationBoundaries) {
    const start = pollWorkspaceSource.indexOf(`const ${mutationName} = useMutation(`);
    const end = pollWorkspaceSource.indexOf(`const ${nextName}`, start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    assert.match(
      pollWorkspaceSource.slice(start, end),
      /onSettled:[\s\S]*?invalidatePollLists\(\)/u,
    );
  }
});

test('long poll mutations release modal navigation and fall through native Back', () => {
  const panelCloseSource = pollWorkspaceSource.match(
    /const requestPanelClose = useCallback\([\s\S]*?\n {2}useImperativeHandle/u,
  )?.[0];
  const nativeBackSource = pollWorkspaceSource.match(
    /useNativeBackHandler\([\s\S]*?priority: 650/u,
  )?.[0];

  assert.ok(panelCloseSource);
  assert.doesNotMatch(panelCloseSource, /isBusy/u);
  assert.ok(nativeBackSource);
  assert.match(nativeBackSource, /if \(draft\)[\s\S]*?if \(isBusy\)[\s\S]*?return false;/u);

  const confirmHandlers = pollWorkspaceSource.match(
    /onConfirm=\{\(\) => \{\n\s+const confirmedState = confirmState;[\s\S]*?\n\s+\}\}/gu,
  );
  assert.equal(confirmHandlers?.length, 2);
  for (const handler of confirmHandlers ?? []) {
    const releaseIndex = handler.indexOf('setConfirmState(null)');
    const mutationIndex = handler.indexOf('Mutation.mutate(');
    assert.notEqual(releaseIndex, -1);
    assert.notEqual(mutationIndex, -1);
    assert.equal(releaseIndex < mutationIndex, true);
  }

  assert.match(chatPollSettingsSource, /\{expanded \? \([\s\S]*?<LazyManagedPollWorkspace/u);
  assert.match(
    channelSettingsSource,
    /\{expandedSections\.polls \? \([\s\S]*?<LazyManagedPollWorkspace/u,
  );
});
