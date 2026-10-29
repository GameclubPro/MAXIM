import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  karavanMarketplaceActorAccessRequestSchema,
  karavanMarketplaceActorAccessResponseSchema,
  type KaravanMarketplaceActorAccessRequest,
  type KaravanMarketplaceActorAccessResponse,
} from '@maxim/contracts/karavan-marketplace';
import { PrismaService } from '../../prisma/prisma.service';
import {
  KaravanMarketplaceAuthorityDenied,
  KaravanMarketplaceAuthorityService,
} from './karavan-marketplace-authority.service';
import { KaravanMarketplaceBindingStatusService } from './karavan-marketplace-binding-status.service';

const ACCESS_TTL_MS = 15_000;

@Injectable()
export class KaravanMarketplaceActorAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: KaravanMarketplaceAuthorityService,
    private readonly bindings: KaravanMarketplaceBindingStatusService,
  ) {}

  async check(raw: unknown): Promise<KaravanMarketplaceActorAccessResponse> {
    this.authority.assertEnabled();
    const input = karavanMarketplaceActorAccessRequestSchema.parse(raw);
    const checkedAt = new Date();
    const binding = {
      chatId: input.chatId,
      botId: input.botId,
      authorityEpoch: input.authorityEpoch,
      verifiedAt: input.verifiedAt,
    };
    const before = await this.bindings.status(binding);
    if (!before.active)
      return this.result(
        input,
        before.reason === 'bot_unavailable' ? 'bot_unavailable' : 'binding_changed',
        checkedAt,
      );
    try {
      // FLAG: A binding belongs to its original witness, not to the actor now requesting access.
      const actor = await this.authority.collect(input.chatId, input.actorMaxUserId);
      if (actor.botId !== input.botId) return this.result(input, 'binding_changed', checkedAt);
      const after = await this.bindings.status(binding);
      if (!after.active)
        return this.result(
          input,
          after.reason === 'bot_unavailable' ? 'bot_unavailable' : 'binding_changed',
          checkedAt,
        );
      const current = await this.prisma.$transaction(async (tx) => {
        await this.authority.assertWitness(tx, actor);
        return this.bindings.isCurrent(tx, binding);
      });
      return this.result(input, current ? 'admin' : 'binding_changed', checkedAt);
    } catch (error) {
      if (error instanceof KaravanMarketplaceAuthorityDenied) {
        if (error.accessReason === 'unknown')
          throw new ServiceUnavailableException('MAX пока не подтвердил права.');
        return this.result(input, error.accessReason, checkedAt);
      }
      if (error instanceof ConflictException)
        return this.result(input, 'binding_changed', checkedAt);
      throw error;
    }
  }

  private result(
    input: KaravanMarketplaceActorAccessRequest,
    reason: KaravanMarketplaceActorAccessResponse['reason'],
    checkedAt: Date,
  ): KaravanMarketplaceActorAccessResponse {
    if (Date.now() - checkedAt.getTime() >= ACCESS_TTL_MS)
      throw new ServiceUnavailableException('Проверка прав устарела. Повторите позже.');
    return karavanMarketplaceActorAccessResponseSchema.parse({
      ...input,
      allowed: reason === 'admin',
      reason,
      checkedAt: checkedAt.toISOString(),
      expiresAt: new Date(checkedAt.getTime() + ACCESS_TTL_MS).toISOString(),
    });
  }
}
