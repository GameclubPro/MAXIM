import { describe, expect, it } from 'vitest';

import {
  safetyDeskDecisionResponseSchema as rootSafetyDeskDecisionResponseSchema,
  safetyDeskDeleteIntentStatusSchema as rootSafetyDeskDeleteIntentStatusSchema,
  safetyDeskDeleteRuntimeResponseSchema as rootSafetyDeskDeleteRuntimeResponseSchema,
  safetyDeskQueueResponseSchema as rootSafetyDeskQueueResponseSchema,
  safetyDeskReviewStatusSchema as rootSafetyDeskReviewStatusSchema,
  safetyDeskRetryDeleteIntentRequestSchema as rootSafetyDeskRetryDeleteIntentRequestSchema,
  safetyDeskRetentionRuntimeResponseSchema as rootRetentionRuntimeResponseSchema,
  safetyDeskRetentionPreviewResponseSchema as rootRetentionPreviewResponseSchema,
  safetyDeskRetryRetentionRequestSchema as rootRetryRetentionRequestSchema,
} from '@maxim/contracts';
import {
  safetyDeskDecisionRequestSchema,
  safetyDeskDecisionResponseSchema,
  safetyDeskDeleteIntentStatusSchema,
  safetyDeskDeleteRuntimeResponseSchema,
  safetyDeskQueueResponseSchema,
  safetyDeskReviewStatusSchema,
  safetyDeskRetryDeleteIntentRequestSchema,
  safetyDeskDeleteIntentItemSchema,
  safetyDeskRetentionRuntimeResponseSchema,
  safetyDeskRetentionPreviewResponseSchema,
  safetyDeskRetryRetentionRequestSchema,
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
    expect(rootRetentionRuntimeResponseSchema).toBe(safetyDeskRetentionRuntimeResponseSchema);
    expect(rootRetentionPreviewResponseSchema).toBe(safetyDeskRetentionPreviewResponseSchema);
    expect(rootRetryRetentionRequestSchema).toBe(safetyDeskRetryRetentionRequestSchema);
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

  it('denies ordinary retry for older servers that omit action permissions', () => {
    const ownership = safetyDeskDeleteIntentItemSchema.pick({
      retentionOwned: true,
      retryAllowed: true,
    });
    expect(ownership.parse({})).toEqual({ retentionOwned: false, retryAllowed: false });
    expect(ownership.parse({ retentionOwned: true, retryAllowed: true })).toEqual({
      retentionOwned: true,
      retryAllowed: true,
    });
  });

  it('bounds retention pages and diagnostics independently', () => {
    const date = '2026-10-01T10:00:00.000Z';
    const chat = {
      chatId: 'chat-1',
      chatTitle: 'Чат',
      enabled: true,
      hours: 24,
      revision: 2,
      activationId: 'activation-1',
      pendingCount: 4,
      deletedCount: 8,
      skippedCount: 1,
      status: 'running',
      oldestDueAt: date,
      nextRunAt: date,
      hasTerminalReview: true,
      hasUnresolvedReceipt: false,
    };
    const runtime = {
      generatedAt: date,
      mode: 'on',
      nextAfter: null,
      quotas: [{ shard: 0, pendingCount: 4, cap: 100 }],
      items: Array(50).fill(chat),
    };
    expect(safetyDeskRetentionRuntimeResponseSchema.safeParse(runtime).success).toBe(true);
    expect(
      safetyDeskRetentionRuntimeResponseSchema.safeParse({
        ...runtime,
        items: Array(51).fill(chat),
      }).success,
    ).toBe(false);
    expect(
      safetyDeskRetentionRuntimeResponseSchema.safeParse({
        ...runtime,
        quotas: Array(33).fill(runtime.quotas[0]),
      }).success,
    ).toBe(false);
    const candidate = {
      messageId: 'message-1',
      authorId: 'user-1',
      sourceAt: date,
      dueAt: date,
      status: 'terminal_review',
      outcomeCode: 'worker_error',
      intentId: 'intent-1',
      intentStatus: 'FAILED_TERMINAL',
      intentUpdatedAt: date,
      intentAttemptCount: 2,
      reconcileAfter: null,
      retryAllowed: true,
    };
    const preview = {
      chatId: chat.chatId,
      activationId: chat.activationId,
      revision: chat.revision,
      items: Array(20).fill(candidate),
    };
    expect(safetyDeskRetentionPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(
      safetyDeskRetentionPreviewResponseSchema.safeParse({
        ...preview,
        items: Array(21).fill(candidate),
      }).success,
    ).toBe(false);
    const olderCandidate: Partial<typeof candidate> = { ...candidate };
    delete olderCandidate.retryAllowed;
    expect(
      safetyDeskRetentionPreviewResponseSchema.safeParse({ ...preview, items: [olderCandidate] })
        .success,
    ).toBe(false);
  });

  it('requires candidate, activation, policy and intent version for a retention retry', () => {
    const input = {
      messageId: 'message-1',
      activationId: 'activation-1',
      expectedRevision: 2,
      intentId: 'intent-1',
      expectedIntentUpdatedAt: '2026-10-01T10:00:00.000Z',
      expectedAttemptCount: 3,
    };
    expect(safetyDeskRetryRetentionRequestSchema.parse(input)).toEqual(input);
    expect(
      safetyDeskRetryRetentionRequestSchema.safeParse({ ...input, enabled: true }).success,
    ).toBe(false);
    expect(
      safetyDeskRetryRetentionRequestSchema.safeParse({ ...input, expectedRevision: -1 }).success,
    ).toBe(false);
    for (const field of Object.keys(input)) {
      const incomplete = { ...input } as Record<string, unknown>;
      delete incomplete[field];
      expect(safetyDeskRetryRetentionRequestSchema.safeParse(incomplete).success).toBe(false);
    }
  });
});
