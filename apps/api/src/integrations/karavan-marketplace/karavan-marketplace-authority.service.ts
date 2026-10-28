import {
  KaravanMarketplacePublicationPolicyService,
  karavanPublicationPrincipalSchema,
} from './karavan-marketplace-publication-policy.service';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalKaravanMarketplaceJson,
  karavanMarketplaceAuthorityScopeSchema,
  karavanMarketplaceAuthorityRequestSchema,
  karavanMarketplaceAuthorityEvidenceSchema,
  type KaravanMarketplaceAuthorityScope,
  type KaravanMarketplaceAuthorityRequest,
  type KaravanMarketplaceAuthorityEvidence,
} from '@maxim/contracts/karavan-marketplace';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { MaxClientService } from '../../max/max-client.service';
import { MaxBotRegistryService } from '../../max/max-bot-registry.service';
import {
  MINIAPP_SESSION_AUTHORITY,
  type MiniappSessionAuthority,
} from '../../auth/miniapp-session-authority';
import type { MiniappAuthContext } from '../../auth/miniapp-session.types';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

export const KARAVAN_AUTHORITY_TTL_MS = 60_000;
export const karavanPrincipalSchema = z
  .object({
    source: z.enum(['init_data', 'session']),
    principalKey: z.string().regex(/^[a-f0-9]{64}$/u),
    launchBotId: z.string().nullable(),
  })
  .strict();
export type KaravanPrincipal = z.infer<typeof karavanPrincipalSchema>;
export type KaravanChatWitness = {
  chatId: string;
  actorMaxUserId: string;
  botId: string;
  checkedAt: Date;
  authorityEpoch: string;
  chatTitle: string;
};
export function karavanHash(value: unknown): string {
  return createHash('sha256').update(canonicalKaravanMarketplaceJson(value)).digest('hex');
}

@Injectable()
export class KaravanMarketplaceAuthorityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly registry: MaxBotRegistryService,
    @Optional()
    @Inject(MINIAPP_SESSION_AUTHORITY)
    private readonly sessions: MiniappSessionAuthority | undefined,
    private readonly config: ConfigService,
    private readonly publicationPolicy: KaravanMarketplacePublicationPolicyService,
  ) {}

  assertEnabled(): void {
    if (!this.config.get<boolean>('KARAVAN_MARKETPLACE_ENABLED'))
      throw new ServiceUnavailableException({
        code: 'KARAVAN_MARKETPLACE_DISABLED',
        message: 'Модуль магазина пока недоступен.',
      });
  }

  principal(user: AuthUser, auth: MiniappAuthContext | undefined): KaravanPrincipal {
    if (!auth) throw new ForbiddenException('Откройте настройки заново в MAX.');
    return karavanPrincipalSchema.parse({
      source: auth.source,
      principalKey: auth.principalKey,
      launchBotId: user.launchBotId ?? null,
    });
  }

  async assertPrincipal(principal: KaravanPrincipal, actorMaxUserId: string): Promise<void> {
    if (!this.registry.getValidationTokensForBot(principal.launchBotId).length)
      throw new ForbiddenException('Сессия бота больше недоступна.');
    if (
      principal.source === 'session' &&
      // FLAG: Non-HTTP runtimes omit AuthModule; missing session authority must deny management.
      (!this.sessions ||
        !(await this.sessions.isPrincipalActive(
          principal.principalKey,
          actorMaxUserId,
          principal.launchBotId,
        )))
    )
      throw new ForbiddenException('Сессия завершена. Откройте настройки заново в MAX.');
  }

  opaqueToken(kind: string, id: string, scopeHash: string, checkedAt: Date): string {
    return createHmac(
      'sha256',
      this.config.getOrThrow<string>('KARAVAN_MARKETPLACE_AUTHORITY_TOKEN'),
    )
      .update(`${kind}\0${id}\0${scopeHash}\0${checkedAt.toISOString()}`)
      .digest('base64url');
  }

  tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async collect(chatId: string, actorMaxUserId: string): Promise<KaravanChatWitness> {
    this.assertEnabled();
    const checkedAt = new Date();
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true, fixedModeratorBotId: true, primaryBotId: true, botId: true },
    });
    const botId = chat?.fixedModeratorBotId ?? chat?.primaryBotId ?? chat?.botId;
    if (
      chat?.entityType !== 'CHAT' ||
      !botId ||
      !this.registry.getActionableBots().some((bot) => bot.id === botId)
    )
      throw new ForbiddenException('Нужен подключённый чат с действующим ботом Майора.');
    const options = {
      botId,
      bypassCache: true,
      trafficClass: 'interactive' as const,
      sourceTag: 'karavan_marketplace_authority',
      timeoutMs: 5_000,
    };
    // FLAG: Every sibling settles before admission is released; a timeout is unknown, never permission.
    const reads = await Promise.allSettled([
      this.max.getChatSnapshot(chatId, options),
      this.max.getCurrentChatMemberAccess(chatId, options),
      this.max.getChatMemberAccess(chatId, actorMaxUserId, options),
    ]);
    if (reads.some((read) => read.status === 'rejected'))
      throw new ServiceUnavailableException('Не удалось проверить права в MAX. Повторите позже.');
    const snapshot = reads[0].status === 'fulfilled' ? reads[0].value : null;
    const bot = reads[1].status === 'fulfilled' ? reads[1].value : null;
    const actor = reads[2].status === 'fulfilled' ? reads[2].value : null;
    if (!snapshot || !bot || !actor)
      throw new ServiceUnavailableException('MAX пока не подтвердил права.');
    if (
      snapshot.chatId !== chatId ||
      snapshot.entityType !== 'chat' ||
      !(bot.isAdmin || bot.isOwner) ||
      !(actor.isAdmin || actor.isOwner) ||
      actor.isBot !== false ||
      actor.userId !== actorMaxUserId ||
      bot.explicitPrivilegeEvidence !== true ||
      actor.explicitPrivilegeEvidence !== true
    )
      throw new ForbiddenException('Нужны права администратора чата у вас и у бота.');
    if (Date.now() - checkedAt.getTime() >= KARAVAN_AUTHORITY_TTL_MS)
      throw new ConflictException('Проверка прав устарела.');
    return this.prisma.$transaction(async (tx) => {
      const authorityEpoch = await this.readEpoch(
        tx,
        { chatId, actorMaxUserId, botId, checkedAt },
        true,
      );
      return {
        chatId,
        actorMaxUserId,
        botId,
        checkedAt,
        authorityEpoch,
        chatTitle: (snapshot.title ?? 'Чат').slice(0, 300),
      };
    });
  }

  async readEpoch(
    tx: Prisma.TransactionClient,
    witness: Pick<KaravanChatWitness, 'chatId' | 'actorMaxUserId' | 'botId' | 'checkedAt'>,
    fresh = false,
  ): Promise<string> {
    const { chatId, actorMaxUserId, botId, checkedAt } = witness;
    await tx.$queryRaw`SELECT id FROM chats WHERE id=${chatId} FOR UPDATE`;
    const chat = await tx.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        fixedModeratorBotId: true,
        primaryBotId: true,
        botId: true,
        routingVersion: true,
      },
    });
    const membership = await tx.chatBotMembership.findUnique({
      where: { chatId_botId: { chatId, botId } },
      select: {
        status: true,
        commerceRevocationEpoch: true,
        lifecycleEventAt: true,
        lifecycleEventType: true,
        botAccessState: true,
        botAccessCheckedAt: true,
      },
    });
    const edge = await tx.managedEntityAccessEdge.findUnique({
      where: { chatId_userId_botId: { chatId, userId: actorMaxUserId, botId } },
      select: { state: true, userRole: true, botRole: true, checkedAt: true },
    });
    const activity = await tx.chatMembershipActivityEvent.findFirst({
      where: { chatId, userId: actorMaxUserId, eventType: { in: ['user_added', 'user_removed'] } },
      orderBy: [{ eventAt: 'desc' }, { id: 'desc' }],
      select: { id: true, eventAt: true, eventType: true },
    });
    if (
      chat?.entityType !== 'CHAT' ||
      (chat.fixedModeratorBotId ?? chat.primaryBotId ?? chat.botId) !== botId ||
      !this.registry.getActionableBots().some((bot) => bot.id === botId) ||
      membership?.status !== 'ACTIVE'
    )
      throw new ConflictException('Подключение чата изменилось. Обновите настройки.');
    if (
      fresh &&
      ((membership.lifecycleEventAt && membership.lifecycleEventAt >= checkedAt) ||
        (membership.botAccessCheckedAt &&
          membership.botAccessCheckedAt >= checkedAt &&
          !['CONFIRMED_ADMIN', 'CONFIRMED_OWNER'].includes(membership.botAccessState)) ||
        (activity && activity.eventAt >= checkedAt) ||
        (edge &&
          edge.checkedAt >= checkedAt &&
          (edge.state !== 'GRANTED' ||
            !['ADMIN', 'OWNER'].includes(edge.userRole) ||
            !['ADMIN', 'OWNER'].includes(edge.botRole))))
    )
      throw new ConflictException('Права изменились во время проверки.');
    return karavanHash({
      chat,
      membership: JSON.parse(JSON.stringify(membership)),
      edge: JSON.parse(JSON.stringify(edge)),
      activity: JSON.parse(JSON.stringify(activity)),
    });
  }

  async assertWitness(tx: Prisma.TransactionClient, witness: KaravanChatWitness): Promise<void> {
    if ((await this.readEpoch(tx, witness)) !== witness.authorityEpoch)
      throw new ConflictException('Права или подключение чата изменились.');
  }

  async issue(
    raw: KaravanMarketplaceAuthorityScope,
    principal: KaravanPrincipal,
  ): Promise<KaravanMarketplaceAuthorityRequest> {
    this.assertEnabled();
    const scope = karavanMarketplaceAuthorityScopeSchema.parse(raw);
    if (scope.action === 'resolve_publication')
      throw new ForbiddenException('Публикации проверяются только из обработчика сообщения.');
    await this.assertPrincipal(principal, scope.actorMaxUserId);
    const scopeHash = karavanHash(scope);
    const existing = await this.prisma.karavanMarketplaceAuthorityGrant.findUnique({
      where: {
        actorMaxUserId_commandId: {
          actorMaxUserId: scope.actorMaxUserId,
          commandId: scope.commandId,
        },
      },
    });
    if (existing && existing.scopeHash !== scopeHash)
      throw new ConflictException('Этот запрос уже использован для другого действия.');
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      await this.assertPrincipal(
        karavanPrincipalSchema.parse(existing.principal),
        scope.actorMaxUserId,
      );
      await this.prisma.$transaction((tx) =>
        this.assertWitness(tx, { ...existing, chatTitle: existing.chatTitle ?? 'Чат' }),
      );
      return {
        ...scope,
        proofId: this.opaqueToken('authority', existing.id, scopeHash, existing.checkedAt),
      };
    }
    const witness = await this.collect(scope.chatId, scope.actorMaxUserId);
    return this.prisma.$transaction(async (tx) => {
      await this.assertWitness(tx, witness);
      const current = await tx.karavanMarketplaceAuthorityGrant.findUnique({
        where: {
          actorMaxUserId_commandId: {
            actorMaxUserId: scope.actorMaxUserId,
            commandId: scope.commandId,
          },
        },
      });
      if (current && (current.scopeHash !== scopeHash || current.checkedAt > witness.checkedAt))
        throw new ConflictException('Запрос уже обновлён. Повторите чтение.');
      const id = current?.id ?? randomUUID();
      const proofId = this.opaqueToken('authority', id, scopeHash, witness.checkedAt);
      const data = {
        ...witness,
        commandId: scope.commandId,
        scopeHash,
        scope,
        proofHash: this.tokenHash(proofId),
        principal,
        expiresAt: new Date(witness.checkedAt.getTime() + KARAVAN_AUTHORITY_TTL_MS),
      };
      await tx.karavanMarketplaceAuthorityGrant.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      });
      if (['bind_chat', 'recover_chat', 'transfer_chat'].includes(scope.action)) {
        await tx.karavanMarketplaceChatEnrollment.upsert({
          where: { chatId: scope.chatId },
          create: {
            chatId: scope.chatId,
            actorMaxUserId: scope.actorMaxUserId,
            requestedCommandId: scope.commandId,
            marketplaceId: scope.marketplaceId!,
            phase: 'pending',
          },
          update: {},
        });
        const chat = await tx.chat.findUniqueOrThrow({
          where: { id: scope.chatId },
          select: { routingVersion: true },
        });
        const membership = await tx.chatBotMembership.findUniqueOrThrow({
          where: { chatId_botId: { chatId: scope.chatId, botId: witness.botId } },
          select: { commerceRevocationEpoch: true, lifecycleEventAt: true },
        });
        await tx.karavanMarketplaceBindingWitness.upsert({
          where: {
            authorityEpoch_checkedAt: {
              authorityEpoch: witness.authorityEpoch,
              checkedAt: witness.checkedAt,
            },
          },
          create: {
            authorityEpoch: witness.authorityEpoch,
            checkedAt: witness.checkedAt,
            chatId: scope.chatId,
            botId: witness.botId,
            routingVersion: chat.routingVersion,
            botRevocationEpoch: membership.commerceRevocationEpoch,
            lifecycleEventAt: membership.lifecycleEventAt,
          },
          update: {},
        });
      }
      return { ...scope, proofId };
    });
  }

  /** FLAG: Internal relay entry only: the actor and forwarded subject come from an exact MAX message. */
  async issuePublication(
    raw: KaravanMarketplaceAuthorityScope,
    source: { sourceMessageId: string; subjectMaxUserId: string; botId: string },
  ): Promise<{ authority: KaravanMarketplaceAuthorityRequest; sourceFingerprint: string }> {
    this.assertEnabled();
    const scope = karavanMarketplaceAuthorityScopeSchema.parse(raw);
    if (scope.action !== 'resolve_publication')
      throw new ForbiddenException('Недопустимая область публикации.');
    const capture = await this.publicationPolicy.capture(
      scope.chatId,
      scope.actorMaxUserId,
      source.subjectMaxUserId,
      source.sourceMessageId,
      source.botId,
    );
    const scopeHash = karavanHash(scope);
    return this.prisma.$transaction(async (tx) => {
      const authorityEpoch = await this.readEpoch(tx, capture, true);
      await this.publicationPolicy.assertLocal(
        tx,
        scope.chatId,
        scope.actorMaxUserId,
        capture.principal,
      );
      const current = await tx.karavanMarketplaceAuthorityGrant.findUnique({
        where: {
          actorMaxUserId_commandId: {
            actorMaxUserId: scope.actorMaxUserId,
            commandId: scope.commandId,
          },
        },
      });
      if (current && (current.scopeHash !== scopeHash || current.checkedAt > capture.checkedAt))
        throw new ConflictException('Публикация уже обновлена.');
      const grantId = current?.id ?? randomUUID();
      const proofId = this.opaqueToken('authority', grantId, scopeHash, capture.checkedAt);
      const data = {
        ...capture,
        authorityEpoch,
        commandId: scope.commandId,
        scopeHash,
        scope,
        proofHash: this.tokenHash(proofId),
        expiresAt: new Date(capture.checkedAt.getTime() + KARAVAN_AUTHORITY_TTL_MS),
      };
      await tx.karavanMarketplaceAuthorityGrant.upsert({
        where: { id: grantId },
        create: { id: grantId, ...data },
        update: data,
      });
      return {
        authority: { ...scope, proofId },
        sourceFingerprint: capture.principal.sourceFingerprint,
      };
    });
  }

  async introspect(raw: unknown): Promise<KaravanMarketplaceAuthorityEvidence> {
    this.assertEnabled();
    const request = karavanMarketplaceAuthorityRequestSchema.parse(raw);
    const { proofId, ...scope } = request;
    const record = await this.prisma.karavanMarketplaceAuthorityGrant.findUnique({
      where: { proofHash: this.tokenHash(proofId) },
    });
    if (
      !record ||
      record.scopeHash !== karavanHash(scope) ||
      record.expiresAt.getTime() <= Date.now()
    )
      throw new ForbiddenException('Подтверждение прав устарело или не совпадает с запросом.');
    if (request.action === 'resolve_publication') {
      const principal = karavanPublicationPrincipalSchema.parse(record.principal);
      const capture = await this.publicationPolicy.capture(
        request.chatId,
        request.actorMaxUserId,
        principal.subjectMaxUserId,
        principal.sourceMessageId,
        record.botId,
      );
      if (
        capture.principal.sourceFingerprint !== principal.sourceFingerprint ||
        capture.principal.policyHash !== principal.policyHash
      )
        throw new ConflictException('Публикация изменилась.');
      await this.prisma.$transaction(async (tx) => {
        await this.assertWitness(tx, { ...record, chatTitle: record.chatTitle ?? 'Чат' });
        await this.publicationPolicy.assertLocal(
          tx,
          request.chatId,
          request.actorMaxUserId,
          principal,
        );
      });
    } else {
      await this.assertPrincipal(
        karavanPrincipalSchema.parse(record.principal),
        request.actorMaxUserId,
      );
      await this.prisma.$transaction((tx) =>
        this.assertWitness(tx, { ...record, chatTitle: record.chatTitle ?? 'Чат' }),
      );
    }
    if (record.expiresAt.getTime() <= Date.now())
      throw new ForbiddenException('Подтверждение прав устарело.');
    return karavanMarketplaceAuthorityEvidenceSchema.parse({
      ...scope,
      provider: 'maxim',
      botId: record.botId,
      entityType: 'chat',
      checkedAt: record.checkedAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
      authorityEpoch: record.authorityEpoch,
      ...(record.chatTitle ? { chatTitle: record.chatTitle } : {}),
    });
  }
}
