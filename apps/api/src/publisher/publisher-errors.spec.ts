import { PublisherSetupRequiredException } from './publisher-errors';

describe('Publisher setup errors', () => {
  it.each([
    'policy_disabled',
    'module_disabled',
    'bot_not_connected',
    'bot_not_admin',
    'write_permission_missing',
    'bot_access_unconfirmed',
    'bot_access_expired',
    'route_quarantined',
    'publisher_runtime_unavailable',
    'unknown',
    '__proto__',
  ])(
    'returns a public Russian explanation for %s without changing the error contract',
    (blockerCode) => {
      const error = new PublisherSetupRequiredException(['chat-1'], blockerCode);
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({
        code: 'PUBLISHER_SETUP_REQUIRED',
        blockerCode,
        chatIds: ['chat-1'],
        message: expect.stringMatching(/[А-Яа-яЁё]/u),
      });
    },
  );
});
