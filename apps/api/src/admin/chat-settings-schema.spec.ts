import { chatSettingsSchema } from '@maxim/contracts';

describe('chatSettingsSchema duplicate flow validation', () => {
  it('allows duplicate thresholds to start from the first duplicate', () => {
    const result = chatSettingsSchema.safeParse({
      antiDuplicateEnabled: true,
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 1,
      duplicateMuteEnabled: true,
      duplicateMuteMaxCount: 2,
      duplicateBanEnabled: true,
      duplicateBanMaxCount: 3,
    });

    expect(result.success).toBe(true);
  });

  it('does not require BAN thresholds to stay above MUTE thresholds', () => {
    const result = chatSettingsSchema.safeParse({
      antiDuplicateEnabled: true,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      duplicateMuteWindowSec: 48 * 60 * 60,
      duplicateMuteMaxCount: 6,
      duplicateBanWindowSec: 24 * 60 * 60,
      duplicateBanMaxCount: 4,
    });

    expect(result.success).toBe(true);
  });
});
