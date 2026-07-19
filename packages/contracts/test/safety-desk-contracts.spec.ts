import { describe, expect, it } from 'vitest';

import {
  safetyDeskDecisionResponseSchema as rootSafetyDeskDecisionResponseSchema,
  safetyDeskDeleteIntentStatusSchema as rootSafetyDeskDeleteIntentStatusSchema,
  safetyDeskDeleteRuntimeResponseSchema as rootSafetyDeskDeleteRuntimeResponseSchema,
  safetyDeskQueueResponseSchema as rootSafetyDeskQueueResponseSchema,
  safetyDeskReviewStatusSchema as rootSafetyDeskReviewStatusSchema,
  safetyDeskRetryDeleteIntentRequestSchema as rootSafetyDeskRetryDeleteIntentRequestSchema,
} from '@maxim/contracts';
import {
  safetyDeskDecisionRequestSchema,
  safetyDeskDecisionResponseSchema,
  safetyDeskDeleteIntentStatusSchema,
  safetyDeskDeleteRuntimeResponseSchema,
  safetyDeskQueueResponseSchema,
  safetyDeskReviewStatusSchema,
  safetyDeskRetryDeleteIntentRequestSchema,
} from '@maxim/contracts/safety-desk';

describe('Safety Desk contract exports', () => {
  it('keeps root and subpath schema identity aligned', () => {
    expect(rootSafetyDeskReviewStatusSchema).toBe(safetyDeskReviewStatusSchema);
    expect(rootSafetyDeskQueueResponseSchema).toBe(safetyDeskQueueResponseSchema);
    expect(rootSafetyDeskDecisionResponseSchema).toBe(safetyDeskDecisionResponseSchema);
    expect(rootSafetyDeskDeleteIntentStatusSchema).toBe(safetyDeskDeleteIntentStatusSchema);
    expect(rootSafetyDeskDeleteRuntimeResponseSchema).toBe(safetyDeskDeleteRuntimeResponseSchema);
    expect(rootSafetyDeskRetryDeleteIntentRequestSchema).toBe(
      safetyDeskRetryDeleteIntentRequestSchema,
    );
  });

  it('applies queue defaults and normalizes review reasons', () => {
    expect(
      safetyDeskQueueResponseSchema.parse({
        generatedAt: '2026-07-19T10:00:00.000Z',
        summary: {},
      }),
    ).toEqual({
      generatedAt: '2026-07-19T10:00:00.000Z',
      items: [],
      summary: {
        review: 0,
        approved: 0,
        rejected: 0,
        blocked: 0,
        servicePosts: 0,
      },
      audit: [],
    });
    expect(safetyDeskDecisionRequestSchema.parse({ reason: '  Проверено владельцем  ' })).toEqual({
      reason: 'Проверено владельцем',
    });
  });

  it('keeps delete retry input strict and optimistic', () => {
    const input = {
      expectedStatus: 'FAILED_TERMINAL' as const,
      expectedUpdatedAt: '2026-07-19T10:00:00.000Z',
      expectedAttemptCount: 3,
    };

    expect(safetyDeskRetryDeleteIntentRequestSchema.parse(input)).toEqual(input);
    expect(
      safetyDeskRetryDeleteIntentRequestSchema.safeParse({ ...input, unexpected: true }).success,
    ).toBe(false);
  });
});
