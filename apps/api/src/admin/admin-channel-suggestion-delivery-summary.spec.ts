import { buildChannelSuggestionDeliverySummary } from './admin-channel-suggestion-delivery-summary';

describe('buildChannelSuggestionDeliverySummary', () => {
  it('prefers the sanitized ledger snapshot over incomplete legacy evidence', () => {
    expect(
      buildChannelSuggestionDeliverySummary({
        delivered: true,
        deliveredToUserIds: ['admin-delivered'],
        deliveries: [{ adminUserId: 'admin-delivered' }],
        suggestionDelivery: {
          state: 'partially_delivered',
          deliveredCount: 1,
          targetCount: 2,
          pendingCount: 1,
          unreachableCount: 0,
          adminUserIds: ['must-be-stripped'],
          error: 'must-be-stripped',
        },
      }),
    ).toEqual({
      state: 'partially_delivered',
      deliveredCount: 1,
      targetCount: 2,
      pendingCount: 1,
      unreachableCount: 0,
    });
  });

  it('falls back to legacy evidence when a stored snapshot is malformed', () => {
    expect(
      buildChannelSuggestionDeliverySummary({
        delivered: true,
        suggestionDelivery: {
          state: 'delivered',
          deliveredCount: -1,
          targetCount: 0,
          pendingCount: 0,
          unreachableCount: 0,
        },
      }),
    ).toEqual({
      state: 'delivered',
      deliveredCount: 1,
      targetCount: 1,
      pendingCount: 0,
      unreachableCount: 0,
    });
  });

  it('keeps a newly queued suggestion pending without inventing editor targets', () => {
    expect(
      buildChannelSuggestionDeliverySummary({
        delivered: false,
        deliveries: [],
      }),
    ).toEqual({
      state: 'queued',
      deliveredCount: 0,
      targetCount: 0,
      pendingCount: 0,
      unreachableCount: 0,
    });
  });

  it('reports partial delivery without exposing target identities', () => {
    expect(
      buildChannelSuggestionDeliverySummary({
        delivered: true,
        deliveryAttemptedAt: '2026-08-24T12:00:00.000Z',
        deliveries: [
          {
            adminUserId: 'admin-delivered',
            privateChatId: 'private-chat',
            messageId: 'message-1',
          },
        ],
        deliveryFailures: [
          {
            adminUserId: 'admin-unreachable',
            status: 404,
            code: 'dialog.not.found',
            terminal: true,
            recoverable: false,
          },
        ],
      }),
    ).toEqual({
      state: 'partially_delivered',
      deliveredCount: 1,
      targetCount: 2,
      pendingCount: 0,
      unreachableCount: 1,
    });
  });

  it('reports no reachable editor after terminal private-dialog failures', () => {
    expect(
      buildChannelSuggestionDeliverySummary({
        delivered: false,
        deliveryAttemptedAt: '2026-08-24T12:00:00.000Z',
        deliveries: [],
        deliveryFailures: [
          {
            adminUserId: 'admin-1',
            status: 404,
            code: 'dialog.not.found',
            terminal: true,
            recoverable: false,
          },
          {
            adminUserId: 'admin-2',
            status: 403,
            code: 'access.denied',
            terminal: true,
            recoverable: false,
          },
        ],
      }),
    ).toEqual({
      state: 'no_reachable_editor',
      deliveredCount: 0,
      targetCount: 2,
      pendingCount: 0,
      unreachableCount: 2,
    });
  });

  it('keeps route-v2 unavailable codes stable without relying on an HTTP status', () => {
    for (const code of [
      'suggestion.delivery.no_reachable_dialog',
      'suggestion.delivery.dialog_unavailable',
      'suggestion.delivery.editor_removed',
    ]) {
      expect(
        buildChannelSuggestionDeliverySummary({
          delivered: false,
          deliveryAttemptedAt: '2026-08-24T12:00:00.000Z',
          deliveryFailures: [
            {
              adminUserId: 'admin-1',
              status: null,
              code,
              terminal: true,
              recoverable: false,
            },
          ],
        }).state,
      ).toBe('no_reachable_editor');
    }
  });

  it('keeps retryable delivery failures queued and ambiguous outcomes uncertain', () => {
    expect(
      buildChannelSuggestionDeliverySummary({
        deliveryAttemptedAt: '2026-08-24T12:00:00.000Z',
        deliveryFailures: [
          {
            adminUserId: 'admin-1',
            status: 503,
            terminal: false,
            recoverable: true,
          },
        ],
      }).state,
    ).toBe('queued');

    expect(
      buildChannelSuggestionDeliverySummary({
        deliveryAttemptedAt: '2026-08-24T12:00:00.000Z',
        deliveryFailures: [
          {
            adminUserId: 'admin-1',
            status: null,
            terminal: false,
            recoverable: false,
          },
        ],
      }).state,
    ).toBe('uncertain');
  });

  it('does not treat a terminal queue failure as an unreachable editor', () => {
    expect(
      buildChannelSuggestionDeliverySummary({
        deliveryAttemptedAt: '2026-08-24T12:00:00.000Z',
        deliveryFailures: [
          {
            adminUserId: 'delivery_job',
            status: 403,
            terminal: true,
            recoverable: false,
          },
        ],
      }),
    ).toEqual({
      state: 'uncertain',
      deliveredCount: 0,
      targetCount: 0,
      pendingCount: 0,
      unreachableCount: 0,
    });
  });

  it('lets versioned preclaim provenance override a raw 404 in legacy evidence', () => {
    expect(
      buildChannelSuggestionDeliverySummary({
        deliveryAttemptedAt: '2026-08-24T12:00:00.000Z',
        deliveryFailures: [
          {
            adminUserId: 'admin-1',
            status: 404,
            code: 'suggestion.delivery.preclaim_failed',
            terminal: true,
            recoverable: false,
          },
        ],
      }).state,
    ).toBe('uncertain');
  });
});
