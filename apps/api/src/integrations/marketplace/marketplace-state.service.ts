import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import {
  marketplaceBindingSchema,
  marketplaceButtonModules,
  MARKETPLACE_BUTTON_DEFAULT_CAPTION,
  type MarketplaceButtonModule,
  type MarketplaceBinding,
} from '@maxim/contracts/marketplace-integration';

export const MARKETPLACE_PILOT_USER_ID = '323459159';
export const MARKETPLACE_GRANT_MS = 5 * 60_000;
export const STATISTICS_ACCESS_CACHE_MS = 24 * 60 * 60_000;
export type MarketplaceBindingRow = {
  id: string;
  actor_user_id: string;
  entity_id: string;
  kind: 'CHAT' | 'CHANNEL';
  profile: 'moderation' | 'publisher';
  bot_id: string;
  state: 'ACTIVE' | 'UNKNOWN' | 'REVOKED';
  revision: number;
  checked_at: Date | null;
  valid_until: Date | null;
  updated_at: Date;
  generation_id: string | null;
  statistics_checked_at: Date | null;
  native_history_checked_at: Date | null;
  native_full_checked_at: Date | null;
  native_audience_checked_at: Date | null;
  history_complete: boolean;
  history_from: Date | null;
  metadata: unknown;
  statistics_consent: boolean;
  statistics_revoked_at: Date | null;
  collection_owner: 'SHADOW' | 'MAXIM';
  collection_metrics: unknown;
  last_button_access_loss_at?: Date | null;
  append_enabled: boolean;
  append_revision: number;
  profile_revision: number;
  profile_snapshot: unknown;
  public_url: string | null;
  public_verified_until: Date | null;
  history_to: Date | null;
  history_cursor: Date | null;
  history_signature: string | null;
  discovery_from: Date | null;
  discovery_to: Date | null;
  history_anomaly: boolean;
  collection_error?: string | null;
  button_diagnostic: string | null;
  next_collect_at: Date;
  next_access_at: Date;
  lease_id: string | null;
  lease_until: Date | null;
};

// Trusted SQL aliases only; this is shared by claims, commits, exports, and ownership gates.
export function marketplaceLocalGrantSql(
  alias: 'b' | 's' | 'preferred' | 'marketplace_bindings' = 'marketplace_bindings',
  requireConsent = true,
): Prisma.Sql {
  return marketplaceGrantEvidenceSql(alias, requireConsent, false);
}

// FLAG: Only central statistics may reuse the original MAX proof for a day.
// This never changes checked_at or extends publication/moderation authority.
export function marketplaceStatisticsGrantSql(
  alias: 'b' | 's' | 'preferred' | 'marketplace_bindings' = 'marketplace_bindings',
  requireConsent = true,
): Prisma.Sql {
  return marketplaceGrantEvidenceSql(alias, requireConsent, true);
}

function marketplaceGrantEvidenceSql(
  alias: 'b' | 's' | 'preferred' | 'marketplace_bindings',
  requireConsent: boolean,
  statistics: boolean,
): Prisma.Sql {
  const b = Prisma.raw(alias);
  const expiry = statistics
    ? Prisma.sql`${b}.checked_at>now()-interval '24 hours'`
    : Prisma.sql`${b}.valid_until>now()`;
  return Prisma.sql`${b}.state='ACTIVE' AND ${requireConsent ? Prisma.sql`${b}.statistics_consent=true AND ${b}.statistics_revoked_at IS NULL` : Prisma.sql`true`} AND ${expiry}
    AND ${b}.checked_at IS NOT NULL AND ${b}.checked_at<=now()+interval '30 seconds'
    AND NOT EXISTS(SELECT 1 FROM chat_membership_activity_events e
      WHERE e.chat_id=${b}.entity_id AND e.user_id=${b}.actor_user_id
        AND e.event_type IN ('user_added','user_removed') AND e.event_at AT TIME ZONE 'UTC'>=${b}.checked_at)
    AND NOT EXISTS(SELECT 1 FROM managed_entity_access_edges a
      WHERE a.chat_id=${b}.entity_id AND a.user_id=${b}.actor_user_id AND a.bot_id=${b}.bot_id
        AND a.checked_at AT TIME ZONE 'UTC'>=${b}.checked_at
        AND (a.state<>'GRANTED' OR a.user_role NOT IN ('OWNER','ADMIN') OR a.bot_role NOT IN ('OWNER','ADMIN')))
    AND ((${b}.profile='moderation' AND EXISTS(
      SELECT 1 FROM chat_bot_memberships m WHERE m.chat_id=${b}.entity_id AND m.bot_id=${b}.bot_id AND m.status='ACTIVE'
        AND (m.lifecycle_event_at IS NULL OR m.lifecycle_event_at AT TIME ZONE 'UTC'<${b}.checked_at)
        AND (m.bot_access_checked_at IS NULL OR m.bot_access_checked_at AT TIME ZONE 'UTC'<${b}.checked_at OR m.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER'))
    )) OR (${b}.profile='publisher' AND EXISTS(
      SELECT 1 FROM publisher_entity_bindings p WHERE p.chat_id=${b}.entity_id AND p.publisher_bot_id=${b}.bot_id AND p.status='ACTIVE'
        AND (p.lifecycle_event_at IS NULL OR p.lifecycle_event_at AT TIME ZONE 'UTC'<${b}.checked_at)
        AND (p.bot_access_checked_at IS NULL OR p.bot_access_checked_at AT TIME ZONE 'UTC'<${b}.checked_at OR p.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER'))
    )))`;
}

@Injectable()
export class MarketplaceStateService {
  private readonly logger = new Logger(MarketplaceStateService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  enabled(): boolean {
    return Boolean(
      this.config.get<string>('SVYAZKA_ANALYTICS_TOKEN') &&
      this.config.get<string>('SVYAZKA_PROFILE_TOKEN'),
    );
  }
  async read(id: string): Promise<MarketplaceBindingRow | null> {
    const rows = await this.prisma.$queryRaw<
      MarketplaceBindingRow[]
    >`SELECT * FROM marketplace_bindings WHERE id=${id}::uuid`;
    return rows[0] ?? null;
  }
  present(row: MarketplaceBindingRow): MarketplaceBinding {
    // FLAG: Statistics clients retain the explicit withdrawal even when an
    // independent button/profile check refreshes the same exact access proof.
    return this.presentBinding(row, 'statistics');
  }
  presentAccess(row: MarketplaceBindingRow): MarketplaceBinding {
    return this.presentBinding(row, 'access');
  }
  private presentBinding(
    row: MarketplaceBindingRow,
    purpose: 'statistics' | 'access',
  ): MarketplaceBinding {
    const denied = purpose === 'statistics' && row.statistics_revoked_at != null;
    return marketplaceBindingSchema.parse({
      id: row.id,
      actorUserId: row.actor_user_id,
      entityId: row.entity_id,
      kind: row.kind,
      profile: row.profile,
      state: denied
        ? 'REVOKED'
        : row.state === 'ACTIVE' && (!row.valid_until || row.valid_until.getTime() <= Date.now())
          ? 'UNKNOWN'
          : row.state,
      revision: row.revision,
      checkedAt: row.checked_at?.toISOString() ?? null,
      validUntil: denied ? null : (row.valid_until?.toISOString() ?? null),
      updatedAt: row.updated_at.toISOString(),
      generationId: row.generation_id,
      statisticsCheckedAt: row.statistics_checked_at?.toISOString() ?? null,
      historyComplete: row.history_complete,
      historyFrom: row.history_from?.toISOString() ?? null,
      collectionOwner: row.collection_owner,
      collectionMetrics: row.collection_metrics,
      statisticsConsent: row.statistics_consent,
      metadata: row.metadata,
    });
  }
  async hasActiveGrant(id: string, lease?: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM marketplace_bindings WHERE id=${id}::uuid AND ${marketplaceLocalGrantSql()}
        AND (${lease === undefined} OR (lease_id=${lease ?? null}::uuid AND lease_until>now()))`;
    return rows.length > 0;
  }
  async hasActiveAccess(id: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM marketplace_bindings WHERE id=${id}::uuid AND ${marketplaceLocalGrantSql('marketplace_bindings', false)}`;
    return rows.length > 0;
  }
  async hasHealthyCollectionOwner(input: {
    entityId: string;
    metrics: Array<'AUDIENCE' | 'REACH' | 'PUBLICATION_HOUR'>;
  }): Promise<boolean> {
    if (!this.enabled() || !input.metrics.length) return false;
    const proofMetrics = [
      ...new Set(
        input.metrics.includes('REACH') ? [...input.metrics, 'PUBLICATION_HOUR'] : input.metrics,
      ),
    ];
    const needsAudience = input.metrics.includes('AUDIENCE');
    const needsPosts = input.metrics.some((metric) => metric !== 'AUDIENCE');
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT b.id FROM marketplace_bindings b
      WHERE b.entity_id=${input.entityId} AND b.kind='CHANNEL'
        AND b.state='ACTIVE' AND b.statistics_consent=true AND b.valid_until>now()
        AND b.collection_owner='MAXIM' AND b.collection_metrics @> ${JSON.stringify(input.metrics)}::jsonb
        AND b.statistics_checked_at BETWEEN now()-interval '5 minutes' AND now()+interval '30 seconds'
        AND EXISTS(SELECT 1 FROM marketplace_statistics_generations g WHERE g.id=b.generation_id AND g.binding_id=b.id
          AND g.manifest->>'complete'='true'
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(proofMetrics)}::jsonb) required(metric)
            WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.rows) point WHERE point->>'metric'=required.metric))
          AND NOT EXISTS(
            SELECT 1 FROM jsonb_array_elements(g.rows) point WHERE ${JSON.stringify(proofMetrics)}::jsonb ? (point->>'metric')
              AND (point->>'incomplete'='true' OR point->>'complete'='false')))
        AND (${!needsAudience} OR b.native_audience_checked_at BETWEEN now()-interval '5 minutes' AND now()+interval '30 seconds')
        AND (${!needsPosts} OR (b.history_complete=true AND b.history_anomaly=false
          AND b.native_history_checked_at BETWEEN now()-interval '2 hours' AND now()+interval '30 seconds'
          AND b.native_full_checked_at BETWEEN now()-interval '2 hours' AND now()+interval '30 seconds'))
        AND ${marketplaceLocalGrantSql('b')} LIMIT 1`;
    return rows.length > 0;
  }
  async resolvePublicationButton(input: {
    chatId: string;
    botId: string;
    now?: Date;
    purpose?:
      | 'PUBLICATION'
      | 'VK_IMPORT'
      | 'APPROVED_SUGGESTION'
      | 'GREETING'
      | 'MODERATION_NOTICE'
      | 'CHANNEL_POST';
    sourceAt?: Date;
    module?: MarketplaceButtonModule;
  }): Promise<{ url: string; revision: number; caption: string } | null> {
    if (!this.enabled()) return null;
    const purpose = input.purpose ?? 'PUBLICATION';
    const context =
      purpose === 'GREETING'
        ? 'GREETINGS'
        : purpose === 'MODERATION_NOTICE'
          ? 'MODERATION_NOTICES'
          : purpose === 'CHANNEL_POST'
            ? 'CHANNEL_POSTS'
            : 'PUBLICATIONS';
    const modules = marketplaceButtonModules[context];
    const module =
      input.module ??
      (purpose === 'MODERATION_NOTICE'
        ? 'OTHER_MODERATION'
        : purpose === 'GREETING'
          ? 'GREETING'
          : purpose === 'CHANNEL_POST'
            ? 'CHANNEL_POST'
            : purpose);
    if (!modules.includes(module)) return null;
    const resolvedContext = modules.length > 1 ? module : context;
    const now = input.now ?? new Date();
    // FLAG: Final proof is independent of statistics consent and belongs to the
    // exact confirmer, platform and selected sender. A route hint grants nothing.
    const rows = await this.prisma.$queryRaw<
      Array<{ public_url: string; revision: number; caption: string | null }>
    >`
      SELECT c.public_url,p.revision,t.caption FROM marketplace_button_policies p
      LEFT JOIN marketplace_button_captions t ON t.entity_id=p.entity_id AND t.kind=p.kind
      JOIN marketplace_button_contexts c ON c.policy_id=p.id
      JOIN marketplace_bindings b ON b.id=c.binding_id AND b.actor_user_id=c.confirmed_by AND b.entity_id=p.entity_id AND b.kind=p.kind AND b.profile=p.profile
      WHERE p.entity_id=${input.chatId} AND (c.context=${resolvedContext} OR (c.context=${context}
        AND ${!['NIGHT_MODE', 'RULES'].includes(module)}
        AND NOT EXISTS(SELECT 1 FROM marketplace_button_contexts child WHERE child.policy_id=p.id AND child.context=ANY(${[...modules]}::text[])))) AND c.enabled=true AND c.suspended_reason IS NULL
        AND c.public_url IS NOT NULL AND c.verified_until>${now} AND b.valid_until>${now}
        AND b.checked_at>${now}::timestamptz-interval '5 minutes'
        AND ${marketplaceLocalGrantSql('b', false)}
        AND (b.last_button_access_loss_at IS NULL OR b.last_button_access_loss_at<c.confirmed_at)
        AND (${context !== 'CHANNEL_POSTS'} OR (${input.sourceAt ?? null}::timestamptz IS NOT NULL AND ${input.sourceAt ?? null}::timestamptz>=c.confirmed_at))
        AND (${context === 'PUBLICATIONS'} OR p.profile='moderation')
        AND NOT EXISTS(SELECT 1 FROM chat_membership_activity_events e WHERE e.chat_id=p.entity_id AND e.user_id=c.confirmed_by AND e.event_type='user_removed' AND e.event_at AT TIME ZONE 'UTC'>=c.confirmed_at)
        AND NOT EXISTS(SELECT 1 FROM managed_entity_access_edges a WHERE a.chat_id=p.entity_id AND a.user_id=c.confirmed_by AND a.bot_id=b.bot_id AND a.checked_at AT TIME ZONE 'UTC'>=c.confirmed_at AND (a.state<>'GRANTED' OR a.user_role NOT IN ('OWNER','ADMIN')))
        AND ((p.profile='moderation' AND EXISTS(SELECT 1 FROM chat_bot_memberships m WHERE m.chat_id=p.entity_id AND m.bot_id=${input.botId} AND m.status='ACTIVE'
          AND (m.lifecycle_event_at IS NULL OR m.lifecycle_event_at AT TIME ZONE 'UTC'<b.checked_at)
          AND ((m.bot_id=b.bot_id AND (m.bot_access_checked_at IS NULL OR m.bot_access_checked_at AT TIME ZONE 'UTC'<b.checked_at OR m.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER')))
            OR (m.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER') AND m.bot_access_checked_at IS NOT NULL))))
          OR (p.profile='publisher' AND b.bot_id=${input.botId} AND EXISTS(SELECT 1 FROM publisher_entity_bindings pb WHERE pb.chat_id=p.entity_id AND pb.publisher_bot_id=${input.botId} AND pb.status='ACTIVE'
          AND (pb.lifecycle_event_at IS NULL OR pb.lifecycle_event_at AT TIME ZONE 'UTC'<b.checked_at)
          AND (pb.bot_access_checked_at IS NULL OR pb.bot_access_checked_at AT TIME ZONE 'UTC'<b.checked_at OR pb.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER')))))
      ORDER BY c.verified_until DESC,p.id LIMIT 1`;
    if (rows[0])
      return {
        url: rows[0].public_url,
        revision: rows[0].revision,
        caption: rows[0].caption ?? MARKETPLACE_BUTTON_DEFAULT_CAPTION,
      };
    if (context !== 'PUBLICATIONS') return null;
    // Compatibility only until the first canonical policy exists. It cannot
    // restore a disabled setting or extend the old publication consent's scope.
    const canonical = await this.prisma.$queryRaw<
      Array<{ id: string }>
    >`SELECT p.id FROM marketplace_button_policies p WHERE p.entity_id=${input.chatId}
      AND ((p.profile='moderation' AND EXISTS(SELECT 1 FROM chat_bot_memberships m WHERE m.chat_id=p.entity_id AND m.bot_id=${input.botId}))
        OR (p.profile='publisher' AND EXISTS(SELECT 1 FROM publisher_entity_bindings b WHERE b.chat_id=p.entity_id AND b.publisher_bot_id=${input.botId}))) LIMIT 1`;
    return canonical.length ? null : this.resolveLegacyPublicationButton(input);
  }
  async channelPostActivation(chatId: string): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ confirmed_at: Date }>
    >`SELECT c.confirmed_at FROM marketplace_button_policies p JOIN marketplace_button_contexts c ON c.policy_id=p.id
      WHERE p.entity_id=${chatId} AND p.kind='CHANNEL' AND p.profile='moderation' AND c.context='CHANNEL_POSTS' AND c.enabled=true AND c.suspended_reason IS NULL LIMIT 1`;
    return rows[0]?.confirmed_at ?? null;
  }
  async listChannelPostTargets(limit: number, after = ''): Promise<Array<{ chatId: string }>> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit) || 1));
    const rows = await this.prisma.$queryRaw<
      Array<{ entity_id: string }>
    >`SELECT p.entity_id FROM marketplace_button_policies p JOIN marketplace_button_contexts c ON c.policy_id=p.id
      WHERE p.entity_id>${after} AND p.kind='CHANNEL' AND p.profile='moderation' AND c.context='CHANNEL_POSTS' AND c.enabled=true AND c.suspended_reason IS NULL ORDER BY p.entity_id LIMIT ${bounded}`;
    return rows.map((row) => ({ chatId: row.entity_id }));
  }
  private async resolveLegacyPublicationButton(input: {
    chatId: string;
    botId: string;
    now?: Date;
  }): Promise<{ url: string; revision: number; caption: string } | null> {
    if (!this.enabled()) return null;
    const now = input.now ?? new Date();
    // FLAG: The actual sending bot must hold a fresh connection; routing hints never grant access.
    const rows = await this.prisma.$queryRaw<
      Array<{ public_url: string; append_revision: number; caption: string | null }>
    >`
      SELECT b.public_url,b.append_revision,t.caption FROM marketplace_bindings b
      LEFT JOIN marketplace_button_captions t ON t.entity_id=b.entity_id AND t.kind=b.kind
      WHERE b.entity_id=${input.chatId} AND b.actor_user_id=${MARKETPLACE_PILOT_USER_ID}
        AND b.state='ACTIVE' AND b.valid_until>${now} AND b.statistics_consent=true
        AND ${marketplaceLocalGrantSql('b')}
        AND b.append_enabled=true AND b.public_url IS NOT NULL AND b.public_verified_until>${now}
        AND NOT EXISTS(SELECT 1 FROM chat_membership_activity_events e WHERE e.chat_id=b.entity_id AND e.user_id=b.actor_user_id
          AND e.event_type IN ('user_added','user_removed') AND e.event_at AT TIME ZONE 'UTC'>=b.checked_at)
        AND ((b.profile='moderation' AND EXISTS (
          SELECT 1 FROM chat_bot_memberships m WHERE m.chat_id=b.entity_id AND m.bot_id=${input.botId}
            AND m.status='ACTIVE' AND (m.lifecycle_event_at IS NULL OR m.lifecycle_event_at AT TIME ZONE 'UTC'<b.checked_at)
            AND ((b.bot_id=m.bot_id AND (m.bot_access_checked_at IS NULL OR m.bot_access_checked_at AT TIME ZONE 'UTC'<b.checked_at OR m.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER')))
              OR (m.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER') AND m.bot_access_checked_at IS NOT NULL))
        )) OR (b.profile='publisher' AND EXISTS (
          SELECT 1 FROM publisher_entity_bindings p WHERE p.chat_id=b.entity_id AND p.publisher_bot_id=${input.botId}
            AND p.status='ACTIVE' AND b.bot_id=p.publisher_bot_id
            AND (p.lifecycle_event_at IS NULL OR p.lifecycle_event_at AT TIME ZONE 'UTC'<b.checked_at)
            AND (p.bot_access_checked_at IS NULL OR p.bot_access_checked_at AT TIME ZONE 'UTC'<b.checked_at OR p.bot_access_state IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER'))
        ))) ORDER BY b.public_verified_until DESC LIMIT 1`;
    const row = rows[0];
    return row
      ? {
          url: row.public_url,
          revision: row.append_revision,
          caption: row.caption ?? MARKETPLACE_BUTTON_DEFAULT_CAPTION,
        }
      : null;
  }
  async recordButtonDiagnostic(input: {
    chatId: string;
    botId: string;
    revision: number;
    code: 'KEYBOARD_FULL';
    purpose?:
      | 'PUBLICATION'
      | 'VK_IMPORT'
      | 'APPROVED_SUGGESTION'
      | 'GREETING'
      | 'MODERATION_NOTICE'
      | 'CHANNEL_POST';
  }): Promise<void> {
    const context =
      input.purpose === 'GREETING'
        ? 'GREETINGS'
        : input.purpose === 'MODERATION_NOTICE'
          ? 'MODERATION_NOTICES'
          : input.purpose === 'CHANNEL_POST'
            ? 'CHANNEL_POSTS'
            : 'PUBLICATIONS';
    await this.prisma
      .$executeRaw`UPDATE marketplace_button_contexts c SET diagnostic='KEYBOARD_FULL' FROM marketplace_button_policies p WHERE p.id=c.policy_id AND p.entity_id=${input.chatId} AND p.revision=${input.revision} AND (c.context=${context} OR c.context=ANY(${[...marketplaceButtonModules[context]]}::text[]))`;
    await this.prisma
      .$executeRaw`UPDATE marketplace_bindings SET button_diagnostic='KEYBOARD_FULL' WHERE entity_id=${input.chatId} AND append_revision=${input.revision}`;
    this.logger.warn(
      { code: 'KEYBOARD_FULL' },
      'Marketplace button omitted: existing keyboard preserved',
    );
  }
}
