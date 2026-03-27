import type {
  BroadcastScheduleMode,
  BroadcastTextFormat,
  ChatRules,
  UpdateManagedGiveawayRequest,
} from '@maxim/contracts';

export type SendBroadcastPayload = {
  text: string;
  textFormat: BroadcastTextFormat;
  applyToAllChats: boolean;
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
  scheduleMode: BroadcastScheduleMode;
  scheduleTimezone: string;
  scheduledSlots: string[];
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
  applyToAllChats: boolean;
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
  scheduleMode: BroadcastScheduleMode;
  scheduleTimezone: string;
  scheduledSlots: string[];
  sendAt: string | null;
  cycleEnabled: boolean;
  cycleEveryHours: number;
  cycleCount: number;
};

export type CreateChannelDialogMessagePayload = {
  token: string;
  text: string;
  replyToMessageId?: string | null;
  imageBase64?: string;
  imageMimeType?: string;
  imageFileName?: string;
};

export type ToggleChannelDialogReactionPayload = {
  token: string;
  emoji: string;
};

export type UpdateChatRulesPayload = Pick<
  ChatRules,
  | 'text'
  | 'imageBase64'
  | 'imageMimeType'
  | 'imageFileName'
  | 'autoTextEnabled'
  | 'buttonEnabled'
  | 'buttonUrl'
  | 'buttonText'
>;
