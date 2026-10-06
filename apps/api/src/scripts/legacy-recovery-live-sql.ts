import { Prisma } from '../prisma/prisma-client';
import {
  inspectLegacyRecoveryCandidate,
  inspectLegacyRecoverySource,
  legacySnapshotDigest,
  type LegacyRecoveryCandidate,
} from '../webhook/webhook-legacy-cold-install';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  legacyRecoveryLiveDigest,
  type LegacyRecoveryLiveIssue,
  type LegacyRecoveryLiveOutput,
  type LegacyRecoveryLivePlanProof,
  type LegacyRecoveryLiveRequest,
} from './legacy-recovery-live-protocol';
import { LEGACY_RECOVERY_SQL_PRIMARY_KEYS } from './legacy-recovery-sql-keys';
import { previewLegacyRecoveryMaterialization } from './legacy-recovery-materialization-preview';

export type LegacyRecoveryLiveSqlSelection = Pick<LegacyRecoveryLiveRequest, 'selection'>;

const descriptors = Object.freeze(
  Object.keys(LEGACY_RECOVERY_SQL_PRIMARY_KEYS).map((table) =>
    Object.freeze({ id: `sql:${table}`, table }),
  ),
);

// FLAG: Literal schema-reviewed metadata only. Bodies, media, tokens, payloads and
// JSON ancestry remain private; omission is not positive evidence of independence.
const metadataColumns: Readonly<Record<string, readonly string[]>> = Object.freeze({
  publisher_entity_bindings: [
    'chat_id',
    'publisher_bot_id',
    'status',
    'bot_access_checked_at',
    'bot_access_expires_at',
    'send_route_failure_count',
    'send_route_quarantined_until',
    'send_route_last_failure_at',
    'send_route_last_success_at',
    'last_seen_at',
    'last_webhook_at',
    'lifecycle_event_at',
    'roster_checked_at',
    'roster_refresh_after',
    'created_at',
    'updated_at',
  ],
  publisher_access_refresh_obligations: [
    'publisher_bot_id',
    'chat_id',
    'proof_checked_at',
    'required_before',
    'observed_at',
    'resolution',
    'committed_at',
  ],
  suggestion_subscription_watches: [
    'id',
    'chat_id',
    'author_user_id',
    'profile',
    'bot_id',
    'next_check_at',
    'missing_since',
    'checked_at',
    'lease_until',
    'revision',
  ],
  suggestion_subscription_publications: [
    'id',
    'watch_id',
    'publication_id',
    'message_id',
    'delivery_id',
    'published_at',
    'deleted_at',
    'delete_intent_id',
  ],
  publisher_auto_reply_deliveries: [
    'id',
    'chat_id',
    'rule_id',
    'content_revision_id',
    'publisher_bot_id',
    'source_message_id',
    'source_user_id',
    'source_webhook_event_id',
    'matched_rule_version',
    'matched_trigger_id',
    'distance',
    'matcher_version',
    'auto_reply_config_revision',
    'publisher_settings_revision',
    'publication_policy_revision',
    'status',
    'due_at',
    'attempt_count',
    'locked_at',
    'dispatch_started_at',
    'remote_message_id',
    'canceled_at',
    'created_at',
    'updated_at',
  ],
  publisher_auto_reply_asset_uploads: [
    'id',
    'asset_id',
    'publisher_bot_id',
    'status',
    'expires_at',
    'attempt_count',
    'locked_at',
    'created_at',
    'updated_at',
  ],
  publisher_auto_reply_authoring_sessions: [
    'id',
    'publisher_bot_id',
    'actor_user_id',
    'request_id',
    'state',
    'stage_revision',
    'private_chat_id',
    'target_chat_id',
    'fuzzy_match',
    'phrase_message_id',
    'content_message_id',
    'source_webhook_event_id',
    'bot_status_message_id',
    'notification_pending',
    'notification_kind',
    'notification_revision',
    'notification_locked_at',
    'notification_claim_revision',
    'notification_last_ambiguous_revision',
    'notification_dispatch_started_at',
    'callback_id',
    'rule_id',
    'content_revision_id',
    'capture_guard_until',
    'locked_at',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  publisher_auto_reply_authoring_messages: [
    'id',
    'session_id',
    'publisher_bot_id',
    'message_id',
    'kind',
    'stage_revision',
    'created_at',
  ],
  publisher_private_flow_leases: [
    'publisher_bot_id',
    'actor_user_id',
    'flow_id',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  night_mode_transition_reconcile_requests: [
    'chat_id',
    'first_requested_at',
    'requested_at',
    'attempt_count',
    'last_attempt_at',
    'lease_expires_at',
    'manual_blocked_at',
    'manual_blocked_job_id',
    'manual_blocked_ledger_job_id',
    'manual_acknowledged_at',
  ],
  night_mode_transition_scheduled_jobs: [
    'chat_id',
    'job_id',
    'scheduled_for',
    'runtime_version',
    'created_at',
    'updated_at',
  ],
  managed_polls: [
    'id',
    'chat_id',
    'actor_user_id',
    'image_count',
    'status',
    'render_revision',
    'rendered_revision',
    'render_format_version',
    'publication_message_id',
    'publication_bot_id',
    'published_at',
    'closed_at',
    'locked_at',
    'created_at',
    'updated_at',
  ],
  managed_entity_access_edges: [
    'chat_id',
    'user_id',
    'bot_id',
    'state',
    'checked_at',
    'expires_at',
    'last_max_status_code',
    'source',
    'created_at',
    'updated_at',
  ],
  managed_entity_handshake_outcomes: [
    'chat_id',
    'user_id',
    'bot_id',
    'status',
    'source',
    'happened_at',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  publisher_comment_notification_events: [
    'id',
    'bot_id',
    'chat_id',
    'thread_id',
    'author_user_id',
    'reply_to_id',
    'expanded',
    'completed',
    'available_at',
    'created_at',
    'expires_at',
    'locked_until',
  ],
  publisher_comment_notification_deliveries: [
    'id',
    'event_id',
    'user_id',
    'status',
    'attempts',
    'available_at',
    'send_started_at',
    'message_id',
    'updated_at',
  ],
  moderation_delete_intents: [
    'id',
    'chat_id',
    'message_id',
    'subject_user_id',
    'source_message_at',
    'origin_bot_id',
    'retention_owned',
    'suggestion_subscription_id',
    'commercial_ocr_guard_required',
    'commercial_ocr_deadline_at',
    'status',
    'execute_at',
    'next_attempt_at',
    'retry_until_at',
    'attempt_count',
    'last_bot_id',
    'succeeded_bot_id',
    'delete_dispatch_started_at',
    'delete_dispatch_started_bot_id',
    'remote_delete_succeeded_at',
    'remote_delete_succeeded_bot_id',
    'last_status_code',
    'first_attempt_at',
    'last_attempt_at',
    'completed_at',
    'absence_verified_at',
    'absence_verified_bot_id',
    'lease_expires_at',
    'leased_from_status',
    'created_at',
    'updated_at',
  ],
  moderation_delete_intent_reasons: [
    'id',
    'intent_id',
    'user_id',
    'score',
    'moderation_event_id',
    'created_at',
    'updated_at',
  ],
  moderation_rule_followups: [
    'id',
    'intent_id',
    'chat_id',
    'user_id',
    'message_id',
    'source_at',
    'deadline_at',
    'status',
    'next_attempt_at',
    'lease_expires_at',
    'attempt_count',
    'completed_at',
    'created_at',
    'updated_at',
  ],
  webhook_events: [
    'id',
    'semantic_key',
    'execution_deadline_at',
    'bot_id',
    'status',
    'queued_at',
    'enqueue_attempts',
    'next_enqueue_at',
    'timeout_quarantine_expires_at',
    'created_at',
    'processed_at',
  ],
  webhook_execution_claims: [
    'id',
    'kind',
    'semantic_key',
    'business_started_at',
    'webhook_event_id',
    'execution_bot_id',
    'enforced',
    'status',
    'lease_expires_at',
    'prepared_at',
    'completed_at',
    'created_at',
    'updated_at',
  ],
  audit_logs: ['id', 'chat_id', 'actor_user_id', 'action', 'created_at'],
  channel_suggestion_admin_deliveries: [
    'id',
    'audit_log_id',
    'admin_user_id',
    'bot_id',
    'private_chat_id',
    'status',
    'attempt_count',
    'remote_message_id',
    'last_status_code',
    'terminal',
    'sent_at',
    'locked_at',
    'created_at',
    'updated_at',
  ],
  max_action_ledger: [
    'id',
    'job_id',
    'chat_id',
    'bot_id',
    'message_id',
    'user_id',
    'status',
    'ambiguous',
    'terminal',
    'attempt_count',
    'last_status_code',
    'dispatch_started_at',
    'dispatch_bot_id',
    'remote_message_id',
    'enqueued_at',
    'first_attempt_at',
    'last_attempt_at',
    'completed_at',
    'created_at',
    'updated_at',
  ],
  channel_auto_post_attach_markers: [
    'id',
    'chat_id',
    'message_id',
    'status',
    'locked_at',
    'bot_id',
    'source',
    'delivery_mode',
    'replacement_message_id',
    'reply_message_id',
    'original_deleted',
    'cleanup_intent_id',
    'replacement_send_started_at',
    'last_status_code',
    'created_at',
    'updated_at',
  ],
  chat_auto_comment_attach_markers: [
    'id',
    'chat_id',
    'message_id',
    'status',
    'locked_at',
    'bot_id',
    'source',
    'delivery_mode',
    'replacement_message_id',
    'reply_message_id',
    'original_deleted',
    'cleanup_intent_id',
    'replacement_send_started_at',
    'last_status_code',
    'created_at',
    'updated_at',
  ],
  publications: [
    'id',
    'actor_user_id',
    'request_id',
    'canonical_content_revision_id',
    'legacy_broadcast_id',
    'legacy_autopost_rule_id',
    'required_bot_id',
    'version',
    'created_at',
    'updated_at',
  ],
  publisher_post_import_sessions: [
    'id',
    'publisher_bot_id',
    'actor_user_id',
    'request_id',
    'status',
    'private_chat_id',
    'incoming_message_id',
    'source_webhook_event_id',
    'bot_status_message_id',
    'notification_kind',
    'notification_pending',
    'notification_locked_at',
    'notification_dispatch_started_at',
    'callback_id',
    'publication_id',
    'captured_at',
    'capture_guard_until',
    'locked_at',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  publication_assets: ['id', 'actor_user_id', 'size_bytes', 'created_at'],
  publication_schedules: [
    'id',
    'publication_id',
    'revision',
    'status',
    'next_materialize_at',
    'last_materialized_at',
    'created_at',
    'updated_at',
  ],
  publication_occurrences: [
    'id',
    'publication_id',
    'schedule_id',
    'content_revision_id',
    'schedule_revision',
    'scheduled_at',
    'status',
    'legacy_broadcast_id',
    'required_bot_id',
    'dispatch_blocked_at',
    'dispatch_first_blocked_at',
    'retry_authorized_at',
    'access_preflight_position',
    'access_preflight_cycle_started_at',
    'access_preflight_last_completed_at',
    'created_at',
    'updated_at',
  ],
  managed_broadcasts: [
    'id',
    'source_chat_id',
    'actor_user_id',
    'apply_to_all_chats',
    'button_enabled',
    'image_enabled',
    'schedule_mode',
    'next_send_at',
    'cycle_enabled',
    'cycle_every_hours',
    'cycle_count',
    'sent_count',
    'status',
    'locked_at',
    'publication_occurrence_id',
    'publication_content_revision_id',
    'required_bot_id',
    'created_at',
    'updated_at',
  ],
  managed_autopost_rules: [
    'id',
    'source_chat_id',
    'actor_user_id',
    'status',
    'revision',
    'next_materialize_at',
    'last_materialized_at',
    'locked_at',
    'created_at',
    'updated_at',
  ],
  managed_autopost_materializations: [
    'id',
    'rule_id',
    'broadcast_id',
    'revision',
    'attempt',
    'request_id',
    'scheduled_at',
    'status',
    'created_at',
    'updated_at',
  ],
  managed_broadcast_occurrences: [
    'id',
    'broadcast_id',
    'source_chat_id',
    'occurrence_index',
    'scheduled_at',
    'status',
    'created_at',
    'updated_at',
  ],
  managed_broadcast_deliveries: [
    'id',
    'broadcast_id',
    'occurrence_index',
    'target_chat_id',
    'bot_id',
    'status',
    'attempt_count',
    'remote_message_id',
    'remote_message_verified_at',
    'remote_message_verification_attempt_count',
    'remote_message_verification_absent_count',
    'remote_message_verification_present_count',
    'remote_message_verification_attempted_at',
    'remote_message_verification_next_at',
    'legacy_sent_without_remote_id',
    'sent_at',
    'post_actions_next_at',
    'subscription_delete_id',
    'pin_status',
    'pin_attempt_count',
    'delete_status',
    'delete_at',
    'deleted_at',
    'delete_attempt_count',
    'locked_at',
    'publication_occurrence_id',
    'content_revision_id',
    'required_bot_id',
    'dialog_bot_id',
    'publication_policy_revision',
    'dispatch_blocked_at',
    'created_at',
    'updated_at',
  ],
  vk_parsing_sources: [
    'id',
    'chat_id',
    'owner_bot_id',
    'owner_id',
    'wall_owner_id',
    'status',
    'import_enabled',
    'auto_publish_enabled',
    'auto_publish_enabled_at',
    'auto_publish_paused_at',
    'publish_interval_minutes',
    'daily_limit',
    'min_publish_interval_minutes',
    'publish_mode',
    'bot_review_enabled_at',
    'last_auto_published_at',
    'next_sync_at',
    'last_sync_at',
    'last_success_at',
    'sync_started_at',
    'sync_locked_at',
    'sync_lock_deadline_at',
    'sync_heartbeat_at',
    'sync_attempt_count',
    'consecutive_failures',
    'terminal_failure_count',
    'circuit_opened_at',
    'circuit_retry_at',
    'last_imported_count',
    'last_fetched_count',
    'last_fetched_pages',
    'last_vk_newest_post_id',
    'last_vk_newest_published_at',
    'adaptive_interval_ms',
    'last_sync_duration_ms',
    'created_by_user_id',
    'created_at',
    'updated_at',
  ],
  vk_parsing_posts: [
    'id',
    'source_id',
    'chat_id',
    'owner_bot_id',
    'vk_owner_id',
    'vk_post_id',
    'vk_published_at',
    'manual_content_edited_at',
    'has_unsupported_attachments',
    'is_advertising',
    'status',
    'published_message_id',
    'published_at_max',
    'auto_published_at',
    'skipped_at',
    'last_seen_at',
    'missing_since_at',
    'missing_seen_count',
    'last_availability_checked_at',
    'unavailable_at',
    'publish_queued_at',
    'publish_scheduled_at',
    'publish_cancelled_at',
    'publish_cancelled_by_user_id',
    'publish_locked_at',
    'publish_attempt_count',
    'required_bot_id',
    'dialog_bot_id',
    'publication_policy_revision',
    'publish_actor_user_id',
    'published_bot_id',
    'dispatch_blocked_at',
    'rollback_queued_at',
    'rollback_locked_at',
    'rollback_deleted_at',
    'rollback_attempt_count',
    'created_at',
    'updated_at',
  ],
  vk_bot_review_inboxes: ['bot_id', 'user_id', 'private_chat_id', 'confirmed_at'],
  vk_bot_reviews: [
    'id',
    'post_id',
    'recipient_user_id',
    'revision',
    'status',
    'private_chat_id',
    'content_message_id',
    'control_message_id',
    'attempt_started_at',
    'next_attempt_at',
    'decided_at',
    'decided_by_user_id',
    'created_at',
    'updated_at',
  ],
  vk_parsing_media_cache: [
    'id',
    'status',
    'content_length',
    'max_uploaded_at',
    'upload_attempt_count',
    'last_checked_at',
    'created_at',
    'updated_at',
  ],
  managed_giveaways: [
    'id',
    'source_chat_id',
    'actor_user_id',
    'image_enabled',
    'starts_at',
    'ends_at',
    'claim_hours',
    'status',
    'publication_message_id',
    'publication_bot_id',
    'published_at',
    'results_message_id',
    'results_bot_id',
    'drawn_at',
    'completed_at',
    'canceled_at',
    'locked_at',
    'created_at',
    'updated_at',
  ],
  managed_giveaway_winners: [
    'id',
    'giveaway_id',
    'prize_id',
    'entry_id',
    'rank',
    'status',
    'selected_at',
    'claim_deadline_at',
    'claimed_at',
    'delivered_at',
    'expired_at',
    'rerolled_at',
    'created_at',
    'updated_at',
  ],
  managed_giveaway_winner_notifications: [
    'id',
    'winner_id',
    'status',
    'next_attempt_at',
    'attempt_count',
    'locked_at',
    'dispatched_at',
    'bot_id',
    'remote_message_id',
    'sent_at',
    'ambiguous_at',
    'created_at',
    'updated_at',
  ],
  message_retention_policies: [
    'chat_id',
    'enabled',
    'hours',
    'revision',
    'activation_id',
    'enabled_at',
    'capture_after',
    'paused_at',
    'healthy_since',
    'quota_shard',
    'pending_count',
    'deleted_count',
    'skipped_count',
    'next_run_at',
    'created_at',
    'updated_at',
  ],
  message_retention_candidates: [
    'chat_id',
    'message_id',
    'author_id',
    'origin_bot_id',
    'source_at',
    'activation_id',
    'shadow_only',
    'status',
    'next_attempt_at',
    'intent_id',
    'completed_at',
    'reconcile_after',
    'created_at',
  ],
  publisher_start_intents: [
    'id',
    'publisher_bot_id',
    'private_chat_id',
    'requested_at',
    'expires_at',
    'next_enqueue_at',
    'status',
    'updated_at',
  ],
});

export type Allowance = Readonly<{
  pages: number;
  rows: number;
  probes: number;
  bytes: number;
  deadlineAtMs: number;
}>;
export type LegacyRecoveryLiveSqlResult = Readonly<{
  selectedOwners: LegacyRecoveryLiveOutput['selectedOwners'];
  // FLAG: Exact full snapshots are internal installer input, never public output.
  candidates: readonly LegacyRecoveryCandidate[];
  proofs: readonly LegacyRecoveryLivePlanProof[];
  stableDigest: string;
  cost: LegacyRecoveryLiveOutput['cost'];
  issues: readonly LegacyRecoveryLiveIssue[];
}>;

type Database = Pick<Prisma.TransactionClient, '$queryRaw'>;
type Metadata = Record<string, string | null> & { _truncated?: never };
type Page = { rows: unknown; count: number; oversize: boolean; bytes: number };
type PlanNode = Record<string, unknown>;
const PAGE_ROWS = 16;
const PAGE_BYTES = 64 * 1024;
const PLAN_BYTES = 64 * 1024;
const FULL_ROW_BYTES = 384 * 1024;
const SCALAR_BYTES = 512;
const MIGRATION_CATALOG_MAX_BYTES = 1024 * 1024;

type SelectedLookup = Readonly<{
  table: string | null;
  schema: 'public' | 'pg_catalog' | null;
  equality: readonly string[];
  maxReturnedRows: number;
  metadataRows?: number;
  actionTypeSeek?: 'first' | 'next';
}>;

class Refused extends Error {
  constructor(
    readonly code: string,
    readonly descriptor: string,
  ) {
    super(code);
  }
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function quantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Refused('sql_plan_unproved', 'sql:plan');
  return value;
}
function identifier(value: string): Prisma.Sql {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Refused('sql_catalog_unproved', 'sql:catalog');
  return Prisma.raw(`"${value}"`);
}

// FLAG: An ordered primary-key scan with a semantic Filter still scans global
// history. Require equality on the actual requested scope inside Index/Recheck Cond.
export function admitLegacyRecoveryHistoryPlan(
  value: unknown,
  scope: 'id' | 'semantic_key',
): string[] {
  const root = Array.isArray(value) && value.length === 1 ? object(object(value[0])?.Plan) : null;
  if (!root) throw new Refused('sql_plan_unproved', 'sql:plan');
  const indexes = new Set<string>();
  let nodes = 0;
  const bound = (condition: unknown): boolean => {
    if (typeof condition !== 'string' || /\\|\bE'/u.test(condition)) return false;
    const syntax = condition.replace(/'(?:[^']|'')*'/gu, '?');
    if (/\bOR\b/u.test(syntax)) return false;
    return new RegExp(`(?:\\b${scope}\\b|"${scope}")\\s*=`, 'u').test(syntax);
  };
  const inspect = (node: PlanNode, depth: number, bitmapHistory = false): void => {
    if (++nodes > 128 || depth > 32 || typeof node['Node Type'] !== 'string')
      throw new Refused('sql_plan_unproved', 'sql:plan');
    const history = ['webhook_events', 'webhook_execution_claims'].includes(
      String(node['Relation Name']),
    );
    if (history) {
      const indexScan = ['Index Scan', 'Index Only Scan'].includes(node['Node Type']);
      const bitmapHeap = node['Node Type'] === 'Bitmap Heap Scan';
      if (
        (!indexScan && !bitmapHeap) ||
        !bound(indexScan ? node['Index Cond'] : node['Recheck Cond'])
      )
        throw new Refused('sql_history_scan_refused', 'sql:plan');
    }
    if (
      (history || bitmapHistory) &&
      node['Node Type'] === 'Bitmap Index Scan' &&
      !bound(node['Index Cond'])
    )
      throw new Refused('sql_history_scan_refused', 'sql:plan');
    if ((history || bitmapHistory) && typeof node['Index Name'] === 'string')
      indexes.add(node['Index Name']);
    const children = node.Plans ?? [];
    if (!Array.isArray(children)) throw new Refused('sql_plan_unproved', 'sql:plan');
    for (const child of children) {
      const nested = object(child);
      if (!nested) throw new Refused('sql_plan_unproved', 'sql:plan');
      inspect(
        nested,
        depth + 1,
        bitmapHistory || (history && node['Node Type'] === 'Bitmap Heap Scan'),
      );
    }
  };
  inspect(root, 0);
  return [...indexes].sort();
}

// FLAG: Selected production reads admit actual equality predicates, never a Filter
// over a broad index. The sole table-scan exception is the size-proved public
// migration catalog; estimates are explicitly planning evidence, not measured work.
function admitSelectedPlan(
  value: unknown,
  lookup: SelectedLookup,
): { indexes: string[]; estimatedRows: number } {
  const root = Array.isArray(value) && value.length === 1 ? object(object(value[0])?.Plan) : null;
  if (!root) throw new Refused('sql_plan_unproved', 'sql:plan');
  const indexes = new Set<string>();
  let nodes = 0;
  let scans = 0;
  let estimatedRows = 0;
  const bound = (condition: unknown): boolean => {
    if (typeof condition !== 'string' || /\\|\bE'/u.test(condition)) return false;
    const syntax = condition.replace(/'(?:[^']|'')*'/gu, '?');
    if (/\bOR\b/u.test(syntax)) return false;
    if (/\bNOT\b/u.test(syntax)) return false;
    return lookup.equality.every((column) =>
      new RegExp(`(?:\\b${column}\\b|"${column}")\\s*=`, 'u').test(syntax),
    );
  };
  const walk = (node: PlanNode, depth: number, bitmap = false): void => {
    if (++nodes > 128 || depth > 32 || typeof node['Node Type'] !== 'string')
      throw new Refused('sql_plan_unproved', 'sql:plan');
    if (
      lookup.actionTypeSeek &&
      ['Sort', 'Incremental Sort', 'Bitmap Heap Scan'].includes(node['Node Type'])
    )
      throw new Refused('sql_selected_scan_refused', 'sql:plan');
    const relation = node['Relation Name'];
    if (
      node['Node Type'].includes('Scan') &&
      relation === undefined &&
      !['CTE Scan', 'Bitmap Index Scan'].includes(node['Node Type'])
    )
      throw new Refused('sql_selected_scan_refused', 'sql:plan');
    if (relation !== undefined) {
      scans += 1;
      if (relation !== lookup.table || node.Schema !== lookup.schema)
        throw new Refused('sql_selected_scan_refused', 'sql:plan');
      const indexed = ['Index Scan', 'Index Only Scan'].includes(node['Node Type']);
      const heap = node['Node Type'] === 'Bitmap Heap Scan';
      if (
        lookup.actionTypeSeek &&
        (![
          'max_action_ledger_chat_action_updated_idx',
          'max_action_ledger_delete_owner_lookup_idx',
        ].includes(String(node['Index Name'])) ||
          (lookup.actionTypeSeek === 'next' &&
            !/\baction_type\s*>/u.test(String(node['Index Cond']))))
      )
        throw new Refused('sql_selected_scan_refused', 'sql:plan');
      if (
        lookup.table !== '_prisma_migrations' &&
        ((!indexed && !heap) || !bound(indexed ? node['Index Cond'] : node['Recheck Cond']))
      )
        throw new Refused('sql_selected_scan_refused', 'sql:plan');
      if (
        lookup.table === '_prisma_migrations' &&
        !['Seq Scan', 'Index Scan', 'Index Only Scan'].includes(node['Node Type'])
      )
        throw new Refused('sql_selected_scan_refused', 'sql:plan');
    }
    if (bitmap && node['Node Type'] === 'Bitmap Index Scan' && !bound(node['Index Cond']))
      throw new Refused('sql_selected_scan_refused', 'sql:plan');
    if (typeof node['Index Name'] === 'string') indexes.add(node['Index Name']);
    const children = node.Plans ?? [];
    if (!Array.isArray(children)) throw new Refused('sql_plan_unproved', 'sql:plan');
    if (children.length === 0) estimatedRows += Math.ceil(quantity(node['Plan Rows']));
    for (const child of children) {
      const nested = object(child);
      if (!nested) throw new Refused('sql_plan_unproved', 'sql:plan');
      walk(nested, depth + 1, bitmap || node['Node Type'] === 'Bitmap Heap Scan');
    }
  };
  walk(root, 0);
  if ((lookup.table !== null && scans !== 1) || (lookup.table === null && scans !== 0))
    throw new Refused('sql_selected_scan_refused', 'sql:plan');
  return { indexes: [...indexes].sort(), estimatedRows };
}

// FLAG: Count executed leaf work and filter/recheck work, including subplan loops.
// LIMIT, index labels and estimated costs never substitute for measured work.
export function measureLegacyRecoverySqlPlan(value: unknown): {
  indexes: string[];
  returnedRows: number;
  examinedRows: number;
  probes: number;
  bufferBytes: number;
} {
  if (!Array.isArray(value) || value.length !== 1)
    throw new Refused('sql_plan_unproved', 'sql:plan');
  const root = object(object(value[0])?.Plan);
  if (!root) throw new Refused('sql_plan_unproved', 'sql:plan');
  const indexes = new Set<string>();
  let examinedRows = 0;
  let probes = 0;
  let nodes = 0;
  const visit = (node: PlanNode, depth: number): void => {
    if (++nodes > 128 || depth > 32 || typeof node['Node Type'] !== 'string')
      throw new Refused('sql_plan_unproved', 'sql:plan');
    const loops = quantity(node['Actual Loops']);
    const rows = quantity(node['Actual Rows']);
    const children = node.Plans ?? [];
    if (!Array.isArray(children)) throw new Refused('sql_plan_unproved', 'sql:plan');
    const removed =
      quantity(node['Rows Removed by Filter'] ?? 0) +
      quantity(node['Rows Removed by Join Filter'] ?? 0) +
      quantity(node['Rows Removed by Index Recheck'] ?? 0);
    examinedRows += (removed + (children.length === 0 ? rows : 0)) * loops;
    if (node['Node Type'].includes('Scan') || children.length === 0) probes += loops;
    if (typeof node['Index Name'] === 'string') indexes.add(node['Index Name']);
    for (const child of children) {
      const nested = object(child);
      if (!nested) throw new Refused('sql_plan_unproved', 'sql:plan');
      visit(nested, depth + 1);
    }
  };
  visit(root, 0);
  // Buffers are inclusive at ancestors. Charge the root once, including planning.
  const bufferKeys = [
    'Shared Hit Blocks',
    'Shared Read Blocks',
    'Shared Dirtied Blocks',
    'Shared Written Blocks',
    'Local Hit Blocks',
    'Local Read Blocks',
    'Local Dirtied Blocks',
    'Local Written Blocks',
    'Temp Read Blocks',
    'Temp Written Blocks',
  ];
  let blocks = 0;
  for (const row of [root, object(object(value[0])?.Planning) ?? {}])
    for (const key of bufferKeys) blocks += quantity(row[key] ?? 0);
  return {
    indexes: [...indexes].sort(),
    returnedRows: Math.ceil(quantity(root['Actual Rows']) * quantity(root['Actual Loops'])),
    examinedRows: Math.ceil(examinedRows),
    probes: Math.ceil(probes),
    bufferBytes: Math.ceil(blocks * 8192),
  };
}

class Meter {
  readonly cost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
  readonly proofs: LegacyRecoveryLivePlanProof[] = [];
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  constructor(
    readonly tx: Database,
    readonly allowance: Allowance,
    readonly measured: boolean,
  ) {}
  check(descriptor: string): void {
    if (Date.now() >= this.allowance.deadlineAtMs)
      throw new Refused('sql_deadline_exceeded', descriptor);
    for (const key of ['pages', 'rows', 'probes', 'bytes'] as const)
      if (!Number.isSafeInteger(this.cost[key]) || this.cost[key] > this.allowance[key])
        throw new Refused('sql_budget_exceeded', descriptor);
  }
  read<T>(descriptor: string, statement: Prisma.Sql): Promise<T[]> {
    const pending = this.tail.then(() => this.performRead<T>(descriptor, statement));
    this.tail = pending.then(
      () => undefined,
      () => {
        this.failed = true;
      },
    );
    return pending;
  }
  async drain(): Promise<void> {
    await this.tail;
  }
  private async performRead<T>(descriptor: string, statement: Prisma.Sql): Promise<T[]> {
    if (this.failed) throw new Refused('sql_inventory_query_failed', descriptor);
    if (!this.measured) return this.performSelectedRead<T>(descriptor, statement);
    this.check(descriptor);
    if (this.cost.pages + 2 > this.allowance.pages)
      throw new Refused('sql_budget_exceeded', descriptor);
    // FLAG: Exact predicates alone do not prevent a global history scan. Before any
    // receipt/claim read executes, reject a plan that scans those histories sequentially.
    if (/"webhook_(?:events|execution_claims)"/u.test(statement.sql)) {
      if (this.cost.pages + 3 > this.allowance.pages)
        throw new Refused('sql_budget_exceeded', descriptor);
      const planning = await this.tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${statement}`,
      );
      this.cost.pages += 1;
      const plan = planning[0]?.['QUERY PLAN'];
      this.cost.bytes += Buffer.byteLength(JSON.stringify(plan) ?? '');
      this.check(descriptor);
      const root = Array.isArray(plan) && plan.length === 1 ? object(object(plan[0])?.Plan) : null;
      if (!root || Buffer.byteLength(JSON.stringify(plan) ?? '') > PLAN_BYTES)
        throw new Refused('sql_plan_unproved', descriptor);
      let indexes: string[];
      try {
        indexes = admitLegacyRecoveryHistoryPlan(
          plan,
          statement.sql.includes('"semantic_key" =') ? 'semantic_key' : 'id',
        );
      } catch (error) {
        if (error instanceof Refused) throw new Refused(error.code, descriptor);
        throw error;
      }
      this.proofs.push({
        descriptor: `${descriptor}:planning`,
        querySha256: legacyRecoveryLiveDigest({ sql: statement.sql, values: statement.values }),
        planSha256: legacyRecoveryLiveDigest(plan),
        indexes,
        returnedRows: 0,
        examinedRows: 0,
        probes: 0,
      });
    }
    // FLAG: EXPLAIN ANALYZE executes this read. The subsequent identical read uses
    // the same frozen snapshot; charge measured row/probe/I/O work twice, plus both replies.
    const explained = await this.tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
    );
    this.cost.pages += 1;
    const plan = explained[0]?.['QUERY PLAN'];
    const planBytes = Buffer.byteLength(JSON.stringify(plan) ?? '');
    if (planBytes > PLAN_BYTES) throw new Refused('sql_plan_reply_oversize', descriptor);
    const measured = measureLegacyRecoverySqlPlan(plan);
    this.cost.rows += measured.examinedRows * 2;
    this.cost.probes += measured.probes * 2;
    this.cost.bytes += measured.bufferBytes * 2 + planBytes;
    this.proofs.push({
      descriptor,
      querySha256: legacyRecoveryLiveDigest({ sql: statement.sql, values: statement.values }),
      planSha256: legacyRecoveryLiveDigest(plan),
      indexes: measured.indexes,
      returnedRows: measured.returnedRows,
      examinedRows: measured.examinedRows,
      probes: measured.probes,
    });
    this.check(descriptor);
    const rows = await this.tx.$queryRaw<T[]>(statement);
    this.cost.pages += 1;
    this.cost.bytes += Buffer.byteLength(JSON.stringify(rows));
    this.check(descriptor);
    return rows;
  }

  // FLAG: Production cost records returned scalar/metadata rows, database round
  // trips and serialized replies. Plain planning never proves physical I/O work.
  private async performSelectedRead<T>(descriptor: string, statement: Prisma.Sql): Promise<T[]> {
    this.check(descriptor);
    if (this.cost.pages + 2 > this.allowance.pages)
      throw new Refused('sql_budget_exceeded', descriptor);
    const normalized = statement.sql.trim().replace(/\s+/gu, ' ');
    let lookup: SelectedLookup;
    if (descriptor === 'sql:snapshot') {
      lookup = { table: null, schema: null, equality: [], maxReturnedRows: 1 };
    } else if (descriptor === 'sql:migrations-catalog-proof') {
      lookup = { table: 'pg_class', schema: 'pg_catalog', equality: ['oid'], maxReturnedRows: 1 };
    } else if (
      normalized ===
      "SELECT finished_at AS at FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences' AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1"
    ) {
      const catalog = await this.performSelectedRead<{
        schema: string;
        name: string;
        kind: string;
        totalBytes: string;
      }>(
        'sql:migrations-catalog-proof',
        Prisma.sql`
        SELECT c.relnamespace::regnamespace::text AS schema, c.relname AS name,
          c.relkind::text AS kind, pg_catalog.pg_total_relation_size(c.oid)::text AS "totalBytes"
        FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass('public._prisma_migrations') LIMIT 1`,
      );
      const proof = catalog[0];
      if (
        catalog.length !== 1 ||
        proof?.schema !== 'public' ||
        proof.name !== '_prisma_migrations' ||
        proof.kind !== 'r' ||
        !/^\d+$/u.test(proof.totalBytes) ||
        BigInt(proof.totalBytes) > BigInt(MIGRATION_CATALOG_MAX_BYTES)
      )
        throw new Refused('sql_migration_catalog_unproved', descriptor);
      statement = Prisma.sql`
        SELECT finished_at AS at FROM public._prisma_migrations
        WHERE migration_name = '20261005020000_add_multibot_order_fences'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1`;
      lookup = { table: '_prisma_migrations', schema: 'public', equality: [], maxReturnedRows: 1 };
    } else {
      const tables = [
        ...normalized.matchAll(/\bFROM\s+(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))/giu),
      ]
        .map((match) => match[1] ?? match[2])
        .filter((table) => !['page', 'sized'].includes(table!));
      const table = tables[0];
      if (tables.length !== 1 || !table)
        throw new Refused('sql_selected_lookup_unproved', descriptor);
      const equality =
        table === 'webhook_events'
          ? [normalized.includes('"semantic_key" =') ? 'semantic_key' : 'id']
          : table === 'webhook_execution_claims'
            ? ['kind', 'semantic_key']
            : table === 'chat_settings'
              ? ['chat_id']
              : table === 'max_action_ledger'
                ? descriptor.startsWith('sql:action-types:')
                  ? ['chat_id']
                  : ['chat_id', 'action_type', 'message_id']
                : table === 'moderation_delete_intents'
                  ? ['chat_id', 'message_id']
                  : null;
      if (!equality) throw new Refused('sql_selected_lookup_unproved', descriptor);
      lookup = {
        table,
        schema: 'public',
        equality,
        maxReturnedRows: 1,
        ...(normalized.startsWith('WITH page AS MATERIALIZED') ? { metadataRows: PAGE_ROWS } : {}),
        ...(descriptor === 'sql:action-types:first' || descriptor === 'sql:action-types:last'
          ? { actionTypeSeek: 'first' as const }
          : descriptor === 'sql:action-types:next'
            ? { actionTypeSeek: 'next' as const }
            : {}),
      };
    }
    this.check(descriptor);
    if (this.cost.pages + 2 > this.allowance.pages)
      throw new Refused('sql_budget_exceeded', descriptor);
    const planning = await this.tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (VERBOSE, FORMAT JSON) ${statement}`,
    );
    this.cost.pages += 1;
    this.cost.probes += 1;
    const plan = planning[0]?.['QUERY PLAN'];
    const planBytes = Buffer.byteLength(JSON.stringify(plan) ?? '');
    this.cost.bytes += planBytes;
    if (planning.length !== 1 || planBytes > PLAN_BYTES)
      throw new Refused('sql_plan_reply_oversize', descriptor);
    let admitted: ReturnType<typeof admitSelectedPlan>;
    try {
      admitted = admitSelectedPlan(plan, lookup);
    } catch (error) {
      if (error instanceof Refused) throw new Refused(error.code, descriptor);
      throw error;
    }
    this.proofs.push({
      descriptor: `${descriptor}:bounded-planning`,
      querySha256: legacyRecoveryLiveDigest({ sql: statement.sql, values: statement.values }),
      planSha256: legacyRecoveryLiveDigest(plan),
      indexes: admitted.indexes,
      returnedRows: 0,
      examinedRows: admitted.estimatedRows,
      probes: 0,
    });
    this.check(descriptor);
    const rows = await this.tx.$queryRaw<T[]>(statement);
    this.cost.pages += 1;
    this.cost.probes += 1;
    this.cost.rows += rows.length;
    this.cost.bytes += Buffer.byteLength(JSON.stringify(rows));
    if (rows.length > lookup.maxReturnedRows)
      throw new Refused('sql_selected_reply_unproved', descriptor);
    if (lookup.metadataRows !== undefined) {
      for (const row of rows) {
        const count = object(row)?.count;
        if (
          !Number.isSafeInteger(count) ||
          (count as number) < 0 ||
          (count as number) > lookup.metadataRows
        )
          throw new Refused('sql_selected_reply_unproved', descriptor);
        this.cost.rows += count as number;
      }
    }
    this.proofs.push({
      descriptor: `${descriptor}:returned`,
      querySha256: legacyRecoveryLiveDigest({ sql: statement.sql, values: statement.values }),
      planSha256: legacyRecoveryLiveDigest({ mode: 'bounded-select', returnedRows: rows.length }),
      indexes: admitted.indexes,
      returnedRows: rows.length,
      examinedRows: 0,
      probes: 1,
    });
    this.check(descriptor);
    return rows;
  }
}

function hydrate(value: unknown): Record<string, unknown> | null {
  const row = object(value);
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row).map(([key, val]) => [
      key.replace(/_([a-z])/gu, (_all, next: string) => next.toUpperCase()),
      key.endsWith('_at') && typeof val === 'string' ? new Date(`${val.replace(/Z$/u, '')}Z`) : val,
    ]),
  );
}

async function exactRow(
  meter: Meter,
  descriptor: string,
  table: string,
  where: Prisma.Sql,
): Promise<Record<string, unknown> | null> {
  const rows = await meter.read<{ row: unknown; oversize: boolean }>(
    descriptor,
    Prisma.sql`
    SELECT CASE WHEN octet_length(to_jsonb(t)::text) <= ${FULL_ROW_BYTES}
      THEN to_jsonb(t) ELSE NULL END AS row,
      octet_length(to_jsonb(t)::text) > ${FULL_ROW_BYTES} AS oversize
    FROM ${identifier(table)} t WHERE ${where} LIMIT 1`,
  );
  if (rows[0]?.oversize) throw new Refused('sql_source_payload_oversize', descriptor);
  return hydrate(rows[0]?.row);
}

// FLAG: The existing candidate inspector keeps every source/command/cutoff fence.
// Its finite reads use this metered facade; no unmeasured Prisma delegate is reachable.
function candidateReader(meter: Meter): Prisma.TransactionClient {
  return {
    $queryRaw: (statement: Prisma.Sql) => meter.read('sql:owner-inspection', statement),
    webhookEvent: {
      findUnique: ({ where }: { where: { id: string } }) =>
        exactRow(meter, 'sql:webhook_events', 'webhook_events', Prisma.sql`t."id" = ${where.id}`),
    },
    webhookExecutionClaim: {
      findUnique: ({
        where,
      }: {
        where: { kind_semanticKey: { kind: string; semanticKey: string } };
      }) =>
        exactRow(
          meter,
          'sql:webhook_execution_claims',
          'webhook_execution_claims',
          Prisma.sql`
          t."kind" = ${where.kind_semanticKey.kind} AND t."semantic_key" = ${where.kind_semanticKey.semanticKey}`,
        ),
    },
    moderationDeleteIntent: {
      findFirst: ({ where }: { where: { chatId: string; messageId: string } }) =>
        exactIdentity(meter, 'moderation_delete_intents', where),
    },
    maxActionLedgerEntry: {
      findFirst: ({ where }: { where: { chatId: string; messageId: string } }) =>
        exactActionIdentity(meter, where),
    },
    chatSettings: {
      findUnique: ({ where }: { where: { chatId: string } }) =>
        exactRow(
          meter,
          'sql:owner-settings',
          'chat_settings',
          Prisma.sql`t."chat_id" = ${where.chatId}`,
        ),
    },
  } as unknown as Prisma.TransactionClient;
}
async function exactIdentity(
  meter: Meter,
  table: string,
  where: { chatId: string; messageId: string },
) {
  const rows = await meter.read<{ present: boolean }>(
    `sql:${table}`,
    Prisma.sql`
    SELECT TRUE AS present FROM ${identifier(table)}
    WHERE "chat_id" = ${where.chatId} AND "message_id" = ${where.messageId}
    LIMIT 1`,
  );
  return rows[0] ?? null;
}

// FLAG: The ledger index is (chat, action type, message, status). Seek each actual
// stored type, including unknown historical types, then probe the complete key.
// A cap refuses recovery instead of treating an unvisited type as absent.
async function exactActionIdentity(meter: Meter, where: { chatId: string; messageId: string }) {
  const last = await meter.read<{ actionType: string; oversize: boolean }>(
    'sql:action-types:last',
    Prisma.sql`
    SELECT left("action_type", ${SCALAR_BYTES}) AS "actionType",
      octet_length("action_type") > ${SCALAR_BYTES} AS oversize
    FROM "max_action_ledger" WHERE "chat_id" = ${where.chatId}
    ORDER BY "action_type" DESC, "updated_at" DESC LIMIT 1`,
  );
  if (!last.length) return null;
  if (last.length !== 1 || last[0]!.oversize || typeof last[0]!.actionType !== 'string')
    throw new Refused('sql_action_types_unproved', 'sql:max_action_ledger');
  let cursor: string | null = null;
  for (let index = 0; index <= 32; index += 1) {
    const types: Array<{ actionType: string; oversize: boolean }> = await meter.read(
      cursor === null ? 'sql:action-types:first' : 'sql:action-types:next',
      Prisma.sql`SELECT left("action_type", ${SCALAR_BYTES}) AS "actionType",
        octet_length("action_type") > ${SCALAR_BYTES} AS oversize
        FROM "max_action_ledger" WHERE "chat_id" = ${where.chatId}
        ${cursor === null ? Prisma.empty : Prisma.sql`AND "action_type" > ${cursor}`}
        ORDER BY "action_type", "updated_at" LIMIT 1`,
    );
    if (!types.length) throw new Refused('sql_action_types_unproved', 'sql:max_action_ledger');
    const type = types[0]!;
    if (
      index === 32 ||
      types.length !== 1 ||
      type.oversize ||
      typeof type.actionType !== 'string' ||
      type.actionType === cursor
    )
      throw new Refused('sql_action_types_unproved', 'sql:max_action_ledger');
    const rows = await meter.read<{ present: boolean }>(
      'sql:max_action_ledger',
      Prisma.sql`
      SELECT TRUE AS present FROM "max_action_ledger" WHERE "chat_id" = ${where.chatId}
        AND "action_type" = ${type.actionType} AND "message_id" = ${where.messageId} LIMIT 1`,
    );
    if (rows.length) return rows[0];
    if (type.actionType === last[0]!.actionType) return null;
    cursor = type.actionType;
  }
  throw new Refused('sql_action_types_unproved', 'sql:max_action_ledger');
}

function primaryKeys(table: string): readonly string[] {
  const keys = (LEGACY_RECOVERY_SQL_PRIMARY_KEYS as Readonly<Record<string, readonly string[]>>)[
    table
  ];
  if (!keys?.length) throw new Refused('sql_catalog_unproved', `sql:${table}`);
  return keys;
}
function metadataProjection(table: string): Prisma.Sql {
  const fields = metadataColumns[table];
  if (!fields?.length || primaryKeys(table).some((key) => !fields.includes(key)))
    throw new Refused('sql_catalog_unproved', `sql:${table}`);
  return Prisma.join([
    ...fields.map(
      (field) =>
        Prisma.sql`left(${identifier(field)}::text, ${SCALAR_BYTES}) AS ${identifier(field)}`,
    ),
    Prisma.sql`COALESCE((${Prisma.join(
      fields.map((field) => Prisma.sql`octet_length(${identifier(field)}::text) > ${SCALAR_BYTES}`),
      ' OR ',
    )}), FALSE) AS "_truncated"`,
  ]);
}
function keyset(table: string, cursor: Metadata | null): Prisma.Sql {
  if (!cursor) return Prisma.sql`TRUE`;
  const keys = primaryKeys(table);
  return Prisma.sql`(${Prisma.join(keys.map(identifier))}) > (${Prisma.join(
    keys.map((key) => {
      const value = cursor[key];
      if (!value || Buffer.byteLength(value) > SCALAR_BYTES)
        throw new Refused('sql_cursor_unproved', `sql:${table}`);
      return table === 'publisher_access_refresh_obligations' &&
        ['proof_checked_at', 'required_before'].includes(key)
        ? Prisma.sql`${value}::timestamp`
        : Prisma.sql`${value}::text`;
    }),
  )})`;
}

async function metadataPage(
  meter: Meter,
  table: string,
  cursor: Metadata | null,
  scope: Prisma.Sql = Prisma.sql`TRUE`,
): Promise<Metadata[]> {
  const order = Prisma.join(primaryKeys(table).map(identifier));
  // FLAG: Server caps apply before the metadata JSON leaves PostgreSQL. Full tables
  // are exhausted through literal PK keysets; future, unknown and terminal continuation
  // rows are all visited. An omitted/truncated row is DENY, never an empty page.
  const rows = await meter.read<Page>(
    `sql:${table}`,
    Prisma.sql`
    WITH page AS MATERIALIZED (
      SELECT ${metadataProjection(table)} FROM ${identifier(table)}
      WHERE ${scope} AND ${keyset(table, cursor)} ORDER BY ${order} LIMIT ${PAGE_ROWS}
    ), sized AS MATERIALIZED (
      SELECT to_jsonb(page) AS value, octet_length(to_jsonb(page)::text) AS bytes,
        COALESCE(page."_truncated", FALSE) AS truncated FROM page
    ) SELECT CASE WHEN COALESCE(sum(bytes), 0) <= ${PAGE_BYTES} AND NOT COALESCE(bool_or(truncated), FALSE)
      THEN COALESCE(jsonb_agg(value), '[]'::jsonb) ELSE NULL END AS rows,
      count(*)::int AS count, COALESCE(sum(bytes), 0)::int AS bytes,
      (COALESCE(sum(bytes), 0) > ${PAGE_BYTES} OR COALESCE(bool_or(truncated), FALSE)) AS oversize FROM sized`,
  );
  const page = rows[0];
  if (
    !page ||
    page.oversize ||
    !Number.isSafeInteger(page.count) ||
    page.count < 0 ||
    page.count > PAGE_ROWS ||
    !Array.isArray(page.rows) ||
    page.rows.length !== page.count ||
    page.bytes > PAGE_BYTES
  )
    throw new Refused('sql_metadata_reply_unproved', `sql:${table}`);
  return page.rows.map((item) => {
    const row = object(item);
    if (
      !row ||
      row._truncated !== false ||
      primaryKeys(table).some((key) => typeof row[key] !== 'string')
    )
      throw new Refused('sql_metadata_reply_unproved', `sql:${table}`);
    const data = { ...row };
    delete data._truncated;
    if (Object.values(data).some((value) => value !== null && typeof value !== 'string'))
      throw new Refused('sql_metadata_reply_unproved', `sql:${table}`);
    return data as Metadata;
  });
}

async function independentRetentionSource(
  meter: Meter,
  row: Metadata,
  candidates: readonly LegacyRecoveryCandidate[],
): Promise<boolean> {
  if (
    ['chat_id', 'message_id', 'author_id', 'origin_bot_id', 'activation_id', 'source_at'].some(
      (key) => !row[key],
    ) ||
    !Number.isFinite(Date.parse(row.source_at!)) ||
    row.intent_id !== null ||
    candidates.some(
      (candidate) =>
        candidate.source.userId === row.author_id ||
        (candidate.source.chatId === row.chat_id && candidate.source.messageId === row.message_id),
    )
  )
    return false;
  // FLAG: Only immutable ingress-retention source scope is accepted here. This proves
  // independence, never permission or a new retention effect.
  const policy = await meter.read<{ activationId: string }>(
    'sql:retention-source-policy',
    Prisma.sql`
    SELECT left("activation_id", ${SCALAR_BYTES}) AS "activationId" FROM "message_retention_policies"
    WHERE "chat_id" = ${row.chat_id} AND "activation_id" = ${row.activation_id}`,
  );
  return policy.length === 1 && policy[0]!.activationId === row.activation_id;
}

export async function inventoryLegacyRecoveryLiveSql(
  tx: Prisma.TransactionClient,
  request: LegacyRecoveryLiveSqlSelection,
  allowance: Allowance,
): Promise<LegacyRecoveryLiveSqlResult> {
  return inventoryLegacyRecoverySql(tx, request, allowance, true);
}

// FLAG: Source closure proves protection of descendants without claiming unrelated
// SQL history empty. Preserve exact source/claim/mirror checks and all refusal fences.
export async function inventoryLegacyRecoverySelectedSql(
  tx: Prisma.TransactionClient,
  request: LegacyRecoveryLiveSqlSelection,
  allowance: Allowance,
): Promise<LegacyRecoveryLiveSqlResult> {
  return inventoryLegacyRecoverySql(tx, request, allowance, false);
}

async function inventoryLegacyRecoverySql(
  tx: Prisma.TransactionClient,
  request: LegacyRecoveryLiveSqlSelection,
  allowance: Allowance,
  exhaustiveCatalog: boolean,
): Promise<LegacyRecoveryLiveSqlResult> {
  const meter = new Meter(tx, allowance, exhaustiveCatalog);
  const issues: LegacyRecoveryLiveIssue[] = [];
  const candidates: LegacyRecoveryCandidate[] = [];
  const selectedOwners: LegacyRecoveryLiveOutput['selectedOwners'][number][] = [];
  const evidence: unknown[] = [];
  try {
    if (
      ['pages', 'rows', 'probes', 'bytes'].some(
        (key) =>
          !Number.isSafeInteger(allowance[key as keyof Allowance]) ||
          allowance[key as keyof Allowance] <= 0,
      ) ||
      !Number.isSafeInteger(allowance.deadlineAtMs)
    )
      throw new Refused('sql_allowance_invalid', 'sql:inventory');
    if (
      !request.selection.ownerWebhookEventIds.length ||
      request.selection.ownerWebhookEventIds.length > 200 ||
      new Set(request.selection.ownerWebhookEventIds).size !==
        request.selection.ownerWebhookEventIds.length ||
      !request.selection.majorBotIds.length
    )
      throw new Refused('sql_selection_invalid', 'sql:inventory');
    const snapshot = await meter.read<{ readOnly: string; isolation: string; timeoutMs: number }>(
      'sql:snapshot',
      Prisma.sql`
      SELECT current_setting('transaction_read_only') AS "readOnly",
        current_setting('transaction_isolation') AS isolation,
        (extract(epoch FROM current_setting('statement_timeout')::interval) * 1000)::int AS "timeoutMs"`,
    );
    if (
      snapshot[0]?.readOnly !== 'on' ||
      snapshot[0]?.isolation !== 'repeatable read' ||
      !snapshot[0]?.timeoutMs ||
      snapshot[0].timeoutMs > allowance.deadlineAtMs - Date.now()
    )
      throw new Refused('sql_snapshot_unproved', 'sql:inventory');
    if (descriptors.length !== 47 || new Set(descriptors.map((item) => item.table)).size !== 47)
      throw new Refused('sql_catalog_unproved', 'sql:inventory');
    for (const ownerId of request.selection.ownerWebhookEventIds) {
      const candidate = await inspectLegacyRecoveryCandidate(
        candidateReader(meter),
        ownerId,
        request.selection.majorBotIds,
      );
      if (!candidate) {
        issues.push({ code: 'sql_selected_owner_unproved', descriptor: 'sql:webhook_events' });
        continue;
      }
      candidates.push(candidate);
      selectedOwners.push({
        ownerWebhookEventId: candidate.owner.id,
        semanticKey: candidate.claim.semanticKey,
        claimId: candidate.claim.id,
        ...candidate.source,
        sourceAt: candidate.source.sourceAt.toISOString(),
        rawPayloadSha256: candidate.rawPayloadDigest,
        normalizedPayloadSha256: candidate.normalizedPayloadDigest,
        ownerSnapshotSha256: legacySnapshotDigest(candidate.owner),
        claimSnapshotSha256: legacySnapshotDigest(candidate.claim),
      });
      let cursor: Metadata | null = null;
      let exhausted = false;
      // FLAG: Exact semantic mirrors are inventoried without touching unrelated
      // webhook history. A missing suitable plan exhausts the measured budget and denies.
      while (!exhausted) {
        const mirrors = await metadataPage(
          meter,
          'webhook_events',
          cursor,
          Prisma.sql`"semantic_key" = ${candidate.claim.semanticKey}`,
        );
        evidence.push({
          descriptor: 'sql:webhook_events',
          metadataSha256: legacyRecoveryLiveDigest(mirrors),
          count: mirrors.length,
        });
        for (const row of mirrors) {
          if (row.id === candidate.owner.id) continue;
          const mirror = await exactRow(
            meter,
            'sql:semantic-mirror-source',
            'webhook_events',
            Prisma.sql`t."id" = ${row.id}`,
          );
          const source = mirror ? inspectLegacyRecoverySource(mirror as never) : null;
          if (
            !mirror ||
            !source ||
            !row.bot_id ||
            !request.selection.majorBotIds.includes(row.bot_id) ||
            row.semantic_key !== candidate.claim.semanticKey ||
            buildWebhookSemanticEventKey(mirror.normalizedPayload) !==
              candidate.claim.semanticKey ||
            legacySnapshotDigest(source) !== legacySnapshotDigest(candidate.source) ||
            legacySnapshotDigest(object(mirror.normalizedPayload)?.raw) !==
              legacySnapshotDigest(object(candidate.owner.normalizedPayload)?.raw)
          )
            issues.push({ code: 'sql_semantic_mirror_unproved', descriptor: 'sql:webhook_events' });
        }
        exhausted = mirrors.length < PAGE_ROWS;
        cursor = mirrors.at(-1) ?? null;
      }
    }
    for (const descriptor of exhaustiveCatalog ? descriptors : []) {
      // FLAG: Never scan the global receipt/claim history. Candidate inspection above
      // performs every exact owner, EXECUTION and COMMAND projection in this snapshot.
      if (['webhook_events', 'webhook_execution_claims'].includes(descriptor.table)) continue;
      let cursor: Metadata | null = null;
      let exhausted = false;
      while (!exhausted) {
        const page = await metadataPage(meter, descriptor.table, cursor);
        evidence.push({
          descriptor: descriptor.id,
          metadataSha256: legacyRecoveryLiveDigest(page),
          count: page.length,
        });
        for (const row of page) {
          const independent =
            descriptor.table === 'message_retention_candidates' &&
            candidates.length === request.selection.ownerWebhookEventIds.length &&
            (await independentRetentionSource(meter, row, candidates));
          if (
            !independent &&
            !issues.some(
              (item) => item.code === 'sql_source_unresolved' && item.descriptor === descriptor.id,
            )
          )
            issues.push({ code: 'sql_source_unresolved', descriptor: descriptor.id });
        }
        exhausted = page.length < PAGE_ROWS;
        cursor = page.at(-1) ?? null;
        if (!exhausted && !cursor) throw new Refused('sql_cursor_unproved', descriptor.id);
      }
      evidence.push({ descriptor: descriptor.id, exhausted: true });
    }
    // FLAG: Source protection alone cannot prove that cold materialization will
    // finish. Check the pending prefix in this same snapshot before either preview
    // can report READY; its work shares the original total inventory allowance.
    if (
      !exhaustiveCatalog &&
      !issues.length &&
      candidates.length === request.selection.ownerWebhookEventIds.length
    ) {
      meter.check('sql:materialization-preview');
      const prefix = await previewLegacyRecoveryMaterialization(tx, candidates, {
        pages: allowance.pages - meter.cost.pages,
        rows: allowance.rows - meter.cost.rows,
        probes: allowance.probes - meter.cost.probes,
        bytes: allowance.bytes - meter.cost.bytes,
        deadlineAtMs: allowance.deadlineAtMs,
      });
      for (const key of ['pages', 'rows', 'probes', 'bytes'] as const) {
        if (!Number.isSafeInteger(prefix.cost[key]) || prefix.cost[key] < 0)
          throw new Refused(
            'sql_materialization_accounting_refused',
            'sql:materialization-preview',
          );
        meter.cost[key] += prefix.cost[key];
      }
      meter.check('sql:materialization-preview');
      for (const plan of prefix.plans) {
        // FLAG: The prefix helper reports estimated plan rows alongside actual
        // results. Keep their diagnostic identities separate on the frozen wire.
        meter.proofs.push(
          {
            ...plan,
            descriptor: `${plan.descriptor}:bounded-planning`,
            returnedRows: 0,
            probes: 0,
          },
          {
            ...plan,
            descriptor: `${plan.descriptor}:returned`,
            planSha256: legacyRecoveryLiveDigest({
              mode: 'bounded-select',
              returnedRows: plan.returnedRows,
            }),
            examinedRows: 0,
            probes: 1,
          },
        );
      }
      issues.push(...prefix.issues);
      if (prefix.decision !== 'READY' || !/^[a-f0-9]{64}$/u.test(prefix.proofSha256))
        issues.push({
          code: 'sql_materialization_prefix_unproved',
          descriptor: 'sql:materialization-preview',
        });
      evidence.push({ descriptor: 'sql:materialization-preview', proofSha256: prefix.proofSha256 });
    }
  } catch (error) {
    issues.push(
      error instanceof Refused
        ? { code: error.code, descriptor: error.descriptor }
        : { code: 'sql_inventory_query_failed', descriptor: 'sql:inventory' },
    );
  }
  await meter.drain();
  const stableDigest = legacyRecoveryLiveDigest({
    selection: request.selection,
    scope: exhaustiveCatalog ? 'exhaustive-catalog' : 'selected-original-source',
    selectedOwners,
    evidence,
    issues,
  });
  return {
    selectedOwners,
    candidates,
    proofs: meter.proofs,
    stableDigest,
    cost: { ...meter.cost },
    issues,
  };
}
