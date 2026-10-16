import { WebhookParser } from '../webhook/webhook.parser';
import { captureChannelPostDemand, CHANNEL_POST_DEMAND_LIFETIME_MS } from './channel-post-demand';
import { ChannelAutoPostScanManager } from './channel-auto-post-runtime';

function fixture() {
  const at = Date.now();
  const raw = {
    update_type: 'message_created',
    timestamp: at,
    message: {
      recipient: { chat_id: '-78271171091799', chat_type: 'channel' },
      timestamp: at,
      body: { mid: 'fixture-post', text: 'Local fixture' },
    },
  };
  const update = new WebhookParser().parse(raw);
  update.botId = 'moderator';
  return { update, raw, at };
}

describe('authenticated channel post scheduling nomination', () => {
  it('captures an exact senderless post, with a source-bound horizon', () => {
    const { update, at } = fixture();
    expect(captureChannelPostDemand(update, 'publisher', at)).toEqual({
      chatId: update.message!.chatId,
      messageId: 'fixture-post',
      sourceAt: new Date(at),
      expiresAt: new Date(at + CHANNEL_POST_DEMAND_LIFETIME_MS),
    });
    expect(captureChannelPostDemand(update, 'publisher', at + 1000)?.expiresAt.getTime()).toBe(
      at + CHANNEL_POST_DEMAND_LIFETIME_MS,
    );
  });
  it.each([
    'publisher',
    'chat',
    'comment',
    'mismatch',
    'edited',
    'synthetic-time',
    'future',
    'expired',
  ])('does not nominate %s observations', (kind) => {
    const { update, raw, at } = fixture();
    let now = at;
    if (kind === 'publisher') update.botId = 'publisher';
    if (kind === 'chat') update.message!.entityType = 'chat';
    if (kind === 'comment') update.message!.postId = 'parent-post';
    if (kind === 'mismatch') raw.message.body.mid = 'another-post';
    if (kind === 'edited') update.type = 'message_edited';
    if (kind === 'synthetic-time') update.eventTimestampSource = 'ingress';
    if (kind === 'future') now -= 1001;
    if (kind === 'expired') now += CHANNEL_POST_DEMAND_LIFETIME_MS;
    expect(captureChannelPostDemand(update, 'publisher', now)).toBeNull();
  });
  it('bypasses idle delay while preserving scoped Retry-After', () => {
    let now = 0;
    const manager = new ChannelAutoPostScanManager({
      scanIntervalMs: 30_000,
      scanMaxChannels: 6,
      idleBackoffMaxMs: 300_000,
      repairSweepMs: 600_000,
      rateLimitBackoffMs: 60_000,
      throttleBackoffMaxMs: 300_000,
      now: () => now,
    });
    manager.states.set('channel', {
      latestTimestampMs: 0,
      latestMessageIdsAtTimestamp: [],
      idleStreak: 3,
      nextScanAtMs: 300_000,
    });
    expect(manager.isDue('channel')).toBe(false);
    expect(manager.isDemandDue('channel')).toBe(true);
    manager.recordTransientThrottle('channel', true, 120_000);
    now = 119_999;
    expect(manager.isDemandDue('channel')).toBe(false);
    now++;
    expect(manager.isDemandDue('channel')).toBe(true);
  });
});
