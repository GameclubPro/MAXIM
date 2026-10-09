import type { WebhookEvent } from '../prisma/prisma-client';
import { WebhookParser } from './webhook.parser';
import {
  isSourceAbandonmentChannelMedia,
  inspectChannelAuthorlessSource,
  inspectSourceAbandonmentAnySource,
} from './webhook-source-abandonment-channel';
import { inspectSourceAbandonmentSource } from './webhook-legacy-source';
import { SOURCE_ABANDONMENT_CHANNEL_PROFILE } from './webhook-source-abandonment.contract';

type Source = Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>;
function fixture(type = 'message_created') {
  const at = Date.parse('2026-10-09T10:00:00.000Z');
  const body: Record<string, unknown> = {
    mid: 'channel-original',
    seq: 42,
    text: 'Ordinary channel post',
  };
  const recipient = { chat_id: '-111', chat_type: 'channel' };
  const message: Record<string, unknown> = { recipient, timestamp: at, body };
  const raw = { update_type: type, timestamp: at, message };
  const owner = (): Source => ({
    botId: 'major',
    createdAt: new Date(at + 1000),
    rawPayload: structuredClone(raw) as never,
    normalizedPayload: new WebhookParser().parse(structuredClone(raw), { botId: 'major' }) as never,
  });
  return { at, body, recipient, message, raw, owner };
}

describe('separate immutable authorless channel source profile', () => {
  it.each(['message_created', 'message_edited'])(
    'accepts the ingress empty %s receipt sample while retaining the stricter owner proof',
    (type) => {
      const owner = fixture(type).owner();
      const expected = inspectChannelAuthorlessSource(owner);
      expect(expected).not.toBeNull();
      owner.rawPayload = {};
      const before = structuredClone(owner);
      expect(inspectChannelAuthorlessSource(owner)).toBeNull();
      expect(inspectChannelAuthorlessSource(owner, undefined, undefined, true)).toEqual(expected);
      expect(owner).toEqual(before);
    },
  );

  it.each([null, [], 'invalid', { unexpected: true }])(
    'refuses a malformed or conflicting retained raw sample %j',
    (rawPayload) => {
      const owner = fixture().owner();
      owner.rawPayload = rawPayload as never;
      expect(inspectChannelAuthorlessSource(owner, undefined, undefined, true)).toBeNull();
    },
  );

  it.each(['missing-raw', 'sender', 'identity', 'clock', 'command', 'unknown-shape'])(
    'keeps normalized source proof mandatory with an empty raw sample: %s',
    (fault) => {
      const owner = fixture().owner();
      owner.rawPayload = {};
      const update = JSON.parse(JSON.stringify(owner.normalizedPayload));
      if (fault === 'missing-raw') delete update.raw;
      if (fault === 'sender') update.raw.message.sender = { user_id: 'invented' };
      if (fault === 'identity') update.message.messageId = 'other';
      if (fault === 'clock') update.raw.message.timestamp += 1;
      if (fault === 'command') update.raw.message.body.text = '/ban';
      if (fault === 'unknown-shape') update.raw.message.unproved = true;
      owner.normalizedPayload = update;
      expect(inspectChannelAuthorlessSource(owner, undefined, undefined, true)).toBeNull();
    },
  );

  it.each(['message_created', 'message_edited'])(
    'retains bounded official keyboards with %s source media without granting another target',
    (type) => {
      const f = fixture(type);
      f.message.url = 'https://max.ru/channel/another-post';
      const keyboard = {
        type: 'inline_keyboard',
        payload: {
          buttons:
            type === 'message_edited'
              ? [
                  [{ type: 'link', text: 'First', url: 'https://example.com/a' }],
                  [{ type: 'link', text: 'Second', url: 'https://example.com/b' }],
                ]
              : [
                  [
                    {
                      type: 'open_app',
                      text: 'Open app',
                      contact_id: 12345,
                      web_app: 'https://example.com/app',
                      payload: 'opaque-start-argument',
                    },
                  ],
                ],
        },
      };
      f.body.attachments = [
        type === 'message_edited'
          ? { type: 'image', payload: { photo_id: 42, url: 'https://example.com/image' } }
          : {
              type: 'video',
              payload: { id: 42, token: 'opaque-video-token', url: 'https://example.com/video' },
            },
        keyboard,
      ];
      const owner = f.owner(),
        before = structuredClone(owner);
      expect(inspectChannelAuthorlessSource(owner)).toMatchObject({
        userId: null,
        chatId: '-111',
        messageId: 'channel-original',
        sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
      });
      expect(owner).toEqual(before);
      expect(inspectSourceAbandonmentSource(owner)).toBeNull();
    },
  );

  it.each([
    { type: 'callback', text: 'Callback', payload: 'command' },
    { type: 'link', text: 'Link', url: 'http://example.com' },
    { type: 'link', text: 'Link', url: 'https://user:secret@example.com' },
    { type: 'link', text: 'Link', url: 'https://example.com', user_id: 'invented' },
    { type: 'open_app', text: 'App', web_app: 'javascript:command' },
    ...[
      '@Some_Public_Bot',
      ' Some_Public_Bot',
      'Some_Public_Bot ',
      '1Bot',
      'Bot-name',
      'Бот',
      'A'.repeat(65),
      'Bot/path',
    ].map((web_app) => ({ type: 'open_app', text: 'App', web_app, contact_id: 42 })),
    { type: 'open_app', text: 'App', contact_id: {} },
    { type: 'open_app', text: 'App', payload: 'no target' },
    { type: 'open_app', text: 'App', contact_id: '123', payload: { target: 'other' } },
    { type: 'open_app', text: 'App', contact_id: '123', payload: 'x'.repeat(4097) },
    { type: 'link', text: 'x'.repeat(257), url: 'https://example.com' },
  ])('refuses unsupported keyboard button %#', (button) => {
    expect(
      isSourceAbandonmentChannelMedia(
        [{ type: 'inline_keyboard', payload: { buttons: [[button]] } }],
        undefined,
      ),
    ).toBe(false);
  });

  it.each(['A', 'Some_Public_Bot', 'A'.repeat(64)])(
    'retains an official open_app shortname unchanged with channel video: %s',
    (web_app) => {
      const f = fixture();
      f.message.url = 'https://max.ru/another-channel/another-post';
      f.body.attachments = [
        { type: 'video', payload: { id: 42, token: 'opaque', url: 'https://example.com/video' } },
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [{ type: 'open_app', text: 'Open', web_app, contact_id: 12345, payload: 'start' }],
            ],
          },
        },
      ];
      const owner = f.owner(),
        before = structuredClone(owner);
      expect(inspectChannelAuthorlessSource(owner)).toEqual({
        sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
        chatId: '-111',
        messageId: 'channel-original',
        userId: null,
        sourceAt: new Date(f.at),
      });
      expect(owner).toEqual(before);
    },
  );

  it('refuses multiple keyboards, excessive rows/buttons, extra payloads and linked keyboards', () => {
    const button = { type: 'link', text: 'Link', url: 'https://example.com' };
    const keyboard = { type: 'inline_keyboard', payload: { buttons: [[button]] } };
    expect(isSourceAbandonmentChannelMedia([keyboard, keyboard], undefined)).toBe(false);
    expect(
      isSourceAbandonmentChannelMedia(
        [{ ...keyboard, payload: { buttons: Array.from({ length: 31 }, () => [button]) } }],
        undefined,
      ),
    ).toBe(false);
    expect(
      isSourceAbandonmentChannelMedia(
        [{ ...keyboard, payload: { buttons: [Array.from({ length: 11 }, () => button)] } }],
        undefined,
      ),
    ).toBe(false);
    expect(
      isSourceAbandonmentChannelMedia(
        [{ ...keyboard, payload: { ...keyboard.payload, command: 'unknown' } }],
        undefined,
      ),
    ).toBe(false);
    expect(isSourceAbandonmentChannelMedia([keyboard], { type: 'forward' })).toBe(false);
  });

  it.each(['direct', 'forward'])(
    'retains a passive original post URL on %s media without granting another target',
    (kind) => {
      const f = fixture();
      f.message.url = 'https://max.ru/another-channel/another-post';
      const image = { type: 'image', payload: { photo_id: 42, url: 'https://example.com/image' } };
      if (kind === 'forward') {
        f.body.text = '';
        f.message.link = {
          type: 'forward',
          chat_id: '-222',
          sender: { user_id: 'linked-human', is_bot: false },
          message: { mid: 'linked-mid', seq: 55, text: 'Quoted source', attachments: [image] },
        };
      } else {
        f.body.attachments = [image];
      }
      const owner = f.owner(),
        before = structuredClone(owner);
      expect(inspectSourceAbandonmentAnySource(owner)).toEqual({
        sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
        chatId: '-111',
        messageId: 'channel-original',
        userId: null,
        sourceAt: new Date(f.at),
      });
      expect(owner).toEqual(before);
      (owner.normalizedPayload as unknown as { message: { text: string } }).message.text =
        'Unproved replacement';
      expect(inspectChannelAuthorlessSource(owner)).toBeNull();
    },
  );

  it.each([
    null,
    42,
    '',
    'http://example.com/post',
    'https://user:password@example.com/post',
    'https://example.com/with space',
    'https://example.com/' + 'x'.repeat(8192),
    'relative-post',
  ])('refuses unsupported original post URL %#', (url) => {
    const f = fixture();
    f.message.url = url;
    expect(inspectChannelAuthorlessSource(f.owner())).toBeNull();
  });

  it('retains direct channel markup with a bounded scheme-less link without changing authority', () => {
    const f = fixture();
    f.body.text = '😀 Ordinary channel post with retained original formatting';
    f.body.attachments = [
      { type: 'image', payload: { photo_id: 42, url: 'https://example.com/image' } },
    ];
    f.body.markup = [
      ...Array.from({ length: 4 }, () => ({ type: 'strong', from: 3, length: 8 })),
      { type: 'emphasized', from: 3, length: 8 },
      ...Array.from({ length: 5 }, () => ({
        type: 'link',
        from: 3,
        length: 8,
        url: 'https://example.com/post',
      })),
      { type: 'link', from: 3, length: 8, url: 'another.example/another-channel/another-post' },
    ];
    const owner = f.owner(),
      before = structuredClone(owner);
    expect(inspectChannelAuthorlessSource(owner)).toEqual({
      sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
      chatId: '-111',
      messageId: 'channel-original',
      userId: null,
      sourceAt: new Date(f.at),
    });
    expect(owner).toEqual(before);
    f.recipient.chat_type = 'chat';
    f.message.sender = { user_id: 'original-human', is_bot: false };
    expect(inspectSourceAbandonmentAnySource(f.owner())).toBeNull();
  });

  it.each([
    '',
    ' with-space',
    'trailing-space ',
    'inline space',
    'inline\nline',
    'inline\u0000control',
    'inline\u007fcontrol',
    'x'.repeat(2049),
    '//example.com/post',
    '\\example.com/post',
    'path\\other',
    'http://example.com/post',
    'javascript:alert(1)',
  ])('refuses unsupported channel markup link %#', (url) => {
    const f = fixture();
    f.body.markup = [{ type: 'link', from: 0, length: 8, url }];
    expect(inspectChannelAuthorlessSource(f.owner())).toBeNull();
  });

  it('refuses unknown metadata, missing source identity and unproved channel markup bounds', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.message.stat = { views: 5 };
      },
      (f: ReturnType<typeof fixture>) => {
        f.message.other = 'unknown';
      },
      (f: ReturnType<typeof fixture>) => {
        f.body.mid = '';
      },
      (f: ReturnType<typeof fixture>) => {
        f.body.markup = [{ type: 'link', from: 0, length: 8, url: 'post/path', user_id: 12 }];
      },
      (f: ReturnType<typeof fixture>) => {
        f.body.markup = [{ type: 'link', from: 0, length: 500, url: 'post/path' }];
      },
      (f: ReturnType<typeof fixture>) => {
        f.body.markup = [{ type: 'link', from: -1, length: 8, url: 'post/path' }];
      },
      (f: ReturnType<typeof fixture>) => {
        f.body.markup = [{ type: 'link', from: 0, length: 0, url: 'post/path' }];
      },
    ]) {
      const f = fixture();
      f.message.url = 'https://max.ru/another-channel/another-post';
      mutate(f);
      expect(inspectChannelAuthorlessSource(f.owner())).toBeNull();
    }
  });

  it.each(['message_created', 'message_edited'])(
    'accepts %s with a real null author and preserves evidence',
    (type) => {
      const f = fixture(type),
        owner = f.owner(),
        before = structuredClone(owner);
      expect(inspectSourceAbandonmentAnySource(owner)).toEqual({
        sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
        chatId: '-111',
        messageId: 'channel-original',
        userId: null,
        sourceAt: new Date(f.at),
      });
      expect(inspectSourceAbandonmentAnySource(owner, undefined, undefined, true)).not.toBeNull();
      expect(inspectSourceAbandonmentSource(owner)).toBeNull();
      expect(owner).toEqual(before);
    },
  );

  it.each([
    null,
    {},
    { user_id: '' },
    { user_id: 'bot', is_bot: true },
    { user_id: 'human', is_bot: false },
  ])('refuses any supplied raw sender %j', (sender) => {
    const f = fixture();
    f.message.sender = sender;
    expect(inspectChannelAuthorlessSource(f.owner())).toBeNull();
  });

  it.each([undefined, null, 'human', 'linked-user'])(
    'refuses a normalized sender other than actual parser empty value: %j',
    (senderId) => {
      const owner = fixture().owner();
      (
        owner.normalizedPayload as unknown as {
          message: Record<string, unknown>;
          botId: string;
          eventTimestampSource: string;
        }
      ).message.senderId = senderId;
      expect(inspectChannelAuthorlessSource(owner)).toBeNull();
    },
  );

  it.each(['chat', 'dialog'])('refuses authorless %s envelopes', (type) => {
    const f = fixture();
    f.recipient.chat_type = type;
    expect(inspectSourceAbandonmentAnySource(f.owner())).toBeNull();
  });

  it('refuses raw/normalized entity, receiver, source payload and clock conflicts', () => {
    for (const mutate of [
      (owner: Source) => {
        (
          owner.normalizedPayload as unknown as {
            message: Record<string, unknown>;
            botId: string;
            eventTimestampSource: string;
          }
        ).message.entityType = 'chat';
      },
      (owner: Source) => {
        (
          owner.normalizedPayload as unknown as {
            message: Record<string, unknown>;
            botId: string;
            eventTimestampSource: string;
          }
        ).botId = 'other';
      },
      (owner: Source) => {
        owner.rawPayload = { conflicting: true };
      },
      (owner: Source) => {
        (
          owner.normalizedPayload as unknown as {
            message: Record<string, unknown>;
            botId: string;
            eventTimestampSource: string;
          }
        ).eventTimestampSource = 'ingress';
      },
      (owner: Source) => {
        (
          owner.normalizedPayload as unknown as {
            message: Record<string, unknown>;
            botId: string;
            eventTimestampSource: string;
          }
        ).message.text = 'different';
      },
      (owner: Source) => {
        owner.createdAt = new Date(0);
      },
    ]) {
      const owner = fixture().owner();
      mutate(owner);
      expect(inspectSourceAbandonmentAnySource(owner)).toBeNull();
    }
  });

  it.each(['Старт', '/command', '$command', 'бан', 'quiet'])(
    'rejects default and configured commands %s',
    (text) => {
      const f = fixture();
      f.body.text = text;
      expect(
        inspectChannelAuthorlessSource(f.owner(), undefined, { adminSilenceCommandName: 'quiet' }),
      ).toBeNull();
    },
  );

  it('never substitutes the linked human for the absent channel author', () => {
    const f = fixture();
    f.message.link = {
      type: 'forward',
      chat_id: '-222',
      sender: { user_id: 'linked-human', is_bot: false },
      message: { mid: 'linked-mid', text: 'A quoted ordinary source' },
    };
    expect(inspectChannelAuthorlessSource(f.owner())).toMatchObject({
      sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
      userId: null,
      chatId: '-111',
      messageId: 'channel-original',
    });
  });

  it('accepts only identical linked markup copied onto an empty channel forward', () => {
    const f = fixture();
    const markup = [{ type: 'link', from: 2, length: 8, url: 'https://example.com/source' }];
    f.body.text = '';
    f.body.markup = structuredClone(markup);
    f.message.link = {
      type: 'forward',
      chat_id: '-222',
      message: { mid: 'linked-mid', text: 'A quoted ordinary source', markup },
    };
    expect(inspectChannelAuthorlessSource(f.owner())).toMatchObject({
      userId: null,
      sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
    });
    (f.body.markup as typeof markup)[0]!.url = 'https://example.com/changed';
    expect(inspectChannelAuthorlessSource(f.owner())).toBeNull();
  });
});
