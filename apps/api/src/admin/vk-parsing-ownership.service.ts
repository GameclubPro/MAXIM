import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { VkParsingOwnerProfile } from '../prisma/prisma-client';

export type VkParsingOwnerScope = Readonly<{
  ownerProfile: typeof VkParsingOwnerProfile.PUBLISHER;
  ownerBotId: string;
}>;

type VkParsingOwnerRow = Readonly<{
  ownerProfile: VkParsingOwnerProfile;
  ownerBotId: string;
}>;

@Injectable()
export class VkParsingOwnershipService {
  private readonly publisherScope: VkParsingOwnerScope;

  constructor(configService: ConfigService) {
    const publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
    this.publisherScope = Object.freeze({
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: publisherBotId,
    });
  }

  getPublisherScope(): VkParsingOwnerScope {
    return this.publisherScope;
  }

  fromRow(row: VkParsingOwnerRow): VkParsingOwnerScope {
    const ownerBotId = row.ownerBotId.trim();
    if (row.ownerProfile !== VkParsingOwnerProfile.PUBLISHER || !ownerBotId) {
      throw new Error('Publisher-owned VK scope is required');
    }
    return Object.freeze({
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId,
    });
  }

  isExactScope(row: VkParsingOwnerRow, scope: VkParsingOwnerScope): boolean {
    return row.ownerProfile === scope.ownerProfile && row.ownerBotId === scope.ownerBotId;
  }
}
