import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  marketplaceBindingInputSchema,
  marketplaceLaunchInputSchema,
  marketplaceLaunchResponseSchema,
} from '@maxim/contracts/marketplace-integration';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { MaxBotRegistryService } from '../../max/max-bot-registry.service';
import { canAuthenticateInitDataForBotState } from '../../max/max-bot-state.util';
import { ManagedEntitiesService } from '../../admin/managed-entities.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceButtonPolicyService } from './marketplace-button-policy.service';

const BOT = 'https://max.ru/id613000037577_3_bot';
export function signMarketplaceLaunch(prefix: string, token: string): string {
  return createHmac('sha256', token)
    .update(`birzhik-navigation-v1\0${prefix}`)
    .digest('base64url')
    .slice(0, 16);
}
@Injectable()
export class MarketplaceNavigationService {
  constructor(
    private readonly config: ConfigService,
    private readonly registry: MaxBotRegistryService,
    private readonly buttons: MarketplaceButtonPolicyService,
    private readonly entities: ManagedEntitiesService,
    private readonly prisma: PrismaService,
  ) {}
  async launch(user: AuthUser, profile: 'moderation' | 'publisher', raw: unknown) {
    const input = marketplaceLaunchInputSchema.parse(raw);
    const source =
      profile === 'publisher'
        ? this.registry.getPublisherBotDescriptor()
        : this.registry.getBotById(user.launchBotId);
    if (
      !source ||
      source.id !== user.launchBotId ||
      ('state' in source && !canAuthenticateInitDataForBotState(source.state))
    )
      throw new ForbiddenException('Бот запуска недоступен');
    let canonical = `${BOT}?startapp=catalog`;
    if (input.kind && input.entityId) {
      const entry = await this.buttons.entry(
        this.buttons.identity(user.userId, input.kind, input.entityId, profile),
      );
      if (input.target === 'manage') {
        if (!entry.isOwner || !entry.manageUrl || entry.listing?.id !== input.listingId)
          throw new ForbiddenException('Управление профилем недоступно');
        canonical = entry.manageUrl;
      } else if (input.target === 'listing') {
        if (!entry.listing?.publicUrl || entry.listing.id !== input.listingId)
          throw new NotFoundException('Профиль недоступен');
        canonical = entry.listing.publicUrl;
      } else if (input.target === 'connect') canonical = entry.connectUrl;
    }
    const token = this.config.get<string>('SVYAZKA_PROFILE_TOKEN');
    if (!token) throw new ServiceUnavailableException('Биржик пока не подключён');
    const kind = input.kind === 'CHANNEL' ? 'n' : input.kind === 'CHAT' ? 'c' : 'h';
    const verb = { catalog: 'c', listing: 'l', manage: 'm', connect: 'a' }[input.target];
    const target =
      input.target === 'catalog'
        ? '0'
        : input.target === 'connect'
          ? input.entityId!.slice(1)
          : input.listingId!.replaceAll('-', '');
    const prefix = `b1-${verb}${input.target === 'catalog' ? 'h' : kind}-${target}-${profile === 'publisher' ? 'p' : 'm'}${kind}${input.entityId?.slice(1) ?? '0'}-${source.id}-${Math.floor(Date.now() / 60_000) + 1440}`;
    const payload = `${prefix}-${signMarketplaceLaunch(prefix, token)}`;
    // FLAG: Only a verified registry identity is signed. This context is navigation,
    // never authentication, and generic arbitrary return URLs are not accepted.
    return marketplaceLaunchResponseSchema.parse({
      url:
        /^[A-Za-z0-9_]{3,32}$/u.test(source.id) && payload.length <= 128
          ? `${BOT}?startapp=${payload}`
          : canonical,
    });
  }
  async reverse(raw: unknown): Promise<{ url: string; label: string }> {
    const input = marketplaceBindingInputSchema.parse(raw);
    let botId: string;
    let label: string;
    if (input.profile === 'publisher') {
      const bot = this.registry.getPublisherBotDescriptor();
      const rows = await this.prisma.$queryRaw<
        Array<{ chat_id: string }>
      >`SELECT p.chat_id FROM publisher_entity_bindings p JOIN managed_entity_access_edges a ON a.chat_id=p.chat_id AND a.bot_id=p.publisher_bot_id
        WHERE p.chat_id=${input.entityId} AND p.publisher_bot_id=${bot.id} AND p.status='ACTIVE' AND a.user_id=${input.actorUserId} AND a.entity_type=${input.kind}::"ChatEntityType"
          AND a.state='GRANTED' AND a.user_role IN ('ADMIN','OWNER') AND a.bot_role IN ('ADMIN','OWNER')
          AND p.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER') LIMIT 1`;
      if (!rows.length) throw new NotFoundException('Подключение Публика недоступно');
      botId = bot.id;
      label = bot.label;
    } else {
      await this.entities.assertManagedEntityAdminAccess(
        input.entityId,
        { userId: input.actorUserId, username: null, displayName: null },
        input.kind === 'CHANNEL' ? 'channel' : 'chat',
      );
      const selected = await this.entities.resolveManagedEntityReadBotId(input.entityId);
      const bot = this.registry.getBotById(selected);
      if (!bot || !canAuthenticateInitDataForBotState(bot.state))
        throw new NotFoundException('Бот модерации недоступен');
      botId = bot.id;
      label = bot.characterName;
    }
    const kind = input.kind === 'CHANNEL' ? 'channel' : 'chat';
    const route =
      input.profile === 'publisher'
        ? `/publisher/${kind}/${input.entityId}?focus=birzhik`
        : `/${kind}/${input.entityId}/settings?focus=birzhik`;
    const payload =
      'mr-' + Buffer.from(JSON.stringify({ v: 1, k: 'route', r: route })).toString('base64url');
    return { url: `https://max.ru/${encodeURIComponent(botId)}?startapp=${payload}`, label };
  }
}
