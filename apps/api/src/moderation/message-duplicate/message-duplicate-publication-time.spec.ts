import { WebhookParser } from '../../webhook/webhook.parser';
import { duplicatePublicationTime } from './message-duplicate-publication-time';

describe('duplicate original publication clock', () => {
  const publishedAt = Date.parse('2026-10-29T05:00:00Z');
  const eventAt = publishedAt + 30 * 60_000;
  const message = {
    sender: { user_id: 123 },
    recipient: { chat_id: -123, chat_type: 'chat' },
    body: { mid: 'offer', text: 'Одинаковое объявление' },
  };

  it.each(['message_created', 'message_edited'])(
    'retains publication time across accepted %s envelopes',
    (type) => {
      for (const envelope of [
        { message: { ...message, timestamp: publishedAt } },
        { [type]: { message: { ...message, timestamp: publishedAt } } },
        { data: { message: { ...message, timestamp: publishedAt } } },
        { event: { items: [{ ...message, timestamp: publishedAt }] } },
        { message: { ...message, created_at: new Date(publishedAt).toISOString() } },
      ]) {
        const update = new WebhookParser().parse({
          update_type: type,
          timestamp: eventAt,
          ...envelope,
        });
        expect(Date.parse(update.message!.createdAt)).toBe(eventAt);
        expect(duplicatePublicationTime(update)).toBe(publishedAt);
      }
    },
  );

  it('never substitutes an edit or forwarded publication date for the selected message', () => {
    const update = new WebhookParser().parse({
      update_type: 'message_edited',
      timestamp: eventAt,
      data: {
        message: {
          ...message,
          link: { type: 'forward', message: { ...message, timestamp: publishedAt } },
        },
      },
    });
    expect(duplicatePublicationTime(update)).toBeUndefined();
  });
});
