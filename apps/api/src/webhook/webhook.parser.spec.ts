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
});
