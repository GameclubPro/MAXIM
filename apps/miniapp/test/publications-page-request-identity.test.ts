import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(
  new URL('../src/pages/publications-page.tsx', import.meta.url),
  'utf8',
);

function getMutationBlock(start: string, end: string): string {
  return pageSource.slice(pageSource.indexOf(start), pageSource.indexOf(end));
}

function assertStableMutationIdentity(
  block: string,
  resolveMethod: string,
  confirmMethod: string,
): void {
  assert.match(block, new RegExp(`requestIds\\.${resolveMethod}`, 'u'));
  assert.match(block, new RegExp(`onSuccess:[\\s\\S]*?requestIds\\.${confirmMethod}\\(\\)`, 'u'));
  assert.doesNotMatch(
    block,
    new RegExp(`onError:[\\s\\S]*?requestIds\\.${confirmMethod}\\(\\)`, 'u'),
  );
}

test('publication page reuses mutation identities and clears them only after success', () => {
  const saveBlock = getMutationBlock(
    'const saveMutation = useMutation',
    'const testMutation = useMutation',
  );
  const testBlock = getMutationBlock(
    'const testMutation = useMutation',
    'const openPublicationMutation = useMutation',
  );

  assert.match(saveBlock, /requestIds\.resolveSaveRequestId/u);
  assert.match(saveBlock, /onSuccess:[\s\S]*?requestIds\.confirmSaveSuccess\(\)/u);
  assert.doesNotMatch(saveBlock, /onError:[\s\S]*?requestIds\.confirmSaveSuccess\(\)/u);

  assert.match(testBlock, /requestIds\.resolveTestRequestId/u);
  assert.match(testBlock, /onSuccess:[\s\S]*?requestIds\.confirmTestSuccess\(\)/u);
  assert.doesNotMatch(testBlock, /onError:[\s\S]*?requestIds\.confirmTestSuccess\(\)/u);
  assert.match(testBlock, /isPublicationTestResultPendingError/u);
  assert.match(testBlock, /PUBLICATION_TEST_RESULT_PENDING_FEEDBACK/u);

  assertStableMutationIdentity(
    getMutationBlock('const actionMutation = useMutation', 'const retryMutation = useMutation'),
    'resolveActionRequestId',
    'confirmActionSuccess',
  );
  assertStableMutationIdentity(
    getMutationBlock(
      'const retryMutation = useMutation',
      'const resolveAmbiguousMutation = useMutation',
    ),
    'resolveRetryRequestId',
    'confirmRetrySuccess',
  );
  assertStableMutationIdentity(
    getMutationBlock('const resolveAmbiguousMutation = useMutation', 'const visibleItems ='),
    'resolveAmbiguousRequestId',
    'confirmAmbiguousSuccess',
  );
});
