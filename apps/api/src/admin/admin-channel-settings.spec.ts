import { channelSettingsSchema } from '@maxim/contracts';
import {
  normalizeChannelAutoPostButtonsMode,
  normalizeChannelSettings,
} from './admin-channel-settings';

describe('channel auto post button mode', () => {
  it.each([
    ['BOTH', false, true],
    ['COMMENTS', false, true],
    ['SUGGEST', true, false],
    ['OFF', true, true],
  ] as const)(
    'keeps %s as the selected mode when feature availability changes',
    (mode, commentsEnabled, postSuggestionsEnabled) => {
      const settings = channelSettingsSchema.parse({
        autoPostButtonsMode: mode,
        commentsEnabled,
        postSuggestionsEnabled,
      });

      expect(normalizeChannelAutoPostButtonsMode(settings)).toBe(mode);
      expect(normalizeChannelSettings(settings).autoPostButtonsMode).toBe(mode);
    },
  );
});
