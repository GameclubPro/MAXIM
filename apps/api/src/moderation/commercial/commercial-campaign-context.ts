import {
  COMMERCIAL_CAMPAIGN_WINDOW_SEC,
  COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC,
  buildCommercialCampaignFingerprint,
  buildCommercialCampaignDomainChatsKey,
  buildCommercialCampaignHandleChatsKey,
  buildCommercialCampaignLinkChatsKey,
  buildCommercialCampaignPhoneChatsKey,
  buildCommercialCampaignSenderChatsKey,
  buildCommercialCampaignSenderNearTextChatsKey,
  buildCommercialCampaignSenderTextChatsKey,
  buildCommercialCampaignSenderVelocityChatsKey,
  hasCommercialCampaignEvidence,
  normalizeCommercialCampaignSenderId,
  type CommercialCampaignContext,
} from '../commercial-campaign.util';
import type { RedisCounterService } from '../redis-counter.service';
import { buildCommercialCampaignSlidingSenderVelocityChatsKey } from './commercial-campaign-sliding';

type CommercialCampaignContextInput = {
  chatId: string;
  senderId: string;
  text: string;
  eventTimestampMs?: number;
};

type CommercialCampaignContextDependencies = {
  redisCounter?: Pick<
    RedisCounterService,
    'addToSetWithTtl' | 'trackCommercialCampaignSlidingWindow'
  >;
  onLookupError: (error: unknown) => void;
};

export async function collectCommercialCampaignContextFromRedis(
  params: CommercialCampaignContextInput,
  dependencies: CommercialCampaignContextDependencies,
): Promise<CommercialCampaignContext | null> {
  const redisCounter = dependencies.redisCounter;
  if (!redisCounter) {
    return null;
  }

  const normalizedSenderId = normalizeCommercialCampaignSenderId(params.senderId);
  if (!normalizedSenderId) {
    return null;
  }

  const fingerprint = buildCommercialCampaignFingerprint(params.text);

  try {
    const [
      senderDistinctChatCount,
      senderDistinctChatCount5m,
      senderDistinctChatCount30m,
      senderDistinctChatCount120m,
      sameTextDistinctChatCount,
      nearTextDistinctChatCount,
      phoneChatCounts,
      linkChatCounts,
      domainChatCounts,
      handleChatCounts,
      slidingVelocityCounts,
    ] = await Promise.all([
      redisCounter
        .addToSetWithTtl(
          buildCommercialCampaignSenderChatsKey(normalizedSenderId),
          params.chatId,
          COMMERCIAL_CAMPAIGN_WINDOW_SEC,
        )
        .then((result) => result.size),
      redisCounter
        .addToSetWithTtl(
          buildCommercialCampaignSenderVelocityChatsKey(
            normalizedSenderId,
            COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[0],
          ),
          params.chatId,
          COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[0],
        )
        .then((result) => result.size),
      redisCounter
        .addToSetWithTtl(
          buildCommercialCampaignSenderVelocityChatsKey(
            normalizedSenderId,
            COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[1],
          ),
          params.chatId,
          COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[1],
        )
        .then((result) => result.size),
      redisCounter
        .addToSetWithTtl(
          buildCommercialCampaignSenderVelocityChatsKey(
            normalizedSenderId,
            COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[2],
          ),
          params.chatId,
          COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[2],
        )
        .then((result) => result.size),
      fingerprint.textHash
        ? redisCounter
            .addToSetWithTtl(
              buildCommercialCampaignSenderTextChatsKey(normalizedSenderId, fingerprint.textHash),
              params.chatId,
              COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            )
            .then((result) => result.size)
        : Promise.resolve(0),
      fingerprint.nearTextHash
        ? redisCounter
            .addToSetWithTtl(
              buildCommercialCampaignSenderNearTextChatsKey(
                normalizedSenderId,
                fingerprint.nearTextHash,
              ),
              params.chatId,
              COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            )
            .then((result) => result.size)
        : Promise.resolve(0),
      Promise.all(
        fingerprint.phones.map((phone) =>
          redisCounter
            .addToSetWithTtl(
              buildCommercialCampaignPhoneChatsKey(phone),
              params.chatId,
              COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            )
            .then((result) => result.size),
        ),
      ),
      Promise.all(
        fingerprint.links.map((link) =>
          redisCounter
            .addToSetWithTtl(
              buildCommercialCampaignLinkChatsKey(link),
              params.chatId,
              COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            )
            .then((result) => result.size),
        ),
      ),
      Promise.all(
        fingerprint.domains.map((domain) =>
          redisCounter
            .addToSetWithTtl(
              buildCommercialCampaignDomainChatsKey(domain),
              params.chatId,
              COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            )
            .then((result) => result.size),
        ),
      ),
      Promise.all(
        fingerprint.handles.map((handle) =>
          redisCounter
            .addToSetWithTtl(
              buildCommercialCampaignHandleChatsKey(handle),
              params.chatId,
              COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            )
            .then((result) => result.size),
        ),
      ),
      Promise.all(
        COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC.map((windowSeconds) =>
          params.eventTimestampMs === undefined
            ? Promise.resolve(0)
            : redisCounter
                .trackCommercialCampaignSlidingWindow({
                  key: buildCommercialCampaignSlidingSenderVelocityChatsKey(
                    normalizedSenderId,
                    windowSeconds,
                  ),
                  chatId: params.chatId,
                  eventTimestampMs: params.eventTimestampMs,
                  windowSeconds,
                })
                .then((result) => result.size),
        ),
      ),
    ]);

    const context: CommercialCampaignContext = {
      senderDistinctChatCount,
      sameTextDistinctChatCount,
      repeatedPhoneDistinctChatCount: Math.max(0, ...phoneChatCounts),
      repeatedLinkDistinctChatCount: Math.max(0, ...linkChatCounts),
      nearTextDistinctChatCount,
      repeatedDomainDistinctChatCount: Math.max(0, ...domainChatCounts),
      repeatedHandleDistinctChatCount: Math.max(0, ...handleChatCounts),
      senderDistinctChatCount5m,
      senderDistinctChatCount30m,
      senderDistinctChatCount120m,
      shadowSlidingSenderDistinctChatCount5m: slidingVelocityCounts[0] ?? 0,
      shadowSlidingSenderDistinctChatCount30m: slidingVelocityCounts[1] ?? 0,
      shadowSlidingSenderDistinctChatCount120m: slidingVelocityCounts[2] ?? 0,
    };

    const hasSlidingCampaignEvidence =
      (context.shadowSlidingSenderDistinctChatCount5m ?? 0) >= 3 ||
      (context.shadowSlidingSenderDistinctChatCount30m ?? 0) >= 4 ||
      (context.shadowSlidingSenderDistinctChatCount120m ?? 0) >= 5;
    return hasCommercialCampaignEvidence(context) || hasSlidingCampaignEvidence ? context : null;
  } catch (error) {
    dependencies.onLookupError(error);
    return null;
  }
}
