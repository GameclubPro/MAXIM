import { ManagedEntitiesDiscoveryService } from './managed-entities-discovery.service';

describe('ManagedEntitiesDiscoveryService', () => {
  it('keeps managed entity refresh jobs behind the discovery boundary', async () => {
    const managedEntitiesService = {
      processManagedEntitiesRefreshJob: jest.fn().mockResolvedValue({ continueAfterMs: 5_000 }),
      listChatsWithRefreshState: jest.fn(),
      listChannelsWithRefreshState: jest.fn(),
    };
    const service = new ManagedEntitiesDiscoveryService(managedEntitiesService as never);

    await expect(
      service.processManagedEntitiesRefreshJob({
        entityType: 'chat',
        userId: 'user-1',
        cursor: null,
      } as never),
    ).resolves.toEqual({ continueAfterMs: 5_000 });
    expect(managedEntitiesService.processManagedEntitiesRefreshJob).toHaveBeenCalled();
  });
});
