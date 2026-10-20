import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

export const RETIREMENT_CUTOFF = '2026-10-19T23:00:00.000Z';
export const RETIREMENT_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'FAILED'];
export const RETIREMENT_SOURCE_CAP = 32;
export const RETIREMENT_TARGET_CAP = 128;
export const RETIREMENT_STOP_OPERATION = 'stop-only';
export const RETIREMENT_STOP_STATUSES = [
  ...RETIREMENT_STATUSES,
  'SENT',
  'PARTIAL',
  'AMBIGUOUS',
  'CANCELED',
];
export const RETIREMENT_STOP_PAGE_CAP = 96;
const stopEnvelopeStatuses = ['ACTIVE', 'PARTIAL', 'FAILED'];
const stopOccurrenceStatuses = [...RETIREMENT_STATUSES, 'PARTIAL', 'AMBIGUOUS'];
const profile = 'PUBLIK_V1';
const knownPreDispatchErrors = new Set([
  'PUBLISHER_ACTOR_ACCESS_REQUIRED',
  'PUBLISHER_RUNTIME_UNAVAILABLE',
  'PUBLISHER_AUTH_PAUSED',
  'PUBLISHER_MISSED_WINDOW_REVIEW',
  'PUBLISHER_WINDOW_EXPIRED',
  'PUBLICATION_ROUTE_QUARANTINED',
  'policy_disabled',
  'bot_not_connected',
  'bot_access_expired',
  'bot_access_unconfirmed',
  'bot_not_admin',
  'write_permission_missing',
  'route_quarantined',
  'publisher_bot_changed',
  'module_disabled',
  'publisher_runtime_unavailable',
  'catalog_unconfirmed',
  'audience_empty',
]);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = (value) => {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return NaN;
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/u.test(value) ? value : `${value.replace(' ', 'T')}Z`);
};
const normalized = (value) => JSON.parse(JSON.stringify(value));
const fail = (reason) => ({ safe: false, reason });
const beforeCutoff = (value) => timestamp(value) <= Date.parse(RETIREMENT_CUTOFF);
const sameIds = (left, right) =>
  left.length === right.length &&
  [...left].sort().every((id, index) => id === [...right].sort()[index]);

export function initialRetirementCursors() {
  return Object.fromEntries(
    RETIREMENT_STATUSES.map((status) => [status, { blocker: null, after: null, done: false }]),
  );
}

export function initialStopRetirementCursors() {
  return Object.fromEntries(
    RETIREMENT_STOP_STATUSES.map((status) => [status, { blocker: null, after: null, done: false }]),
  );
}

// FLAG: The existing ready index has blocker before slot. Each page fixes that
// full leading prefix, so equal-time cohorts use (scheduled_at,id) without a sort.
// Blocker discovery is a separate one-row index seek; never filter the source
// head by actor, bot, joins or zero-effect predicates before its 32+sentinel cap.
// Keep blocker in ORDER BY too: PostgreSQL does not discard its IS NULL pathkey
// when proving slot order and would otherwise sort the entire NULL partition.
export function buildRetirementSourceQuery(status, cursor) {
  if (!RETIREMENT_STATUSES.includes(status)) throw new Error('invalid_source_status');
  return buildSourceQuery(status, cursor);
}

export function buildStopRetirementSourceQuery(status, cursor) {
  if (!RETIREMENT_STOP_STATUSES.includes(status)) throw new Error('invalid_source_status');
  return buildSourceQuery(status, cursor);
}

function buildSourceQuery(status, cursor) {
  const values = [status, RETIREMENT_CUTOFF];
  let blocker = 'dispatch_blocker_code IS NULL';
  if (cursor.blocker !== null) {
    values.push(cursor.blocker);
    blocker = `dispatch_blocker_code=$${values.length}`;
  }
  let after = '';
  if (cursor.after) {
    values.push(cursor.after.scheduledAt, cursor.after.id);
    after = `AND (scheduled_at,id)>($${values.length - 1}::timestamp,$${values.length}::text)`;
  }
  return {
    text: `SELECT id,publication_id,schedule_id,scheduled_at FROM public.publication_occurrences
      WHERE dispatch_profile='PUBLIK_V1' AND status=$1::"PublicationOccurrenceStatus"
        AND ${blocker} AND scheduled_at<=$2::timestamp ${after}
      ORDER BY dispatch_blocker_code,scheduled_at,id LIMIT 33`,
    values,
  };
}

export function buildRetirementBlockerQuery(status, previous) {
  return {
    text: `SELECT dispatch_blocker_code FROM public.publication_occurrences
      WHERE dispatch_profile='PUBLIK_V1' AND status=$1::"PublicationOccurrenceStatus"
        AND dispatch_blocker_code IS NOT NULL ${previous === null ? '' : 'AND dispatch_blocker_code>$2'}
      ORDER BY dispatch_blocker_code LIMIT 1`,
    values: previous === null ? [status] : [status, previous],
  };
}

const occurrenceColumns = `id,publication_id,schedule_id,content_revision_id,schedule_revision,
  scheduled_at,status,legacy_broadcast_id,dispatch_profile,required_bot_id,dispatch_blocker_code,
  dispatch_blocked_at,dispatch_first_blocked_at,retry_authorized_at,retry_expires_at,delivery_deadline_at,created_at,updated_at`;
const deliveryColumns = `id,broadcast_id,occurrence_index,target_chat_id,bot_id,status,attempt_count,
  remote_message_id,remote_message_verified_at,remote_message_verification_attempt_count,
  remote_message_verification_absent_count,remote_message_verification_present_count,
  remote_message_verification_attempted_at,remote_message_verification_next_at,
  remote_message_verification_last_error IS NOT NULL AS verification_error_present,
  remote_message_verification_source,legacy_sent_without_remote_id,sent_at,
  post_actions_next_at,post_actions_token IS NOT NULL AS has_post_actions_token,subscription_delete_id,
  pin_status,pin_attempt_count,pin_error IS NOT NULL AS pin_error_present,
  delete_status,delete_at,deleted_at,delete_attempt_count,delete_error IS NOT NULL AS delete_error_present,
  locked_at,lock_token IS NOT NULL AS has_lock_token,publication_occurrence_id,content_revision_id,
  dispatch_profile,required_bot_id,dialog_bot_id,last_error_code,last_error IS NOT NULL AS last_error_present,created_at,updated_at`;

export async function readRetirementSnapshot(db, source, lock = false) {
  const suffix = lock ? ' FOR UPDATE NOWAIT' : '';
  // FLAG: Match the calendar writer lock and parent-first order. Parent row locks
  // also fence new FK children; delivery/envelope claims then serialize on rows.
  if (lock) {
    const result = await db.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('publication-calendar')) AS acquired",
    );
    if (!result.rows[0].acquired) throw new Error('calendar_writer_busy');
  }
  const publication = (
    await db.query(
      `SELECT id,actor_user_id,lifecycle,audience_mode,dispatch_profile,required_bot_id,
    canonical_content_revision_id,version,created_at,updated_at FROM public.publications WHERE id=$1 LIMIT 1${suffix}`,
      [source.publication_id],
    )
  ).rows[0];
  const schedule = (
    await db.query(
      `SELECT id,publication_id,mode,revision,status,created_at,updated_at
    FROM public.publication_schedules WHERE id=$1 LIMIT 1${suffix}`,
      [source.schedule_id],
    )
  ).rows[0];
  const occurrence = (
    await db.query(
      `SELECT ${occurrenceColumns} FROM public.publication_occurrences WHERE id=$1 LIMIT 1${suffix}`,
      [source.id],
    )
  ).rows[0];
  if (!publication || !schedule || !occurrence) return null;
  const targets = (
    await db.query(
      `SELECT id,target_chat_id,entity_type,position,created_at FROM public.publication_targets
    WHERE publication_id=$1 ORDER BY position LIMIT 129${suffix}`,
      [publication.id],
    )
  ).rows;
  const envelopes = (
    await db.query(
      `SELECT id,entity_type,sent_count,status,next_send_at,locked_at,cycle_enabled,cycle_count,apply_to_all_chats,
    CASE WHEN pg_column_compression(target_chat_ids) IS NULL AND pg_column_size(target_chat_ids)<=16384
      THEN jsonb_typeof(target_chat_ids) ELSE NULL END AS target_ids_type,
    CASE WHEN pg_column_compression(target_chat_ids) IS NULL AND pg_column_size(target_chat_ids)<=16384
      THEN CASE WHEN jsonb_typeof(target_chat_ids)='array'
        THEN CASE WHEN jsonb_array_length(target_chat_ids)<=128 THEN target_chat_ids ELSE NULL END
        ELSE NULL END ELSE NULL END AS target_chat_ids,
    last_error IS NOT NULL AS last_error_present,
    lock_token IS NOT NULL AS has_lock_token,publication_occurrence_id,publication_content_revision_id,
    dispatch_profile,required_bot_id,created_at,updated_at FROM public.managed_broadcasts
    WHERE publication_occurrence_id=$1 ORDER BY entity_type LIMIT 3${suffix}`,
      [occurrence.id],
    )
  ).rows;
  const deliveries = (
    await db.query(
      `SELECT ${deliveryColumns} FROM public.managed_broadcast_deliveries
    WHERE publication_occurrence_id=$1 ORDER BY created_at DESC,id DESC LIMIT 129${suffix}`,
      [occurrence.id],
    )
  ).rows;
  const envelopeDeliveries = [];
  const envelopeOccurrences = [];
  // FLAG: At most two envelopes exist under the attested (occurrence,entity) key.
  if (envelopes.length <= 2) {
    for (const envelope of envelopes) {
      const rows = (
        await db.query(
          `SELECT id,publication_occurrence_id FROM public.managed_broadcast_deliveries
        WHERE broadcast_id=$1 ORDER BY occurrence_index,target_chat_id LIMIT 129${suffix}`,
          [envelope.id],
        )
      ).rows;
      envelopeDeliveries.push({ envelopeId: envelope.id, rows });
      const occurrences = (
        await db.query(
          `SELECT id,occurrence_index,scheduled_at,status,updated_at
        FROM public.managed_broadcast_occurrences WHERE broadcast_id=$1 ORDER BY occurrence_index LIMIT 2${suffix}`,
          [envelope.id],
        )
      ).rows;
      envelopeOccurrences.push({ envelopeId: envelope.id, rows: occurrences });
    }
  }
  return normalized({
    publication,
    schedule,
    occurrence,
    targets,
    envelopes,
    deliveries,
    envelopeDeliveries,
    envelopeOccurrences,
  });
}

export function classifyRetirementSnapshot(snapshot, botId) {
  if (!snapshot) return fail('missing_parent');
  const { publication: p, schedule: s, occurrence: o, targets, envelopes, deliveries } = snapshot;
  if ([p, o].some((row) => row.dispatch_profile !== profile || row.required_bot_id !== botId))
    return fail('foreign_bot_or_profile');
  if (!RETIREMENT_STATUSES.includes(o.status)) return fail('terminal_or_uncertain_occurrence');
  if (!['ONCE', 'SLOTS', 'RECURRENCE'].includes(s.mode)) return fail('not_scheduled_mode');
  if (p.audience_mode !== 'SNAPSHOT') return fail('dynamic_audience');
  if (!beforeCutoff(o.scheduled_at) || ![p, s, o].every((row) => beforeCutoff(row.created_at)))
    return fail('newer_plan');
  if (o.retry_authorized_at && !beforeCutoff(o.retry_authorized_at))
    return fail('newer_explicit_retry');
  if (
    o.dispatch_blocker_code === 'PUBLISHER_EXPLICIT_RETRY' &&
    (!o.dispatch_blocked_at || !beforeCutoff(o.dispatch_blocked_at))
  )
    return fail('newer_explicit_retry');
  if (
    s.publication_id !== p.id ||
    o.publication_id !== p.id ||
    o.schedule_id !== s.id ||
    o.schedule_revision !== s.revision ||
    p.canonical_content_revision_id !== o.content_revision_id
  )
    return fail('revision_or_parent_mismatch');
  if (!['ACTIVE', 'PAUSED', 'ERROR', 'COMPLETED', 'CANCELED'].includes(p.lifecycle))
    return fail('publication_lifecycle');
  if (
    !targets.length ||
    targets.length > RETIREMENT_TARGET_CAP ||
    deliveries.length > RETIREMENT_TARGET_CAP ||
    envelopes.length > 2
  )
    return fail('target_or_child_cap');
  if (new Set(targets.map((row) => row.target_chat_id)).size !== targets.length)
    return fail('duplicate_target');
  if (o.legacy_broadcast_id && !envelopes.some((row) => row.id === o.legacy_broadcast_id))
    return fail('foreign_legacy_envelope');
  for (const envelope of envelopes) {
    if (
      envelope.dispatch_profile !== profile ||
      envelope.required_bot_id !== botId ||
      envelope.publication_occurrence_id !== o.id ||
      envelope.publication_content_revision_id !== o.content_revision_id
    )
      return fail('envelope_identity_mismatch');
    if (
      !['ACTIVE', 'FAILED'].includes(envelope.status) ||
      envelope.sent_count !== 0 ||
      envelope.locked_at !== null ||
      envelope.has_lock_token
    )
      return fail('envelope_touched');
    if (
      envelope.cycle_enabled !== false ||
      envelope.cycle_count !== 1 ||
      envelope.apply_to_all_chats !== false ||
      envelope.target_ids_type !== 'array' ||
      !Array.isArray(envelope.target_chat_ids) ||
      !sameIds(
        envelope.target_chat_ids,
        targets
          .filter((target) => target.entity_type === envelope.entity_type)
          .map((target) => target.target_chat_id),
      )
    )
      return fail('envelope_audience_or_cycle_mismatch');
    if (envelope.last_error_present) return fail('envelope_unknown_error');
    if (!targets.some((target) => target.entity_type === envelope.entity_type))
      return fail('envelope_target_mismatch');
    const saved = snapshot.envelopeDeliveries.find(
      (entry) => entry.envelopeId === envelope.id,
    )?.rows;
    if (
      !saved ||
      saved.length > RETIREMENT_TARGET_CAP ||
      saved.some((row) => row.publication_occurrence_id !== o.id) ||
      !sameIds(
        saved.map((row) => row.id),
        deliveries.filter((row) => row.broadcast_id === envelope.id).map((row) => row.id),
      )
    )
      return fail('foreign_or_incomplete_envelope_deliveries');
    if (
      !sameIds(
        envelope.target_chat_ids,
        deliveries
          .filter((row) => row.broadcast_id === envelope.id)
          .map((row) => row.target_chat_id),
      )
    )
      return fail('incomplete_frozen_targets');
    const slots = snapshot.envelopeOccurrences.find(
      (entry) => entry.envelopeId === envelope.id,
    )?.rows;
    if (
      !slots ||
      slots.length > 1 ||
      slots.some(
        (row) =>
          !['ACTIVE', 'FAILED'].includes(row.status) ||
          row.occurrence_index !== 1 ||
          timestamp(row.scheduled_at) !== timestamp(o.scheduled_at),
      )
    )
      return fail('envelope_slot_mismatch');
  }
  const targetSet = new Set();
  for (const delivery of deliveries) {
    const envelope = envelopes.find((row) => row.id === delivery.broadcast_id);
    const target = targets.find((row) => row.target_chat_id === delivery.target_chat_id);
    if (
      !envelope ||
      !target ||
      target.entity_type !== envelope.entity_type ||
      targetSet.has(target.target_chat_id) ||
      delivery.occurrence_index !== 1
    )
      return fail('delivery_target_mismatch');
    targetSet.add(target.target_chat_id);
    if (
      delivery.dispatch_profile !== profile ||
      delivery.required_bot_id !== botId ||
      delivery.content_revision_id !== o.content_revision_id ||
      delivery.publication_occurrence_id !== o.id ||
      (delivery.bot_id !== null && delivery.bot_id !== botId)
    )
      return fail('delivery_identity_mismatch');
    if (
      delivery.status !== 'PENDING' ||
      delivery.attempt_count !== 0 ||
      delivery.legacy_sent_without_remote_id ||
      delivery.locked_at !== null ||
      delivery.has_lock_token ||
      delivery.last_error_code === 'PUBLIK_LEDGER_DISPATCH_V1'
    )
      return fail('delivery_started_or_uncertain');
    if (
      (delivery.last_error_code !== null &&
        !knownPreDispatchErrors.has(delivery.last_error_code)) ||
      (delivery.last_error_present && delivery.last_error_code === null)
    )
      return fail('delivery_unknown_error');
    if (
      [
        'remote_message_id',
        'remote_message_verified_at',
        'remote_message_verification_attempted_at',
        'remote_message_verification_next_at',
        'remote_message_verification_source',
        'sent_at',
      ].some((key) => delivery[key] !== null) ||
      [
        'remote_message_verification_attempt_count',
        'remote_message_verification_absent_count',
        'remote_message_verification_present_count',
      ].some((key) => delivery[key] !== 0) ||
      delivery.verification_error_present
    )
      return fail('delivery_verification_evidence');
    // FLAG: Configured PENDING pin/delete (including delete_at) is intent, not an
    // effect. Preserve that history while requiring every execution counter,
    // token, error, subscription handoff and settlement to remain untouched.
    if (
      !['NONE', 'PENDING'].includes(delivery.pin_status) ||
      !['NONE', 'PENDING'].includes(delivery.delete_status) ||
      delivery.pin_attempt_count !== 0 ||
      delivery.delete_attempt_count !== 0 ||
      delivery.has_post_actions_token ||
      delivery.pin_error_present ||
      delivery.delete_error_present ||
      ['post_actions_next_at', 'subscription_delete_id', 'deleted_at'].some(
        (key) => delivery[key] !== null,
      )
    )
      return fail('post_action_evidence');
  }
  return {
    safe: true,
    reason: 'obsolete_untouched',
    deliveries: deliveries.length,
    envelopes: envelopes.length,
  };
}

export const retirementSnapshotDigest = digest;
export function retirementPlanMatchesOperation(plan, operation) {
  return operation === RETIREMENT_STOP_OPERATION
    ? plan?.version === 2 && plan.operation === RETIREMENT_STOP_OPERATION
    : operation === undefined && plan?.version === 1 && !Object.hasOwn(plan, 'operation');
}

export function retirementSendKey(delivery) {
  return `managed-broadcast:send:${delivery.broadcast_id}:occurrence:${delivery.occurrence_index}:target:${delivery.target_chat_id}:content:publication-${delivery.content_revision_id}`;
}

export async function hasRetirementLedgerEvidence(db, snapshot) {
  // FLAG: attempt_count=0 and no dispatch marker are mandatory above. The first
  // immutable SEND key is retained by every supported later attempt; any ledger
  // row, including canceled/failed/ENQUEUED, refuses maintenance cancellation.
  for (const delivery of snapshot.deliveries) {
    if (
      (
        await db.query('SELECT job_id FROM public.max_action_ledger WHERE job_id=$1 LIMIT 1', [
          retirementSendKey(delivery),
        ])
      ).rows.length
    )
      return true;
  }
  return false;
}

export async function previewRetirement(db, { botId, cursors = initialRetirementCursors() }) {
  const nextCursors = normalized(cursors);
  const candidates = [];
  const refusals = {};
  let sampled = 0;
  const heads = [];
  for (const status of RETIREMENT_STATUSES) {
    const cursor = cursors[status];
    if (cursor.done) continue;
    const rows = (await db.query(buildRetirementSourceQuery(status, cursor))).rows;
    const selected = rows.slice(0, RETIREMENT_SOURCE_CAP);
    sampled += selected.length;
    heads.push({
      status,
      sampled: selected.length,
      truncated: rows.length > RETIREMENT_SOURCE_CAP,
    });
    for (const source of selected) {
      const snapshot = await readRetirementSnapshot(db, source);
      let result = classifyRetirementSnapshot(snapshot, botId);
      if (result.safe && (await hasRetirementLedgerEvidence(db, snapshot)))
        result = fail('ledger_evidence');
      if (result.safe)
        candidates.push({
          source: normalized(source),
          snapshotDigest: digest(snapshot),
          deliveries: result.deliveries,
          envelopes: result.envelopes,
        });
      else refusals[result.reason] = (refusals[result.reason] ?? 0) + 1;
    }
    if (rows.length > RETIREMENT_SOURCE_CAP) {
      const last = selected.at(-1);
      nextCursors[status].after = {
        scheduledAt: new Date(timestamp(last.scheduled_at)).toISOString(),
        id: last.id,
      };
    } else {
      const next = (await db.query(buildRetirementBlockerQuery(status, cursor.blocker))).rows[0];
      nextCursors[status] = next
        ? { blocker: next.dispatch_blocker_code, after: null, done: false }
        : { blocker: cursor.blocker, after: null, done: true };
    }
  }
  return {
    candidates,
    nextCursors,
    report: {
      sampled,
      eligible: candidates.length,
      deliveries: candidates.reduce((sum, row) => sum + row.deliveries, 0),
      envelopes: candidates.reduce((sum, row) => sum + row.envelopes, 0),
      refusals,
      heads,
      sourceComplete: Object.values(nextCursors).every((cursor) => cursor.done),
    },
  };
}

export async function applyRetirement(db, plan, botId) {
  const outcomes = { canceled: 0, deliveries: 0, envelopes: 0, refused: {} };
  // FLAG: One whole occurrence is the transaction boundary. Earlier committed safe
  // occurrences stay canceled if a later row races; all other evidence survives.
  for (const candidate of plan.candidates) {
    await db.query('BEGIN');
    try {
      const snapshot = await readRetirementSnapshot(db, candidate.source, true);
      const result = classifyRetirementSnapshot(snapshot, botId);
      let reason = !result.safe
        ? result.reason
        : digest(snapshot) !== candidate.snapshotDigest
          ? 'snapshot_changed'
          : null;
      if (!reason && (await hasRetirementLedgerEvidence(db, snapshot))) reason = 'ledger_evidence';
      if (reason) {
        await db.query('ROLLBACK');
        outcomes.refused[reason] = (outcomes.refused[reason] ?? 0) + 1;
        continue;
      }
      for (const delivery of snapshot.deliveries) {
        const changed = await db.query(
          "UPDATE public.managed_broadcast_deliveries SET status='CANCELED',updated_at=(statement_timestamp() AT TIME ZONE 'UTC') WHERE id=$1 AND status='PENDING' AND attempt_count=0",
          [delivery.id],
        );
        if (changed.rowCount !== 1) throw new Error('delivery_cas_failed');
      }
      for (const envelope of snapshot.envelopes) {
        const changed = await db.query(
          "UPDATE public.managed_broadcasts SET status='CANCELED',next_send_at=NULL,updated_at=(statement_timestamp() AT TIME ZONE 'UTC') WHERE id=$1 AND sent_count=0 AND locked_at IS NULL AND lock_token IS NULL",
          [envelope.id],
        );
        if (changed.rowCount !== 1) throw new Error('envelope_cas_failed');
        for (const slot of snapshot.envelopeOccurrences.find(
          (row) => row.envelopeId === envelope.id,
        ).rows) {
          await db.query(
            "UPDATE public.managed_broadcast_occurrences SET status='CANCELED',updated_at=(statement_timestamp() AT TIME ZONE 'UTC') WHERE id=$1",
            [slot.id],
          );
        }
      }
      const changed = await db.query(
        "UPDATE public.publication_occurrences SET status='CANCELED',updated_at=(statement_timestamp() AT TIME ZONE 'UTC') WHERE id=$1 AND status=$2::\"PublicationOccurrenceStatus\"",
        [snapshot.occurrence.id, snapshot.occurrence.status],
      );
      if (changed.rowCount !== 1) throw new Error('occurrence_cas_failed');
      await db.query('COMMIT');
      outcomes.canceled += 1;
      outcomes.deliveries += snapshot.deliveries.length;
      outcomes.envelopes += snapshot.envelopes.length;
    } catch (error) {
      await db.query('ROLLBACK');
      if (error.code === '55P03' || error.message === 'calendar_writer_busy')
        outcomes.refused.writer_busy = (outcomes.refused.writer_busy ?? 0) + 1;
      else throw error;
    }
  }
  return outcomes;
}

export async function readStopRetirementSnapshot(db, source, lock = false) {
  const suffix = lock ? ' FOR UPDATE NOWAIT' : '';
  if (lock) {
    const result = await db.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('publication-calendar')) AS acquired",
    );
    if (!result.rows[0].acquired) throw new Error('calendar_writer_busy');
  }
  const publication = (
    await db.query(
      `SELECT id,lifecycle,audience_mode,dispatch_profile,required_bot_id,version,
      canonical_content_revision_id,created_at,updated_at FROM public.publications WHERE id=$1 LIMIT 1${suffix}`,
      [source.publication_id],
    )
  ).rows[0];
  const schedule = (
    await db.query(
      `SELECT id,publication_id,mode,revision,status,created_at,updated_at
      FROM public.publication_schedules WHERE id=$1 LIMIT 1${suffix}`,
      [source.schedule_id],
    )
  ).rows[0];
  const occurrence = (
    await db.query(
      `SELECT ${occurrenceColumns} FROM public.publication_occurrences WHERE id=$1 LIMIT 1${suffix}`,
      [source.id],
    )
  ).rows[0];
  if (!publication || !schedule || !occurrence) return null;
  // FLAG: Stop intent never reads child effects or audience JSON. An ACK may
  // settle independently; only this occurrence and its one-shot envelopes stop.
  const envelopes = (
    await db.query(
      `SELECT id,entity_type,status,next_send_at,cycle_enabled,cycle_count,
      publication_occurrence_id,dispatch_profile,required_bot_id FROM public.managed_broadcasts
      WHERE publication_occurrence_id=$1 ORDER BY entity_type LIMIT 3${suffix}`,
      [occurrence.id],
    )
  ).rows;
  const envelopeOccurrences = [];
  if (envelopes.length <= 2)
    for (const envelope of envelopes) {
      const rows = (
        await db.query(
          `SELECT id,occurrence_index,scheduled_at FROM public.managed_broadcast_occurrences
          WHERE broadcast_id=$1 ORDER BY occurrence_index LIMIT 2${suffix}`,
          [envelope.id],
        )
      ).rows;
      envelopeOccurrences.push({ envelopeId: envelope.id, rows });
    }
  return normalized({ publication, schedule, occurrence, envelopes, envelopeOccurrences });
}

export function classifyStopRetirementSnapshot(snapshot, botId) {
  if (!snapshot) return fail('missing_parent');
  const { publication: p, schedule: s, occurrence: o, envelopes } = snapshot;
  if ([p, o].some((row) => row.dispatch_profile !== profile || row.required_bot_id !== botId))
    return fail('foreign_bot_or_profile');
  if (!RETIREMENT_STOP_STATUSES.includes(o.status)) return fail('unknown_occurrence_status');
  if (!['ONCE', 'SLOTS', 'RECURRENCE'].includes(s.mode)) return fail('not_scheduled_mode');
  if (p.audience_mode !== 'SNAPSHOT') return fail('dynamic_audience');
  if (!beforeCutoff(o.scheduled_at) || ![p, s, o].every((row) => beforeCutoff(row.created_at)))
    return fail('newer_plan');
  if (
    (o.retry_authorized_at && !beforeCutoff(o.retry_authorized_at)) ||
    (o.dispatch_blocker_code === 'PUBLISHER_EXPLICIT_RETRY' &&
      (!o.dispatch_blocked_at || !beforeCutoff(o.dispatch_blocked_at)))
  )
    return fail('newer_explicit_retry');
  if (s.publication_id !== p.id || o.publication_id !== p.id || o.schedule_id !== s.id)
    return fail('parent_mismatch');
  if (!['ACTIVE', 'PAUSED', 'ERROR', 'COMPLETED', 'CANCELED'].includes(p.lifecycle))
    return fail('publication_lifecycle');
  if (envelopes.length > 2) return fail('envelope_cap');
  if (o.legacy_broadcast_id && !envelopes.some((row) => row.id === o.legacy_broadcast_id))
    return fail('foreign_legacy_envelope');
  for (const envelope of envelopes) {
    if (
      envelope.publication_occurrence_id !== o.id ||
      envelope.dispatch_profile !== profile ||
      envelope.required_bot_id !== botId ||
      !['CHAT', 'CHANNEL'].includes(envelope.entity_type)
    )
      return fail('envelope_identity_mismatch');
    if (!['ACTIVE', 'PARTIAL', 'FAILED', 'COMPLETED', 'CANCELED'].includes(envelope.status))
      return fail('unknown_envelope_status');
  }
  const cancelOccurrence = stopOccurrenceStatuses.includes(o.status);
  const stopEnvelopes = envelopes.filter((row) => stopEnvelopeStatuses.includes(row.status));
  if (!cancelOccurrence && stopEnvelopes.length === 0)
    return { safe: true, cancelOccurrence, envelopes: 0, noAction: true };
  for (const envelope of envelopes) {
    const slots = snapshot.envelopeOccurrences.find(
      (entry) => entry.envelopeId === envelope.id,
    )?.rows;
    if (
      envelope.cycle_enabled !== false ||
      envelope.cycle_count !== 1 ||
      !slots ||
      slots.length > 1 ||
      slots.some(
        (row) =>
          row.occurrence_index !== 1 || timestamp(row.scheduled_at) !== timestamp(o.scheduled_at),
      )
    )
      return fail('future_or_mismatched_envelope_slots');
  }
  return {
    safe: true,
    cancelOccurrence,
    envelopes: stopEnvelopes.length,
    noAction: !cancelOccurrence && stopEnvelopes.length === 0,
  };
}

export async function previewStopRetirement(
  db,
  { botId, cursors = initialStopRetirementCursors() },
) {
  if (
    Object.keys(cursors).length !== RETIREMENT_STOP_STATUSES.length ||
    RETIREMENT_STOP_STATUSES.some((status) => !cursors[status])
  )
    throw new Error('invalid_stop_cursor');
  const nextCursors = normalized(cursors);
  const candidates = [];
  const refusals = {};
  const heads = [];
  let sampled = 0;
  let noAction = 0;
  for (const status of RETIREMENT_STOP_STATUSES) {
    if (sampled >= RETIREMENT_STOP_PAGE_CAP) break;
    const cursor = cursors[status];
    if (!cursor || typeof cursor.done !== 'boolean') throw new Error('invalid_stop_cursor');
    if (cursor.done) continue;
    const rows = (await db.query(buildStopRetirementSourceQuery(status, cursor))).rows;
    const cap = Math.min(RETIREMENT_SOURCE_CAP, RETIREMENT_STOP_PAGE_CAP - sampled);
    const selected = rows.slice(0, cap);
    sampled += selected.length;
    heads.push({ status, sampled: selected.length, truncated: rows.length > cap });
    for (const source of selected) {
      const snapshot = await readStopRetirementSnapshot(db, source);
      const result = classifyStopRetirementSnapshot(snapshot, botId);
      if (!result.safe) refusals[result.reason] = (refusals[result.reason] ?? 0) + 1;
      else if (result.noAction) noAction += 1;
      else
        candidates.push({
          source: normalized(source),
          snapshotDigest: digest(snapshot),
          cancelOccurrence: result.cancelOccurrence,
          envelopes: result.envelopes,
        });
    }
    if (rows.length > cap) {
      const last = selected.at(-1);
      nextCursors[status].after = {
        scheduledAt: new Date(timestamp(last.scheduled_at)).toISOString(),
        id: last.id,
      };
    } else {
      const next = (await db.query(buildRetirementBlockerQuery(status, cursor.blocker))).rows[0];
      nextCursors[status] = next
        ? { blocker: next.dispatch_blocker_code, after: null, done: false }
        : { blocker: cursor.blocker, after: null, done: true };
    }
  }
  return {
    candidates,
    nextCursors,
    report: {
      sampled,
      eligible: candidates.length,
      occurrencesToCancel: candidates.filter((row) => row.cancelOccurrence).length,
      envelopes: candidates.reduce((sum, row) => sum + row.envelopes, 0),
      noAction,
      refusals,
      heads,
      sourceComplete: Object.values(nextCursors).every((cursor) => cursor.done),
    },
  };
}

export async function applyStopRetirement(db, plan, botId) {
  const outcomes = { stopped: 0, canceled: 0, envelopes: 0, preservedOccurrences: 0, refused: {} };
  for (const candidate of plan.candidates) {
    await db.query('BEGIN');
    try {
      const snapshot = await readStopRetirementSnapshot(db, candidate.source, true);
      const result = classifyStopRetirementSnapshot(snapshot, botId);
      const reason = !result.safe
        ? result.reason
        : digest(snapshot) !== candidate.snapshotDigest
          ? 'snapshot_changed'
          : null;
      if (reason) {
        await db.query('ROLLBACK');
        outcomes.refused[reason] = (outcomes.refused[reason] ?? 0) + 1;
        continue;
      }
      // FLAG: Never alter delivery/slot/ledger/lease/post-action evidence. Late
      // receipts remain valid; canceled envelopes cannot be auto-projected again.
      if (result.noAction) {
        await db.query('ROLLBACK');
        continue;
      }
      for (const envelope of snapshot.envelopes.filter((row) =>
        stopEnvelopeStatuses.includes(row.status),
      )) {
        const changed = await db.query(
          `UPDATE public.managed_broadcasts SET status='CANCELED',next_send_at=NULL,
          updated_at=(statement_timestamp() AT TIME ZONE 'UTC')
          WHERE id=$1 AND status=$2::"ManagedBroadcastStatus" AND publication_occurrence_id=$3
          AND dispatch_profile='PUBLIK_V1' AND required_bot_id=$4`,
          [envelope.id, envelope.status, snapshot.occurrence.id, botId],
        );
        if (changed.rowCount !== 1) throw new Error('stop_envelope_cas_failed');
      }
      if (result.cancelOccurrence) {
        const changed = await db.query(
          `UPDATE public.publication_occurrences SET status='CANCELED',
          updated_at=(statement_timestamp() AT TIME ZONE 'UTC')
          WHERE id=$1 AND status=$2::"PublicationOccurrenceStatus"
          AND dispatch_profile='PUBLIK_V1' AND required_bot_id=$3`,
          [snapshot.occurrence.id, snapshot.occurrence.status, botId],
        );
        if (changed.rowCount !== 1) throw new Error('stop_occurrence_cas_failed');
      }
      await db.query('COMMIT');
      outcomes.stopped += 1;
      outcomes.canceled += Number(result.cancelOccurrence);
      outcomes.preservedOccurrences += Number(!result.cancelOccurrence);
      outcomes.envelopes += result.envelopes;
    } catch (error) {
      await db.query('ROLLBACK');
      if (error.code === '55P03' || error.message === 'calendar_writer_busy')
        outcomes.refused.writer_busy = (outcomes.refused.writer_busy ?? 0) + 1;
      else throw error;
    }
  }
  return outcomes;
}

const requiredIndexes = {
  publication_occurrences_ready_dispatch_idx: [
    'publication_occurrences',
    ['dispatch_profile', 'status', 'dispatch_blocker_code', 'scheduled_at', 'id'],
  ],
  publications_pkey: ['publications', ['id']],
  publication_schedules_pkey: ['publication_schedules', ['id']],
  publication_occurrences_pkey: ['publication_occurrences', ['id']],
  publication_targets_publication_position_key: [
    'publication_targets',
    ['publication_id', 'position'],
  ],
  managed_broadcasts_pub_occurrence_entity_key: [
    'managed_broadcasts',
    ['publication_occurrence_id', 'entity_type'],
  ],
  managed_broadcast_deliveries_pub_occurrence_created_id_idx: [
    'managed_broadcast_deliveries',
    ['publication_occurrence_id', 'created_at', 'id'],
  ],
  managed_broadcast_deliveries_broadcast_occurrence_target_key: [
    'managed_broadcast_deliveries',
    ['broadcast_id', 'occurrence_index', 'target_chat_id'],
  ],
  managed_broadcast_occurrences_broadcast_occurrence_key: [
    'managed_broadcast_occurrences',
    ['broadcast_id', 'occurrence_index'],
  ],
  max_action_ledger_job_id_key: ['max_action_ledger', ['job_id']],
  managed_broadcasts_pkey: ['managed_broadcasts', ['id']],
  managed_broadcast_deliveries_pkey: ['managed_broadcast_deliveries', ['id']],
  managed_broadcast_occurrences_pkey: ['managed_broadcast_occurrences', ['id']],
};

export async function attestRetirementIndexes(db) {
  for (const [name, [table, columns]] of Object.entries(requiredIndexes)) {
    const row = (
      await db.query(
        `SELECT i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indnkeyatts=i.indnatts AS no_include,
      i.indoption::smallint[] AS options,i.indpred IS NULL AND i.indexprs IS NULL AS plain,
      NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) op(opid) JOIN pg_opclass oc ON oc.oid=op.opid WHERE NOT oc.opcdefault) AS default_opclasses,
      NOT EXISTS (SELECT 1 FROM unnest(i.indkey::smallint[],i.indcollation::oid[]) k(attnum,collation_oid)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum WHERE k.collation_oid<>a.attcollation) AS default_collations,
      ARRAY(SELECT ty.typname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,n)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum JOIN pg_type ty ON ty.oid=a.atttypid ORDER BY k.n) AS types,
      t.relname AS table_name,am.amname,ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,n)
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum ORDER BY k.n) AS columns
      FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid
      JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am am ON am.oid=c.relam WHERE ns.nspname='public' AND c.relname=$1`,
        [name],
      )
    ).rows[0];
    const types = columns.map((column) =>
      column === 'dispatch_profile'
        ? 'PublicationDispatchProfile'
        : column === 'status'
          ? 'PublicationOccurrenceStatus'
          : ['created_at', 'scheduled_at'].includes(column)
            ? 'timestamp'
            : ['position', 'occurrence_index'].includes(column)
              ? 'int4'
              : column === 'entity_type'
                ? 'ChatEntityType'
                : 'text',
    );
    const options = columns.map((column) =>
      name === 'managed_broadcast_deliveries_pub_occurrence_created_id_idx' &&
      ['created_at', 'id'].includes(column)
        ? 3
        : 0,
    );
    if (
      !row ||
      !row.indisvalid ||
      !row.indisready ||
      !row.indislive ||
      !row.plain ||
      !row.no_include ||
      !row.default_opclasses ||
      !row.default_collations ||
      row.indisunique !== (name.endsWith('_key') || name.endsWith('_pkey')) ||
      JSON.stringify(row.options) !== JSON.stringify(options) ||
      JSON.stringify(row.types) !== JSON.stringify(types) ||
      row.amname !== 'btree' ||
      row.table_name !== table ||
      JSON.stringify(row.columns) !== JSON.stringify(columns)
    )
      throw Object.assign(new Error(`retirement_index_drift_${name}`), { observed: row });
  }
}

// FLAG: Production observes plain EXPLAIN only. Reject an unbounded scan/sort
// before executing each distinct read shape, including parent and child probes.
export async function inspectRetirementReadPlan(client, query, params) {
  const text = typeof query === 'string' ? query : query.text;
  const values = typeof query === 'string' ? params : query.values;
  const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values)).rows[0][
    'QUERY PLAN'
  ][0].Plan;
  const indexes = [];
  const visit = (node) => {
    if (
      !['Limit', 'Index Scan', 'Index Only Scan', 'Result'].includes(node['Node Type']) ||
      node.Filter ||
      (node['Relation Name'] && !Object.hasOwn(requiredIndexes, node['Index Name']))
    )
      throw Object.assign(new Error('unbounded_retirement_read_plan'), {
        observed: {
          node: node['Node Type'],
          index: node['Index Name'],
          relation: node['Relation Name'],
          hasFilter: Boolean(node.Filter),
        },
        shapeDigest: digest(text),
      });
    if (node['Index Name']) indexes.push(node['Index Name']);
    for (const child of node.Plans ?? []) visit(child);
  };
  if (
    plan['Node Type'] !== 'Limit' ||
    !Number.isFinite(plan['Plan Rows']) ||
    plan['Plan Rows'] > 129
  )
    throw new Error('unbounded_retirement_read_plan');
  visit(plan);
  if (!indexes.length) throw new Error('missing_retirement_read_index');
  return { shapeDigest: digest(text), indexes, estimatedRows: plan['Plan Rows'] };
}

export async function runContainerRetirement(request) {
  const require = createRequire('/app/package.json');
  const pg = require('pg');
  pg.types.setTypeParser(1114, (value) => new Date(`${value.replace(' ', 'T')}Z`));
  if (
    !request ||
    !['preview', 'apply'].includes(request.action) ||
    ![undefined, RETIREMENT_STOP_OPERATION].includes(request.operation) ||
    (request.action === 'apply' &&
      (!retirementPlanMatchesOperation(request.plan, request.operation) ||
        !Array.isArray(request.plan.candidates) ||
        request.plan.candidates.length > RETIREMENT_STOP_PAGE_CAP)) ||
    request.cutoff !== RETIREMENT_CUTOFF ||
    request.botId !== process.env.MAX_PUBLISHER_BOT_ID ||
    request.botId !== process.env.MAX_BOT_ID ||
    !Number.isSafeInteger(request.deadlineMs) ||
    request.deadlineMs <= Date.now() ||
    request.deadlineMs > Date.now() + 90_000
  )
    throw new Error('invalid_retirement_request');
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    application_name: `maxim-publik-retirement-${randomUUID()}`,
    options:
      '-c timezone=UTC -c statement_timeout=2000 -c lock_timeout=150 -c idle_in_transaction_session_timeout=5000 -c max_parallel_workers_per_gather=0 -c enable_seqscan=off -c enable_bitmapscan=off -c plan_cache_mode=force_custom_plan',
  });
  await client.connect();
  const readPlans = new Map();
  const db = {
    query: async (...args) => {
      const command = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (Date.now() >= request.deadlineMs && command !== 'ROLLBACK')
        throw new Error('retirement_deadline');
      if (
        request.action === 'preview' &&
        /^SELECT\b/iu.test(command) &&
        /\bpublic\./u.test(command) &&
        !readPlans.has(command)
      ) {
        readPlans.set(command, await inspectRetirementReadPlan(client, args[0], args[1]));
      }
      return client.query(...args);
    },
  };
  try {
    await attestRetirementIndexes(db);
    if (request.action === 'preview') {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const result = await (request.operation === RETIREMENT_STOP_OPERATION
          ? previewStopRetirement(db, request)
          : previewRetirement(db, request));
        await db.query('COMMIT');
        return { ...result, readPlans: [...readPlans.values()] };
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
    return await (request.operation === RETIREMENT_STOP_OPERATION
      ? applyStopRetirement(db, request.plan, request.botId)
      : applyRetirement(db, request.plan, request.botId));
  } finally {
    await client.end();
  }
}
