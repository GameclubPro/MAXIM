import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBroadcastSendFeedback } from '../src/lib/broadcast-send-feedback';

function buildResult(
  overrides: Partial<Parameters<typeof buildBroadcastSendFeedback>[0]> = {},
): Parameters<typeof buildBroadcastSendFeedback>[0] {
  return {
    targetChats: 1,
    sentChats: 0,
    failedChats: 0,
    nextSendAt: null,
    scheduleId: null,
    scheduledSlots: [],
    scheduledOccurrences: 0,
    ...overrides,
  };
}

test('confirms a completed immediate broadcast only after every target was delivered', () => {
  const feedback = buildBroadcastSendFeedback(buildResult({ sentChats: 1 }));

  assert.equal(feedback.kind, 'delivered');
  assert.equal(feedback.tone, 'success');
  assert.equal(feedback.clearDraft, true);
});

test('keeps a future broadcast as a successful schedule without claiming delivery', () => {
  const feedback = buildBroadcastSendFeedback(
    buildResult({
      nextSendAt: '2026-07-13T09:00:00.000Z',
      scheduledSlots: ['2026-07-13T09:00:00.000Z'],
      scheduledOccurrences: 1,
    }),
  );

  assert.equal(feedback.kind, 'scheduled');
  assert.equal(feedback.title, 'Публикация запланирована');
  assert.equal(feedback.clearDraft, true);
});

test('preserves the draft when an immediate response confirms no delivery or failure', () => {
  const feedback = buildBroadcastSendFeedback(buildResult());

  assert.equal(feedback.kind, 'unconfirmed');
  assert.equal(feedback.tone, 'danger');
  assert.equal(feedback.clearDraft, false);
});

test('preserves the draft when every immediate delivery failed', () => {
  const feedback = buildBroadcastSendFeedback(buildResult({ failedChats: 1 }));

  assert.equal(feedback.kind, 'failed');
  assert.equal(feedback.tone, 'danger');
  assert.equal(feedback.clearDraft, false);
});

test('clears a failed handoff draft after the broadcast was persisted', () => {
  const feedback = buildBroadcastSendFeedback(
    buildResult({ failedChats: 1, scheduleId: 'broadcast-1' }),
  );

  assert.equal(feedback.kind, 'failed');
  assert.equal(feedback.clearDraft, true);
  assert.match(feedback.description ?? '', /сохранена в списке публикаций/u);
});

test('does not preserve an unconfirmed handoff that already has a persisted broadcast', () => {
  const feedback = buildBroadcastSendFeedback(buildResult({ scheduleId: 'broadcast-1' }));

  assert.equal(feedback.kind, 'unconfirmed');
  assert.equal(feedback.clearDraft, true);
  assert.match(feedback.description ?? '', /не запускайте её повторно/u);
});

test('reports a mixed immediate result without inviting a duplicate full resend', () => {
  const feedback = buildBroadcastSendFeedback(
    buildResult({ targetChats: 2, sentChats: 1, failedChats: 1 }),
  );

  assert.equal(feedback.kind, 'partial');
  assert.equal(feedback.tone, 'info');
  assert.equal(feedback.clearDraft, true);
});

test('distinguishes a delivered first cycle from a completed one-off send', () => {
  const feedback = buildBroadcastSendFeedback(
    buildResult({ sentChats: 1, nextSendAt: '2026-07-13T09:00:00.000Z' }),
  );

  assert.equal(feedback.kind, 'started');
  assert.equal(feedback.title, 'Публикация запущена');
});
