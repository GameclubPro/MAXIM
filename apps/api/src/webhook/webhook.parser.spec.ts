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
});
