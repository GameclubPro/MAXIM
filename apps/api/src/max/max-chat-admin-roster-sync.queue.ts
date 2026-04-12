export const MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE = 'max-chat-admin-roster-sync';

export type MaxChatAdminRosterSyncJob = {
  chatId: string;
  botIds?: string[];
  title?: string | null;
  entityType?: 'chat' | 'channel' | null;
  source?:
    | 'webhook_bot_added'
    | 'webhook_bot_removed'
    | 'webhook_chat_title_changed'
    | 'webhook_membership_churn'
    | 'discovery_snapshot'
    | null;
  retryUntilMs?: number | null;
};
