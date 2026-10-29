import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { MaxClientService } from '../../max/max-client.service';
import { MaxBotRegistryService } from '../../max/max-bot-registry.service';
import { karavanHash } from './karavan-marketplace-authority.service';
import type { Prisma } from '../../prisma/prisma-client';

export const karavanMarketplaceBindingStatusRequestSchema = z
  .object({
    chatId: z.string().regex(/^-?\d{1,24}$/u),
    botId: z.string().min(1).max(128),
    authorityEpoch: z.string().regex(/^[a-f0-9]{64}$/u),
    verifiedAt: z.string().datetime(),
  })
  .strict();
type Request = z.infer<typeof karavanMarketplaceBindingStatusRequestSchema>;
type Status = {
  active: boolean;
  checkedAt: string;
  expiresAt: string;
  reason: 'active' | 'bot_unavailable' | 'binding_changed';
};
const TTL_MS = 10_000;

@Injectable()
export class KaravanMarketplaceBindingStatusService {
  private readonly cache = new Map<string, { epoch: string; status: Status }>();
  private readonly inFlight = new Map<string, Promise<Status>>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly registry: MaxBotRegistryService,
    private readonly config: ConfigService,
  ) {}
  async status(raw: unknown): Promise<Status> {
    if (!this.config.get<boolean>('KARAVAN_MARKETPLACE_ENABLED'))
      throw new ServiceUnavailableException('Модуль магазина недоступен.');
    const input = karavanMarketplaceBindingStatusRequestSchema.parse(raw);
    const local = await this.local(input);
    if (!local) return this.result(false, 'binding_changed');
    const key = karavanHash(input);
    const cached = this.cache.get(key);
    if (cached && cached.epoch === local && Date.parse(cached.status.expiresAt) > Date.now())
      return cached.status;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if (this.inFlight.size >= 32)
      throw new ServiceUnavailableException('Проверка магазина занята.');
    const task = this.probe(input, local)
      .then((status) => {
        if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { epoch: local, status });
        return status;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }
  private result(active: boolean, reason: Status['reason'], checkedAt = new Date()): Status {
    return {
      active,
      reason,
      checkedAt: checkedAt.toISOString(),
      expiresAt: new Date(checkedAt.getTime() + TTL_MS).toISOString(),
    };
  }
  private async local(input: Request): Promise<string | null> {
    return this.prisma.$transaction((tx) => this.localEpoch(tx, input));
  }
  async isCurrent(tx: Prisma.TransactionClient, input: Request): Promise<boolean> {
    return (await this.localEpoch(tx, input)) !== null;
  }
  private async localEpoch(tx: Prisma.TransactionClient, input: Request): Promise<string | null> {
    if (!this.registry.getActionableBots().some((bot) => bot.id === input.botId)) return null;
    await tx.$queryRaw`SELECT id FROM chats WHERE id=${input.chatId} FOR SHARE`;
    const witness = await tx.karavanMarketplaceBindingWitness.findUnique({
      where: {
        authorityEpoch_checkedAt: {
          authorityEpoch: input.authorityEpoch,
          checkedAt: new Date(input.verifiedAt),
        },
      },
    });
    const chat = await tx.chat.findUnique({
      where: { id: input.chatId },
      select: {
        entityType: true,
        fixedModeratorBotId: true,
        primaryBotId: true,
        botId: true,
        routingVersion: true,
      },
    });
    const membership = await tx.chatBotMembership.findUnique({
      where: { chatId_botId: { chatId: input.chatId, botId: input.botId } },
      select: {
        status: true,
        commerceRevocationEpoch: true,
        botAccessState: true,
        botAccessCheckedAt: true,
        lifecycleEventAt: true,
      },
    });
    if (
      !witness ||
      witness.revokedAt ||
      witness.chatId !== input.chatId ||
      witness.botId !== input.botId ||
      chat?.entityType !== 'CHAT' ||
      (chat.fixedModeratorBotId ?? chat.primaryBotId ?? chat.botId) !== input.botId ||
      witness.routingVersion !== chat.routingVersion ||
      membership?.status !== 'ACTIVE' ||
      witness.botRevocationEpoch !== membership.commerceRevocationEpoch ||
      (witness.lifecycleEventAt?.getTime() ?? null) !==
        (membership.lifecycleEventAt?.getTime() ?? null) ||
      ['DENIED', 'LOST'].includes(membership.botAccessState)
    )
      return null;
    return karavanHash({
      routingVersion: chat.routingVersion,
      membership: JSON.parse(JSON.stringify(membership)),
    });
  }
  private async probe(input: Request, local: string): Promise<Status> {
    const started = new Date();
    const options = {
      botId: input.botId,
      bypassCache: true,
      trafficClass: 'interactive' as const,
      sourceTag: 'karavan_marketplace_binding_status',
      timeoutMs: 1_800,
    };
    const reads = await Promise.allSettled([
      this.max.getChatSnapshot(input.chatId, options),
      this.max.getCurrentChatMemberAccess(input.chatId, options),
    ]);
    if (reads.some((read) => read.status !== 'fulfilled'))
      throw new ServiceUnavailableException('MAX не подтвердил доступность магазина.');
    const snapshot = reads[0].status === 'fulfilled' ? reads[0].value : null;
    const bot = reads[1].status === 'fulfilled' ? reads[1].value : null;
    if (!snapshot || !bot)
      throw new ServiceUnavailableException('MAX не подтвердил доступность магазина.');
    const active =
      snapshot.chatId === input.chatId &&
      snapshot.entityType === 'chat' &&
      (bot.isAdmin || bot.isOwner) &&
      bot.explicitPrivilegeEvidence === true;
    if (!active) {
      if (
        snapshot.chatId !== input.chatId ||
        snapshot.entityType !== 'chat' ||
        bot.isAdmin ||
        bot.isOwner ||
        bot.explicitNonPrivilegeEvidence !== true
      )
        throw new ServiceUnavailableException('MAX не подтвердил доступность магазина.');
      await this.prisma.karavanMarketplaceBindingWitness.updateMany({
        where: {
          authorityEpoch: input.authorityEpoch,
          checkedAt: new Date(input.verifiedAt),
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      return this.result(false, 'bot_unavailable', started);
    }
    if (Date.now() - started.getTime() >= TTL_MS || (await this.local(input)) !== local)
      return this.result(false, 'binding_changed', started);
    return this.result(true, 'active', started);
  }
}
