import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  resolveMaxActionQueueName,
} from './max-action.queue';

describe('resolveMaxActionQueueName', () => {
  it.each([
    ['critical', MAX_ACTION_CRITICAL_QUEUE],
    ['interactive', MAX_ACTION_INTERACTIVE_QUEUE],
    ['background', MAX_ACTION_BACKGROUND_QUEUE],
  ] as const)('honors explicit %s traffic class', (trafficClass, expected) => {
    expect(
      resolveMaxActionQueueName({
        actionType: 'SEND_MESSAGE',
        trafficClass,
      }),
    ).toBe(expected);
  });

  it('routes ordinary sends to interactive by default', () => {
    expect(resolveMaxActionQueueName({ actionType: 'SEND_MESSAGE' })).toBe(
      MAX_ACTION_INTERACTIVE_QUEUE,
    );
  });

  it.each(['DELETE_MESSAGE', 'KICK_MEMBER', 'BAN_MEMBER', 'UNBAN_MEMBER', 'NOTIFY_MODERATORS'])(
    'routes %s to critical by default',
    (actionType) => {
      expect(resolveMaxActionQueueName({ actionType })).toBe(MAX_ACTION_CRITICAL_QUEUE);
    },
  );
});
