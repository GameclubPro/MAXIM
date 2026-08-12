import type { MaxUpdate } from '@maxim/contracts';

import type { RuleViolation } from '../rule-engine.contract';
import { extractLogicalPhotoAlbumResult } from '../photo-duplicate/photo-attachment-extractor';

export type CommercialOcrEnqueueCandidate = Readonly<{
  webhookEventId: string;
  chatId: string;
  messageId: string;
  sourceCreatedAt: string;
  imageCount: number;
}>;

export function resolveCommercialOcrEnqueueCandidate(params: {
  update: MaxUpdate;
  webhookEventId?: string;
  updateType: string | null;
  commercialAdsFilterEnabled: boolean;
  hasPhotoAttachment: boolean;
  chatId: string;
  messageId?: string;
  sourceCreatedAt: string;
}): CommercialOcrEnqueueCandidate | null {
  if (
    !params.webhookEventId ||
    !params.messageId ||
    params.updateType !== 'message_created' ||
    !params.commercialAdsFilterEnabled ||
    !params.hasPhotoAttachment
  ) {
    return null;
  }

  const result = extractLogicalPhotoAlbumResult(params.update);
  if (
    result.kind !== 'complete' ||
    result.album.chatId !== params.chatId ||
    result.album.messageId !== params.messageId
  ) {
    return null;
  }

  return {
    webhookEventId: params.webhookEventId,
    chatId: params.chatId,
    messageId: params.messageId,
    sourceCreatedAt: params.sourceCreatedAt,
    imageCount: result.album.images.length,
  };
}

export function hasActionableCompetingViolation(
  violations: readonly RuleViolation[],
): boolean {
  return violations.some((violation) => {
    if (violation.ruleCode !== 'COMMERCIAL_AD') {
      return true;
    }
    const actionBand =
      typeof violation.metadata?.actionBand === 'string' ? violation.metadata.actionBand : null;
    const actionable =
      typeof violation.metadata?.actionable === 'boolean'
        ? violation.metadata.actionable
        : actionBand !== null && actionBand !== 'ALLOW' && actionBand !== 'REVIEW_ONLY';
    return (
      actionable &&
      (actionBand === 'WARN' || actionBand === 'DELETE' || actionBand === 'DELETE_AND_ESCALATE')
    );
  });
}
