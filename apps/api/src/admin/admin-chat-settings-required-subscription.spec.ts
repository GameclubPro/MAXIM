import { chatSettingsSchema } from '@maxim/contracts';
import { getChatSettingsNormalizationChanges, normalizeChatSettings } from './admin-chat-settings';

describe('required subscription chat settings normalization', () => {
  it('keeps the explanation enabled while required subscription targets are active', () => {
    const stored = chatSettingsSchema.parse({
      requiredSubscriptionChannelIds: ['channel-1'],
      requiredSubscriptionBotMessageEnabled: false,
    });

    const normalized = normalizeChatSettings(stored);

    expect(normalized.requiredSubscriptionEnabled).toBe(true);
    expect(normalized.requiredSubscriptionBotMessageEnabled).toBe(true);
    expect(getChatSettingsNormalizationChanges(stored, normalized)).toEqual(
      expect.objectContaining({ requiredSubscriptionBotMessageEnabled: true }),
    );
  });

  it('disables the legacy explanation flag when no required targets remain', () => {
    const stored = chatSettingsSchema.parse({
      requiredSubscriptionChannelIds: [],
      requiredSubscriptionBotMessageEnabled: true,
    });

    const normalized = normalizeChatSettings(stored);

    expect(normalized.requiredSubscriptionEnabled).toBe(false);
    expect(normalized.requiredSubscriptionBotMessageEnabled).toBe(false);
  });
});
