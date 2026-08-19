import { describe, expect, it } from 'vitest';

import {
  createManagedPollRequestSchema,
  decodeManagedPollListCursor,
  encodeManagedPollListCursor,
  MAX_MANAGED_POLL_LIST_CURSOR_LENGTH,
  managedPollListQuerySchema,
  managedPollListResponseSchema,
  MANAGED_POLL_MESSAGE_MAX_LENGTH,
  MANAGED_POLL_QUESTION_MAX_LENGTH,
  updateManagedPollRequestSchema,
} from '@maxim/contracts/poll';

const options = [{ text: 'Да' }, { text: 'Нет' }];

describe('managed poll contracts', () => {
  it('accepts a 2000-character question and rejects a longer one', () => {
    expect(MANAGED_POLL_QUESTION_MAX_LENGTH).toBe(2_000);
    expect(MANAGED_POLL_MESSAGE_MAX_LENGTH).toBe(4_000);
    expect(
      createManagedPollRequestSchema.safeParse({
        question: 'A'.repeat(MANAGED_POLL_QUESTION_MAX_LENGTH),
        options,
      }).success,
    ).toBe(true);
    expect(
      createManagedPollRequestSchema.safeParse({
        question: 'A'.repeat(MANAGED_POLL_QUESTION_MAX_LENGTH + 1),
        options,
      }).success,
    ).toBe(false);
  });

  it('defaults visibility only when creating a poll', () => {
    const request = {
      question: 'Какой вариант?',
      options,
      expectedUpdatedAt: '2026-08-19T10:00:00.000Z',
    };

    expect(createManagedPollRequestSchema.parse(request).visibility).toBe('ANONYMOUS');
    expect(updateManagedPollRequestSchema.parse(request).visibility).toBeUndefined();
  });

  it('requires a valid draft revision token only on updates', () => {
    const expectedUpdatedAt = '2026-08-19T10:00:00.000Z';
    const request = {
      question: 'Какой вариант?',
      options,
      expectedUpdatedAt,
    };

    expect(updateManagedPollRequestSchema.parse(request).expectedUpdatedAt).toBe(expectedUpdatedAt);
    expect(
      updateManagedPollRequestSchema.safeParse({
        ...request,
        expectedUpdatedAt: 'not-a-date',
      }).success,
    ).toBe(false);
    expect(
      updateManagedPollRequestSchema.safeParse({
        question: request.question,
        options: request.options,
      }).success,
    ).toBe(false);
    expect(createManagedPollRequestSchema.parse(request)).not.toHaveProperty('expectedUpdatedAt');
  });

  it('supports scoped history queries and exact totals', () => {
    expect(managedPollListQuerySchema.parse({ scope: 'current' }).scope).toBe('current');
    expect(managedPollListQuerySchema.safeParse({ scope: 'unknown' }).success).toBe(false);
    expect(
      managedPollListResponseSchema.parse({ items: [], nextCursor: null, total: 12 }).total,
    ).toBe(12);
  });

  it('round-trips a route-bound poll list cursor', () => {
    const payload = {
      v: 1,
      createdAt: '2026-08-19T09:30:00.000Z',
      id: 'poll-42',
      chatId: 'channel-7',
      scope: 'archive',
    } as const;
    const cursor = encodeManagedPollListCursor(payload);

    expect(decodeManagedPollListCursor(cursor)).toEqual(payload);
    expect(managedPollListQuerySchema.parse({ cursor }).cursor).toBe(cursor);
  });

  it('keeps every valid ASCII poll cursor consumable and rejects unsafe values', () => {
    const maxAsciiPayload = {
      v: 1,
      createdAt: '2026-08-19T09:30:00.123456+03:00',
      id: 'p'.repeat(128),
      chatId: 'c'.repeat(256),
      scope: 'current',
    } as const;
    const longestCursor = encodeManagedPollListCursor(maxAsciiPayload);
    const encodeUncheckedCursor = (payload: unknown) =>
      globalThis
        .btoa(JSON.stringify(payload))
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/=+$/u, '');
    const invalidVersion = encodeUncheckedCursor({
      ...maxAsciiPayload,
      v: 2,
    });
    const nulCursor = encodeUncheckedCursor({
      ...maxAsciiPayload,
      id: 'poll\u0000unsafe',
    });
    const controlCursor = encodeUncheckedCursor({
      ...maxAsciiPayload,
      chatId: 'channel\u0001unsafe',
    });
    const oversizedCursor = 'a'.repeat(MAX_MANAGED_POLL_LIST_CURSOR_LENGTH + 1);

    expect(MAX_MANAGED_POLL_LIST_CURSOR_LENGTH).toBe(1_024);
    expect(longestCursor.length).toBeLessThanOrEqual(MAX_MANAGED_POLL_LIST_CURSOR_LENGTH);
    expect(managedPollListQuerySchema.safeParse({ cursor: longestCursor }).success).toBe(true);
    expect(decodeManagedPollListCursor(longestCursor)).toEqual(maxAsciiPayload);
    expect(decodeManagedPollListCursor(invalidVersion)).toBeNull();
    expect(decodeManagedPollListCursor(nulCursor)).toBeNull();
    expect(decodeManagedPollListCursor(controlCursor)).toBeNull();
    expect(decodeManagedPollListCursor('not+base64')).toBeNull();
    expect(decodeManagedPollListCursor(oversizedCursor)).toBeNull();
    expect(managedPollListQuerySchema.safeParse({ cursor: oversizedCursor }).success).toBe(false);
  });
});
