import {
  assertEditableAttachmentsPreserved,
  readStrictEditableAttachments,
} from './max-editable-message-preservation';
import { AdminDialogLinkHelper } from '../admin/admin-dialog-link-helper';

describe('strict editable message preservation', () => {
  it('allows only a recognized same-channel suggestion alias, never lost ads or comments', () => {
    const helper = new AdminDialogLinkHelper({
      appBaseUrl: null,
      explicitBotContactId: null,
      ownBotUserId: 'major',
      maxBotToken: 'test',
      maxBotTokenValidationSecrets: ['test'],
    });
    const button = (chatId: string, kind: 'suggest' | 'comments', thread: string) =>
      helper.buildChannelDialogButton(chatId, kind, thread, 'Same label', 'major', 'MINIAPP');
    const keyboard = (value: unknown) => ({
      type: 'inline_keyboard',
      payload: { buttons: [[value]] },
    });
    const original = button('-100', 'suggest', 'old');
    expect(() =>
      assertEditableAttachmentsPreserved(
        [keyboard(original)],
        [keyboard(button('-100', 'suggest', 'new'))],
        [],
      ),
    ).not.toThrow();
    for (const replacement of [
      button('-200', 'suggest', 'old'),
      button('-100', 'comments', 'old'),
      { type: 'link', text: 'Same label', url: 'https://example.com/ads' },
    ]) {
      expect(() =>
        assertEditableAttachmentsPreserved([keyboard(original)], [keyboard(replacement)], []),
      ).toThrow('would be lost');
      expect(() =>
        assertEditableAttachmentsPreserved([keyboard(replacement)], [keyboard(original)], []),
      ).toThrow('would be lost');
    }
    expect(() =>
      assertEditableAttachmentsPreserved(
        [keyboard(button('-100', 'comments', 'old'))],
        [keyboard(button('-100', 'comments', 'new'))],
        [],
      ),
    ).toThrow('would be lost');
  });
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
