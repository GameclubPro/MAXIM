import type { ChatSettings } from '../../prisma/prisma-client';
import {
  InMemoryCommercialCampaignTracker,
  type CommercialCampaignContext,
} from '../commercial-campaign.util';
import { CommercialAdDetector } from './commercial-ad.detector';
import {
  buildCommercialCampaignSlidingSenderVelocityChatsKey,
  COMMERCIAL_SLIDING_CAMPAIGN_COHORT,
  fingerprintCommercialCampaignSlidingMember,
  InMemoryCommercialCampaignSlidingWindow,
  resolveCommercialSlidingCampaignPolicyContext,
} from './commercial-campaign-sliding';

const START = Date.parse('2026-10-01T10:00:00.000Z');
const KEY = buildCommercialCampaignSlidingSenderVelocityChatsKey('user-1', 300);

function observation(chatId: string, seconds: number, nowSeconds = seconds) {
  return {
    key: KEY,
    chatId,
    eventTimestampMs: START + seconds * 1000,
    nowMs: START + nowSeconds * 1000,
    windowSeconds: 300,
  };
}

describe('commercial campaign sliding velocity', () => {
  it('keeps recent chats across a legacy fixed-window reset and refreshes each chat independently', () => {
    const tracker = new InMemoryCommercialCampaignTracker();
    const track = (chatId: string, seconds: number) =>
      tracker.track({
        createdAt: new Date(START + seconds * 1000),
        chatId,
        senderId: 'user-1',
        text: 'Услуги электрика, принимаю заказы. Телефон 8 900 000 10 42.',
      });
    track('chat-1', 0);
    track('chat-2', 299);
    expect(track('chat-3', 301)).toMatchObject({
      senderDistinctChatCount5m: 1,
      shadowSlidingSenderDistinctChatCount5m: 2,
    });

    const sliding = new InMemoryCommercialCampaignSlidingWindow();
    sliding.observe(observation('chat-1', 0));
    sliding.observe(observation('chat-2', 290));
    sliding.observe(observation('chat-1', 299));
    expect(sliding.observe(observation('chat-3', 301))).toEqual({ size: 3, saturated: false });
    expect(sliding.observe(observation('chat-3', 302))).toEqual({ size: 3, saturated: false });
  });

  it('uses an exclusive cutoff and rejects stale or excessive future observations', () => {
    const sliding = new InMemoryCommercialCampaignSlidingWindow();
    sliding.observe(observation('chat-1', 0));
    expect(sliding.observe(observation('chat-2', 299.999))).toEqual({ size: 2, saturated: false });
    expect(sliding.observe(observation('chat-3', 300))).toEqual({ size: 2, saturated: false });
    expect(sliding.observe(observation('stale-chat', 0, 300))).toEqual({
      size: 0,
      saturated: false,
    });
    expect(sliding.observe(observation('future-chat', 331, 300))).toEqual({
      size: 0,
      saturated: false,
    });
    expect(sliding.observe(observation('chat-3', 301))).toEqual({ size: 2, saturated: false });
    expect(sliding.observe(observation('clamped-chat', 331, 301))).toEqual({
      size: 3,
      saturated: false,
    });
  });

  it('never lends later chats to an older event or regresses a chat lastSeen', () => {
    const sliding = new InMemoryCommercialCampaignSlidingWindow();
    sliding.observe(observation('chat-1', 0));
    sliding.observe(observation('chat-2', 250));
    sliding.observe(observation('chat-1', 270));
    expect(sliding.observe(observation('chat-3', 255, 300))).toEqual({ size: 2, saturated: false });
    expect(sliding.observe(observation('chat-1', 260, 301))).toEqual({ size: 2, saturated: false });
    expect(sliding.observe(observation('chat-4', 560))).toEqual({ size: 2, saturated: false });
  });

  it('saturates with the most recent members and bounds active audit keys', () => {
    const sliding = new InMemoryCommercialCampaignSlidingWindow(3, 2);
    for (let seconds = 0; seconds < 4; seconds += 1) {
      expect(sliding.observe(observation(`chat-${seconds}`, seconds)).size).toBe(
        Math.min(seconds + 1, 3),
      );
    }
    expect(sliding.observe(observation('chat-4', 4))).toEqual({ size: 3, saturated: true });
    expect(sliding.observe(observation('chat-5', 301))).toEqual({ size: 3, saturated: true });
    for (let index = 0; index < 3; index += 1)
      sliding.observe({ ...observation('chat', 302 + index), key: `test-key-${index}` });
    expect(sliding.retainedKeyCount).toBe(2);
    sliding.observe({ ...observation('chat', 605), key: 'final-key' });
    expect(sliding.retainedKeyCount).toBe(1);
  });

  it('uses a separate immutable key namespace and digests member identifiers', () => {
    expect(KEY).toMatch(/^commercial-campaign:sliding:v1:sender:[a-f0-9]{64}:velocity:300:chats$/u);
    expect(KEY).not.toContain('user-1');
    expect(fingerprintCommercialCampaignSlidingMember('chat-1')).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintCommercialCampaignSlidingMember('chat-1')).not.toBe(
      fingerprintCommercialCampaignSlidingMember('chat-2'),
    );
  });

  it('preserves explicit baseline replay and binds changed production velocity to its cohort', () => {
    const campaign: CommercialCampaignContext = {
      senderDistinctChatCount: 3,
      sameTextDistinctChatCount: 1,
      repeatedPhoneDistinctChatCount: 1,
      repeatedLinkDistinctChatCount: 0,
      senderDistinctChatCount5m: 1,
      senderDistinctChatCount30m: 1,
      senderDistinctChatCount120m: 1,
      shadowSlidingSenderDistinctChatCount5m: 3,
      shadowSlidingSenderDistinctChatCount30m: 3,
      shadowSlidingSenderDistinctChatCount120m: 3,
    };
    expect(resolveCommercialSlidingCampaignPolicyContext(campaign, [])).toEqual({
      context: campaign,
      requiredPolicyCohorts: [],
    });
    const promoted = resolveCommercialSlidingCampaignPolicyContext(campaign, [
      COMMERCIAL_SLIDING_CAMPAIGN_COHORT,
    ]);
    expect(promoted.context).toMatchObject({
      senderDistinctChatCount5m: 3,
      senderDistinctChatCount30m: 3,
      senderDistinctChatCount120m: 3,
    });
    expect(promoted.requiredPolicyCohorts).toEqual([COMMERCIAL_SLIDING_CAMPAIGN_COHORT]);
    expect(campaign.senderDistinctChatCount5m).toBe(1);

    const detector = new CommercialAdDetector();
    const params = {
      rawLoweredText:
        'Ремонт холодильников. Выезд от 2000 рублей, звоните 8 900 000 10 42.'.toLowerCase(),
      normalizedText: '',
      settings: {
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 45,
        commercialAdsDeleteThreshold: 65,
      } as ChatSettings,
      commercialCampaignContext: campaign,
    };
    const baseline = detector.detect({ ...params, promotedPolicyCohorts: [] });
    expect(baseline?.matchedSignals).not.toContain('campaign:sender-velocity-5m');
    const production = detector.detect(params);
    expect(production?.matchedSignals).toContain('campaign:sender-velocity-5m');
    expect(production?.requiredPolicyCohorts).toEqual([COMMERCIAL_SLIDING_CAMPAIGN_COHORT]);
    expect(production?.actionable).toBe(true);
    expect(detector.detect({ ...params, promotedPolicyCohorts: [] })).toEqual(baseline);
  });
});
