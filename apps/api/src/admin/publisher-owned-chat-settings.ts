import type { ChatSettings } from '@maxim/contracts';
import { DEFAULT_CHAT_SETTINGS } from './admin.service.support';

export const PUBLISHER_OWNED_CHAT_SETTING_KEYS = [
  'commentsEnabled',
  'commentsAdminsEnabled',
  'commentsAllEnabled',
  'commentsChatBroadcastsEnabled',
] as const satisfies readonly (keyof ChatSettings)[];

export const DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS = {
  commentsEnabled: DEFAULT_CHAT_SETTINGS.commentsEnabled,
  commentsAdminsEnabled: DEFAULT_CHAT_SETTINGS.commentsAdminsEnabled,
  commentsAllEnabled: DEFAULT_CHAT_SETTINGS.commentsAllEnabled,
  commentsChatBroadcastsEnabled: DEFAULT_CHAT_SETTINGS.commentsChatBroadcastsEnabled,
} satisfies Pick<ChatSettings, (typeof PUBLISHER_OWNED_CHAT_SETTING_KEYS)[number]>;

export function omitPublisherOwnedChatSettings(
  settings: Partial<ChatSettings>,
): Partial<ChatSettings> {
  const majorOwnedSettings = { ...settings };
  for (const key of PUBLISHER_OWNED_CHAT_SETTING_KEYS) {
    delete majorOwnedSettings[key];
  }
  return majorOwnedSettings;
}
