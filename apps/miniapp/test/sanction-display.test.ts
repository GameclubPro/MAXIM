import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatSanctionRemaining,
  sanctionTimeProgress,
  createSanctionClock,
  readSanctionClock,
} from '../src/lib/sanction-display';
import { describeParticipantActivity } from '../src/lib/participant-activity';

const now = Date.parse('2026-09-12T12:00:00Z');
test('sanction clock tolerates wrong device dates and then uses monotonic elapsed time', () => {
  const wrongWall = now + 20 * 86400_000;
  const clock = createSanctionClock(new Date(now).toISOString(), wrongWall, wrongWall, 100);
  assert.equal(readSanctionClock(clock, 1100), now + 1000);
  assert.equal(readSanctionClock(clock, 50), now);
});
test('sanction timer displays days, stable seconds, expiry and permanent state', () => {
  const item = {
    status: 'active' as const,
    permanent: false,
    expiresAt: new Date(now + 2 * 86400_000 + 4 * 3600_000).toISOString(),
  };
  assert.equal(formatSanctionRemaining(item, now), '2 д 04 ч');
  assert.equal(
    formatSanctionRemaining({ ...item, expiresAt: new Date(now + 3661_000).toISOString() }, now),
    '01:01:01',
  );
  assert.equal(
    formatSanctionRemaining({ ...item, expiresAt: new Date(now).toISOString() }, now),
    'Срок истёк',
  );
  assert.equal(
    formatSanctionRemaining({ ...item, permanent: true, expiresAt: null }, now),
    'Бессрочно',
  );
  assert.equal(sanctionTimeProgress({ ...item, createdAt: new Date(now).toISOString() }, now), 1);
  assert.equal(sanctionTimeProgress({ ...item, createdAt: item.expiresAt }, now), null);
});
test('activity does not turn private or stale data into inactivity', () => {
  assert.equal(
    describeParticipantActivity(
      { lastMaxActivityAt: null, activityCheckedAt: new Date(now).toISOString() },
      now,
    ).label,
    'Нет данных',
  );
  assert.equal(
    describeParticipantActivity(
      {
        lastMaxActivityAt: new Date(now - 40 * 86400_000).toISOString(),
        activityCheckedAt: new Date(now - 2 * 86400_000).toISOString(),
      },
      now,
    ).label,
    'Данные устарели',
  );
  for (const days of [7, 14, 30, 60, 90]) {
    assert.equal(
      describeParticipantActivity(
        {
          lastMaxActivityAt: new Date(now - days * 86400_000).toISOString(),
          activityCheckedAt: new Date(now).toISOString(),
        },
        now,
      ).label,
      `${days}+ дней`,
    );
  }
});
