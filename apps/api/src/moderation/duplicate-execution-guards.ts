import {
  hasPersistedTerminalDuplicateSanction,
  type TerminalDuplicateSanctionEventModel,
} from './moderation-message-action-claim';
import type { ModerationDeletePreDispatchPhase } from './moderation-delete-intent.types';

export function createDuplicateMemberMutationGuard(
  lease: { assertOwned(): Promise<void> } | undefined,
  beforeMutation: ((beforeFinalAuthority?: () => Promise<void>) => Promise<void>) | undefined,
): ((beforeFinalAuthority?: () => Promise<void>) => Promise<void>) | undefined {
  if (!beforeMutation && !lease) return undefined;
  return async (beforeFinalAuthority) => {
    await lease?.assertOwned();
    const finalLeaseAndRoute = async () => {
      await lease?.assertOwned();
      await beforeFinalAuthority?.();
    };
    // FLAG: Route/lease reads finish inside authority, before its final settings,
    // Redis permit and synchronous deadline. No post-authority await extends that permit.
    if (beforeMutation) await beforeMutation(finalLeaseAndRoute);
    else await finalLeaseAndRoute();
  };
}

export function createDuplicateDeleteAuthorizationGuard(params: {
  assertActiveLease?: () => void;
  authorizeDelete?: (phase?: ModerationDeletePreDispatchPhase) => Promise<boolean>;
}): {
  beforeImmediateDeleteMutation?: (phase?: ModerationDeletePreDispatchPhase) => Promise<void>;
  wasRejected: () => boolean;
  verificationFailed: () => boolean;
} {
  let rejected = false;
  let failed = false;
  if (!params.assertActiveLease && !params.authorizeDelete) {
    return { wasRejected: () => false, verificationFailed: () => false };
  }
  return {
    beforeImmediateDeleteMutation: async (phase) => {
      params.assertActiveLease?.();
      if (params.authorizeDelete) {
        // FLAG: An unavailable guard is unfinished work, never a confirmed policy rejection.
        rejected = false;
        failed = true;
        const allowed = await params.authorizeDelete(phase);
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
