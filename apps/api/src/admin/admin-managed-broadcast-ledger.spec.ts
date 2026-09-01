import {
  buildManagedBroadcastLedgerContext,
  readManagedBroadcastLedgerCommentDialogContext,
  type ManagedBroadcastCommentDialogReference,
} from './admin-managed-broadcast-ledger';

describe('managed broadcast dialog keyboard snapshot', () => {
  const reference: ManagedBroadcastCommentDialogReference = {
    entityType: 'channel',
    threadId: 'thread-1',
    includeCommentsButton: true,
    includeSuggestButton: true,
    suggestButtonText: '✍️ Предложить объявление',
    customButtons: [],
    suggestionEntryMode: 'MINIAPP',
    botId: 'publisher-bot',
    dialogBotId: 'publisher-bot',
    buttonRows: [
      [{ type: 'link', text: '💬 Комментарии · 0', url: 'https://max.ru/comments' }],
      [{ type: 'link', text: '✍️ Предложить объявление', url: 'https://max.ru/suggest' }],
      [{ type: 'link', text: '📞 Заказать рекламу', url: 'https://example.test/ads' }],
    ],
    commentsButton: { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' },
  };

  it('round-trips the exact keyboard and comments slot through the action ledger', () => {
    const parsed = readManagedBroadcastLedgerCommentDialogContext({
      ledgerContext: buildManagedBroadcastLedgerContext(reference),
    });

    expect(parsed).toEqual({ found: true, reference });
  });

  it('rejects a comments slot outside the frozen keyboard', () => {
    const context = buildManagedBroadcastLedgerContext({
      ...reference,
      commentsButton: { rowIndex: 9, columnIndex: 0, baseText: '💬 Комментарии' },
    });

    expect(
      readManagedBroadcastLedgerCommentDialogContext({ ledgerContext: context }),
    ).toEqual({ found: false, reference: null });
  });
});
