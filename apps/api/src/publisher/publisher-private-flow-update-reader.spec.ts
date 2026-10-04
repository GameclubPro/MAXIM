import type { MaxUpdate } from '@maxim/contracts';
import {
  readPublisherPrivateCallback,
  readPublisherPrivateStartPayload,
} from './publisher-private-flow-update-reader';

function update(type: string, raw: Record<string, unknown>): MaxUpdate {
  return { updateId: 'reader-test', botId: 'publisher', type, raw };
}

describe('Publisher private flow update reader boundaries', () => {
  it.each(['payload', 'start_payload', 'startPayload'])(
    'reads a declared nested start %s',
    (field) => {
      expect(
        readPublisherPrivateStartPayload(
          update('bot_started', { event: { bot_started: { [field]: ' pi_token ' } } }),
        ),
      ).toBe('pi_token');
    },
  );

  it('never discovers a start payload or callback inside arbitrary nested content', () => {
    const raw = {
      data: {
        attachment: {
          payload: 'ar_token',
          callback: { payload: 'ar:cancel:token', user: { user_id: 42 } },
        },
      },
    };
    expect(readPublisherPrivateStartPayload(update('bot_started', raw))).toBeNull();
    expect(readPublisherPrivateCallback(update('message_callback', raw))).toBeNull();
  });

  it('never combines one callback payload with another callback actor', () => {
    const callback = readPublisherPrivateCallback(
      update('message_callback', {
        callback: { payload: 'ar:cancel:first-token', callback_id: 'first-callback' },
        event: {
          callback: {
            payload: 'ar:cancel:second-token',
            callback_id: 'second-callback',
            user: { user_id: 42 },
          },
        },
      }),
    );
    expect(callback).toEqual({
      payload: 'ar:cancel:first-token',
      callbackId: 'first-callback',
      actorUserId: null,
    });
  });

  it('rejects oversized callback payloads and inappropriate event types', () => {
    const raw = { callback: { payload: 'x'.repeat(513), user: { user_id: 42 } } };
    expect(readPublisherPrivateCallback(update('message_callback', raw))).toBeNull();
    expect(readPublisherPrivateCallback(update('message_created', raw))).toBeNull();
    expect(
      readPublisherPrivateStartPayload(update('message_created', { payload: 'pi_token' })),
    ).toBeNull();
  });
});
