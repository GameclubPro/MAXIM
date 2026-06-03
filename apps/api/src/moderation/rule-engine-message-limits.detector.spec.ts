import type { ChatSettings } from '../prisma/prisma-client';
import {
  RuleEngineMessageLimitsDetector,
  extractDetectedPhoneNumbers,
} from './rule-engine-message-limits.detector';

class MockRedisCounterService {
  readonly calls: Array<{ key: string; ttlSec: number }> = [];
  private readonly counters = new Map<string, number>();

  async incrementWithTtl(key: string, ttlSec: number): Promise<number> {
    this.calls.push({ key, ttlSec });
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }
}

function buildSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    maxMessageLengthEnabled: false,
    maxMessageLength: 1500,
    antiSpamEnabled: true,
    messageCountLimitEnabled: false,
    messageCountLimitMessages: 5,
    messageCountLimitWindowHours: 1,
    messageLimitsBlockedWords: [],
    messageLimitsBlockedDomains: [],
    photoMessagesEnabled: true,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    phoneNumbersEnabled: true,
    photoMessageCooldownEnabled: false,
    photoMessageCooldownHours: 1,
    stickerMessageCooldownEnabled: false,
    stickerMessageCooldownMinutes: 5,
    updatedAt: new Date('2026-05-14T00:00:00.000Z'),
    ...overrides,
  } as ChatSettings;
}

describe('RuleEngineMessageLimitsDetector', () => {
  it('detects text length, blocked words, and disabled attachment kinds', () => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService() as never);
    const settings = buildSettings({
      maxMessageLengthEnabled: true,
      maxMessageLength: 10,
      messageLimitsBlockedWords: ['спаммаркер'],
      photoMessagesEnabled: false,
      videoMessagesEnabled: false,
      fileMessagesEnabled: false,
      voiceMessagesEnabled: false,
      phoneNumbersEnabled: false,
    });

    expect(
      detector.detectMessageLengthLimit({
        measuredLength: 11,
        settings,
      })?.ruleCode,
    ).toBe('MESSAGE_TOO_LONG');
    expect(
      detector.detectBlockedWordLimit({
        text: 'тут спаммаркер внутри',
        settings,
      })?.ruleCode,
    ).toBe('MESSAGE_BLOCKED_WORD');
    expect(
      detector.detectPhoneNumberLimit({
        text: 'Связь: +7 900 000 00 01',
        settings,
      })?.ruleCode,
    ).toBe('PHONE_NUMBER_BLOCKED');
    expect(
      detector.detectAttachmentLimits({
        settings,
        hasPhotoAttachment: true,
        hasVideoAttachment: true,
        hasFileAttachment: true,
        hasVoiceAttachment: true,
      }),
    ).toEqual([
      expect.objectContaining({ ruleCode: 'PHOTO_BLOCKED' }),
      expect.objectContaining({ ruleCode: 'VIDEO_BLOCKED' }),
      expect.objectContaining({ ruleCode: 'FILE_BLOCKED' }),
      expect.objectContaining({ ruleCode: 'VOICE_BLOCKED' }),
    ]);
  });

  it('detects blocked domains on exact hosts and subdomains', () => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService() as never);
    const settings = buildSettings({
      messageLimitsBlockedDomains: ['casino.example'],
    });

    expect(
      detector.detectBlockedDomainLimit({
        text: 'Бонусы тут: https://promo.casino.example/path',
        settings,
      }),
    ).toEqual(
      expect.objectContaining({
        ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
        metadata: {
          blockedDomain: 'casino.example',
          matchedDomain: 'promo.casino.example',
        },
      }),
    );
    expect(
      detector.detectBlockedDomainLimit({
        text: 'Нейтральный домен: https://notcasino.example/path',
        settings,
      }),
    ).toBeNull();
  });

  it('extracts formatted and contextual phone numbers without duplicates', () => {
    expect(
      extractDetectedPhoneNumbers('Связь: +7 (900) 123-45-67, запасной телефон 8 900 123 45 67'),
    ).toEqual(['79001234567']);
    expect(extractDetectedPhoneNumbers('телефон офиса 495 123 45 67')).toEqual(['4951234567']);
  });

  it('does not treat dates and numeric ranges as phones', () => {
    expect(
      extractDetectedPhoneNumbers(
        'Периоды 2024-2025-2026 и 12.05.2026 не контакты, диапазон 100-200-300 тоже.',
      ),
    ).toEqual([]);
  });

  it('uses clamped message-count windows and thresholds', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter as never);
    const settings = buildSettings({
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 99,
      messageCountLimitWindowHours: 99,
    });

    for (let index = 0; index < 10; index += 1) {
      await expect(
        detector.detectMessageCountLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          settings,
        }),
      ).resolves.toBeNull();
    }

    await expect(
      detector.detectMessageCountLimit({
        chatId: 'chat-1',
        userId: 'user-1',
        settings,
      }),
    ).resolves.toEqual(expect.objectContaining({ ruleCode: 'MESSAGE_COUNT_LIMIT' }));
    expect(redisCounter.calls[0]).toEqual({
      key: 'message:count-limit:v1:chat-1:user-1:10:24',
      ttlSec: 24 * 60 * 60 + 1,
    });
  });

  it('enforces the built-in anti-spam burst window', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter as never);
    const settings = buildSettings({ antiSpamEnabled: true });

    for (let index = 0; index < 5; index += 1) {
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          settings,
        }),
      ).resolves.toBeNull();
    }

    await expect(
      detector.detectAntiSpamBurstLimit({
        chatId: 'chat-1',
        userId: 'user-1',
        settings,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ruleCode: 'MESSAGE_RATE_LIMIT',
        metadata: expect.objectContaining({
          count: 6,
          maxMessages: 5,
          windowSec: 6,
        }),
      }),
    );
    expect(redisCounter.calls[0]).toEqual({
      key: 'message:anti-spam-burst:v1:chat-1:user-1:5:6',
      ttlSec: 7,
    });
  });

  it('skips the built-in anti-spam burst window when disabled', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter as never);
    const settings = buildSettings({ antiSpamEnabled: false });

    for (let index = 0; index < 6; index += 1) {
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          settings,
        }),
      ).resolves.toBeNull();
    }

    expect(redisCounter.calls).toEqual([]);
  });

  it('skips the built-in anti-spam burst window for forwarded messages', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter as never);
    const settings = buildSettings({ antiSpamEnabled: true });

    for (let index = 0; index < 6; index += 1) {
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          settings,
          skipAntiSpamBurstLimit: true,
        }),
      ).resolves.toBeNull();
    }

    expect(redisCounter.calls).toEqual([]);
  });

  it('skips the built-in anti-spam burst window for media attachments and batches', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter as never);
    const settings = buildSettings({ antiSpamEnabled: true });

    for (let index = 0; index < 6; index += 1) {
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          settings,
          hasMediaAttachment: true,
        }),
      ).resolves.toBeNull();
    }

    expect(redisCounter.calls).toEqual([]);
  });

  it('scopes media cooldown state by media kind and settings update timestamp', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter as never);
    const firstSettings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
      updatedAt: new Date('2026-05-14T00:00:00.000Z'),
    });
    const secondSettings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
      updatedAt: new Date('2026-05-14T01:00:00.000Z'),
    });

    await expect(
      detector.detectMediaCooldownLimits({
        chatId: 'chat-1',
        userId: 'user-1',
        settings: firstSettings,
        hasPhotoAttachment: true,
      }),
    ).resolves.toEqual([]);
    await expect(
      detector.detectMediaCooldownLimits({
        chatId: 'chat-1',
        userId: 'user-1',
        settings: firstSettings,
        hasPhotoAttachment: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ ruleCode: 'PHOTO_RATE_LIMIT' })]);
    await expect(
      detector.detectMediaCooldownLimits({
        chatId: 'chat-1',
        userId: 'user-1',
        settings: secondSettings,
        hasPhotoAttachment: true,
      }),
    ).resolves.toEqual([]);
  });
});
