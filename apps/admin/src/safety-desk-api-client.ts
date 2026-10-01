import {
  safetyDeskDecisionResponseSchema,
  safetyDeskDeleteRuntimeResponseSchema,
  safetyDeskQueueResponseSchema,
  safetyDeskRetentionRuntimeResponseSchema,
  safetyDeskRetentionPreviewResponseSchema,
  safetyDeskRetryRetentionRequestSchema,
  type SafetyDeskDecisionResponse,
  type SafetyDeskDeleteIntentItem,
  type SafetyDeskDeleteRuntimeResponse,
  type SafetyDeskQueueResponse,
  commercialReviewQueueResponseSchema,
  commercialReviewItemSchema,
  type CommercialReviewQueueResponse,
  type CommercialReviewItem,
  type CommercialReviewLabel,
  type SafetyDeskRetentionRuntimeResponse,
  type SafetyDeskRetentionPreviewResponse,
  type SafetyDeskRetryRetentionRequest,
} from '@maxim/contracts/safety-desk';
import { createAdminApiTransport, type AdminApiTransport } from './admin-request';

const SAFETY_DESK_API_BASE = '/api/v1/safety-desk';

export type SafetyDeskDecisionAction = 'approve' | 'reject' | 'recheck';

export class SafetyDeskApiClient {
  constructor(private readonly transport: AdminApiTransport = createAdminApiTransport()) {}

  fetchCommercialReview(
    accessCode: string,
    cursor?: string,
    status: 'PENDING' | 'REVIEWED' | 'ALL' = 'PENDING',
  ): Promise<CommercialReviewQueueResponse> {
    const query = new URLSearchParams({ limit: '50', status, ...(cursor ? { cursor } : {}) });
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/commercial/review?${query}`,
      accessCode,
      commercialReviewQueueResponseSchema,
    );
  }

  labelCommercialReview(
    item: CommercialReviewItem,
    label: CommercialReviewLabel,
    reason: string,
    accessCode: string,
  ): Promise<CommercialReviewItem> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/commercial/review/${encodeURIComponent(item.id)}/label`,
      accessCode,
      commercialReviewItemSchema,
      {
        method: 'POST',
        body: { expectedUpdatedAt: item.updatedAt, label, reason },
      },
    );
  }

  fetchQueue(accessCode: string): Promise<SafetyDeskQueueResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/queue`,
      accessCode,
      safetyDeskQueueResponseSchema,
    );
  }

  fetchDeleteRuntime(accessCode: string): Promise<SafetyDeskDeleteRuntimeResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/deletes`,
      accessCode,
      safetyDeskDeleteRuntimeResponseSchema,
    );
  }

  fetchRetentionRuntime(
    accessCode: string,
    after: string | null = null,
  ): Promise<SafetyDeskRetentionRuntimeResponse> {
    const cursor = after ? `?after=${encodeURIComponent(after)}` : '';
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/retention${cursor}`,
      accessCode,
      safetyDeskRetentionRuntimeResponseSchema,
    );
  }

  fetchRetentionPreview(
    chatId: string,
    accessCode: string,
  ): Promise<SafetyDeskRetentionPreviewResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/retention/${encodeURIComponent(chatId)}/preview`,
      accessCode,
      safetyDeskRetentionPreviewResponseSchema,
    );
  }

  retryRetention(
    chatId: string,
    request: SafetyDeskRetryRetentionRequest,
    accessCode: string,
  ): Promise<SafetyDeskRetentionPreviewResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/retention/${encodeURIComponent(chatId)}/retry`,
      accessCode,
      safetyDeskRetentionPreviewResponseSchema,
      { method: 'POST', body: safetyDeskRetryRetentionRequestSchema.parse(request) },
    );
  }

  allowAmbiguousSendRetry(
    item: SafetyDeskDeleteRuntimeResponse['ambiguousSends'][number],
    accessCode: string,
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/ambiguous-sends/${encodeURIComponent(item.id)}/allow-retry`,
      accessCode,
      safetyDeskDeleteRuntimeResponseSchema,
      {
        method: 'POST',
        body: {
          expectedOperationId: item.messageId,
          expectedStartedAt: item.startedAt,
        },
      },
    );
  }

  retryDeleteIntent(
    item: Pick<SafetyDeskDeleteIntentItem, 'id' | 'status' | 'updatedAt' | 'attemptCount'> & {
      status: 'EXPIRED' | 'FAILED_TERMINAL';
    },
    accessCode: string,
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/runtime/deletes/${encodeURIComponent(item.id)}/retry`,
      accessCode,
      safetyDeskDeleteRuntimeResponseSchema,
      {
        method: 'POST',
        body: {
          expectedStatus: item.status,
          expectedUpdatedAt: item.updatedAt,
          expectedAttemptCount: item.attemptCount,
        },
      },
    );
  }

  decide(
    itemId: string,
    action: SafetyDeskDecisionAction,
    accessCode: string,
  ): Promise<SafetyDeskDecisionResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/items/${encodeURIComponent(itemId)}/${action}`,
      accessCode,
      safetyDeskDecisionResponseSchema,
      { method: 'POST', body: {} },
    );
  }

  approveAll(itemIds: string[], accessCode: string): Promise<SafetyDeskDecisionResponse> {
    return this.transport.request(
      `${SAFETY_DESK_API_BASE}/queue/approve-all`,
      accessCode,
      safetyDeskDecisionResponseSchema,
      { method: 'POST', body: { itemIds } },
    );
  }
}

export const safetyDeskApiClient = new SafetyDeskApiClient();
