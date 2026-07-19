import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createHomeRefreshCooldownDeadline,
  getHomeRefreshCooldownRemainingSec,
} from '../src/pages/home-refresh-cooldown';

const chatsPageSource = readFileSync(
  new URL('../src/pages/chats-page.tsx', import.meta.url),
  'utf8',
);

test('home refresh cooldown keeps a response-scoped deadline', () => {
  assert.equal(createHomeRefreshCooldownDeadline(18_250, 1_000), 19_250);
  assert.equal(createHomeRefreshCooldownDeadline(0, 1_000), null);
  assert.equal(createHomeRefreshCooldownDeadline(null, 1_000), null);
});

test('home refresh cooldown counts down and expires', () => {
  const deadlineAtMs = createHomeRefreshCooldownDeadline(2_500, 10_000);

  assert.equal(getHomeRefreshCooldownRemainingSec(deadlineAtMs, 10_000), 3);
  assert.equal(getHomeRefreshCooldownRemainingSec(deadlineAtMs, 11_501), 1);
  assert.equal(getHomeRefreshCooldownRemainingSec(deadlineAtMs, 12_500), null);
});

test('home refresh cooldown catches up after a background-tab deadline expires', () => {
  assert.match(
    chatsPageSource,
    /if \(remainingMs <= 0\) \{\s+if \(manualRefreshClockMs < deadlineAtMs\) \{\s+setManualRefreshClockMs\(Date\.now\(\)\);/u,
  );
  assert.match(
    chatsPageSource,
    /document\.addEventListener\('visibilitychange', updateClockWhenVisible\)/u,
  );
  assert.match(chatsPageSource, /disabled=\{isFetching \|\| isManualRefreshInProgressByState\}/u);
});
