import type { PublicationTargetsRefreshResponse } from '@maxim/contracts/publication';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationDispatchProfile } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  publicationAdminAccessWhere,
  publicationAdminScope,
  publicationAdminTargetWhere,
} from './publication-admin-access';
import { PublisherEntityRefreshService } from './publisher-entity-refresh.service';

@Injectable()
export class PublicationPublisherTargetRefreshService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entityRefresh: PublisherEntityRefreshService,
  ) {}

  async request(publicationId: string, user: AuthUser): Promise<PublicationTargetsRefreshResponse> {
    const publication = await this.prisma.publication.findFirst({
      where: {
        id: publicationId,
        ...publicationAdminAccessWhere(
          publicationAdminScope(user.userId),
          PublicationDispatchProfile.PUBLIK_V1,
        ),
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      },
      select: {
        targets: {
          where: publicationAdminTargetWhere(publicationAdminScope(user.userId)),
          orderBy: { position: 'asc' },
          select: { targetChatId: true },
        },
      },
    });
    if (!publication) {
      throw new NotFoundException('Публикация не найдена.');
    }

    return this.entityRefresh.requestAuthorizedEntitiesRefresh(
      publication.targets.map((target) => target.targetChatId),
      user,
    );
  }
}
