import type { Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AdminModule } from './admin.module';
import { AdminService } from './admin.service';
import { CHANNEL_DIALOG_LEGACY_PORT } from './channel-dialog-legacy.port';
import { ChannelDialogService } from './channel-dialog.service';
import { MANAGED_ENTITIES_LEGACY_PORT } from './managed-entities-legacy.port';
import { ManagedEntitiesService } from './managed-entities.service';

type ExistingProvider = {
  provide: symbol;
  useExisting: typeof AdminService;
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
});
