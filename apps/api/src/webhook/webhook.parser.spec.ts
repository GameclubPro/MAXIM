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

  it('extracts unicode-domain urls from nested body.text', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-3-unicode',
        chat_id: 'chat-3-unicode',
        sender_id: 'user-3-unicode',
        created_at: '2026-03-15T07:08:54.854Z',
        body: {
          text: 'вакансии https://центр-занятости-иркутск38.рф',
        },
      },
    });

    expect(parsed.message?.text).toContain('https://центр-занятости-иркутск38.рф');
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

  it('appends hidden urls from MAX message.link markup when only anchor text is visible', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4c-markup',
        chat_id: 'chat-4c-markup',
        sender_id: 'user-4c-markup',
        created_at: '2026-03-09T09:11:10.174Z',
        body: {
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            text: 'Приглашаю в группы бесплатных объявлений. Краснодар и край',
            markup: [
              {
                type: 'link',
                from: 42,
                length: 18,
                url: 'https://max.ru/join/hidden-anchor-link',
              },
            ],
          },
        },
      },
    });

    expect(parsed.message?.text).toContain('Приглашаю в группы бесплатных объявлений');
    expect(parsed.message?.text).toContain('https://max.ru/join/hidden-anchor-link');
  });

  it('appends hidden urls from body markup when visible text is stored outside direct body text', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4c-body-markup',
        chat_id: 'chat-4c-body-markup',
        sender_id: 'user-4c-body-markup',
        created_at: '2026-03-09T09:11:10.174Z',
        body: {
          text: '',
          markup: [
            {
              type: 'link',
              from: 91,
              length: 12,
              url: 'https://max.ru/join/xte75O0CZf_31UDr3PI1bqaRoWidHatl4yn3U2Rf8ZQ',
            },
          ],
          attachments: [
            {
              type: 'share',
              title: 'MAX',
              description:
                'MAX позволяет отправлять любые виды сообщений и звонить даже на слабых устройствах.',
              payload: {
                url: 'https://max.ru/join/xte75O0CZf_31UDr3PI1bqaRoWidHatl4yn3U2Rf8ZQ',
              },
            },
          ],
        },
      },
    });

    expect(parsed.message?.text).toContain(
      'https://max.ru/join/xte75O0CZf_31UDr3PI1bqaRoWidHatl4yn3U2Rf8ZQ',
    );
  });

  it('does not append reply quote text or buttons to the current message', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-reply-1',
        chat_id: 'chat-reply-1',
        sender_id: 'user-reply-1',
        created_at: '2026-03-27T07:59:59.886Z',
        body: {
          text: 'Здравствуйте, это первое объявление было сегодня!',
        },
        link: {
          type: 'reply',
          sender: {
            user_id: 'bot-1',
            name: 'Майор Максимов',
            is_bot: true,
          },
          message: {
            text: 'Товарищ Ольга, сообщение завернул. Причина: слишком частая отправка фото.',
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    [
                      {
                        type: 'link',
                        text: 'Правила',
                        url: 'https://max.ru/c/-71520449562631/AZ0U59k8egE',
                      },
                    ],
                  ],
                },
              },
            ],
          },
        },
      },
    });

    expect(parsed.message?.text).toBe('Здравствуйте, это первое объявление было сегодня!');
    expect(parsed.message?.text).not.toContain('Правила');
    expect(parsed.message?.text).not.toContain('https://max.ru/c/-71520449562631/AZ0U59k8egE');
    expect(parsed.message?.text).not.toContain('слишком частая отправка фото');
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

  it('keeps forwarded channel posts when MAX sends message id outside body', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      timestamp: 1772249118580,
      message: {
        id: 'mid-forward-channel-1',
        sender: {
          user_id: 195714583,
        },
        recipient: {
          chat_id: -71527833503751,
          chat_type: 'channel',
        },
        body: null,
        link: {
          type: 'forward',
          message: {
            text: 'Пересланный пост из другого канала',
          },
        },
      },
    });

    expect(parsed.message?.messageId).toBe('mid-forward-channel-1');
    expect(parsed.message?.chatId).toBe('-71527833503751');
    expect(parsed.message?.senderId).toBe('195714583');
    expect(parsed.message?.text).toContain('Пересланный пост из другого канала');
  });

  it('keeps service join message when sender id is missing', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        body: {
          mid: 'mid-service-join-1',
          new_members: [
            {
              user_id: 777,
              display_name: 'Новый участник',
            },
          ],
        },
        recipient: {
          chat_id: -123456789,
        },
        timestamp: 1772249118580,
      },
    });

    expect(parsed.message?.messageId).toBe('mid-service-join-1');
    expect(parsed.message?.chatId).toBe('-123456789');
    expect(parsed.message?.senderId).toBe('');
  });

  it('builds normalized message for user_added update without message payload', () => {
    const parsed = parser.parse({
      update_id: 'upd-user-added-1',
      update_type: 'user_added',
      chat_id: -123456789,
      user: {
        user_id: 888,
        first_name: 'Иван',
        last_name: 'Смирнов',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.type).toBe('user_added');
    expect(parsed.message?.messageId).toBe('user_added:upd-user-added-1');
    expect(parsed.message?.chatId).toBe('-123456789');
    expect(parsed.message?.senderId).toBe('888');
    expect(parsed.message?.senderName).toBe('Иван Смирнов');
  });

  it('builds normalized message for user_removed update without message payload', () => {
    const parsed = parser.parse({
      update_id: 'upd-user-removed-1',
      update_type: 'user_removed',
      chat_id: -123456789,
      user: {
        user_id: 889,
        first_name: 'Петр',
        last_name: 'Иванов',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.type).toBe('user_removed');
    expect(parsed.message?.messageId).toBe('user_removed:upd-user-removed-1');
    expect(parsed.message?.chatId).toBe('-123456789');
    expect(parsed.message?.senderId).toBe('889');
    expect(parsed.message?.senderName).toBe('Петр Иванов');
  });

  it('builds normalized message for bot_removed update without message payload', () => {
    const parsed = parser.parse({
      update_id: 'upd-bot-removed-1',
      update_type: 'bot_removed',
      chat_id: -123456789,
      user: {
        user_id: 890,
        first_name: 'Bot',
        last_name: 'Removed',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.type).toBe('bot_removed');
    expect(parsed.message?.messageId).toBe('bot_removed:upd-bot-removed-1');
    expect(parsed.message?.chatId).toBe('-123456789');
    expect(parsed.message?.senderId).toBe('890');
    expect(parsed.message?.senderName).toBe('Bot Removed');
  });

  it('builds normalized message for bot_started update without message payload', () => {
    const parsed = parser.parse({
      update_id: 'upd-bot-started-1',
      update_type: 'bot_started',
      chat_id: 152517912,
      user: {
        user_id: 100500,
        first_name: 'MAX',
        last_name: 'User',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.type).toBe('bot_started');
    expect(parsed.message?.messageId).toBe('bot_started:upd-bot-started-1');
    expect(parsed.message?.chatId).toBe('152517912');
    expect(parsed.message?.senderId).toBe('100500');
    expect(parsed.message?.senderName).toBe('MAX User');
  });
});
