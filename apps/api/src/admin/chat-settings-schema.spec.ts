import { chatSettingsSchema } from '@maxim/contracts';

describe('chatSettingsSchema duplicate stage validation', () => {
  it('rejects BAN thresholds that are lower than MUTE thresholds', () => {
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

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['duplicateBanWindowSec'] }),
        expect.objectContaining({ path: ['duplicateBanMaxCount'] }),
      ]),
    );
  });
});
