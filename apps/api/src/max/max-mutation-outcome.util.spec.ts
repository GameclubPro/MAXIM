import { classifyMaxTerminalChatActionError } from './managed-entity-access-loss.service';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
} from './max-member-error.util';
import {
  isMaxMutationOutcomeAmbiguous,
  markMaxMessageSendAttempted,
} from './max-mutation-outcome.util';

describe('mutation outcome certainty', () => {
  it.each([408, 500, 502, 503, 504])(
    'never treats HTTP %i access text as a definite rejection',
    (status) => {
      const error = Object.assign(new Error('not accessible: chat not found'), {
        response: { status, data: { code: 'chat.denied', message: 'not accessible' } },
      });
      expect(isMaxMutationOutcomeAmbiguous(error)).toBe(true);
      expect(classifyMaxTerminalChatActionError(error)).toBeNull();
    },
  );
  it.each([
    markMaxMemberMutationAttempted,
    markMaxMessageSendAttempted,
    markMaxMemberMutationConfirmed,
  ])('keeps attempted/confirmed transport outcomes fenced without HTTP evidence', (mark) => {
    const error = mark(new Error('not accessible'));
    expect(isMaxMutationOutcomeAmbiguous(error)).toBe(true);
    expect(classifyMaxTerminalChatActionError(error)).toBeNull();
  });
  it('allows only a definite 403 to invalidate access', () => {
    const error = markMaxMemberMutationAttempted(
      Object.assign(new Error('not accessible'), {
        response: { status: 403, data: { code: 'chat.denied' } },
      }),
    );
    expect(isMaxMutationOutcomeAmbiguous(error)).toBe(false);
    expect(classifyMaxTerminalChatActionError(error)?.kind).toBe('managed_entity_access_lost');
  });
});
