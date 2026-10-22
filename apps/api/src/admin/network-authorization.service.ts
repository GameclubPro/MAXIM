import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

export const NETWORK_AUTHORIZATION_CONCURRENCY = 2;
const AUTHORIZATION_CONCURRENCY = NETWORK_AUTHORIZATION_CONCURRENCY;
const AUTHORIZATION_QUEUE_TIMEOUT_MS = 2500;
const MAX_AUTHORIZATION_WAITERS = 200;

// FLAG: Statistics and settings metadata share this one FIFO admission pool and exact denial epochs.
@Injectable()
export class NetworkAuthorizationService {
  private authorizationInFlight = 0;
  private readonly authorizationWaiters: Array<() => void> = [];
  constructor(@Inject(PrismaService) private readonly prisma: Pick<PrismaService, '$queryRaw'>) {}
  async acquireSlot(): Promise<() => void> {
    if (this.authorizationInFlight < AUTHORIZATION_CONCURRENCY) {
      this.authorizationInFlight += 1;
    } else {
      if (this.authorizationWaiters.length >= MAX_AUTHORIZATION_WAITERS)
        throw new ServiceUnavailableException('Проверка доступа временно занята.');
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.authorizationWaiters.indexOf(grant);
          if (index >= 0) this.authorizationWaiters.splice(index, 1);
          reject(new ServiceUnavailableException('Проверка доступа временно занята.'));
        }, AUTHORIZATION_QUEUE_TIMEOUT_MS);
        this.authorizationWaiters.push(grant);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.authorizationWaiters.shift();
      // FLAG: The in-flight reservation transfers directly to the FIFO waiter.
      if (next) next();
      else this.authorizationInFlight -= 1;
    };
  }

  async readEpochs(
    g: { userId: string; entityType: ManagedEntityType },
    ids: string[],
    freshSince?: Date,
  ): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ id: string; epoch: string }>>`
      SELECT c.id,md5(c.routing_version::text || ':' ||
        COALESCE((SELECT jsonb_agg(jsonb_build_array(e.bot_id,e.state,e.user_role,e.bot_role,e.checked_at,e.updated_at)
          ORDER BY e.bot_id)::text FROM managed_entity_access_edges e
          WHERE e.chat_id=c.id AND e.user_id=${g.userId}
            AND e.entity_type=${g.entityType === 'chat' ? 'CHAT' : 'CHANNEL'}::"ChatEntityType"),'[]') || ':' ||
        COALESCE((SELECT jsonb_agg(jsonb_build_array(m.bot_id,m.status,m.bot_access_state,m.bot_access_checked_at,
          m.lifecycle_event_at,m.lifecycle_event_type,m.permissions_hash) ORDER BY m.bot_id)::text
          FROM chat_bot_memberships m WHERE m.chat_id=c.id),'[]')) AS epoch
      FROM chats c WHERE c.id IN (${Prisma.join(ids)})
        AND c.entity_type=${g.entityType === 'chat' ? 'CHAT' : 'CHANNEL'}::"ChatEntityType"
        AND EXISTS (SELECT 1 FROM managed_entity_access_edges grant_edge
          WHERE grant_edge.chat_id=c.id AND grant_edge.user_id=${g.userId}
            AND grant_edge.entity_type=c.entity_type AND grant_edge.state='GRANTED'
            AND grant_edge.source='remote_admin_access'
            AND grant_edge.user_role IN ('ADMIN','OWNER') AND grant_edge.bot_role IN ('ADMIN','OWNER')
            AND (${freshSince ?? null}::timestamp IS NULL OR grant_edge.checked_at>=${freshSince ?? null})
            AND NOT EXISTS (SELECT 1 FROM managed_entity_access_edges denied
              WHERE denied.chat_id=c.id AND denied.user_id=${g.userId} AND denied.entity_type=c.entity_type
                AND denied.state='USER_DENIED' AND denied.checked_at>=grant_edge.checked_at)
            AND NOT EXISTS (SELECT 1 FROM chat_bot_memberships denied_bot
              WHERE denied_bot.chat_id=c.id AND denied_bot.bot_id=grant_edge.bot_id
                AND ((denied_bot.status='REMOVED' AND denied_bot.lifecycle_event_at>=grant_edge.checked_at)
                  OR (denied_bot.bot_access_state IN ('DENIED','LOST') AND denied_bot.bot_access_checked_at>=grant_edge.checked_at))))
    `;
    return new Map(rows.map((row) => [row.id, row.epoch]));
  }
}
