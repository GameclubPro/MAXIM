import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrationPaths = process.argv.slice(2);
if (migrationPaths.length === 0) {
  throw new Error('At least one migration path is required');
}

const db = new PGlite();
try {
  await db.exec(`
    CREATE TABLE "chats" ("id" TEXT PRIMARY KEY, "entity_type" TEXT);
    CREATE TABLE "chat_settings" (
      "chat_id" TEXT PRIMARY KEY,
      "night_mode_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "night_mode_start_time_minutes" INTEGER NOT NULL DEFAULT 1380,
      "night_mode_end_time_minutes" INTEGER NOT NULL DEFAULT 480,
      "night_mode_timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
      "night_mode_bot_message_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "night_mode_bot_message_text" TEXT NOT NULL DEFAULT '',
      "night_mode_comments_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "night_mode_open_message_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "night_mode_open_message_text" TEXT NOT NULL DEFAULT '',
      "night_mode_bot_button_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "night_mode_bot_button_url" TEXT NOT NULL DEFAULT '',
      "night_mode_bot_button_text" TEXT NOT NULL DEFAULT '',
      "night_mode_bot_buttons" JSONB NOT NULL DEFAULT '[]',
      "night_mode_rules_button_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "night_mode_force_close_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "night_mode_force_close_forever" BOOLEAN NOT NULL DEFAULT FALSE,
      "night_mode_force_close_hours" INTEGER NOT NULL DEFAULT 8,
      "night_mode_force_close_days" INTEGER NOT NULL DEFAULT 0,
      "night_mode_force_close_until" TEXT NOT NULL DEFAULT '',
      "comments_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "bot_speech_style" TEXT NOT NULL DEFAULT 'ROBOT',
      "bot_speech_media" JSONB
    );
    CREATE TABLE "chat_bot_memberships" (
      "id" TEXT PRIMARY KEY,
      "chat_id" TEXT NOT NULL,
      "bot_id" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "bot_access_state" TEXT NOT NULL,
      "bot_access_checked_at" TIMESTAMPTZ,
      "bot_access_expires_at" TIMESTAMPTZ
    );
    CREATE TABLE "max_action_ledger" (
      "id" TEXT PRIMARY KEY,
      "job_id" TEXT NOT NULL,
      "action_type" TEXT NOT NULL,
      "chat_id" TEXT NOT NULL,
      "source_tag" TEXT,
      "status" TEXT NOT NULL,
      "ambiguous" BOOLEAN NOT NULL DEFAULT FALSE,
      "terminal" BOOLEAN NOT NULL DEFAULT FALSE,
      "completed_at" TIMESTAMP(3),
      "dispatch_bot_id" TEXT,
      "remote_message_id" TEXT
    );
    CREATE TABLE "moderation_events" (
      "id" TEXT PRIMARY KEY,
      "chat_id" TEXT NOT NULL,
      "bot_id" TEXT,
      "message_id" TEXT,
      "rule_code" TEXT NOT NULL,
      "metadata" JSONB
    );
    CREATE INDEX "moderation_events_chat_message_idx"
      ON "moderation_events"("chat_id", "message_id");
  `);
  for (const migrationPath of migrationPaths) {
    const sql = (await readFile(migrationPath, 'utf8')).replace(
      /CREATE INDEX CONCURRENTLY/gu,
      'CREATE INDEX',
    );
    await db.exec(sql);
  }

  const timestampColumns = await db.query(`
    SELECT "table_name", "column_name", "data_type", "datetime_precision", "column_default"
    FROM information_schema.columns
    WHERE "table_name" IN (
      'night_mode_transition_reconcile_requests',
      'night_mode_transition_scheduled_jobs'
    )
      AND "column_name" IN (
        'first_requested_at',
        'requested_at',
        'last_attempt_at',
        'last_error_at',
        'lease_expires_at',
        'manual_blocked_at',
        'manual_acknowledged_at',
        'scheduled_for',
        'created_at',
        'updated_at'
      )
    ORDER BY "table_name", "column_name"
  `);
  assert.equal(timestampColumns.rows.length, 10);
  for (const column of timestampColumns.rows) {
    assert.equal(column.data_type, 'timestamp without time zone');
    assert.equal(column.datetime_precision, 3);
  }
  const scheduledUpdatedAt = timestampColumns.rows.find(
    (column) =>
      column.table_name === 'night_mode_transition_scheduled_jobs' &&
      column.column_name === 'updated_at',
  );
  assert.equal(scheduledUpdatedAt?.column_default, null);
  const scheduledCreatedAt = timestampColumns.rows.find(
    (column) =>
      column.table_name === 'night_mode_transition_scheduled_jobs' &&
      column.column_name === 'created_at',
  );
  assert.match(String(scheduledCreatedAt?.column_default), /CURRENT_TIMESTAMP/u);
  const runtimeVersionColumn = await db.query(`
    SELECT "column_default", "is_nullable"
    FROM information_schema.columns
    WHERE "table_name" = 'night_mode_transition_scheduled_jobs'
      AND "column_name" = 'runtime_version'
  `);
  assert.equal(runtimeVersionColumn.rows.length, 1);
  assert.equal(runtimeVersionColumn.rows[0]?.column_default, '3');
  assert.equal(runtimeVersionColumn.rows[0]?.is_nullable, 'NO');

  await db.exec(`
    INSERT INTO "max_action_ledger" (
      "id", "job_id", "action_type", "chat_id", "source_tag", "status",
      "ambiguous", "terminal", "completed_at", "dispatch_bot_id", "remote_message_id"
    )
    SELECT
      'ledger-' || LPAD(series::TEXT, 6, '0'),
      'night-mode:close:chat-' || (series % 100)::TEXT ||
        ':session:v1:Europe/Moscow:23:00:08:00:2026-05-30',
      'SEND_MESSAGE',
      'chat-' || (series % 100)::TEXT,
      'night_mode_transition',
      'SUCCEEDED',
      FALSE,
      TRUE,
      TIMESTAMP '2026-05-30 20:00:00' + series * INTERVAL '1 second',
      'bot-1',
      'message-' || series::TEXT
    FROM GENERATE_SERIES(1, 10000) series;
    ANALYZE "max_action_ledger";
    ANALYZE "moderation_events";
  `);
  const recoveryPlan = await db.query(`
    EXPLAIN (FORMAT JSON, COSTS FALSE)
    SELECT
      ledger."id",
      ledger."job_id",
      ledger."completed_at",
      ledger."dispatch_bot_id",
      ledger."remote_message_id"
    FROM "max_action_ledger" ledger
    WHERE ledger."chat_id" = 'chat-42'
      AND ledger."terminal" = true
      AND ledger."completed_at" IS NOT NULL
      AND ledger."status" = 'SUCCEEDED'
      AND ledger."ambiguous" = false
      AND ledger."action_type" = 'SEND_MESSAGE'
      AND ledger."source_tag" = 'night_mode_transition'
      AND ledger."remote_message_id" IS NOT NULL
      AND BTRIM(ledger."remote_message_id") <> ''
      AND ledger."dispatch_bot_id" IS NOT NULL
      AND BTRIM(ledger."dispatch_bot_id") <> ''
      AND ledger."job_id" LIKE 'night-mode:close:%'
      AND LEFT(ledger."job_id", CHAR_LENGTH('night-mode:close:chat-42:session:')) =
        'night-mode:close:chat-42:session:'
      AND NOT EXISTS (
        SELECT 1
        FROM "moderation_events" event
        WHERE event."chat_id" = ledger."chat_id"
          AND event."message_id" = ledger."remote_message_id"
          AND event."bot_id" = ledger."dispatch_bot_id"
          AND event."rule_code" = 'NIGHT_MODE_CLOSE_NOTICE'
          AND event."metadata" ->> 'sessionKey' = SUBSTRING(
            ledger."job_id" FROM CHAR_LENGTH('night-mode:close:chat-42:session:') + 1
          )
      )
    ORDER BY ledger."completed_at" DESC, ledger."id" DESC
    LIMIT 20
  `);
  const recoveryPlanJson = JSON.stringify(recoveryPlan.rows);
  assert.match(recoveryPlanJson, /max_action_ledger_night_mode_close_chat_recovery_idx/u);

  const reconcileIndexes = await db.query(`
    SELECT "indexname", "indexdef"
    FROM pg_indexes
    WHERE "schemaname" = 'public'
      AND "indexname" IN (
        'night_mode_transition_reconcile_due_idx',
        'night_mode_transition_reconcile_stale_lease_idx'
      )
    ORDER BY "indexname" ASC
  `);
  assert.equal(reconcileIndexes.rows.length, 2);
  for (const index of reconcileIndexes.rows) {
    assert.match(index.indexdef, /manual_blocked_at IS NULL/u);
    assert.match(index.indexdef, /generation > manual_blocked_generation/u);
  }
  assert.match(
    reconcileIndexes.rows.find(
      (index) => index.indexname === 'night_mode_transition_reconcile_stale_lease_idx',
    )?.indexdef ?? '',
    /lease_token IS NOT NULL/u,
  );

  await assert.rejects(
    db.exec(`
      INSERT INTO "night_mode_transition_scheduled_jobs" (
        "chat_id", "job_id", "transition", "session_key", "scheduled_for",
        "schedule_fingerprint"
      ) VALUES (
        'missing-updated-at', 'job-1', 'open', 'session-1', CURRENT_TIMESTAMP,
        'sha256:${'b'.repeat(64)}'
      )
    `),
    /updated_at/u,
  );
  await db.exec(`
    INSERT INTO "night_mode_transition_scheduled_jobs" (
      "chat_id", "job_id", "transition", "session_key", "scheduled_for",
      "schedule_fingerprint", "created_at", "updated_at"
    ) VALUES (
      'schema-exact', 'job-1', 'open', 'session-1', CURRENT_TIMESTAMP,
      'sha256:${'c'.repeat(64)}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`
    INSERT INTO "night_mode_transition_reconcile_requests" (
      "chat_id", "generation", "first_requested_at", "requested_at",
      "manual_blocked_at", "manual_blocked_reason", "manual_blocked_category",
      "manual_blocked_job_id", "manual_blocked_session_key", "manual_blocked_fingerprint",
      "manual_blocked_generation", "manual_acknowledged_at"
    ) VALUES (
      'atomic-manual', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, 'review first', 'unsafe_prior_dispatch',
      'atomic-manual-job', 'session-atomic', 'sha256:${'e'.repeat(64)}', 7,
      CURRENT_TIMESTAMP
    );
    INSERT INTO "night_mode_transition_reconcile_requests" (
      "chat_id", "generation", "first_requested_at", "requested_at",
      "lease_token", "lease_expires_at"
    ) VALUES (
      'atomic-leased', 9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      'active-lease', CURRENT_TIMESTAMP + INTERVAL '1 minute'
    );
    INSERT INTO "night_mode_transition_reconcile_requests" (
      "chat_id", "generation", "first_requested_at", "requested_at",
      "lease_token", "lease_expires_at"
    ) VALUES (
      'atomic-foreign', 11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      'foreign-lease', CURRENT_TIMESTAMP + INTERVAL '1 minute'
    );
    INSERT INTO "night_mode_transition_reconcile_requests" (
      "chat_id", "generation", "first_requested_at", "requested_at",
      "lease_token", "lease_expires_at"
    ) VALUES (
      'atomic-expired', 13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      'expired-lease', CURRENT_TIMESTAMP - INTERVAL '1 minute'
    );
    INSERT INTO "night_mode_transition_reconcile_requests" (
      "chat_id", "generation", "first_requested_at", "requested_at",
      "lease_token", "lease_expires_at"
    ) VALUES (
      'atomic-external', 15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      'external-lease', CURRENT_TIMESTAMP + INTERVAL '1 minute'
    );
    INSERT INTO "night_mode_transition_reconcile_requests" (
      "chat_id", "generation", "first_requested_at", "requested_at",
      "lease_token", "lease_expires_at", "manual_blocked_at", "manual_blocked_reason",
      "manual_blocked_category", "manual_blocked_job_id", "manual_blocked_session_key",
      "manual_blocked_fingerprint", "manual_blocked_generation", "manual_acknowledged_at"
    ) VALUES (
      'atomic-future-owner', 8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      'future-owner-lease', CURRENT_TIMESTAMP + INTERVAL '1 minute', CURRENT_TIMESTAMP,
      'acknowledged prior occurrence', 'unsafe_prior_dispatch', 'atomic-prior-job',
      'session-prior', 'sha256:${'f'.repeat(64)}', 7, CURRENT_TIMESTAMP
    )
  `);
  await persistRegistryIntent('atomic-new', 'atomic-new-job');
  await persistRegistryIntent('atomic-manual', 'atomic-manual-job');
  await persistRegistryIntent('atomic-leased', 'atomic-leased-job-1', {
    generation: 9,
    leaseToken: 'active-lease',
  });
  await persistRegistryIntent('atomic-leased', 'atomic-leased-job-2', {
    generation: 9,
    leaseToken: 'active-lease',
  });
  await persistRegistryIntent('atomic-foreign', 'atomic-foreign-job', {
    generation: 11,
    leaseToken: 'different-owner',
  });
  await persistRegistryIntent('atomic-expired', 'atomic-expired-job', {
    generation: 13,
    leaseToken: 'expired-lease',
  });
  await persistRegistryIntent('atomic-external', 'atomic-external-job');
  await persistRegistryIntent('atomic-future-owner', 'atomic-future-owner-job', {
    generation: 8,
    leaseToken: 'future-owner-lease',
  });
  const staleRegistryCompletion = await db.query(`
    DELETE FROM "night_mode_transition_reconcile_requests"
    WHERE "chat_id" = 'atomic-external'
      AND "generation" = 15
      AND "lease_token" = 'external-lease'
  `);
  assert.equal(staleRegistryCompletion.affectedRows, 0);
  const atomicRequests = await db.query(`
    SELECT
      "chat_id", "generation", "manual_blocked_reason", "manual_blocked_category",
      "manual_blocked_generation", "lease_token",
      "manual_acknowledged_at" IS NOT NULL AS "acknowledged"
    FROM "night_mode_transition_reconcile_requests"
    WHERE "chat_id" LIKE 'atomic-%'
    ORDER BY "chat_id" ASC
  `);
  assert.deepEqual(atomicRequests.rows, [
    {
      chat_id: 'atomic-expired',
      generation: 14,
      manual_blocked_reason: null,
      manual_blocked_category: null,
      manual_blocked_generation: null,
      lease_token: null,
      acknowledged: false,
    },
    {
      chat_id: 'atomic-external',
      generation: 16,
      manual_blocked_reason: null,
      manual_blocked_category: null,
      manual_blocked_generation: null,
      lease_token: null,
      acknowledged: false,
    },
    {
      chat_id: 'atomic-foreign',
      generation: 12,
      manual_blocked_reason: null,
      manual_blocked_category: null,
      manual_blocked_generation: null,
      lease_token: null,
      acknowledged: false,
    },
    {
      chat_id: 'atomic-future-owner',
      generation: 8,
      manual_blocked_reason: 'acknowledged prior occurrence',
      manual_blocked_category: 'unsafe_prior_dispatch',
      manual_blocked_generation: 7,
      lease_token: 'future-owner-lease',
      acknowledged: true,
    },
    {
      chat_id: 'atomic-leased',
      generation: 9,
      manual_blocked_reason: null,
      manual_blocked_category: null,
      manual_blocked_generation: null,
      lease_token: 'active-lease',
      acknowledged: false,
    },
    {
      chat_id: 'atomic-manual',
      generation: 8,
      manual_blocked_reason: 'review first',
      manual_blocked_category: 'unsafe_prior_dispatch',
      manual_blocked_generation: 7,
      lease_token: null,
      acknowledged: true,
    },
    {
      chat_id: 'atomic-new',
      generation: 1,
      manual_blocked_reason: null,
      manual_blocked_category: null,
      manual_blocked_generation: null,
      lease_token: null,
      acknowledged: false,
    },
  ]);
  const atomicRegistry = await db.query(`
    SELECT "chat_id", "job_id", "created_at" IS NOT NULL AS "has_created_at",
      "updated_at" IS NOT NULL AS "has_updated_at"
    FROM "night_mode_transition_scheduled_jobs"
    WHERE "chat_id" LIKE 'atomic-%'
    ORDER BY "chat_id" ASC, "job_id" ASC
  `);
  assert.deepEqual(atomicRegistry.rows, [
    {
      chat_id: 'atomic-expired',
      job_id: 'atomic-expired-job',
      has_created_at: true,
      has_updated_at: true,
    },
    {
      chat_id: 'atomic-external',
      job_id: 'atomic-external-job',
      has_created_at: true,
      has_updated_at: true,
    },
    {
      chat_id: 'atomic-foreign',
      job_id: 'atomic-foreign-job',
      has_created_at: true,
      has_updated_at: true,
    },
    {
      chat_id: 'atomic-future-owner',
      job_id: 'atomic-future-owner-job',
      has_created_at: true,
      has_updated_at: true,
    },
    {
      chat_id: 'atomic-leased',
      job_id: 'atomic-leased-job-1',
      has_created_at: true,
      has_updated_at: true,
    },
    {
      chat_id: 'atomic-leased',
      job_id: 'atomic-leased-job-2',
      has_created_at: true,
      has_updated_at: true,
    },
    {
      chat_id: 'atomic-manual',
      job_id: 'atomic-manual-job',
      has_created_at: true,
      has_updated_at: true,
    },
    {
      chat_id: 'atomic-new',
      job_id: 'atomic-new-job',
      has_created_at: true,
      has_updated_at: true,
    },
  ]);
  await db.exec(`
    INSERT INTO "chats" ("id", "entity_type") VALUES ('chat-1', 'CHAT');
    INSERT INTO "chat_settings" ("chat_id", "night_mode_enabled")
    VALUES ('chat-1', TRUE);
    INSERT INTO "chat_bot_memberships" (
      "id", "chat_id", "bot_id", "status", "bot_access_state",
      "bot_access_checked_at", "bot_access_expires_at"
    ) VALUES (
      'membership-1', 'chat-1', 'bot-1', 'ACTIVE', 'DENIED',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 minutes'
    );
  `);

  const beforeCheckedRefresh = await loadRequest();
  await db.exec(`
    UPDATE "chat_bot_memberships"
    SET "bot_access_checked_at" = CURRENT_TIMESTAMP + INTERVAL '1 second'
    WHERE "id" = 'membership-1'
  `);
  assert.equal((await loadRequest()).generation, beforeCheckedRefresh.generation);

  await blockRequest('unsafe_prior_dispatch');
  const unsafe = await loadRequest();
  await db.exec(`
    UPDATE "chat_bot_memberships"
    SET
      "bot_access_state" = 'CONFIRMED_ADMIN',
      "bot_access_expires_at" = CURRENT_TIMESTAMP + INTERVAL '20 minutes'
    WHERE "id" = 'membership-1'
  `);
  const afterFreshGrant = await loadRequest();
  assert.equal(BigInt(afterFreshGrant.generation), BigInt(unsafe.generation) + 1n);
  assert.equal(afterFreshGrant.manual_blocked_category, 'unsafe_prior_dispatch');

  await db.exec(`
    UPDATE "night_mode_transition_reconcile_requests"
    SET
      "manual_blocked_generation" = "generation",
      "manual_acknowledged_at" = CURRENT_TIMESTAMP
    WHERE "chat_id" = 'chat-1'
  `);
  const acknowledged = await loadRequest();
  assert.equal(acknowledged.manual_acknowledged_at instanceof Date, true);

  await db.exec(`
    UPDATE "chat_bot_memberships"
    SET "bot_access_expires_at" = CURRENT_TIMESTAMP + INTERVAL '30 minutes'
    WHERE "id" = 'membership-1'
  `);
  assert.equal((await loadRequest()).generation, afterFreshGrant.generation);

  await db.exec(`
    UPDATE "chat_settings"
    SET "night_mode_start_time_minutes" = "night_mode_start_time_minutes"
    WHERE "chat_id" = 'chat-1'
  `);
  assert.equal((await loadRequest()).generation, afterFreshGrant.generation);

  await db.exec(`
    UPDATE "chat_settings"
    SET "night_mode_start_time_minutes" = 1320
    WHERE "chat_id" = 'chat-1'
  `);
  const afterReschedule = await loadRequest();
  assert.equal(BigInt(afterReschedule.generation), BigInt(acknowledged.generation) + 1n);
  assert.equal(afterReschedule.manual_blocked_category, 'unsafe_prior_dispatch');
  assert.equal(afterReschedule.manual_blocked_job_id, unsafe.manual_blocked_job_id);
  assert.equal(afterReschedule.manual_blocked_session_key, unsafe.manual_blocked_session_key);
  assert.equal(afterReschedule.manual_blocked_fingerprint, unsafe.manual_blocked_fingerprint);
  assert.equal(afterReschedule.manual_blocked_generation, acknowledged.manual_blocked_generation);
  assert.equal(
    afterReschedule.manual_acknowledged_at.getTime(),
    acknowledged.manual_acknowledged_at.getTime(),
  );
  assert.equal(afterReschedule.attempt_count, unsafe.attempt_count);

  await db.exec(`
    UPDATE "chats"
    SET "entity_type" = 'CHANNEL'
    WHERE "id" = 'chat-1'
  `);
  const afterEntityChange = await loadRequest();
  assert.equal(BigInt(afterEntityChange.generation), BigInt(afterReschedule.generation) + 1n);
  assert.equal(afterEntityChange.manual_blocked_category, 'unsafe_prior_dispatch');
  assert.equal(afterEntityChange.manual_blocked_job_id, unsafe.manual_blocked_job_id);
  assert.equal(afterEntityChange.manual_blocked_session_key, unsafe.manual_blocked_session_key);
  assert.equal(afterEntityChange.manual_blocked_fingerprint, unsafe.manual_blocked_fingerprint);
  assert.equal(afterEntityChange.manual_blocked_generation, acknowledged.manual_blocked_generation);
  assert.equal(
    afterEntityChange.manual_acknowledged_at.getTime(),
    acknowledged.manual_acknowledged_at.getTime(),
  );
  assert.equal(afterEntityChange.attempt_count, unsafe.attempt_count);

  await blockRequest('no_fresh_access');
  await db.exec(`
    UPDATE "night_mode_transition_reconcile_requests"
    SET "manual_acknowledged_at" = CURRENT_TIMESTAMP
    WHERE "chat_id" = 'chat-1'
  `);
  await db.exec(`
    UPDATE "chat_bot_memberships"
    SET "bot_access_state" = 'DENIED'
    WHERE "id" = 'membership-1';
    UPDATE "chat_bot_memberships"
    SET
      "bot_access_state" = 'CONFIRMED_OWNER',
      "bot_access_expires_at" = CURRENT_TIMESTAMP + INTERVAL '20 minutes'
    WHERE "id" = 'membership-1';
  `);
  const afterNoFreshAccessClear = await loadRequest();
  assert.equal(afterNoFreshAccessClear.manual_blocked_category, null);
  assert.equal(afterNoFreshAccessClear.manual_acknowledged_at, null);

  const leased = await loadRequest();
  await db.exec(`
    UPDATE "night_mode_transition_reconcile_requests"
    SET
      "lease_token" = 'old-lease',
      "lease_expires_at" = CURRENT_TIMESTAMP + INTERVAL '1 minute'
    WHERE "chat_id" = 'chat-1';
    SELECT enqueue_night_mode_transition_reconcile_request('chat-1');
  `);
  const raced = await loadRequest();
  assert.equal(BigInt(raced.generation), BigInt(leased.generation) + 1n);
  assert.equal(raced.lease_token, null);
  const staleCompletion = await db.query(`
    DELETE FROM "night_mode_transition_reconcile_requests"
    WHERE "chat_id" = 'chat-1'
      AND "generation" = ${leased.generation.toString()}
      AND "lease_token" = 'old-lease'
  `);
  assert.equal(staleCompletion.affectedRows, 0);

  await db.exec(`
    INSERT INTO "night_mode_transition_reconcile_requests" (
      "chat_id", "generation", "first_requested_at", "requested_at"
    ) VALUES (
      'legacy-active-request', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    INSERT INTO "night_mode_transition_reconcile_requests" (
      "chat_id", "generation", "first_requested_at", "requested_at",
      "manual_blocked_at", "manual_blocked_reason", "manual_blocked_category",
      "manual_blocked_job_id", "manual_blocked_ledger_job_id",
      "manual_blocked_session_key", "manual_blocked_fingerprint",
      "manual_blocked_generation", "manual_acknowledged_at"
    ) VALUES (
      'legacy-exact-ack', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, 'accepted exact legacy occurrence', 'unsafe_prior_dispatch',
      'legacy-exact-job', 'night-mode:close:legacy-exact-ack:session:session-exact',
      'session-exact', 'sha256:${'d'.repeat(64)}',
      3, CURRENT_TIMESTAMP
    ), (
      'legacy-unrelated-tombstone', 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, 'different legacy occurrence', 'unsafe_prior_provenance',
      'legacy-old-job', 'night-mode:close:legacy-unrelated-tombstone:session:session-old',
      'session-old', 'sha256:${'e'.repeat(64)}',
      5, NULL
    ), (
      'legacy-open-same-session', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, 'open occurrence in the shared session', 'unsafe_prior_dispatch',
      'legacy-open-job', 'night-mode:open:legacy-open-same-session:session:session-shared',
      'session-shared', 'sha256:${'a'.repeat(64)}',
      2, NULL
    );

    INSERT INTO "night_mode_transition_scheduled_jobs" (
      "chat_id", "job_id", "transition", "session_key", "scheduled_for",
      "schedule_fingerprint", "created_at", "updated_at"
    ) VALUES (
      'legacy-recovery-registry', 'night-mode-transition__digest__recovery__exact',
      'close', 'session-registry', CURRENT_TIMESTAMP,
      'sha256:${'f'.repeat(64)}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `);

  await requestLegacyRecoveryCandidates([
    [
      'legacy-active-request',
      'session-active',
      'night-mode:close:legacy-active-request:session:session-active',
    ],
    [
      'legacy-exact-ack',
      'session-exact',
      'night-mode:close:legacy-exact-ack:session:session-exact',
    ],
    [
      'legacy-recovery-registry',
      'session-registry',
      'night-mode:close:legacy-recovery-registry:session:session-registry',
    ],
    [
      'legacy-unrelated-tombstone',
      'session-new',
      'night-mode:close:legacy-unrelated-tombstone:session:session-new',
    ],
    [
      'legacy-open-same-session',
      'session-shared',
      'night-mode:close:legacy-open-same-session:session:session-shared',
    ],
  ]);
  assert.equal(await loadRequestGeneration('legacy-active-request'), 7n);
  assert.equal(await loadRequestGeneration('legacy-exact-ack'), 3n);
  assert.equal(await loadRequestGeneration('legacy-recovery-registry'), null);
  assert.equal(await loadRequestGeneration('legacy-unrelated-tombstone'), 6n);
  assert.equal(await loadRequestGeneration('legacy-open-same-session'), 3n);

  await requestLegacyRecoveryCandidates([
    [
      'legacy-active-request',
      'session-active',
      'night-mode:close:legacy-active-request:session:session-active',
    ],
    [
      'legacy-exact-ack',
      'session-exact',
      'night-mode:close:legacy-exact-ack:session:session-exact',
    ],
    [
      'legacy-recovery-registry',
      'session-registry',
      'night-mode:close:legacy-recovery-registry:session:session-registry',
    ],
    [
      'legacy-unrelated-tombstone',
      'session-new',
      'night-mode:close:legacy-unrelated-tombstone:session:session-new',
    ],
    [
      'legacy-open-same-session',
      'session-shared',
      'night-mode:close:legacy-open-same-session:session:session-shared',
    ],
  ]);
  assert.equal(await loadRequestGeneration('legacy-active-request'), 7n);
  assert.equal(await loadRequestGeneration('legacy-exact-ack'), 3n);
  assert.equal(await loadRequestGeneration('legacy-recovery-registry'), null);
  assert.equal(await loadRequestGeneration('legacy-unrelated-tombstone'), 6n);
  assert.equal(await loadRequestGeneration('legacy-open-same-session'), 3n);

  process.stdout.write(JSON.stringify({ ok: true }));
} finally {
  await db.close();
}

async function loadRequest() {
  const result = await db.query(`
    SELECT
      "generation", "attempt_count", "lease_token", "manual_blocked_category",
      "manual_blocked_job_id", "manual_blocked_session_key", "manual_blocked_fingerprint",
      "manual_blocked_generation", "manual_acknowledged_at"
    FROM "night_mode_transition_reconcile_requests"
    WHERE "chat_id" = 'chat-1'
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error('Expected durable night mode request');
  }
  return row;
}

async function blockRequest(category) {
  await db.query(
    `UPDATE "night_mode_transition_reconcile_requests"
     SET
       "manual_blocked_at" = CURRENT_TIMESTAMP,
       "manual_blocked_reason" = 'bounded diagnostic',
       "manual_blocked_category" = $1,
       "manual_blocked_job_id" = 'job-1',
       "manual_blocked_session_key" = 'session-1',
       "manual_blocked_fingerprint" = $2,
       "manual_blocked_generation" = "generation",
       "manual_acknowledged_at" = NULL,
       "attempt_count" = 4
     WHERE "chat_id" = 'chat-1'`,
    [category, `sha256:${'a'.repeat(64)}`],
  );
}

async function loadRequestGeneration(chatId) {
  const result = await db.query(
    `SELECT "generation"
     FROM "night_mode_transition_reconcile_requests"
     WHERE "chat_id" = $1`,
    [chatId],
  );
  return result.rows[0] ? BigInt(result.rows[0].generation) : null;
}

async function requestLegacyRecoveryCandidates(candidates) {
  const values = candidates.flat();
  const valueSql = candidates
    .map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`)
    .join(', ');
  await db.query(
    `WITH recovery_candidates("chat_id", "session_key", "ledger_job_id") AS (
       VALUES ${valueSql}
     ), chats_to_request AS (
       SELECT DISTINCT candidate."chat_id"
       FROM recovery_candidates candidate
       WHERE NOT EXISTS (
         SELECT 1
         FROM "night_mode_transition_reconcile_requests" request
         WHERE request."chat_id" = candidate."chat_id"
           AND (
             request."manual_blocked_at" IS NULL
             OR request."generation" > request."manual_blocked_generation"
           )
       )
         AND NOT EXISTS (
           SELECT 1
           FROM "night_mode_transition_reconcile_requests" request
           WHERE request."chat_id" = candidate."chat_id"
             AND request."manual_blocked_at" IS NOT NULL
             AND request."generation" = request."manual_blocked_generation"
             AND request."manual_blocked_session_key" = candidate."session_key"
             AND request."manual_blocked_ledger_job_id" = candidate."ledger_job_id"
         )
         AND NOT EXISTS (
           SELECT 1
           FROM "night_mode_transition_scheduled_jobs" registry
           WHERE registry."chat_id" = candidate."chat_id"
             AND registry."session_key" = candidate."session_key"
             AND POSITION('__recovery__' IN registry."job_id") > 0
         )
     )
     SELECT enqueue_night_mode_transition_reconcile_request(candidate."chat_id")
     FROM chats_to_request candidate
     ORDER BY candidate."chat_id" ASC`,
    values,
  );
}

async function persistRegistryIntent(
  chatId,
  jobId,
  owner = { generation: null, leaseToken: null },
) {
  await db.query(
    `WITH request_owner AS (
       SELECT $4::BIGINT AS "generation", $5::TEXT AS "lease_token"
     ), registry_intent AS (
       INSERT INTO "night_mode_transition_scheduled_jobs" (
         "chat_id", "job_id", "transition", "session_key", "scheduled_for",
         "schedule_fingerprint", "created_at", "updated_at"
       ) VALUES (
         $1, $2, 'open', 'session-atomic', CURRENT_TIMESTAMP,
         $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )
       ON CONFLICT ("chat_id", "job_id") DO UPDATE
       SET
         "transition" = EXCLUDED."transition",
         "session_key" = EXCLUDED."session_key",
         "scheduled_for" = EXCLUDED."scheduled_for",
         "schedule_fingerprint" = EXCLUDED."schedule_fingerprint",
         "updated_at" = CURRENT_TIMESTAMP
       RETURNING "chat_id"
     )
     INSERT INTO "night_mode_transition_reconcile_requests" (
       "chat_id", "generation", "first_requested_at", "requested_at"
     )
     SELECT "chat_id", 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     FROM registry_intent
     ON CONFLICT ("chat_id") DO UPDATE
     SET
       "generation" = "night_mode_transition_reconcile_requests"."generation" + 1,
       "requested_at" = LEAST(
         "night_mode_transition_reconcile_requests"."requested_at",
         EXCLUDED."requested_at"
       ),
       "lease_token" = NULL,
       "lease_expires_at" = NULL
     WHERE NOT EXISTS (
       SELECT 1
       FROM request_owner owner
       WHERE owner."generation" =
           "night_mode_transition_reconcile_requests"."generation"
         AND owner."lease_token" =
           "night_mode_transition_reconcile_requests"."lease_token"
         AND "night_mode_transition_reconcile_requests"."lease_expires_at" >
           CURRENT_TIMESTAMP
         AND (
           "night_mode_transition_reconcile_requests"."manual_blocked_at" IS NULL
           OR "night_mode_transition_reconcile_requests"."generation" >
             "night_mode_transition_reconcile_requests"."manual_blocked_generation"
         )
     )`,
    [chatId, jobId, `sha256:${'d'.repeat(64)}`, owner.generation, owner.leaseToken],
  );
}
