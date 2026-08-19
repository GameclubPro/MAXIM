import {
  buildManagedPollLedgerContext,
  readManagedPollLedgerChannelEngagement,
} from './admin-managed-poll-ledger';

describe('managed poll ledger context', () => {
  it('binds a routed send to the exact poll render format', () => {
    const context = buildManagedPollLedgerContext(
      {
        buttons: [],
        threadId: 'thread-1',
        includeCommentsButton: true,
        includeSuggestButton: false,
        suggestButtonText: null,
        suggestionEntryMode: 'BOT',
      },
      'bot-1',
      6,
    );

    expect(readManagedPollLedgerChannelEngagement({ ledgerContext: context })).toEqual({
      found: true,
      reference: {
        threadId: 'thread-1',
        includeCommentsButton: true,
        includeSuggestButton: false,
        suggestButtonText: null,
        suggestionEntryMode: 'BOT',
        botId: 'bot-1',
      },
      renderFormatVersion: 6,
    });
  });

  it('keeps legacy ledgers readable but leaves their render format unresolved', () => {
    expect(
      readManagedPollLedgerChannelEngagement({
        ledgerContext: {
          managedPoll: {
            channelEngagement: null,
          },
        },
      }),
    ).toEqual({ found: true, reference: null, renderFormatVersion: null });
  });
});
