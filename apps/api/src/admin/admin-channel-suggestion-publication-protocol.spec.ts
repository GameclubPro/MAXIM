import {
  buildChannelSuggestionPublicationLedgerJobId,
  CHANNEL_SUGGESTION_PUBLICATION_CLAIM_STALE_MS,
  CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
  CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
  classifyChannelSuggestionPublicationLedgerAudit,
  classifyChannelSuggestionPublicationRecovery as classifyChannelSuggestionPublicationRecoveryValue,
  readChannelSuggestionPublicationClaimV1,
  readChannelSuggestionPublicationContextV1,
  withChannelSuggestionPublicationContextDigest,
  type ChannelSuggestionPublicationLedgerRow,
} from './admin-channel-suggestion-publication-protocol';

const suggestionId = 'suggestion-protocol-1';
const chatId = 'channel-1';
const ledgerJobId = buildChannelSuggestionPublicationLedgerJobId(suggestionId);
const claimedAt = '2026-08-20T10:00:00.000Z';
const actorUserId = 'user-1';

function classifyChannelSuggestionPublicationRecovery(
  params: Omit<
    Parameters<typeof classifyChannelSuggestionPublicationRecoveryValue>[0],
    'actorUserId'
  >,
) {
  return classifyChannelSuggestionPublicationRecoveryValue({ ...params, actorUserId });
}

function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'suggest',
    reviewStatus: 'publishing',
    reviewAction: 'publish',
    reviewPublicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
    reviewPublicationLedgerJobId: ledgerJobId,
    reviewClaimToken: 'claim-token-1',
    reviewClaimedAt: claimedAt,
    reviewClaimedByUserId: 'admin-1',
    reviewClaimedByDisplayName: 'Главный редактор',
    ...overrides,
  };
}

function createContext() {
  return withChannelSuggestionPublicationContextDigest({
    protocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
    preparedAt: '2026-08-20T10:01:00.000Z',
    messageDigest: 'a'.repeat(64),
    botId: 'bot-1',
    threadId: '11111111-1111-4111-8111-111111111111',
    buttons: [[{ type: 'link', text: 'Комментарии', url: 'https://max.ru/app' }]],
    includeCommentsButton: true,
    includeSuggestButton: false,
    suggestButtonText: null,
    suggestionEntryMode: 'BOT',
    authorAttribution: {
      userId: actorUserId,
      displayName: 'Автор',
      mentionDisplayName: 'Автор',
      username: null,
      profileUrl: null,
    },
  });
}

function createLedger(
  overrides: Partial<ChannelSuggestionPublicationLedgerRow> = {},
): ChannelSuggestionPublicationLedgerRow {
  const context = createContext();
  return {
    jobId: ledgerJobId,
    actionType: 'SEND_MESSAGE',
    chatId,
    sourceTag: CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
    status: 'IN_PROGRESS',
    ambiguous: false,
    terminal: false,
    dispatchToken: null,
    dispatchStartedAt: null,
    dispatchBotId: null,
    remoteMessageId: null,
    metadata: {
      ledgerContext: {
        suggestionId,
        publicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
        claimToken: 'claim-token-1',
        actorUserId,
        messageDigest: context.messageDigest,
        contextDigest: context.contextDigest,
      },
    },
    ...overrides,
  };
}

describe('channel suggestion publication protocol', () => {
  it('uses a deterministic versioned ledger key and parses the exact claim', () => {
    expect(ledgerJobId).toBe('channel-suggestion:publish:v1:suggestion-protocol-1');
    expect(readChannelSuggestionPublicationClaimV1(createPayload(), suggestionId)).toEqual({
      protocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
      ledgerJobId,
      claimToken: 'claim-token-1',
      claimedAt,
      claimedByUserId: 'admin-1',
      claimedByDisplayName: 'Главный редактор',
    });
  });

  it('quarantines every legacy publishing claim even when it is old and unfenced', () => {
    expect(
      classifyChannelSuggestionPublicationRecovery({
        payload: {
          type: 'suggest',
          reviewStatus: 'publishing',
          reviewAction: 'publish',
          reviewClaimedAt: claimedAt,
          reviewClaimedByUserId: 'admin-1',
        },
        suggestionId,
        chatId,
        ledger: null,
        nowMs: new Date(claimedAt).getTime() + 24 * 60 * 60_000,
      }),
    ).toEqual({ kind: 'manual', reason: 'legacy' });
  });

  it('waits for a fresh versioned claim with no dispatch evidence', () => {
    expect(
      classifyChannelSuggestionPublicationRecovery({
        payload: createPayload(),
        suggestionId,
        chatId,
        ledger: createLedger(),
        nowMs: new Date(claimedAt).getTime() + CHANNEL_SUGGESTION_PUBLICATION_CLAIM_STALE_MS - 1,
      }).kind,
    ).toBe('waiting');
  });

  it('releases only a stale versioned claim with no fence or ambiguity', () => {
    expect(
      classifyChannelSuggestionPublicationRecovery({
        payload: createPayload(),
        suggestionId,
        chatId,
        ledger: createLedger({ status: 'FAILED_TERMINAL', terminal: true }),
        nowMs: new Date(claimedAt).getTime() + CHANNEL_SUGGESTION_PUBLICATION_CLAIM_STALE_MS,
      }).kind,
    ).toBe('release_pre_dispatch');
  });

  it.each([
    { dispatchToken: 'dispatch-token-1' },
    { dispatchStartedAt: new Date('2026-08-20T10:02:00.000Z') },
    { dispatchBotId: 'bot-1' },
    { ambiguous: true, status: 'AMBIGUOUS', terminal: true },
  ])('keeps retained dispatch evidence manual-only: %o', (ledgerOverrides) => {
    expect(
      classifyChannelSuggestionPublicationRecovery({
        payload: createPayload({ reviewPublicationContext: createContext() }),
        suggestionId,
        chatId,
        ledger: createLedger(ledgerOverrides),
        nowMs: new Date(claimedAt).getTime() + 24 * 60 * 60_000,
      }),
    ).toEqual({ kind: 'manual', reason: 'dispatch_ambiguous' });
  });

  it('treats a prepared context without its ledger as manual-only', () => {
    expect(
      classifyChannelSuggestionPublicationRecovery({
        payload: createPayload({ reviewPublicationContext: createContext() }),
        suggestionId,
        chatId,
        ledger: null,
        nowMs: new Date(claimedAt).getTime() + 24 * 60 * 60_000,
      }),
    ).toEqual({ kind: 'manual', reason: 'context_without_ledger' });
  });

  it('recovers a completed exact ledger without another dispatch', () => {
    const context = createContext();
    const decision = classifyChannelSuggestionPublicationRecovery({
      payload: createPayload({ reviewPublicationContext: context }),
      suggestionId,
      chatId,
      ledger: createLedger({
        status: 'SUCCEEDED',
        terminal: true,
        dispatchToken: 'dispatch-token-1',
        dispatchStartedAt: new Date('2026-08-20T10:02:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: 'mid-1',
      }),
    });

    expect(decision).toEqual(
      expect.objectContaining({
        kind: 'completed',
        context: expect.objectContaining({
          botId: 'bot-1',
          messageDigest: 'a'.repeat(64),
          buttons: context.buttons,
        }),
        ledger: expect.objectContaining({ remoteMessageId: 'mid-1' }),
      }),
    );
  });

  it('rejects a completed ledger whose persisted context names another bot', () => {
    expect(
      classifyChannelSuggestionPublicationRecovery({
        payload: createPayload({
          reviewPublicationContext: { ...createContext(), botId: 'bot-2' },
        }),
        suggestionId,
        chatId,
        ledger: createLedger({ dispatchBotId: 'bot-1', remoteMessageId: 'mid-1' }),
      }),
    ).toEqual({ kind: 'manual', reason: 'context_missing' });
  });

  it('requires the exact source, action, chat, and deterministic key', () => {
    expect(
      classifyChannelSuggestionPublicationRecovery({
        payload: createPayload(),
        suggestionId,
        chatId,
        ledger: createLedger({ sourceTag: 'interactive' }),
      }),
    ).toEqual({ kind: 'manual', reason: 'ledger_mismatch' });
  });

  it('round-trips a CTA-only keyboard without requiring a dialog thread', () => {
    const context = withChannelSuggestionPublicationContextDigest({
      protocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
      preparedAt: '2026-08-20T10:01:00.000Z',
      messageDigest: 'b'.repeat(64),
      botId: 'bot-1',
      threadId: null,
      buttons: [
        [{ type: 'link', text: '📞 Заказать рекламу', url: 'https://example.test/ads' }],
      ],
      includeCommentsButton: false,
      includeSuggestButton: false,
      includeCtaButton: true,
      suggestButtonText: null,
      suggestionEntryMode: 'BOT',
      authorAttribution: {
        userId: actorUserId,
        displayName: 'Автор',
        mentionDisplayName: 'Автор',
        username: null,
        profileUrl: null,
      },
    });

    expect(
      readChannelSuggestionPublicationContextV1(
        createPayload({ reviewPublicationContext: context }),
      ),
    ).toEqual(context);
  });

  it('rejects malformed persisted button context', () => {
    expect(
      readChannelSuggestionPublicationContextV1(
        createPayload({
          reviewPublicationContext: { ...createContext(), buttons: [[{ type: 'link' }]] },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ['thread', (context: ReturnType<typeof createContext>) => ({ ...context, threadId: 'other' })],
    [
      'buttons',
      (context: ReturnType<typeof createContext>) => ({
        ...context,
        buttons: [[{ type: 'link', text: 'Другой поток', url: 'https://max.ru/other' }]],
      }),
    ],
    [
      'author',
      (context: ReturnType<typeof createContext>) => ({
        ...context,
        authorAttribution: { ...context.authorAttribution, displayName: 'Другой автор' },
      }),
    ],
    [
      'message digest',
      (context: ReturnType<typeof createContext>) => ({
        ...context,
        messageDigest: 'f'.repeat(64),
      }),
    ],
  ])('rejects a persisted context with a tampered %s', (_label, mutate) => {
    const context = createContext();
    expect(
      readChannelSuggestionPublicationContextV1(
        createPayload({ reviewPublicationContext: mutate(context) }),
      ),
    ).toBeNull();
  });

  it.each([
    ['claim token', { claimToken: 'other-claim' }],
    ['actor', { actorUserId: 'other-user' }],
    ['message digest', { messageDigest: 'c'.repeat(64) }],
    ['context digest', { contextDigest: 'd'.repeat(64) }],
  ])(
    'keeps completed recovery manual when ledger binding changes its %s',
    (_label, bindingPatch) => {
      const context = createContext();
      const ledger = createLedger({
        status: 'SUCCEEDED',
        terminal: true,
        dispatchToken: 'dispatch-token-1',
        dispatchStartedAt: new Date('2026-08-20T10:02:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: 'mid-1',
      });
      const ledgerContext = (ledger.metadata as { ledgerContext: Record<string, unknown> })
        .ledgerContext;

      expect(
        classifyChannelSuggestionPublicationRecovery({
          payload: createPayload({ reviewPublicationContext: context }),
          suggestionId,
          chatId,
          ledger: {
            ...ledger,
            metadata: { ledgerContext: { ...ledgerContext, ...bindingPatch } },
          },
        }),
      ).toEqual({ kind: 'manual', reason: 'context_missing' });
    },
  );

  it('classifies linked, terminal, and orphan ledger audit states without mutation', () => {
    const context = createContext();
    const baseAudit = {
      id: suggestionId,
      chatId,
      actorUserId,
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: createPayload(),
    };

    expect(
      classifyChannelSuggestionPublicationLedgerAudit({
        ledger: createLedger(),
        audit: null,
      }),
    ).toBe('missing_audit');
    expect(
      classifyChannelSuggestionPublicationLedgerAudit({
        ledger: createLedger(),
        audit: { ...baseAudit, payload: { type: 'suggest', reviewStatus: 'pending' } },
      }),
    ).toBe('pending_audit');
    expect(
      classifyChannelSuggestionPublicationLedgerAudit({
        ledger: createLedger(),
        audit: baseAudit,
      }),
    ).toBe('linked_publishing');

    const completedLedger = createLedger({
      status: 'SUCCEEDED',
      terminal: true,
      dispatchToken: 'dispatch-token-1',
      dispatchStartedAt: new Date('2026-08-20T10:02:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: 'mid-1',
    });
    expect(
      classifyChannelSuggestionPublicationLedgerAudit({
        ledger: completedLedger,
        audit: {
          ...baseAudit,
          payload: {
            type: 'suggest',
            reviewStatus: 'published',
            reviewPublicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
            reviewPublicationLedgerJobId: ledgerJobId,
            reviewPublicationContext: context,
            publishedMessageId: 'mid-1',
          },
        },
      }),
    ).toBe('published_audit');
    expect(
      classifyChannelSuggestionPublicationLedgerAudit({
        ledger: completedLedger,
        audit: {
          ...baseAudit,
          chatId: 'other-channel',
          payload: { type: 'suggest', reviewStatus: 'published' },
        },
      }),
    ).toBe('mismatched_audit');
  });

  it.each([
    {
      name: 'a retained dispatch fence',
      payload: () => createPayload({ reviewPublicationContext: createContext() }),
      ledger: () =>
        createLedger({
          dispatchToken: 'dispatch-token-retained',
          dispatchStartedAt: new Date('2026-08-20T10:02:00.000Z'),
          dispatchBotId: 'bot-1',
        }),
      expected: 'mismatched_audit',
    },
    {
      name: 'an ambiguous terminal dispatch',
      payload: () => createPayload({ reviewPublicationContext: createContext() }),
      ledger: () =>
        createLedger({
          status: 'AMBIGUOUS',
          ambiguous: true,
          terminal: true,
        }),
      expected: 'mismatched_audit',
    },
    {
      name: 'an invalid completion without persisted context',
      payload: () => createPayload(),
      ledger: () =>
        createLedger({
          status: 'SUCCEEDED',
          terminal: true,
          dispatchToken: 'dispatch-token-invalid-completed',
          dispatchStartedAt: new Date('2026-08-20T10:02:00.000Z'),
          dispatchBotId: 'bot-1',
          remoteMessageId: 'mid-invalid-completed',
        }),
      expected: 'mismatched_audit',
    },
    {
      name: 'a completed publication without a persisted dispatch bot',
      payload: () => createPayload({ reviewPublicationContext: createContext() }),
      ledger: () =>
        createLedger({
          status: 'SUCCEEDED',
          terminal: true,
          dispatchToken: 'dispatch-token-missing-bot',
          dispatchStartedAt: new Date('2026-08-20T10:02:00.000Z'),
          dispatchBotId: null,
          remoteMessageId: 'mid-missing-bot',
        }),
      expected: 'mismatched_audit',
    },
    {
      name: 'a valid completed publication',
      payload: () => createPayload({ reviewPublicationContext: createContext() }),
      ledger: () =>
        createLedger({
          status: 'SUCCEEDED',
          terminal: true,
          dispatchToken: 'dispatch-token-valid-completed',
          dispatchStartedAt: new Date('2026-08-20T10:02:00.000Z'),
          dispatchBotId: 'bot-1',
          remoteMessageId: 'mid-valid-completed',
        }),
      expected: 'linked_publishing',
    },
  ])('aligns publishing ledger audit for $name with recovery', ({ payload, ledger, expected }) => {
    expect(
      classifyChannelSuggestionPublicationLedgerAudit({
        ledger: ledger(),
        audit: {
          id: suggestionId,
          chatId,
          actorUserId,
          action: 'CHANNEL_DIALOG_SUGGESTION',
          payload: payload(),
        },
      }),
    ).toBe(expected);
  });
});
