import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  decodePublisherEntitiesCursor,
  encodePublisherEntitiesCursor,
  PUBLISHER_ENTITIES_CURSOR_INVALID_CODE,
  type PublisherEntitiesCursorQuery,
  type PublisherEntitiesSummary,
} from '@maxim/contracts/publisher';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

type Summary = { summary: PublisherEntitiesSummary; filteredTotal: number };
type Cursor = { scope: string; after: string; expiresAt: number };

@Injectable()
export class PublisherCatalogQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ChatContextCacheService,
  ) {}

  async page(
    userId: string,
    botId: string,
    query: PublisherEntitiesCursorQuery,
    runtimeAvailable: boolean,
  ) {
    const now = new Date();
    const scope = createHash('sha256')
      .update(
        JSON.stringify([
          'publisher',
          userId,
          botId,
          query.query,
          query.entityType ?? null,
          query.readiness ?? null,
        ]),
      )
      .digest('hex');
    let after: string | null = null;
    let expiresAt = now.getTime() + 15 * 60_000;
    if (query.cursor) {
      const decoded = decodePublisherEntitiesCursor(query.cursor);
      if (
        !decoded ||
        decoded.query !== query.query ||
        decoded.entityType !== (query.entityType ?? null) ||
        decoded.readiness !== (query.readiness ?? null) ||
        decoded.offset !== 1
      )
        throw this.invalidCursor();
      const raw = await this.cache.readPublisherCatalogState(decoded.snapshotId);
      const cursor: Cursor | null = raw ? JSON.parse(raw) : null;
      if (!cursor || cursor.scope !== scope || cursor.expiresAt <= now.getTime())
        throw this.invalidCursor();
      after = cursor.after;
      expiresAt = cursor.expiresAt;
    }
    const source = this.source(userId, botId, now, runtimeAvailable);
    const filter = Prisma.sql`
      (${query.entityType ?? null}::text IS NULL OR entity_type::text = ${query.entityType?.toUpperCase() ?? null})
      AND (${query.readiness ?? null}::text IS NULL OR ready = ${query.readiness === 'ready'})
      AND (${query.query} = '' OR POSITION(LOWER(${query.query}) IN LOWER(title || ' ' || chat_id)) > 0)`;
    const ids = await this.prisma.$queryRaw<{ chatId: string }[]>(Prisma.sql`
      WITH scoped AS (${source}) SELECT chat_id AS "chatId" FROM scoped
      WHERE ${filter} ${after === null ? Prisma.empty : Prisma.sql`AND chat_id > ${after}`}
      ORDER BY chat_id ASC LIMIT ${query.limit + 1}
    `);
    const summaryKey = `summary-${scope}-${Number(runtimeAvailable)}`;
    const cached = await this.cache.readPublisherCatalogState(summaryKey);
    let totals: Summary;
    if (cached) totals = JSON.parse(cached) as Summary;
    else {
      const [row] = await this.prisma.$queryRaw<
        {
          total: number;
          chat: number;
          channel: number;
          ready: number;
          filteredTotal: number;
        }[]
      >(Prisma.sql`
        WITH scoped AS (${source}) SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE entity_type = 'CHAT')::int AS chat,
          COUNT(*) FILTER (WHERE entity_type = 'CHANNEL')::int AS channel,
          COUNT(*) FILTER (WHERE ready)::int AS ready,
          COUNT(*) FILTER (WHERE ${filter})::int AS "filteredTotal" FROM scoped
      `);
      const count = row!;
      totals = {
        summary: {
          total: count.total,
          chat: count.chat,
          channel: count.channel,
          ready: count.ready,
          attention: count.total - count.ready,
        },
        filteredTotal: count.filteredTotal,
      };
      await this.cache.storePublisherCatalogState(summaryKey, JSON.stringify(totals), 15);
    }
    const page = ids.slice(0, query.limit);
    let nextCursor: string | null = null;
    if (ids.length > query.limit) {
      const snapshotId = randomUUID();
      await this.cache.storePublisherCatalogState(
        snapshotId,
        JSON.stringify({
          scope,
          after: page.at(-1)!.chatId,
          expiresAt,
        } satisfies Cursor),
        Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
      );
      nextCursor = encodePublisherEntitiesCursor({
        v: 1,
        snapshotId,
        offset: 1,
        query: query.query,
        entityType: query.entityType ?? null,
        readiness: query.readiness ?? null,
      });
    }
    return { ids: page.map((row) => row.chatId), nextCursor, ...totals };
  }

  private source(userId: string, botId: string, now: Date, runtimeAvailable: boolean) {
    // FLAG: This is a scoped read model, never an authorization grant. The page is
    // hydrated through current Publisher access again before any entity is returned.
    return Prisma.sql`
      SELECT edge.chat_id, edge.entity_type,
        COALESCE(NULLIF(BTRIM(catalog.title), ''), edge.chat_id) AS title,
        COALESCE(${runtimeAvailable} AND COALESCE(policy.publik_enabled, true)
          AND binding.bot_access_checked_at IS NOT NULL AND binding.bot_access_expires_at > ${now}
          AND (binding.send_route_quarantined_until IS NULL OR binding.send_route_quarantined_until <= ${now})
          AND (binding.bot_access_state = 'CONFIRMED_OWNER' OR (
            binding.bot_access_state = 'CONFIRMED_ADMIN'
            AND binding.permissions_snapshot->'permissionsKnown' = 'true'::jsonb
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(binding.permissions_snapshot->'permissions') = 'array'
              THEN binding.permissions_snapshot->'permissions' ELSE '[]'::jsonb END) permission
              WHERE REGEXP_REPLACE(LOWER(REGEXP_REPLACE(permission, '^\\s+|\\s+$', '', 'g')), '[-\\s]+', '_', 'g') IN
              ('write','can_write','post_edit_delete_message','post_edit_delete_messages',
               'can_post_edit_delete_message','can_post_edit_delete_messages'))
          )), false) AS ready
      FROM managed_entity_access_edges edge
      JOIN publisher_entity_bindings binding ON binding.chat_id = edge.chat_id
        AND binding.publisher_bot_id = edge.bot_id AND binding.status = 'ACTIVE'
        AND (binding.bot_access_state IN ('CONFIRMED_MEMBER','CONFIRMED_ADMIN','CONFIRMED_OWNER')
          OR (binding.bot_access_state = 'UNKNOWN' AND binding.last_webhook_at IS NOT NULL))
      JOIN managed_bot_chat_catalog catalog ON catalog.chat_id = edge.chat_id
        AND catalog.bot_id = edge.bot_id AND catalog.status = 'ACTIVE' AND catalog.entity_type = edge.entity_type
      LEFT JOIN managed_entity_publication_policies policy ON policy.chat_id = edge.chat_id
      WHERE edge.user_id = ${userId} AND edge.bot_id = ${botId} AND edge.state = 'GRANTED'
        AND edge.user_role IN ('OWNER','ADMIN')
        AND (edge.expires_at > ${now} OR (edge.expires_at IS NULL AND edge.checked_at > ${new Date(now.getTime() - 7 * 86400_000)}))
    `;
  }

  private invalidCursor() {
    return new BadRequestException({
      code: PUBLISHER_ENTITIES_CURSOR_INVALID_CODE,
      message: 'Список изменился. Обновите получателей.',
    });
  }
}
