import type { MaxUpdate } from '@maxim/contracts';

import type { RuleViolation } from '../rule-engine.contract';
import { isCommercialMessageDeleteEligible } from '../commercial/commercial-action-policy';
import { extractLogicalPhotoAlbumResult } from '../photo-duplicate/photo-attachment-extractor';
import { extractCommercialOcrSourceCreatedAt } from './commercial-ocr-source-time';

export type CommercialOcrEnqueueCandidate = Readonly<{
  webhookEventId: string;
  chatId: string;
  messageId: string;
  sourceCreatedAt: string;
  eventTimestamp: string;
  imageCount: number;
  commercialScanRequested: boolean;
  imageTextScanRequested: boolean;
}>;

export function resolveCommercialOcrEnqueueCandidate(params: {
  update: MaxUpdate;
  webhookEventId?: string;
  updateType: string | null;
  commercialAdsFilterEnabled: boolean;
  imageTextScanEnabled?: boolean;
  hasImageTextStopList?: boolean;
  hasPhotoAttachment: boolean;
  chatId: string;
  messageId?: string;
  sourceCreatedAt: string;
}): CommercialOcrEnqueueCandidate | null {
  if (
    !params.webhookEventId ||
    !params.messageId ||
    params.updateType !== 'message_created' ||
    (!params.commercialAdsFilterEnabled &&
      !(params.imageTextScanEnabled === true && params.hasImageTextStopList === true)) ||
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

  const sourceCreatedAt = extractCommercialOcrSourceCreatedAt(params.update.raw);
  const eventTimestampMs = Date.parse(params.sourceCreatedAt);
  if (
    sourceCreatedAt === null ||
    !Number.isSafeInteger(eventTimestampMs) ||
    eventTimestampMs <= 0 ||
    result.album.createdAtMs !== eventTimestampMs
  ) {
    return null;
  }

  return {
    webhookEventId: params.webhookEventId,
    chatId: params.chatId,
    messageId: params.messageId,
    sourceCreatedAt,
    eventTimestamp: new Date(eventTimestampMs).toISOString(),
    imageCount: result.album.images.length,
    commercialScanRequested: params.commercialAdsFilterEnabled,
    imageTextScanRequested:
      params.imageTextScanEnabled === true && params.hasImageTextStopList === true,
  };
}

export function hasActionableCompetingViolation(violations: readonly RuleViolation[]): boolean {
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
    return isCommercialMessageDeleteEligible(
      actionBand,
      actionable,
      violation.metadata?.messageDisposition,
    );
  });
}
