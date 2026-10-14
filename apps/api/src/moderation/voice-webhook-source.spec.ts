import { WebhookParser } from '../webhook/webhook.parser';
import {
  bindVoiceSourceEvidence,
  captureVoiceSourceInput,
  VOICE_SOURCE_LIFETIME_MS,
} from './voice-webhook-source';

function fixture() {
  const at = Date.now();
  const raw = {
    update_type: 'message_created',
    timestamp: at,
    message: {
      sender: { user_id: '42', is_bot: false },
      recipient: { chat_id: '-123', chat_type: 'chat' },
      timestamp: at,
      body: {
        mid: 'voice-one',
        text: '',
        attachments: [{ type: 'audio', payload: { token: 'private' } }],
      },
    },
  };
  const parse = () => new WebhookParser().parse(raw, { botId: 'bot-one' });
  return { raw, parse, at };
}

describe('authenticated direct voice source classification', () => {
  it.each(['audio', 'voice', 'audio_message', 'ptt'])(
    'captures %s without retaining media data',
    (type) => {
      const s = fixture();
      s.raw.message.body.attachments[0]!.type = type;
      expect(captureVoiceSourceInput(s.parse())).toEqual({
        kind: 'created',
        chatId: '-123',
        messageId: 'voice-one',
        userId: '42',
        sourceAtMs: s.at,
        deadlineAtMs: s.at + VOICE_SOURCE_LIFETIME_MS,
      });
    },
  );
  it.each(['file', 'sticker', 'image', 'video'])(
    'does not grant authority from an %s attachment or filename',
    (type) => {
      const s = fixture();
      s.raw.message.body.attachments[0]!.type = type;
      Object.assign(s.raw.message.body.attachments[0]!.payload, {
        url: 'https://media.invalid/voice.opus',
        mime_type: 'audio/ogg',
      });
      expect(captureVoiceSourceInput(s.parse())).toBeNull();
    },
  );
  it.each([
    'bot',
    'channel',
    'old',
    'future',
    'missing-clock',
    'missing-receiver',
    'mismatched-id',
    'reply',
    'mixed',
  ])('rejects %s evidence', (variant) => {
    const s = fixture();
    if (variant === 'bot') s.raw.message.sender.is_bot = true;
    if (variant === 'channel') s.raw.message.recipient.chat_type = 'channel';
    if (variant === 'old') s.raw.timestamp -= VOICE_SOURCE_LIFETIME_MS;
    if (variant === 'future') s.raw.timestamp += 2_000;
    if (variant === 'missing-clock') {
      Reflect.deleteProperty(s.raw, 'timestamp');
      Reflect.deleteProperty(s.raw.message, 'timestamp');
    }
    if (variant === 'reply') {
      Object.assign(s.raw.message, {
        link: { type: 'reply', message: { body: s.raw.message.body } },
      });
      s.raw.message.body = { mid: 'voice-one', text: '', attachments: [] };
    }
    if (variant === 'mixed')
      s.raw.message.body.attachments.push({ type: 'file', payload: { token: 'other' } });
    const update = s.parse();
    if (variant === 'missing-receiver') delete update.botId;
    if (variant === 'mismatched-id') update.message!.messageId = 'different';
    expect(captureVoiceSourceInput(update)).toBeNull();
  });
  it('revokes on an exact edit even when its event timestamp is unavailable', () => {
    const s = fixture();
    s.raw.update_type = 'message_edited';
    Reflect.deleteProperty(s.raw, 'timestamp');
    Reflect.deleteProperty(s.raw.message, 'timestamp');
    expect(captureVoiceSourceInput(s.parse())).toEqual({
      kind: 'invalidate',
      chatId: '-123',
      messageId: 'voice-one',
    });
  });
  it('revokes exact removal without treating the removing actor as the original author', () => {
    const update = new WebhookParser().parse(
      {
        update_type: 'message_removed',
        chat_id: '-123',
        message_id: 'voice-one',
        user_id: 'other',
        timestamp: Date.now(),
      },
      { botId: 'bot-one' },
    );
    expect(captureVoiceSourceInput(update)).toEqual({
      kind: 'invalidate',
      chatId: '-123',
      messageId: 'voice-one',
    });
  });
  it('binds only the admitted native voice reason and preserves its absolute deadline', () => {
    const s = fixture();
    const input = {
      chatId: '-123',
      messageId: 'voice-one',
      subjectUserId: '42',
      sourceMessageAt: new Date(s.at),
      ruleCode: 'VOICE_BLOCKED_DELETE',
      reasonKey: 'voice',
    };
    const settings = { voiceMessagesEnabled: false } as never;
    const bound = bindVoiceSourceEvidence(input, s.parse(), settings, 'receipt-one');
    expect(bound.retryUntilAt).toEqual(new Date(s.at + VOICE_SOURCE_LIFETIME_MS));
    expect(bound.event?.metadata).toMatchObject({
      voiceSourceEvidenceVersion: 1,
      voiceSourceAtMs: s.at,
    });
    expect(bindVoiceSourceEvidence(input, s.parse(), settings, undefined)).toBe(input);
    const unrelated = { ...input, ruleCode: 'MESSAGE_TOO_LONG_DELETE' };
    expect(bindVoiceSourceEvidence(unrelated, s.parse(), settings, 'receipt-one')).toBe(unrelated);
  });
});
