import { chatSettingsSchema } from '@maxim/contracts';

describe('chatSettingsSchema duplicate stage validation', () => {
  it('rejects BAN thresholds that are lower than KICK thresholds', () => {
    const result = chatSettingsSchema.safeParse({
      antiDuplicateEnabled: true,
      duplicateWarnEnabled: false,
      duplicateKickEnabled: true,
      duplicateBanEnabled: true,
      duplicateKickWindowSec: 48 * 60 * 60,
      duplicateKickMaxCount: 6,
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
