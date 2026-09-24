import { refreshExistingInlineKeyboardText } from './max-inline-keyboard-text-refresh';

const button = {
  type: 'link' as const,
  text: 'Comments 0',
  url: 'https://max.ru/bot?startapp=thread-one',
};
const other = { type: 'link', text: 'Shop', url: 'https://example.com/new-shop' };
const message = {
  body: {
    text: 'Original',
    markup: [{ type: 'strong', from: 0, length: 8 }],
    attachments: [
      { type: 'image', payload: { token: 'media' } },
      { type: 'inline_keyboard', payload: { buttons: [[other], [button]] } },
    ],
  },
};

describe('existing comment button text refresh', () => {
  it('changes only the exact live target label, preserving position, media, text and links', async () => {
    const readText = jest.fn().mockResolvedValue('Comments 9');
    const before = structuredClone(message);
    const result = await refreshExistingInlineKeyboardText(message, { button, readText });
    const expected = structuredClone(message);
    expected.body.attachments[1]!.payload.buttons![1]![0]!.text = 'Comments 9';
    expect(result).toEqual(expected);
    expect(message).toEqual(before);
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('does not restore a removed button or change another thread with the same label', async () => {
    const readText = jest.fn();
    expect(
      await refreshExistingInlineKeyboardText(message, {
        button: { ...button, url: 'https://max.ru/bot?startapp=other-thread' },
        readText,
      }),
    ).toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });

  it('skips an unchanged counter and does not touch nested forwarded keyboards', async () => {
    expect(
      await refreshExistingInlineKeyboardText(message, {
        button,
        readText: async () => button.text,
      }),
    ).toBeNull();
    expect(
      await refreshExistingInlineKeyboardText(
        { body: { text: '' }, link: { type: 'forward', message } },
        {
          button,
          readText: async () => 'Comments 1',
        },
      ),
    ).toBeNull();
  });

  it('fails closed on unavailable snapshots and failed counts', async () => {
    await expect(
      refreshExistingInlineKeyboardText(null, { button, readText: async () => '0' }),
    ).rejects.toThrow('unavailable');
    await expect(
      refreshExistingInlineKeyboardText(message, {
        button,
        readText: async () => {
          throw new Error('database unavailable');
        },
      }),
    ).rejects.toThrow('database unavailable');
  });
});
