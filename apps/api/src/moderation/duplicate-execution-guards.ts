import {
  hasPersistedTerminalDuplicateSanction,
  type TerminalDuplicateSanctionEventModel,
} from './moderation-message-action-claim';

export function createDuplicateDeleteAuthorizationGuard(params: {
  assertActiveLease?: () => void;
  authorizeDelete?: () => Promise<boolean>;
}): {
  beforeImmediateDeleteMutation?: () => Promise<void>;
  wasRejected: () => boolean;
} {
  let rejected = false;
  if (!params.assertActiveLease && !params.authorizeDelete) {
    return { wasRejected: () => false };
  }
  return {
    beforeImmediateDeleteMutation: async () => {
      params.assertActiveLease?.();
      if (params.authorizeDelete) {
        rejected = true;
        if (!(await params.authorizeDelete())) {
          throw new Error('Duplicate delete authorization was revoked');
        }
        rejected = false;
      }
      params.assertActiveLease?.();
    },
    wasRejected: () => rejected,
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
