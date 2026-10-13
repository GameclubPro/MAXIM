import { PublisherSetupRequiredException } from './publisher-errors';

const PERSISTENT_BLOCKERS = new Set([
  'policy_disabled',
  'module_disabled',
  'bot_not_connected',
  'bot_not_admin',
  'write_permission_missing',
]);

export class PublisherCommentSetupBlockedError extends PublisherSetupRequiredException {}

// FLAG: Wrap only the readiness call before the guarded mutation. A transport error,
// an earlier recipient's receipt, or a lost edit/send claim is never no-effect proof.
export async function checkPublisherCommentReadiness<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (error: unknown) {
    if (
      error instanceof PublisherSetupRequiredException &&
      PERSISTENT_BLOCKERS.has(error.blockerCode)
    ) {
      throw new PublisherCommentSetupBlockedError(error.chatIds, error.blockerCode);
    }
    throw error;
  }
}
