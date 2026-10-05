import { buildMaxActionIdempotencyKey } from './max-action-idempotency';

describe('retained MAX action identity compatibility', () => {
  // FLAG: These identities were captured from the pre-extraction dispatcher. Existing
  // SQL journals and BullMQ jobs must retain their exact key across a compatible release.
  it.each([
    {
      namespace: 'explicit',
      parts: ['SEND_MESSAGE', 'mrf-v1-source:sanction-notice'],
      expected:
        'max-action__explicit__send_message__mrf-v1-source_sanction-notice___eBZB820hJg3ysSxUjeZEnu8',
    },
    {
      namespace: 'explicit',
      parts: ['BAN_MEMBER', 'mrf-v1-source:sanction-ban'],
      expected:
        'max-action__explicit__ban_member__mrf-v1-source_sanction-ban__7e-8NrJaSASrA39r3YzXxMWj',
    },
    {
      namespace: 'explicit',
      parts: ['surviving-peer', 'SEND_MESSAGE', 'chat:Исходное сообщение/42'],
      expected:
        'max-action__explicit__surviving-peer__send_message__chat_42__xRBM34o1VDIz4NldJJDOJuzp',
    },
    {
      namespace: 'logical',
      parts: ['DELETE_MESSAGE', '-100-chat-1', 'message:original'],
      expected:
        'max-action__logical__delete_message__-100-chat-1__message_original__dW5Uu5CORuOPjCtUQ8cwqALq',
    },
  ])('preserves $namespace $parts', ({ namespace, parts, expected }) => {
    expect(buildMaxActionIdempotencyKey(namespace, parts)).toBe(expected);
  });
});
