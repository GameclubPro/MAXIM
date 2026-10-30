import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
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
type BindingRefusal =
  | 'bot_unregistered'
  | 'witness_missing'
  | 'witness_revoked'
  | 'witness_scope_changed'
  | 'chat_type_changed'
  | 'selected_bot_changed'
  | 'legacy_route_changed'
  | 'route_authority_changed'
  | 'membership_inactive'
  | 'bot_revoked'
  | 'lifecycle_changed'
  | 'bot_access_denied';

@Injectable()
export class KaravanMarketplaceBindingStatusService {
  private readonly logger = new Logger(KaravanMarketplaceBindingStatusService.name);
  private readonly refusalTimes = new Map<string, number>();
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
  private refuse(input: Request, reason: BindingRefusal): null {
    const chatRef = karavanHash({ chatId: input.chatId }).slice(0, 16);
    const key = `${chatRef}:${reason}`;
    const now = Date.now();
    if (now - (this.refusalTimes.get(key) ?? 0) >= 60_000) {
      if (this.refusalTimes.size >= 256)
        this.refusalTimes.delete(this.refusalTimes.keys().next().value!);
      this.refusalTimes.set(key, now);
      // FLAG: Diagnose the existing read only; never log proof tokens, user/chat IDs,
      // names or state snapshots, and never probe or send messages to a user chat.
      this.logger.warn({ event: 'karavan_marketplace_binding_refused', chatRef, reason });
    }
    return null;
  }
  private async localEpoch(tx: Prisma.TransactionClient, input: Request): Promise<string | null> {
    if (!this.registry.getActionableBots().some((bot) => bot.id === input.botId))
      return this.refuse(input, 'bot_unregistered');
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
        commerceRoutingEpoch: true,
      },
    });
    const membership = await tx.chatBotMembership.findUnique({
      where: { chatId_botId: { chatId: input.chatId, botId: input.botId } },
      select: {
        status: true,
        commerceRevocationEpoch: true,
        botAccessState: true,
        lifecycleEventAt: true,
        lifecycleEventType: true,
        lifecycleSource: true,
      },
    });
    if (!witness) return this.refuse(input, 'witness_missing');
    if (witness.revokedAt) return this.refuse(input, 'witness_revoked');
    if (witness.chatId !== input.chatId || witness.botId !== input.botId)
      return this.refuse(input, 'witness_scope_changed');
    if (chat?.entityType !== 'CHAT') return this.refuse(input, 'chat_type_changed');
    if ((chat.fixedModeratorBotId ?? chat.primaryBotId ?? chat.botId) !== input.botId)
      return this.refuse(input, 'selected_bot_changed');
    // FLAG: Old witnesses have no stable route history. Preserve their strict legacy
    // check; new witnesses survive cache refreshes but fence real switch-away-and-back.
    if (
      witness.routingAuthorityEpoch === null
        ? witness.routingVersion !== chat.routingVersion
        : witness.routingAuthorityEpoch !== chat.commerceRoutingEpoch
    )
      return this.refuse(
        input,
        witness.routingAuthorityEpoch === null ? 'legacy_route_changed' : 'route_authority_changed',
      );
    if (membership?.status !== 'ACTIVE') return this.refuse(input, 'membership_inactive');
    if (witness.botRevocationEpoch !== membership.commerceRevocationEpoch)
      return this.refuse(input, 'bot_revoked');
    if (
      (witness.lifecycleEventAt?.getTime() ?? null) !==
        (membership.lifecycleEventAt?.getTime() ?? null) &&
      !(
        membership.lifecycleEventType === 'live_probe' &&
        membership.lifecycleSource === 'live_probe'
      )
    )
      return this.refuse(input, 'lifecycle_changed');
    if (['DENIED', 'LOST'].includes(membership.botAccessState))
      return this.refuse(input, 'bot_access_denied');
    return karavanHash({
      routingAuthorityEpoch: witness.routingAuthorityEpoch ?? chat.routingVersion,
      // FLAG: Positive observation timestamps are not revocations. The database epoch
      // retains real removal/denial/lifecycle changes even after a later positive probe.
      botRevocationEpoch: membership.commerceRevocationEpoch,
      botAccessState: membership.botAccessState,
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
    if (Date.now() - started.getTime() >= TTL_MS)
      throw new ServiceUnavailableException('Проверка магазина устарела. Повторите позже.');
    if ((await this.local(input)) !== local) return this.result(false, 'binding_changed', started);
    return this.result(true, 'active', started);
  }
}
