import { describe, expect, it } from 'vitest';
import * as canonical from '../src/settings-field-schemas.js';
import * as core from '../src/core.js';
import * as settings from '../src/settings.js';
import * as root from '../src/index.js';
import * as broadcast from '../src/broadcast.js';
import * as networks from '../src/network-settings.js';
import { applySettingsSectionSchema } from '../src/settings-sections.js';
import * as channelFields from '../src/channel-settings-field-schemas.js';
import * as messageFields from '../src/settings-message-field-schemas.js';

describe('canonical settings schema entry points', () => {
  it('shares the same field, media and button schemas across compatibility entry points', () => {
    for (const name of [
      'botSpeechMediaSchema',
      'channelSettingsSchema',
      'chatSettingsFieldsSchema',
    ] as const) {
      expect(core[name]).toBe(canonical[name]);
      expect(settings[name]).toBe(canonical[name]);
      expect(root[name]).toBe(canonical[name]);
    }
    expect(core.broadcastLinkButtonSchema).toBe(canonical.broadcastLinkButtonSchema);
    expect(root.broadcastLinkButtonSchema).toBe(canonical.broadcastLinkButtonSchema);
    expect(broadcast.broadcastLinkButtonSchema).toBe(canonical.broadcastLinkButtonSchema);
    expect(core.channelSettingsScreenResponseSchema.shape.settings).toBe(
      canonical.channelSettingsSchema,
    );
    expect(canonical.chatSettingsFieldsSchema.shape.botSpeechMedia).toBe(
      canonical.botSpeechMediaSchema,
    );
  });

  it('reuses channel and message leaves without changing shared validator identity', () => {
    expect(canonical.channelSettingsSchema).toBe(channelFields.channelSettingsSchema);
    expect(canonical.channelSuggestionEntryModeSchema).toBe(
      channelFields.channelSuggestionEntryModeSchema,
    );
    expect(settings.channelSettingsSchema).toBe(channelFields.channelSettingsSchema);
    expect(settings.channelSuggestionEntryModeSchema).toBe(
      channelFields.channelSuggestionEntryModeSchema,
    );
    expect(canonical.channelSettingsSchema.shape.commentsMessageText).toBe(
      messageFields.botMessageTextSchema,
    );
    expect(canonical.chatSettingsFieldsSchema.shape.linkBotMessageText).toBe(
      messageFields.botMessageTextSchema,
    );
    expect(canonical.channelSettingsSchema.shape.postSuggestionsButtonUrl).toBe(
      messageFields.botButtonUrlSchema,
    );
    expect(canonical.chatSettingsFieldsSchema.shape.linkBotButtonUrl).toBe(
      messageFields.botButtonUrlSchema,
    );
    expect(canonical.broadcastLinkButtonSchema.shape.url).toBe(messageFields.botButtonUrlSchema);
    expect(canonical.botButtonTextSchema).toBe(messageFields.botButtonTextSchema);
    expect(canonical.isValidBotButtonUrl).toBe(messageFields.isValidBotButtonUrl);
    expect(canonical.isValidBotButtonText).toBe(messageFields.isValidBotButtonText);
    expect(canonical.parseHttpButtonUrl).toBe(messageFields.parseHttpButtonUrl);
    expect(channelFields.channelSuggestionEntryModeSchema.options).toEqual(['BOT', 'MINIAPP']);
    expect(channelFields.channelSettingsSchema.parse({}).postSuggestionsEntryMode).toBe('BOT');
  });

  it('keeps field defaults separate from full snapshot legacy normalization', () => {
    expect(canonical.chatSettingsFieldsSchema.shape.linkMuteDurationHours.parse(undefined)).toBe(6);
    expect(core.chatSettingsSchema.parse({ muteDurationHours: 12 }).linkMuteDurationHours).toBe(12);
    const delay = canonical.chatSettingsFieldsSchema.shape.greetingDeleteBotMessageDelayMinutes;
    expect(delay.parse(undefined)).toBe(2);
    expect(delay.parse(0.5)).toBe(0.5);
    expect(delay.safeParse(1.5).success).toBe(false);
  });

  it('retains channel combination checks in addition to individual field validation', () => {
    expect(canonical.channelSettingsSchema.shape.postSuggestionsButtonUrl.parse('')).toBe('');
    const invalid = canonical.channelSettingsSchema.safeParse({
      postSuggestionsEnabled: true,
      postSuggestionsButtonEnabled: true,
      postSuggestionsButtonUrl: '',
      postSuggestionsButtonText: '',
    });
    expect(invalid.success).toBe(false);
    if (invalid.success) throw new Error('Expected invalid channel action to be rejected');
    expect(invalid.error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([['postSuggestionsButtonUrl'], ['postSuggestionsButtonText']]),
    );
    expect(canonical.channelSettingsSchema.parse({}).commentsEnabled).toBe(false);
  });

  it('preserves media trimming, empty resets and image validation', () => {
    expect(
      canonical.botSpeechMediaSchema.parse({
        greetingBotMessageText: {
          base64: ' YQ== ',
          mimeType: ' image/png ',
          fileName: ' greeting.png ',
        },
      }),
    ).toEqual({
      greetingBotMessageText: {
        base64: 'YQ==',
        mimeType: 'image/png',
        fileName: 'greeting.png',
      },
    });
    expect(
      canonical.botSpeechMediaSchema.parse({
        greetingBotMessageText: { base64: ' ', mimeType: 'text/plain', fileName: 'old.txt' },
      }),
    ).toEqual({
      greetingBotMessageText: { base64: '', mimeType: '', fileName: '' },
    });
    expect(
      canonical.botSpeechMediaSchema.safeParse({
        greetingBotMessageText: { base64: 'YQ==', mimeType: 'text/plain', fileName: 'bad.txt' },
      }).success,
    ).toBe(false);
  });

  it('keeps public button validation and private handoff exclusions', () => {
    expect(
      canonical.broadcastLinkButtonSchema.parse({
        text: ' Подробнее ',
        url: ' https://example.com/post ',
      }),
    ).toEqual({ text: 'Подробнее', url: 'https://example.com/post' });
    for (const url of ['javascript:alert(1)', 'https://max.ru/bot?start=pmh-private']) {
      expect(canonical.broadcastLinkButtonSchema.safeParse({ text: 'Открыть', url }).success).toBe(
        false,
      );
    }
  });

  it('reuses the unchanged chat section enum inside network section validation', () => {
    expect(core.applySettingsSectionSchema).toBe(applySettingsSectionSchema);
    expect(settings.applySettingsSectionSchema).toBe(applySettingsSectionSchema);
    expect(root.applySettingsSectionSchema).toBe(applySettingsSectionSchema);
    expect(networks.applySettingsSectionSchema).toBe(applySettingsSectionSchema);
    expect(networks.networkSettingsSectionSchema.options[0]).toBe(applySettingsSectionSchema);
    expect(applySettingsSectionSchema.options).toEqual([
      'reports',
      'links',
      'greeting',
      'profanityFilter',
      'commercialFilter',
      'duplicates',
      'limits',
      'stopWords',
      'phones',
      'night',
      'requiredSubscription',
      'invitationAccess',
      'commands',
      'storefront',
      'extra',
    ]);
    expect(applySettingsSectionSchema.safeParse(undefined).success).toBe(false);
    expect(applySettingsSectionSchema.safeParse('comments').success).toBe(false);
    expect(networks.networkSettingsSectionSchema.parse('comments')).toBe('comments');
  });
});
