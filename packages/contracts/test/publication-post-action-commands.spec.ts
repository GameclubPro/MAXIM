import { describe, expect, it } from 'vitest';
import { publicationPostActionRequestSchema } from '../src/publication-post-action-request.js';

const base = { requestId: 'action-request', expectedVersion: 'a'.repeat(64) };
describe('publication post-action commands', () => {
  it.each(['cancel_delete', 'retry_delete', 'retry_pin'])(
    'accepts %s with an opaque version',
    (action) => {
      expect(publicationPostActionRequestSchema.safeParse({ ...base, action }).success).toBe(true);
    },
  );
  it('requires an explicit deadline and rejects unintended fields', () => {
    expect(
      publicationPostActionRequestSchema.safeParse({ ...base, action: 'reschedule_delete' })
        .success,
    ).toBe(false);
    expect(
      publicationPostActionRequestSchema.safeParse({
        ...base,
        action: 'cancel_delete',
        deleteAt: '2030-01-01T12:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      publicationPostActionRequestSchema.safeParse({
        ...base,
        action: 'reschedule_delete',
        deleteAt: '2030-01-01T12:00:00Z',
      }).success,
    ).toBe(true);
  });
});
