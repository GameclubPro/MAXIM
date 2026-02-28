import { WebhookParser } from './webhook.parser';

describe('WebhookParser', () => {
  const parser = new WebhookParser();

  it('extracts chatTitle from recipient.title', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-1',
        chat_id: 'chat-1',
        sender_id: 'user-1',
        text: 'hello',
        created_at: '2026-02-28T05:00:00.000Z',
        recipient: {
          title: 'My Chat Title',
        },
      },
    });

    expect(parsed.message?.chatTitle).toBe('My Chat Title');
  });

  it('extracts chatTitle from chat_title', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-2',
        chat_id: 'chat-2',
        sender_id: 'user-2',
        text: 'hello',
        created_at: '2026-02-28T05:00:00.000Z',
        chat_title: 'Another Chat',
      },
    });

    expect(parsed.message?.chatTitle).toBe('Another Chat');
  });

  it('extracts senderName from sender profile fields', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-name-1',
        chat_id: 'chat-name-1',
        sender: {
          user_id: 'user-name-1',
          first_name: 'Иван',
          last_name: 'Петров',
        },
        text: 'hello',
        created_at: '2026-02-28T05:00:00.000Z',
      },
    });

    expect(parsed.message?.senderName).toBe('Иван Петров');
  });

  it('extracts text from nested body.text when message.text is missing', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-3',
        chat_id: 'chat-3',
        sender_id: 'user-3',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'смотри ссылку https://example.com/abc',
        },
      },
    });

    expect(parsed.message?.text).toContain('https://example.com/abc');
  });

  it('adds urls from forwarded payload when outer text has no links', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4a',
        chat_id: 'chat-4a',
        sender_id: 'user-4a',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'пересланное сообщение',
          forwarded_message: {
            body: {
              text: 'источник: https://spam-forwarded.example/path',
            },
          },
        },
      },
    });

    expect(parsed.message?.text).toContain('пересланное сообщение');
    expect(parsed.message?.text).toContain('https://spam-forwarded.example/path');
  });

  it('does not append service urls from forwarded metadata when forwarded text has no links', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4a-meta',
        chat_id: 'chat-4a-meta',
        sender_id: 'user-4a-meta',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'пересланное сообщение',
          forwarded_message: {
            source: {
              message_url: 'https://max.ru/chats/source/message/123',
            },
          },
        },
      },
    });

    expect(parsed.message?.text).toBe('пересланное сообщение');
    expect(parsed.message?.text).not.toContain('https://max.ru/chats/source/message/123');
  });

  it('does not duplicate urls already present in direct text', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4b',
        chat_id: 'chat-4b',
        sender_id: 'user-4b',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'ссылка https://dup.example/path',
          forwarded_message: {
            body: {
              text: 'https://dup.example/path',
            },
          },
        },
      },
    });

    const matches = parsed.message?.text.match(/https?:\/\/dup\.example\/path/gi) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('extracts urls from MAX message.link payload', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4c',
        chat_id: 'chat-4c',
        sender_id: 'user-4c',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'переслано',
        },
        link: {
          body: {
            text: 'оригинал: https://forward-link.example/news',
          },
        },
      },
    });

    expect(parsed.message?.text).toContain('https://forward-link.example/news');
  });

  it('extracts url from nested structures when plain text is missing', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4',
        chat_id: 'chat-4',
        sender_id: 'user-4',
        created_at: '2026-02-28T05:00:00.000Z',
        attachments: [
          {
            type: 'link',
            data: {
              url: 'https://bad.com/path',
            },
          },
        ],
      },
    });

    expect(parsed.message?.text).toContain('https://bad.com/path');
  });

  it('parses message from message_created.message envelope and fills ids', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      timestamp: '2026-02-28T05:10:00.000Z',
      message_created: {
        message: {
          id: 'msg-5',
          sender: { id: 'user-5' },
          recipient: {
            chat_id: '-71527248136199',
            title: 'MAXIM Test Chat',
          },
          body: {
            text: 'check https://example.org',
          },
        },
      },
    });

    expect(parsed.type).toBe('message_created');
    expect(parsed.message?.messageId).toBe('msg-5');
    expect(parsed.message?.chatId).toBe('-71527248136199');
    expect(parsed.message?.senderId).toBe('user-5');
    expect(parsed.message?.chatTitle).toBe('MAXIM Test Chat');
    expect(parsed.message?.text).toContain('https://example.org');
  });

  it('parses message from message_created object when nested message key is absent', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message_created: {
        message_id: 'msg-6',
        chat: {
          id: 'chat-6',
          title: 'Envelope Chat',
        },
        from: {
          id: 'user-6',
        },
        content: {
          text: 'hello from envelope',
        },
        created_at: '2026-02-28T05:11:00.000Z',
      },
    });

    expect(parsed.message?.messageId).toBe('msg-6');
    expect(parsed.message?.chatId).toBe('chat-6');
    expect(parsed.message?.senderId).toBe('user-6');
    expect(parsed.message?.chatTitle).toBe('Envelope Chat');
    expect(parsed.message?.text).toBe('hello from envelope');
  });

  it('parses MAX payload with body.mid and numeric sender/chat ids', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      timestamp: 1772249118580,
      message: {
        body: {
          mid: 'mid.ffffbef220e477f9019ca24777741421',
          seq: 116146118235264030,
          text: 'Gffc https://web.telegram.org/',
          markup: [
            {
              url: 'https://web.telegram.org/',
              type: 'link',
            },
          ],
        },
        sender: {
          user_id: 195714583,
        },
        recipient: {
          chat_id: -71527833503751,
          chat_type: 'chat',
        },
        timestamp: 1772249118580,
      },
    });

    expect(parsed.message?.messageId).toBe('mid.ffffbef220e477f9019ca24777741421');
    expect(parsed.message?.chatId).toBe('-71527833503751');
    expect(parsed.message?.senderId).toBe('195714583');
    expect(parsed.message?.text).toContain('https://web.telegram.org/');
  });
});
