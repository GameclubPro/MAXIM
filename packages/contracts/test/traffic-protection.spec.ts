import { describe, expect, it } from 'vitest';
import { chatSettingsSchema, updateSettingsRequestSchema } from '@maxim/contracts';

describe('traffic protection settings', () => {
  it('keeps existing chats unchanged by default', () => {
    expect(chatSettingsSchema.parse({})).toMatchObject({
      slowModeEnabled: false,
      slowModeIntervalSeconds: 30,
      mediaMessageCooldownEnabled: false,
      mediaMessageCooldownSeconds: 30,
      stickerMessagesEnabled: true,
    });
  });
  it.each(['slowModeIntervalSeconds', 'mediaMessageCooldownSeconds'])(
    'bounds %s without accepting strings or fractional intervals',
    (field) => {
      for (const value of [0, 9, 86401, -1, 10.5, '30', null])
        expect(updateSettingsRequestSchema.safeParse({ [field]: value }).success).toBe(false);
      for (const value of [10, 30, 60, 300, 86400])
        expect(updateSettingsRequestSchema.safeParse({ [field]: value }).success).toBe(true);
    },
  );
  it('never accepts client-authored policy revisions or activation dates', () => {
    const settings = updateSettingsRequestSchema.parse({
      trafficPolicyRevision: 10,
      trafficPolicyEffectiveAt: '2020-01-01T00:00:00Z',
    });
    expect(settings).not.toHaveProperty('trafficPolicyRevision');
    expect(settings).not.toHaveProperty('trafficPolicyEffectiveAt');
  });
});
