import { createHash } from 'node:crypto';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import type { CommercialDecisionBand, CommercialSubtype } from './rule-engine.service';
import type { CommercialThresholdProfile } from './rule-engine-commercial-thresholds';

export const COMMERCIAL_SECOND_STAGE_VERSION = '2026-service-private-v2';

export type CommercialSecondStageDecision = {
  adjustedConfidenceScore: number;
  primarySubtype: CommercialSubtype;
  supportingSubtypes: CommercialSubtype[];
  reviewRecommended: boolean;
  reviewReasons: string[];
  classifierVersion: string;
  commercialProbability: number;
  reviewProbability: number;
  classifierReasons: string[];
};

type CommercialSecondStageClassificationSnapshot = {
  primarySubtype: CommercialSubtype;
};

type CommercialSecondStageCacheKeyParams = {
  normalizedText: string;
  confidenceScore: number;
  decisionBand: CommercialDecisionBand;
  appliedThresholds: CommercialThresholdProfile;
  classification: CommercialSecondStageClassificationSnapshot;
  commercialCampaignContext?: CommercialCampaignContext | null;
};

export class CommercialSecondStageDecisionCache {
  private readonly decisions = new Map<string, CommercialSecondStageDecision>();

  constructor(private readonly maxEntries = 4096) {}

  buildKey(params: CommercialSecondStageCacheKeyParams): string {
    const {
      normalizedText,
      confidenceScore,
      decisionBand,
      appliedThresholds,
      classification,
      commercialCampaignContext,
    } = params;
    const textHash = createHash('sha1').update(normalizedText).digest('hex').slice(0, 16);
    return [
      COMMERCIAL_SECOND_STAGE_VERSION,
      textHash,
      classification.primarySubtype,
      decisionBand,
      Math.round(confidenceScore),
      appliedThresholds.warnThreshold,
      appliedThresholds.deleteThreshold,
      commercialCampaignContext?.sameTextDistinctChatCount ?? 0,
      commercialCampaignContext?.repeatedPhoneDistinctChatCount ?? 0,
      commercialCampaignContext?.repeatedLinkDistinctChatCount ?? 0,
      commercialCampaignContext?.senderDistinctChatCount ?? 0,
    ].join('|');
  }

  read(cacheKey: string): CommercialSecondStageDecision | null {
    const cached = this.decisions.get(cacheKey);
    if (!cached) {
      return null;
    }

    this.decisions.delete(cacheKey);
    this.decisions.set(cacheKey, cached);
    return cached;
  }

  remember(cacheKey: string, decision: CommercialSecondStageDecision): void {
    this.decisions.set(cacheKey, decision);
    if (this.decisions.size <= this.maxEntries) {
      return;
    }

    const oldestKey = this.decisions.keys().next().value;
    if (typeof oldestKey === 'string') {
      this.decisions.delete(oldestKey);
    }
  }

  get size(): number {
    return this.decisions.size;
  }
}
