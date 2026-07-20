import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAuthQueryClient,
  resolveAuthQueryPrincipalKey,
} from '../src/lib/auth-query-session';

function createInitData(userId: string, authDate: number, hash: string): string {
  return new URLSearchParams({
    auth_date: String(authDate),
    hash,
    user: JSON.stringify({ id: userId }),
  }).toString();
}

test('auth query principal survives credential rotation for the same signed user', () => {
  const initial = createInitData('user-1', 1, 'old-hash');
  const refreshed = createInitData('user-1', 2, 'new-hash');

  assert.equal(resolveAuthQueryPrincipalKey(initial, false), 'user:user-1');
  assert.equal(
    resolveAuthQueryPrincipalKey(initial, false),
    resolveAuthQueryPrincipalKey(refreshed, false),
  );
});

test('auth query principal changes when late bridge data belongs to another signed user', () => {
  const fallback = createInitData('user-1', 1, 'fallback-hash');
  const bridge = createInitData('user-2', 2, 'bridge-hash');

  assert.notEqual(
    resolveAuthQueryPrincipalKey(fallback, false),
    resolveAuthQueryPrincipalKey(bridge, false),
  );
});

test('unresolved auth principals rotate opaque keys without exposing credentials', () => {
  let sequence = 0;
  const createSessionId = () => `opaque-${(sequence += 1)}`;
  const initialCredentials = 'auth_date=1&hash=secret-old-hash';
  const nextCredentials = 'auth_date=2&hash=secret-new-hash';
  const initial = resolveAuthQueryPrincipalKey(
    initialCredentials,
    false,
    createSessionId,
  );
  const rotated = resolveAuthQueryPrincipalKey(
    nextCredentials,
    false,
    createSessionId,
  );

  assert.equal(initial, 'unresolved:opaque-1');
  assert.equal(rotated, 'unresolved:opaque-2');
  assert.equal(rotated.includes('secret-new-hash'), false);
  assert.equal(rotated.includes(nextCredentials), false);
});

test('clearing an auth query client aborts active requests and removes cached data', async () => {
  const queryClient = createAuthQueryClient();
  let markStarted: (() => void) | null = null;
  let aborted = false;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  queryClient.setQueryData(['session-data'], { owner: 'user-1' });
  const pendingQuery = queryClient
    .fetchQuery({
      queryKey: ['pending-session-data'],
      queryFn: ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
          markStarted?.();
        }),
    })
    .catch(() => undefined);

  await started;
  queryClient.clear();
  await pendingQuery;

  assert.equal(aborted, true);
  assert.equal(queryClient.getQueryCache().getAll().length, 0);
});
