import type { CommercialCampaignContext } from '../commercial-campaign.util';
import type { CommercialThresholdProfile } from '../rule-engine-commercial-thresholds';
import {
  hasStrongCommercialCampaignEvidence,
  resolveCommercialEvidenceProfile,
  resolveCommercialSignalEvidence,
} from './commercial-evidence';
import type { CommercialSignalState } from './commercial.types';

const BASE_STATE: CommercialSignalState = {
  score: 0,
  matchedSignals: [],
  negativeSignals: [],
  hasIntent: false,
  hasServiceOfferContext: false,
  hasServiceSpecialtyContext: false,
  hasPrice: false,
  hasContact: false,
  hasPhoneContact: false,
  hasDealChannel: false,
  hasTransactional: false,
  hasDealSignal: false,
  hasPromoContext: false,
  hasBusinessContext: false,
  hasBuyoutContext: false,
  hasRecruitmentContext: false,
  hasInfoProductContext: false,
  hasGroupPromotionIntent: false,
  hasGroupPromoContext: false,
  hasCommercialAudienceContext: false,
  hasChannelPlacementContext: false,
  hasSearchRequestContext: false,
  hasJobSeekingContext: false,
  hasServiceContext: false,
  hasCallToActionContext: false,
  hasCommercialContext: false,
  hasCampaignContext: false,
  hasPrivateSaleContext: false,
  hasPropertyPrivateContext: false,
  hasPropertyAgentContext: false,
  hasCommercialPropertyContext: false,
  hasGoodsRetailContext: false,
  hasPrivateGoodsItemContext: false,
  hasStrongNegativeContext: false,
};

const STRICT_THRESHOLDS: CommercialThresholdProfile = {
  warnThreshold: 38,
  deleteThreshold: 55,
  sensitivity: 'STRICT',
  strictness: 0.7,
};

const LOOSE_BALANCED_THRESHOLDS: CommercialThresholdProfile = {
  warnThreshold: 60,
  deleteThreshold: 82,
  sensitivity: 'BALANCED',
  strictness: 0.1,
};

const BASE_CAMPAIGN_CONTEXT: CommercialCampaignContext = {
  senderDistinctChatCount: 1,
  sameTextDistinctChatCount: 1,
  repeatedPhoneDistinctChatCount: 0,
  repeatedLinkDistinctChatCount: 0,
  nearTextDistinctChatCount: 1,
  repeatedDomainDistinctChatCount: 0,
  repeatedHandleDistinctChatCount: 0,
  senderDistinctChatCount5m: 1,
  senderDistinctChatCount30m: 1,
  senderDistinctChatCount120m: 1,
};

function buildState(overrides: Partial<CommercialSignalState>): CommercialSignalState {
  return {
    ...BASE_STATE,
    ...overrides,
    matchedSignals: [...(overrides.matchedSignals ?? [])],
    negativeSignals: [...(overrides.negativeSignals ?? [])],
  };
}

describe('commercial evidence profile', () => {
  it.each([
    {
      label: 'weak private-message contact',
      signals: ['contact:в личк'],
      expected: {
        hasNonCampaignDirectDealEvidence: false,
        hasActionDirectDealEvidence: false,
        hasStrongContactEvidence: false,
      },
    },
    {
      label: 'phone alone',
      signals: ['contact:phone'],
      expected: {
        hasNonCampaignDirectDealEvidence: true,
        hasActionDirectDealEvidence: false,
        hasStrongContactEvidence: true,
      },
    },
    {
      label: 'price and phone',
      signals: ['transaction:price', 'contact:phone'],
      expected: {
        hasPriceEvidence: true,
        hasNonCampaignDirectDealEvidence: true,
        hasActionDirectDealEvidence: true,
      },
    },
    {
      label: 'link and handle',
      signals: ['deal-channel:link', 'contact:handle'],
      expected: {
        hasLinkEvidence: true,
        hasStrongContactEvidence: true,
        hasActionDirectDealEvidence: true,
      },
    },
    {
      label: 'high risk alone',
      signals: ['risk:loan-leadgen'],
      expected: {
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: true,
        hasNonCampaignDirectDealEvidence: false,
        hasActionDirectDealEvidence: false,
      },
    },
    {
      label: 'non-escalation structured job risk',
      signals: ['risk:structured-job-vacancy'],
      expected: {
        hasHighRiskEvidence: true,
        hasEscalationRiskEvidence: false,
        hasNonCampaignDirectDealEvidence: false,
        hasActionDirectDealEvidence: false,
      },
    },
    {
      label: 'high risk with weak contact',
      signals: ['risk:loan-leadgen', 'contact:в личк'],
      expected: {
        hasHighRiskEvidence: true,
        hasStrongContactEvidence: false,
        hasActionDirectDealEvidence: false,
      },
    },
    {
      label: 'high risk with strong handle',
      signals: ['risk:loan-leadgen', 'contact:handle'],
      expected: {
        hasHighRiskEvidence: true,
        hasStrongContactEvidence: true,
        hasActionDirectDealEvidence: true,
      },
    },
    {
      label: 'campaign marker only',
      signals: ['campaign:repeated-text'],
      expected: {
        hasNonCampaignDirectDealEvidence: false,
        hasActionDirectDealEvidence: false,
      },
    },
  ])('resolves signal evidence for $label', ({ signals, expected }) => {
    expect(resolveCommercialSignalEvidence(signals)).toMatchObject(expected);
  });

  it('keeps classifier-direct evidence distinct from action-direct evidence', () => {
    const evidence = resolveCommercialEvidenceProfile({
      state: buildState({
        hasPrice: true,
        hasTransactional: true,
        matchedSignals: ['transaction:price', 'transaction:keywords'],
      }),
      appliedThresholds: STRICT_THRESHOLDS,
    });

    expect(evidence.hasClassifierDirectDealEvidence).toBe(true);
    expect(evidence.hasActionDirectDealEvidence).toBe(false);
    expect(evidence.hasNonCampaignDirectDealEvidence).toBe(true);
  });

  it('recognizes balanced service-phone anchors without loosening generic service phones', () => {
    const anchored = resolveCommercialEvidenceProfile({
      state: buildState({
        hasServiceContext: true,
        hasPhoneContact: true,
        hasContact: true,
        matchedSignals: ['service-specialty:appliance-repair', 'contact:phone'],
      }),
      appliedThresholds: LOOSE_BALANCED_THRESHOLDS,
    });
    const generic = resolveCommercialEvidenceProfile({
      state: buildState({
        hasServiceContext: true,
        hasPhoneContact: true,
        hasContact: true,
        matchedSignals: ['contact:phone'],
      }),
      appliedThresholds: LOOSE_BALANCED_THRESHOLDS,
    });

    expect(anchored.hasStructuredServicePhoneEvidence).toBe(true);
    expect(generic.hasStructuredServicePhoneEvidence).toBe(false);
  });

  it('treats structured retail transactional evidence as strong commercial evidence', () => {
    const evidence = resolveCommercialEvidenceProfile({
      state: buildState({
        hasGoodsRetailContext: true,
        hasTransactional: true,
        matchedSignals: ['goods-retail:clearance-stock-retail', 'transaction:keywords'],
      }),
      appliedThresholds: STRICT_THRESHOLDS,
    });

    expect(evidence.hasStructuredRetailTransactionalEvidence).toBe(true);
    expect(evidence.hasStrongCommercialEvidence).toBe(true);
    expect(evidence.hasStructuredCommercialContext).toBe(true);
  });

  it('keeps private-sale suppression unless a commercial override is present', () => {
    const privateOnly = resolveCommercialEvidenceProfile({
      state: buildState({
        hasPrivateSaleContext: true,
        hasPrice: true,
        matchedSignals: ['transaction:price'],
      }),
      appliedThresholds: STRICT_THRESHOLDS,
    });
    const commercialRetail = resolveCommercialEvidenceProfile({
      state: buildState({
        hasPrivateSaleContext: true,
        hasGoodsRetailContext: true,
        hasPrice: true,
        matchedSignals: ['goods-retail:clearance-stock-retail', 'transaction:price'],
      }),
      appliedThresholds: STRICT_THRESHOLDS,
    });

    expect(privateOnly.hasPrivateSaleCommercialOverride).toBe(false);
    expect(commercialRetail.hasPrivateSaleCommercialOverride).toBe(true);
  });

  it('requires a deal anchor for repeated campaign text to become strong evidence', () => {
    const repeatedTextContext = {
      ...BASE_CAMPAIGN_CONTEXT,
      sameTextDistinctChatCount: 99,
      nearTextDistinctChatCount: 99,
    };

    expect(
      hasStrongCommercialCampaignEvidence(
        repeatedTextContext,
        buildState({ hasCampaignContext: true }),
      ),
    ).toBe(false);
    expect(
      hasStrongCommercialCampaignEvidence(
        repeatedTextContext,
        buildState({
          hasCampaignContext: true,
          hasContact: true,
          matchedSignals: ['contact:phone'],
        }),
      ),
    ).toBe(true);
  });
});
