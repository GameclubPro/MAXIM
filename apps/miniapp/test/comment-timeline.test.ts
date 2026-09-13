import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCommentDay, isSameCommentDay } from '../src/lib/comment-timeline';

const localDate = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).toISOString();

test('comment groups do not cross a local midnight or year boundary', () => {
  assert.equal(isSameCommentDay(localDate(2026, 9, 13), localDate(2026, 9, 13, 23)), true);
  assert.equal(isSameCommentDay(localDate(2026, 9, 13, 23, 59), localDate(2026, 9, 14, 0)), false);
  assert.equal(isSameCommentDay(localDate(2025, 9, 13), localDate(2026, 9, 13)), false);
  assert.equal(isSameCommentDay('invalid', 'invalid'), false);
});

test('comment date labels use local days including month boundaries', () => {
  const now = new Date(2026, 8, 1, 12);
  assert.equal(formatCommentDay(localDate(2026, 9, 1), now), 'Сегодня');
  assert.equal(formatCommentDay(localDate(2026, 8, 31), now), 'Вчера');
  assert.equal(formatCommentDay(localDate(2026, 8, 30), now), '30 августа');
  assert.match(formatCommentDay(localDate(2025, 8, 30), now), /2025/u);
  assert.equal(formatCommentDay('invalid', now), '');
});
