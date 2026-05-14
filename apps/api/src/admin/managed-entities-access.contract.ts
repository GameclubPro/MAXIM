import type {
  ChatSummary,
  ManagedEntitiesListResponse,
  ManagedEntityFavoriteType,
  ManagedEntityType,
} from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { AdminManagedEntitiesRefreshJob } from './admin-managed-entities-refresh.queue';

export type ManagedEntitiesScope = ManagedEntityType | 'all';

export type ManagedEntitiesAccessReadOptions = {
  bypassRemoteCache?: boolean;
  includeRefreshState?: boolean;
  resetRefreshCursor?: boolean;
};

export type ManagedEntityFavoritesUpdate = {
  favoriteTypes: ManagedEntityFavoriteType[];
};

export type ManagedEntitiesRefreshJobOutcome = {
  continueAfterMs: number;
} | null;

export interface ManagedEntitiesAccessReader {
  listManagedEntities(
    user: AuthUser,
    entityType?: ManagedEntitiesScope,
    options?: ManagedEntitiesAccessReadOptions,
  ): Promise<ChatSummary[] | ManagedEntitiesListResponse>;
}

export interface ManagedEntitiesAccessWriter {
  updateManagedEntityFavorites(
    user: AuthUser,
    entityType: ManagedEntityType,
    entityId: string,
    body: ManagedEntityFavoritesUpdate,
  ): Promise<unknown>;

  processManagedEntitiesRefreshJob(
    job: AdminManagedEntitiesRefreshJob,
  ): Promise<ManagedEntitiesRefreshJobOutcome>;
}
