import {
  assertEditableAttachmentsPreserved,
  readStrictEditableAttachments,
} from './max-editable-message-preservation';

describe('strict editable message preservation', () => {
  it('rejects missing messages and incomplete attachment collections', () => {
    expect(() => readStrictEditableAttachments(null)).toThrow();
    expect(() => readStrictEditableAttachments({ body: { attachments: {} } })).toThrow();
  });
  it('does not guess between different direct and forwarded media collections', () => {
    expect(() =>
      readStrictEditableAttachments({
        body: { attachments: [{ type: 'image', payload: { token: 'one' } }] },
        link: {
          type: 'forward',
          message: { attachments: [{ type: 'image', payload: { token: 'two' } }] },
        },
      }),
    ).toThrow('ambiguous');
  });
  it('rejects an unsupported existing keyboard instead of silently dropping it', () => {
    expect(() =>
      assertEditableAttachmentsPreserved(
        [{ type: 'inline_keyboard', payload: { buttons: [[{ type: 'unknown', text: 'Keep' }]] } }],
        [],
        [],
      ),
    ).toThrow('would be lost');
  });
});
