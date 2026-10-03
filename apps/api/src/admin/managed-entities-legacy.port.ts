import type {
  ManagedEntitiesRefreshState,
  ManagedEntityHeader,
  ManagedEntityType,
} from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type {
  AdminReadBypassOptions,
  ManagedEntitiesListOptions,
  ManagedEntitiesListResult,
  ManagedEntitiesRefreshJobOutcome,
  ManagedEntityTypeFilter,
  ResolvedUserProfile,
  ResolveUserProfilesOptions,
} from './admin.service.support';

export const MANAGED_ENTITIES_LEGACY_PORT = Symbol('MANAGED_ENTITIES_LEGACY_PORT');

export type ManagedEntitiesLegacyPort = {
  assertManagedEntityAdminAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<void>;
  assertManagedEntityReadAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    options?: AdminReadBypassOptions,
  ): Promise<void>;
  attachManagedEntityHeaderBotAssignmentsForManagedEntities(
    header: ManagedEntityHeader,
  ): Promise<ManagedEntityHeader>;
  createIdleManagedEntitiesRefreshStateForManagedEntities(): ManagedEntitiesRefreshState;
  listManagedEntitiesDetailedForManagedEntities(
    user: AuthUser,
    entityType?: ManagedEntityTypeFilter,
    options?: ManagedEntitiesListOptions,
  ): Promise<ManagedEntitiesListResult>;
  resolveManagedEntityHeaderReadBotId(chatId: string): Promise<string | undefined>;
  resolveUserProfilesForAdminSurface(
    chatId: string,
    entityType: ManagedEntityType,
    userIds: readonly string[],
    options?: ResolveUserProfilesOptions,
  ): Promise<Map<string, ResolvedUserProfile>>;
  runManagedEntitiesBoundedRefreshForManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options?: { bypassRemoteCache?: boolean; resetRefreshCursor?: boolean },
  ): Promise<ManagedEntitiesRefreshJobOutcome>;
};
