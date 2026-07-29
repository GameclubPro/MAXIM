import {
  InMemoryCommercialCampaignTracker,
  buildCommercialCampaignFingerprint,
  hasCommercialCampaignEvidence,
} from './commercial-campaign.util';

describe('commercial-campaign util', () => {
  it('builds a stable text fingerprint while separating links and phones', () => {
    const first = buildCommercialCampaignFingerprint(
      'Каналы на трафике. 2500р 1/48. Пишите в MAX https://max.ru/join/AbCdEf +7 900 123 45 67',
    );
    const second = buildCommercialCampaignFingerprint(
      'Каналы на трафике. 2500р 1/48. Пишите в MAX https://max.ru/join/AbCdEf 8 (900) 123-45-67',
    );

    expect(first.textHash).toBe(second.textHash);
    expect(first.links).toEqual(['max.ru/join/AbCdEf']);
    expect(first.phones).toEqual(['79001234567']);
  });

  it('extracts emoji keycap formatted phones for campaign evidence', () => {
    const fingerprint = buildCommercialCampaignFingerprint(
      'По поводу заказа пишите по номеру 8️⃣9️⃣8️⃣9️⃣8️⃣8️⃣8️⃣2️⃣0️⃣8️⃣9️⃣ Иннара',
    );

    expect(fingerprint.phones).toEqual(['79898882089']);
  });

  it('tracks repeated sender, text, and phone across chats', () => {
    const tracker = new InMemoryCommercialCampaignTracker(60 * 60);

    const first = tracker.track({
      createdAt: new Date('2026-04-19T10:00:00.000Z'),
      chatId: 'chat-1',
      senderId: 'User-1',
      text: 'Маникюр, пишите в личку +7 900 123 45 67',
    });
    const second = tracker.track({
      createdAt: new Date('2026-04-19T10:05:00.000Z'),
      chatId: 'chat-2',
      senderId: 'user-1',
      text: 'Маникюр, пишите в личку 8 (900) 123-45-67',
    });

    expect(first).toMatchObject({
      senderDistinctChatCount: 1,
      sameTextDistinctChatCount: 1,
      repeatedPhoneDistinctChatCount: 1,
      repeatedLinkDistinctChatCount: 0,
    });
    expect(second).toMatchObject({
      senderDistinctChatCount: 2,
      sameTextDistinctChatCount: 2,
      repeatedPhoneDistinctChatCount: 2,
      repeatedLinkDistinctChatCount: 0,
    });
    expect(hasCommercialCampaignEvidence(second)).toBe(true);
  });

  it('expires the whole redis-like set window from the first seen message', () => {
    const tracker = new InMemoryCommercialCampaignTracker(60);

    tracker.track({
      createdAt: new Date('2026-04-19T10:00:00.000Z'),
      chatId: 'chat-1',
      senderId: 'user-1',
      text: 'Электрик круглосуточно, звоните +7 900 123 45 67',
    });
    const afterTtl = tracker.track({
      createdAt: new Date('2026-04-19T10:01:01.000Z'),
      chatId: 'chat-2',
      senderId: 'user-1',
      text: 'Электрик круглосуточно, звоните +7 900 123 45 67',
    });

    expect(afterTtl).toMatchObject({
      senderDistinctChatCount: 1,
      sameTextDistinctChatCount: 1,
      repeatedPhoneDistinctChatCount: 1,
    });
    expect(hasCommercialCampaignEvidence(afterTtl)).toBe(false);
  });

  it('evicts expired unique campaign keys during a chronological audit', () => {
    const tracker = new InMemoryCommercialCampaignTracker(60);
    const startedAt = Date.parse('2026-04-19T10:00:00.000Z');

    for (let index = 0; index < 2_000; index += 1) {
      tracker.track({
        createdAt: new Date(startedAt + index),
        chatId: `chat-${index}`,
        senderId: `user-${index}`,
        text: `Уникальное объявление номер ${index}, подробности в личных сообщениях`,
      });
    }

    expect(tracker.retainedKeyCount).toBeGreaterThan(10_000);

    tracker.track({
      createdAt: new Date(startedAt + 121 * 60 * 1_000),
      chatId: 'final-chat',
      senderId: 'final-user',
      text: 'Последнее уникальное объявление, подробности в личных сообщениях',
    });

    expect(tracker.retainedKeyCount).toBeLessThan(10);
  });
});
