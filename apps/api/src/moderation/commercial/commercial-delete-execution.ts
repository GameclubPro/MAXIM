import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import type {
  ModerationDeleteExecutionResult,
  ProfanityDeleteMutationHooks,
} from '../profanity/profanity-delete-execution';
import { COMMERCIAL_TEXT_DELETE_RULE_CODE } from './commercial-delete-binding';
import {
  CommercialDeleteGuardRejectedError,
  type CommercialDeleteGuardService,
} from './commercial-delete-guard.service';

class CommercialMessageAbsentError extends Error {}

export async function executeCommercialGuardedLegacyDelete(params: {
  input: EnsureModerationDeleteIntentInput;
  scheduled?: boolean;
  guard?: Pick<CommercialDeleteGuardService, 'assertMessageStillActionable'>;
  execute(hooks?: ProfanityDeleteMutationHooks): Promise<ModerationDeleteExecutionResult>;
}): Promise<ModerationDeleteExecutionResult> {
  if (params.input.ruleCode !== COMMERCIAL_TEXT_DELETE_RULE_CODE) return params.execute();
  if (!params.guard) throw new Error('Commercial delete guard is unavailable');
  // FLAG: Transport callbacks cannot be serialized into a delayed legacy action job.
  if (
    params.scheduled ||
    (params.input.executeAt && new Date(params.input.executeAt).getTime() > Date.now())
  )
    throw new Error('Scheduled commercial deletion requires the durable guarded executor');
  let verified = false;
  try {
    const result = await params.execute({
      // FLAG: A route retry must regain its own proof at the final transport boundary.
      beforeAttempt: () => {
        verified = false;
      },
      beforeDeleteMutation: async (botId) => {
        verified = false;
        const verdict = await params.guard!.assertMessageStillActionable({
          chatId: params.input.chatId,
          messageId: params.input.messageId,
          subjectUserId: params.input.subjectUserId ?? null,
          botId,
          evidence: [
            {
              reasonKey: params.input.reasonKey,
              score: params.input.event?.score ?? 0,
              metadata: params.input.event?.metadata,
            },
          ],
        });
        if (verdict === 'absent') throw new CommercialMessageAbsentError();
        verified = verdict === 'allowed';
      },
    });
    return result.deleted && verified ? { ...result, commercialVerified: true } : result;
  } catch (error) {
    if (
      !(error instanceof CommercialDeleteGuardRejectedError) &&
      !(error instanceof CommercialMessageAbsentError)
    )
      throw error;
    return {
      accepted: error instanceof CommercialMessageAbsentError,
      gone: error instanceof CommercialMessageAbsentError,
      deleted: false,
      eventPersistedByIntent: false,
      botId: null,
    };
  }
}
