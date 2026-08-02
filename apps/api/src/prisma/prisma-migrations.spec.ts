import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_USER_DISPLAY_NAME_EVENT_TYPES } from '../common/local-user-display-name-events';

const LOCAL_DISPLAY_NAME_EVENTS = LOCAL_USER_DISPLAY_NAME_EVENT_TYPES;

function readMigration(name: string): string {
  return readFileSync(resolve(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
}

function readSchema(): string {
  return readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
}

describe('Prisma migrations', () => {
  it('adds ordered channel suggestion image assets without rewriting legacy audit payloads', () => {
    const schema = readSchema();
    const migration = readMigration('20260802061500_add_channel_suggestion_image_assets');
    const indexMigration = readMigration('20260802061600_index_channel_suggestion_image_assets');

    expect(schema).toContain('model ChannelSuggestionImageAsset');
    expect(schema).toContain('channelSuggestionImageAssets     ChannelSuggestionImageAsset[]');
    expect(schema).toContain(
      '@@unique([auditLogId, position], map: "channel_suggestion_image_assets_audit_position_key")',
    );
    expect(migration).toContain('CREATE TABLE "channel_suggestion_image_assets"');
    expect(migration).toContain('"bytes" BYTEA');
    expect(migration).toContain('"durable_payload" JSONB');
    expect(migration).toContain('OCTET_LENGTH("bytes") > 0');
    expect(migration).toContain('"size_bytes" = OCTET_LENGTH("bytes")');
    expect(migration).toContain('JSONB_TYPEOF("durable_payload") = \'object\'');
    expect(indexMigration).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY "channel_suggestion_image_assets_audit_position_key"',
    );
    expect(migration).toContain('ON DELETE CASCADE ON UPDATE CASCADE');
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|audit_logs|FROM)\b/u);
  });

  it('removes unused raw membership indexes and tunes autovacuum without running it', () => {
    const schema = readSchema();
    const dropMigrations = new Map([
      [
        'chat_membership_activity_events_dashboard_idx',
        readMigration('20260802054500_drop_membership_dashboard_index'),
      ],
      [
        'chat_membership_activity_events_chat_id_event_type_event_at_idx',
        readMigration('20260802054600_drop_membership_event_type_index'),
      ],
      [
        'chat_membership_activity_events_chat_id_event_at_idx',
        readMigration('20260802054700_drop_membership_event_at_index'),
      ],
    ]);
    const tuningMigration = readMigration('20260802054800_tune_high_growth_table_autovacuum');

    for (const [indexName, migration] of dropMigrations) {
      expect(schema).not.toContain(indexName);
      expect(migration).toContain(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
      expect(migration.match(/;/gu)).toHaveLength(1);
    }
    expect(schema).toContain('chat_membership_activity_events_chat_id_user_id_event_at_idx');
    expect([...dropMigrations.values()].join('\n')).not.toContain(
      'chat_membership_activity_feed_items_chat_event_idx',
    );

    for (const tableName of [
      'webhook_events',
      'webhook_execution_claims',
      'managed_entity_local_activities',
      'max_action_ledger',
      'vk_parsing_posts',
      'managed_broadcasts',
    ]) {
      expect(tuningMigration).toContain(`ALTER TABLE "${tableName}" SET (`);
    }
    expect(tuningMigration).toContain('autovacuum_vacuum_scale_factor = 0.05');
    expect(tuningMigration).toContain('autovacuum_vacuum_insert_scale_factor = 0.05');
    expect(tuningMigration).not.toMatch(/\b(?:VACUUM|REINDEX)\b/u);
  });

  it('backfills channel view milestones only from bounded post-age snapshots', () => {
    const schema = readSchema();
    const migration = readMigration('20260801120000_add_channel_post_view_milestones');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toMatch(/^\s*viewsAt24h\s+Int\?/m);
    expect(schema).toMatch(/^\s*viewsAt24hCapturedAt\s+DateTime\?/m);
    expect(schema).toMatch(/^\s*viewsAt48h\s+Int\?/m);
    expect(schema).toMatch(/^\s*viewsAt48hCapturedAt\s+DateTime\?/m);
    expect(compact).toContain(`posts."published_at" >= CURRENT_TIMESTAMP - INTERVAL '30 days'`);
    expect(compact).toContain(
      `snapshots."captured_at" >= posts."published_at" + INTERVAL '24 hours'`,
    );
    expect(compact).toContain(
      `snapshots."captured_at" <= posts."published_at" + INTERVAL '27 hours'`,
    );
    expect(compact).toContain(
      `snapshots."captured_at" >= posts."published_at" + INTERVAL '48 hours'`,
    );
    expect(compact).toContain(
      `snapshots."captured_at" <= posts."published_at" + INTERVAL '51 hours'`,
    );
    expect(compact).toContain('ORDER BY snapshots."captured_at" ASC, snapshots."id" ASC LIMIT 1');
    expect(compact).toContain('CASE WHEN snapshot_24h."views" > 0 THEN snapshot_24h."views" END');
    expect(compact).toContain('CASE WHEN snapshot_48h."views" > 0 THEN snapshot_48h."views" END');
    expect(compact).not.toContain('latest_views');
    expect(compact).toContain('CREATE INDEX CONCURRENTLY "channel_posts_24h_milestone_due_idx"');
    expect(compact).toContain('CREATE INDEX CONCURRENTLY "channel_posts_48h_milestone_due_idx"');
  });

  it('adds durable milestone cooldown and bounded views discovery cursors', () => {
    const schema = readSchema();
    const migration = readMigration('20260801183000_add_channel_stats_collection_cursors');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toMatch(/^\s*viewMilestoneLastAttemptAt\s+DateTime\?/m);
    expect(schema).toMatch(/^\s*lastViewsDiscoveryAt\s+DateTime\?/m);
    expect(schema).toMatch(/^\s*lastViewsAttemptAt\s+DateTime\?/m);
    expect(compact).toContain('ADD COLUMN "view_milestone_last_attempt_at" TIMESTAMP(3)');
    expect(compact).toContain('ADD COLUMN "last_views_discovery_at" TIMESTAMP(3)');
    expect(compact).toContain('ADD COLUMN "last_views_attempt_at" TIMESTAMP(3)');
    expect(compact).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i);
  });

  it('resets every thematic codeword column before the later database drop', () => {
    const migration = readMigration('20260716043000_retire_thematic_codeword_settings');
    const compact = migration.replace(/\s+/g, ' ').trim();
    const resetAssignments = [
      '"thematic_codeword_enabled" = false',
      '"thematic_codeword" = \'\'',
      '"thematic_filters_bot_message_enabled" = false',
      '"thematic_filters_warn_enabled" = false',
      '"thematic_filters_ban_enabled" = false',
      '"thematic_filters_mute_enabled" = false',
      '"thematic_filters_mute_duration_hours" = 6',
      '"thematic_filters_admin_contact_button_enabled" = false',
      '"thematic_filters_admin_contact_button_url" = \'\'',
      '"thematic_filters_bot_button_enabled" = false',
      '"thematic_filters_bot_button_url" = \'\'',
      '"thematic_filters_bot_button_text" = \'Открыть\'',
      '"thematic_filters_bot_buttons" = \'[]\'::jsonb',
      '"thematic_filters_rules_button_enabled" = false',
    ];

    expect(compact).toContain('UPDATE "chat_settings" SET');
    for (const assignment of resetAssignments) {
      expect(compact).toContain(assignment);
      expect(compact).toContain(`${assignment.split(' = ')[0]} IS DISTINCT FROM`);
    }
    expect(compact).not.toMatch(/\b(?:ALTER|CREATE|DROP|TRUNCATE|DELETE)\b/i);

    const schema = readSchema();
    expect(schema).not.toMatch(/\bthematic(?:Codeword|Filters)/);
  });

  it('drops every retired thematic codeword column after the compatible client deploy', () => {
    const migration = readMigration('20260716050000_drop_thematic_codeword_settings');
    const compact = migration.replace(/\s+/g, ' ').trim();
    const droppedColumns = [
      'thematic_codeword_enabled',
      'thematic_codeword',
      'thematic_filters_bot_message_enabled',
      'thematic_filters_warn_enabled',
      'thematic_filters_ban_enabled',
      'thematic_filters_mute_enabled',
      'thematic_filters_mute_duration_hours',
      'thematic_filters_admin_contact_button_enabled',
      'thematic_filters_admin_contact_button_url',
      'thematic_filters_bot_button_enabled',
      'thematic_filters_bot_button_url',
      'thematic_filters_bot_button_text',
      'thematic_filters_bot_buttons',
      'thematic_filters_rules_button_enabled',
    ];

    expect(compact).toMatch(/^ALTER TABLE "chat_settings" /);
    for (const column of droppedColumns) {
      expect(compact).toContain(`DROP COLUMN "${column}"`);
    }
    expect(compact).not.toMatch(/\b(?:UPDATE|CREATE|TRUNCATE|DELETE)\b/i);
  });

  it('keeps the local display-name webhook lookup index aligned with the runtime SQL', () => {
    const migration = readMigration('20260707152000_optimize_local_display_name_lookup');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(compact).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_local_display_name_chat_user_created_idx"',
    );
    expect(compact).toContain(
      `ON "webhook_events" ( (NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '')), (NULLIF(BTRIM("normalized_payload"->'message'->>'senderId'), '')), "created_at" DESC )`,
    );
    expect(compact).toContain(
      `NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '') IS NOT NULL`,
    );
    expect(compact).toContain(
      `NULLIF(BTRIM("normalized_payload"->'message'->>'senderName'), '') IS NOT NULL`,
    );

    for (const eventType of LOCAL_DISPLAY_NAME_EVENTS) {
      expect(compact).toContain(`'${eventType}'`);
    }
  });

  it('indexes the global retention cleanup cutoffs', () => {
    const schema = readSchema();
    const migration = readMigration('20260719110000_bound_retention_cleanup');

    expect(schema).toContain('@@index([createdAt], map: "violations_created_at_idx")');
    expect(migration).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "violations_created_at_idx"',
    );
    expect(migration).toContain('ON "violations"("created_at")');
    expect(migration).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_retention_completed_created_id_idx"',
    );
    expect(migration).toContain('ON "webhook_events"("created_at", "id")');
    expect(migration).toContain(
      `WHERE "status" IN ('PROCESSED'::"WebhookStatus", 'DUPLICATE'::"WebhookStatus")`,
    );
  });

  it('adds a durable chat-scoped display-name read model', () => {
    const schema = readSchema();
    const migration = readMigration('20260714120000_add_chat_user_display_names');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toContain('model ChatUserDisplayName {');
    expect(schema).toContain('@@id([chatId, userId])');
    expect(schema).toContain('@@map("chat_user_display_names")');
    expect(compact).toContain('CREATE TABLE IF NOT EXISTS "chat_user_display_names"');
    expect(compact).toContain('"display_name" TEXT NOT NULL');
    expect(compact).toContain('"observed_at" TIMESTAMP(3) NOT NULL');
    expect(compact).toContain('"source_event_id" TEXT NOT NULL');
    expect(compact).toContain('"source_kind" TEXT NOT NULL');
    expect(compact).toContain(
      'CONSTRAINT "chat_user_display_names_pkey" PRIMARY KEY ("chat_id", "user_id")',
    );
    expect(compact).toContain('CHECK (BTRIM("display_name") <> \'\')');
    expect(compact).toContain(
      'CREATE INDEX IF NOT EXISTS "chat_user_display_names_observed_at_idx" ON "chat_user_display_names"("observed_at")',
    );
    expect(migration).not.toMatch(/\b(?:TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i);
  });

  it('repairs duplicate membership names without replaying membership rollups', () => {
    const schema = readSchema();
    const migration = readMigration('20260714121500_repair_membership_display_name_replays');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toContain('model ChatUserDisplayNameBackfillState {');
    expect(schema).toContain('@@id([chatId, sourceKind])');
    expect(compact).toContain(
      'CREATE TABLE IF NOT EXISTS "chat_user_display_name_backfill_states"',
    );
    expect(compact).toContain(
      'CREATE TRIGGER "chat_membership_activity_events_rollup_sender_name_update"',
    );
    expect(compact).toContain('AFTER UPDATE OF "sender_name" ON "chat_membership_activity_events"');
    expect(compact).toContain('EXECUTE FUNCTION "sync_chat_membership_activity_rollup"()');
    expect(compact).toContain("COALESCE(BTRIM(OLD.\"sender_name\"), '') = ''");
    expect(compact).toContain("COALESCE(BTRIM(NEW.\"sender_name\"), '') <> ''");
    expect(migration).not.toMatch(/\b(?:TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i);
  });

  it('keeps moderation display-name backfill off nameless rows', () => {
    const migration = readMigration('20260714123000_optimize_display_name_backfill');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(compact).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_moderation_feed_items_chat_named_created_id_idx"',
    );
    expect(compact).toContain(
      'ON "chat_moderation_feed_items"("chat_id", "created_at" DESC, "id" DESC)',
    );
    expect(compact).toContain("WHERE COALESCE(BTRIM(\"user_display_name\"), '') <> ''");
  });

  it('keeps live moderation display names in the shared participant snapshot', () => {
    const migration = readMigration('20260714124500_sync_moderation_display_name_snapshots');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(compact).toContain(
      'CREATE OR REPLACE FUNCTION "sync_chat_user_display_name_from_moderation_feed"()',
    );
    expect(compact).toContain('INSERT INTO "chat_user_display_names"');
    expect(compact).toContain("'moderation_feed'");
    expect(compact).toContain('CREATE TRIGGER "chat_moderation_feed_items_display_name_snapshot"');
    expect(compact).toContain(
      'AFTER INSERT OR UPDATE OF "chat_id", "user_id", "user_display_name", "created_at"',
    );
    expect(compact).toContain('ON "chat_moderation_feed_items"');
    expect(compact).toContain(
      'EXECUTE FUNCTION "sync_chat_user_display_name_from_moderation_feed"()',
    );
    expect(migration).not.toMatch(/\b(?:TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i);
  });

  it('adds the publication domain without destructively rewriting legacy broadcasts', () => {
    const schema = readSchema();
    const migration = readMigration('20260710142000_publication_domain_foundation');
    const compact = migration.replace(/\s+/g, ' ').trim();

    for (const model of [
      'Publication',
      'PublicationMutationRecord',
      'PublicationContentRevision',
      'PublicationAsset',
      'PublicationContentAsset',
      'PublicationTarget',
      'PublicationSchedule',
      'PublicationOccurrence',
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }

    expect(schema).toContain('enum PublicationAudienceSelection {');
    expect(schema).toContain('enum PublicationAudienceMode {');
    expect(schema).toContain('enum PublicationScheduleMode {');
    expect(schema).toContain(
      '@@unique([actorUserId, sha256], map: "publication_assets_actor_sha256_key")',
    );
    expect(schema).not.toContain('@unique(map: "publication_assets_sha256_key")');
    expect(compact).toContain(
      `CREATE TYPE "PublicationScheduleMode" AS ENUM ('NOW', 'ONCE', 'SLOTS', 'RECURRENCE')`,
    );
    expect(compact).toContain(
      `CREATE UNIQUE INDEX "publications_actor_request_key" ON "publications"("actor_user_id", "request_id")`,
    );
    expect(compact).toContain(
      `CREATE UNIQUE INDEX "publication_mutation_records_actor_request_key" ON "publication_mutation_records"("actor_user_id", "request_id")`,
    );
    expect(compact).toContain(
      `CONSTRAINT "publication_assets_actor_user_id_check" CHECK (BTRIM("actor_user_id") <> '')`,
    );
    expect(compact).toContain(
      `CREATE UNIQUE INDEX "publication_assets_actor_sha256_key" ON "publication_assets"("actor_user_id", "sha256")`,
    );
    expect(compact).not.toContain(
      `CREATE UNIQUE INDEX "publication_assets_sha256_key" ON "publication_assets"("sha256")`,
    );
    expect(compact).toContain(
      `CREATE UNIQUE INDEX "publication_occurrences_publication_revision_slot_key" ON "publication_occurrences"("publication_id", "schedule_revision", "scheduled_at")`,
    );
    expect(compact).toContain(
      `CREATE INDEX "publications_actor_lifecycle_updated_idx" ON "publications"("actor_user_id", "lifecycle", "updated_at" DESC, "id" DESC)`,
    );
    expect(compact).toContain(
      `CREATE INDEX "publication_occurrences_publication_scheduled_id_idx" ON "publication_occurrences"("publication_id", "scheduled_at" DESC, "id" DESC)`,
    );
    expect(compact).toContain(
      `ADD COLUMN "publication_occurrence_id" TEXT, ADD COLUMN "publication_content_revision_id" TEXT`,
    );
    expect(compact).toContain(
      `CREATE UNIQUE INDEX "managed_broadcasts_pub_occurrence_entity_key" ON "managed_broadcasts"("publication_occurrence_id", "entity_type")`,
    );
    expect(compact).toContain(
      `ALTER TABLE "managed_broadcast_deliveries" ADD COLUMN "publication_occurrence_id" TEXT`,
    );
    expect(compact).toContain(
      `CREATE INDEX "managed_broadcast_deliveries_pub_occurrence_created_id_idx" ON "managed_broadcast_deliveries"("publication_occurrence_id", "created_at" DESC, "id" DESC)`,
    );
    expect(compact).toContain(
      `CONSTRAINT "managed_broadcasts_publication_occurrence_id_fkey" FOREIGN KEY ("publication_occurrence_id") REFERENCES "publication_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    expect(compact).toContain(
      `CONSTRAINT "managed_broadcast_deliveries_publication_occurrence_id_fkey" FOREIGN KEY ("publication_occurrence_id") REFERENCES "publication_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    expect(compact).toContain(
      `CONSTRAINT "publication_assets_payload_check" CHECK ( ("bytes" IS NOT NULL OR "durable_payload" IS NOT NULL)`,
    );
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|TYPE)\b/i);
    expect(migration).not.toMatch(/\b(?:TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i);
  });

  it('adds the SEND dispatch fence and quarantines legacy attempts that may have posted', () => {
    const schema = readSchema();
    const migration = readMigration('20260711120000_max_action_send_dispatch_fence');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toContain('dispatchToken');
    expect(schema).toContain('dispatchStartedAt');
    expect(schema).toContain('dispatchBotId');
    expect(schema).toContain('remoteMessageId');
    expect(compact).toContain('ADD COLUMN IF NOT EXISTS "dispatch_token" TEXT');
    expect(compact).toContain('ADD COLUMN IF NOT EXISTS "remote_message_id" TEXT');
    expect(compact).toContain('UPDATE "max_action_ledger" SET "status" = \'AMBIGUOUS\'');
    expect(compact).toContain('"action_type" = \'SEND_MESSAGE\'');
    expect(compact).toContain('"terminal" = false');
    expect(compact).toContain('"attempt_count" > 0');
    expect(compact).toContain('"first_attempt_at" IS NOT NULL');
    expect(compact).toContain('"last_attempt_at" IS NOT NULL');
    expect(compact).not.toMatch(/\b(?:TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i);
  });

  it('indexes exact managed broadcast message ownership lookups', () => {
    const schema = readSchema();
    const migration = readMigration(
      '20260717132000_optimize_managed_broadcast_remote_message_lookup',
    );
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toContain(
      '@@index([targetChatId, remoteMessageId], map: "managed_broadcast_deliveries_target_remote_message_idx")',
    );
    expect(compact).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "managed_broadcast_deliveries_target_remote_message_idx" ON "managed_broadcast_deliveries"("target_chat_id", "remote_message_id");',
    );
    expect(compact).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
    expect(compact).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i);
  });

  it('persists bounded publication verification and indexes managed-output ownership', () => {
    const schema = readSchema();
    const verification = readMigration('20260727180000_bound_publication_delivery_verification');
    const ownerIndexes = readMigration('20260727181000_optimize_managed_output_owner_lookup');

    expect(schema).toContain('remoteMessageVerificationAttemptCount');
    expect(schema).toContain('PublicationDeliveryVerificationSource');
    expect(schema).toContain('sendRouteQuarantinedUntil');
    expect(schema).toContain('sendRouteLastSuccessAt');
    expect(schema).toMatch(/lastErrorCode\s+String\?\s+@map\("last_error_code"\)/u);
    expect(verification).toContain('"remote_message_verification_attempt_count"');
    expect(verification).toContain('"remote_message_verification_source"');
    expect(verification).toContain('"last_error_code" TEXT');
    expect(verification).toContain('"send_route_quarantined_until"');
    expect(verification).toContain('"send_route_last_success_at"');
    expect(verification).not.toContain(
      '"managed_broadcast_deliveries_remote_verification_stable_check"',
    );
    expect(verification).not.toContain('UPDATE "managed_broadcast_deliveries"');
    expect(verification).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE)\b/i);

    for (const indexName of [
      'vk_parsing_posts_chat_published_message_idx',
      'managed_giveaways_chat_publication_message_idx',
      'managed_giveaways_chat_results_message_idx',
      'chat_auto_comment_attach_markers_chat_reply_idx',
    ]) {
      expect(schema).toContain(indexName);
      expect(ownerIndexes).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${indexName}"`);
    }
    expect(ownerIndexes).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
    expect(ownerIndexes).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i);
  });

  it('backfills and safely constrains publication delivery content revisions', () => {
    const schema = readSchema();
    const migration = readMigration('20260718100000_add_publication_delivery_content_revision');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toMatch(/contentRevisionId\s+String\?/u);
    expect(schema).toContain(
      '@@index([contentRevisionId], map: "managed_broadcast_deliveries_content_revision_idx")',
    );
    expect(compact).toContain(
      'CREATE OR REPLACE FUNCTION "set_publication_delivery_content_revision"() RETURNS TRIGGER LANGUAGE plpgsql',
    );
    expect(compact).toContain(
      'CREATE TRIGGER "managed_broadcast_deliveries_content_revision_fill" BEFORE INSERT OR UPDATE OF "broadcast_id", "publication_occurrence_id" ON "managed_broadcast_deliveries" FOR EACH ROW EXECUTE FUNCTION "set_publication_delivery_content_revision"()',
    );
    expect(compact).not.toContain('UPDATE OF "content_revision_id"');
    const relationBackfill =
      'UPDATE "managed_broadcast_deliveries" AS delivery SET "publication_occurrence_id" = broadcast."publication_occurrence_id", "content_revision_id" = broadcast."publication_content_revision_id" FROM "managed_broadcasts" AS broadcast WHERE delivery."broadcast_id" = broadcast."id" AND delivery."publication_occurrence_id" IS NULL AND broadcast."publication_occurrence_id" IS NOT NULL AND broadcast."publication_content_revision_id" IS NOT NULL';
    const revisionBackfill =
      'UPDATE "managed_broadcast_deliveries" AS delivery SET "content_revision_id" = occurrence."content_revision_id" FROM "publication_occurrences" AS occurrence WHERE delivery."publication_occurrence_id" = occurrence."id" AND delivery."content_revision_id" IS NULL';
    expect(compact).toContain(
      'IF NEW."publication_occurrence_id" IS NULL THEN SELECT broadcast."publication_occurrence_id", broadcast."publication_content_revision_id" INTO execution_occurrence_id, execution_content_revision_id FROM "managed_broadcasts" AS broadcast WHERE broadcast."id" = NEW."broadcast_id" AND broadcast."publication_occurrence_id" IS NOT NULL',
    );
    expect(compact).toContain(relationBackfill);
    expect(compact).toContain(revisionBackfill);
    expect(compact.indexOf('CREATE TRIGGER')).toBeLessThan(compact.indexOf(relationBackfill));
    expect(compact.indexOf(relationBackfill)).toBeLessThan(compact.indexOf(revisionBackfill));
    const integrityGuard =
      'IF EXISTS ( SELECT 1 FROM "managed_broadcast_deliveries" AS delivery INNER JOIN "managed_broadcasts" AS broadcast ON broadcast."id" = delivery."broadcast_id" WHERE broadcast."publication_occurrence_id" IS NOT NULL';
    expect(compact).toContain(integrityGuard);
    expect(compact).toContain(
      'delivery."publication_occurrence_id" IS DISTINCT FROM broadcast."publication_occurrence_id" OR delivery."content_revision_id" IS NULL',
    );
    expect(compact).toContain(
      'delivery."status" IN ( \'PENDING\'::"ManagedBroadcastDeliveryStatus", \'SENDING\'::"ManagedBroadcastDeliveryStatus" ) AND delivery."content_revision_id" IS DISTINCT FROM broadcast."publication_content_revision_id"',
    );
    expect(compact).toContain(
      "RAISE EXCEPTION 'Publication delivery attribution backfill is incomplete'",
    );
    expect(compact.indexOf(revisionBackfill)).toBeLessThan(compact.indexOf(integrityGuard));
    expect(compact).toContain(
      'CREATE INDEX IF NOT EXISTS "managed_broadcast_deliveries_content_revision_idx" ON "managed_broadcast_deliveries"("content_revision_id")',
    );
    expect(compact).not.toContain('CREATE INDEX CONCURRENTLY');
    expect(compact).toContain(
      'ADD CONSTRAINT "managed_broadcast_deliveries_content_revision_id_fkey" FOREIGN KEY ("content_revision_id") REFERENCES "publication_content_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID',
    );
    expect(compact).toContain(
      'VALIDATE CONSTRAINT "managed_broadcast_deliveries_content_revision_id_fkey"',
    );
    expect(compact.indexOf('CREATE INDEX IF NOT EXISTS')).toBeLessThan(
      compact.indexOf('ADD CONSTRAINT "managed_broadcast_deliveries_content_revision_id_fkey"'),
    );
    expect(migration).not.toMatch(
      /^\s*(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION|COMMIT(?:\s+WORK)?)\s*;/imu,
    );
    expect(compact).not.toMatch(
      /\b(?:DROP\s+(?:TABLE|COLUMN|TYPE|INDEX)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i,
    );
  });

  it('adds a conservative persistent chat routing state fence', () => {
    const schema = readSchema();
    const migration = readMigration('20260711123000_chat_routing_state');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toContain('enum ChatRoutingState {');
    expect(schema).toContain('routingState   ChatRoutingState @default(NO_ELIGIBLE_BOT)');
    expect(compact).toContain(
      `CREATE TYPE "ChatRoutingState" AS ENUM ('READY', 'NO_ELIGIBLE_BOT')`,
    );
    expect(schema).toContain('model ChatRoutingReconcileRequest {');
    expect(compact).toContain('CREATE TABLE "chat_routing_reconcile_requests"');
    expect(compact).toContain('CREATE OR REPLACE FUNCTION enqueue_chat_routing_reconcile_request');
    expect(compact).toContain(`ALTER COLUMN "routing_state" SET DEFAULT 'NO_ELIGIBLE_BOT'`);
    expect(compact).toContain('"lease_token" TEXT');
    expect(compact).toContain('"lease_expires_at" TIMESTAMPTZ');
    expect(compact).toContain('"generation" = "chat_routing_reconcile_requests"."generation" + 1');
    expect(compact).toContain('"lease_token" = NULL, "lease_expires_at" = NULL');
    expect(compact).toContain('AFTER INSERT OR DELETE OR UPDATE OF');
    expect(compact).toContain('"capabilities"');
    expect(compact).toContain('"permissions_snapshot"');
    expect(compact).not.toContain(
      'INSERT INTO "chat_routing_reconcile_requests" ("chat_id", "generation", "requested_at") SELECT "id", 1, CURRENT_TIMESTAMP FROM "chats"',
    );
    expect(compact).toContain(`OR NEW."routing_state" IS DISTINCT FROM OLD."routing_state"`);
    expect(compact).not.toContain('FOR UPDATE');
    expect(compact).not.toContain('UPDATE "chats" SET');
    expect(compact).not.toMatch(/\b(?:TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i);
  });

  it('adds a non-destructive routed giveaway send lock discriminator', () => {
    const schema = readSchema();
    const migration = readMigration('20260711130000_managed_giveaway_send_lock_key');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toContain('sendLockKey          String?               @map("send_lock_key")');
    expect(compact).toContain(
      'ALTER TABLE "managed_giveaways" ADD COLUMN IF NOT EXISTS "send_lock_key" TEXT',
    );
    expect(compact).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|TYPE)\b/i);
    expect(compact).not.toMatch(/\b(?:TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i);
  });

  it('adds a durable managed giveaway winner notification outbox', () => {
    const schema = readSchema();
    const migration = readMigration('20260718143000_managed_giveaway_winner_notification_outbox');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(schema).toContain('enum ManagedGiveawayWinnerNotificationStatus {');
    expect(schema).toContain('model ManagedGiveawayWinnerNotification {');
    expect(compact).toContain(
      `CREATE TYPE "ManagedGiveawayWinnerNotificationStatus" AS ENUM ( 'PENDING', 'RETRYABLE', 'DISPATCHING', 'SENT', 'AMBIGUOUS', 'FAILED_TERMINAL', 'CANCELED' )`,
    );
    expect(compact).toContain('CREATE TABLE "managed_giveaway_winner_notifications"');
    expect(compact).toContain('"remote_message_id" TEXT');
    expect(compact).toContain('"managed_giveaway_winner_notifications_sent_pair_check"');
    expect(compact).toContain(
      'FOREIGN KEY ("winner_id") REFERENCES "managed_giveaway_winners"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
    expect(compact).not.toMatch(
      /\b(?:DROP\s+(?:TABLE|COLUMN|TYPE)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i,
    );
  });

  it('keeps replacement cleanup recovery referential without trusting legacy delete flags', () => {
    const foundation = readMigration('20260716190000_add_moderation_delete_intents');
    const tracking = readMigration('20260716191000_track_channel_replacement_cleanup');
    const indexes = readMigration('20260716191500_add_replacement_cleanup_indexes');
    const compactTracking = tracking.replace(/\s+/g, ' ').trim();

    expect(foundation).toContain('"delete_dispatch_started_at" TIMESTAMP(3)');
    expect(foundation).toContain('"delete_dispatch_started_bot_id" TEXT');
    expect(foundation).toContain('"moderation_delete_intents_dispatch_pair_check"');
    expect(compactTracking).not.toContain(
      'UPDATE "channel_auto_post_attach_markers" marker SET "original_deleted" = true',
    );
    expect(compactTracking).toContain(
      'UPDATE "chat_auto_comment_attach_markers" SET "original_deleted" = false',
    );
    for (const constraint of [
      'channel_auto_post_attach_markers_cleanup_intent_id_fkey',
      'chat_auto_comment_attach_markers_cleanup_intent_id_fkey',
      'chat_rules_pending_cleanup_intent_id_fkey',
    ]) {
      expect(compactTracking).toContain(`ADD CONSTRAINT "${constraint}"`);
    }
    expect(compactTracking.match(/ON DELETE SET NULL ON UPDATE CASCADE/g)).toHaveLength(3);
    expect(indexes).toContain('CREATE INDEX CONCURRENTLY');
    expect(indexes).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });
});
