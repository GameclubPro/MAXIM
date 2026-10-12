import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherBindingRefreshQueueService } from '../publisher/publisher-binding-refresh.queue';

const PROOF_REUSE_MS = 30_000;
const MAX_IN_FLIGHT = 256;
const READ_DELAYS_MS = [100, 200, 400, 800, 1000, 1500, 1500];

@Injectable()
export class PublisherSelectedAccessService {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MaxBotRegistryService,
    private readonly queue: PublisherBindingRefreshQueueService,
  ) {}

  async assertAccess(user: AuthUser, chatId: string, entityType: ManagedEntityType): Promise<void> {
    const botId = this.registry.getPublisherBotDescriptor().id;
    const boundary = Math.max(
      user.accessCheckedAfter ?? 0,
      Math.floor(Date.now() / PROOF_REUSE_MS) * PROOF_REUSE_MS,
    );
    const key = JSON.stringify([user.userId, chatId, botId, entityType, boundary]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= MAX_IN_FLIGHT) throw this.unavailable();
    const task = this.verify(user.userId, chatId, botId, entityType, boundary);
    this.inFlight.set(key, task);
    try {
      await task;
    } finally {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    }
  }

  private async verify(
    userId: string,
    chatId: string,
    botId: string,
    entityType: ManagedEntityType,
    boundary: number,
  ): Promise<void> {
    const read = () =>
      this.prisma.managedEntityAccessEdge.findUnique({
        where: { chatId_userId_botId: { chatId, userId, botId } },
        select: {
          entityType: true,
          state: true,
          userRole: true,
          checkedAt: true,
          expiresAt: true,
          lastAdminConfirmedAt: true,
          sourceVersion: true,
        },
      });
    type Edge = Awaited<ReturnType<typeof read>>;
    const checked = (edge: Edge): boolean => {
      if (!edge || edge.entityType !== (entityType === 'chat' ? 'CHAT' : 'CHANNEL'))
        throw new ForbiddenException('Нет доступа к этому чату или каналу.');
      const positive = edge.state === 'GRANTED' && ['ADMIN', 'OWNER'].includes(edge.userRole);
      // FLAG: Old positive evidence admits one selected probe, never settings access.
      // Neither an arbitrary id nor an unconfirmed candidate can create MAX work.
      if (!positive && !edge.lastAdminConfirmedAt)
        throw new ForbiddenException('Нет доступа к этому чату или каналу.');
      if (edge.checkedAt.getTime() < boundary || edge.checkedAt.getTime() > Date.now())
        return false;
      if (!positive) throw new ForbiddenException('Права администратора больше не подтверждены.');
      return edge.expiresAt === null || edge.expiresAt.getTime() > Date.now();
    };
    const before = await read();
    if (checked(before)) return;
    try {
      const queued = await this.queue.enqueue({
        chatId,
        publisherBotId: botId,
        candidateUserId: userId,
        candidateVersion: before!.sourceVersion,
        reason: 'selected_actor_access',
        requestedAt: new Date(boundary),
      });
      if (!queued) throw this.unavailable();
    } catch {
      throw this.unavailable();
    }
    // FLAG: Bounded exact-key reads wait for the token-owning Publisher worker.
    // No token crosses roles, no old grant authorizes a timeout, and no list is scanned.
    for (const delay of READ_DELAYS_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (checked(await read())) return;
    }
    throw this.unavailable();
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'PUBLISHER_SELECTED_ACCESS_PENDING',
      message: 'Не удалось подтвердить права в MAX. Повторите проверку.',
    });
  }
}
