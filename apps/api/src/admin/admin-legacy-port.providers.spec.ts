import type { Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import { AdminModule } from './admin.module';
import { AdminService } from './admin.service';
import { CHANNEL_DIALOG_LEGACY_PORT } from './channel-dialog-legacy.port';
import { ChannelDialogService } from './channel-dialog.service';
import { MANAGED_ENTITIES_LEGACY_PORT } from './managed-entities-legacy.port';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { ManagedEntitiesService } from './managed-entities.service';

type ExistingProvider = {
  provide: symbol;
  useExisting: typeof AdminService;
};

type ManagedBroadcastFactoryProvider = {
  provide: typeof ManagedBroadcastService;
  inject: [typeof AdminService];
  useFactory: (adminService: AdminService) => ManagedBroadcastService;
};

function readAdminProviders(): Provider[] {
  return (
    (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminModule) as Provider[] | undefined) ?? []
  );
}

function requireExistingProvider(providers: Provider[], token: symbol): ExistingProvider {
  const provider = providers.find(
    (candidate): candidate is ExistingProvider =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'provide' in candidate &&
      candidate.provide === token &&
      'useExisting' in candidate,
  );
  if (!provider) {
    throw new Error(`Missing useExisting provider for ${token.description ?? 'legacy port'}`);
  }
  return provider;
}

function requireManagedBroadcastFactory(providers: Provider[]): ManagedBroadcastFactoryProvider {
  const provider = providers.find(
    (candidate): candidate is ManagedBroadcastFactoryProvider =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'provide' in candidate &&
      candidate.provide === ManagedBroadcastService &&
      'useFactory' in candidate,
  );
  if (!provider) {
    throw new Error('Missing ManagedBroadcastService factory provider');
  }
  return provider;
}

describe('Admin legacy facade ports', () => {
  it('binds managed entities and channel dialog ports to the existing AdminService instance', async () => {
    const providers = readAdminProviders();
    expect(providers).toContain(ManagedEntitiesService);
    expect(providers).toContain(ChannelDialogService);

    const managedEntitiesProvider = requireExistingProvider(
      providers,
      MANAGED_ENTITIES_LEGACY_PORT,
    );
    const channelDialogProvider = requireExistingProvider(providers, CHANNEL_DIALOG_LEGACY_PORT);
    expect(managedEntitiesProvider.useExisting).toBe(AdminService);
    expect(channelDialogProvider.useExisting).toBe(AdminService);

    const legacyAdminService = { marker: 'legacy-admin-service' };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: AdminService, useValue: legacyAdminService },
        managedEntitiesProvider,
        channelDialogProvider,
      ],
    }).compile();

    expect(moduleRef.get(MANAGED_ENTITIES_LEGACY_PORT)).toBe(legacyAdminService);
    expect(moduleRef.get(CHANNEL_DIALOG_LEGACY_PORT)).toBe(legacyAdminService);
    await moduleRef.close();
  });

  it('builds the broadcast facade from safe AdminService methods without exporting its runtime', async () => {
    const providers = readAdminProviders();
    const managedBroadcastProvider = requireManagedBroadcastFactory(providers);
    const processDueDeadlinePublicationBroadcasts = jest.fn().mockResolvedValue(undefined);
    const legacyAdminService = { processDueDeadlinePublicationBroadcasts };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: AdminService, useValue: legacyAdminService },
        managedBroadcastProvider,
      ],
    }).compile();

    const broadcastService = moduleRef.get(ManagedBroadcastService);
    await broadcastService.processDueDeadlinePublicationBroadcasts(7);

    expect(managedBroadcastProvider.inject).toEqual([AdminService]);
    expect(processDueDeadlinePublicationBroadcasts).toHaveBeenCalledWith(7);
    expect(
      providers.some(
        (provider) =>
          provider === AdminManagedBroadcastRuntime ||
          (typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === AdminManagedBroadcastRuntime),
      ),
    ).toBe(false);
    await moduleRef.close();
  });
});
