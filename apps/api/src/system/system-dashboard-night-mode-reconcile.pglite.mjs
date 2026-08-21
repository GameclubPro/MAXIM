import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const encodedPayload = process.argv[2];
if (!encodedPayload) {
  throw new Error('Serialized dashboard query is required');
}
const payload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'));
if (typeof payload.sql !== 'string' || !Array.isArray(payload.values)) {
  throw new Error('Serialized dashboard query is invalid');
}

const db = new PGlite();
try {
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "night_mode_transition_reconcile_requests" (
      "chat_id" TEXT PRIMARY KEY,
      "generation" BIGINT NOT NULL DEFAULT 1,
      "first_requested_at" TIMESTAMP(3) NOT NULL,
      "requested_at" TIMESTAMP(3) NOT NULL,
      "lease_token" TEXT,
      "lease_expires_at" TIMESTAMP(3),
      "manual_blocked_at" TIMESTAMP(3),
      "manual_blocked_category" TEXT,
      "manual_blocked_generation" BIGINT,
      "manual_acknowledged_at" TIMESTAMP(3)
    )
  `);

  await insertUnleasedDue(1_001);
  await insertManual(1);
  await insertStaleLeases(1);
  let snapshot = await loadSnapshot();
  assert.equal(snapshot.manualBlocked, 1);
  assert.equal(snapshot.manualCapped, false);
  assert.equal(snapshot.agedDue, 1_001);
  assert.equal(snapshot.dueCapped, true);
  assert.equal(snapshot.staleLeases, 1);
  assert.equal(snapshot.staleLeaseCapped, false);

  await db.exec('TRUNCATE TABLE "night_mode_transition_reconcile_requests"');
  await insertAcknowledged(1);
  await insertFutureGenerationDue(1);
  await insertFutureGenerationStaleLease(1);
  snapshot = await loadSnapshot();
  assert.equal(snapshot.manualBlocked, 0);
  assert.equal(snapshot.agedDue, 2);
  assert.equal(snapshot.staleLeases, 1);

  await db.exec('TRUNCATE TABLE "night_mode_transition_reconcile_requests"');
  await insertManual(1_001);
  await insertUnleasedDue(1);
  await insertStaleLeases(1);
  snapshot = await loadSnapshot();
  assert.equal(snapshot.manualBlocked, 1_001);
  assert.equal(snapshot.manualCapped, true);
  assert.equal(snapshot.agedDue, 2);
  assert.equal(snapshot.dueCapped, false);
  assert.equal(snapshot.staleLeases, 1);
  assert.equal(snapshot.staleLeaseCapped, false);

  await db.exec('TRUNCATE TABLE "night_mode_transition_reconcile_requests"');
  await insertStaleLeases(1_001);
  await insertManual(1);
  await insertUnleasedDue(1);
  snapshot = await loadSnapshot();
  assert.equal(snapshot.manualBlocked, 1);
  assert.equal(snapshot.manualCapped, false);
  assert.equal(snapshot.agedDue, 1_001);
  assert.equal(snapshot.dueCapped, true);
  assert.equal(snapshot.staleLeases, 1_001);
  assert.equal(snapshot.staleLeaseCapped, true);

  process.stdout.write(JSON.stringify({ ok: true }));
} finally {
  await db.close();
}

async function loadSnapshot() {
  const result = await db.query(payload.sql, payload.values);
  const row = result.rows[0];
  if (!row) {
    throw new Error('Expected dashboard risk snapshot');
  }
  return row;
}

async function insertManual(count) {
  await db.query(
    `INSERT INTO "night_mode_transition_reconcile_requests" (
       "chat_id", "first_requested_at", "requested_at", "manual_blocked_at",
       "manual_blocked_category", "manual_blocked_generation"
     )
     SELECT
       'manual-' || LPAD(value::text, 5, '0'),
       CURRENT_TIMESTAMP - INTERVAL '20 minutes',
       CURRENT_TIMESTAMP - INTERVAL '20 minutes',
       CURRENT_TIMESTAMP - INTERVAL '10 minutes',
       'unsafe_prior_dispatch',
       1
     FROM generate_series(1, $1) value`,
    [count],
  );
}

async function insertAcknowledged(count) {
  await db.query(
    `INSERT INTO "night_mode_transition_reconcile_requests" (
       "chat_id", "first_requested_at", "requested_at", "manual_blocked_at",
       "manual_blocked_category", "manual_blocked_generation", "manual_acknowledged_at"
     )
     SELECT
       'acknowledged-' || LPAD(value::text, 5, '0'),
       CURRENT_TIMESTAMP - INTERVAL '30 minutes',
       CURRENT_TIMESTAMP - INTERVAL '30 minutes',
       CURRENT_TIMESTAMP - INTERVAL '20 minutes',
       'unsafe_prior_dispatch',
       1,
       CURRENT_TIMESTAMP - INTERVAL '10 minutes'
     FROM generate_series(1, $1) value`,
    [count],
  );
}

async function insertFutureGenerationDue(count) {
  await db.query(
    `INSERT INTO "night_mode_transition_reconcile_requests" (
       "chat_id", "generation", "first_requested_at", "requested_at", "manual_blocked_at",
       "manual_blocked_category", "manual_blocked_generation", "manual_acknowledged_at"
     )
     SELECT
       'future-due-' || LPAD(value::text, 5, '0'),
       2,
       CURRENT_TIMESTAMP - INTERVAL '30 minutes',
       CURRENT_TIMESTAMP - INTERVAL '30 minutes',
       CURRENT_TIMESTAMP - INTERVAL '20 minutes',
       'unsafe_prior_dispatch',
       1,
       CURRENT_TIMESTAMP - INTERVAL '10 minutes'
     FROM generate_series(1, $1) value`,
    [count],
  );
}

async function insertFutureGenerationStaleLease(count) {
  await db.query(
    `INSERT INTO "night_mode_transition_reconcile_requests" (
       "chat_id", "generation", "first_requested_at", "requested_at", "lease_token",
       "lease_expires_at", "manual_blocked_at", "manual_blocked_category",
       "manual_blocked_generation", "manual_acknowledged_at"
     )
     SELECT
       'future-stale-' || LPAD(value::text, 5, '0'),
       2,
       CURRENT_TIMESTAMP - INTERVAL '30 minutes',
       CURRENT_TIMESTAMP - INTERVAL '30 minutes',
       'future-lease-' || value::text,
       CURRENT_TIMESTAMP - INTERVAL '10 minutes',
       CURRENT_TIMESTAMP - INTERVAL '20 minutes',
       'unsafe_prior_dispatch',
       1,
       CURRENT_TIMESTAMP - INTERVAL '10 minutes'
     FROM generate_series(1, $1) value`,
    [count],
  );
}

async function insertUnleasedDue(count) {
  await db.query(
    `INSERT INTO "night_mode_transition_reconcile_requests" (
       "chat_id", "first_requested_at", "requested_at"
     )
     SELECT
       'due-' || LPAD(value::text, 5, '0'),
       CURRENT_TIMESTAMP - INTERVAL '30 minutes',
       CURRENT_TIMESTAMP - INTERVAL '30 minutes'
     FROM generate_series(1, $1) value`,
    [count],
  );
}

async function insertStaleLeases(count) {
  await db.query(
    `INSERT INTO "night_mode_transition_reconcile_requests" (
       "chat_id", "first_requested_at", "requested_at", "lease_token", "lease_expires_at"
     )
     SELECT
       'stale-' || LPAD(value::text, 5, '0'),
       CURRENT_TIMESTAMP - INTERVAL '20 minutes',
       CURRENT_TIMESTAMP - INTERVAL '20 minutes',
       'lease-' || value::text,
       CURRENT_TIMESTAMP - INTERVAL '10 minutes'
     FROM generate_series(1, $1) value`,
    [count],
  );
}
