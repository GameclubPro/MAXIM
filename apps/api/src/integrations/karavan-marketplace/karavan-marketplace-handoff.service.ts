import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  karavanMarketplaceHandoffIssueSchema,
  karavanMarketplaceHandoffExchangeSchema,
  karavanMarketplaceHandoffEvidenceSchema,
  type KaravanMarketplaceHandoffEvidence,
} from '@maxim/contracts/karavan-marketplace';
import { PrismaService } from '../../prisma/prisma.service';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import {
  KaravanMarketplaceAuthorityService,
  karavanHash,
  karavanPrincipalSchema,
  type KaravanPrincipal,
} from './karavan-marketplace-authority.service';

const HANDOFF_TTL_MS = 120_000;
@Injectable()
export class KaravanMarketplaceHandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: KaravanMarketplaceAuthorityService,
    private readonly config: ConfigService,
    private readonly botLinks: MaxBotLinkService,
  ) {}

  /** FLAG: Caller verifies a live binding and the permission required for this destination. */
  async issue(
    chatId: string,
    actorMaxUserId: string,
    raw: unknown,
    principal: KaravanPrincipal,
  ): Promise<{ url: string; expiresAt: string }> {
    this.authority.assertEnabled();
    const input = karavanMarketplaceHandoffIssueSchema.parse(raw);
    const buyer = input.destination === 'view' || input.destination === 'preview';
    const entryUrl = buyer
      ? new URL(this.config.getOrThrow<string>('KARAVAN_STOREFRONT_CATALOG_URL'))
      : new URL(`https://max.ru/${this.config.getOrThrow<string>('KARAVAN_SELLER_BOT_USERNAME')}`);
    if (
      entryUrl.origin !== 'https://max.ru' ||
      entryUrl.username ||
      entryUrl.password ||
      !/^\/[A-Za-z0-9_]{3,64}\/?$/u.test(entryUrl.pathname)
    )
      throw new ServiceUnavailableException('Ссылка магазина не настроена.');
    entryUrl.search = '';
    entryUrl.hash = '';
    await this.authority.assertPrincipal(principal, actorMaxUserId);
    const witness = await this.authority.collect(chatId, actorMaxUserId);
    const scopeHash = karavanHash({ chatId, actorMaxUserId, ...input });
    return this.prisma.$transaction(async (tx) => {
      await this.authority.assertWitness(tx, witness);
      const current = await tx.karavanMarketplaceHandoff.findUnique({
        where: { actorMaxUserId_commandId: { actorMaxUserId, commandId: input.commandId } },
      });
      if (
        current &&
        (current.chatId !== chatId ||
          current.marketplaceId !== input.marketplaceId ||
          current.destination !== input.destination)
      )
        throw new ConflictException('Этот переход уже связан с другим магазином.');
      if (current && (current.expiresAt.getTime() <= Date.now() || current.exchangedAt))
        throw new ConflictException('Создайте новый переход в магазин.');
      if (current)
        await this.authority.assertWitness(tx, { ...current, chatTitle: witness.chatTitle });
      const id = current?.id ?? randomUUID();
      const checkedAt = current?.checkedAt ?? witness.checkedAt;
      const code = this.authority.opaqueToken('handoff', id, scopeHash, checkedAt);
      const expiresAt = current?.expiresAt ?? new Date(checkedAt.getTime() + HANDOFF_TTL_MS);
      if (!current)
        await tx.karavanMarketplaceHandoff.create({
          data: {
            id,
            actorMaxUserId,
            commandId: input.commandId,
            chatId,
            botId: witness.botId,
            marketplaceId: input.marketplaceId,
            destination: input.destination,
            codeHash: this.authority.tokenHash(code),
            authorityEpoch: witness.authorityEpoch,
            principal,
            checkedAt,
            expiresAt,
          },
        });
      entryUrl.searchParams.set('startapp', `${buyer ? 'mh_' : 'community_h_'}${code}`);
      return {
        url: entryUrl.toString(),
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async exchange(raw: unknown): Promise<KaravanMarketplaceHandoffEvidence> {
    this.authority.assertEnabled();
    const input = karavanMarketplaceHandoffExchangeSchema.parse(raw);
    const record = await this.prisma.karavanMarketplaceHandoff.findUnique({
      where: { codeHash: this.authority.tokenHash(input.code) },
    });
    if (
      !record ||
      record.actorMaxUserId !== input.actorMaxUserId ||
      record.expiresAt.getTime() <= Date.now()
    )
      throw new ForbiddenException('Переход устарел или принадлежит другому пользователю.');
    const buyer = record.destination === 'view' || record.destination === 'preview';
    if (buyer !== (input.audience === 'client'))
      throw new ForbiddenException('Откройте переход в нужном приложении Каравана.');
    await this.authority.assertPrincipal(
      karavanPrincipalSchema.parse(record.principal),
      input.actorMaxUserId,
    );
    return this.prisma.$transaction(async (tx) => {
      await this.authority.assertWitness(tx, { ...record, chatTitle: 'Чат' });
      const current = await tx.karavanMarketplaceHandoff.findUniqueOrThrow({
        where: { id: record.id },
      });
      if (current.expiresAt.getTime() <= Date.now())
        throw new ForbiddenException('Переход устарел.');
      if (current.exchangeId && current.exchangeId !== input.exchangeId)
        throw new ConflictException('Этот переход уже использован.');
      if (!current.exchangeId)
        await tx.karavanMarketplaceHandoff.update({
          where: { id: record.id },
          data: { exchangeId: input.exchangeId, exchangedAt: new Date() },
        });
      return karavanMarketplaceHandoffEvidenceSchema.parse({
        provider: 'maxim',
        actorMaxUserId: current.actorMaxUserId,
        marketplaceId: current.marketplaceId,
        chatId: current.chatId,
        botId: current.botId,
        entityType: 'chat',
        destination: current.destination,
        checkedAt: current.checkedAt.toISOString(),
        expiresAt: current.expiresAt.toISOString(),
        authorityEpoch: current.authorityEpoch,
        exchangeId: input.exchangeId,
        returnUrl: this.botLinks.buildEntryMiniappStartUrlSync(
          `mr-${Buffer.from(
            JSON.stringify({
              v: 1,
              k: 'route',
              r: `/chat/${encodeURIComponent(current.chatId)}/settings?focus=storefront`,
            }),
            'utf8',
          ).toString('base64url')}`,
        ),
      });
    });
  }
}
