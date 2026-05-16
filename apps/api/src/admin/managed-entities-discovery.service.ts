import { Injectable } from '@nestjs/common';
import { ManagedEntitiesService } from './managed-entities.service';

@Injectable()
export class ManagedEntitiesDiscoveryService {
  constructor(private readonly managedEntitiesService: ManagedEntitiesService) {}

  listChatsWithRefreshState(
    ...args: Parameters<ManagedEntitiesService['listChatsWithRefreshState']>
  ): ReturnType<ManagedEntitiesService['listChatsWithRefreshState']> {
    return this.managedEntitiesService.listChatsWithRefreshState(...args);
  }

  listChannelsWithRefreshState(
    ...args: Parameters<ManagedEntitiesService['listChannelsWithRefreshState']>
  ): ReturnType<ManagedEntitiesService['listChannelsWithRefreshState']> {
    return this.managedEntitiesService.listChannelsWithRefreshState(...args);
  }

  processManagedEntitiesRefreshJob(
    ...args: Parameters<ManagedEntitiesService['processManagedEntitiesRefreshJob']>
  ): ReturnType<ManagedEntitiesService['processManagedEntitiesRefreshJob']> {
    return this.managedEntitiesService.processManagedEntitiesRefreshJob(...args);
  }
}
