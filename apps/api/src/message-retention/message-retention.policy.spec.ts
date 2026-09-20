import type { MaxUpdate } from '@maxim/contracts';
import {
  readRetentionCapture,
  retentionModeAllows,
  retentionQuotaShard,
  MESSAGE_RETENTION_DAY_MS,
} from './message-retention.policy';

const now = Date.parse('2026-09-20T12:00:00Z');
function update(): MaxUpdate {
  return {
    type: 'message_created',
    updateId: 'u1',
    botId: 'major',
    eventTimestampSource: 'payload',
    message: {
      chatId: '-123',
      messageId: 'mid1',
      senderId: '456',
      text: '',
      createdAt: new Date(now).toISOString(),
    },
    raw: {
      message: {
        timestamp: now - 1000,
        sender: { user_id: 456, is_bot: false },
        recipient: { chat_id: -123, chat_type: 'chat' },
        body: { mid: 'mid1' },
      },
    },
  };
}

describe('retention capture authority', () => {
  it('uses message creation time rather than normalized event time', () => {
    expect(readRetentionCapture(update(), now)?.sourceAt.getTime()).toBe(now - 1000);
  });
  it.each(['message_edited', 'message_removed', 'message_callback'])('ignores %s', (type) => {
    expect(readRetentionCapture({ ...update(), type }, now)).toBeNull();
  });
  it('rejects missing provenance, unknown authors and bots', () => {
    for (const raw of [
      {},
      { message: { timestamp: now } },
      {
        message: {
          timestamp: now,
          sender: { user_id: 456, is_bot: true },
          recipient: { chat_id: -123, chat_type: 'chat' },
          body: { mid: 'mid1' },
        },
      },
    ])
      expect(readRetentionCapture({ ...update(), raw }, now)).toBeNull();
  });
  it('rejects private dialogs, channels and wrong message identity', () => {
    const original = update();
    expect(
      readRetentionCapture({ ...original, message: { ...original.message!, chatId: '123' } }, now),
    ).toBeNull();
    expect(
      readRetentionCapture(
        { ...original, message: { ...original.message!, entityType: 'channel' } },
        now,
      ),
    ).toBeNull();
    expect(
      readRetentionCapture(
        { ...original, message: { ...original.message!, messageId: 'other' } },
        now,
      ),
    ).toBeNull();
  });
  it('rejects expired replay and future timestamps', () => {
    for (const timestamp of [now - 8 * MESSAGE_RETENTION_DAY_MS, now + 61_000, NaN]) {
      const event = update();
      (event.raw!.message as Record<string, unknown>).timestamp = timestamp;
      expect(readRetentionCapture(event, now)).toBeNull();
    }
  });
  it('keeps canary exact and shadow non-destructive', () => {
    expect(retentionModeAllows('off', '-123', '-123')).toBe(false);
    expect(retentionModeAllows('shadow', '', '-123')).toBe(true);
    expect(retentionModeAllows('shadow', '', '-123', true)).toBe(false);
    expect(retentionModeAllows('canary', '-123', '-123', true)).toBe(true);
    expect(retentionModeAllows('canary', '*,-1234', '-123', true)).toBe(false);
    expect(retentionModeAllows('unknown', '-123', '-123', true)).toBe(false);
  });
  it('distributes 20,000 chat identities over bounded stable quota shards', () => {
    const counts = Array<number>(32).fill(0);
    for (let i = 1; i <= 20_000; i++) counts[retentionQuotaShard(`-${i}`)]!++;
    expect(counts.reduce((a, b) => a + b, 0)).toBe(20_000);
    expect(Math.min(...counts)).toBeGreaterThan(450);
    expect(Math.max(...counts)).toBeLessThan(800);
    expect(retentionQuotaShard('-123')).toBe(retentionQuotaShard('-123'));
  });
});
