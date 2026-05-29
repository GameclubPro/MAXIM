import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';

export type CommercialCampaignStrength = 'NONE' | 'WEAK' | 'STANDARD' | 'STRONG';

export function resolveCommercialCampaignStrength(
  context: CommercialCampaignContext | null | undefined,
): CommercialCampaignStrength {
  if (!context) {
    return 'NONE';
  }
  const { strong, standard } = COMMERCIAL_ENGINE_CONFIG.campaignStrength;
  if (
    context.sameTextDistinctChatCount >= strong.sameTextDistinctChatCount ||
    context.repeatedPhoneDistinctChatCount >= strong.repeatedPhoneDistinctChatCount ||
    context.repeatedLinkDistinctChatCount >= strong.repeatedLinkDistinctChatCount ||
    context.senderDistinctChatCount >= strong.senderDistinctChatCount
  ) {
    return 'STRONG';
  }
  if (
    context.sameTextDistinctChatCount >= standard.sameTextDistinctChatCount ||
    context.repeatedPhoneDistinctChatCount >= standard.repeatedPhoneDistinctChatCount ||
    context.repeatedLinkDistinctChatCount >= standard.repeatedLinkDistinctChatCount ||
    context.senderDistinctChatCount >= standard.senderDistinctChatCount
  ) {
    return 'STANDARD';
  }
  return 'WEAK';
}
