import type { AdminService } from './admin.service';

export const CHANNEL_DIALOG_LEGACY_PORT = Symbol('CHANNEL_DIALOG_LEGACY_PORT');

export type ChannelDialogLegacyPort = Pick<
  AdminService,
  | 'channelSuggestionPublicationRuntime'
  | 'createChannelDialogMessage'
  | 'createChatDialogMessage'
  | 'deleteChannelDialogMessage'
  | 'deleteChatDialogMessage'
  | 'getChannelDialog'
  | 'getChatDialog'
  | 'getPublicChannelSettingsForDialog'
  | 'getPublicPublisherChannelCommentSettingsForDialog'
  | 'getPublicChatCommentSettingsForDialog'
  | 'getPublicPublisherChatCommentSettingsForDialog'
  | 'processChannelSuggestionDeliveryJob'
  | 'processPublisherSuggestionAdminDeliveryJob'
  | 'recordChannelSuggestionDeliveryJobFailure'
  | 'recoverStaleChannelSuggestionDeliveries'
  | 'syncPublisherSuggestionAdminReviewMessages'
  | 'toggleEntityDialogReactionForDialog'
  | 'updateChannelDialogMessage'
  | 'updateChannelDialogNotifications'
  | 'updateChatDialogMessage'
  | 'updateChatDialogNotifications'
>;
