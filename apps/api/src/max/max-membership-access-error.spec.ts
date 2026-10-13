import { resolveExplicitMembershipAccessDenial } from './max-membership-access-error';

describe('membership endpoint access evidence', () => {
  it.each([403, 404, 429, 503])('does not revoke the bot on an opaque HTTP %s', (status) => {
    expect(resolveExplicitMembershipAccessDenial({ response: { status } })).toBeNull();
  });
  it.each(['user.not.found', 'member.not.found', 'message.not.found'])(
    'does not turn %s into loss of chat rights',
    (code) => {
      expect(
        resolveExplicitMembershipAccessDenial({ response: { status: 404, data: { code } } }),
      ).toBeNull();
    },
  );
  it.each(['chat.denied', 'access.denied', 'chat.not.found'])(
    'retains explicit MAX refusal %s',
    (code) => {
      expect(
        resolveExplicitMembershipAccessDenial({ response: { status: 403, data: { code } } }),
      ).toBe(code);
    },
  );
});
