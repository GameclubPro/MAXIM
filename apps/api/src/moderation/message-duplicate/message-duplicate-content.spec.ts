import {
  buildMessageDuplicateIdentity,
  extractDuplicateMessageContent,
  canRefreshDuplicatePhotoSources,
} from './message-duplicate-content';

const content = (body: Record<string, unknown>, extra = {}) =>
  extractDuplicateMessageContent({ message: { body, ...extra } });
const identity = (body: Record<string, unknown>) =>
  buildMessageDuplicateIdentity(content(body), 'MESSAGE');
const photo = (id: string) => ({
  type: 'image',
  payload: { photo_id: id, url: `https://i.oneme.ru/${id}` },
});

describe('message duplicate canonical contents', () => {
  it.each(['image_url', 'imageUrl'] as const)(
    'reads the existing MAX %s photo field variants',
    (key) => {
      for (const nested of [true, false]) {
        const fields = { photoId: 'photo', [key]: 'https://i.oneme.ru/photo' };
        const parsed = content({
          attachments: [
            { type: 'image', ...(nested ? { payload: fields } : { ...fields, payload: {} }) },
          ],
        });
        expect(parsed.complete).toBe(true);
        expect(parsed.media).toEqual([
          expect.objectContaining({ photoId: 'photo', url: 'https://i.oneme.ru/photo' }),
        ]);
      }
    },
  );
  it('never refreshes an anonymous photo from a different source URL', () => {
    const original = content({
      attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/a' } }],
    });
    const fresh = content({
      attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/b' } }],
    });
    expect(canRefreshDuplicatePhotoSources(original, fresh)).toBe(false);
    expect(original.sourceDigest).not.toBe(fresh.sourceDigest);
  });
  it('keeps a message-bound photo source stable across URL renewal, never across photo replacement', () => {
    const original = content({ attachments: [photo('a')] });
    const renewed = content({
      attachments: [
        { type: 'image', payload: { photo_id: 'a', url: 'https://i.oneme.ru/renewed' } },
      ],
    });
    expect(renewed.sourceDigest).toBe(original.sourceDigest);
    expect(renewed.media[0]!.identity).not.toBe(original.media[0]!.identity);
    expect(content({ attachments: [photo('b')] }).sourceDigest).not.toBe(original.sourceDigest);
    expect(buildMessageDuplicateIdentity(renewed, 'MESSAGE')).toBeNull();
  });
  it.each(['a', '\u0434\u0430', '\u{1f44d}', '1', '!'])(
    'compares nonempty short text %s',
    (text) => {
      expect(identity({ text })).toMatch(/^[a-f0-9]{64}$/);
      expect(identity({ text: ` ${text.toUpperCase()}\n` })).toBe(identity({ text }));
    },
  );
  it('does not compare empty text or discard punctuation, numbers, or emoji joiners', () => {
    expect(identity({ text: '  ' })).toBeNull();
    expect(identity({ text: '1' })).not.toBe(identity({ text: '2' }));
    expect(identity({ text: 'yes!' })).not.toBe(identity({ text: 'yes?' }));
    expect(identity({ text: '\u{1f469}\u200d\u{1f4bb}' })).not.toBe(
      identity({ text: '\u{1f469}\u{1f4bb}' }),
    );
  });
  it('treats direct text, captions, and explicit forward contents equally', () => {
    const forwarded = content(
      {},
      { link: { type: 'forward', message: { body: { text: 'hello' } } } },
    );
    expect(buildMessageDuplicateIdentity(forwarded, 'MESSAGE')).toBe(identity({ text: 'hello' }));
    expect(identity({ caption: 'hello' })).toBe(identity({ text: 'hello' }));
    expect(
      buildMessageDuplicateIdentity(
        content({}, { forwarded_message: { body: { text: 'hello' } } }),
        'MESSAGE',
      ),
    ).toBe(identity({ text: 'hello' }));
  });
  it('does not count reply quotations as content', () => {
    expect(
      buildMessageDuplicateIdentity(
        content(
          { text: 'answer' },
          { link: { type: 'reply', message: { body: { text: 'quoted' } } } },
        ),
        'MESSAGE',
      ),
    ).toBe(identity({ text: 'answer' }));
  });
  it('ignores formatting while preserving hidden links and keyboard actions', () => {
    expect(identity({ text: 'hello', markup: [{ type: 'strong', from: 0, length: 5 }] })).toBe(
      identity({ text: 'hello' }),
    );
    const hidden = (url: string) => ({
      text: 'hello',
      markup: [{ type: 'link', from: 0, length: 5, url }],
    });
    expect(identity(hidden('https://example.com/a'))).not.toBe(
      identity(hidden('https://example.com/b')),
    );
    const buttons = (payload: string) => ({
      text: 'hello',
      attachments: [
        {
          type: 'inline_keyboard',
          payload: { buttons: [[{ type: 'callback', text: 'open', payload }]] },
        },
      ],
    });
    expect(identity(buttons('a'))).not.toBe(identity(buttons('b')));
  });
  it('requires independently verified media hashes, not ids, names, sizes or URLs', () => {
    const a = content({ text: 'caption', attachments: [photo('a')] });
    const b = content({ text: 'caption', attachments: [photo('b')] });
    expect(buildMessageDuplicateIdentity(a, 'MESSAGE')).toBeNull();
    expect(buildMessageDuplicateIdentity(a, 'MESSAGE', ['a'.repeat(64)])).toBe(
      buildMessageDuplicateIdentity(b, 'MESSAGE', ['a'.repeat(64)]),
    );
    expect(buildMessageDuplicateIdentity(a, 'MESSAGE', ['a'.repeat(64)])).not.toBe(
      buildMessageDuplicateIdentity(b, 'MESSAGE', ['b'.repeat(64)]),
    );
    expect(buildMessageDuplicateIdentity(a, 'TEXT')).toBe(buildMessageDuplicateIdentity(b, 'TEXT'));
  });
  it('compares complete albums as one object, never a subset or split package', () => {
    const album = content({ attachments: [photo('a'), photo('b')] });
    expect(buildMessageDuplicateIdentity(album, 'MESSAGE', ['a'.repeat(64)])).toBeNull();
    expect(
      buildMessageDuplicateIdentity(album, 'MESSAGE', ['a'.repeat(64), 'b'.repeat(64)]),
    ).not.toBeNull();
    expect(content({ attachments: [photo('a')], media_group_id: 'group' }).complete).toBe(false);
  });
  it('does not let unknown attachments or malformed buttons disappear in TEXT mode', () => {
    const unknown = content({
      text: 'caption',
      attachments: [{ type: 'future_navigation', payload: {} }],
    });
    expect(buildMessageDuplicateIdentity(unknown, 'TEXT')).toBeNull();
    expect(
      buildMessageDuplicateIdentity(
        content({
          text: 'caption',
          attachments: [
            { type: 'file', payload: {} },
            { type: 'inline_keyboard', payload: { buttons: 'bad' } },
          ],
        }),
        'TEXT',
      ),
    ).toBeNull();
  });
  it('permits TEXT captions with unavailable known media, but fails closed on oversized content', () => {
    expect(
      buildMessageDuplicateIdentity(
        content({ caption: 'caption', attachments: [{ type: 'file', payload: {} }] }),
        'TEXT',
      ),
    ).not.toBeNull();
    expect(identity({ text: 'x'.repeat(8001) })).toBeNull();
    expect(identity({ attachments: Array.from({ length: 11 }, () => photo('a')) })).toBeNull();
  });
});
