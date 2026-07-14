import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCAL_DISPLAY_NAME_EVENTS = [
  'message_created',
  'message_edited',
  'message_callback',
  'bot_started',
  'bot_added',
  'user_added',
  'user_removed',
] as const;

function readMigration(name: string): string {
  return readFileSync(resolve(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
}

function readSchema(): string {
  return readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
}

describe('Prisma migrations', () => {
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
});
