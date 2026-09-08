import { describe, expect, it } from 'vitest';
import { channelSettingsSchema } from '../src/core';

describe('channel quick button settings', () => {
  it('defaults off for existing clients and channels', () => {
    expect(channelSettingsSchema.parse({}).quickButtonsEnabled).toBe(false);
  });
  it('requires an explicit boolean to enable the feature', () => {
    expect(channelSettingsSchema.parse({ quickButtonsEnabled: true }).quickButtonsEnabled).toBe(
      true,
    );
    expect(channelSettingsSchema.safeParse({ quickButtonsEnabled: 'true' }).success).toBe(false);
  });
});
