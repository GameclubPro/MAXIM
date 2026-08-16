import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryObserver } from '@tanstack/react-query';
import { createApiRequestError } from '../src/lib/api-request-error';
import { createAuthQueryClient, resolveAuthQueryPrincipalKey } from '../src/lib/auth-query-session';
import { createAuthSessionCoordinator } from '../src/lib/auth-session-coordinator';

function createInitData(userId: string, authDate: number, hash: string): string {
  return new URLSearchParams({
    auth_date: String(authDate),
    hash,
    user: JSON.stringify({ id: userId }),
  }).toString();
}

test('auth query principal rotates on credential changes for the same signed user', () => {
  const initial = createInitData('user-1', 1, 'old-hash');
  const refreshed = createInitData('user-1', 2, 'new-hash');
  let sequence = 0;
  const createSessionId = () => `opaque-${(sequence += 1)}`;

  assert.notEqual(
    resolveAuthQueryPrincipalKey(initial, false, createSessionId),
    resolveAuthQueryPrincipalKey(refreshed, false, createSessionId),
  );
});

test('auth query principal changes when late bridge data belongs to another signed user', () => {
  const fallback = createInitData('user-1', 1, 'fallback-hash');
  const bridge = createInitData('user-2', 2, 'bridge-hash');
  let sequence = 0;
  const createSessionId = () => `opaque-${(sequence += 1)}`;

  assert.notEqual(
    resolveAuthQueryPrincipalKey(fallback, false, createSessionId),
    resolveAuthQueryPrincipalKey(bridge, false, createSessionId),
  );
});

test('auth query principals use opaque keys without exposing credentials', () => {
  let sequence = 0;
  const createSessionId = () => `opaque-${(sequence += 1)}`;
  const initialCredentials = 'auth_date=1&hash=secret-old-hash';
  const nextCredentials = 'auth_date=2&hash=secret-new-hash';
  const initial = resolveAuthQueryPrincipalKey(initialCredentials, false, createSessionId);
  const rotated = resolveAuthQueryPrincipalKey(nextCredentials, false, createSessionId);

  assert.equal(initial, 'credential:opaque-1');
  assert.equal(rotated, 'credential:opaque-2');
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

test('credential recovery refetches active 401 queries', async () => {
  const initial = createInitData('user-1', 1, 'old-hash');
  const refreshed = createInitData('user-1', 2, 'new-hash');
  const authSession = createAuthSessionCoordinator(initial);
  const queryClient = createAuthQueryClient(authSession);
  let attempts = 0;
  let allowSuccess = false;
  let markRecoveredRequest: (() => void) | null = null;
  const recoveredRequest = new Promise<void>((resolve) => {
    markRecoveredRequest = resolve;
  });
  const observer = new QueryObserver(queryClient, {
    queryKey: ['active-auth-query'],
    queryFn: async () => {
      attempts += 1;
      if (!allowSuccess) {
        throw createApiRequestError(401, '{"statusCode":401}', 'Срок входа истёк.');
      }
      markRecoveredRequest?.();
      return { owner: 'user-1' };
    },
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);

  const initialResult = await observer.refetch();
  assert.equal(initialResult.isError, true);
  assert.equal(attempts, 1);

  authSession.markUnauthorized(initial);
  allowSuccess = true;
  authSession.observeInitData(refreshed);
  await recoveredRequest;

  assert.equal(attempts, 2);
  unsubscribe();
  queryClient.clear();
});
