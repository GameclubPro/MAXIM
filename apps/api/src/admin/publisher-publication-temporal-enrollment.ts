import { Prisma } from '../prisma/prisma-client';

export type PublisherTemporalSelectionRollout = 'off' | 'test' | '5' | '25' | '100';

const MAX_AUDIENCE_SIZE = 64;
const MAX_AUDIENCE_JSON_BYTES = 16 * 1024;
const TEST_CHAT_ID = '-78271094414679';
const TEST_CHANNEL_ID = '-78271171091799';
const CANONICAL_MAX_ID = '^-?[1-9][0-9]{0,18}$';

export function parsePublisherTemporalSelectionRollout(
  value: unknown,
): PublisherTemporalSelectionRollout {
  return value === 'test' || value === '5' || value === '25' || value === '100' ? value : 'off';
}

// FLAG: This is selection preference only. An unproved audience stays on the old path;
// enrollment never grants publication authority or permits repeating an uncertain effect.
export function buildPublisherTemporalEnrollment(
  rollout: PublisherTemporalSelectionRollout,
): Prisma.Sql {
  const mode = parsePublisherTemporalSelectionRollout(rollout);
  if (mode === 'off') return Prisma.sql`FALSE`;

  const cohort =
    mode === 'test' || mode === '100'
      ? Prisma.sql`TRUE`
      : Prisma.sql`
          (
            ('x' || substr(md5(
              'publisher-temporal-v1:'
              || octet_length(broadcast."required_bot_id")::text || ':'
              || broadcast."required_bot_id" || ':'
              || octet_length(publication."id")::text || ':' || publication."id"
            ), 1, 8))::bit(32)::bigint % 100
          ) < ${mode === '5' ? 5 : 25}
        `;
  const currentDeliveryCoverage = Prisma.sql`
    COUNT(*) = (SELECT COUNT(*) FROM temporal_delivery_page)
    AND NOT EXISTS (
      SELECT 1 FROM temporal_saved_targets AS saved
      WHERE NOT EXISTS (
        SELECT 1 FROM temporal_delivery_page AS delivery
        WHERE delivery."target_chat_id" = saved."target_chat_id"
      )
    )
  `;
  const currentAudience = buildSavedAudienceProof(
    Prisma.sql`broadcast."target_chat_ids"`,
    Prisma.sql`broadcast."entity_type"`,
    currentDeliveryCoverage,
  );
  const testAudience =
    mode === 'test'
      ? Prisma.sql`
          NOT EXISTS (
            SELECT 1 FROM temporal_publication_target_page AS target
            WHERE NOT (
              (target."entity_type" = 'CHAT'::"ChatEntityType" AND target."target_chat_id" = ${TEST_CHAT_ID})
              OR (target."entity_type" = 'CHANNEL'::"ChatEntityType" AND target."target_chat_id" = ${TEST_CHANNEL_ID})
            )
          )
          AND ${buildTestSiblingAudienceProof()}
        `
      : Prisma.sql`TRUE`;

  return Prisma.sql`
    CASE WHEN publication."audience_mode" = 'SNAPSHOT'::"PublicationAudienceMode"
      AND broadcast."apply_to_all_chats" = FALSE
      AND length(btrim(broadcast."required_bot_id")) > 0
      AND ${cohort}
    THEN (
      WITH temporal_publication_target_page AS MATERIALIZED (
        SELECT target."target_chat_id", target."entity_type"
        FROM "publication_targets" AS target
        WHERE target."publication_id" = publication."id"
        LIMIT ${MAX_AUDIENCE_SIZE + 1}
      )
      SELECT CASE
        WHEN COUNT(*) BETWEEN 1 AND ${MAX_AUDIENCE_SIZE}
          THEN (${currentAudience}) IS TRUE AND (${testAudience}) IS TRUE
        ELSE FALSE
      END
      FROM temporal_publication_target_page
    ) ELSE FALSE END
  `;
}

function buildSavedAudienceProof(
  audience: Prisma.Sql,
  entityType: Prisma.Sql,
  additionalCoverage: Prisma.Sql,
): Prisma.Sql {
  // FLAG: pg_column_size alone measures compressed storage. Reject compressed/oversized
  // values before any JSON operation; only then inspect the bounded uncompressed value.
  // Nested CASE prevents SQL predicate reordering from expanding an unbounded audience.
  return Prisma.sql`
    CASE WHEN pg_column_compression(${audience}) IS NULL
      AND pg_column_size(${audience}) <= ${MAX_AUDIENCE_JSON_BYTES}
    THEN CASE WHEN jsonb_typeof(${audience}) = 'array'
    THEN CASE WHEN jsonb_array_length(${audience}) BETWEEN 1 AND ${MAX_AUDIENCE_SIZE}
    THEN CASE WHEN octet_length((${audience})::text) <= ${MAX_AUDIENCE_JSON_BYTES}
    THEN (
      WITH temporal_saved_targets AS MATERIALIZED (
        SELECT element."value", element."value" #>> '{}' AS "target_chat_id"
        FROM jsonb_array_elements(${audience}) AS element("value")
      )
      SELECT COUNT(*) = COUNT(DISTINCT saved."target_chat_id")
        AND COALESCE(BOOL_AND((
          jsonb_typeof(saved."value") = 'string'
          AND saved."target_chat_id" ~ ${CANONICAL_MAX_ID}
        ) IS TRUE), FALSE)
        AND COUNT(*) = (
          SELECT COUNT(*) FROM temporal_publication_target_page AS target
          WHERE target."entity_type" = ${entityType}
        )
        AND NOT EXISTS (
          SELECT 1 FROM temporal_saved_targets AS actual
          WHERE NOT EXISTS (
            SELECT 1 FROM temporal_publication_target_page AS target
            WHERE target."entity_type" = ${entityType}
              AND target."target_chat_id" = actual."target_chat_id"
          )
        )
        AND (${additionalCoverage})
      FROM temporal_saved_targets AS saved
    ) ELSE FALSE END ELSE FALSE END ELSE FALSE END ELSE FALSE END
  `;
}

function buildTestSiblingAudienceProof(): Prisma.Sql {
  const siblingAudience = buildSavedAudienceProof(
    Prisma.sql`temporal_sibling."target_chat_ids"`,
    Prisma.sql`temporal_sibling."entity_type"`,
    Prisma.sql`TRUE`,
  );
  // FLAG: Test enrollment covers every execution audience of the whole publication.
  // Cap occurrences before sibling joins: LIMIT on the joined rows alone could probe
  // arbitrarily many empty historical occurrences. Then cap sibling ids before JSON.
  return Prisma.sql`
    (
      WITH temporal_publication_occurrence_page AS MATERIALIZED (
        SELECT historical_occurrence."id"
        FROM "publication_occurrences" AS historical_occurrence
        WHERE historical_occurrence."publication_id" = publication."id"
        LIMIT ${MAX_AUDIENCE_SIZE + 1}
      )
      SELECT CASE WHEN COUNT(*) BETWEEN 1 AND ${MAX_AUDIENCE_SIZE} THEN (
        WITH temporal_sibling_page AS MATERIALIZED (
          SELECT sibling."id"
          FROM temporal_publication_occurrence_page AS sibling_occurrence
          INNER JOIN "managed_broadcasts" AS sibling
            ON sibling."publication_occurrence_id" = sibling_occurrence."id"
          LIMIT ${MAX_AUDIENCE_SIZE + 1}
        )
        SELECT CASE WHEN COUNT(*) BETWEEN 1 AND ${MAX_AUDIENCE_SIZE} THEN
          NOT EXISTS (
            SELECT 1
            FROM temporal_sibling_page AS sibling_id
            INNER JOIN "managed_broadcasts" AS temporal_sibling
              ON temporal_sibling."id" = sibling_id."id"
            WHERE (CASE
              WHEN temporal_sibling."apply_to_all_chats" = FALSE
                AND temporal_sibling."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
                AND temporal_sibling."required_bot_id" = broadcast."required_bot_id"
              THEN ${siblingAudience}
              ELSE FALSE
            END) IS NOT TRUE
          )
            ELSE FALSE
        END
        FROM temporal_sibling_page
      )
        ELSE FALSE
      END
      FROM temporal_publication_occurrence_page
    )
  `;
}
