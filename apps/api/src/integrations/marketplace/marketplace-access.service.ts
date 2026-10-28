import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  type OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  marketplaceBindingInputSchema,
  marketplaceBindingMetadataSchema,
  type MarketplaceBindingInput,
} from '@maxim/contracts/marketplace-integration';
import { ManagedEntitiesService } from '../../admin/managed-entities.service';
import { MaxClientService } from '../../max/max-client.service';
import { isMajorManagedEntityActivationRequired } from '../../max/managed-entity-activation.util';
import { isPublisherManagedEntityActivationRequired } from '../../publisher/publisher-entity-connection.util';
import { PrismaService } from '../../prisma/prisma.service';
import { getAppRole, roleRunsPublisher } from '../../runtime/app-role';
import { PublisherIdentityAttestationService } from '../../publisher/publisher-identity-attestation.service';
import { ConfigService } from '@nestjs/config';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { statisticsExchangeActorAllowed } from './statistics-exchange.settings';
import { MarketplacePublisherAccessQueueService } from './marketplace-publisher-access.queue';
import {
  MARKETPLACE_GRANT_MS,
  MarketplaceStateService,
  type MarketplaceBindingRow,
} from './marketplace-state.service';

@Injectable()
export class MarketplaceAccessService implements OnModuleDestroy {
  private backgroundInFlight: Promise<MarketplaceBindingRow> | null = null;
  private nextBackgroundAt = 0;
  private stopping = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly entities: ManagedEntitiesService,
    private readonly max: MaxClientService,
    private readonly state: MarketplaceStateService,
    @Optional() private readonly publisherQueue?: MarketplacePublisherAccessQueueService,
    @Optional() private readonly publisherIdentity?: PublisherIdentityAttestationService,
    @Optional() private readonly config?: ConfigService,
    @Optional()
    @Inject(BackgroundRuntimeGovernorService)
    private readonly governor?: Pick<BackgroundRuntimeGovernorService, 'decide'>,
  ) {}
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.backgroundInFlight?.catch(() => undefined);
  }
  async attest(
    raw: unknown,
    exchangeV2 = false,
    background = false,
  ): Promise<MarketplaceBindingRow> {
    if (this.stopping) throw this.pendingAccess();
    if (!background) return this.attestNow(raw, exchangeV2, false);
    // FLAG: Background access never queues in memory or borrows interactive capacity.
    // Deferral cannot renew a lease or turn unknown rights into denial or permission.
    if (this.backgroundInFlight || Date.now() < this.nextBackgroundAt) throw this.pendingAccess();
    const operation = this.attestBackground(raw, exchangeV2);
    this.backgroundInFlight = operation;
    try {
      return await operation;
    } finally {
      this.backgroundInFlight = null;
    }
  }
  private pendingAccess(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'MARKETPLACE_ACCESS_PENDING',
      message: 'Проверка доступа отложена. Повторите позже.',
    });
  }
  private async attestBackground(
    raw: unknown,
    exchangeV2: boolean,
  ): Promise<MarketplaceBindingRow> {
    if (!this.governor) throw this.pendingAccess();
    const decision = await this.governor.decide({
      component: 'marketplace-access-refresh',
      sourceTag: 'marketplace_access_refresh',
    });
    if (decision.action !== 'run') this.nextBackgroundAt = Date.now() + decision.retryAfterMs;
    if (this.stopping || decision.action === 'pause') throw this.pendingAccess();
    return this.attestNow(raw, exchangeV2, true);
  }
  private async attestNow(
    raw: unknown,
    exchangeV2: boolean,
    background: boolean,
  ): Promise<MarketplaceBindingRow> {
    const input = marketplaceBindingInputSchema.parse(raw);
    if (!this.state.enabled()) throw new ServiceUnavailableException('Биржик пока не подключён');
    if (
      exchangeV2
        ? !this.config || !statisticsExchangeActorAllowed(this.config, input.actorUserId)
        : false
    )
      throw new ForbiddenException('Модуль пока недоступен');
    if (input.profile === 'publisher' && !roleRunsPublisher(getAppRole())) {
      if (!this.publisherQueue)
        throw new ServiceUnavailableException('Проверка прав Публика пока недоступна');
      const id = await (background
        ? this.publisherQueue.attest(input, exchangeV2, true)
        : exchangeV2
          ? this.publisherQueue.attest(input, true)
          : this.publisherQueue.attest(input));
      const binding = await this.state.read(id);
      if (
        !binding ||
        binding.actor_user_id !== input.actorUserId ||
        binding.entity_id !== input.entityId ||
        binding.kind !== input.kind ||
        binding.profile !== input.profile ||
        binding.state !== 'ACTIVE' ||
        !binding.valid_until ||
        binding.valid_until.getTime() <= Date.now()
      )
        throw new ServiceUnavailableException(
          'Права изменились во время проверки. Обновите состояние.',
        );
      return binding;
    }
    if (input.profile === 'publisher') {
      if (process.env.APP_SERVICE_NAME !== 'api-publisher' || !this.publisherIdentity)
        throw new ServiceUnavailableException('Проверка прав Публика пока недоступна');
      await this.publisherIdentity.assertAttested();
    }
    const started = new Date();
    let botId: string | undefined;
    if (input.profile === 'publisher') {
      const binding = await this.prisma.publisherEntityBinding.findUnique({
        where: { chatId: input.entityId },
        select: { publisherBotId: true, status: true },
      });
      if (!binding || binding.status !== 'ACTIVE')
        throw new ForbiddenException('Подключение Публика недоступно');
      botId = binding.publisherBotId;
    } else {
      await this.entities.assertManagedEntityAdminAccess(
        input.entityId,
        { userId: input.actorUserId, username: null, displayName: null },
        input.kind === 'CHAT' ? 'chat' : 'channel',
      );
      botId = await this.entities.resolveManagedEntityReadBotId(input.entityId);
    }
    const options = {
      botId,
      bypassCache: true,
      trafficClass: background ? ('background' as const) : ('interactive' as const),
      sourceTag: background ? 'marketplace_access_refresh' : 'marketplace_access',
      timeoutMs: 5_000,
    };
    const reads = [
      this.max.getChatSnapshot(input.entityId, options),
      this.max.getCurrentChatMemberAccess(input.entityId, options),
      this.max.getChatMemberAccess(input.entityId, input.actorUserId, options),
    ] as const;
    // FLAG: A failed sibling read must not release background admission while
    // the other exact-rights requests are still using the shared bot quota.
    if (background) await Promise.allSettled(reads);
    const [snapshot, bot, user] = await Promise.all(reads);
    if (!bot || !user) throw new ServiceUnavailableException('Не удалось подтвердить доступ в MAX');
    if (
      !(bot.isAdmin || bot.isOwner) ||
      !(user.isAdmin || user.isOwner) ||
      user.isBot !== false ||
      user.userId !== input.actorUserId
    ) {
      await this.deny(input, started);
      throw new ForbiddenException('Нужны действующие права администратора пользователя и бота');
    }
    if (
      snapshot.chatId !== input.entityId ||
      snapshot.entityType !== (input.kind === 'CHAT' ? 'chat' : 'channel')
    )
      throw new ForbiddenException('Тип площадки не совпадает');
    const resolvedBotId = botId ?? bot.userId;
    if (!resolvedBotId) throw new ServiceUnavailableException('Маршрут бота не подтверждён');
    const metadata = marketplaceBindingMetadataSchema.parse({
      title: (snapshot.title ?? 'Площадка').slice(0, 300),
      description: (snapshot.description ?? '').slice(0, 4000),
      imageUrl: snapshot.avatarUrl,
      publicUrl: snapshot.isPublic ? snapshot.link : null,
      audience: snapshot.participantsCount,
      isPublic: snapshot.isPublic === true,
    });
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chats WHERE id=${input.entityId} FOR UPDATE`;
      const newer = await tx.chatMembershipActivityEvent.findFirst({
        where: {
          chatId: input.entityId,
          userId: input.actorUserId,
          eventAt: { gte: started },
          eventType: { in: ['user_added', 'user_removed'] },
        },
        select: { id: true },
      });
      if (newer) throw new ConflictException('Права изменились во время проверки');
      const newerDenial = await tx.managedEntityAccessEdge.findFirst({
        where: {
          chatId: input.entityId,
          userId: input.actorUserId,
          botId: resolvedBotId,
          checkedAt: { gte: started },
          OR: [
            { state: { not: 'GRANTED' } },
            { userRole: { notIn: ['ADMIN', 'OWNER'] } },
            { botRole: { notIn: ['ADMIN', 'OWNER'] } },
          ],
        },
        select: { chatId: true },
      });
      if (newerDenial) throw new ConflictException('Права изменились во время проверки');
      const connection =
        input.profile === 'publisher'
          ? await tx.publisherEntityBinding.findUnique({ where: { chatId: input.entityId } })
          : await tx.chatBotMembership.findUnique({
              where: { chatId_botId: { chatId: input.entityId, botId: resolvedBotId } },
            });
      const actualBot =
        connection &&
        ('publisherBotId' in connection ? connection.publisherBotId : connection.botId);
      if (
        !connection ||
        actualBot !== resolvedBotId ||
        connection.status !== 'ACTIVE' ||
        (input.profile === 'publisher'
          ? isPublisherManagedEntityActivationRequired(connection)
          : isMajorManagedEntityActivationRequired(connection, input.kind)) ||
        (connection.lifecycleEventAt && connection.lifecycleEventAt >= started) ||
        (connection.botAccessCheckedAt &&
          connection.botAccessCheckedAt >= started &&
          !['CONFIRMED_ADMIN', 'CONFIRMED_OWNER'].includes(connection.botAccessState))
      )
        throw new ConflictException('Подключение бота изменилось во время проверки');
      // FLAG: An older concurrent probe cannot replace newer denial or connection evidence.
      const rows = await tx.$queryRaw<MarketplaceBindingRow[]>`
        INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,next_access_at)
        VALUES(${randomUUID()}::uuid,${input.actorUserId},${input.entityId},${input.kind},${input.profile},${resolvedBotId},'ACTIVE',${started},${new Date(started.getTime() + MARKETPLACE_GRANT_MS)},${JSON.stringify(metadata)}::jsonb,${new Date(started.getTime() + (exchangeV2 ? 1 : 3) * 60_000)})
        ON CONFLICT(actor_user_id,entity_id,profile) DO UPDATE SET bot_id=EXCLUDED.bot_id,state='ACTIVE',checked_at=EXCLUDED.checked_at,
          valid_until=EXCLUDED.valid_until,metadata=EXCLUDED.metadata,revision=marketplace_bindings.revision+1,updated_at=now(),next_access_at=EXCLUDED.next_access_at
        WHERE marketplace_bindings.checked_at IS NULL OR marketplace_bindings.checked_at<=EXCLUDED.checked_at
        RETURNING *`;
      if (!rows[0]) throw new ConflictException('Проверка доступа устарела');
      return rows[0];
    });
  }
  async deny(input: MarketplaceBindingInput, at = new Date()): Promise<void> {
    await this.prisma
      .$executeRaw`UPDATE marketplace_bindings SET state='REVOKED',valid_until=NULL,public_verified_until=NULL,lease_id=NULL,lease_until=NULL,
      revision=revision+1,checked_at=${at},updated_at=now() WHERE actor_user_id=${input.actorUserId} AND entity_id=${input.entityId}
      AND profile=${input.profile} AND (checked_at IS NULL OR checked_at<=${at})`;
  }
  async refresh(row: MarketplaceBindingRow, exchangeV2 = false): Promise<void> {
    const started = new Date();
    try {
      await this.attest(
        {
          actorUserId: row.actor_user_id,
          entityId: row.entity_id,
          kind: row.kind,
          profile: row.profile,
        },
        exchangeV2,
        true,
      );
    } catch (error) {
      if (error instanceof ForbiddenException)
        await this.deny(
          {
            actorUserId: row.actor_user_id,
            entityId: row.entity_id,
            kind: row.kind,
            profile: row.profile,
          },
          started,
        );
      else
        await this.prisma
          .$executeRaw`UPDATE marketplace_bindings SET next_access_at=now()+interval '1 minute' WHERE id=${row.id}::uuid`;
    }
  }
}
