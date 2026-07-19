import type { AdminService } from './admin.service';

export const MANAGED_ENTITIES_LEGACY_PORT = Symbol('MANAGED_ENTITIES_LEGACY_PORT');

export type ManagedEntitiesLegacyPort = Pick<
  AdminService,
  | 'assertManagedEntityAdminAccess'
  | 'assertManagedEntityReadAccess'
  | 'attachManagedEntityHeaderBotAssignmentsForManagedEntities'
  | 'createIdleManagedEntitiesRefreshStateForManagedEntities'
  | 'listManagedEntitiesDetailedForManagedEntities'
  | 'resolveManagedEntityHeaderReadBotId'
  | 'runManagedEntitiesBoundedRefreshForManagedEntities'
>;
