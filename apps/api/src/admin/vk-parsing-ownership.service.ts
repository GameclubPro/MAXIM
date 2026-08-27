import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { VkParsingOwnerProfile } from '../prisma/prisma-client';

export type VkParsingOwnerScope = Readonly<{
  ownerProfile: VkParsingOwnerProfile;
  ownerBotId: string;
}>;

export const MAJOR_VK_OWNER_SCOPE: VkParsingOwnerScope = Object.freeze({
  ownerProfile: VkParsingOwnerProfile.MAJOR,
  ownerBotId: '',
});

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

  fromRow(row: Pick<VkParsingOwnerScope, 'ownerProfile' | 'ownerBotId'>): VkParsingOwnerScope {
    return row.ownerProfile === VkParsingOwnerProfile.PUBLISHER
      ? Object.freeze({
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: row.ownerBotId.trim(),
        })
      : MAJOR_VK_OWNER_SCOPE;
  }

  isExactScope(
    row: Pick<VkParsingOwnerScope, 'ownerProfile' | 'ownerBotId'>,
    scope: VkParsingOwnerScope,
  ): boolean {
    return row.ownerProfile === scope.ownerProfile && row.ownerBotId === scope.ownerBotId;
  }
}
