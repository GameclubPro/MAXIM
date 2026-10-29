import { performance } from 'node:perf_hooks';
import type pg from 'pg';

export const HOUSEKEEPING_INTERVAL_MS = 30_000;
export const TERMINAL_PURGE_BATCH = 500;
export const WEBHOOK_PURGE_BATCH = 1000;
export const HOUSEKEEPING_MAX_ROUNDS = 16;
const PASS_BUDGET_MS = 1000;

// FLAG: Lock only a finite indexed page. Retain every unknown/manual journal and seven
// full days of terminal history; a changed row must still satisfy the terminal predicate.
// Locked tuple identities keep DELETE on TID probes instead of joining the retained table.
export const HOUSEKEEPING_PAGE_SQL = `
WITH candidate_keys AS MATERIALIZED (
  SELECT ctid FROM eraser_candidates
  WHERE state IN ('deleted','protected') AND updated_at<CURRENT_TIMESTAMP-INTERVAL '7 days'
  ORDER BY updated_at,chat_id,message_id LIMIT $1 FOR UPDATE SKIP LOCKED
), candidate_deleted AS (
  DELETE FROM eraser_candidates WHERE ctid=ANY(ARRAY(SELECT ctid FROM candidate_keys))
  AND state IN ('deleted','protected') AND updated_at<CURRENT_TIMESTAMP-INTERVAL '7 days'
  RETURNING 1
), receipt_keys AS MATERIALIZED (
  SELECT ctid FROM eraser_webhook_receipts WHERE received_at<CURRENT_TIMESTAMP-INTERVAL '7 days'
  ORDER BY received_at,receipt_key LIMIT $2 FOR UPDATE SKIP LOCKED
), receipt_deleted AS (
  DELETE FROM eraser_webhook_receipts WHERE ctid=ANY(ARRAY(SELECT ctid FROM receipt_keys))
  AND received_at<CURRENT_TIMESTAMP-INTERVAL '7 days' RETURNING 1
)
SELECT (SELECT count(*)::int FROM candidate_deleted) AS candidates,
       (SELECT count(*)::int FROM receipt_deleted) AS receipts`;

export type HousekeepingHealth = {
  enabled: boolean;
  running: boolean;
  lastStartedAt: string | null;
  lastSuccessfulAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: 'query_budget' | 'store_unavailable' | null;
  lastDurationMs: number;
  pageBudget: number;
  completedRounds: number;
  budgetExhausted: boolean;
  rows: { candidates: number; receipts: number };
  totalRows: { candidates: number; receipts: number };
  backlogObservedAt: string | null;
  oldestExpiredCandidateAt: string | null;
  oldestExpiredReceiptAt: string | null;
};

export class Housekeeping {
  private state: HousekeepingHealth;
  constructor(
    private readonly pool: pg.Pool,
    enabled: boolean,
  ) {
    this.state = {
      enabled,
      running: false,
      lastStartedAt: null,
      lastSuccessfulAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      lastDurationMs: 0,
      pageBudget: 1,
      completedRounds: 0,
      budgetExhausted: false,
      rows: { candidates: 0, receipts: 0 },
      totalRows: { candidates: 0, receipts: 0 },
      backlogObservedAt: null,
      oldestExpiredCandidateAt: null,
      oldestExpiredReceiptAt: null,
    };
  }
  health(): HousekeepingHealth {
    return { ...this.state, rows: { ...this.state.rows }, totalRows: { ...this.state.totalRows } };
  }
  private async bounded<T>(client: pg.PoolClient, run: () => Promise<T>): Promise<T> {
    await client.query(
      "BEGIN; SET LOCAL statement_timeout='500ms'; SET LOCAL lock_timeout='100ms'",
    );
    try {
      const value = await run();
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  async run(): Promise<void> {
    if (this.state.running) return;
    const started = performance.now();
    this.state.running = true;
    this.state.lastStartedAt = new Date().toISOString();
    this.state.rows = { candidates: 0, receipts: 0 };
    this.state.completedRounds = 0;
    this.state.budgetExhausted = false;
    let client: pg.PoolClient | undefined;
    let locked = false;
    let destroy = false;
    try {
      client = await this.pool.connect();
      // FLAG: Replicas serialize maintenance without waiting or multiplying its page budget.
      locked = (
        await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext(current_schema()||':eraser:housekeeping:v1')) AS locked",
        )
      ).rows[0]!.locked;
      if (!locked) return;
      let candidatesDone = false,
        receiptsDone = false;
      while (
        this.state.completedRounds < this.state.pageBudget &&
        performance.now() - started < PASS_BUDGET_MS
      ) {
        const row = await this.bounded(
          client,
          async () =>
            (
              await client!.query<{ candidates: number; receipts: number }>(HOUSEKEEPING_PAGE_SQL, [
                candidatesDone ? 0 : TERMINAL_PURGE_BATCH,
                receiptsDone ? 0 : WEBHOOK_PURGE_BATCH,
              ])
            ).rows[0]!,
        );
        this.state.completedRounds++;
        for (const kind of ['candidates', 'receipts'] as const) {
          this.state.rows[kind] += row[kind];
          this.state.totalRows[kind] += row[kind];
        }
        candidatesDone ||= row.candidates < TERMINAL_PURGE_BATCH;
        receiptsDone ||= row.receipts < WEBHOOK_PURGE_BATCH;
        if (candidatesDone && receiptsDone) break;
      }
      if (this.state.completedRounds === 0)
        throw Object.assign(new Error('Maintenance admission budget exhausted'), { code: '57014' });
      const elapsed = performance.now() - started;
      this.state.budgetExhausted = !candidatesDone || !receiptsDone;
      if (elapsed >= PASS_BUDGET_MS * 0.75)
        this.state.pageBudget = Math.max(1, Math.floor(this.state.pageBudget / 2));
      else if (this.state.budgetExhausted)
        this.state.pageBudget = Math.min(HOUSEKEEPING_MAX_ROUNDS, this.state.pageBudget * 2);
      else this.state.pageBudget = Math.max(1, Math.ceil(this.state.completedRounds / 2));
      // FLAG: An expired-head observation has its own timestamp. A time-capped pass never refreshes
      // old observations or substitutes a count inferred from the number of rows deleted.
      if (performance.now() - started < PASS_BUDGET_MS) {
        const head = await this.bounded(
          client,
          async () =>
            (
              await client!.query<{
                observed_at: Date;
                candidate_at: Date | null;
                receipt_at: Date | null;
              }>(`SELECT CURRENT_TIMESTAMP AS observed_at,
          (SELECT updated_at FROM eraser_candidates WHERE state IN ('deleted','protected')
            AND updated_at<CURRENT_TIMESTAMP-INTERVAL '7 days' ORDER BY updated_at,chat_id,message_id LIMIT 1) AS candidate_at,
          (SELECT received_at FROM eraser_webhook_receipts WHERE received_at<CURRENT_TIMESTAMP-INTERVAL '7 days'
            ORDER BY received_at,receipt_key LIMIT 1) AS receipt_at`)
            ).rows[0]!,
        );
        this.state.backlogObservedAt = head.observed_at.toISOString();
        this.state.oldestExpiredCandidateAt = head.candidate_at?.toISOString() ?? null;
        this.state.oldestExpiredReceiptAt = head.receipt_at?.toISOString() ?? null;
      }
      this.state.lastSuccessfulAt = new Date().toISOString();
      this.state.lastErrorCode = null;
    } catch (error) {
      this.state.pageBudget = Math.max(1, Math.floor(this.state.pageBudget / 2));
      this.state.lastFailureAt = new Date().toISOString();
      const code = (error as { code?: string })?.code;
      this.state.lastErrorCode =
        code === '57014' || code === '55P03' ? 'query_budget' : 'store_unavailable';
      throw error;
    } finally {
      if (client && locked) {
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtext(current_schema()||':eraser:housekeeping:v1'))",
          );
        } catch {
          destroy = true;
        }
      }
      client?.release(destroy);
      this.state.lastDurationMs = Math.ceil(performance.now() - started);
      this.state.running = false;
    }
  }
}
