import {
  buildChannelSuggestionDeliverySnapshot,
  mergeChannelSuggestionPrivateDeliveryRoutes,
  resolveChannelSuggestionPrivateDeliveryRoutePlan,
  selectRetryableLogicalDeliveryRows,
} from './admin-channel-suggestion-delivery-route';

describe('channel suggestion private delivery routing', () => {
  it('prefers the selected bot and then active alternate bots for token-free content', () => {
    expect(
      resolveChannelSuggestionPrivateDeliveryRoutePlan({
        suggestion: { text: 'Предложка' },
        preferredBotId: 'assist-bot',
        actionableBotIds: ['assist-bot', 'alternate-bot'],
      }),
    ).toEqual({
      botIds: ['assist-bot', 'alternate-bot'],
      failureBotId: 'assist-bot',
      routeError: null,
    });
  });

  it('pins bot-scoped media to its trusted upload bot instead of the channel assist bot', () => {
    expect(
      resolveChannelSuggestionPrivateDeliveryRoutePlan({
        suggestion: {
          text: '',
          mediaType: 'video',
          mediaPayload: { token: 'video-token' },
          mediaBotId: 'source-private-bot',
        },
        preferredBotId: 'channel-assist-bot',
        actionableBotIds: ['channel-assist-bot', 'source-private-bot'],
      }),
    ).toEqual({
      botIds: ['source-private-bot'],
      failureBotId: 'source-private-bot',
      routeError: null,
    });
  });

  it('keeps media pinned but retries later when its source bot is temporarily not actionable', () => {
    const plan = resolveChannelSuggestionPrivateDeliveryRoutePlan({
      suggestion: {
        text: '',
        images: [{ payload: { token: 'image-token' } }],
        mediaBotId: 'draining-source-bot',
      },
      preferredBotId: 'entry-bot',
      actionableBotIds: ['entry-bot'],
    });

    expect(plan.botIds).toEqual([]);
    expect(plan.failureBotId).toBe('draining-source-bot');
    expect(plan.routeError).toEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          status: 503,
          data: expect.objectContaining({ code: 'suggestion.delivery.no_actionable_bot' }),
        }),
      }),
    );
  });

  it('fails legacy token media closed when upload-bot provenance is missing', () => {
    const plan = resolveChannelSuggestionPrivateDeliveryRoutePlan({
      suggestion: { text: '', mediaType: 'video', mediaPayload: { token: 'legacy-token' } },
      preferredBotId: 'entry-bot',
      actionableBotIds: ['entry-bot', 'alternate-bot'],
    });

    expect(plan.botIds).toEqual([]);
    expect(plan.routeError).toEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          data: expect.objectContaining({ code: 'suggestion.media.provenance.unknown' }),
        }),
      }),
    );
  });

  it('treats an empty actionable fleet as an operational retry instead of editor absence', () => {
    const plan = resolveChannelSuggestionPrivateDeliveryRoutePlan({
      suggestion: { text: 'Предложка' },
      preferredBotId: 'draining-bot',
      actionableBotIds: [],
    });

    expect(plan.botIds).toEqual([]);
    expect(plan.routeError).toEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          status: 503,
          data: expect.objectContaining({ code: 'suggestion.delivery.no_actionable_bot' }),
        }),
      }),
    );
  });

  it('keeps a durable ledger route first and deduplicates discovered routes', () => {
    expect(
      mergeChannelSuggestionPrivateDeliveryRoutes({
        ledgerRoute: { botId: 'alternate-bot', privateChatId: 'private-2' },
        discoveredRoutes: [
          { botId: 'assist-bot', privateChatId: 'private-1' },
          { botId: 'alternate-bot', privateChatId: 'private-2' },
          { botId: 'disabled-bot', privateChatId: 'private-3' },
        ],
        allowedBotIds: ['assist-bot', 'alternate-bot'],
      }),
    ).toEqual([
      { botId: 'alternate-bot', privateChatId: 'private-2' },
      { botId: 'assist-bot', privateChatId: 'private-1' },
    ]);
  });

  it.each(['PENDING', 'SENDING'])('counts SENT plus %s as partial across two editors', (status) => {
    expect(
      buildChannelSuggestionDeliverySnapshot([
        {
          adminUserId: 'admin-1',
          status: 'SENT',
          terminal: false,
          lastStatusCode: null,
          lastErrorCode: null,
          retryable: false,
        },
        {
          adminUserId: 'admin-2',
          status,
          terminal: false,
          lastStatusCode: null,
          lastErrorCode: null,
          retryable: true,
        },
      ]),
    ).toEqual({
      state: 'partially_delivered',
      deliveredCount: 1,
      targetCount: 2,
      pendingCount: 1,
      unreachableCount: 0,
    });
  });

  it('deduplicates multiple bot-key rows for one editor using SENT precedence', () => {
    expect(
      buildChannelSuggestionDeliverySnapshot([
        {
          adminUserId: 'admin-1',
          status: 'PENDING',
          terminal: false,
          lastStatusCode: null,
          lastErrorCode: null,
          retryable: true,
        },
        {
          adminUserId: 'admin-1',
          status: 'SENT',
          terminal: false,
          lastStatusCode: null,
          lastErrorCode: null,
          retryable: false,
        },
      ]),
    ).toEqual({
      state: 'delivered',
      deliveredCount: 1,
      targetCount: 1,
      pendingCount: 0,
      unreachableCount: 0,
    });
  });

  it('treats lock-loss as uncertain instead of an unavailable editor', () => {
    expect(
      buildChannelSuggestionDeliverySnapshot([
        {
          adminUserId: 'admin-1',
          status: 'FAILED',
          terminal: true,
          lastStatusCode: 409,
          lastErrorCode: 'suggestion.delivery.lock_lost',
          retryable: false,
        },
      ]).state,
    ).toBe('uncertain');
  });

  it('lets versioned preclaim provenance override a raw 404 in the ledger snapshot', () => {
    expect(
      buildChannelSuggestionDeliverySnapshot([
        {
          adminUserId: 'admin-1',
          status: 'FAILED',
          terminal: true,
          lastStatusCode: 404,
          lastErrorCode: 'suggestion.delivery.preclaim_failed',
          retryable: false,
        },
      ]).state,
    ).toBe('uncertain');
  });

  it('treats a removed editor as unavailable without reopening private-dialog recovery', () => {
    expect(
      buildChannelSuggestionDeliverySnapshot([
        {
          adminUserId: 'admin-1',
          status: 'FAILED',
          terminal: true,
          lastStatusCode: null,
          lastErrorCode: 'suggestion.delivery.editor_removed',
          retryable: false,
        },
      ]),
    ).toEqual({
      state: 'no_reachable_editor',
      deliveredCount: 0,
      targetCount: 1,
      pendingCount: 0,
      unreachableCount: 1,
    });
  });

  it('selects at most one retryable row per editor and blocks SENT siblings', () => {
    const rows = [
      { id: 'failed-sibling', adminUserId: 'admin-1', status: 'FAILED' },
      { id: 'sent-sibling', adminUserId: 'admin-1', status: 'SENT' },
      { id: 'pending-preferred', adminUserId: 'admin-2', status: 'PENDING' },
      { id: 'failed-alternate', adminUserId: 'admin-2', status: 'FAILED' },
    ];
    expect(
      selectRetryableLogicalDeliveryRows(
        rows,
        (row) => row.status === 'PENDING' || row.status === 'FAILED',
      ).map((row) => row.id),
    ).toEqual(['pending-preferred']);
  });
});
