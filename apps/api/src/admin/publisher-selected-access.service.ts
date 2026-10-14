import { ForbiddenException, Injectable } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';

// FLAG: Rollback readers must retain positive authority without timestamp expiry.
export const PUBLISHER_DURABLE_ACTOR_AUTHORITY_VERSION = 1;

@Injectable()
export class PublisherSelectedAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MaxBotRegistryService,
  ) {}

  async assertAccess(user: AuthUser, chatId: string, entityType: ManagedEntityType): Promise<void> {
    const botId = this.registry.getPublisherBotDescriptor().id;
    // FLAG: A confirmed exact-bot human grant survives TTL and session changes. Read SQL on
    // every command so explicit MAX revocation wins; never restore authority from history.
    // Connection, catalog and feature-policy guards remain the caller's independent boundary.
    const edge = await this.prisma.managedEntityAccessEdge.findUnique({
      where: { chatId_userId_botId: { chatId, userId: user.userId, botId } },
      select: { entityType: true, state: true, userRole: true },
    });
    if (
      !edge ||
      edge.entityType !== (entityType === 'chat' ? 'CHAT' : 'CHANNEL') ||
      edge.state !== 'GRANTED' ||
      !['ADMIN', 'OWNER'].includes(edge.userRole)
    ) {
      throw new ForbiddenException('Нет подтверждённых прав администратора этого чата или канала.');
    }
  }
}
