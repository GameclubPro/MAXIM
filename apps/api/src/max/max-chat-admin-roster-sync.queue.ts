export const MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE = 'max-chat-admin-roster-sync';

export type MaxChatAdminRosterSyncJob = {
  chatId: string;
  botIds?: string[];
  title?: string | null;
  entityType?: 'chat' | 'channel' | null;
};
