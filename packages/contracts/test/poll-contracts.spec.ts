import { describe, expect, it } from 'vitest';

import {
  createManagedPollRequestSchema,
  MANAGED_POLL_QUESTION_MAX_LENGTH,
} from '@maxim/contracts/poll';

const options = [{ text: 'Да' }, { text: 'Нет' }];

describe('managed poll contracts', () => {
  it('accepts a 400-character question and rejects a longer one', () => {
    expect(MANAGED_POLL_QUESTION_MAX_LENGTH).toBe(400);
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
});
