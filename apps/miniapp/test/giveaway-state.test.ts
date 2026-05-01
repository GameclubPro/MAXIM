import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isGiveawayEntryOpen,
  resolveGiveawayDisplayPhase,
  resolveNextGiveawayBoundaryMs,
  shouldPollGiveawayFinalization,
} from '../src/lib/giveaway-state';

const nowMs = new Date('2026-05-01T10:00:00.000Z').getTime();

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
