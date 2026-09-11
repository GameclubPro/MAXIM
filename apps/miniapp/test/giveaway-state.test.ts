import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isGiveawayEntryOpen,
  resolveGiveawayDisplayPhase,
  resolveNextGiveawayBoundaryMs,
  shouldPollGiveawayFinalization,
  buildGiveawayConditions,
  canClaimGiveaway,
  formatGiveawayCountdown,
} from '../src/lib/giveaway-state';
import type {
  ManagedGiveawayPublic,
  ManagedGiveawayParticipantState,
} from '@maxim/contracts/giveaway';

const nowMs = new Date('2026-05-01T10:00:00.000Z').getTime();

const giveaway = {
  sourceChatId: 'source',
  sourceTitle: 'Источник',
  sourceLink: null,
  requiredChannels: [
    { id: 'extra', title: 'Канал', link: 'https://max.ru/extra' },
    { id: 'source', title: 'Источник', link: null },
  ],
} as ManagedGiveawayPublic;

test('unverified and pending subscriptions never contribute to progress', () => {
  for (const participant of [null, { eligibilityState: null }, { eligibilityState: 'PENDING' }]) {
    const conditions = buildGiveawayConditions(
      giveaway,
      participant as ManagedGiveawayParticipantState | null,
    );
    assert.deepEqual(
      conditions.map((item) => item.state),
      ['unknown', 'unknown'],
    );
  }
});

test('conditions deduplicate the source and preserve exact missing identities', () => {
  const participant = {
    eligibilityState: 'REJECTED',
    missingChannelIds: ['extra'],
  } as ManagedGiveawayParticipantState;
  assert.deepEqual(
    buildGiveawayConditions(giveaway, participant).map((item) => [item.id, item.state]),
    [
      ['source', 'verified'],
      ['extra', 'missing'],
    ],
  );
  assert.deepEqual(
    buildGiveawayConditions(giveaway, participant, true).map((item) => item.state),
    ['checking', 'checking'],
  );
  assert.deepEqual(
    buildGiveawayConditions(giveaway, { ...participant, missingChannelIds: [] }).map(
      (item) => item.state,
    ),
    ['unknown', 'unknown'],
  );
});

test('claim closes exactly at the deadline even while the response is cached', () => {
  const participant = {
    canClaim: true,
    winnerStatus: 'SELECTED',
    claimDeadlineAt: new Date(nowMs).toISOString(),
  } as ManagedGiveawayParticipantState;
  assert.equal(canClaimGiveaway(participant, nowMs - 1), true);
  assert.equal(canClaimGiveaway(participant, nowMs), false);
  assert.equal(canClaimGiveaway({ ...participant, claimDeadlineAt: null }, nowMs), true);
  assert.equal(canClaimGiveaway({ ...participant, winnerStatus: 'REROLLED' }, nowMs - 1), false);
  assert.equal(canClaimGiveaway({ ...participant, claimDeadlineAt: 'invalid' }, nowMs - 1), false);
});

test('countdown is clamped, rounded up and keeps the full day count', () => {
  assert.equal(formatGiveawayCountdown(nowMs - 1, nowMs), '00:00:00');
  assert.equal(formatGiveawayCountdown(nowMs + 1, nowMs), '00:00:01');
  assert.equal(formatGiveawayCountdown(nowMs + 90_061_000, nowMs), '1 д 01:01:01');
});

test('invalid finish time never admits entry', () => {
  assert.equal(
    isGiveawayEntryOpen({ status: 'ACTIVE', startsAt: null, endsAt: 'invalid' }, nowMs),
    false,
  );
});

test('resolveGiveawayDisplayPhase treats an ended active giveaway as drawing', () => {
  assert.equal(
    resolveGiveawayDisplayPhase(
      {
        status: 'ACTIVE',
        startsAt: null,
        endsAt: '2026-05-01T09:59:59.000Z',
      },
      nowMs,
    ),
    'DRAWING',
  );
});

test('isGiveawayEntryOpen closes entry exactly at the finish boundary', () => {
  assert.equal(
    isGiveawayEntryOpen(
      {
        status: 'ACTIVE',
        startsAt: null,
        endsAt: '2026-05-01T10:00:00.000Z',
      },
      nowMs,
    ),
    false,
  );
});

test('resolveGiveawayDisplayPhase promotes due scheduled giveaways to active before finish', () => {
  assert.equal(
    resolveGiveawayDisplayPhase(
      {
        status: 'SCHEDULED',
        startsAt: '2026-05-01T09:30:00.000Z',
        endsAt: '2026-05-01T10:30:00.000Z',
      },
      nowMs,
    ),
    'ACTIVE',
  );
});

test('shouldPollGiveawayFinalization polls active giveaways after finish', () => {
  assert.equal(
    shouldPollGiveawayFinalization(
      {
        status: 'ACTIVE',
        startsAt: null,
        endsAt: '2026-05-01T09:59:59.000Z',
      },
      nowMs,
    ),
    true,
  );
});

test('resolveNextGiveawayBoundaryMs schedules the active finish boundary', () => {
  assert.equal(
    resolveNextGiveawayBoundaryMs(
      {
        status: 'ACTIVE',
        startsAt: null,
        endsAt: '2026-05-01T10:05:00.000Z',
      },
      nowMs,
    ),
    new Date('2026-05-01T10:05:00.000Z').getTime(),
  );
});
