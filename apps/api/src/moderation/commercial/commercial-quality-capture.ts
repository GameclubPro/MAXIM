import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import { COMMERCIAL_TEXT_DELETE_RULE_CODE } from './commercial-delete-binding';
import {
  buildCommercialReviewExecutionBinding,
  type Candidate,
  type CommercialReviewService,
} from './commercial-review.service';

type ReviewCapture = Pick<CommercialReviewService, 'recordCandidate' | 'recordExecution'>;

export async function prepareCommercialQualityDelete(
  review: ReviewCapture | undefined,
  observation: Candidate | null,
  intent: EnsureModerationDeleteIntentInput,
): Promise<EnsureModerationDeleteIntentInput> {
  if (
    !review ||
    !observation ||
    intent.ruleCode !== COMMERCIAL_TEXT_DELETE_RULE_CODE ||
    intent.chatId !== observation.chatId ||
    intent.messageId !== observation.messageId
  )
    return intent;
  const commercialReviewBinding = buildCommercialReviewExecutionBinding(observation);
  if (!commercialReviewBinding) return intent;
  // FLAG: Persist the frozen sample before any receipt can finalize; an asynchronous
  // capture alone could arrive after the successful DELETE and lose its attribution.
  await review.recordCandidate({ ...observation, executionOutcome: 'PENDING' });
  const metadata = intent.event?.metadata;
  return {
    ...intent,
    event: {
      ...intent.event,
      metadata: {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        commercialReviewBinding,
      },
    },
  };
}

export async function recordCommercialQualityExecution(
  review: ReviewCapture | undefined,
  observation: Candidate | null,
  result: { deleted: boolean; gone: boolean; commercialVerified?: boolean },
): Promise<void> {
  if (!review || !observation) return;
  const binding = buildCommercialReviewExecutionBinding(observation);
  if (!binding) return;
  // FLAG: Only a fresh commercial proof and confirmed DELETE establish filter execution.
  // Exact absence is a separate outcome; another reason's successful DELETE cannot supply proof.
  const executionOutcome =
    result.deleted && result.commercialVerified
      ? 'CONFIRMED_DELETE'
      : result.gone && !result.deleted
        ? 'ALREADY_ABSENT'
        : null;
  if (executionOutcome)
    await review.recordExecution({
      chatId: observation.chatId,
      messageId: observation.messageId,
      binding,
      executionOutcome,
    });
}
