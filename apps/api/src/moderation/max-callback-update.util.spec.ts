import type { MaxUpdate } from '@maxim/contracts';
import {
  extractMaxCallbackId,
  extractMaxCallbackPayload,
  extractMaxCallbackPayloadRaw,
  extractMaxCallbackUserId,
} from './max-callback-update.util';

describe('MAX callback update extraction', () => {
  it('reads a nested callback without changing the raw payload case', () => {
    const update = {
      updateId: 'update-1',
      type: 'message_callback',
      message: {
        messageId: 'message-1',
        chatId: 'chat-1',
        senderId: 'bot-1',
        text: '',
        createdAt: new Date().toISOString(),
      },
      raw: {
        data: {
          message_callback: {
            callback: {
              callback_id: 42,
              payload: 'Case_Sensitive-Payload',
              user: { user_id: 195714583 },
            },
          },
        },
      },
    } satisfies MaxUpdate;

    expect(extractMaxCallbackId(update)).toBe('42');
    expect(extractMaxCallbackPayloadRaw(update)).toBe('Case_Sensitive-Payload');
    expect(extractMaxCallbackPayload(update)).toBe('case_sensitive-payload');
    expect(extractMaxCallbackUserId(update)).toBe('195714583');
  });
});
