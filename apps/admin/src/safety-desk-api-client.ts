import {
  safetyDeskDecisionResponseSchema,
  safetyDeskDeleteRuntimeResponseSchema,
  safetyDeskQueueResponseSchema,
  type SafetyDeskDecisionResponse,
  type SafetyDeskDeleteIntentItem,
  type SafetyDeskDeleteRuntimeResponse,
  type SafetyDeskQueueResponse,
} from '@maxim/contracts/safety-desk';
import { createAdminApiTransport, type AdminApiTransport } from './admin-request';

const SAFETY_DESK_API_BASE = '/api/v1/safety-desk';

export type SafetyDeskDecisionAction = 'approve' | 'reject' | 'recheck';

export class SafetyDeskApiClient {
  constructor(private readonly transport: AdminApiTransport = createAdminApiTransport()) {}

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
