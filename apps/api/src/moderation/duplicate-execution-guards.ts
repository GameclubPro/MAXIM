import {
  hasPersistedTerminalDuplicateSanction,
  type TerminalDuplicateSanctionEventModel,
} from './moderation-message-action-claim';

export function createDuplicateMemberMutationGuard(
  lease: { assertOwned(): Promise<void> } | undefined,
  beforeMutation: (() => Promise<void>) | undefined,
): (() => Promise<void>) | undefined {
  if (!beforeMutation) return lease ? () => lease.assertOwned() : undefined;
  return async () => {
    await lease?.assertOwned();
    await beforeMutation();
    await lease?.assertOwned();
  };
}

export function createDuplicateDeleteAuthorizationGuard(params: {
  assertActiveLease?: () => void;
  authorizeDelete?: () => Promise<boolean>;
}): {
  beforeImmediateDeleteMutation?: () => Promise<void>;
  wasRejected: () => boolean;
  verificationFailed: () => boolean;
} {
  let rejected = false;
  let failed = false;
  if (!params.assertActiveLease && !params.authorizeDelete) {
    return { wasRejected: () => false, verificationFailed: () => false };
  }
  return {
    beforeImmediateDeleteMutation: async () => {
      params.assertActiveLease?.();
      if (params.authorizeDelete) {
        // FLAG: An unavailable guard is unfinished work, never a confirmed policy rejection.
        rejected = false;
        failed = true;
        const allowed = await params.authorizeDelete();
        failed = false;
        if (!allowed) {
          rejected = true;
          throw new Error('Duplicate delete authorization was revoked');
        }
      }
      params.assertActiveLease?.();
    },
    wasRejected: () => rejected,
    verificationFailed: () => failed,
  };
}

export function createDuplicateSanctionAuthorization(params: {
  model: TerminalDuplicateSanctionEventModel;
  chatId: string;
  userId: string;
  messageId: string;
  authorizeSanction?: () => Promise<boolean>;
}): {
  authorize: () => Promise<boolean>;
  wasRejected: () => boolean;
} {
  let rejected = false;
  return {
    authorize: async () => {
      rejected = true;
      if (
        (await hasPersistedTerminalDuplicateSanction(params)) ||
        (params.authorizeSanction && !(await params.authorizeSanction()))
      ) {
        return false;
      }
      rejected = false;
      return true;
    },
    wasRejected: () => rejected,
  };
}
