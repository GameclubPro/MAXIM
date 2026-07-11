export const MAX_KNOWN_OFFICIAL_WEBHOOK_UPDATE_TYPES = [
  'message_created',
  'message_edited',
  'message_removed',
  'message_callback',
  'user_added',
  'user_removed',
  'bot_added',
  'bot_removed',
  'bot_started',
  'bot_stopped',
  'chat_title_changed',
  'dialog_cleared',
  'dialog_muted',
  'dialog_unmuted',
  'dialog_removed',
] as const;

export const MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES = [
  'message_created',
  'message_edited',
  'message_callback',
  'user_added',
  'user_removed',
  'bot_added',
  'bot_removed',
  'bot_started',
  'chat_title_changed',
] as const;

export const MAX_EXTENDED_LIFECYCLE_WEBHOOK_UPDATE_TYPES = [
  'message_removed',
  'bot_stopped',
  'dialog_removed',
] as const;

export const MAX_REQUIRED_WEBHOOK_UPDATE_TYPES = [
  ...MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES,
  ...MAX_EXTENDED_LIFECYCLE_WEBHOOK_UPDATE_TYPES,
] as const;

export type MaxExtendedWebhookLifecycleMode = 'off' | 'shadow' | 'canary' | 'on';

export function resolveRequiredWebhookUpdateTypes(
  mode: MaxExtendedWebhookLifecycleMode | string | null | undefined,
): readonly string[] {
  return mode === 'canary' || mode === 'on'
    ? MAX_REQUIRED_WEBHOOK_UPDATE_TYPES
    : MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES;
}
