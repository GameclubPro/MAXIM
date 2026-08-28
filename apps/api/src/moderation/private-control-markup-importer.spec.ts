import type { MaxUpdate } from '@maxim/contracts';
import {
  extractIncomingFormattedTextPayload,
  extractIncomingSuggestionTextPayload,
} from './private-control-markup-importer';

function currentOfficialMarkupUpdate(): MaxUpdate {
  return {
    type: 'message_created',
    updateId: 'markup-current-1',
    raw: {
      message: {
        body: {
          text: 'Title\nFocus\nQuote\nUser',
          markup: [
            { type: 'heading', from: 0, length: 5 },
            { type: 'highlighted', from: 6, length: 5 },
            { type: 'quote', from: 12, length: 5 },
            { type: 'user_mention', from: 18, length: 4, user_id: 67123224 },
          ],
        },
      },
    },
  } as MaxUpdate;
}

describe('private control markup importer', () => {
  it('reconstructs current official formatting as MAX markdown', () => {
    expect(extractIncomingFormattedTextPayload(currentOfficialMarkupUpdate(), '')).toEqual({
      text: '# Title\n^^Focus^^\n> Quote\n[User](max://user/67123224)',
      textFormat: 'markdown',
    });
  });

  it('preserves current official suggestion markup with canonical mention targets', () => {
    expect(extractIncomingSuggestionTextPayload(currentOfficialMarkupUpdate(), '')).toEqual({
      text: 'Title\nFocus\nQuote\nUser',
      textFormat: 'plain',
      textMarkup: [
        { type: 'heading', from: 0, length: 5, url: null, userLink: null },
        { type: 'highlighted', from: 6, length: 5, url: null, userLink: null },
        { type: 'quote', from: 12, length: 5, url: null, userLink: null },
        {
          type: 'user_mention',
          from: 18,
          length: 4,
          url: null,
          userLink: 'max://user/67123224',
        },
      ],
    });
  });

  it('preserves source whitespace so official UTF-16 markup offsets stay aligned', () => {
    const update = {
      type: 'message_created',
      updateId: 'markup-whitespace-1',
      raw: {
        message: {
          body: {
            text: '  Bold  ',
            markup: [{ type: 'strong', from: 2, length: 4 }],
          },
        },
      },
    } as MaxUpdate;

    expect(extractIncomingFormattedTextPayload(update, '')).toEqual({
      text: '  **Bold**  ',
      textFormat: 'markdown',
    });
  });

  it('uses populated text_markup when the earlier markup field is empty', () => {
    const update = {
      type: 'message_created',
      updateId: 'markup-fallback-array-1',
      raw: {
        message: {
          body: {
            text: 'Title',
            markup: [],
            text_markup: [{ type: 'strong', from: 0, length: 5 }],
          },
        },
      },
    } as MaxUpdate;

    expect(extractIncomingFormattedTextPayload(update, '')).toEqual({
      text: '**Title**',
      textFormat: 'markdown',
    });
  });

  it('skips invalid aliases and accepts camelCase markup fields', () => {
    const update = {
      type: 'message_created',
      updateId: 'markup-camel-case-1',
      raw: {
        message: {
          body: {
            text: 'Title',
            markup: [{ type: 'unknown', from: 0, length: 5 }],
            textMarkup: [{ type: 'strong', from: 0, length: 5 }],
          },
        },
      },
    } as MaxUpdate;

    expect(extractIncomingFormattedTextPayload(update, '')).toEqual({
      text: '**Title**',
      textFormat: 'markdown',
    });
  });

  it('keeps a redundant auto-link as exact plain text without escape leakage', () => {
    const url = 'https://t.me/glavnyy_admin';
    const update = {
      type: 'message_created',
      updateId: 'markup-auto-link-1',
      raw: {
        message: {
          body: {
            text: url,
            markup: [{ type: 'link', from: 0, length: url.length, url }],
          },
        },
      },
    } as MaxUpdate;

    expect(extractIncomingFormattedTextPayload(update, '')).toEqual({
      text: url,
      textFormat: 'plain',
    });
  });

  it('keeps text plain when incoming markup has no applicable range', () => {
    const source = 'snake_case C++17';
    const update = {
      type: 'message_created',
      updateId: 'markup-invalid-only-1',
      raw: {
        message: {
          body: {
            text: source,
            markup: [{ type: 'strong', from: 99, length: 4 }],
          },
        },
      },
    } as MaxUpdate;

    expect(extractIncomingFormattedTextPayload(update, '')).toEqual({
      text: source,
      textFormat: 'plain',
    });
  });

  it('imports text and markup from the official forwarded-message link', () => {
    const update = {
      type: 'message_created',
      updateId: 'markup-forward-1',
      raw: {
        message: {
          body: { text: '' },
          link: {
            type: 'forward',
            message: {
              body: {
                text: 'Forwarded title',
                markup: [{ type: 'strong', from: 0, length: 9 }],
              },
            },
          },
        },
      },
    } as MaxUpdate;

    expect(extractIncomingFormattedTextPayload(update, 'fallback')).toEqual({
      text: '**Forwarded** title',
      textFormat: 'markdown',
    });
    expect(extractIncomingSuggestionTextPayload(update, 'fallback')).toEqual({
      text: 'Forwarded title',
      textFormat: 'plain',
      textMarkup: [
        { type: 'strong', from: 0, length: 9, url: null, userLink: null },
      ],
    });
  });
});
