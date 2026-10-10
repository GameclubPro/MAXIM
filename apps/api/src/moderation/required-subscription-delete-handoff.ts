import type { EnsureModerationDeleteIntentResult } from './moderation-delete-intent.types';
import {
  RequiredSubscriptionDeleteSourceUnavailableError,
  RequiredSubscriptionExecutionRejectedError,
  RequiredSubscriptionMembershipUnavailableError,
} from './required-subscription-execution-guard.service';

export async function handoffRequiredSubscriptionDelete(options: {
  assertAuthority: () => Promise<void>;
  assertLeaseOwned: () => Promise<void>;
  persist?: () => Promise<EnsureModerationDeleteIntentResult>;
}): Promise<boolean> {
  // FLAG: Prior notice/coverage does not retain DELETE authority. Only a committed
  // executable intent can own a read outage; never replay the notice or infer deletion.
  let unavailable: unknown;
  try {
    await options.assertAuthority();
  } catch (error: unknown) {
    if (error instanceof RequiredSubscriptionExecutionRejectedError) return true;
    if (
      !(error instanceof RequiredSubscriptionMembershipUnavailableError) &&
      !(error instanceof RequiredSubscriptionDeleteSourceUnavailableError)
    )
      throw error;
    unavailable = error;
  }
  await options.assertLeaseOwned();
  if (options.persist) {
    // FLAG: Final reads and retry failures belong to the durable worker, including
    // after successful initial authority. Inline execution would fence the started
    // webhook again after its non-replayable notice/sanction. Preserve the deadline.
    const handoff = await options.persist();
    if (
      handoff.rollout === 'execute' &&
      handoff.intentId &&
      handoff.status !== null &&
      handoff.status !== 'OBSERVED' &&
      handoff.status !== 'AMBIGUOUS'
    )
      return true;
    throw unavailable ?? new Error('Required subscription DELETE handoff is not executable');
  }
  if (unavailable) throw unavailable;
  return false;
}
