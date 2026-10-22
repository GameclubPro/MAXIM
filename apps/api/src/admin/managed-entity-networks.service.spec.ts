import { BadRequestException } from '@nestjs/common';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ManagedEntityNetworksService } from './managed-entity-networks.service';

describe('managed network request boundary', () => {
  it('rejects malformed entity types with HTTP 400 before querying storage', async () => {
    const transaction = jest.fn();
    const prisma: Pick<PrismaService, '$transaction'> = { $transaction: transaction };
    const registry: Pick<MaxBotRegistryService, 'getAllBots'> = { getAllBots: jest.fn() };
    const service = new ManagedEntityNetworksService(
      prisma as PrismaService,
      registry as MaxBotRegistryService,
    );
    const user = { userId: 'actor', username: null, displayName: null };
    for (const type of ['mixed', 'CHAT', '', 'chat,channel']) {
      for (const operation of [
        () => service.catalogue(user, type),
        () => service.entries(user, type, {}),
        () => service.updateComposition(user, type, { changes: [] }),
      ]) {
        await expect(operation()).rejects.toBeInstanceOf(BadRequestException);
      }
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(registry.getAllBots).not.toHaveBeenCalled();
  });
});
