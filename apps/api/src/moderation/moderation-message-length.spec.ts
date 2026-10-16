import type { MaxUpdate } from '@maxim/contracts';
import { WebhookParser } from '../webhook/webhook.parser';
import { calculateEffectiveMessageLength } from './moderation-update-extractors';
import { countMessageCharacters } from './moderation-message-length';

function parsed(text: string, extra: Record<string, unknown> = {}): MaxUpdate {
  return new WebhookParser().parse({
    update_type: 'message_created',
    timestamp: Date.now(),
    message: {
      sender: { user_id: 'user-1' },
      recipient: { chat_id: '-123', chat_type: 'chat' },
      timestamp: Date.now(),
      body: { mid: 'message-1', text },
      ...extra,
    },
  });
}

describe('visible message length', () => {
  it.each([
    ['Привет', 6],
    ['Hello', 5],
    ['🔥', 1],
    ['👨‍👩‍👧‍👦', 1],
    ['👍🏽', 1],
    ['🇷🇺', 1],
    ['е\u0308', 1],
    ['ё', 1],
    ['1️⃣', 1],
    ['a\r\nb', 3],
    ['a\nb', 3],
    [' a  b ', 6],
    ['', 0],
  ])('counts %j as %i characters, preserving source whitespace', (text, length) => {
    expect(countMessageCharacters(text)).toBe(length);
    expect(calculateEffectiveMessageLength(parsed(text))).toBe(length);
  });

  it('counts the official flat forwarded MessageBody without transport strings', () => {
    const update = parsed('', {
      link: {
        type: 'forward',
        sender: { name: 'An unrelated long author name', user_id: '123456789' },
        message: {
          mid: 'forwarded-message-long-id',
          text: 'Привет',
          attachments: [
            {
              type: 'photo',
              payload: { token: 'secret-media-token', url: 'https://cdn.example/image.jpg' },
            },
          ],
          markup: [
            { type: 'link', from: 0, length: 6, url: 'https://very-long.example/destination' },
          ],
        },
      },
    });
    expect(calculateEffectiveMessageLength(update)).toBe(6);
  });

  it.each(['reply', 'quoted'])('never adds a forward found inside a %s', (type) => {
    const update = parsed('Да', {
      link: {
        type,
        message: {
          body: { text: 'Quoted message' },
          link: { type: 'forward', message: { text: 'x'.repeat(1000) } },
        },
      },
    });
    expect(calculateEffectiveMessageLength(update)).toBe(2);
  });

  it.each(['Да', 'да', 'Да!'])(
    'keeps repeated/overlapping direct and forwarded text %j',
    (text) => {
      expect(
        calculateEffectiveMessageLength(
          parsed('Да', {
            link: { type: 'forward', message: { text } },
          }),
        ),
      ).toBe(2 + countMessageCharacters(text));
    },
  );

  it('deduplicates aliases within one part, and does not read metadata captions', () => {
    expect(
      calculateEffectiveMessageLength(
        parsed('Привет', {
          text: 'Привет',
          content: { text: 'Привет' },
          sender: { user_id: 'user-1', text: 'x'.repeat(1000) },
          attachments: [{ type: 'photo', caption: 'x'.repeat(1000) }],
        }),
      ),
    ).toBe(6);
  });

  it('prefers original body whitespace over normalized or stale envelope aliases', () => {
    expect(
      calculateEffectiveMessageLength(
        parsed('А  б\n', {
          text: 'А б',
          caption: 'stale envelope alias',
        }),
      ),
    ).toBe(5);
  });

  it.each(['', null])('does not revive a cleared body (%j) from an old text alias', (text) => {
    const update = parsed('', {
      body: { mid: 'message-1', text },
      text: 'old content'.repeat(100),
    });
    expect(calculateEffectiveMessageLength(update)).toBe(0);
  });

  it.each([
    'forward',
    'forwarded',
    'forwarded_message',
    'forwardedMessage',
    'forwarded_messages',
    'forwardedMessages',
  ])('reads the direct %s legacy shape only', (key) => {
    expect(
      calculateEffectiveMessageLength(
        parsed('Да', {
          [key]: key.endsWith('s') ? [{ body: { text: 'Да' } }] : { body: { text: 'Да' } },
        }),
      ),
    ).toBe(4);
  });

  it('does not count alternate forwarding representations twice', () => {
    expect(
      calculateEffectiveMessageLength(
        parsed('', {
          link: { type: 'forward', message: { text: 'Привет' } },
          forwarded_message: { text: 'Привет' },
        }),
      ),
    ).toBe(6);
  });

  it.each(['message_created', 'message_edited'])(
    'reads the original text from a %s envelope',
    (type) => {
      const update = parsed('a  b');
      const root = update.raw as { message: unknown };
      update.type = type;
      update.raw = { update_type: type, [type]: { data: { message: root.message } } };
      expect(calculateEffectiveMessageLength(update)).toBe(4);
    },
  );

  it('counts visible links but excludes a confirmed hidden MAX media preview', () => {
    const preview = 'https://i.oneme.ru/i?r=preview';
    const text = `Привет https://example.org ${preview}`;
    expect(
      calculateEffectiveMessageLength(
        parsed('', {
          link: {
            type: 'forward',
            message: {
              text,
              attachments: [{ type: 'photo', payload: { url: preview } }],
            },
          },
        }),
      ),
    ).toBe('Привет https://example.org'.length);
    expect(calculateEffectiveMessageLength(parsed(preview))).toBe(preview.length);
  });

  it('uses Unicode counting when only normalized text is available', () => {
    const update = parsed('🔥');
    update.raw = {};
    expect(calculateEffectiveMessageLength(update)).toBe(1);
  });

  it('bounds cyclic/deep/wide forwarding without adding metadata', () => {
    const update = parsed('Да');
    const message = (update.raw as { message: Record<string, unknown> }).message;
    message.forward = message;
    expect(calculateEffectiveMessageLength(update)).toBe(2);
    message.forward = Array.from({ length: 1000 }, () => ({ text: 'a' }));
    expect(calculateEffectiveMessageLength(update)).toBeLessThanOrEqual(130);
  });
});
