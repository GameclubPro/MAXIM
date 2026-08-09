import {
  internalChannelDialogButtonIdentityKey,
  readInternalChannelDialogButtonIdentity,
  readInternalChannelDialogButtonIdentitiesFromMessage,
} from './channel-dialog-button-identity.util';

function buildStartParam(chatId: string, kind: 'comments' | 'suggest', threadId: string): string {
  const token = `cdt-${Buffer.from(
    JSON.stringify({ v: 1, d: threadId, s: 'a'.repeat(64) }),
    'utf8',
  ).toString('base64url')}`;
  const payload = Buffer.from(
    JSON.stringify({ v: 1, k: 'channel-dialog', c: chatId, m: kind, t: token }),
    'utf8',
  ).toString('base64url');
  return `cd-${payload}`;
}

describe('internal channel dialog button identity', () => {
  it('recognizes channel comments across thread-specific MAX miniapp links', () => {
    const first = readInternalChannelDialogButtonIdentity({
      type: 'link',
      url: `https://max.ru/bot-1?startapp=${buildStartParam('channel-1', 'comments', 'thread-1')}`,
    });
    const second = readInternalChannelDialogButtonIdentity({
      type: 'LINK',
      url: `https://max.ru/bot-2?startapp=${buildStartParam('channel-1', 'comments', 'thread-2')}`,
    });

    expect(first).toEqual({ chatId: 'channel-1', kind: 'comments', threadId: 'thread-1' });
    expect(second).toEqual({ chatId: 'channel-1', kind: 'comments', threadId: 'thread-2' });
    expect(internalChannelDialogButtonIdentityKey(first!)).toBe(
      internalChannelDialogButtonIdentityKey(second!),
    );
  });

  it('recognizes compact suggestion and direct open-app channel links', () => {
    const directToken = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: 'direct-thread', s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    expect(
      readInternalChannelDialogButtonIdentity({
        type: 'link',
        url: `https://max.ru/bot-1?start=${encodeURIComponent(
          `cds-channel-1.${'a'.repeat(32)}.${'b'.repeat(24)}`,
        )}`,
      }),
    ).toEqual({
      chatId: 'channel-1',
      kind: 'suggest',
      threadId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    expect(
      readInternalChannelDialogButtonIdentity({
        type: 'open_app',
        web_app: `https://major-maksimov.ru/app/channel/channel-2/dialog/suggest?token=${directToken}`,
      }),
    ).toEqual({ chatId: 'channel-2', kind: 'suggest', threadId: 'direct-thread' });
  });

  it('recognizes historical exact direct hosts without trusting lookalike domains', () => {
    const token = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: 'legacy-thread', s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;

    for (const host of ['maxim.play-team.ru', 'app.major-maksimov.ru']) {
      expect(
        readInternalChannelDialogButtonIdentity({
          type: 'link',
          url: `https://${host}/app/channel/channel-legacy/dialog/comments?token=${token}`,
        }),
      ).toEqual({ chatId: 'channel-legacy', kind: 'comments', threadId: 'legacy-thread' });
    }

    expect(
      readInternalChannelDialogButtonIdentity({
        type: 'link',
        url: `https://maxim.play-team.ru.attacker.example/app/channel/channel-legacy/dialog/comments?token=${token}`,
      }),
    ).toBeNull();
  });

  it('does not classify custom, malformed, or chat-dialog buttons as channel system buttons', () => {
    const spoofedToken = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: 'spoofed-thread', s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    expect(
      readInternalChannelDialogButtonIdentity({
        type: 'link',
        url: `https://example.com/app/channel/channel-1/dialog/comments?token=${spoofedToken}`,
      }),
    ).toBeNull();
    expect(
      readInternalChannelDialogButtonIdentity({
        type: 'link',
        url: `https://major-maksimov.ru.attacker.example/app/channel/channel-1/dialog/comments?token=${spoofedToken}`,
      }),
    ).toBeNull();
    expect(
      readInternalChannelDialogButtonIdentity({
        type: 'link',
        url: `https://max.ru/bot-1?startapp=${buildStartParam(
          'chat-1',
          'comments',
          'thread-1',
        ).replace('cd-', 'broken-')}`,
      }),
    ).toBeNull();

    const malformedTokenPayload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'channel-dialog',
        c: 'channel-1',
        m: 'comments',
        t: 'cdt-not-signed',
      }),
      'utf8',
    ).toString('base64url');
    expect(
      readInternalChannelDialogButtonIdentity({
        type: 'link',
        url: `https://max.ru/bot-1?startapp=cd-${malformedTokenPayload}`,
      }),
    ).toBeNull();
    expect(
      readInternalChannelDialogButtonIdentity({
        type: 'open_app',
        web_app:
          'https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=cdt-not-signed',
      }),
    ).toBeNull();

    const chatDialogPayload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'chat-dialog',
        c: 'chat-1',
        m: 'comments',
        t: 'cdt-token',
      }),
      'utf8',
    ).toString('base64url');
    expect(
      readInternalChannelDialogButtonIdentity({
        type: 'link',
        url: `https://max.ru/bot-1?startapp=cd-${chatDialogPayload}`,
      }),
    ).toBeNull();
  });

  it('extracts and channel-filters identities from raw MAX message keyboards', () => {
    const commentsUrl = `https://max.ru/bot-1?startapp=${buildStartParam(
      'channel-1',
      'comments',
      'thread-1',
    )}`;
    const message = {
      body: {
        attachments: [
          {
            type: 'inline_keyboard',
            payload: {
              buttons: [
                [{ type: 'link', text: 'Комментарии', url: commentsUrl }],
                [{ type: 'link', text: 'Дубль', url: commentsUrl }],
                [
                  {
                    type: 'link',
                    text: 'Другой канал',
                    url: `https://max.ru/bot-1?startapp=${buildStartParam(
                      'channel-2',
                      'comments',
                      'thread-2',
                    )}`,
                  },
                ],
              ],
            },
          },
        ],
      },
    };

    expect(readInternalChannelDialogButtonIdentitiesFromMessage(message, 'channel-1')).toEqual([
      { chatId: 'channel-1', kind: 'comments', threadId: 'thread-1' },
    ]);
  });
});
