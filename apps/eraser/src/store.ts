import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ServiceError,
  type Candidate,
  type Lane,
  type Message,
  type Policy,
  type Protection,
  type UpdatePolicy,
  type Hours,
  type ConnectionRequest,
} from './types.js';

const HOUR = 3_600_000;
export const CHAT_BUFFER = 200;
export const HOUSEKEEPING_INTERVAL_MS = 60_000;
export const TERMINAL_PURGE_BATCH = 2000;
export const WEBHOOK_PURGE_BATCH = 20_000;
export type PolicyRow = Policy & {
  last_operation_id: string | null;
  live_signature: string | null;
  history_signature: string | null;
  deferred_from: string | null;
  deferred_to: string | null;
  historical_deferred_from: string | null;
  historical_deferred_to: string | null;
};
type ProtectionState = {
  ready: boolean;
  complete_through: Date | null;
  bot_history_complete_from: Date | null;
};
export function protectionGap(
  message: Pick<Message, 'isBot' | 'sourceMs'>,
  moduleBot: boolean,
  protection: ProtectionState | undefined,
): 'current' | 'history' | null {
  if (message.isBot === false) return null;
  if (
    !protection?.ready ||
    !protection.complete_through ||
    message.sourceMs > protection.complete_through.getTime()
  )
    return 'current';
  // FLAG: Historical module publications lack a trustworthy exact-ID inventory before this floor.
  if (
    moduleBot &&
    (!protection.bot_history_complete_from ||
      message.sourceMs < protection.bot_history_complete_from.getTime())
  )
    return 'history';
  return null;
}
export class Store {
  constructor(
    readonly pool: pg.Pool,
    readonly executionEnabled: boolean,
  ) {}
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async ensure(client: pg.PoolClient, chatId: string, hours: Hours = 48): Promise<void> {
    await client.query(
      'INSERT INTO eraser_policies(chat_id,hours,activation_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [chatId, hours, randomUUID()],
    );
  }
  async policy(chatId: string): Promise<PolicyRow | null> {
    return (
      (await this.pool.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1', [chatId]))
        .rows[0] ?? null
    );
  }
  async globalHolds(
    authorIds: string[],
    messages: Array<{ chatId: string; messageId: string }> = [],
  ): Promise<void> {
    await this.transaction(async (client) => {
      // FLAG: Exclude final-guard transactions until the negative authority is durably installed.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('eraser:effect-holds:v1'))");
      await client.query(
        'INSERT INTO eraser_global_held_authors(author_id) SELECT id FROM unnest($1::text[]) id ON CONFLICT DO NOTHING',
        [authorIds],
      );
      await client.query(
        'INSERT INTO eraser_global_message_holds(chat_id,message_id) SELECT m.chat_id,m.message_id FROM jsonb_to_recordset($1::jsonb) AS m(chat_id text,message_id text) ON CONFLICT DO NOTHING',
        [
          JSON.stringify(
            messages.map((message) => ({ chat_id: message.chatId, message_id: message.messageId })),
          ),
        ],
      );
    });
    // FLAG: Preserve installed holds on refusal. An earlier authorized effect remains uncertain,
    // and its source writer must not claim the cold fence has been established yet.
    const authors = await this.pool.query(
      "SELECT 1 FROM eraser_candidates WHERE author_id=ANY($1::text[]) AND state IN ('dispatching','uncertain') LIMIT 1",
      [authorIds],
    );
    const exact = await this.pool.query(
      "SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS m(chat_id text,message_id text) JOIN eraser_candidates c ON c.chat_id=m.chat_id AND c.message_id=m.message_id WHERE c.state IN ('dispatching','uncertain') LIMIT 1",
      [
        JSON.stringify(
          messages.map((message) => ({ chat_id: message.chatId, message_id: message.messageId })),
        ),
      ],
    );
    if (authors.rowCount || exact.rowCount)
      throw new ServiceError(
        409,
        'ERASER_HOLD_EFFECT_PENDING',
        'Результат предыдущего удаления ещё не подтверждён.',
      );
  }
  async bootstrap(chatId: string, hours: Hours, protection?: Protection): Promise<void> {
    await this.transaction(async (client) => {
      await this.ensure(client, chatId, hours);
      if (protection) await this.applyProtection(client, chatId, protection);
    });
  }
  async protect(chatId: string, input: Protection): Promise<void> {
    await this.transaction(async (client) => {
      await this.ensure(client, chatId);
      await this.applyProtection(client, chatId, input);
    });
  }
  private async applyProtection(client: pg.PoolClient, chatId: string, input: Protection) {
    await client.query('SELECT chat_id FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [chatId]);
    const old = (
      await client.query<{ source_revision: string; bot_history_complete_from: Date | null }>(
        'SELECT source_revision,bot_history_complete_from FROM eraser_protection_state WHERE chat_id=$1',
        [chatId],
      )
    ).rows[0];
    if (old && Number(old.source_revision) > input.sourceRevision)
      throw new ServiceError(
        409,
        'ERASER_PROTECTION_REVISION_CONFLICT',
        'Защита публикаций уже изменена.',
      );
    for (const [kind, ids] of [
      ['protected', input.protectedMessageIds],
      ['hold', input.holdMessageIds],
    ] as const) {
      await client.query(
        `INSERT INTO eraser_protected_messages(chat_id,message_id,kind) SELECT $1,id,$3 FROM unnest($2::text[]) id ON CONFLICT(chat_id,message_id) DO UPDATE SET kind=CASE WHEN EXCLUDED.kind='hold' THEN 'hold' ELSE eraser_protected_messages.kind END`,
        [chatId, ids, kind],
      );
    }
    await client.query(
      'INSERT INTO eraser_held_authors(chat_id,author_id) SELECT $1,id FROM unnest($2::text[]) id ON CONFLICT DO NOTHING',
      [chatId, input.holdAuthorIds ?? []],
    );
    await client.query(
      'INSERT INTO eraser_protected_bots(chat_id,bot_id) SELECT $1,id FROM unnest($2::text[]) id ON CONFLICT DO NOTHING',
      [chatId, input.protectedBotIds],
    );
    await client.query(
      `INSERT INTO eraser_protection_state(chat_id,source_revision,complete_through,ready,bot_history_complete_from) VALUES($1,$2,$3,$4,$5) ON CONFLICT(chat_id) DO UPDATE SET source_revision=EXCLUDED.source_revision,complete_through=EXCLUDED.complete_through,ready=EXCLUDED.ready,bot_history_complete_from=CASE WHEN EXCLUDED.ready THEN EXCLUDED.bot_history_complete_from ELSE eraser_protection_state.bot_history_complete_from END,updated_at=CURRENT_TIMESTAMP`,
      [
        chatId,
        input.sourceRevision,
        input.complete === false ? null : input.completeThrough,
        input.complete !== false,
        input.complete === false ? null : (input.botHistoryCompleteFrom ?? null),
      ],
    );
    // FLAG: Revisit deferred ranges only after a complete local protection snapshot exists.
    if (input.complete !== false && input.completeThrough !== null) {
      await client.query(
        `UPDATE eraser_policies SET history_cursor=GREATEST(COALESCE(history_cursor,0),deferred_to),history_complete=false,history_gap=false,history_signature=NULL,deferred_from=NULL,deferred_to=NULL,next_run_at=CURRENT_TIMESTAMP WHERE chat_id=$1 AND deferred_to IS NOT NULL AND deferred_to <= $2`,
        [chatId, Date.parse(input.completeThrough)],
      );
    }
    // FLAG: An advancing current watermark cannot certify older module-bot publications.
    const floor = input.botHistoryCompleteFrom ? Date.parse(input.botHistoryCompleteFrom) : null;
    if (
      input.complete !== false &&
      floor !== null &&
      (!old?.bot_history_complete_from || floor < old.bot_history_complete_from.getTime())
    )
      await client.query(
        `UPDATE eraser_policies SET history_cursor=GREATEST(COALESCE(history_cursor,0),historical_deferred_to),history_complete=false,history_signature=NULL,historical_deferred_from=NULL,historical_deferred_to=NULL,next_run_at=CURRENT_TIMESTAMP WHERE chat_id=$1 AND historical_deferred_to IS NOT NULL AND historical_deferred_to >= $2`,
        [chatId, floor],
      );
  }
  async snapshot(
    chatId: string,
    client: pg.Pool | pg.PoolClient = this.pool,
  ): Promise<Record<string, unknown>> {
    const policy = (
      await client.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1', [chatId])
    ).rows[0];
    if (!policy)
      return {
        enabled: false,
        hours: 48,
        revision: 0,
        enabledAt: null,
        captureAfter: null,
        pausedAt: null,
        pendingCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        oldestDueAt: null,
        status: this.executionEnabled ? 'off' : 'unavailable',
        connectionStatus: 'unknown',
        historyStatus: 'off',
        historyScannedCount: 0,
        connectionRequest: null,
      };
    const connection = (
      await client.query<ConnectionRequest & { effective_status: ConnectionRequest['status'] }>(
        `SELECT *,CASE WHEN status='pending' AND expires_at<=clock_timestamp() THEN 'expired'
          WHEN status='pending' AND policy_revision<>$2 THEN 'cancelled' ELSE status END AS effective_status
         FROM eraser_connection_requests WHERE chat_id=$1`,
        [chatId, policy.revision],
      )
    ).rows[0];
    const counts = (
      await client.query<{
        pending: number;
        unresolved: number;
        review: number;
        oldest: string | null;
      }>(
        `SELECT COUNT(*) FILTER(WHERE state='pending')::int AS pending,COUNT(*) FILTER(WHERE state IN ('uncertain','dispatching'))::int AS unresolved,COUNT(*) FILTER(WHERE state='review')::int AS review,MIN(source_ms)::text AS oldest FROM (SELECT state,source_ms FROM eraser_candidates WHERE chat_id=$1 AND state IN ('pending','uncertain','dispatching','review') LIMIT 201) c`,
        [chatId],
      )
    ).rows[0]!;
    const status = !this.executionEnabled
      ? 'unavailable'
      : !policy.enabled
        ? 'off'
        : policy.connection_status === 'no_access' || policy.connection_status === 'missing'
          ? 'no_access'
          : counts.review
            ? 'error'
            : counts.unresolved ||
                policy.last_error ||
                policy.deferred_from ||
                policy.historical_deferred_from ||
                policy.history_gap
              ? 'delayed'
              : 'running';
    const historyStatus = !policy.enabled
      ? 'off'
      : policy.history_gap ||
          policy.deferred_from ||
          policy.historical_deferred_from ||
          policy.last_error ||
          ['missing', 'no_access'].includes(policy.connection_status)
        ? 'blocked'
        : policy.history_complete &&
            counts.pending === 0 &&
            counts.unresolved === 0 &&
            counts.review === 0
          ? 'complete'
          : Number(policy.scanned_count)
            ? 'running'
            : 'pending';
    return {
      enabled: policy.enabled,
      hours: policy.hours,
      revision: policy.revision,
      enabledAt: policy.enabled_at?.toISOString() ?? null,
      captureAfter: null,
      pausedAt: null,
      pendingCount: counts.pending,
      deletedCount: Number(policy.deleted_count),
      skippedCount: Number(policy.skipped_count),
      oldestDueAt: counts.oldest
        ? new Date(Number(counts.oldest) + policy.hours * HOUR).toISOString()
        : null,
      status,
      connectionStatus: policy.connection_status,
      historyStatus,
      historyScannedCount: Number(policy.scanned_count),
      connectionRequest:
        connection && connection.effective_status !== 'activated'
          ? { status: connection.effective_status, expiresAt: connection.expires_at.toISOString() }
          : null,
      ...(policy.last_operation_id ? { lastOperationId: policy.last_operation_id } : {}),
    };
  }
  async operation(chatId: string, input: UpdatePolicy): Promise<Record<string, unknown> | null> {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          enabled: input.enabled,
          hours: input.hours,
          expectedRevision: input.expectedRevision,
          actorUserId: input.actorUserId,
          ...(input.connectWhenReady === true ? { connectWhenReady: true } : {}),
        }),
      )
      .digest('hex');
    const row = (
      await this.pool.query<{ request_hash: string; response: Record<string, unknown> }>(
        'SELECT request_hash,response FROM eraser_operations WHERE chat_id=$1 AND operation_id=$2',
        [chatId, input.operationId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_hash !== hash)
      throw new ServiceError(
        409,
        'ERASER_OPERATION_CONFLICT',
        'Идентификатор сохранения уже использован.',
      );
    return row.response;
  }
  async update(chatId: string, input: UpdatePolicy): Promise<Record<string, unknown>> {
    if (input.connectWhenReady && !input.enabled)
      throw new ServiceError(400, 'INVALID_POLICY', 'Подключение требует включения очистки.');
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          enabled: input.enabled,
          hours: input.hours,
          expectedRevision: input.expectedRevision,
          actorUserId: input.actorUserId,
          ...(input.connectWhenReady === true ? { connectWhenReady: true } : {}),
        }),
      )
      .digest('hex');
    return this.transaction(async (client) => {
      await this.ensure(client, chatId);
      const policy = (
        await client.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
          chatId,
        ])
      ).rows[0]!;
      const previous = (
        await client.query<{ request_hash: string; response: Record<string, unknown> }>(
          'SELECT request_hash,response FROM eraser_operations WHERE chat_id=$1 AND operation_id=$2',
          [chatId, input.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== hash)
          throw new ServiceError(
            409,
            'ERASER_OPERATION_CONFLICT',
            'Идентификатор сохранения уже использован.',
          );
        return previous.response;
      }
      if (input.expectedRevision !== policy.revision)
        throw new ServiceError(
          409,
          'MESSAGE_RETENTION_REVISION_CONFLICT',
          'Настройки уже изменены.',
        );
      if (input.enabled) {
        if (!this.executionEnabled)
          throw new ServiceError(503, 'ERASER_UNAVAILABLE', 'Ластик пока недоступен.');
        const protection = (
          await client.query<{ ready: boolean }>(
            'SELECT ready FROM eraser_protection_state WHERE chat_id=$1',
            [chatId],
          )
        ).rows[0];
        if (!protection?.ready)
          throw new ServiceError(
            409,
            'ERASER_PROTECTION_PENDING',
            'Подготавливаем защиту правил и розыгрышей.',
          );
      }
      const now = Date.now(),
        cutoff = now - input.hours * HOUR;
      const enabled = input.enabled && !input.connectWhenReady;
      const restart = enabled && (!policy.enabled || input.hours !== policy.hours);
      await client.query(
        `UPDATE eraser_policies SET enabled=$2,hours=$3,revision=revision+1,last_operation_id=$4,updated_at=CURRENT_TIMESTAMP,last_error=NULL,
        activation_id=CASE WHEN enabled <> $2 THEN $5::uuid ELSE activation_id END,
        enabled_at=CASE WHEN NOT enabled AND $2 THEN CURRENT_TIMESTAMP ELSE enabled_at END,
        first_enabled_at=CASE WHEN $2 THEN COALESCE(first_enabled_at,CURRENT_TIMESTAMP) ELSE first_enabled_at END,
        live_floor=CASE WHEN $6 THEN $7 ELSE live_floor END,live_upper=CASE WHEN $6 THEN NULL ELSE live_upper END,live_cursor=CASE WHEN $6 THEN NULL ELSE live_cursor END,
        history_cursor=CASE WHEN $6 THEN GREATEST(COALESCE(history_cursor,0),$8) ELSE history_cursor END,
        history_complete=CASE WHEN $6 THEN false ELSE history_complete END,history_gap=CASE WHEN $6 THEN false ELSE history_gap END,
        history_signature=CASE WHEN $6 THEN NULL ELSE history_signature END,live_signature=CASE WHEN $6 THEN NULL ELSE live_signature END,next_run_at=CURRENT_TIMESTAMP
        WHERE chat_id=$1`,
        [
          chatId,
          enabled,
          input.hours,
          input.operationId,
          randomUUID(),
          restart,
          cutoff + 1,
          cutoff,
        ],
      );
      if (input.connectWhenReady) {
        await client.query(
          `INSERT INTO eraser_connection_requests(chat_id,operation_id,actor_user_id,policy_revision,status,expires_at)
           VALUES($1,$2,$3,$4,'pending',clock_timestamp()+INTERVAL '1 hour')
           ON CONFLICT(chat_id) DO UPDATE SET operation_id=EXCLUDED.operation_id,actor_user_id=EXCLUDED.actor_user_id,
           policy_revision=EXCLUDED.policy_revision,status='pending',expires_at=EXCLUDED.expires_at,
           next_attempt_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=clock_timestamp()`,
          [chatId, input.operationId, input.actorUserId, policy.revision + 1],
        );
      } else {
        // FLAG: Every ordinary revision-checked settings write revokes the outstanding opt-in.
        await client.query(
          `UPDATE eraser_connection_requests SET status='cancelled',lease_token=NULL,lease_until=NULL,
           updated_at=clock_timestamp() WHERE chat_id=$1 AND status IN ('pending','expired')`,
          [chatId],
        );
      }
      const response = await this.snapshot(chatId, client);
      await client.query(
        'INSERT INTO eraser_operations(chat_id,operation_id,request_hash,actor_user_id,response) VALUES($1,$2,$3,$4,$5)',
        [chatId, input.operationId, hash, input.actorUserId, response],
      );
      return response;
    });
  }
  async reserveConnections(limit: number): Promise<Array<{ chatId: string; leaseToken: string }>> {
    if (!this.executionEnabled) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
      throw new Error('Invalid connection reservation limit');
    return this.transaction(async (client) => {
      await client.query(
        `WITH expired AS (SELECT chat_id FROM eraser_connection_requests WHERE status='pending'
         AND expires_at<=CURRENT_TIMESTAMP ORDER BY expires_at,chat_id LIMIT 64 FOR UPDATE SKIP LOCKED)
         UPDATE eraser_connection_requests r SET status='expired',lease_token=NULL,lease_until=NULL,
         updated_at=clock_timestamp() FROM expired e WHERE r.chat_id=e.chat_id`,
      );
      const rows = (
        await client.query<{ chat_id: string }>(
          `SELECT chat_id FROM eraser_connection_requests WHERE status='pending'
           AND next_attempt_at<=CURRENT_TIMESTAMP
           AND (lease_until IS NULL OR lease_until<=CURRENT_TIMESTAMP)
           ORDER BY next_attempt_at,chat_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit],
        )
      ).rows;
      const reserved = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        const leased = await client.query(
          `UPDATE eraser_connection_requests SET lease_token=$2,
           lease_until=LEAST(expires_at,clock_timestamp()+INTERVAL '60 seconds')
           WHERE chat_id=$1 AND status='pending' AND expires_at>clock_timestamp() RETURNING chat_id`,
          [row.chat_id, leaseToken],
        );
        if (leased.rowCount) reserved.push({ chatId: row.chat_id, leaseToken });
        else
          await client.query(
            `UPDATE eraser_connection_requests SET status='expired',lease_token=NULL,lease_until=NULL,
           updated_at=clock_timestamp() WHERE chat_id=$1 AND status='pending' AND expires_at<=clock_timestamp()`,
            [row.chat_id],
          );
      }
      return reserved;
    });
  }
  async connectionRequest(chatId: string, leaseToken: string): Promise<ConnectionRequest | null> {
    if (!this.executionEnabled) return null;
    return (
      (
        await this.pool.query<ConnectionRequest>(
          `SELECT r.* FROM eraser_connection_requests r JOIN eraser_policies p USING(chat_id)
         WHERE r.chat_id=$1 AND r.lease_token=$2 AND r.status='pending' AND NOT p.enabled
         AND p.revision=r.policy_revision AND r.expires_at>clock_timestamp() AND r.lease_until>clock_timestamp()`,
          [chatId, leaseToken],
        )
      ).rows[0] ?? null
    );
  }
  async finishConnection(
    chatId: string,
    leaseToken: string,
    status: 'pending' | 'cancelled',
    code: string | null,
    waitMs: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE eraser_connection_requests SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE $3 END,
       next_attempt_at=LEAST(expires_at,clock_timestamp()+($5 * INTERVAL '1 millisecond')),
       lease_token=NULL,lease_until=NULL,last_error=$4,updated_at=clock_timestamp()
       WHERE chat_id=$1 AND lease_token=$2 AND status='pending'`,
      [chatId, leaseToken, status, code, Math.max(1000, waitMs)],
    );
  }
  async activateConnection(
    chatId: string,
    leaseToken: string,
    proofExpiresAt: Date,
  ): Promise<boolean> {
    if (!this.executionEnabled || !Number.isFinite(proofExpiresAt.getTime())) return false;
    return this.transaction(async (client) => {
      const policy = (
        await client.query<PolicyRow>('SELECT * FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
          chatId,
        ])
      ).rows[0];
      if (!policy || policy.enabled) return false;
      const request = (
        await client.query<ConnectionRequest>(
          `SELECT * FROM eraser_connection_requests WHERE chat_id=$1 AND lease_token=$2
           AND status='pending' AND policy_revision=$3 AND expires_at>clock_timestamp()
           AND lease_until>clock_timestamp() AND $4::timestamptz>clock_timestamp() FOR UPDATE`,
          [chatId, leaseToken, policy.revision, proofExpiresAt],
        )
      ).rows[0];
      if (!request) return false;
      const protection = (
        await client.query<{ ready: boolean }>(
          'SELECT ready FROM eraser_protection_state WHERE chat_id=$1',
          [chatId],
        )
      ).rows[0];
      if (!protection?.ready) return false;
      // FLAG: The final DB-clock predicate fences expiry during row-lock waits. The operation
      // identity and all protection/effect holds survive activation; only this request may enable.
      const result = await client.query(
        `UPDATE eraser_policies p SET enabled=true,revision=revision+1,connection_status='connected',
         activation_id=$3,enabled_at=clock_timestamp(),first_enabled_at=COALESCE(first_enabled_at,clock_timestamp()),
         live_floor=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-hours*3600000::bigint+1,
         live_upper=NULL,live_cursor=NULL,history_cursor=GREATEST(COALESCE(history_cursor,0),
           (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-hours*3600000::bigint),
         history_complete=false,history_gap=false,history_signature=NULL,live_signature=NULL,
         lease_token=NULL,lease_until=NULL,last_error=NULL,next_run_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE chat_id=$1 AND NOT enabled AND revision=$4 AND $5::timestamptz>clock_timestamp() AND EXISTS(
           SELECT 1 FROM eraser_connection_requests r WHERE r.chat_id=p.chat_id AND r.lease_token=$2
           AND r.status='pending' AND r.policy_revision=p.revision AND r.expires_at>clock_timestamp()
           AND r.lease_until>clock_timestamp()) RETURNING chat_id`,
        [chatId, leaseToken, randomUUID(), policy.revision, proofExpiresAt],
      );
      if (!result.rowCount) return false;
      await client.query(
        `UPDATE eraser_connection_requests SET status='activated',lease_token=NULL,lease_until=NULL,
         last_error=NULL,updated_at=clock_timestamp() WHERE chat_id=$1 AND lease_token=$2`,
        [chatId, leaseToken],
      );
      return true;
    });
  }
  async reserve(limit: number): Promise<Array<{ chatId: string; leaseToken: string }>> {
    return this.transaction(async (client) => {
      const rows = (
        await client.query<{ chat_id: string }>(
          `SELECT chat_id FROM eraser_policies WHERE enabled AND connection_status NOT IN ('missing','no_access') AND next_run_at<=CURRENT_TIMESTAMP AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP) ORDER BY next_run_at,chat_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit],
        )
      ).rows;
      const result = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        await client.query(
          "UPDATE eraser_policies SET lease_token=$2,lease_until=CURRENT_TIMESTAMP+INTERVAL '60 seconds' WHERE chat_id=$1",
          [row.chat_id, leaseToken],
        );
        result.push({ chatId: row.chat_id, leaseToken });
      }
      return result;
    });
  }
  async finishVisit(
    chatId: string,
    token: string,
    error: string | null = null,
    waitMs = 1000,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE eraser_policies SET lease_token=NULL,lease_until=NULL,next_run_at=CURRENT_TIMESTAMP+($3 * INTERVAL '1 millisecond'),last_error=$4 WHERE chat_id=$1 AND lease_token=$2",
      [chatId, token, waitMs, error],
    );
  }
  async connection(
    chatId: string,
    status: Policy['connection_status'],
    explicitActivation = false,
  ): Promise<void> {
    // FLAG: Passive rights observations cannot undo an authenticated removal or proven denial.
    await this.pool.query(
      "UPDATE eraser_policies SET connection_status=$2 WHERE chat_id=$1 AND ($2<>'connected' OR $3 OR connection_status NOT IN ('missing','no_access'))",
      [chatId, status, explicitActivation],
    );
  }
  async active(chatId: string, token: string): Promise<PolicyRow | null> {
    return (
      (
        await this.pool.query<PolicyRow>(
          "SELECT * FROM eraser_policies WHERE chat_id=$1 AND enabled AND connection_status NOT IN ('missing','no_access') AND lease_token=$2 AND lease_until>CURRENT_TIMESTAMP",
          [chatId, token],
        )
      ).rows[0] ?? null
    );
  }
  async nextCandidates(chatId: string): Promise<Candidate[]> {
    return (
      await this.pool.query<Candidate>(
        `SELECT * FROM eraser_candidates WHERE chat_id=$1 AND state='pending' AND next_attempt_at<=CURRENT_TIMESTAMP ORDER BY CASE WHEN lane='live' THEN 0 ELSE 1 END,source_ms,message_id LIMIT 5`,
        [chatId],
      )
    ).rows;
  }
  async reconciliation(chatId: string): Promise<Candidate | null> {
    return (
      (
        await this.pool.query<Candidate>(
          `SELECT * FROM eraser_candidates WHERE chat_id=$1 AND state IN ('uncertain','dispatching') AND next_attempt_at<=CURRENT_TIMESTAMP ORDER BY next_attempt_at,message_id LIMIT 1`,
          [chatId],
        )
      ).rows[0] ?? null
    );
  }
  async openScan(policy: PolicyRow, lane: Lane): Promise<{ upper: number; lower?: number } | null> {
    const cutoff = Date.now() - policy.hours * HOUR;
    if (lane === 'history')
      return policy.history_complete || policy.history_gap
        ? null
        : { upper: Number(policy.history_cursor ?? cutoff) };
    const floor = Number(policy.live_floor ?? cutoff + 1);
    if (floor > cutoff) return null;
    if (policy.live_cursor !== null) return { upper: Number(policy.live_cursor), lower: floor };
    await this.pool.query(
      'UPDATE eraser_policies SET live_upper=$2,live_cursor=$2,live_signature=NULL WHERE chat_id=$1 AND lease_token=$3 AND enabled',
      [policy.chat_id, cutoff, policy.lease_token],
    );
    return { upper: cutoff, lower: floor };
  }
  async bufferSize(chatId: string, client: pg.Pool | pg.PoolClient = this.pool): Promise<number> {
    return (
      await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM (SELECT 1 FROM eraser_candidates WHERE chat_id=$1 AND state NOT IN ('deleted','protected') LIMIT 201) c",
        [chatId],
      )
    ).rows[0]!.count;
  }
  async savePage(policy: PolicyRow, lane: Lane, messages: Message[]): Promise<void> {
    await this.transaction(async (client) => {
      const current = (
        await client.query<PolicyRow>(
          'SELECT * FROM eraser_policies WHERE chat_id=$1 AND enabled AND lease_token=$2 AND lease_until>CURRENT_TIMESTAMP FOR UPDATE',
          [policy.chat_id, policy.lease_token],
        )
      ).rows[0];
      if (!current || current.revision !== policy.revision) return;
      if ((await this.bufferSize(policy.chat_id, client)) > CHAT_BUFFER - 100) return;
      const protection = (
        await client.query<ProtectionState>(
          'SELECT ready,complete_through,bot_history_complete_from FROM eraser_protection_state WHERE chat_id=$1',
          [policy.chat_id],
        )
      ).rows[0];
      const signature = createHash('sha256')
        .update(messages.map((m) => `${m.id}:${m.sourceMs}`).join('|'))
        .digest('hex');
      const previous = lane === 'live' ? current.live_signature : current.history_signature;
      const repeated = messages.length === 100 && signature === previous;
      let deferredFrom: number | null = null,
        deferredTo: number | null = null,
        historicalFrom: number | null = null,
        historicalTo: number | null = null;
      const exclusions = (
        await client.query<{ id: string; kind: string }>(
          "SELECT message_id AS id,'message' AS kind FROM eraser_protected_messages WHERE chat_id=$1 AND message_id=ANY($2::text[]) UNION ALL SELECT author_id AS id,'author' AS kind FROM eraser_held_authors WHERE chat_id=$1 AND author_id=ANY($3::text[]) UNION ALL SELECT author_id AS id,'author' AS kind FROM eraser_global_held_authors WHERE author_id=ANY($3::text[]) UNION ALL SELECT message_id AS id,'message' AS kind FROM eraser_global_message_holds WHERE chat_id=$1 AND message_id=ANY($2::text[]) UNION ALL SELECT bot_id AS id,'bot' AS kind FROM eraser_protected_bots WHERE chat_id=$1 AND bot_id=ANY($3::text[])",
          [
            policy.chat_id,
            messages.map((message) => message.id),
            messages.map((message) => message.authorId),
          ],
        )
      ).rows;
      const excludedMessages = new Set(
        exclusions.filter((row) => row.kind === 'message').map((row) => row.id),
      );
      const excludedAuthors = new Set(
        exclusions.filter((row) => row.kind === 'author').map((row) => row.id),
      );
      const moduleBots = new Set(
        exclusions.filter((row) => row.kind === 'bot').map((row) => row.id),
      );
      const admitted = [];
      for (const message of messages) {
        if (
          message.sourceMs + current.hours * HOUR > Date.now() ||
          excludedMessages.has(message.id) ||
          excludedAuthors.has(message.authorId)
        )
          continue;
        const gap = protectionGap(message, moduleBots.has(message.authorId), protection);
        if (gap === 'current') {
          deferredFrom = Math.min(deferredFrom ?? message.sourceMs, message.sourceMs);
          deferredTo = Math.max(deferredTo ?? message.sourceMs, message.sourceMs);
          continue;
        }
        if (gap === 'history') {
          historicalFrom = Math.min(historicalFrom ?? message.sourceMs, message.sourceMs);
          historicalTo = Math.max(historicalTo ?? message.sourceMs, message.sourceMs);
          continue;
        }
        admitted.push({
          message_id: message.id,
          author_id: message.authorId,
          is_bot: message.isBot,
          source_ms: message.sourceMs,
        });
      }
      await client.query(
        `INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane)
        SELECT $1,m.message_id,m.author_id,m.is_bot,m.source_ms,$3 FROM jsonb_to_recordset($2::jsonb) AS m(message_id text,author_id text,is_bot boolean,source_ms bigint) ON CONFLICT DO NOTHING`,
        [policy.chat_id, JSON.stringify(admitted), lane],
      );
      await client.query(
        'UPDATE eraser_policies SET scanned_count=scanned_count+$2,deferred_from=CASE WHEN $3::bigint IS NULL THEN deferred_from ELSE LEAST(COALESCE(deferred_from,$3),$3) END,deferred_to=CASE WHEN $4::bigint IS NULL THEN deferred_to ELSE GREATEST(COALESCE(deferred_to,$4),$4) END,historical_deferred_from=CASE WHEN $5::bigint IS NULL THEN historical_deferred_from ELSE LEAST(COALESCE(historical_deferred_from,$5),$5) END,historical_deferred_to=CASE WHEN $6::bigint IS NULL THEN historical_deferred_to ELSE GREATEST(COALESCE(historical_deferred_to,$6),$6) END WHERE chat_id=$1',
        [policy.chat_id, messages.length, deferredFrom, deferredTo, historicalFrom, historicalTo],
      );
      const oldest = messages.at(-1)?.sourceMs;
      if (lane === 'history') {
        await client.query(
          'UPDATE eraser_policies SET history_cursor=COALESCE($2,history_cursor),history_complete=$3,history_gap=$4,history_signature=$5 WHERE chat_id=$1',
          [policy.chat_id, oldest ?? null, messages.length < 100, repeated, signature],
        );
      } else if (messages.length < 100) {
        await client.query(
          'UPDATE eraser_policies SET live_floor=live_upper+1,live_upper=NULL,live_cursor=NULL,live_signature=NULL WHERE chat_id=$1',
          [policy.chat_id],
        );
      } else {
        await client.query(
          'UPDATE eraser_policies SET live_cursor=$2,live_signature=$3,history_gap=history_gap OR $4 WHERE chat_id=$1',
          [policy.chat_id, oldest, signature, repeated],
        );
      }
    });
  }
  async assertAndMarkDispatch(
    candidate: Candidate,
    token: string,
    checkedAt: number,
    pinAt: number,
  ): Promise<string> {
    return this.transaction(async (client) => {
      // FLAG: A hold acknowledgement cannot pass an uncommitted final dispatch decision.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('eraser:effect-holds:v1'))");
      const policy = (
        await client.query<PolicyRow & { lease_valid: boolean }>(
          'SELECT *,lease_until>CURRENT_TIMESTAMP AS lease_valid FROM eraser_policies WHERE chat_id=$1 FOR UPDATE',
          [candidate.chat_id],
        )
      ).rows[0];
      if (
        !this.executionEnabled ||
        !policy?.enabled ||
        ['missing', 'no_access'].includes(policy.connection_status) ||
        policy.lease_token !== token ||
        !policy.lease_valid ||
        !policy.lease_until ||
        policy.lease_until.getTime() <= Date.now() ||
        Date.now() - checkedAt >= 30_000 ||
        Date.now() - pinAt >= 5000
      )
        throw new ServiceError(409, 'ERASER_GUARD_CHANGED', 'Удаление отложено.');
      const row = (
        await client.query<Candidate>(
          'SELECT * FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2 FOR UPDATE',
          [candidate.chat_id, candidate.message_id],
        )
      ).rows[0];
      if (
        !row ||
        row.state !== 'pending' ||
        Number(row.source_ms) + policy.hours * HOUR > Date.now()
      )
        throw new ServiceError(409, 'ERASER_GUARD_CHANGED', 'Срок ещё не наступил.');
      const protectedId = await client.query(
        'SELECT 1 FROM eraser_protected_messages WHERE chat_id=$1 AND message_id=$2 UNION ALL SELECT 1 FROM eraser_held_authors WHERE chat_id=$1 AND author_id=$3 UNION ALL SELECT 1 FROM eraser_global_held_authors WHERE author_id=$3 UNION ALL SELECT 1 FROM eraser_global_message_holds WHERE chat_id=$1 AND message_id=$2 LIMIT 1',
        [candidate.chat_id, candidate.message_id, row.author_id],
      );
      const protection = (
        await client.query<ProtectionState & { module_bot: boolean }>(
          'SELECT ready,complete_through,bot_history_complete_from,EXISTS(SELECT 1 FROM eraser_protected_bots WHERE chat_id=$1 AND bot_id=$2) AS module_bot FROM eraser_protection_state WHERE chat_id=$1',
          [candidate.chat_id, row.author_id],
        )
      ).rows[0];
      if (protectedId.rowCount)
        throw new ServiceError(409, 'ERASER_PROTECTED', 'Сообщение защищено.');
      if (
        protectionGap(
          { isBot: row.is_bot, sourceMs: Number(row.source_ms) },
          protection?.module_bot ?? false,
          protection,
        )
      )
        throw new ServiceError(409, 'ERASER_PROTECTION_PENDING', 'Ожидаем сведения о публикациях.');
      const dispatch = randomUUID();
      await client.query(
        "UPDATE eraser_candidates SET state='dispatching',dispatch_id=$3,attempt_count=attempt_count+1,updated_at=CURRENT_TIMESTAMP,next_attempt_at=CURRENT_TIMESTAMP+INTERVAL '10 seconds' WHERE chat_id=$1 AND message_id=$2",
        [candidate.chat_id, candidate.message_id, dispatch],
      );
      return dispatch;
    });
  }
  async settle(
    candidate: Candidate,
    state: 'deleted' | 'protected' | 'review' | 'uncertain' | 'pending',
    code: string,
    waitMs = 1000,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT chat_id FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
        candidate.chat_id,
      ]);
      const row = (
        await client.query<Candidate>(
          'SELECT * FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2 FOR UPDATE',
          [candidate.chat_id, candidate.message_id],
        )
      ).rows[0];
      if (!row || row.state === 'deleted' || row.state === 'protected') return;
      await client.query(
        "UPDATE eraser_candidates SET state=$3,outcome_code=$4,updated_at=CURRENT_TIMESTAMP,next_attempt_at=CURRENT_TIMESTAMP+($5 * INTERVAL '1 millisecond') WHERE chat_id=$1 AND message_id=$2",
        [candidate.chat_id, candidate.message_id, state, code, waitMs],
      );
      if (state === 'deleted' || state === 'protected')
        await client.query(
          `UPDATE eraser_policies SET ${state === 'deleted' ? 'deleted_count=deleted_count+1' : 'skipped_count=skipped_count+1'} WHERE chat_id=$1`,
          [candidate.chat_id],
        );
    });
  }
  async defer(candidate: Candidate, code: string, waitMs: number): Promise<void> {
    await this.settle(candidate, 'pending', code, waitMs);
  }
  async deferProtection(candidate: Candidate): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT chat_id FROM eraser_policies WHERE chat_id=$1 FOR UPDATE', [
        candidate.chat_id,
      ]);
      const row = (
        await client.query<Candidate>(
          "SELECT * FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2 AND state='pending' FOR UPDATE",
          [candidate.chat_id, candidate.message_id],
        )
      ).rows[0];
      if (!row) return;
      const protection = (
        await client.query<ProtectionState & { module_bot: boolean }>(
          'SELECT ready,complete_through,bot_history_complete_from,EXISTS(SELECT 1 FROM eraser_protected_bots WHERE chat_id=$1 AND bot_id=$2) AS module_bot FROM eraser_protection_state WHERE chat_id=$1',
          [candidate.chat_id, row.author_id],
        )
      ).rows[0];
      const gap = protectionGap(
        { isBot: row.is_bot, sourceMs: Number(row.source_ms) },
        protection?.module_bot ?? false,
        protection,
      );
      if (!gap) return;
      const prefix = gap === 'history' ? 'historical_deferred' : 'deferred';
      // FLAG: Park only unissued candidates in a durable range; uncertain effects remain journals.
      await client.query(
        `UPDATE eraser_policies SET ${prefix}_from=LEAST(COALESCE(${prefix}_from,$2),$2),${prefix}_to=GREATEST(COALESCE(${prefix}_to,$2),$2) WHERE chat_id=$1`,
        [candidate.chat_id, row.source_ms],
      );
      await client.query('DELETE FROM eraser_candidates WHERE chat_id=$1 AND message_id=$2', [
        candidate.chat_id,
        candidate.message_id,
      ]);
    });
  }
  async ingest(raw: Record<string, unknown>, receiptKey: string, message?: Message): Promise<void> {
    await this.transaction(async (client) => {
      if (
        !(
          await client.query(
            'INSERT INTO eraser_webhook_receipts(receipt_key) VALUES($1) ON CONFLICT DO NOTHING RETURNING receipt_key',
            [receiptKey],
          )
        ).rowCount
      )
        return;
      if (message) {
        // FLAG: Events schedule a bounded history window; they never accumulate one row per future message.
        await client.query(
          'UPDATE eraser_policies SET live_floor=LEAST(COALESCE(live_floor,$2),$2),next_run_at=CURRENT_TIMESTAMP WHERE chat_id=$1 AND enabled',
          [message.chatId, message.sourceMs],
        );
      }
      if (
        raw.update_type === 'message_removed' &&
        typeof raw.message_id === 'string' &&
        raw.chat_id !== undefined
      ) {
        const chatId = String(raw.chat_id);
        const result = await client.query(
          "UPDATE eraser_candidates SET state='deleted',outcome_code='removed_receipt',updated_at=CURRENT_TIMESTAMP WHERE chat_id=$1 AND message_id=$2 AND state NOT IN ('deleted','protected') RETURNING message_id",
          [chatId, raw.message_id],
        );
        if (result.rowCount)
          await client.query(
            'UPDATE eraser_policies SET deleted_count=deleted_count+1 WHERE chat_id=$1',
            [chatId],
          );
      }
      if (raw.update_type === 'bot_removed' && raw.chat_id !== undefined)
        await client.query(
          "UPDATE eraser_policies SET connection_status='missing',last_error='bot_removed',next_run_at=CURRENT_TIMESTAMP+INTERVAL '5 minutes' WHERE chat_id=$1",
          [String(raw.chat_id)],
        );
    });
  }
  async housekeeping(): Promise<void> {
    await this.pool.query(
      "DELETE FROM eraser_candidates WHERE (chat_id,message_id) IN (SELECT chat_id,message_id FROM eraser_candidates WHERE state IN ('deleted','protected') AND updated_at<CURRENT_TIMESTAMP-INTERVAL '7 days' ORDER BY updated_at,chat_id,message_id LIMIT $1)",
      [TERMINAL_PURGE_BATCH],
    );
    await this.pool.query(
      "DELETE FROM eraser_webhook_receipts WHERE receipt_key IN (SELECT receipt_key FROM eraser_webhook_receipts WHERE received_at<CURRENT_TIMESTAMP-INTERVAL '7 days' ORDER BY received_at,receipt_key LIMIT $1)",
      [WEBHOOK_PURGE_BATCH],
    );
  }
}
