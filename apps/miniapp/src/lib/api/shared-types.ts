import type {
  BroadcastLinkButton,
  BroadcastScheduleMode,
  BroadcastTargetMode,
  BroadcastTextFormat,
  ChatRules,
  UpdateManagedGiveawayRequest,
} from '@maxim/contracts';

export type SendBroadcastPayload = {
  text: string;
  textFormat: BroadcastTextFormat;
  targetMode: BroadcastTargetMode;
  targetChatIds: string[];
  applyToAllChats: boolean;
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
  mediaType?: 'video' | null;
  mediaPayload?: Record<string, unknown> | null;
  mediaMimeType?: string;
  mediaFileName?: string;
  scheduleMode: BroadcastScheduleMode;
  scheduleTimezone: string;
  scheduledSlots: string[];
  replaceConflictingSlots?: boolean;
  sendAt: string | null;
  cycleEnabled: boolean;
  cycleEveryHours: number;
  cycleCount: number;
};

export type UpdateManagedBroadcastPayload = SendBroadcastPayload;
export type UpdateManagedGiveawayPayload = UpdateManagedGiveawayRequest;

export type ManagedGiveawayHandoffPayload = {
  giveawayId: string | null;
};

export type BroadcastHandoffPayload = {
  targetMode: BroadcastTargetMode;
  targetChatIds: string[];
  applyToAllChats: boolean;
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
  scheduleMode: BroadcastScheduleMode;
  scheduleTimezone: string;
  scheduledSlots: string[];
  replaceConflictingSlots?: boolean;
  sendAt: string | null;
  cycleEnabled: boolean;
  cycleEveryHours: number;
  cycleCount: number;
};

export type CreateChannelDialogMessagePayload = {
  token: string;
  text: string;
  replyToMessageId?: string | null;
  attachments?: Array<{
    type: 'image' | 'file';
    base64: string;
    mimeType: string;
    fileName: string;
    width?: number;
    height?: number;
  }>;
  images?: Array<{
    base64: string;
    mimeType: string;
    fileName: string;
  }>;
  imageBase64?: string;
  imageMimeType?: string;
  imageFileName?: string;
};

export type ToggleChannelDialogReactionPayload = {
  token: string;
  emoji: string;
};

export type UpdateChannelDialogMessagePayload = {
  token: string;
  text: string;
};

export type DeleteChannelDialogMessagePayload = {
  token: string;
};

export type UpdateChatRulesPayload = Pick<
  ChatRules,
  | 'text'
  | 'imageBase64'
  | 'imageMimeType'
  | 'imageFileName'
  | 'autoTextEnabled'
  | 'buttons'
  | 'buttonEnabled'
  | 'buttonUrl'
  | 'buttonText'
>;
