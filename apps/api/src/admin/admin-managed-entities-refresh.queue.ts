export const ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE = 'admin-managed-entities-refresh';

export type AdminManagedEntitiesRefreshJob = {
  userId: string;
  entityType: 'chat' | 'channel' | 'all';
  bypassRemoteCache: boolean;
  resetRefreshCursor: boolean;
};
