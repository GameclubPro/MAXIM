import { chatSettingsSchema } from '@maxim/contracts/settings';
import {
  getStoredChatSettingsSanitizationChanges,
  sanitizeStoredChatSettings,
} from './admin-chat-settings';

describe('legacy duplicate windows', () => {
  it('repairs only the three windows and preserves unrelated settings and custom copy', () => {
    const current = {
      ...chatSettingsSchema.parse({
        antiDuplicateEnabled: true,
        duplicateWarnEnabled: true,
        duplicateBotMessageText: 'Авторский текст реакции',
        greetingEnabled: true,
      }),
      duplicateWarnWindowSec: 604800,
      duplicateMuteWindowSec: 259200,
      duplicateBanWindowSec: 86400,
    };
    const parsed = chatSettingsSchema.parse(sanitizeStoredChatSettings(current));
    expect(parsed).toEqual({
      ...current,
      duplicateWarnWindowSec: 172800,
      duplicateMuteWindowSec: 172800,
    });
    expect(getStoredChatSettingsSanitizationChanges(current, parsed)).toEqual({
      duplicateWarnWindowSec: 172800,
      duplicateMuteWindowSec: 172800,
    });
    expect(current.duplicateWarnWindowSec).toBe(604800);
  });
});
