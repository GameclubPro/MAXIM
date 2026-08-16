import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthSessionCoordinator } from '../src/lib/auth-session-coordinator';

function createInitData(userId: string, authDate: number, hash: string): string {
  return new URLSearchParams({
    auth_date: String(authDate),
    hash,
    user: JSON.stringify({ id: userId }),
  }).toString();
}

test('auth latch only recovers for a new full credential belonging to the same user', () => {
  const initial = createInitData('user-1', 10, 'old-hash');
  const refreshed = createInitData('user-1', 11, 'new-hash');
  const otherUser = createInitData('user-2', 12, 'other-hash');
  const coordinator = createAuthSessionCoordinator(initial);
  const events: string[] = [];
  coordinator.subscribe((event) => events.push(event.type));

  assert.equal(coordinator.markUnauthorized(initial), true);
  assert.equal(coordinator.isBlocked(initial), true);
  assert.equal(coordinator.observeInitData('auth_date=11&hash=incomplete'), false);
  assert.equal(coordinator.observeInitData(otherUser), false);
  assert.equal(coordinator.isBlocked(otherUser), true);
  assert.equal(coordinator.observeInitData(refreshed), true);
  assert.equal(coordinator.isBlocked(refreshed), false);
  assert.deepEqual(events, ['locked', 'recovered']);
});

test('concurrent 401 responses share one credential recovery attempt', async () => {
  const initial = createInitData('user-1', 10, 'old-hash');
  const coordinator = createAuthSessionCoordinator(initial);
  let resolveReplacement: ((value: string) => void) | null = null;
  let reads = 0;
  const replacement = new Promise<string>((resolve) => {
    resolveReplacement = resolve;
  });
  const readReplacement = () => {
    reads += 1;
    return replacement;
  };

  const first = coordinator.recoverAfterUnauthorized(initial, readReplacement);
  const second = coordinator.recoverAfterUnauthorized(initial, readReplacement);
  assert.equal(reads, 1);
  assert.equal(coordinator.hasPendingRecovery(initial), true);

  resolveReplacement?.('');
  assert.deepEqual(await Promise.all([first, second]), ['', '']);
  assert.equal(coordinator.getSnapshot().blocked, true);
  assert.equal(coordinator.getSnapshot().recovering, false);
});

test('a late stale observation cannot replace a newer credential', () => {
  const initial = createInitData('user-1', 10, 'old-hash');
  const refreshed = createInitData('user-1', 11, 'new-hash');
  const coordinator = createAuthSessionCoordinator(initial);

  assert.equal(coordinator.observeInitData(refreshed), false);
  assert.equal(coordinator.observeInitData(initial), false);
  assert.equal(coordinator.markUnauthorized(initial), false);
  assert.equal(coordinator.isBlocked(refreshed), false);
});
