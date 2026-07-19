import type { AdminService } from './admin.service';

export const CHANNEL_DIALOG_LEGACY_PORT = Symbol('CHANNEL_DIALOG_LEGACY_PORT');

export type ChannelDialogLegacyPort = Pick<
  AdminService,
  | 'createChannelDialogMessage'
  | 'createChatDialogMessage'
  | 'deleteChannelDialogMessage'
  | 'deleteChatDialogMessage'
  | 'getChannelDialog'
  | 'getChatDialog'
  | 'getPublicChannelSettingsForDialog'
  | 'getPublicChatCommentSettingsForDialog'
  | 'processChannelSuggestionDeliveryJob'
  | 'recordChannelSuggestionDeliveryJobFailure'
  | 'recoverStaleChannelSuggestionDeliveries'
  | 'toggleEntityDialogReactionForDialog'
  | 'updateChannelDialogMessage'
  | 'updateChannelDialogNotifications'
  | 'updateChatDialogMessage'
  | 'updateChatDialogNotifications'
>;
