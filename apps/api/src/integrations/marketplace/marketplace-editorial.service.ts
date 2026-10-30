import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  marketplaceBindingInputSchema,
  marketplaceEditorialIdentitySchema,
  marketplaceEditorialMutationSchema,
  marketplaceEditorialStateSchema,
  type MarketplaceBindingInput,
  type MarketplaceEditorialMutation,
} from '@maxim/contracts/marketplace-integration';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketplaceAccessService } from './marketplace-access.service';
import { readMarketplaceResponse } from './marketplace-profile.service';
import { MarketplaceStateService, type MarketplaceBindingRow } from './marketplace-state.service';

const EDITORIAL_URL = 'https://major-maksimov.ru/market/api/integrations/maxim/v1/editorial';
const PUBLIC_BOT = 'https://max.ru/id613000037577_3_bot';
@Injectable()
export class MarketplaceEditorialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly state: MarketplaceStateService,
    private readonly access: MarketplaceAccessService,
  ) {}
  private identity(userId: string, kind: unknown, entityId: unknown, profile: unknown) {
    return marketplaceBindingInputSchema.parse({ actorUserId: userId, kind, entityId, profile });
  }
  async get(userId: string, kind: unknown, entityId: unknown, profile: unknown) {
    return this.relay(this.identity(userId, kind, entityId, profile));
  }
  async mutate(userId: string, kind: unknown, entityId: unknown, profile: unknown, raw: unknown) {
    const mutation = marketplaceEditorialMutationSchema.parse(raw);
    return this.relay(this.identity(userId, kind, entityId, profile), mutation);
  }
  private async relay(identity: MarketplaceBindingInput, mutation?: MarketplaceEditorialMutation) {
    if (!this.state.enabled()) throw new ServiceUnavailableException('Биржик пока не подключён');
    const token = this.config.get<string>('SVYAZKA_PROFILE_TOKEN');
    if (!token) throw new ServiceUnavailableException('Биржик пока не подключён');
    const rows = await this.prisma.$queryRaw<MarketplaceBindingRow[]>`
      SELECT * FROM marketplace_bindings WHERE actor_user_id=${identity.actorUserId}
      AND entity_id=${identity.entityId} AND kind=${identity.kind} AND profile=${identity.profile}`;
    const binding =
      rows[0] ?? (await this.access.attest(identity, false, false, 'PROFILE_DESCRIPTION'));
    const input = marketplaceEditorialIdentitySchema.parse({ ...identity, bindingId: binding.id });
    try {
      // FLAG: The Market callback proves current editorial access. No profile sync,
      // owner binding, consent, publication state or button state is written here.
      const response = await fetch(
        mutation ? EDITORIAL_URL : `${EDITORIAL_URL}?${new URLSearchParams(input)}`,
        {
          method: mutation ? 'PATCH' : 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            ...(mutation ? { 'content-type': 'application/json' } : {}),
          },
          ...(mutation ? { body: JSON.stringify({ ...input, ...mutation }) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status === 409)
        throw new ConflictException('Карточка изменилась. Обновите её и проверьте описание');
      if (response.status === 404) throw new NotFoundException('Карточка площадки ещё не создана');
      if (response.status === 403)
        throw new ForbiddenException('Право редактировать описание не подтверждено');
      if (response.status === 400 || response.status === 422)
        throw new BadRequestException('Проверьте длину описания');
      const result = marketplaceEditorialStateSchema.parse(await readMarketplaceResponse(response));
      if (
        result.entityId !== identity.entityId ||
        result.kind !== identity.kind ||
        (mutation &&
          (result.listing.id !== mutation.listingId ||
            result.ownershipKey !== mutation.ownershipKey ||
            result.revision < mutation.expectedRevision)) ||
        Date.parse(result.validUntil) <= Date.now() ||
        Date.parse(result.validUntil) > Date.now() + 31_000
      )
        throw new Error('Editorial identity or deadline mismatch');
      if (
        result.listing.publicUrl !== null &&
        result.listing.publicUrl !==
          `${PUBLIC_BOT}?startapp=listing_${identity.kind === 'CHANNEL' ? 'channel' : 'chat'}_${result.listing.id}`
      )
        throw new Error('Editorial destination mismatch');
      return result;
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException ||
        error instanceof BadRequestException
      )
        throw error;
      throw new ServiceUnavailableException('Не удалось проверить карточку в Биржике');
    }
  }
}
