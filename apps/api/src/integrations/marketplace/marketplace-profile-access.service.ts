import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isMajorManagedEntityActivationRequired } from '../../max/managed-entity-activation.util';
import { isPublisherManagedEntityActivationRequired } from '../../publisher/publisher-entity-connection.util';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MarketplaceStateService, type MarketplaceBindingRow } from './marketplace-state.service';

@Injectable()
export class MarketplaceProfileAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: MarketplaceStateService,
    private readonly access: MarketplaceAccessService,
  ) {}
  async read(id: string) {
    const original = await this.state.read(id);
    if (!original) throw new NotFoundException();
    const denial = await this.knownDenial(original);
    if (denial) return this.revoked(original, denial);
    const age = original.checked_at ? Date.now() - original.checked_at.getTime() : Infinity;
    if (age >= -30_000 && age < 120_000 && (await this.state.hasActiveAccess(id)))
      return this.present(original);
    // FLAG: Existing profiles may refresh exact rights without a button or
    // statistics consent. Background admission never activates a dormant bot.
    try {
      await this.access.attest(
        {
          actorUserId: original.actor_user_id,
          entityId: original.entity_id,
          kind: original.kind,
          profile: original.profile,
        },
        false,
        true,
      );
    } catch {
      const current = await this.state.read(id);
      if (current) {
        const denied = await this.knownDenial(current);
        if (denied) return this.revoked(current, denied);
      }
      throw new ServiceUnavailableException('Проверка доступа к профилю временно недоступна');
    }
    const current = await this.state.read(id);
    if (
      !current ||
      current.actor_user_id !== original.actor_user_id ||
      current.entity_id !== original.entity_id ||
      current.kind !== original.kind ||
      current.profile !== original.profile
    )
      throw new ServiceUnavailableException('Права изменились во время проверки');
    const denied = await this.knownDenial(current);
    if (denied) return this.revoked(current, denied);
    if (
      !current.checked_at ||
      current.checked_at.getTime() <= Date.now() - 300_000 ||
      !(await this.state.hasActiveAccess(id))
    )
      throw new ServiceUnavailableException('Проверка доступа к профилю ещё не завершена');
    return this.present(current);
  }
  private present(row: MarketplaceBindingRow) {
    const until =
      row.checked_at && row.valid_until
        ? new Date(Math.min(row.valid_until.getTime(), row.checked_at.getTime() + 300_000))
        : null;
    return this.state.presentAccess({ ...row, valid_until: until });
  }
  private revoked(row: MarketplaceBindingRow, at: Date) {
    return this.state.presentAccess({
      ...row,
      state: 'REVOKED',
      checked_at: at,
      valid_until: null,
    });
  }
  async knownDenial(row: MarketplaceBindingRow): Promise<Date | null> {
    const connection =
      row.profile === 'publisher'
        ? await this.prisma.publisherEntityBinding.findUnique({ where: { chatId: row.entity_id } })
        : await this.prisma.chatBotMembership.findUnique({
            where: { chatId_botId: { chatId: row.entity_id, botId: row.bot_id } },
          });
    const actualBot =
      connection && ('publisherBotId' in connection ? connection.publisherBotId : connection.botId);
    const activationRequired =
      row.profile === 'publisher'
        ? isPublisherManagedEntityActivationRequired(connection)
        : isMajorManagedEntityActivationRequired(connection, row.kind);
    if (
      !connection ||
      actualBot !== row.bot_id ||
      connection.status !== 'ACTIVE' ||
      activationRequired ||
      row.state === 'REVOKED'
    )
      return new Date(
        Math.max(
          row.checked_at?.getTime() ?? 0,
          connection?.botAccessCheckedAt?.getTime() ?? 0,
          connection?.lifecycleEventAt?.getTime() ?? 0,
        ),
      );
    const rows = await this.prisma.$queryRaw<
      Array<{ denied_at: Date | null }>
    >`SELECT greatest(b.last_button_access_loss_at,
      (SELECT CASE WHEN e.event_type='user_removed' THEN e.event_at AT TIME ZONE 'UTC' END FROM chat_membership_activity_events e WHERE e.chat_id=b.entity_id AND e.user_id=b.actor_user_id ORDER BY e.event_at DESC LIMIT 1),
      (SELECT max(a.checked_at AT TIME ZONE 'UTC') FROM managed_entity_access_edges a WHERE a.chat_id=b.entity_id AND a.user_id=b.actor_user_id AND a.bot_id=b.bot_id AND (a.state='USER_DENIED' OR a.state='GRANTED' AND a.user_role='MEMBER'))
    ) denied_at FROM marketplace_bindings b WHERE b.id=${row.id}::uuid`;
    const at = rows[0]?.denied_at;
    return at && (!row.checked_at || at >= row.checked_at) ? at : null;
  }
}
