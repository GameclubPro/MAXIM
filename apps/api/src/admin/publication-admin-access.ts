import { Prisma, PublicationDispatchProfile } from '../prisma/prisma-client';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';

export type PublicationAdminScope = Readonly<{ actorUserId: string; publisherBotId: string }>;

export function publicationAdminScope(
  actorUserId: string,
  publisherBotId?: string,
): PublicationAdminScope {
  return {
    actorUserId,
    publisherBotId:
      publisherBotId ?? buildPublisherBotDescriptor({ id: process.env.MAX_PUBLISHER_BOT_ID }).id,
  };
}

// FLAG: Shared publication access is exact Publisher SQL authority, never authorship,
// Major membership, historical confirmation or an expiring permission cache.
export function publicationAdminTargetWhere(
  scope: PublicationAdminScope,
): Prisma.PublicationTargetWhereInput {
  return {
    OR: (['CHAT', 'CHANNEL'] as const).map((entityType) => ({
      entityType,
      chat: {
        accessEdges: {
          some: {
            userId: scope.actorUserId,
            botId: scope.publisherBotId,
            entityType,
            state: 'GRANTED',
            userRole: { in: ['ADMIN', 'OWNER'] },
          },
        },
      },
    })),
  };
}

export function publicationAdminAccessWhere(
  scope: PublicationAdminScope,
  profile: PublicationDispatchProfile | undefined,
  mode: 'read' | 'manage' = 'read',
): Prisma.PublicationWhereInput {
  if (profile !== PublicationDispatchProfile.PUBLIK_V1) return { actorUserId: scope.actorUserId };
  const targetAccess = publicationAdminTargetWhere(scope);
  return {
    dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
    OR: [
      {
        targets: mode === 'manage' ? { some: {}, every: targetAccess } : { some: targetAccess },
      },
      // An imported post without recipients is still private, including its media.
      { actorUserId: scope.actorUserId, lifecycle: 'DRAFT', targets: { none: {} } },
    ],
  };
}

export function publicationAdminTargetSql(scope: PublicationAdminScope): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "managed_entity_access_edges" AS access_edge
    WHERE access_edge."chat_id" = target."target_chat_id"
      AND access_edge."user_id" = ${scope.actorUserId}
      AND access_edge."bot_id" = ${scope.publisherBotId}
      AND access_edge."entity_type" = target."entity_type"
      AND access_edge."state" = 'GRANTED'::"ManagedEntityAccessState"
      AND access_edge."user_role" IN ('ADMIN'::"ManagedEntityAccessRole", 'OWNER'::"ManagedEntityAccessRole")
    LIMIT 1 OFFSET 0
  )`;
}

export function publicationAdminReadSql(scope: PublicationAdminScope): Prisma.Sql {
  return Prisma.sql`(
    EXISTS (
      SELECT 1 FROM "publication_targets" AS target
      WHERE target."publication_id" = publication."id"
        AND ${publicationAdminTargetSql(scope)}
      LIMIT 1 OFFSET 0
    ) OR (
      publication."actor_user_id" = ${scope.actorUserId}
      AND publication."lifecycle" = 'DRAFT'::"PublicationLifecycle"
      AND NOT EXISTS (
        SELECT 1 FROM "publication_targets" AS target
        WHERE target."publication_id" = publication."id"
        LIMIT 1 OFFSET 0
      )
    )
  )`;
}

// FLAG: Statistics and blockers obey the same current recipient scope as the details
// page. Joining a publication alone would disclose another administrator's recipients.
export function publicationAdminDeliverySql(scope?: PublicationAdminScope): Prisma.Sql {
  return scope
    ? Prisma.sql`AND EXISTS (
    SELECT 1 FROM "publication_targets" AS target
    WHERE target."publication_id" = occurrence."publication_id"
      AND target."target_chat_id" = delivery."target_chat_id"
      AND ${publicationAdminTargetSql(scope)}
    LIMIT 1 OFFSET 0
  )`
    : Prisma.empty;
}
